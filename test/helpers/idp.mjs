// A stand-in for Google's (or Microsoft's) sign-in in tests: an authorize page that "signs in" as whoever the test says
// and sends the browser back to the redirect address with a code, and a token endpoint that checks the PKCE verifier
// against the challenge and answers with an RS256 ID token. Nothing here talks to the real providers.
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function fakeIdp({ clientId = 'keas-test-client' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const st = { as: 'pat@pool.org', codes: new Map(), calls: [] };
  const idToken = (email, aud = clientId) => {
    const t = Math.floor(Date.now() / 1000);
    const head = enc({ alg: 'RS256', typ: 'JWT', kid: 'idp' });
    const body = enc({ iss: 'https://accounts.google.com', aud, sub: `g-${email}`, email, email_verified: true, iat: t, exp: t + 3600, jti: randomBytes(8).toString('hex') });
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    st.calls.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) { res.writeHead(400); res.end('bad request'); return; }
      const code = randomBytes(12).toString('hex');
      st.codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), email: st.as, hint: q.get('login_hint') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let t = '';
      req.on('data', (c) => (t += c));
      req.on('end', () => {
        const f = new URLSearchParams(t);
        const c = st.codes.get(f.get('code'));
        st.codes.delete(f.get('code'));
        const ok = c && f.get('client_id') === clientId && f.get('redirect_uri') === c.redirect && createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { id_token: idToken(c.email), token_type: 'Bearer' } : { error: 'invalid_grant' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, st, clientId, idToken,
    authUrl: `${url}/authorize`, tokenUrl: `${url}/token`,
    /** The system browser: opens the authorize page and follows it back to KeaS's loopback listener. */
    open: async (address) => {
      const r = await fetch(address, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (loc) await fetch(loc.replace('://localhost:', '://127.0.0.1:'));
    },
    /** Checks one of its ID tokens: { email } or null. */
    check(token) {
      const [h, b, s] = String(token).split('.');
      if (!s || !verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url'))) return null;
      const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
      return p.aud === clientId && p.exp * 1000 > Date.now() ? { email: p.email } : null;
    },
    close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); }),
  };
}
