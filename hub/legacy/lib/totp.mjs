// TOTP (RFC 6238): the 6-digit codes from an authenticator app. 30-second steps, SHA-1 (what every app supports),
// one step of clock drift allowed either way, and each code can be used only once (the caller stores the last step).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHA.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(randomBytes(20));

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

export const stepOf = (ms) => Math.floor(ms / 30000);

/** The matching step, or null. Steps at or before `lastStep` are refused, so a seen code can't be replayed. */
export function checkCode(secret, code, nowMs, lastStep = -1) {
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepOf(nowMs);
  for (const s of [now - 1, now, now + 1]) {
    if (s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUri = (secret, account, issuer = 'Kea') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- TOTP secrets at rest ----------
// Stored sealed (AES-256-GCM), bound to the account id, so a copy of hub.db alone gives nobody the codes. The key is
// derived from the Hub's signing key (hub-signing-key.pem, in the same locked-down folder and in every backup), so a
// restored backup still opens them. Secrets stored before this (plain base32) are sealed when the Hub starts.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

const SEALED = 'v1:';
/** The sealing key, from the Hub's Ed25519 private KeyObject. */
export const totpKeyFrom = (privateKey) => Buffer.from(hkdfSync('sha256', privateKey.export({ type: 'pkcs8', format: 'der' }), 'kea-hub', 'totp-secrets v1', 32));
export const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(SEALED);
export function sealSecret(key, secret, accountId) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`kea-totp:${accountId}`));
  const ct = Buffer.concat([c.update(String(secret), 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
// ---------- backup codes ----------
// Ten one-time codes for when the phone with the authenticator app is gone. Each is 10 characters from an alphabet
// without look-alikes (about 49 bits), shown once as XXXXX-XXXXX. Only an HMAC-SHA256 of each is stored, keyed with a
// key derived from the Hub's signing key and bound to the account id, so a copy of hub.db alone can't be used to test
// guesses offline.
const BACKUP_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BACKUP_COUNT = 10;
const BACKUP_LEN = 10;
export const backupKeyFrom = (privateKey) => Buffer.from(hkdfSync('sha256', privateKey.export({ type: 'pkcs8', format: 'der' }), 'kea-hub', 'totp-backup-codes v1', 32));
/** n new codes, formatted for people: "ABCDE-FGH23". */
export function newBackupCodes(n = BACKUP_COUNT) {
  const out = new Set();
  while (out.size < n) {
    // (Rejection sampling: no character is more likely than another.)
    let s = '';
    while (s.length < BACKUP_LEN) for (const b of randomBytes(16)) if (b < 248 && s.length < BACKUP_LEN) s += BACKUP_ALPHA[b % BACKUP_ALPHA.length];
    out.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...out];
}
/** What someone typed, as stored: upper case, no spaces or dashes; null when it can't be a backup code. */
export function normBackupCode(code) {
  const c = String(code ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (c.length !== BACKUP_LEN) return null;
  for (const ch of c) if (!BACKUP_ALPHA.includes(ch)) return null;
  return c;
}
export const hashBackupCode = (key, accountId, normalized) => createHmac('sha256', key).update(`kea-backup:${accountId}:${normalized}`).digest('hex');
/** Constant-time: the one of `hashes` equal to `hash`, or null. Every one is compared, so the time says nothing. */
export function backupMatch(hash, hashes) {
  const want = Buffer.from(hash, 'hex');
  let found = null;
  for (const h of hashes) {
    const b = Buffer.from(h, 'hex');
    const same = b.length === want.length && timingSafeEqual(b, want);
    if (same) found = h;
  }
  return found;
}

/** The base32 secret (a plain one from before sealing comes back as is), or null for none. Throws if tampered with. */
export function openSecret(key, stored, accountId) {
  if (stored == null) return null;
  if (!isSealed(stored)) return stored;
  const b = Buffer.from(stored.slice(SEALED.length), 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(`kea-totp:${accountId}`));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
