// The Kea account in KeaS: the same account as in the Kea app, on KeaC (the Kea account server). KeaS signs in there
// (email + password + two-step code, or Google in the browser: oauth.cjs), keeps that session encrypted with Windows
// (Electron safeStorage), and asks KeaC for passes for its own KeaS server (POST /v1/pass { serverId }). Passwords and
// two-step codes go to KeaC only, never to the KeaS server.
//
// No Electron here (protect/fetch are passed in), so it can be tested against a fake KeaC.
'use strict';
const fs = require('fs');
const path = require('path');

class AccountError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || null; }
}

/** A KeaC address people may use: https anywhere, plain http only to this computer. '' = none. */
function checkUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new AccountError('That isn’t a web address. It looks like https://name.tailnet.ts.net', 400); }
  if (!/^https?:$/.test(u.protocol)) throw new AccountError('Use an https:// address.', 400);
  if (u.username || u.password) throw new AccountError('The address can’t include a user name or password.', 400);
  if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new AccountError('Use the Kea account server’s https:// address. Plain http only works for one on this computer.', 400);
  return u.origin;
}

/**
 * dir: where the encrypted session and the account summary are kept. protect: { available(), encrypt(s) -> Buffer,
 * decrypt(Buffer) -> s }. getUrl(): KeaC's address (KeaS's settings), setUrl(u).
 */
function createAccount({ dir, protect, getUrl, setUrl = () => {}, fetchImpl = fetch, client = 'KeaS', timeoutMs = 10_000 }) {
  const tokenFile = () => path.join(dir, 'keac-session.bin');
  const cacheFile = () => path.join(dir, 'account.json');
  let memToken = null;
  const url = () => { const u = getUrl(); return u ? String(u).replace(/\/+$/, '') : null; };
  function readToken() {
    if (memToken) return memToken;
    try { if (!protect.available()) return null; return (memToken = protect.decrypt(fs.readFileSync(tokenFile()))); } catch { return null; }
  }
  function writeToken(t) {
    memToken = t || null;
    if (!t || !protect.available()) { fs.rmSync(tokenFile(), { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tokenFile(), protect.encrypt(t));
  }
  function cached() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return null; } }
  function saveCache(me) {
    if (!me) { fs.rmSync(cacheFile(), { force: true }); return null; }
    const a = me.account || me.me || me;
    const c = { id: a.id, email: a.email, name: a.displayName ?? a.name ?? null, totpEnabled: !!a.totpEnabled, keac: url(), at: Date.now() };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 1));
    return c;
  }
  function signOutHere() { writeToken(null); saveCache(null); }

  async function req(method, p, body, { auth = true, token } = {}) {
    const base = url();
    if (!base) throw new AccountError('Set the Kea account server’s address first.', 0, { noUrl: true });
    const t = token || (auth ? readToken() : null);
    let r;
    try {
      r = await fetchImpl(base + p, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-kea': '1', 'x-kea-client': client, ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new AccountError(`Can’t reach your Kea account server at ${base}. Check the internet connection, or the address under Advanced.`, 0); }
    const j = await r.json().catch(() => ({}));
    // The session ended (signed out elsewhere, password changed, suspended): signed out here too.
    if (r.status === 401 && auth && !token && t && !j.totpRequired && !j.mfaRequired) signOutHere();
    if (!r.ok) { const { error, ...data } = j; throw new AccountError(error || `The Kea account server said ${r.status}.`, r.status, data); }
    return j;
  }

  /** { url, signedIn, reachable, account }: account is what KeaS last knew while offline. */
  async function status() {
    const base = { url: url(), remembered: protect.available() };
    if (!url()) return { ...base, signedIn: false, reachable: false, account: null };
    if (!readToken()) {
      let reachable = false;
      try { await req('GET', '/v1/health', undefined, { auth: false }); reachable = true; } catch {}
      return { ...base, signedIn: false, reachable, account: null };
    }
    try { return { ...base, signedIn: true, reachable: true, account: saveCache(await req('GET', '/v1/me')) }; }
    catch (e) {
      if (e.status === 0) return { ...base, signedIn: true, reachable: false, account: cached() };
      if (e.status === 401) return { ...base, signedIn: false, reachable: true, account: null };
      throw e;
    }
  }
  /** Email + password, then (when KeaC asks: data.totpRequired) the same again with the code. */
  async function login({ email, password, code }) {
    const r = await req('POST', '/v1/auth/login', { email: String(email || '').trim(), password: String(password || ''), ...(code ? { code: String(code).trim() } : {}) }, { auth: false });
    writeToken(r.token);
    saveCache(r);
    return status();
  }
  /** Signing in with a Google or Microsoft ID token from the browser (oauth.cjs). */
  async function oauth({ provider, idToken }) {
    const r = await req('POST', '/v1/auth/oauth', { provider, idToken }, { auth: false });
    writeToken(r.token);
    saveCache(r);
    return status();
  }
  async function logout() {
    try { if (readToken() && url()) await req('POST', '/v1/auth/logout', {}); } catch {}
    signOutHere();
    return status();
  }
  /** Moves to another KeaC address. A sign-in belongs to the server it was made on: a different one signs out here. */
  async function changeUrl(next) {
    const from = url();
    setUrl(checkUrl(next));
    if (url() !== from) signOutHere();
    return status();
  }
  /** A pass for a KeaS server (docs/protocol.md 2.2): { pass, exp }. With `token`, from that KeaC session instead. */
  async function pass(serverId, { token } = {}) {
    if (!token && !readToken()) throw new AccountError('Sign in to your Kea account first.', 401, { need: 'signin' });
    const r = await req('POST', '/v1/pass', { serverId }, { token });
    if (typeof r.pass !== 'string') throw new AccountError('The Kea account server didn’t give a pass.', 502);
    return { pass: r.pass, exp: r.exp };
  }
  /**
   * A pass from a fresh sign-in (password and two-step code), for "Ask for my sign-in every time". That KeaC session
   * ends right after; the remembered one stays as it is.
   */
  async function freshPass(serverId, { password, code }) {
    const me = cached();
    if (!me?.email) throw new AccountError('Sign in to your Kea account first.', 401);
    const r = await req('POST', '/v1/auth/login', { email: me.email, password: String(password || ''), ...(code ? { code: String(code).trim() } : {}) }, { auth: false });
    try { return await pass(serverId, { token: r.token }); }
    finally { req('POST', '/v1/auth/logout', {}, { token: r.token }).catch(() => {}); }
  }

  return { url, status, login, oauth, logout, changeUrl, pass, freshPass, cached, signedIn: () => !!readToken(), forget: signOutHere };
}

module.exports = { createAccount, checkUrl, AccountError };
