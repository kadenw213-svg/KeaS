// Signing in to the Kea account with Google or Microsoft, in the system browser: an authorization code with PKCE, sent
// back to a one-time listener on this PC (a free port on the loopback address), exchanged for an ID token, which the
// Kea account server checks (POST /v1/auth/oauth). The same way the Kea app does it.
// The client ids (and, for Google's desktop clients, its client secret, which Google doesn't treat as a secret) come
// from KeaS's settings on this PC; they are never in the repository.
'use strict';
const http = require('http');
const crypto = require('crypto');

const b64u = (b) => b.toString('base64url');

const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // (Google's desktop clients take any loopback port and path.)
    redirect: (port) => `http://127.0.0.1:${port}/callback`,
    path: '/callback',
    extra: { prompt: 'select_account' },
  },
  microsoft: {
    label: 'Microsoft',
    // (common: personal Microsoft accounts and work or school ones.)
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // (Microsoft's app registrations take loopback redirects as http://localhost with any port.)
    redirect: (port) => `http://localhost:${port}`,
    path: '/',
    extra: { prompt: 'select_account', response_mode: 'query' },
  },
};
const SCOPE = 'openid email profile';

/**
 * An ID token from Google or Microsoft for `clientId`. open(url): opens the system browser. loginHint: the email to
 * suggest. Times out after `timeoutMs`. authUrl / tokenUrl: another sign-in service (the tests' stand-in).
 */
async function idToken({ provider = 'google', clientId, clientSecret = null, open, loginHint = null, fetchImpl = fetch, timeoutMs = 5 * 60_000, authUrl, tokenUrl }) {
  const P = PROVIDERS[provider];
  if (!P) throw new Error('Choose Google or Microsoft.');
  if (!clientId) throw new Error(`Signing in with ${P.label} isn’t set up in this KeaS.`);
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  const nonce = b64u(crypto.randomBytes(16));
  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== P.path) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'" });
    res.end('<!doctype html><meta charset="utf-8"><title>KeaS</title><p>You can close this tab and go back to KeaS.</p>');
    if (u.searchParams.get('state') !== state) return finish.reject(new Error('The sign-in answer didn’t match. Try again.'));
    if (u.searchParams.get('error')) return finish.reject(new Error(u.searchParams.get('error') === 'access_denied' ? `${P.label} sign-in was cancelled.` : `${P.label} said: ${u.searchParams.get('error')}`));
    finish.resolve(u.searchParams.get('code'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const redirect = P.redirect(srv.address().port);
  const timer = setTimeout(() => finish.reject(new Error(`The ${P.label} sign-in took too long. Try again.`)), timeoutMs);
  try {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, nonce, ...P.extra, ...(loginHint ? { login_hint: loginHint } : {}) });
    await open(`${authUrl || P.authUrl}?${q}`);
    const code = await done;
    const r = await fetchImpl(tokenUrl || P.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier, ...(provider === 'microsoft' ? { scope: SCOPE } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.id_token !== 'string') throw new Error(j.error_description || j.error || `${P.label} didn’t give an ID token.`);
    return j.id_token;
  } finally { clearTimeout(timer); srv.close(); }
}
/** (The name it had when KeaS signed in with Google only.) */
const googleIdToken = (o) => idToken({ ...o, provider: 'google' });

module.exports = { idToken, googleIdToken, PROVIDERS };
