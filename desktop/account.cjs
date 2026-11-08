// The Kea account in KeaS: the same account as in the Kea app, signed in at the Kea Hub's /v1/auth routes. The
// session token is kept encrypted with Windows (Electron safeStorage, like Kea does), so KeaS stays signed in between
// runs; it's never shown to the page. Without Windows encryption it's kept in memory only, for this run.
//
// No Electron here (protect/fetch are passed in), so it can be tested against a real Hub.
'use strict';
const fs = require('fs');
const path = require('path');

// Where KeaS finds the Kea Hub unless the person sets another address (Advanced: Hub address).
const DEFAULT_HUB_URL = 'http://127.0.0.1:4860';

class AccountError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || null; }
}

/** A Hub address people may use: https anywhere, plain http only to this computer (as in Kea). '' = the default. */
function checkUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new AccountError('That isn’t a web address. It looks like https://name.tailnet.ts.net', 400); }
  if (!/^https?:$/.test(u.protocol)) throw new AccountError('Use an https:// address.', 400);
  if (u.username || u.password) throw new AccountError('The address can’t include a user name or password.', 400);
  // Plain http only to this computer itself: anywhere else, someone on the network could pose as the Hub.
  if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new AccountError('Use the Hub’s https:// address (it looks like https://name.tailnet.ts.net). Plain http only works for a Hub on this computer.', 400);
  return u.origin;
}

/**
 * dir: where the encrypted session and the account summary are kept. protect: { available(), encrypt(s) -> Buffer,
 * decrypt(Buffer) -> s }. getUrl/setUrl: the Hub address in KeaS's settings (null = the default).
 */
function createAccount({ dir, protect, getUrl, setUrl, fetchImpl = fetch, client = 'KeaS', timeoutMs = 10_000 }) {
  const tokenFile = () => path.join(dir, 'hub-session.bin');
  const cacheFile = () => path.join(dir, 'account.json');
  let memToken = null;

  const url = () => (getUrl() || DEFAULT_HUB_URL).replace(/\/+$/, '');
  function readToken() {
    if (memToken) return memToken;
    try {
      if (!protect.available()) return null;
      return (memToken = protect.decrypt(fs.readFileSync(tokenFile())));
    } catch { return null; }
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
    const a = me.account || me;
    const c = { id: a.id, email: a.email, name: a.displayName ?? a.name ?? null, owner: !!a.owner, totpEnabled: !!a.totpEnabled, backupCodesLeft: a.backupCodesLeft ?? null, emailVerified: !!a.emailVerified, hub: url(), terms: me.terms ?? null, at: Date.now() };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 1));
    return c;
  }
  function signOutHere() { writeToken(null); saveCache(null); }

  // reauth: a call that checks the password again, where a 401 can just mean a wrong password (still signed in).
  async function req(method, p, body, { auth = true, token, reauth = false } = {}) {
    const t = token || (auth ? readToken() : null);
    let r;
    try {
      r = await fetchImpl(url() + p, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-kea': '1', 'x-kea-client': client, ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new AccountError(`Can’t reach the Kea Hub at ${url()}. Check your internet, or the Hub address under Advanced.`, 0); }
    const j = await r.json().catch(() => ({}));
    // The session ended (signed out elsewhere, password changed, suspended): signed out here too.
    if (r.status === 401 && auth && !token && t && !j.totpRequired && (!reauth || /^(Sign in|Your sign-in expired)/.test(String(j.error || '')))) signOutHere();
    if (!r.ok) { const { error, ...data } = j; throw new AccountError(error || `The Kea Hub said ${r.status}.`, r.status, data); }
    return j;
  }

  async function refresh() {
    const me = await req('GET', '/v1/me');
    return saveCache(me);
  }
  /** { url, defaultUrl, signedIn, reachable, account } — account is what KeaS last knew while offline. */
  async function status() {
    const base = { url: url(), defaultUrl: DEFAULT_HUB_URL, custom: !!getUrl(), remembered: protect.available() };
    if (!readToken()) {
      let reachable = false;
      try { await req('GET', '/v1/health', undefined, { auth: false }); reachable = true; } catch {}
      return { ...base, signedIn: false, reachable, account: null };
    }
    try { return { ...base, signedIn: true, reachable: true, account: await refresh() }; }
    catch (e) {
      if (e.status === 0) return { ...base, signedIn: true, reachable: false, account: cached() };
      if (e.status === 401) return { ...base, signedIn: false, reachable: true, account: null };
      throw e;
    }
  }
  /** Email + password, then (when the Hub asks: AccountError with data.totpRequired) the same again with the code. */
  async function login({ email, password, code }) {
    const r = await req('POST', '/v1/auth/login', { email: String(email || '').trim(), password: String(password || ''), ...(code ? { code: String(code).trim() } : {}) }, { auth: false });
    writeToken(r.token);
    saveCache({ account: r.account, terms: r.terms });
    return status();
  }
  /** A new Kea account (the Hub answers the same for an email that already has one), then signed in. */
  async function register({ name, email, password, age13, termsVersion, termsSections }) {
    await req('POST', '/v1/auth/register', { email: String(email || '').trim(), password, displayName: String(name || '').trim(), age13: age13 === true, termsVersion, termsSections }, { auth: false });
    try { return await login({ email, password }); }
    catch (e) {
      if (e.status === 401 || e.status === 429) throw new AccountError('This email may already have a Kea account. Sign in instead.', 409, { exists: true });
      throw e;
    }
  }
  async function logout() {
    try { if (readToken()) await req('POST', '/v1/auth/logout', {}); } catch {}
    signOutHere();
    return status();
  }
  /** Moves to another Hub address. A sign-in belongs to the Hub it was made on: a different one signs out here. */
  async function changeUrl(next) {
    const from = url();
    setUrl(checkUrl(next));
    if (url() !== from) signOutHere();
    return status();
  }
  const terms = () => req('GET', '/v1/terms', undefined, { auth: false });
  const acceptTerms = async ({ termsVersion, termsSections }) => { await req('POST', '/v1/terms/accept', { termsVersion, termsSections }); return status(); };
  /** A session made somewhere else in KeaS (the owner account made during the Hub setup). */
  function adopt(token, hubUrl) {
    if (hubUrl && (getUrl() || DEFAULT_HUB_URL).replace(/\/+$/, '') !== hubUrl) setUrl(hubUrl === DEFAULT_HUB_URL ? null : hubUrl);
    writeToken(token);
  }

  /** A short-lived signed token for the payroll vault, from the remembered sign-in (nothing asked). */
  async function payrollToken() {
    if (!readToken()) throw new AccountError('Sign in to your Kea account first.', 401);
    return (await req('POST', '/v1/auth/token', { aud: 'keas-payroll' })).token;
  }
  /**
   * The same, from a fresh sign-in with the password (and two-step code), for "Ask for my sign-in every time". That
   * sign-in is ended right after; the remembered one stays as it is.
   */
  async function freshPayrollToken({ password, code }) {
    const me = cached();
    if (!me?.email) throw new AccountError('Sign in to your Kea account first.', 401);
    const r = await req('POST', '/v1/auth/login', { email: me.email, password: String(password || ''), ...(code ? { code: String(code).trim() } : {}) }, { auth: false });
    try { return (await req('POST', '/v1/auth/token', { aud: 'keas-payroll' }, { token: r.token })).token; }
    finally { req('POST', '/v1/auth/logout', {}, { token: r.token }).catch(() => {}); }
  }

  // The organizations this account belongs to on the Hub (create, join with a code, the state where people work).
  const orgs = async () => (await req('GET', '/v1/orgs')).orgs || [];
  const createOrg = ({ name, state, tz }) => req('POST', '/v1/orgs', { name: String(name || '').trim(), kind: 'private', state: state || null, tz: tz || 'America/Denver' });
  const joinOrg = ({ code }) => req('POST', '/v1/orgs/join', { code: String(code || '').trim() });
  const updateOrg = ({ id, state }) => req('POST', `/v1/orgs/${encodeURIComponent(String(id))}`, { state: state || null });
  const oid = (id) => encodeURIComponent(String(id));
  // (An older Kea Hub answers a route it doesn't have with a bare 404 "Not found.")
  const missingRoute = (e) => (e.status === 404 || e.status === 405) && e.message === 'Not found.';
  /**
   * For each organization this account manages: who's asking to join, and members whose email isn't verified yet.
   * [{ org: { id, name, role }, pending: [member], unverified: [member] }]. One it can't see the members of is left out.
   */
  async function orgPeople() {
    const out = [];
    for (const o of await orgs()) {
      if (!['owner', 'admin', 'manager'].includes(o.role) || o.memberStatus !== 'active' || o.status !== 'active') continue;
      try {
        const r = await req('GET', `/v1/orgs/${oid(o.id)}/members`);
        out.push({ org: { id: o.id, name: o.name, role: o.role }, pending: r.pending || [], unverified: (r.members || []).filter((m) => !m.emailVerified && !m.you) });
      } catch (e) { if (e.status === 0) throw e; }
    }
    return out;
  }
  /** An organization's pay codes, for the checklist: { count, given } (how many, and how many people have one). */
  async function orgPayCodes({ id }) {
    try { const r = await req('GET', `/v1/orgs/${oid(id)}/pay-codes`); return { count: (r.codes || []).filter((c) => c.active).length, given: (r.codes || []).reduce((a, c) => a + (c.holders || 0), 0) }; }
    catch (e) { if (missingRoute(e)) return { count: null, error: 'This Kea Hub has no pay codes yet. It needs a KeaS update.' }; throw e; }
  }
  /**
   * What payroll pays a period from (the org engine's pay feed): people, punches with their pay codes, the codes'
   * rates and timecard approvals. Needs rates.view and timecards.view for the whole organization.
   */
  const orgPayFeed = ({ id, from, to }) => req('GET', `/v1/orgs/${oid(id)}/pay-feed?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const orgApprove = ({ id, accountId, approve }) => req('POST', `/v1/orgs/${oid(id)}/members/${oid(accountId)}/approve`, { approve: approve !== false });
  async function orgVerifyEmail({ id, accountId }) {
    try { return await req('POST', `/v1/orgs/${oid(id)}/members/${oid(accountId)}/verify-email`, {}); }
    catch (e) { if (missingRoute(e)) throw new AccountError('This Kea Hub can’t verify emails yet. It needs a KeaS update.', 404); throw e; }
  }
  /** New two-step backup codes (password and a code from the authenticator app): { backupCodes, left }. */
  async function backupCodes({ password, code }) {
    try { return await req('POST', '/v1/me/totp/backup-codes', { password: String(password || ''), code: String(code || '').trim() }, { reauth: true }); }
    catch (e) { if (missingRoute(e)) throw new AccountError('This Kea Hub doesn’t have backup codes yet. It needs a KeaS update.', 404); throw e; }
  }

  return { url, status, login, orgs, createOrg, joinOrg, updateOrg, orgPeople, orgPayCodes, orgPayFeed, orgApprove, orgVerifyEmail, backupCodes, register, logout, changeUrl, terms, acceptTerms, adopt, payrollToken, freshPayrollToken, cached, signedIn: () => !!readToken(), forget: signOutHere };
}

module.exports = { createAccount, checkUrl, AccountError, DEFAULT_HUB_URL };
