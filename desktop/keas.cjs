// KeaS's own sign-in to the KeaS server on this PC: a pass from the Kea account (account.cjs, KeaC) becomes a KeaS
// session (POST /v1/auth/pass), kept encrypted with Windows like the Kea account's. Kea does the same from anywhere;
// this is the KeaS app's copy, for setting the server up and running the organization from this PC (pay codes,
// roles, people), and for Payroll:
//   - the payroll vault's sign-in is a 15-minute token the KeaS server signs for this session (its owner console,
//     loopback with the owner key: /owner/payroll-token), never a password or a pass (docs/DEVELOPING.md, Payroll);
//   - payroll's hours come from the organization's pay feed, and finalized stubs go back to each member, both through
//     this session.
// The session is renewed with a newer pass once a day while KeaC can be reached (it lasts 30 days on the server).
//
// No Electron here (protect/fetch are passed in), so it can be tested against a real KeaS server and a fake KeaC.
'use strict';
const fs = require('fs');
const path = require('path');

class KeasError extends Error { constructor(message, status, data) { super(message); this.status = status; this.data = data || null; } }
const RENEW_MS = 20 * 3600_000;

/**
 * base(): the KeaS server's address on this PC. owner(method, path, body) -> { status, body }: its owner console.
 * serverId(): its id. account: the Kea account (account.cjs).
 */
function createKeasLink({ dir, protect, base, owner, serverId, account, fetchImpl = fetch, now = Date.now, client = 'KeaS app' }) {
  const file = () => path.join(dir, 'keas-session.bin');
  let mem = null;
  const read = () => {
    if (mem) return mem;
    try { if (!protect.available()) return null; mem = JSON.parse(protect.decrypt(fs.readFileSync(file()))); return mem; } catch { return null; }
  };
  const write = (s) => {
    mem = s || null;
    if (!s || !protect.available()) { fs.rmSync(file(), { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(), protect.encrypt(JSON.stringify(s)));
  };
  async function raw(method, p, body, token) {
    let r;
    try {
      r = await fetchImpl(base() + p, { method, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-kea-client': client, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new KeasError('The KeaS server on this PC isn’t answering. Start it from the status screen.', 0); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const { error, ...data } = j; throw new KeasError(error || `The KeaS server said ${r.status}.`, r.status, data); }
    return j;
  }
  const ownerOk = async (m, p, b) => { const r = await owner(m, p, b); if (r.status >= 400) throw new KeasError(r.body?.error || `The KeaS server said ${r.status}.`, r.status, r.body); return r.body; };
  const keep = (r) => { write({ token: r.token, exp: r.exp, at: now(), me: r.me }); return r.me; };

  /** Signs in (or renews) with a fresh pass from the Kea account. */
  async function signIn() {
    const id = await serverId();
    const { pass } = await account.pass(id);
    const cur = read();
    return keep(await raw('POST', '/v1/auth/pass', { pass }, cur?.token));
  }
  /** Sets up a fresh server: the setup code shown on this PC and a pass; the person becomes its operator. */
  async function claim(secret) {
    const { pass } = await account.pass(await serverId());
    return keep(await ownerOk('POST', '/owner/claim', { pass, secret }));
  }
  /** A session, renewed with a newer pass when it's a day old (kept as it is while KeaC can't be reached). */
  async function ensure() {
    const s = read();
    if (!s) return signIn();
    if (now() - s.at > RENEW_MS) { try { await signIn(); } catch (e) { if (e.status !== 0 && e.status !== 401) throw e; } }
    return read().me;
  }
  /** A call as the signed-in person. A session that ended is made again from a pass once. */
  async function api(method, p, body) {
    if (!read()) await signIn();
    try { return await raw(method, p, body, read().token); }
    catch (e) {
      if (e.status !== 401) throw e;
      write(null);
      await signIn();
      return raw(method, p, body, read().token);
    }
  }
  const oid = (id) => encodeURIComponent(String(id));
  const orgs = async () => (await api('GET', '/v1/orgs')).orgs || [];
  /** The organizations' people waiting for approval: [{ org, pending, unverified: [] }] (emails are verified by KeaC). */
  async function orgPeople() {
    const out = [];
    for (const o of await orgs()) {
      if (!['owner', 'admin', 'manager'].includes(o.role) || o.memberStatus !== 'active' || o.status !== 'active') continue;
      try { const r = await api('GET', `/v1/orgs/${oid(o.id)}/members`); out.push({ org: { id: o.id, name: o.name, role: o.role }, pending: r.pending || [], unverified: [] }); } catch (e) { if (e.status === 0) throw e; }
    }
    return out;
  }
  async function orgPayCodes({ id }) {
    const r = await api('GET', `/v1/orgs/${oid(id)}/pay-codes`);
    return { count: (r.codes || []).filter((c) => c.active).length, given: (r.codes || []).reduce((a, c) => a + (c.holders || 0), 0) };
  }

  /** The vault's token for this session (see the top). */
  async function payrollToken() {
    await ensure();
    return (await ownerOk('POST', '/owner/payroll-token', { session: read().token })).token;
  }
  /** "Ask for my sign-in every time": a fresh KeaC sign-in, a pass, a KeaS session just for this token, then ended. */
  async function freshPayrollToken({ password, code }) {
    const { pass } = await account.freshPass(await serverId(), { password, code });
    const s = await raw('POST', '/v1/auth/pass', { pass });
    try { return (await ownerOk('POST', '/owner/payroll-token', { session: s.token })).token; }
    finally { raw('POST', '/v1/auth/logout', {}, s.token).catch(() => {}); }
  }
  async function logout() { const s = read(); if (s) await raw('POST', '/v1/auth/logout', {}, s.token).catch(() => {}); write(null); }

  return {
    url: base, signIn, claim, ensure, api, logout, forget: () => write(null),
    signedIn: () => !!read() && account.signedIn(), session: () => read(), cached: () => account.cached(),
    orgs,
    createOrg: ({ name, state, tz }) => api('POST', '/v1/orgs', { name: String(name || '').trim(), kind: 'private', state: state || null, tz: tz || 'America/Denver' }),
    joinOrg: ({ code }) => api('POST', '/v1/orgs/join', { code: String(code || '').trim() }),
    updateOrg: ({ id, ...b }) => api('POST', `/v1/orgs/${oid(id)}`, b),
    orgPeople, orgPayCodes,
    orgApprove: ({ id, accountId, approve }) => api('POST', `/v1/orgs/${oid(id)}/members/${oid(accountId)}/approve`, { approve: approve !== false }),
    orgPayFeed: ({ id, from, to }) => api('GET', `/v1/orgs/${oid(id)}/pay-feed?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    publishStubs: ({ id, ...b }) => api('POST', `/v1/orgs/${oid(id)}/stubs`, b),
    payrollToken, freshPayrollToken,
  };
}

module.exports = { createKeasLink, KeasError };
