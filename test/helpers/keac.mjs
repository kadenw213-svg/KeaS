// A fake KeaC (the Kea account server) for tests, doing what docs/protocol.md section 2 says: Ed25519 keys with kids
// and statuses at /v1/keys, passes signed with the current key, and /v1/revoked (the whole list without `since`, with
// full: true; only what changed with it). It can be taken down, and its keys rotated.
import http from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(jwk.x).digest('base64url').slice(0, 16);
  return { privateKey, kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' } };
}
/** A JWT-shaped EdDSA token signed with `key`. */
export function signWith(key, payload, kid = key.kid) {
  const head = enc({ alg: 'EdDSA', typ: 'JWT', kid });
  const body = enc(payload);
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`;
}

export async function fakeKeac({ now = () => Date.now() } = {}) {
  const st = { keys: [{ ...newKey(), status: 'current' }], revoked: new Map(), down: false, calls: [], accounts: new Map(), sessions: new Map() };
  const current = () => st.keys.find((k) => k.status === 'current');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    st.calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (st.down) { req.socket.destroy(); return; }
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // (Kea accounts, enough for the KeaS app: sign-in with a two-step code when set, /v1/me, passes, sign-out.)
    const body = () => new Promise((r) => { let t = ''; req.on('data', (c) => (t += c)); req.on('end', () => { try { r(JSON.parse(t || '{}')); } catch { r({}); } }); });
    const me = () => st.sessions.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    const pub = (a) => ({ id: a.id, email: a.email, displayName: a.name, totpEnabled: !!a.code });
    if (u.pathname === '/v1/health') return json(200, { ok: true, service: 'keac', features: ['pass'] });
    if (u.pathname === '/v1/auth/login') return body().then((b) => {
      const a = st.accounts.get(String(b.email || '').toLowerCase());
      if (!a || a.password !== b.password) return json(401, { error: 'Wrong email or password.' });
      if (a.code && b.code !== a.code) return json(401, { error: b.code ? 'That code is wrong.' : 'Enter your two-step code.', totpRequired: true });
      const token = Math.random().toString(16).slice(2) + Date.now();
      st.sessions.set(token, a);
      json(200, { token, me: pub(a), account: pub(a) });
    });
    if (u.pathname === '/v1/me') { const a = me(); return a ? json(200, { account: pub(a) }) : json(401, { error: 'Sign in again.' }); }
    if (u.pathname === '/v1/auth/logout') { st.sessions.delete(String(req.headers.authorization || '').replace(/^Bearer /, '')); return json(200, { ok: true }); }
    if (u.pathname === '/v1/pass') return body().then((b) => {
      const a = me();
      if (!a) return json(401, { error: 'Sign in again.' });
      const iat = Math.floor(now() / 1000), exp = iat + 7 * 86400;
      json(200, { pass: signWith(current(), { iss: 'kea', aud: `keas:${b.serverId}`, sub: a.id, email: a.email, name: a.name, ev: true, iat, exp }), exp: exp * 1000 });
    });
    if (u.pathname === '/v1/keys') return json(200, { keys: st.keys.filter((k) => k.status !== 'removed').map((k) => ({ ...k.jwk, status: k.status })) });
    if (u.pathname === '/v1/revoked') {
      const since = Number(u.searchParams.get('since')) || 0;
      const active = [...st.revoked].filter(([, r]) => r.active);
      if (since > 0) return json(200, { now: now(), ids: active.filter(([, r]) => r.at > since).map(([id]) => id), full: false });
      return json(200, { now: now(), ids: active.map(([id]) => id), full: true });
    }
    json(404, { error: 'Not found.' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, st,
    get key() { return current(); },
    /** A pass for `serverId` (or any aud), like KeaC's POST /v1/pass makes. Times in seconds. */
    pass({ serverId, aud = `keas:${serverId}`, sub, email, name = '', iat = Math.floor(now() / 1000), exp = iat + 7 * 86400, key = current(), ev = true, iss = 'kea', extra = {} }) {
      return signWith(key, { iss, aud, sub, email, name, ev, iat, exp, ...extra });
    },
    /** A Kea account people can sign in to (code: its two-step code, when on). */
    addAccount({ id, email, password, name = '', code = null }) { st.accounts.set(email.toLowerCase(), { id, email: email.toLowerCase(), password, name, code }); },
    revoke(id) { st.revoked.set(id, { at: now(), active: true }); },
    unrevoke(id) { const r = st.revoked.get(id); if (r) { r.active = false; r.at = now(); } },
    /** Publishes a new key as 'next'; promote() makes it current and retires the old one. */
    addNext() { const k = { ...newKey(), status: 'next' }; st.keys.push(k); return k; },
    promote() { for (const k of st.keys) if (k.status === 'current') k.status = 'retired'; st.keys.find((k) => k.status === 'next').status = 'current'; return current(); },
    remove(kid) { st.keys.find((k) => k.kid === kid).status = 'removed'; },
    setDown(v) { st.down = !!v; },
    close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }),
  };
}
