// The org engine on its own: a host with no Kea Hub (no accounts table, no classes), its own router and people from a
// static identity adapter, as KeaC or a KeaS org server would mount it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mountOrg, staticIdentity, OrgHttpError } from '../../org/index.mjs';

function host() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const h = {
    db, get: (s, ...a) => db.prepare(s).get(...a), all: (s, ...a) => db.prepare(s).all(...a), run: (s, ...a) => db.prepare(s).run(...a),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
  const routes = [];
  const R = (method, path, fn) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const identity = staticIdentity([
    { id: 'kea-1', name: 'Ola Owner', email: 'ola@x.org', emailVerified: true },
    { id: 'kea-2', name: 'Tam Worker', email: 'tam@x.org', emailVerified: true },
  ]);
  let t = Date.UTC(2026, 11, 2, 16);
  const notes = [];
  const engine = mountOrg({ R, h, now: () => t, identity, notify: (...a) => notes.push(a) });
  const call = (method, path, me, body = {}, query = {}) => {
    for (const r of routes) {
      const m = r.method === method && r.re.exec(path);
      if (m) {
        try { const out = r.fn({ me: { id: me }, params: { ...m.groups }, body, query, ip: 'test' }); return out?.status && 'body' in out ? out.body : out; }
        catch (e) { if (e instanceof OrgHttpError) return { error: e.message, status: e.status }; throw e; }
      }
    }
    throw new Error(`no route ${method} ${path}`);
  };
  return { h, engine, call, notes, setNow: (v) => { t = v; } };
}

test('a host without the Kea Hub: orgs, codes, roles and the time clock all work', () => {
  const { h, call, engine } = host();
  assert.equal(h.get("SELECT 1 FROM sqlite_master WHERE name = 'accounts'"), undefined);
  const org = call('POST', '/v1/orgs', 'kea-1', { name: 'Standalone Pool' }).org;
  assert.deepEqual([org.status, org.role], ['active', 'owner'], 'the static adapter approves its own orgs');
  const code = call('POST', `/v1/orgs/${org.id}/codes`, 'kea-1', { role: 'member', needsApproval: false }).code.code;
  assert.equal(call('POST', '/v1/orgs/join', 'kea-2', { code }).org.role, 'member');
  const members = call('GET', `/v1/orgs/${org.id}/members`, 'kea-1').members;
  assert.deepEqual(members.map((m) => [m.name, m.role, m.email]), [['Ola Owner', 'owner', 'ola@x.org'], ['Tam Worker', 'member', 'tam@x.org']]);
  const me = call('GET', `/v1/orgs/${org.id}`, 'kea-2').me;
  assert.deepEqual(me.abilities, ['clock.self', 'timeoff.request']);
  assert.equal(call('POST', `/v1/orgs/${org.id}/clock`, 'kea-2', { type: 'in' }).punch.type, 'in');
  assert.equal(call('POST', `/v1/orgs/${org.id}/departments`, 'kea-2', { name: 'x' }).status, 403);
  // Classes are a Hub thing: no class routes here, and verifying email belongs to the sign-in system.
  assert.throws(() => call('GET', `/v1/orgs/${org.id}/classes`, 'kea-1'), /no route/);
  assert.equal(call('POST', `/v1/orgs/${org.id}/members/kea-2/verify-email`, 'kea-1').status, 404);
  assert.equal(engine.soleOwnerOrgs('kea-1').length, 1);
  engine.forgetAccount('kea-2');
  assert.equal(h.get('SELECT COUNT(*) AS n FROM org_punches').n, 0);
  assert.equal(call('GET', `/v1/orgs/${org.id}/members`, 'kea-1').members.length, 1);
});
