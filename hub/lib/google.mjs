// "Verify with Google": checks a Google ID token (RS256, signed by Google) so the Hub knows the person owns an email.
// Only the openid/email scopes are needed, which Google doesn't put through app review. The token's audience must be
// one of the Kea OAuth client IDs the Hub is configured with (KEA_GOOGLE_CLIENT_IDS, comma-separated).
import { createPublicKey, verify } from 'node:crypto';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** Fetches and caches Google's signing keys (honours Cache-Control max-age; at least 5 minutes). */
export function googleKeys({ fetchFn = fetch, nowFn = Date.now } = {}) {
  let cache = null, until = 0;
  return async (force = false) => {
    if (!force && cache && nowFn() < until) return cache;
    const r = await fetchFn(CERTS);
    if (!r.ok) throw new Error(`Couldn't reach Google (${r.status}).`);
    const age = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1]) || 3600;
    cache = (await r.json()).keys || [];
    until = nowFn() + Math.max(300, age) * 1000;
    return cache;
  };
}

/** Returns { email, name, sub, iat } for a valid token, or throws with a plain message. */
export async function verifyGoogleIdToken(idToken, { clientIds, keys, nowMs = Date.now(), maxAgeMs = 10 * 60_000 }) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 401 }); };
  if (!clientIds?.length) throw Object.assign(new Error('Google verification is not set up on this Hub yet.'), { status: 503 });
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) fail('That Google sign-in is not valid.');
  let head, p;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); p = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { fail('That Google sign-in is not valid.'); }
  if (head.alg !== 'RS256' || !head.kid) fail('That Google sign-in is not valid.');
  let jwk = (await keys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === head.kid);
  if (!jwk) fail('That Google sign-in is not valid.');
  const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) fail('That Google sign-in is not valid.');
  if (!ISSUERS.has(p.iss)) fail('That sign-in is not from Google.');
  if (!clientIds.includes(p.aud)) fail('That Google sign-in was made for a different app.');
  if (typeof p.exp !== 'number' || p.exp * 1000 <= nowMs) fail('That Google sign-in has expired. Try again.');
  if (typeof p.iat !== 'number' || nowMs - p.iat * 1000 > maxAgeMs) fail('That Google sign-in is too old. Try again.');
  if (p.email_verified !== true || typeof p.email !== 'string') fail("Google hasn't verified that email address.");
  return { email: p.email.toLowerCase(), name: p.name ?? null, sub: p.sub, iat: p.iat };
}
