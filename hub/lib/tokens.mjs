// Signed identity tokens. The Hub signs { who you are, which orgs/classes } with its Ed25519 key; org servers and Kea
// check the signature with the Hub's public key (GET /v1/keys), so a password only ever reaches the Hub.
// Format: base64url(header).base64url(payload).base64url(signature), JWT-shaped with alg EdDSA.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Loads the Hub key from `file`, creating it the first time. (On Windows the data folder is the protection; DPAPI wrapping comes with the installer.) */
export function loadOrCreateKey(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(file));
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(jwk.x).digest('base64url').slice(0, 16);
  return { privateKey, publicKey, kid, jwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' } };
}

export function signToken(key, payload) {
  const head = enc({ alg: 'EdDSA', typ: 'JWT', kid: key.kid });
  const body = enc(payload);
  const sig = sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** The payload if the signature, issuer, audience and expiry all check out; otherwise null. */
export function verifyToken(publicKey, token, { aud, nowMs = Date.now(), iss = 'kea-hub' } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (head.alg !== 'EdDSA') return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (p.iss !== iss || typeof p.exp !== 'number' || p.exp * 1000 <= nowMs) return null;
    if (aud != null && p.aud !== aud) return null;
    return p;
  } catch {
    return null;
  }
}
