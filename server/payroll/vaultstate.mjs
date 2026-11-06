// The vault's lock state for one running server: the data key is held in memory only while unlocked.
//
// Upgrades at unlock (each once, in one transaction, then the file is compacted so no old page stays behind):
// - A vault from an older KeaS (key straight from the passphrase with scrypt N = 2^15, values sealed without being
//   bound to their row, some columns not sealed at all) gets a new random data key wrapped under N = 2^17, and every
//   sealed column is re-encrypted bound to its table, column and row.
// - A column that a newer KeaS seals for the first time has its plaintext sealed. Columns that were already sealed
//   never accept plaintext again: a plain value planted in one is refused when read, never "laundered" into a sealed
//   one. The list of columns already sealed is itself sealed, so it can't be reset from outside.
// - Weaker stored KDF parameters are upgraded by rewrapping the data key.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createVaultMeta, openVault, seal, unseal, isSealed, isSealedV1, unsealV1, sealContext, VaultDamaged, SealError } from '../lib/vault.mjs';
import { SEALED_COLUMNS } from './schema.mjs';

export { VaultDamaged, SealError };
export class VaultLocked extends Error { constructor() { super('The payroll vault is locked. Sign in with the vault passphrase.'); } }

// Columns older KeaS versions sealed as JSON values (the others held JSON text the code sealed itself).
const V1_VALUE_COLUMNS = new Set(['people.pay_rate_cents', 'people.birthdate', 'people.email', 'people.ytd_wages_cents', 'pay_rates.rate_cents',
  'raises.old_rate_cents', 'raises.new_rate_cents', 'raises.retro_cents', 'offers.rate_cents', 'payrun_lines.gross', 'payrun_lines.net',
  'payrun_lines.withheld', 'payrun_lines.employer_total', 'payrun_lines.detail']);
const colName = ([t, , c]) => `${t}.${c}`;
// Every column sealed when values were first bound to their rows: a vault this new never upgrades them from plaintext.
const BASE_SEALED = new Set(SEALED_COLUMNS.map(colName));
const COLUMNS_CTX = 'keas-payroll-sealed-columns';

export function makeVault(h) {
  let key = null;
  // The database layer seals and opens sealed columns with the key while the vault is open (see db.mjs).
  const setKey = (k) => {
    const old = key;
    key = k;
    h.setSealer?.(k ? { seal: (v, ctx) => seal(k, JSON.stringify(v), ctx), open: (s, ctx) => JSON.parse(unseal(k, s, ctx)) } : null);
    if (old && old !== k) old.fill(0);
  };
  const meta = () => { const r = h.get("SELECT v FROM vault_meta WHERE k = 'crypto'"); return r ? JSON.parse(r.v) : null; };
  const putMeta = (k, v) => h.run('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);

  /** The columns already sealed in this vault (sealed under the data key, so it can't be rolled back from outside). */
  const sealedColumns = (k) => {
    const r = h.get("SELECT v FROM vault_meta WHERE k = 'sealed_columns'");
    try { return new Set([...BASE_SEALED, ...JSON.parse(unseal(k, r?.v, COLUMNS_CTX))]); } catch { return new Set(BASE_SEALED); }
  };
  const saveSealedColumns = (k) => putMeta('sealed_columns', seal(k, JSON.stringify(SEALED_COLUMNS.map(colName)), COLUMNS_CTX));

  /**
   * Rewrites every value of the given columns: logical = read(raw value, 'table.column', ctx) (undefined: leave it as
   * it is), then sealed under toKey, bound to its row. Runs with the sealing triggers off.
   */
  function rewrite(columns, read, toKey) {
    h.rawWrites(() => {
      for (const [table, keys, col] of columns) {
        const rows = h.db.prepare(`SELECT rowid AS _rid, ${keys.join(', ')}, ${col} AS _v FROM ${table} WHERE ${col} IS NOT NULL`).all();
        const up = h.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
        for (const r of rows) {
          const ctx = sealContext(table, col, keys.map((k) => r[k]));
          const logical = read(r._v, `${table}.${col}`, ctx);
          if (logical !== undefined) up.run(seal(toKey, JSON.stringify(logical), ctx), r._rid);
        }
      }
    });
  }
  function compact() {
    try { h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); h.db.exec('VACUUM'); h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  }

  /** An older KeaS's vault: a new data key, everything re-encrypted bound to its row, plaintext columns sealed. */
  function upgradeLegacy(oldKey, passphrase) {
    const next = createVaultMeta(passphrase);
    h.tx(() => {
      rewrite(SEALED_COLUMNS, (v, where) => {
        if (isSealedV1(v)) { const text = unsealV1(oldKey, v); return V1_VALUE_COLUMNS.has(where) ? JSON.parse(text) : text; }
        if (isSealed(v)) throw new SealError(where, 'is in a format this vault never wrote');
        return v; // plaintext from before the column was sealed
      }, next.key);
      putMeta('crypto', JSON.stringify(next.meta));
      saveSealedColumns(next.key);
    });
    oldKey.fill(0);
    setKey(next.key);
    compact();
  }
  /** Seals the plaintext of columns this vault hasn't sealed before (added by a newer KeaS). */
  function sealNewColumns() {
    const have = sealedColumns(key);
    const fresh = SEALED_COLUMNS.filter((c) => !have.has(colName(c)));
    if (!fresh.length) return 0;
    let n = 0;
    h.tx(() => {
      rewrite(fresh, (v) => { if (isSealed(v)) return undefined; n++; return v; }, key);
      saveSealedColumns(key);
    });
    if (n) compact();
    return n;
  }

  const v = {
    initialized: () => !!meta(),
    unlocked: () => !!key,
    create(passphrase) {
      if (meta()) throw new Error('The vault is already set up.');
      const r = createVaultMeta(passphrase);
      h.tx(() => { putMeta('crypto', JSON.stringify(r.meta)); saveSealedColumns(r.key); });
      setKey(r.key);
    },
    /** True if the passphrase opens the vault (and unlocks it). Upgrades an older vault first (see above). */
    unlock(passphrase) {
      const m = meta(); if (!m) return false;
      const r = openVault(passphrase, m); // throws VaultDamaged when the stored settings are missing or out of bounds
      if (!r) return false;
      if (r.legacy) { upgradeLegacy(r.key, passphrase); return true; }
      setKey(r.key);
      if (r.weakKdf) putMeta('crypto', JSON.stringify(createVaultMeta(passphrase, { dataKey: r.key }).meta));
      sealNewColumns();
      return true;
    },
    /** Locks the vault: the key is wiped from memory. */
    lock() { setKey(null); },
    /** JSON text for a sealed column (the database seals it as it's written). */
    sealJson: (value) => (value == null ? null : JSON.stringify(value)),
    /** A sealed column's value as read (the database layer has opened it already), parsed. */
    openJson(raw) {
      if (raw == null || raw === '') return null;
      if (isSealed(raw) || isSealedV1(raw)) throw new SealError('a JSON column', 'was read without being opened');
      try { return JSON.parse(raw); } catch { return null; }
    },
    /** A new passphrase: a new data key, and every sealed value re-encrypted under it. */
    rekey(current, next) {
      const r = openVault(current, meta());
      if (!r) return false;
      if (r.legacy) { upgradeLegacy(r.key, current); return v.rekey(current, next); }
      const n = createVaultMeta(next);
      h.tx(() => {
        rewrite(SEALED_COLUMNS, (val, where, ctx) => {
          if (!isSealed(val)) throw new SealError(where, 'isn’t sealed');
          try { return JSON.parse(unseal(r.key, val, ctx)); } catch { throw new SealError(where, 'doesn’t belong to its row'); }
        }, n.key);
        putMeta('crypto', JSON.stringify(n.meta));
        saveSealedColumns(n.key);
      });
      if (r.key !== key) r.key.fill(0);
      setKey(n.key);
      compact();
      return true;
    },
    setting(k, d = null) { const r = h.get('SELECT v FROM vault_meta WHERE k = ?', 'set:' + k); return r ? JSON.parse(r.v) : d; },
    setSetting(k, val) { putMeta('set:' + k, JSON.stringify(val)); },
  };
  return v;
}

/**
 * The workforce server's vault: opened with `passphrase` (the KeaS app keeps it protected by Windows DPAPI and hands it
 * over in memory). keyFile: development and tests only, a generated passphrase is kept in a file next to the database
 * so the sample data works without a sign-in step. Without it, no key is ever written to disk here.
 */
export function openDevVault(vault, dbFile, passphrase, { keyFile = false } = {}) {
  let pass = passphrase || null;
  const file = keyFile && dbFile && dbFile !== ':memory:' ? dbFile + '.vaultkey' : null;
  if (!pass && file && existsSync(file)) pass = readFileSync(file, 'utf8').trim();
  if (!vault.initialized()) {
    if (!pass && dbFile && dbFile !== ':memory:' && !file) throw new Error('The organization server needs its vault passphrase (the KeaS app provides it).');
    pass = pass || randomBytes(24).toString('base64url');
    vault.create(pass);
    if (file && !passphrase) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, pass, { mode: 0o600 }); }
  } else if (!pass || !vault.unlock(pass)) throw new Error('This database has a vault passphrase; set KEAS_VAULT_PASSPHRASE or run in vault mode.');
  return pass;
}
