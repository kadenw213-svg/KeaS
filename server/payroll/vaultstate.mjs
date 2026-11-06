// The vault's lock state for one running server: the key is held in memory only while unlocked.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createVaultMeta, openVault, seal, unseal, isSealed } from '../lib/vault.mjs';
import { SEALED_COLUMNS } from './schema.mjs';

export class VaultLocked extends Error { constructor() { super('The payroll vault is locked. Sign in with the vault passphrase.'); } }

export function makeVault(h) {
  let key = null;
  const meta = () => { const r = h.get("SELECT v FROM vault_meta WHERE k = 'crypto'"); return r ? JSON.parse(r.v) : null; };
  const need = () => { if (!key) throw new VaultLocked(); return key; };
  const v = {
    initialized: () => !!meta(),
    unlocked: () => !!key,
    create(passphrase) {
      if (meta()) throw new Error('The vault is already set up.');
      const r = createVaultMeta(passphrase);
      h.run("INSERT INTO vault_meta (k, v) VALUES ('crypto', ?)", JSON.stringify(r.meta));
      key = r.key;
    },
    /** True if the passphrase opens the vault (and unlocks it). */
    unlock(passphrase) { const m = meta(); if (!m) return false; const k = openVault(passphrase, m); if (k) key = k; return !!k; },
    lock() { key = null; },
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
      key = r.key;
      return true;
    },
    /** Seals any plaintext left in sealed columns (data written before the vault was set up). */
    sealLegacy() {
      need();
      for (const [table, id, col] of SEALED_COLUMNS) {
        for (const row of h.all(`SELECT ${id} AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`)) {
          if (!isSealed(row.v)) h.run(`UPDATE ${table} SET ${col} = ? WHERE ${id} = ?`, seal(key, row.v), row.id);
        }
      }
    },
    setting(k, d = null) { const r = h.get('SELECT v FROM vault_meta WHERE k = ?', 'set:' + k); return r ? JSON.parse(r.v) : d; },
    setSetting(k, val) { h.run('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'set:' + k, JSON.stringify(val)); },
  };
  return v;
}

/**
 * Development and the plain workforce server: the vault is opened with a passphrase kept in a file next to the
 * database (or in memory for ':memory:'), so the sample data works without a sign-in step.
 */
export function openDevVault(vault, dbFile, passphrase) {
  let pass = passphrase || null;
  const file = dbFile && dbFile !== ':memory:' ? dbFile + '.vaultkey' : null;
  if (!pass && file && existsSync(file)) pass = readFileSync(file, 'utf8').trim();
  if (!vault.initialized()) {
    pass = pass || randomBytes(24).toString('base64url');
    vault.create(pass);
    if (file && !passphrase) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, pass, { mode: 0o600 }); }
  } else if (!pass || !vault.unlock(pass)) throw new Error('This database has a vault passphrase; set KEAS_VAULT_PASSPHRASE or run in vault mode.');
  vault.sealLegacy();
  return pass;
}
