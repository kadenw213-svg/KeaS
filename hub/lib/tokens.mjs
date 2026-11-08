// Signed tokens with the KeaS server's identity key (Ed25519): the payroll vault's 15-minute sign-in token
// (hub/index.mjs /owner/payroll-token), checked against this server's public key.
// Format: base64url(header).base64url(payload).base64url(signature), JWT-shaped with alg EdDSA.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeSecretFile } from './secureFile.mjs';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Loads the Hub key from `file`, creating it the first time. (Readable by the Hub's own account only: hub/lib/secureFile.mjs.) */
export function loadOrCreateKey(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeSecretFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  return keyFromPem(readFileSync(file));
}
/** { privateKey, publicKey, kid, jwk } from a PEM. kid: the first 16 characters of base64url(SHA-256(x)), as KeaC's. */
export function keyFromPem(pem) {
  const privateKey = createPrivateKey(pem);
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
