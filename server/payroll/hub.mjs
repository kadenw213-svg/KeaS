// Signing payroll admins in with their Kea Hub account. The Hub checks the password (and two-step code) and issues a
// short-lived Ed25519-signed token for the audience "keas-payroll"; this vault checks it against the Hub's public key.
//
// Which Hub, and which key:
//   - The Hub's address is fixed by the KeaS app on this computer (its own Hub, or the one in its settings), never by
//     whoever sends a request. The password is relayed to that address only, for that one request, and never stored
//     or logged here.
//   - The Hub's signing key (and issuer) is pinned when the vault is set up. Later tokens must be signed by that key:
//     a different key is refused until the owner accepts it in the KeaS app (repinHub), after seeing its fingerprint.
import { createPublicKey, createHash, randomBytes, verify as edVerify } from 'node:crypto';
import { verifyToken } from '../../hub/lib/tokens.mjs';

export const AUDIENCE = 'keas-payroll';
export const ISSUER = 'kea-hub';
const SKEW_S = 120; // allowed clock difference between this PC and the Hub
const MAX_LIFETIME_S = 60 * 60; // the Hub issues 15-minute tokens; anything far longer isn't one of its

export class HubUnreachable extends Error { constructor(m) { super(m || 'Can’t reach the Kea Hub.'); } }
export class HubRefused extends Error { constructor(m, status, extra) { super(m); this.status = status; this.extra = extra; } }
/**
 * A Hub key's fingerprint for people to compare: SHA-256 of its public key(s), in groups of four. The KeaS app shows
 * it before the owner accepts a new key (and checks it against this PC's own Hub key file when it has one).
 */
export function keyFingerprint(keys) {
  const xs = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k?.x || '')).filter(Boolean).sort();
  if (!xs.length) return null;
  return createHash('sha256').update(xs.join(',')).digest('hex').toUpperCase().match(/.{4}/g).join(' ');
}
export const KEY_CHANGE_REASONS = [
  'The Kea Hub was reinstalled, or moved to another PC.',
  'KeaS locked down the Hub’s data folder after finding it open to other accounts on that PC, and made new keys.',
  'The Hub’s data folder was restored from a backup made before its key changed.',
];
export const KEY_CHANGE_WARNING = 'If none of these happened, don’t accept the new key: someone may be pretending to be your Kea Hub to get into payroll.';

export const NOT_OUR_HUB = 'Whatever is answering at the Kea Hub’s address couldn’t prove it’s your Kea Hub (it doesn’t hold the signing key payroll trusts), so your password and code weren’t sent to it. If the Hub was moved or reinstalled, the owner can check and accept its new key in the KeaS app on this computer (Payroll, Advanced).';
export const KEY_CHANGED = 'The Kea Hub’s signing key isn’t the one this vault trusts. If the Hub was moved or reinstalled, the owner can accept its new key in the KeaS app on this computer (Payroll, Advanced). Until then, Kea Hub sign-in is refused.';

/** A Hub address the vault will send a password to: https anywhere, or plain http only to this computer. */
export function checkHubUrl(url) {
  if (url == null || url === '') return null;
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('The Kea Hub address isn’t a valid address.'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('The Kea Hub address can’t include a user name, query or fragment.');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The Kea Hub address must start with https:// (plain http only for this computer).');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const okp = (k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.x);
const tokenKid = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url')).kid ?? null; } catch { return null; } };

export function makeHubClient({ fetchImpl = fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
  async function call(base, path, { method = 'GET', body, token } = {}) {
    let r;
    try {
      r = await fetchImpl(base.replace(/\/+$/, '') + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new HubUnreachable(); }
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw new HubUnreachable(`The Kea Hub had a problem (${r.status}).`);
    // (Whether the Hub wants a two-step code goes along, so a used-up code gets its own message.)
    if (!r.ok) throw new HubRefused(j.error || `The Kea Hub said no (${r.status}).`, r.status, j.totpRequired ? { totpRequired: true } : undefined);
    return j;
  }

  /** The Hub's current public keys (for pinning): [{ kid, x, kty, crv }]. */
  async function fetchKeys(base) {
    const { keys } = await call(base, '/v1/keys');
    const out = (Array.isArray(keys) ? keys : []).filter(okp).map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid ?? null }));
    if (!out.length) throw new HubRefused('The Kea Hub didn’t offer a signing key.', 502);
    return out;
  }

  /**
   * The verified payload of a Hub token, checked against the given keys only: signature, issuer, audience, expiry,
   * not-before, issued-at and a sane lifetime.
   */
  function verifyWith(keys, token, { iss = ISSUER } = {}) {
    const t = Math.floor(now() / 1000);
    for (const jwk of keys || []) {
      if (!okp(jwk)) continue;
      let p = null;
      try { p = verifyToken(createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }), token, { aud: AUDIENCE, iss, nowMs: now() }); } catch {}
      if (!p) continue;
      if (typeof p.sub !== 'string' || !p.sub) break;
      if (typeof p.iat !== 'number' || p.iat > t + SKEW_S) break;
      if (p.nbf != null && (typeof p.nbf !== 'number' || p.nbf > t + SKEW_S)) break;
      if (p.exp - p.iat > MAX_LIFETIME_S) break;
      return p;
    }
    const known = new Set((keys || []).map((k) => k.kid).filter(Boolean));
    const kid = tokenKid(token);
    if (kid && known.size && !known.has(kid)) throw new HubRefused(KEY_CHANGED, 401, { hubKeyChanged: true });
    throw new HubRefused('The Kea Hub token didn’t check out.', 401);
  }

  /**
   * Proves the Hub at `base` holds one of `keys` before anything secret is sent to it: it signs a fresh random nonce
   * (GET /v1/identity) and the signature is checked here. Anything else on that address (another program on the Hub's
   * port while the Hub is down, or a look-alike) fails, and nothing is sent.
   */
  async function proveIdentity(base, keys) {
    const nonce = randomBytes(16).toString('hex');
    let j;
    try { j = await call(base, `/v1/identity?nonce=${nonce}`); } catch (e) { if (e instanceof HubUnreachable) throw e; throw new HubRefused(NOT_OUR_HUB, 401, { hubKeyChanged: true, notOurHub: true }); }
    const sig = typeof j?.sig === 'string' && j.sig.length <= 200 ? Buffer.from(j.sig, 'base64url') : null;
    const msg = Buffer.from(`kea-hub-identity:v1:${nonce}`);
    for (const jwk of keys || []) {
      if (!sig || !okp(jwk)) continue;
      try { if (edVerify(null, msg, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }), sig)) return true; } catch {}
    }
    throw new HubRefused(NOT_OUR_HUB, 401, { hubKeyChanged: true, notOurHub: true });
  }

  /**
   * Email + password (+ two-step code) at the Hub -> verified identity { sub, email, name, emailVerified, keys }.
   * pin: { url, iss, keys } pinned at setup. trust: keys known some other way (this PC's own Hub key file, from the
   * KeaS app). The Hub must first prove it holds the pinned (or trusted) key; without either (setting up with a Hub on
   * another PC), it must at least hold the key it offers, which is then returned so the caller can pin it.
   */
  async function signIn(base, { email, password, code }, { pin = null, trust = null } = {}) {
    if (!base) throw new HubUnreachable('No Kea Hub is set for this vault.');
    if (pin && pin.url !== base) throw new HubRefused(KEY_CHANGED, 401, { hubKeyChanged: true });
    const idKeys = pin?.keys || (trust?.length ? trust : await fetchKeys(base));
    await proveIdentity(base, idKeys);
    const login = await call(base, '/v1/auth/login', { method: 'POST', body: { email, password, ...(code ? { code } : {}) } });
    try {
      const t = await call(base, '/v1/auth/token', { method: 'POST', body: { aud: AUDIENCE }, token: login.token });
      const keys = pin ? pin.keys : idKeys;
      const p = verifyWith(keys, t.token, { iss: pin?.iss || ISSUER });
      return { sub: p.sub, email: String(p.email || '').toLowerCase(), name: p.name || null, emailVerified: p.ev === true, keys };
    } finally {
      call(base, '/v1/auth/logout', { method: 'POST', body: {}, token: login.token }).catch(() => {});
    }
  }

  /** Is the Hub answering at all (for the local fallback, which only works while it isn't)? */
  async function reachable(base) {
    if (!base) return false;
    try { await call(base, '/v1/health'); return true; } catch (e) { return !(e instanceof HubUnreachable); }
  }

  return { signIn, verifyWith, fetchKeys, reachable, proveIdentity };
}
