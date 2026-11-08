// A throwaway Kea Hub for the org engine tests: people, calls, the owner console.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';

export async function startHub({ clock, dataDir = null, prefix = 'keas-org-' } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), prefix));
  const t = { now: clock ?? Date.UTC(2026, 10, 5, 15) };
  const hub = createHub({ dataDir: dir, now: () => t.now, log: false, ipHeader: 'x-test-ip', limits: { join: [100, 60_000] }, minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${p.port}`, ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  let ipN = 0;
  const ip = () => ({ 'x-test-ip': `10.8.${Math.floor(++ipN / 250)}.${ipN % 250}` });
  async function call(method, path, token, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
  const owner = async (method, path, body) => { const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body); return { status: r.status, body: await r.json() }; };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  async function login(email, password = 'lantern velvet orbit') {
    const r = ok(await call('POST', '/v1/auth/login', null, { email, password }, ip()));
    return { token: r.token, id: r.account.id, name: r.account.displayName, email };
  }
  async function person(email, name, { verified = true } = {}) {
    const terms = (await call('GET', '/v1/terms')).body.terms;
    ok(await call('POST', '/v1/auth/register', null, { email, password: 'lantern velvet orbit', displayName: name, age13: true, termsVersion: terms.version, termsSections: terms.sections.map((s) => s.id) }, ip()), 202);
    const u = await login(email);
    if (verified) ok(await owner('POST', `/owner/accounts/${u.id}`, { emailVerified: true }));
    return u;
  }
  /** An approved org owned by `boss`, with these people joined as the given 0.5 roles. */
  async function orgWith(boss, name, people = []) {
    const org = ok(await call('POST', '/v1/orgs', boss.token, { name, tz: 'America/Denver', state: 'CO' }), 201).org;
    ok(await owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true }));
    for (const [u, role] of people) {
      const code = ok(await call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: role === 'owner' ? 'admin' : role, needsApproval: false }), 201).code.code;
      ok(await call('POST', '/v1/orgs/join', u.token, { code }, ip()));
      if (role === 'owner') ok(await call('POST', `/v1/orgs/${org.id}/members/${u.id}`, boss.token, { role: 'owner' }));
    }
    return org;
  }
  return {
    hub, dir, t, call, owner, ok, ip, person, login, orgWith,
    async close({ keep = false } = {}) { await hub.close(); if (!keep && !dataDir) rmSync(dir, { recursive: true, force: true }); },
  };
}
