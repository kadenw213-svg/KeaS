// Signing payroll admins in with their Kea Hub account. The Hub checks the password (and two-step code) and issues a
// short-lived Ed25519-signed token for the audience "keas-payroll"; this vault checks the signature with the Hub's
// public keys (GET /v1/keys). The password is relayed to the Hub for that one request and never stored or logged here.
import { createPublicKey } from 'node:crypto';
import { verifyToken } from '../../hub/lib/tokens.mjs';

export const AUDIENCE = 'keas-payroll';

export class HubUnreachable extends Error { constructor(m) { super(m || 'Can’t reach the Kea Hub.'); } }
export class HubRefused extends Error { constructor(m, status) { super(m); this.status = status; } }

export function makeHubClient({ fetchImpl = fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
  async function call(base, path, { method = 'GET', body, token } = {}) {
    let r;
    try {
      r = await fetchImpl(base.replace(/\/+$/, '') + path, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new HubUnreachable(); }
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw new HubUnreachable(`The Kea Hub had a problem (${r.status}).`);
    if (!r.ok) throw new HubRefused(j.error || `The Kea Hub said no (${r.status}).`, r.status);
    return j;
  }

  /** The verified token payload for a signed Hub token. */
  async function verify(base, token) {
    const { keys } = await call(base, '/v1/keys');
    for (const jwk of keys || []) {
      try {
        const p = verifyToken(createPublicKey({ key: jwk, format: 'jwk' }), token, { aud: AUDIENCE, nowMs: now() });
        if (p) return p;
      } catch {}
    }
    throw new HubRefused('The Kea Hub token didn’t check out.', 401);
  }

  /** Email + password (+ two-step code) at the Hub -> verified identity { sub, email, name }. */
  async function signIn(base, { email, password, code }) {
    if (!base) throw new HubUnreachable('No Kea Hub address is set for this vault.');
    const login = await call(base, '/v1/auth/login', { method: 'POST', body: { email, password, ...(code ? { code } : {}) } });
    try {
      const t = await call(base, '/v1/auth/token', { method: 'POST', body: { aud: AUDIENCE }, token: login.token });
      const p = await verify(base, t.token);
      return { sub: p.sub, email: String(p.email || '').toLowerCase(), name: p.name || null };
    } finally {
      call(base, '/v1/auth/logout', { method: 'POST', body: {}, token: login.token }).catch(() => {});
    }
  }

  return { signIn, verify };
}
