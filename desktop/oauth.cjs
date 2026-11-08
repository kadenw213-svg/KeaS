// Signing in to the Kea account with Google, in the browser: an authorization code with PKCE, sent back to a one-time
// listener on this PC (127.0.0.1, a free port), exchanged for an ID token, which KeaC checks (POST /v1/auth/oauth).
// The client id (and, for Google's desktop clients, its client secret, which Google doesn't treat as a secret) come
// from KeaS's settings on this PC; they are never in the repository.
'use strict';
const http = require('http');
const crypto = require('crypto');

const b64u = (b) => b.toString('base64url');

/** An ID token from Google for `clientId`. open(url): opens the browser. Times out after `timeoutMs`. */
async function googleIdToken({ clientId, clientSecret = null, open, fetchImpl = fetch, timeoutMs = 5 * 60_000, authUrl = 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl = 'https://oauth2.googleapis.com/token' }) {
  if (!clientId) throw new Error('No Google client id is set.');
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(16));
  const nonce = b64u(crypto.randomBytes(16));
  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'" });
    res.end('<!doctype html><meta charset="utf-8"><title>KeaS</title><p>You can close this tab and go back to KeaS.</p>');
    if (u.searchParams.get('state') !== state) return finish.reject(new Error('The sign-in answer didn’t match. Try again.'));
    if (u.searchParams.get('error')) return finish.reject(new Error(`Google said: ${u.searchParams.get('error')}`));
    finish.resolve(u.searchParams.get('code'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${srv.address().port}/callback`;
  const timer = setTimeout(() => finish.reject(new Error('The Google sign-in took too long. Try again.')), timeoutMs);
  try {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', code_challenge: challenge, code_challenge_method: 'S256', state, nonce, prompt: 'select_account' });
    await open(`${authUrl}?${q}`);
    const code = await done;
    const r = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.id_token !== 'string') throw new Error(j.error_description || j.error || 'Google didn’t give an ID token.');
    return j.id_token;
  } finally { clearTimeout(timer); srv.close(); }
}

module.exports = { googleIdToken };
