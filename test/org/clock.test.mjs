// The org engine's time clock: clocking in and out, who's late, missed-punch requests, timecards and their approval,
// time off, and punches that nothing can change (except deleting the whole account).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.mjs';

const MIN = 60_000;
let H, boss, mgr, ana, ben, org, pos, today, yesterday, period;
const O = (path) => `/v1/orgs/${org.id}${path}`;
// Wednesday 2 December 2026, 9:07 in Denver (16:07 UTC).
const T0 = Date.UTC(2026, 11, 2, 16, 7);
before(async () => {
  H = await startHub({ prefix: 'keas-clock-', clock: Date.UTC(2026, 10, 25, 15) });
  [boss, mgr, ana, ben] = await Promise.all([H.person('boss@c.org', 'Bea Boss'), H.person('mgr@c.org', 'Mo Manager'), H.person('ana@c.org', 'Ana Guard'), H.person('ben@c.org', 'Ben Guard')]);
  org = await H.orgWith(boss, 'Clock Pool', [[mgr, 'manager'], [ana, 'member'], [ben, 'member']]);
  pos = H.ok(await H.call('POST', O('/positions'), boss.token, { name: 'Guard' }), 201).position;
  for (const u of [ana, ben]) H.ok(await H.call('POST', O(`/members/${u.id}`), boss.token, { positionIds: [pos.id] }));
  const sched = H.ok(await H.call('POST', O('/schedules'), mgr.token, { periodStart: '2026-12-01', periodEnd: '2026-12-31' }), 201).schedule;
  const add = async (date, start, end) => H.ok(await H.call('POST', O('/shifts'), mgr.token, { scheduleId: sched.id, positionId: pos.id, accountId: ana.id, date, start, end }), 201).shift;
  yesterday = await add('2026-12-01', '09:00', '13:00');
  today = await add('2026-12-02', '09:00', '13:00');
  H.ok(await H.call('POST', O(`/schedules/${sched.id}/publish`), mgr.token, {}));
  H.t.now = T0;
});
after(() => H.close());

test('clocking in and out: matched to the shift, late after the org’s threshold, never twice', async () => {
  const r = H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'in' }), 201);
  assert.deepEqual([r.shift.id, r.minutesLate, r.late], [today.id, 7, true]);
  assert.match((await H.call('POST', O('/clock'), ana.token, { type: 'in' })).body.error, /already clocked in/);
  assert.equal(H.ok(await H.call('GET', O('/clock'), ana.token)).clockedIn, true);
  assert.match((await H.call('POST', O('/clock'), ben.token, { type: 'out' })).body.error, /not clocked in/);
  // Who's in today: managers see everyone, people see themselves.
  const team = H.ok(await H.call('GET', O('/clock/today'), mgr.token)).shifts;
  assert.deepEqual(team.map((s) => [s.name, s.state, s.arrival]), [['Ana Guard', 'clocked_in', 'late']]);
  assert.equal(H.ok(await H.call('GET', O('/clock/today'), ben.token)).shifts.length, 0);
  assert.equal(H.ok(await H.call('GET', O('/clock/alerts'), mgr.token)).alerts[0].resolved, true);
  assert.equal((await H.call('GET', O('/clock/alerts'), ben.token)).status, 403);
  H.t.now = Date.UTC(2026, 11, 2, 20, 0);
  H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'out', restAttested: true }), 201);
  // Ben has no shift: by default he can still clock in; with "needs a shift" on, he can't.
  H.ok(await H.call('POST', O(''), boss.token, { settings: { clock: { needShift: true } } }));
  assert.match((await H.call('POST', O('/clock'), ben.token, { type: 'in' })).body.error, /no shift of yours/);
});

test('punches are append-only', () => {
  assert.throws(() => H.hub.h.run('UPDATE org_punches SET at = 0'), /append-only/);
  assert.throws(() => H.hub.h.run('DELETE FROM org_punches'), /append-only/);
});

test('missed punches: asked for by the person, decided by someone else, then on the timecard', async () => {
  const at = (h, m) => new Date(Date.UTC(2026, 11, 1, h, m)).toISOString();
  const rin = H.ok(await H.call('POST', O('/punch-requests'), ana.token, { shiftId: yesterday.id, type: 'in', at: at(16, 0), reasonCode: 'forgot' }), 201).request;
  const rout = H.ok(await H.call('POST', O('/punch-requests'), ana.token, { shiftId: yesterday.id, type: 'out', at: at(20, 0), reasonCode: 'other', note: 'Phone died' }), 201).request;
  assert.match((await H.call('POST', O('/punch-requests'), ana.token, { shiftId: yesterday.id, type: 'out', at: at(20, 0), reasonCode: 'other' })).body.error, /note/);
  assert.equal((await H.call('POST', O('/punch-requests'), ben.token, { shiftId: yesterday.id, type: 'in', at: at(16, 0), reasonCode: 'forgot' })).status, 403, 'not his shift');
  assert.equal((await H.call('POST', O(`/punch-requests/${rin.id}/decide`), ana.token, { approve: true })).status, 403);
  assert.deepEqual(H.ok(await H.call('GET', O('/punch-requests?status=pending'), mgr.token)).requests.map((r) => r.name), ['Ana Guard', 'Ana Guard']);
  assert.equal(H.ok(await H.call('GET', O('/punch-requests'), ben.token)).requests.length, 0);
  for (const r of [rin, rout]) assert.ok(H.ok(await H.call('POST', O(`/punch-requests/${r.id}/decide`), mgr.token, { approve: true })).punch);
  period = H.ok(await H.call('GET', O('/clock'), ana.token)).period;
  const tc = H.ok(await H.call('GET', O(`/timecards?periodStart=${period.start}`), ana.token));
  assert.equal(tc.totals.workedMin, 240 + (240 - 7));
  assert.equal(tc.editCount, 2);
  assert.ok(tc.flags.some((f) => f.code === 'late'));
  assert.equal((await H.call('GET', O(`/timecards?periodStart=2026-12-02`), ana.token)).status, 400, 'periods start on their own day');
});

test('timecards: managers see and approve the team’s, never their own; members only theirs', async () => {
  assert.equal((await H.call('GET', O(`/timecards?accountId=${ana.id}`), ben.token)).status, 403);
  const team = H.ok(await H.call('GET', O(`/timecards/period?periodStart=${period.start}`), mgr.token));
  assert.equal(team.people.find((p) => p.accountId === ana.id).workedMin, 473);
  const r = H.ok(await H.call('POST', O('/timecards/approve-many'), mgr.token, { periodStart: period.start, accountIds: [ana.id, mgr.id] }));
  assert.deepEqual(r.results.map((x) => x.ok), [true, false]);
  assert.match(r.results[1].error, /your own/);
  assert.match((await H.call('POST', O('/timecards/approve'), mgr.token, { periodStart: period.start, accountId: ana.id })).body.error, /already approved/);
  assert.ok(H.ok(await H.call('GET', O(`/timecards?periodStart=${period.start}`), ana.token)).approved);
  assert.equal((await H.call('POST', O('/timecards/approve'), ben.token, { periodStart: period.start, accountId: ana.id })).status, 403);
  // Weekly pay periods are a setting.
  H.ok(await H.call('POST', O(''), boss.token, { settings: { clock: { periodDays: 7, periodAnchor: '2026-11-29' } } }));
  assert.deepEqual(H.ok(await H.call('GET', O('/clock'), ana.token)).period, { start: '2026-11-29', end: '2026-12-05' });
});

test('time off: asked for, no overlaps, decided by a manager, shown on the timecard', async () => {
  const req = H.ok(await H.call('POST', O('/time-off'), ana.token, { kind: 'vacation', startDate: '2026-12-03', endDate: '2026-12-04' }), 201).timeOff;
  assert.match((await H.call('POST', O('/time-off'), ana.token, { kind: 'sick', startDate: '2026-12-04' })).body.error, /already asked/);
  assert.equal((await H.call('POST', O('/time-off'), ana.token, { kind: 'cruise', startDate: '2026-12-10' })).status, 400, 'the org’s own kinds');
  assert.equal((await H.call('POST', O(`/time-off/${req.id}/decide`), ana.token, { approve: true })).status, 403);
  assert.equal(H.ok(await H.call('GET', O('/time-off'), ben.token)).timeOff.length, 0, 'not other people’s');
  const d = H.ok(await H.call('POST', O(`/time-off/${req.id}/decide`), mgr.token, { approve: true })).timeOff;
  assert.deepEqual([d.status, d.name], ['approved', 'Ana Guard']);
  const tc = H.ok(await H.call('GET', O('/timecards?periodStart=2026-11-29'), ana.token));
  assert.deepEqual(tc.timeOff.map((x) => [x.kind, x.startDate, x.endDate]), [['vacation', '2026-12-03', '2026-12-04']]);
  // Nothing about why: the vault keeps that.
  assert.equal('note' in d, false);
  const sick = H.ok(await H.call('POST', O('/time-off'), ana.token, { kind: 'sick', startDate: '2026-12-20', hours: 4 }), 201).timeOff;
  H.ok(await H.call('POST', O(`/time-off/${sick.id}/cancel`), ana.token, {}));
  assert.equal(H.ok(await H.call('GET', O('/time-off?status=cancelled'), ana.token)).timeOff.length, 1);
});

test('a dept-scoped approver decides only for their department; a custom role can carry clock abilities', async () => {
  const lanes = H.ok(await H.call('POST', O('/departments'), boss.token, { name: 'Lanes' }), 201).department;
  H.ok(await H.call('POST', O(`/members/${ben.id}`), boss.token, { departmentId: lanes.id }));
  const lead = H.ok(await H.call('POST', O('/roles'), boss.token, { name: 'Lane lead', abilities: ['timecards.view', 'timecards.approve', 'timeoff.decide'] }), 201).role;
  const cy = await H.person('cy@c.org', 'Cy Lead');
  const code = H.ok(await H.call('POST', O('/codes'), boss.token, { roleId: lead.id, scope: [lanes.id], needsApproval: false }), 201).code.code;
  H.ok(await H.call('POST', '/v1/orgs/join', cy.token, { code }, H.ip()));
  const benOff = H.ok(await H.call('POST', O('/time-off'), ben.token, { kind: 'personal', startDate: '2026-12-15' }), 201).timeOff;
  const anaOff = H.ok(await H.call('POST', O('/time-off'), ana.token, { kind: 'personal', startDate: '2026-12-15' }), 201).timeOff;
  assert.deepEqual(H.ok(await H.call('GET', O('/time-off?status=pending'), cy.token)).timeOff.map((x) => x.id), [benOff.id]);
  assert.equal((await H.call('POST', O(`/time-off/${anaOff.id}/decide`), cy.token, { approve: true })).status, 403);
  H.ok(await H.call('POST', O(`/time-off/${benOff.id}/decide`), cy.token, { approve: false }));
  // Cy's role has no clock.self: no clocking in.
  assert.equal((await H.call('POST', O('/clock'), cy.token, { type: 'in' })).status, 403);
});

test('deleting an account takes its punches with it (the only way they go); the export lists them first', async () => {
  const exp = H.ok(await H.call('GET', '/v1/orgs-export', ana.token));
  assert.equal(exp.timeClock.punches.length, 4);
  assert.equal(exp.memberships[0].role, 'member');
  H.ok(await H.owner('POST', `/owner/members/${ana.id}/forget`, { confirm: 'ana@c.org' }));
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_punches WHERE account_id = ?', ana.id).n, 0);
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_time_off WHERE account_id = ?', ana.id).n, 0);
  H.ok(await H.call('POST', O(''), boss.token, { settings: { clock: { needShift: false } } }));
  H.ok(await H.call('POST', O('/clock'), ben.token, { type: 'in' }), 201);
  assert.throws(() => H.hub.h.run('DELETE FROM org_punches'), /append-only/, 'still append-only for everyone else');
});
