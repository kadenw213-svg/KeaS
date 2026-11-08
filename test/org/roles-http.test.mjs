// Custom roles over HTTP: making and changing them, giving them for the whole org or for departments, what each
// person is told they can do, and every way of getting more than you have being refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.mjs';

let H, boss, adm, mgr, ana, ben, cy, org, aquatics, pool, lessons, front;
const O = (path) => `/v1/orgs/${org.id}${path}`;
before(async () => {
  H = await startHub({ prefix: 'keas-roles-' });
  [boss, adm, mgr, ana, ben, cy] = await Promise.all([
    H.person('boss@r.org', 'Bo Owner'), H.person('adm@r.org', 'Ada Admin'), H.person('mgr@r.org', 'Max Manager'),
    H.person('ana@r.org', 'Ana Lead'), H.person('ben@r.org', 'Ben Guard'), H.person('cy@r.org', 'Cy Desk'),
  ]);
  org = await H.orgWith(boss, 'Roles Pool', [[adm, 'admin'], [mgr, 'manager'], [ana, 'member'], [ben, 'member'], [cy, 'member']]);
  const dept = async (name, parentId) => H.ok(await H.call('POST', O('/departments'), boss.token, { name, parentId }), 201).department;
  aquatics = await dept('Aquatics'); pool = await dept('Pool', aquatics.id); lessons = await dept('Lessons', pool.id); front = await dept('Front desk');
  for (const [u, d] of [[ana, pool], [ben, lessons], [cy, front]]) H.ok(await H.call('POST', O(`/members/${u.id}`), boss.token, { departmentId: d.id }));
});
after(() => H.close());

const roles = async (u) => H.ok(await H.call('GET', O('/roles'), u.token)).roles;
const meIn = async (u) => H.ok(await H.call('GET', O(''), u.token)).me;

test('every organization starts with the four templates; each person is told what they can do and where', async () => {
  const list = await roles(boss);
  assert.deepEqual(list.filter((r) => r.template).map((r) => r.templateKey), ['owner', 'admin', 'manager', 'member']);
  assert.equal(list.find((r) => r.templateKey === 'owner').holders, 1);
  const m = await meIn(mgr);
  assert.equal(m.role, 'manager');
  assert.ok(m.abilities.includes('schedule.publish') && !m.abilities.includes('structure.edit') && !m.abilities.includes('rates.view'));
  assert.equal(m.scopes['people.edit'], 'org');
  assert.deepEqual(m.roles.map((r) => [r.templateKey, r.scope]), [['manager', 'org']]);
  const a = await meIn(ana);
  assert.deepEqual(a.abilities, ['clock.self', 'timeoff.request']);
  // Members can't see who holds what.
  assert.equal((await roles(ana))[0].holders, undefined);
  // The catalog of abilities comes along for the role editor.
  assert.ok(H.ok(await H.call('GET', O('/roles'), adm.token)).abilities.some((x) => x.id === 'people.edit' && x.label));
});

let poolLead;
test('a role for one department: its people and teams, nobody else, never the whole org', async () => {
  assert.equal((await H.call('POST', O('/roles'), mgr.token, { name: 'Pool lead', abilities: ['people.edit'] })).status, 403, 'managers can’t make roles');
  poolLead = H.ok(await H.call('POST', O('/roles'), adm.token, { name: 'Pool lead', abilities: ['people.view', 'people.edit', 'schedule.edit', 'schedule.publish', 'structure.edit'] }), 201).role;
  assert.equal((await H.call('POST', O('/roles'), adm.token, { name: 'pool LEAD', abilities: [] })).status, 400, 'names are unique');
  const a = H.ok(await H.call('POST', O(`/members/${ana.id}/roles`), adm.token, { roleId: poolLead.id, scope: [pool.id] }));
  assert.deepEqual(a.scopes['people.edit'], [lessons.id, pool.id].sort());
  assert.equal(a.scopes['structure.edit'], undefined, 'structure is org-wide only');
  assert.equal(a.role, 'member', 'Kea 0.70 still sees a member');
  // In her department and its teams: yes. Elsewhere, or moving someone out: no.
  H.ok(await H.call('POST', O(`/members/${ben.id}`), ana.token, { title: 'Swim lead' }));
  assert.equal((await H.call('POST', O(`/members/${cy.id}`), ana.token, { title: 'x' })).status, 403);
  assert.equal((await H.call('POST', O(`/members/${ben.id}`), ana.token, { departmentId: front.id })).status, 403);
  assert.equal((await H.call('POST', O(`/members/${mgr.id}`), ana.token, { title: 'x' })).status, 403, 'not people above her');
  // She sees contact details only where she can.
  const list = H.ok(await H.call('GET', O('/members'), ana.token)).members;
  assert.equal(list.find((m) => m.id === ben.id).email, 'ben@r.org');
  assert.equal(list.find((m) => m.id === cy.id).email, undefined);
  assert.equal(list.find((m) => m.id === ben.id).costRate, undefined);
  // Org-wide things stay closed.
  assert.equal((await H.call('POST', O('/departments'), ana.token, { name: 'Nope' })).status, 403);
  assert.equal((await H.call('POST', O('/codes'), ana.token, { role: 'member' })).status, 403);
});

test('shifts and publishing follow the department', async () => {
  const pos = H.ok(await H.call('POST', O('/positions'), boss.token, { name: 'Guard', departmentId: pool.id }), 201).position;
  const desk = H.ok(await H.call('POST', O('/positions'), boss.token, { name: 'Desk', departmentId: front.id }), 201).position;
  const sched = H.ok(await H.call('POST', O('/schedules'), mgr.token, { periodStart: '2026-12-01', periodEnd: '2026-12-31' }), 201).schedule;
  const mine = H.ok(await H.call('POST', O('/shifts'), ana.token, { scheduleId: sched.id, positionId: pos.id, accountId: ben.id, date: '2026-12-03', start: '09:00', end: '12:00' }), 201).shift;
  assert.equal((await H.call('POST', O('/shifts'), ana.token, { scheduleId: sched.id, positionId: desk.id, date: '2026-12-03', start: '09:00', end: '12:00' })).status, 403);
  H.ok(await H.call('POST', O('/shifts'), mgr.token, { scheduleId: sched.id, positionId: desk.id, accountId: cy.id, date: '2026-12-03', start: '09:00', end: '12:00' }), 201);
  const pub = H.ok(await H.call('POST', O(`/schedules/${sched.id}/publish`), ana.token, {}));
  assert.equal(pub.published, 1, 'only her department’s shift');
  assert.equal(H.ok(await H.call('GET', O('/my-shifts'), ben.token)).shifts.some((s) => s.id === mine.id), true);
  assert.equal(H.ok(await H.call('GET', O('/my-shifts'), cy.token)).shifts.length, 0);
  assert.equal((await H.call('POST', O(`/schedules/${sched.id}/autofill`), ana.token, {})).status, 403, 'auto-fill is for the whole org');
});

test('nobody gets more than they have: making roles, giving them, join codes, the 0.5 role field', async () => {
  // A role editor without rates: can't put rates in a role, or give a role above their own.
  const editor = H.ok(await H.call('POST', O('/roles'), boss.token, { name: 'Role editor', abilities: ['roles.manage', 'roles.assign', 'schedule.edit', 'people.edit', 'clock.self'] }), 201).role;
  H.ok(await H.call('POST', O(`/members/${mgr.id}/roles`), boss.token, { roleId: editor.id }));
  assert.match((await H.call('POST', O('/roles'), mgr.token, { name: 'Rates', abilities: ['rates.view'] })).body.error, /Not yours: rates\.view/);
  const small = H.ok(await H.call('POST', O('/roles'), mgr.token, { name: 'Helper', abilities: ['schedule.edit'] }), 201).role;
  H.ok(await H.call('POST', O(`/members/${cy.id}/roles`), mgr.token, { roleId: small.id }));
  assert.equal((await H.call('POST', O(`/members/${cy.id}/roles`), mgr.token, { roleId: (await roles(boss)).find((r) => r.templateKey === 'admin').id })).status, 403);
  // He can pass on what he has (he still outranks Cy: he's a manager too); Cy then can't make Ben level with herself.
  H.ok(await H.call('POST', O(`/members/${cy.id}/roles`), mgr.token, { roleId: editor.id }));
  assert.match((await H.call('POST', O(`/members/${ben.id}/roles`), cy.token, { roleId: editor.id })).body.error, /level with or above you/);
  H.ok(await H.call('POST', O(`/members/${cy.id}/roles/${editor.id}/delete`), mgr.token, {}));
  // Can't raise a role he may edit above himself, or change one someone above him holds.
  assert.equal((await H.call('POST', O(`/roles/${small.id}`), mgr.token, { abilities: ['schedule.edit', 'rates.assign'] })).status, 403);
  H.ok(await H.call('POST', O(`/roles/${small.id}`), mgr.token, { abilities: ['schedule.edit', 'people.edit'] }));
  H.ok(await H.call('POST', O(`/members/${adm.id}/roles`), boss.token, { roleId: small.id }));
  assert.match((await H.call('POST', O(`/roles/${small.id}`), mgr.token, { abilities: ['schedule.edit'] })).body.error, /someone above you/);
  assert.match((await H.call('POST', O(`/roles/${small.id}/delete`), mgr.token, {})).body.error, /someone above you/);
  // Admins can't make admins (the 0.5 rule), owners can.
  const adminRole = (await roles(boss)).find((r) => r.templateKey === 'admin');
  assert.equal((await H.call('POST', O(`/members/${ben.id}/roles`), adm.token, { roleId: adminRole.id })).status, 403);
  assert.equal((await H.call('POST', O(`/members/${ben.id}`), adm.token, { role: 'admin' })).status, 403);
  H.ok(await H.call('POST', O(`/members/${ben.id}`), adm.token, { role: 'manager' }));
  assert.equal(H.ok(await H.call('GET', O('/members'), boss.token)).members.find((m) => m.id === ben.id).role, 'manager');
  H.ok(await H.call('POST', O(`/members/${ben.id}`), adm.token, { role: 'member' }));
  // Join codes: a custom role with a scope, never more than the maker has.
  const code = H.ok(await H.call('POST', O('/codes'), adm.token, { roleId: poolLead.id, scope: [pool.id], departmentId: pool.id, needsApproval: false }), 201).code;
  assert.deepEqual([code.role, code.roleName, code.scope], ['member', 'Pool lead', [pool.id]]);
  assert.equal((await H.call('POST', O('/codes'), mgr.token, { roleId: adminRole.id })).status, 403);
  assert.equal((await H.call('POST', O('/codes'), boss.token, { roleId: (await roles(boss)).find((r) => r.templateKey === 'owner').id })).status, 400, 'no owner codes');
  const dee = await H.person('dee@r.org', 'Dee New');
  H.ok(await H.call('POST', '/v1/orgs/join', dee.token, { code: code.code }, H.ip()));
  const d = await meIn(dee);
  assert.deepEqual(d.roles.map((r) => [r.name, r.scope]), [['Pool lead', [pool.id]]]);
  assert.equal(d.departmentId, pool.id);
});

test('owners: every ability always, the Owner role can’t be edited, and the last owner stays', async () => {
  const ownerRole = (await roles(boss)).find((r) => r.templateKey === 'owner');
  assert.equal((await H.call('POST', O(`/roles/${ownerRole.id}`), boss.token, { abilities: ['clock.self'] })).status, 400);
  H.ok(await H.call('POST', O(`/roles/${ownerRole.id}`), boss.token, { name: 'Director' }));
  assert.equal((await meIn(boss)).role, 'owner', 'renamed, still the owner template');
  assert.match((await H.call('POST', O(`/members/${boss.id}/roles/${ownerRole.id}/delete`), boss.token, {})).body.error, /someone else an owner/);
  assert.match((await H.call('POST', O(`/members/${boss.id}`), boss.token, { role: 'admin' })).body.error, /someone else an owner/);
  assert.match((await H.call('POST', O('/leave'), boss.token, {})).body.error, /only owner/);
  // A second owner, then the first can step down.
  H.ok(await H.call('POST', O(`/members/${adm.id}/roles`), boss.token, { roleId: ownerRole.id, scope: [pool.id] }));
  assert.equal((await meIn(adm)).scopes['structure.edit'], 'org', 'the Owner role is always for the whole org');
  const r = H.ok(await H.call('POST', O(`/members/${boss.id}/roles/${ownerRole.id}/delete`), boss.token, {}));
  assert.equal(r.role, 'member', 'nobody is left with no role');
  assert.equal((await H.call('POST', O(`/members/${adm.id}/roles/${ownerRole.id}/delete`), boss.token, {})).status, 403, 'a member can’t demote an owner');
  H.ok(await H.call('POST', O(`/members/${boss.id}`), adm.token, { role: 'owner' }));
});

test('deleting a role: templates can’t go; holders keep a role; its join codes stop working', async () => {
  const list = await roles(boss);
  assert.equal((await H.call('POST', O(`/roles/${list.find((r) => r.templateKey === 'member').id}/delete`), boss.token, {})).status, 400);
  const lead = list.find((r) => r.name === 'Pool lead');
  const dee = await H.login('dee@r.org');
  H.ok(await H.call('POST', O(`/roles/${lead.id}/delete`), adm.token, {}));
  const d = await meIn(dee);
  assert.deepEqual(d.roles.map((r) => r.templateKey), ['member']);
  assert.ok(!H.ok(await H.call('GET', O('/codes'), adm.token)).codes.some((c) => c.roleId === lead.id), 'its codes are revoked');
});

test('a department-scoped approver sees and decides only requests for their departments', async () => {
  const approver = H.ok(await H.call('POST', O('/roles'), boss.token, { name: 'Front approver', abilities: ['people.approve', 'people.view', 'clock.self'] }), 201).role;
  H.ok(await H.call('POST', O(`/members/${cy.id}/roles`), boss.token, { roleId: approver.id, scope: [front.id] }));
  const toFront = H.ok(await H.call('POST', O('/codes'), boss.token, { role: 'member', departmentId: front.id, needsApproval: true }), 201).code.code;
  const toPool = H.ok(await H.call('POST', O('/codes'), boss.token, { role: 'member', departmentId: pool.id, needsApproval: true }), 201).code.code;
  const f = await H.person('fay@r.org', 'Fay Front'), p = await H.person('pat@r.org', 'Pat Pool');
  H.ok(await H.call('POST', '/v1/orgs/join', f.token, { code: toFront }, H.ip()));
  H.ok(await H.call('POST', '/v1/orgs/join', p.token, { code: toPool }, H.ip()));
  assert.equal((await meIn(f)).abilities.length, 0, 'nothing while waiting');
  const pend = H.ok(await H.call('GET', O('/members'), cy.token)).pending.map((m) => m.id);
  assert.deepEqual(pend, [f.id]);
  assert.equal((await H.call('POST', O(`/members/${p.id}/approve`), cy.token, {})).status, 403);
  H.ok(await H.call('POST', O(`/members/${f.id}/approve`), cy.token, {}));
});

test('deleting a department: roles given for it keep only the teams that were under it, never more', async () => {
  const deep = H.ok(await H.call('POST', O('/departments'), boss.token, { name: 'Deep' }), 201).department;
  const deeper = H.ok(await H.call('POST', O('/departments'), boss.token, { name: 'Deeper', parentId: deep.id }), 201).department;
  const solo = H.ok(await H.call('POST', O('/departments'), boss.token, { name: 'Solo' }), 201).department;
  const r = H.ok(await H.call('POST', O('/roles'), boss.token, { name: 'Deep lead', abilities: ['people.edit'] }), 201).role;
  H.ok(await H.call('POST', O(`/members/${ben.id}/roles`), boss.token, { roleId: r.id, scope: [deep.id] }));
  H.ok(await H.call('POST', O(`/members/${cy.id}/roles`), boss.token, { roleId: r.id, scope: [solo.id] }));
  H.ok(await H.call('POST', O(`/departments/${deep.id}/delete`), boss.token, {}));
  H.ok(await H.call('POST', O(`/departments/${solo.id}/delete`), boss.token, {}));
  const b = await meIn(ben);
  assert.deepEqual(b.roles.find((x) => x.roleId === r.id).scope, [deeper.id]);
  assert.equal((await meIn(cy)).roles.some((x) => x.roleId === r.id), false, 'a scope left with nothing goes');
});
