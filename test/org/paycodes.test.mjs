// Pay codes in the org engine: made by whoever has paycodes.manage, given by paycodes.assign, one default each, on
// every shift and punch, switched freely among a person's own codes (never to one they weren't given), rates sealed
// with the server's org data key, and each person seeing what's theirs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHub } from './helpers.mjs';
import { isSealed, unseal, sealContext } from '../../server/lib/vault.mjs';

let H, boss, adm, mgr, ana, ben, org, pos, guard, swim, sched;
const O = (path) => `/v1/orgs/${org.id}${path}`;
// Wednesday 2 December 2026, 9:00 in Denver (16:00 UTC).
const T0 = Date.UTC(2026, 11, 2, 16, 0);
const HOUR = 3600_000;
before(async () => {
  H = await startHub({ prefix: 'keas-paycodes-', clock: Date.UTC(2026, 10, 25, 15) });
  [boss, adm, mgr, ana, ben] = await Promise.all([H.person('boss@p.org', 'Bea Boss'), H.person('adm@p.org', 'Al Admin'), H.person('mgr@p.org', 'Mo Manager'), H.person('ana@p.org', 'Ana Guard'), H.person('ben@p.org', 'Ben Guard')]);
  org = await H.orgWith(boss, 'Code Pool', [[adm, 'admin'], [mgr, 'manager'], [ana, 'member'], [ben, 'member']]);
  pos = H.ok(await H.call('POST', O('/positions'), boss.token, { name: 'Guard' }), 201).position;
  for (const u of [ana, ben]) H.ok(await H.call('POST', O(`/members/${u.id}`), boss.token, { positionIds: [pos.id] }));
  sched = H.ok(await H.call('POST', O('/schedules'), mgr.token, { periodStart: '2026-12-01', periodEnd: '2026-12-31' }), 201).schedule;
});
after(() => H.close());

test('making codes: paycodes.manage only (Admin and Owner), with the rate sealed and never in the audit log', async () => {
  assert.equal((await H.call('POST', O('/pay-codes'), mgr.token, { name: 'Lifeguard', rate: 15 })).status, 403, 'managers can’t');
  guard = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Lifeguard', rate: 15, color: '#2A7FFF' }), 201).code;
  swim = H.ok(await H.call('POST', O('/pay-codes'), boss.token, { name: 'Swim instructor', rate: '18.00' }), 201).code;
  assert.deepEqual([guard.rate, guard.rateCents, guard.color, swim.rateCents], [15, 1500, '#2a7fff', 1800]);
  assert.match((await H.call('POST', O('/pay-codes'), adm.token, { name: 'lifeguard', rate: 16 })).body.error, /already/);
  assert.match((await H.call('POST', O('/pay-codes'), adm.token, { name: 'Odd', rate: 15.555 })).body.error, /two decimal/);
  // Stored sealed: not the number, bound to its own row (a rate copied onto another code doesn't open).
  const row = H.hub.h.get('SELECT rate FROM org_pay_codes WHERE id = ?', guard.id);
  assert.ok(isSealed(row.rate) && !row.rate.includes('1500'));
  const key = Buffer.from(readFileSync(join(H.dir, 'org-data.key'), 'utf8').trim(), 'hex');
  assert.equal(unseal(key, row.rate, sealContext('org_pay_codes', 'rate', [guard.id])), '1500');
  assert.throws(() => unseal(key, row.rate, sealContext('org_pay_codes', 'rate', [swim.id])));
  H.hub.h.run('UPDATE org_pay_codes SET rate = ? WHERE id = ?', row.rate, swim.id);
  assert.equal((await H.call('GET', O('/pay-codes'), boss.token)).status, 500, 'a moved rate is refused, not misread');
  H.ok(await H.call('POST', O(`/pay-codes/${swim.id}`), boss.token, { rate: 18 }));
  const audit = H.hub.h.all("SELECT * FROM audit WHERE action LIKE 'org.paycode%'").map((r) => JSON.stringify(r));
  assert.ok(audit.length >= 3 && audit.every((a) => !/1500|1800|"rate":/.test(a)));
});

test('the guard: pay code routes carry rates, still never SSNs or bank details; other routes refuse rates', async () => {
  assert.match((await H.call('POST', O('/pay-codes'), adm.token, { name: 'Coach', rate: 20, ssn: '123-45-6789' })).body.error, /payroll vault/);
  assert.match((await H.call('POST', O('/pay-codes'), adm.token, { name: 'Coach', rate: 20, bankAccount: 'x' })).body.error, /payroll vault/);
  assert.match((await H.call('POST', O('/pay-codes'), adm.token, { name: '123-45-6789', rate: 20 })).body.error, /payroll vault/);
  assert.equal((await H.call('POST', O('/pay-codes'), adm.token, { name: 'Coach', rate: 20, payRate: 20 })).status, 201, 'rate words are fine here');
  assert.match((await H.call('POST', O(`/members/${ana.id}`), boss.token, { title: 'Guard', payRate: 20 })).body.error, /payroll vault/);
  assert.match((await H.call('POST', O('/shifts'), mgr.token, { scheduleId: sched.id, positionId: pos.id, date: '2026-12-04', start: '09:00', end: '10:00', hourlyRate: 15 })).body.error, /payroll vault/);
});

test('giving codes: paycodes.assign, never to yourself (unless owner); the first is the default; people are told', async () => {
  assert.equal((await H.call('POST', O(`/members/${ana.id}/pay-codes`), mgr.token, { codeId: guard.id })).status, 403);
  let r = H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes`), adm.token, { codeId: guard.id }), 201);
  assert.deepEqual(r.codes.map((c) => [c.name, c.default]), [['Lifeguard', true]]);
  r = H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes`), adm.token, { codeId: swim.id }), 201);
  assert.deepEqual(r.codes.map((c) => [c.name, c.default]), [['Lifeguard', true], ['Swim instructor', false]]);
  H.ok(await H.call('POST', O(`/members/${ben.id}/pay-codes`), adm.token, { codeId: guard.id }), 201);
  assert.match((await H.call('POST', O(`/members/${adm.id}/pay-codes`), adm.token, { codeId: swim.id })).body.error, /Someone else/);
  H.ok(await H.call('POST', O(`/members/${boss.id}/pay-codes`), boss.token, { codeId: swim.id }), 201);
  assert.ok(H.hub.h.get("SELECT 1 FROM notifications WHERE account_id = ? AND title LIKE '%Swim instructor%'", ana.id));
});

test('what people see: their own codes and rates; others’ only with rates.view; members never see the list', async () => {
  const mine = H.ok(await H.call('GET', O('/me/pay'), ana.token));
  assert.deepEqual(mine.codes.map((c) => [c.name, c.rate, c.default]), [['Lifeguard', 15, true], ['Swim instructor', 18, false]]);
  assert.equal(mine.defaultCodeId, guard.id);
  assert.equal((await H.call('GET', O('/pay-codes'), ana.token)).status, 403);
  assert.equal((await H.call('GET', O(`/members/${ana.id}/pay-codes`), ben.token)).status, 403, 'not a coworker’s');
  H.ok(await H.call('GET', O(`/members/${ana.id}/pay-codes`), ana.token));
  // A manager (schedule.edit) sees code names to build schedules with, not rates.
  const asMgr = H.ok(await H.call('GET', O('/pay-codes'), mgr.token));
  assert.ok(asMgr.codes.length >= 2 && asMgr.codes.every((c) => !('rate' in c) && !('rateCents' in c)));
  assert.ok(H.ok(await H.call('GET', O(`/members/${ana.id}/pay-codes`), mgr.token)).codes.every((c) => !('rate' in c)));
  assert.equal(H.ok(await H.call('GET', O(`/members/${ana.id}/pay-codes`), adm.token)).codes[0].rate, 15);
  // Ben never sees a code he wasn't given.
  assert.deepEqual(H.ok(await H.call('GET', O('/me/pay'), ben.token)).codes.map((c) => c.name), ['Lifeguard']);
});

test('shifts carry a code: the person’s default, one of theirs when set, and it follows the person', async () => {
  const add = (body, who = mgr) => H.call('POST', O('/shifts'), who.token, { scheduleId: sched.id, positionId: pos.id, ...body });
  const a = H.ok(await add({ accountId: ana.id, date: '2026-12-02', start: '09:00', end: '13:00' }), 201).shift;
  assert.equal(a.payCodeId, guard.id, 'her default');
  const b = H.ok(await add({ accountId: ana.id, date: '2026-12-03', start: '09:00', end: '13:00', payCodeId: swim.id }), 201).shift;
  assert.equal(b.payCodeId, swim.id);
  assert.match((await add({ accountId: ben.id, date: '2026-12-03', start: '14:00', end: '15:00', payCodeId: swim.id })).body.error, /wasn’t given/);
  // Moved to Ben, who doesn't have Swim instructor: his default.
  assert.equal(H.ok(await H.call('POST', O(`/shifts/${b.id}`), mgr.token, { accountId: ben.id })).shift.payCodeId, guard.id);
  H.ok(await H.call('POST', O(`/shifts/${b.id}`), mgr.token, { accountId: ana.id }));
  // Ana switches her own shift freely among her codes; never to one she wasn't given, never someone else's shift.
  H.ok(await H.call('POST', O(`/shifts/${b.id}/pay-code`), ana.token, { payCodeId: swim.id }));
  const other = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Front desk', rate: 14 }), 201).code;
  assert.match((await H.call('POST', O(`/shifts/${b.id}/pay-code`), ana.token, { payCodeId: other.id })).body.error, /wasn’t given/);
  const benShift = H.ok(await add({ accountId: ben.id, date: '2026-12-05', start: '09:00', end: '10:00' }), 201).shift;
  assert.equal((await H.call('POST', O(`/shifts/${benShift.id}/pay-code`), ana.token, { payCodeId: guard.id })).status, 403);
  H.ok(await H.call('POST', O(`/schedules/${sched.id}/publish`), mgr.token, {}));
});

test('punches carry a code: the shift’s, or the one asked for; switched on your own, not once approved', async () => {
  H.t.now = T0;
  const inn = H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'in' }), 201);
  assert.equal(inn.punch.payCodeId, guard.id, 'her shift’s code');
  H.t.now = T0 + 2 * HOUR;
  const out = H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'out' }), 201);
  assert.equal(out.punch.payCodeId, guard.id, 'a clock-out carries its clock-in’s');
  // She worked the second hour teaching: she switches the stretch (naming either punch) to Swim instructor.
  H.ok(await H.call('POST', O(`/punches/${out.punch.id}/pay-code`), ana.token, { payCodeId: swim.id }));
  H.t.now = T0 + 3 * HOUR;
  assert.match((await H.call('POST', O('/clock'), ana.token, { type: 'in', payCodeId: 'nope' })).body.error, /not in this organization/);
  const in2 = H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'in', payCodeId: guard.id }), 201);
  assert.equal(in2.punch.payCodeId, guard.id);
  H.t.now = T0 + 4 * HOUR;
  H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'out' }), 201);
  assert.equal((await H.call('POST', O(`/punches/${in2.punch.id}/pay-code`), ben.token, { payCodeId: guard.id })).status, 403, 'not someone else’s');
  // Hours by code this period: the first stretch (2 h) at Swim instructor, the second (1 h) at Lifeguard.
  const mine = H.ok(await H.call('GET', O('/me/pay'), ana.token));
  assert.deepEqual(mine.hours.map((x) => [x.name, x.hours, x.rateCents]), [['Swim instructor', 2, 1800], ['Lifeguard', 1, 1500]]);
  assert.equal(mine.totals.workedMin, 180);
  // Once the timecard is approved, the codes on it are settled.
  const period = H.ok(await H.call('GET', O('/clock'), ana.token)).period;
  H.ok(await H.call('POST', O('/timecards/approve'), mgr.token, { accountId: ana.id, periodStart: period.start }));
  assert.match((await H.call('POST', O(`/punches/${in2.punch.id}/pay-code`), ana.token, { payCodeId: swim.id })).body.error, /approved/);
  // The timecard shows each punch's code.
  const tc = H.ok(await H.call('GET', O(`/timecards?periodStart=${period.start}`), ana.token));
  assert.deepEqual(tc.days.find((d) => d.date === '2026-12-02').punches.map((p) => p.payCodeId), [swim.id, swim.id, guard.id, guard.id]);
});

test('the pay feed: for rates.view and timecards.view org-wide; effective codes, rates and approvals', async () => {
  assert.equal((await H.call('GET', O('/pay-feed?from=2026-11-29&to=2026-12-12'), mgr.token)).status, 403, 'managers don’t see rates');
  const f = H.ok(await H.call('GET', O('/pay-feed?from=2026-11-29&to=2026-12-12'), adm.token));
  assert.equal(f.v, 1);
  assert.deepEqual(f.codes.filter((c) => [guard.id, swim.id].includes(c.id)).map((c) => c.rateCents), [1500, 1800]);
  const a = f.people.find((p) => p.accountId === ana.id);
  assert.equal(a.email, 'ana@p.org');
  assert.deepEqual(a.punches.map((p) => p.payCodeId), [swim.id, swim.id, guard.id, guard.id]);
  assert.equal(a.defaultCodeId, guard.id);
  assert.equal(typeof a.approved, 'boolean');
  assert.match((await H.call('GET', O('/pay-feed?from=2026-12-12&to=2026-11-29'), adm.token)).body.error, /on or after/);
});

test('punches and shifts from before pay codes are paid at the person’s default; ungiving moves future shifts', async () => {
  // A punch pair made before codes existed (no code on it, no shift).
  const at = (h) => Date.UTC(2026, 11, 4, h);
  for (const [type, t] of [['in', at(15)], ['out', at(17)]]) H.hub.h.run('INSERT INTO org_punches (id,org_id,account_id,shift_id,type,at,source,created_at) VALUES (?,?,?,NULL,?,?,?,?)', `old-${type}`, org.id, ben.id, type, t, 'app', t);
  const f = H.ok(await H.call('GET', O('/pay-feed?from=2026-11-29&to=2026-12-12'), adm.token));
  assert.deepEqual(f.people.find((p) => p.accountId === ben.id).punches.filter((p) => p.id.startsWith('old-')).map((p) => p.payCodeId), [guard.id, guard.id]);
  // Swim instructor taken from Ana: her future Swim shifts move to her default; worked hours keep their code.
  const future = H.ok(await H.call('POST', O('/shifts'), mgr.token, { scheduleId: sched.id, positionId: pos.id, accountId: ana.id, date: '2026-12-20', start: '09:00', end: '10:00', payCodeId: swim.id }), 201).shift;
  const r = H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes/${swim.id}/delete`), adm.token, {}));
  assert.deepEqual(r.codes.map((c) => c.name), ['Lifeguard']);
  assert.equal(H.hub.h.get('SELECT pay_code_id FROM org_shifts WHERE id = ?', future.id).pay_code_id, guard.id);
  const mine = H.ok(await H.call('GET', O('/me/pay?periodStart=' + f.timecardPeriods[0]), ana.token));
  assert.ok(mine.hours.some((x) => x.name === 'Swim instructor' && x.noLongerGiven));
  // Ungiving the default makes another code the default.
  H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes`), adm.token, { codeId: swim.id }), 201);
  H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes/${swim.id}/default`), adm.token, {}));
  H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes/${swim.id}/delete`), adm.token, {}));
  assert.equal(H.ok(await H.call('GET', O('/me/pay'), ana.token)).defaultCodeId, guard.id);
});

test('codes in use are turned off, not deleted; a turned-off code can’t be given or picked', async () => {
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}/delete`), adm.token, {})).status, 409);
  const spare = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Spare', rate: 10 }), 201).code;
  H.ok(await H.call('POST', O(`/pay-codes/${spare.id}/delete`), adm.token, {}));
  H.ok(await H.call('POST', O(`/pay-codes/${swim.id}`), adm.token, { active: false }));
  assert.match((await H.call('POST', O(`/members/${ben.id}/pay-codes`), adm.token, { codeId: swim.id })).body.error, /turned off/);
});

test('deleting an account takes its codes and punch switches with it', async () => {
  H.ok(await H.owner('POST', `/owner/members/${ana.id}/forget`, { confirm: 'ana@p.org' }));
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_member_pay_codes WHERE account_id = ?', ana.id).n, 0);
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_punch_codes').n, 0);
});
