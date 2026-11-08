// Upgrading a Kea Hub database made by KeaS 0.5.0 (test/fixtures/hub-0.5.0-orgs.sql, dumped from a Hub that 0.5.0's
// own code filled): every fixed role becomes its template, codes keep working, nothing else is lost, and it happens
// once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startHub } from './helpers.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hub-0.5.0-orgs.sql');
const ORG = '4c7bf4bc-c90a-4b73-9e02-29b451f29508';
let dir, H, u = {};
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-migrate-'));
  const db = new DatabaseSync(join(dir, 'hub.db'));
  db.exec(readFileSync(FIXTURE, 'utf8'));
  // What 0.5.0 had: a role column with its CHECK, and two members' positions.
  assert.ok(db.prepare('PRAGMA table_info(org_members)').all().some((c) => c.name === 'role'));
  db.close();
  H = await startHub({ dataDir: dir, clock: Date.UTC(2026, 10, 5, 18) });
  for (const k of ['boss', 'co', 'adm', 'mgr', 'ana', 'pend']) u[k] = await H.login(`${k}@old.org`);
});
after(async () => { await H.close(); rmSync(dir, { recursive: true, force: true }); });

test('the tables are upgraded in place, once, with a record of it', () => {
  const h = H.hub.h;
  assert.equal(h.db.prepare('PRAGMA table_info(org_members)').all().some((c) => c.name === 'role'), false);
  assert.equal(h.db.prepare('PRAGMA table_info(org_codes)').all().some((c) => c.name === 'role'), false);
  const up = JSON.parse(h.get("SELECT value FROM org_meta WHERE key = 'upgraded'").value);
  assert.deepEqual([up.from, up.members, up.codes], [1, 6, 3]);
  assert.equal(h.get("SELECT value FROM org_meta WHERE key = 'schema'").value, '3');
  assert.equal(h.get('SELECT COUNT(*) AS n FROM org_member_positions').n, 2, 'positions survive the rebuild');
  assert.equal(h.get('SELECT COUNT(*) AS n FROM org_roles WHERE org_id = ? AND template = 1', ORG).n, 4);
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all().filter((r) => String(r.table).startsWith('org_')), []);
});

test('everyone has the role they had, with the same powers', async () => {
  const roleIn = async (k) => (await H.call('GET', '/v1/orgs', u[k].token)).body.orgs[0];
  assert.deepEqual(await Promise.all(['boss', 'co', 'adm', 'mgr', 'ana'].map(async (k) => (await roleIn(k)).role)), ['owner', 'owner', 'admin', 'manager', 'member']);
  assert.deepEqual([(await roleIn('pend')).role, (await roleIn('pend')).memberStatus], ['member', 'pending']);
  const me = H.ok(await H.call('GET', `/v1/orgs/${ORG}`, u.adm.token)).me;
  assert.ok(me.abilities.includes('structure.edit') && me.abilities.includes('rates.view'));
  // What they set before is still there, and still shown only to whom it was.
  const asAdmin = H.ok(await H.call('GET', `/v1/orgs/${ORG}/members`, u.adm.token)).members.find((m) => m.id === u.ana.id);
  assert.deepEqual([asAdmin.title, asAdmin.costRate, asAdmin.positionIds.length], ['Guard', 15, 1]);
  assert.equal(H.ok(await H.call('GET', `/v1/orgs/${ORG}/members`, u.mgr.token)).members.find((m) => m.id === u.ana.id).costRate, undefined);
  // Old shifts, certs and budgets.
  assert.equal(H.ok(await H.call('GET', `/v1/orgs/${ORG}/my-shifts?from=2026-12-01T00:00:00Z`, u.ana.token)).shifts.length, 1);
  assert.equal(H.ok(await H.call('GET', `/v1/orgs/${ORG}/certs`, u.ana.token)).certs.length, 1);
  assert.equal(H.ok(await H.call('GET', `/v1/orgs/${ORG}/budgets?from=2026-12-01&to=2026-12-31`, u.adm.token)).budgets.length, 1);
  // The 0.5 rules: a manager approves the waiting member, an admin can't touch an owner, owners can.
  H.ok(await H.call('POST', `/v1/orgs/${ORG}/members/${u.pend.id}/approve`, u.mgr.token, {}));
  assert.equal((await H.call('POST', `/v1/orgs/${ORG}/members/${u.co.id}`, u.adm.token, { role: 'member' })).status, 403);
  assert.equal((await H.call('POST', `/v1/orgs/${ORG}/members/${u.mgr.id}`, u.mgr.token, { role: 'admin' })).status, 403);
  H.ok(await H.call('POST', `/v1/orgs/${ORG}/members/${u.co.id}`, u.boss.token, { role: 'admin' }));
  H.ok(await H.call('POST', `/v1/orgs/${ORG}/members/${u.co.id}`, u.boss.token, { role: 'owner' }));
});

test('join codes made before the upgrade still work, as the role they were for', async () => {
  const codes = H.ok(await H.call('GET', `/v1/orgs/${ORG}/codes`, u.boss.token)).codes;
  assert.deepEqual(codes.map((c) => c.role).sort(), ['admin', 'manager', 'member']);
  assert.ok(codes.every((c) => c.usable && c.roleId));
  const newbie = await H.person('new@old.org', 'Nia New');
  const j = H.ok(await H.call('POST', '/v1/orgs/join', newbie.token, { code: codes.find((c) => c.role === 'member').code }, H.ip()));
  assert.equal(j.org.role, 'member');
  const m = H.ok(await H.call('GET', `/v1/orgs/${ORG}`, newbie.token)).me;
  assert.equal(m.positionIds.length, 1, 'the code’s position');
  assert.ok(m.departmentId, 'the code’s department');
});

test('starting again changes nothing', async () => {
  const before = H.hub.h.all('SELECT org_id, account_id, role_id, scope FROM org_role_assignments ORDER BY account_id, role_id');
  await H.close({ keep: true });
  H = await startHub({ dataDir: dir, clock: Date.UTC(2026, 10, 5, 19) });
  assert.deepEqual(H.hub.h.all('SELECT org_id, account_id, role_id, scope FROM org_role_assignments ORDER BY account_id, role_id'), before);
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_roles').n, 4);
});
