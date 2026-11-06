// The payroll vault's encryption: AES-256-GCM with a key derived from the vault passphrase by scrypt.
// Sealed values look like "v1.<iv>.<tag>.<ciphertext>" (base64url). The key lives only in memory while the vault is unlocked.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const KDF_DEFAULT = { N: 2 ** 15, r: 8, p: 1 };
const CHECK = 'keas-payroll-vault';

export function deriveKey(passphrase, saltB64, kdf = KDF_DEFAULT) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('passphrase required');
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(saltB64, 'base64url'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
}

export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export const isSealed = (v) => typeof v === 'string' && v.startsWith('v1.') && v.split('.').length === 4;

export function unseal(key, sealed) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('not a sealed value');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** A new vault: salt, KDF parameters and a check value proving a passphrase is right. */
export function createVaultMeta(passphrase, kdf = KDF_DEFAULT) {
  if (String(passphrase).length < 12) throw new Error('The vault passphrase needs at least 12 characters.');
  const salt = randomBytes(16).toString('base64url');
  const key = deriveKey(passphrase, salt, kdf);
  return { key, meta: { salt, kdf, check: seal(key, CHECK) } };
}

/** The key if the passphrase opens this vault, else null. */
export function openVault(passphrase, meta) {
  try {
    const key = deriveKey(passphrase, meta.salt, meta.kdf);
    const v = unseal(key, meta.check);
    return timingSafeEqual(Buffer.from(v), Buffer.from(CHECK)) ? key : null;
  } catch {
    return null;
  }
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
