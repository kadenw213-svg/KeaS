// The payroll vault's encryption: AES-256-GCM.
//
// - A random data key encrypts every sealed value. It is kept in vault_meta wrapped (sealed) under a key derived from
//   the vault passphrase by scrypt (N = 2^17), so making the KDF stronger later only rewraps the data key.
// - Each sealed value is bound to where it lives: the AES-GCM additional data is [table, column, ...row key], so a
//   value moved to another row, column or table no longer opens.
// - Sealed values look like "v2.<iv>.<tag>.<ciphertext>" (base64url). Vaults made by older KeaS versions ("v1" values
//   with no additional data, the key derived straight from the passphrase with N = 2^15) are moved to this format the
//   next time they're unlocked (see payroll/vaultstate.mjs).
// The key lives only in memory while the vault is unlocked.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const KDF_DEFAULT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** The weakest parameters a stored vault may name (older KeaS used N = 2^15; it's upgraded at the next unlock). */
export const KDF_MIN = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
const KDF_MAX_MEM = 1024 * 1024 * 1024; // 128 * N * r bytes at most (1 GiB)
const CHECK = 'keas-payroll-vault';
const WRAP_CTX = 'keas-payroll-vault-key';

export class VaultDamaged extends Error {}
/** A sealed value that's out of place, isn't sealed where it must be, or doesn't open: the file was changed outside KeaS. */
export class SealError extends Error {
  constructor(where, why) { super(`A protected payroll value (${where}) ${why}. The payroll database may have been changed outside KeaS; restore it from a backup.`); this.where = where; }
}

/** Validates stored scrypt parameters: N a power of two, at least KDF_MIN.N; r at least 8; p 1-16; memory bounded. */
export function checkKdf(kdf) {
  const { N, r, p } = kdf && typeof kdf === 'object' ? kdf : {};
  const ok = Number.isSafeInteger(N) && Number.isSafeInteger(r) && Number.isSafeInteger(p)
    && N >= KDF_MIN.N && (N & (N - 1)) === 0 && N <= 2 ** 22
    && r >= KDF_MIN.r && r <= 32 && p >= 1 && p <= 16 && 128 * N * r <= KDF_MAX_MEM;
  if (!ok) throw new VaultDamaged('The payroll vault’s key settings are outside the safe range (it may have been tampered with). Restore it from a backup.');
  return { N, r, p };
}
/** True when stored parameters are weaker than today's default (the vault is upgraded at the next unlock). */
export const kdfIsWeak = (kdf) => Number(kdf?.N) < KDF_DEFAULT.N || Number(kdf?.r) < KDF_DEFAULT.r;

export function deriveKey(passphrase, saltB64, kdf = KDF_DEFAULT) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('passphrase required');
  const { N, r, p } = checkKdf(kdf);
  const salt = Buffer.from(String(saltB64 || ''), 'base64url');
  if (salt.length < 16) throw new VaultDamaged('The payroll vault’s salt is missing or too short. Restore it from a backup.');
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 + 1024 * 1024 });
}

/** Additional data for a value stored in the database: [table, column, ...row key]. */
export const sealContext = (table, column, keys) => JSON.stringify([String(table), String(column), ...keys.map((k) => String(k))]);
const aadOf = (ctx) => {
  if (typeof ctx !== 'string' || !ctx) throw new Error('a sealed value needs its context (table, column and row)');
  return Buffer.from(ctx, 'utf8');
};

export function seal(key, plaintext, ctx) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(ctx));
  const ct = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
  return ['v2', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

const SEALED_RE = /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
const SEALED_V1_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
/** A value in today's sealed format. */
export const isSealed = (v) => typeof v === 'string' && SEALED_RE.test(v);
/** A value sealed by an older KeaS (no additional data). */
export const isSealedV1 = (v) => typeof v === 'string' && SEALED_V1_RE.test(v);

export function unseal(key, sealed, ctx) {
  if (!isSealed(sealed)) throw new Error('not a sealed value');
  const [, iv, tag, ct] = sealed.split('.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(aadOf(ctx));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Opens a value sealed by an older KeaS ("v1", no additional data). Only the one-time upgrade uses this. */
export function unsealV1(key, sealed) {
  if (!isSealedV1(sealed)) throw new Error('not a v1 sealed value');
  const [, iv, tag, ct] = sealed.split('.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
/** Seals the way an older KeaS did (tests build old vaults with it). */
export function sealV1(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * A new vault (or new key settings for one): salt, KDF parameters and the data key wrapped under the passphrase.
 * dataKey: keep this data key (only the wrapping changes); by default a new random one.
 */
export function createVaultMeta(passphrase, { kdf = KDF_DEFAULT, dataKey = null } = {}) {
  if (String(passphrase).length < 12) throw new Error('The vault passphrase needs at least 12 characters.');
  const salt = randomBytes(16).toString('base64url');
  const kek = deriveKey(passphrase, salt, kdf);
  const key = dataKey ? Buffer.from(dataKey) : randomBytes(32);
  const meta = { v: 2, salt, kdf: { N: kdf.N, r: kdf.r, p: kdf.p }, wrapped: seal(kek, key.toString('base64'), WRAP_CTX) };
  kek.fill(0);
  return { key, meta };
}

/**
 * Opens the vault's data key with the passphrase: { key, legacy, weakKdf }, or null when the passphrase is wrong.
 * legacy: a vault from an older KeaS (its key is the passphrase-derived key itself and its values are v1), which
 * needs the one-time upgrade. Throws VaultDamaged when the stored settings are missing or out of bounds.
 */
export function openVault(passphrase, meta) {
  if (!meta || typeof meta !== 'object') throw new VaultDamaged('The payroll vault’s key settings are missing. Restore it from a backup.');
  checkKdf(meta.kdf);
  if (meta.v != null && meta.v !== 2) throw new VaultDamaged('This payroll vault was made by a newer KeaS. Update KeaS to open it.');
  let kek;
  try { kek = deriveKey(passphrase, meta.salt, meta.kdf); } catch (e) { if (e instanceof VaultDamaged) throw e; return null; }
  try {
    if (meta.v === 2) {
      const key = Buffer.from(unseal(kek, meta.wrapped, WRAP_CTX), 'base64');
      kek.fill(0);
      if (key.length !== 32) return null;
      return { key, legacy: false, weakKdf: kdfIsWeak(meta.kdf) };
    }
    const v = unsealV1(kek, meta.check);
    return timingSafeEqual(Buffer.from(v), Buffer.from(CHECK)) ? { key: kek, legacy: true, weakKdf: true } : null;
  } catch {
    return null;
  }
}

/** The vault settings an older KeaS wrote (tests build old vaults with it). */
export function createLegacyVaultMeta(passphrase) {
  const salt = randomBytes(16).toString('base64url');
  const kdf = { ...KDF_MIN };
  const key = deriveKey(passphrase, salt, kdf);
  return { key, meta: { salt, kdf, check: sealV1(key, CHECK) } };
}

/** Local fallback passwords (scrypt, salted). */
export function hashLocalPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(String(pw).normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function checkLocalPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) {
    scryptSync('x', 'y', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); // same work either way
    return false;
  }
  const h = scryptSync(String(pw).normalize('NFC'), Buffer.from(salt, 'base64url'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(h, Buffer.from(hash, 'base64url'));
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Stable JSON (sorted keys) so a signed document always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
