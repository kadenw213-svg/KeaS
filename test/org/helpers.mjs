// A throwaway KeaS server for the org engine tests, with a fake KeaC (test/helpers/keac.mjs) handing out passes: people
// sign in with passes, the server is claimed at the owner console with its setup code, and organizations made by
// anyone wait for the operator's approval (as on a server whose operator allows that).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { fakeKeac } from '../helpers/keac.mjs';

export async function startHub({ clock, dataDir = null, prefix = 'keas-org-', limits = {}, claim = true, anyoneCreates = true } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), prefix));
  const t = { now: clock ?? Date.UTC(2026, 10, 5, 15) };
  const keac = await fakeKeac({ now: () => t.now });
  const hub = createHub({ dataDir: dir, now: () => t.now, log: false, ipHeader: 'x-test-ip', limits: { join: [100, 60_000], pass: [1000, 60_000], ...limits }, minFreeBytes: 0, keacUrl: keac.url, keacKeys: [keac.key.jwk] });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${p.port}`, ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  let ipN = 0;
  const ip = () => ({ 'x-test-ip': `10.8.${Math.floor(++ipN / 250)}.${ipN % 250}` });
  async function call(method, path, token, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  }
  const owner = async (method, path, body) => { const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body); return { status: r.status, body: await r.json() }; };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const pass = (sub, email, name, o = {}) => keac.pass({ serverId: hub.serverId, sub, email, name, ...o });
  /** Signs in with a pass for this Kea account: { token, id, name, email }. */
  async function signIn(id, email, name = '') {
    const r = ok(await call('POST', '/v1/auth/pass', null, { pass: pass(id, email, name) }, ip()));
    return { token: r.token, id, name: r.me.name || name, email };
  }
  /** Someone already known here (a member from an upgraded Hub, or one signed in before), by email. */
  async function login(email) {
    const m = hub.h.get('SELECT id, name FROM keas_members WHERE email = ?', email.toLowerCase());
    assert.ok(m, `no member ${email}`);
    return signIn(m.id, email, m.name);
  }
  /** A new Kea account (a fresh id), signed in here. */
  const person = (email, name) => signIn(randomUUID(), email, name);
  let operator = null;
  if (claim && hub.setupSecret) {
    const id = randomUUID();
    const r = ok(await owner('POST', '/owner/claim', { pass: pass(id, 'operator@keas.test', 'Server Operator'), secret: hub.setupSecret }));
    operator = { token: r.token, id, name: 'Server Operator', email: 'operator@keas.test' };
  }
  if (claim && anyoneCreates) ok(await owner('POST', '/owner/settings', { orgs: { anyoneCreates: true, autoApprove: false } }));
  /** An approved org owned by `boss`, with these people joined as the given 0.5 roles. */
  async function orgWith(boss, name, people = []) {
    const org = ok(await call('POST', '/v1/orgs', boss.token, { name, tz: 'America/Denver', state: 'CO' }), 201).org;
    if (org.status !== 'active') ok(await owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true }));
    for (const [u, role] of people) {
      const code = ok(await call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: role === 'owner' ? 'admin' : role, needsApproval: false }), 201).code.code;
      ok(await call('POST', '/v1/orgs/join', u.token, { code }, ip()));
      if (role === 'owner') ok(await call('POST', `/v1/orgs/${org.id}/members/${u.id}`, boss.token, { role: 'owner' }));
    }
    return org;
  }
  return {
    hub, keac, dir, t, base, ownerBase, call, owner, ok, ip, person, login, signIn, pass, orgWith, operator,
    async close({ keep = false } = {}) { await hub.close(); await keac.close(); if (!keep && !dataDir) rmSync(dir, { recursive: true, force: true }); },
  };
}
