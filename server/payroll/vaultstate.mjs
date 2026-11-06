// The vault's lock state for one running server: the key is held in memory only while unlocked.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createVaultMeta, openVault, seal, unseal, isSealed } from '../lib/vault.mjs';
import { SEALED_COLUMNS, SEALED_TEXT_COLUMNS, SEALED_VALUES } from './schema.mjs';

export class VaultLocked extends Error { constructor() { super('The payroll vault is locked. Sign in with the vault passphrase.'); } }

export function makeVault(h) {
  let key = null;
  // The database layer seals and opens SEALED_VALUES with the key while the vault is open (see db.mjs).
  const setKey = (k) => {
    key = k;
    h.setSealer?.(k ? { seal: (v) => seal(k, JSON.stringify(v)), open: (s) => JSON.parse(unseal(k, s)) } : null);
  };
  const meta = () => { const r = h.get("SELECT v FROM vault_meta WHERE k = 'crypto'"); return r ? JSON.parse(r.v) : null; };
  const need = () => { if (!key) throw new VaultLocked(); return key; };
  const v = {
    initialized: () => !!meta(),
    unlocked: () => !!key,
    create(passphrase) {
      if (meta()) throw new Error('The vault is already set up.');
      const r = createVaultMeta(passphrase);
      h.run("INSERT INTO vault_meta (k, v) VALUES ('crypto', ?)", JSON.stringify(r.meta));
      setKey(r.key);
    },
    /** True if the passphrase opens the vault (and unlocks it). */
    unlock(passphrase) {
      const m = meta(); if (!m) return false;
      const k = openVault(passphrase, m);
      if (k) { setKey(k); v.sealValues(); }
      return !!k;
    },
    lock() { setKey(null); },
    seal: (value) => seal(need(), JSON.stringify(value)),
    sealJson: (value) => (value == null ? null : seal(need(), JSON.stringify(value))),
    /** Opens a sealed value; plain JSON written before the vault existed is read as-is. */
    openJson(raw) {
      if (raw == null || raw === '') return null;
      if (isSealed(raw)) return JSON.parse(unseal(need(), raw));
      try { return JSON.parse(raw); } catch { return null; }
    },
    /** Re-encrypts every sealed column under a new passphrase. */
    rekey(current, next) {
      const m = meta();
      const oldKey = openVault(current, m);
      if (!oldKey) return false;
      if (key) v.sealValues();
      const r = createVaultMeta(next);
      h.tx(() => {
        for (const [table, id, col] of SEALED_COLUMNS) {
          for (const row of h.all(`SELECT ${id} AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
            const plain = isSealed(row.v) ? unseal(oldKey, row.v) : row.v;
            h.run(`UPDATE ${table} SET ${col} = ? WHERE ${id} = ?`, seal(r.key, plain), row.id);
          }
        }
        h.run("UPDATE vault_meta SET v = ? WHERE k = 'crypto'", JSON.stringify(r.meta));
      });
      setKey(r.key);
      return true;
    },
    /** Seals any plaintext left in sealed columns (data written before the vault was set up). */
    sealLegacy() {
      need();
      for (const [table, id, col] of SEALED_TEXT_COLUMNS) {
        for (const row of h.all(`SELECT ${id} AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`)) {
          if (!isSealed(row.v)) h.run(`UPDATE ${table} SET ${col} = ? WHERE ${id} = ?`, seal(key, row.v), row.id);
        }
      }
    },
    /**
     * Seals any plaintext left in SEALED_VALUES (rows written before they were sealed), once, then compacts the file so
     * no old plaintext page stays behind. Returns how many values were sealed.
     */
    sealValues() {
      need();
      let n = 0;
      h.tx(() => {
        for (const [table, cols] of SEALED_VALUES) for (const col of cols) {
          for (const row of h.db.prepare(`SELECT rowid AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all()) {
            if (isSealed(row.v)) continue;
            h.run(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`, seal(key, JSON.stringify(row.v)), row.id);
            n++;
          }
        }
      });
      if (n) { try { h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); h.db.exec('VACUUM'); h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} }
      return n;
    },
    setting(k, d = null) { const r = h.get('SELECT v FROM vault_meta WHERE k = ?', 'set:' + k); return r ? JSON.parse(r.v) : d; },
    setSetting(k, val) { h.run('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'set:' + k, JSON.stringify(val)); },
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
  vault.sealValues();
  vault.sealLegacy();
  return pass;
}
