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
