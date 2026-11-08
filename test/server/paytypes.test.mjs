// Pay types and overtime by the location's rules, with hours from the org engine (a pay feed): the federal weighted
// regular rate across two pay codes in one week, California daily overtime, double time and the seventh day, sick pay
// apart from paid time off, bonuses, and the stub showing how overtime was worked out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/index.mjs';
import { mergeRules, timecard } from '../../server/lib/rules.mjs';
import { addDays, weekStartOf, zonedToUtc, iso } from '../../server/lib/time.mjs';
import { suggestSickPolicy } from '../../server/payroll/leave.mjs';

const LABOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'labor');
const labor = (st) => JSON.parse(readFileSync(join(LABOR, `${st}.json`), 'utf8'));
const NOW = Date.UTC(2026, 11, 20, 18);
const TZ = 'America/Denver';
let dir, app, base, pay, period, ws, feed = null, asked = [];
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { j = buf; }
  return { status: r.status, body: j };
}
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
/** A stretch of work on a day: in at `from` local time for `hours`, at a pay code. */
const stretch = (id, date, from, hours, code) => {
  const t = zonedToUtc(date, from, TZ);
  return [{ id: `${id}-in`, type: 'in', at: iso(t), shiftId: null, payCodeId: code, source: 'app', restAttested: null }, { id: `${id}-out`, type: 'out', at: iso(t + hours * 3600_000), shiftId: null, payCodeId: code, source: 'app', restAttested: null }];
};
const CODES = [{ id: 'c-lg', name: 'Lifeguard', kind: 'hourly', active: true, rateCents: 1500 }, { id: 'c-si', name: 'Swim instructor', kind: 'hourly', active: true, rateCents: 1800 }, { id: 'c-ca', name: 'Pool lead', kind: 'hourly', active: true, rateCents: 2000 }];
const member = (accountId, name, punches, extra = {}) => ({ accountId, name, email: `${accountId}@e.org`, departmentId: null, title: null, defaultCodeId: 'c-lg', codeIds: ['c-lg', 'c-si'], approved: true, pendingRequests: 0, punches, shifts: [], ...extra });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-paytypes-'));
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, devKeyFile: true, demo: true, now: () => NOW,
    engineFeed: async (q) => { asked.push(q); if (!feed) throw new Error('not reachable'); return { v: 1, org: { id: 'e-org', name: 'Engine Pool', state: 'CO', tz: TZ, workweekStart: 0 }, ...q, timecardPeriods: [q.from], codes: CODES, people: feed, generatedAt: iso(NOW) }; } });
  base = `http://127.0.0.1:${await app.listen(0)}`;
  pay = (await call('POST', '/v1/auth/demo-login', null, { personId: 'p03' })).body.token;
  period = ok(await call('GET', '/v1/me', pay)).period.lastCompleted;
  ws = weekStartOf(period.start, 0);
  if (ws < period.start) ws = addDays(ws, 7);
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const lineOf = (run, name) => run.lines.find((l) => l.name === name);

test('the organization server can’t be reached: the pay run says so, and nothing is guessed', async () => {
  const r = await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /can’t get the hours/);
});

test('federal weighted overtime across two pay codes in one week: regular rate $16.20 = $810 ÷ 50 h', async () => {
  // Mon-Wed 10 h as a lifeguard ($15), Thu-Fri 10 h teaching ($18): 50 h in the week.
  const punches = [1, 2, 3, 4, 5].flatMap((i) => stretch(`a${i}`, addDays(ws, i), '08:00', 10, i <= 3 ? 'c-lg' : 'c-si'));
  feed = [member('kea-ana', 'Ana Engine', punches)];
  const run = ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay));
  assert.equal(run.hoursFrom, 'engine');
  assert.deepEqual(asked.at(-1), { from: period.start, to: period.end });
  const l = lineOf(run, 'Ana Engine');
  assert.ok(l, 'an engine member is on the pay run (added to payroll by Kea account)');
  const e = (code) => l.earnings.filter((x) => x.code === code);
  assert.deepEqual(e('regular').map((x) => [x.payCodeName, x.hours, x.rateCents, x.cents]), [['Lifeguard', 30, 1500, 45000], ['Swim instructor', 10, 1800, 18000]]);
  const ot = e('overtime')[0];
  assert.deepEqual([ot.hours, ot.regularRateCents, ot.premiumCents, ot.straightCents, ot.cents], [10, 1620, 8100, 18000, 26100]);
  assert.ok(ot.working.includes('Regular rate $16.20 = $810.00 ÷ 50 h (every hour at its pay code’s rate: Lifeguard 30 h x $15.00 + Swim instructor 20 h x $18.00)'), ot.working.join('\n'));
  assert.ok(ot.working.includes('Overtime 10 h x 0.5 x $16.20 premium = $81.00'));
  assert.ok(ot.working.some((w) => /^Why \(US \+ CO rules\): week of .*10 h over 40 h in the week/.test(w)), ot.working.join('\n'));
  assert.equal(l.gross, 89100);
  assert.deepEqual(l.hours.byCode.map((b) => [b.name, b.hours, b.overtime]), [['Lifeguard', 30, 0], ['Swim instructor', 20, 10]]);
  assert.equal(l.approved, true, 'approved in the engine');
  // Linked by Kea account: no second person on the next run.
  ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay));
  assert.equal(app.h.get("SELECT COUNT(*) AS n FROM people WHERE kea_account_id = 'kea-ana'").n, 1);
});

test('the stub shows hours and rate on each line, the hours by code, and how overtime was worked out', async () => {
  const pid = app.h.get("SELECT id FROM people WHERE kea_account_id = 'kea-ana'").id;
  const s = ok(await call('GET', `/v1/payrun/stub?personId=${pid}&periodStart=${period.start}`, pay)).stub;
  assert.ok(s.line.earnings.find((x) => x.code === 'overtime').working.length >= 4);
  const pdf = await call('GET', `/v1/payrun/stub?personId=${pid}&periodStart=${period.start}&format=pdf`, pay);
  const text = pdf.body.toString('latin1');
  assert.match(text, /Regular: Lifeguard   30 h x \$15\.00/);
  assert.match(text, /Overtime 10 h x 0\.5 x \$16\.20 premium = \$81\.00/);
  assert.match(text, /Regular rate \$16\.20 = \$810\.00 \/ 50 h/);
  assert.match(text, /Hours by pay code/);
});

test('a non-discretionary bonus raises the regular rate; a discretionary one doesn’t', async () => {
  const pid = app.h.get("SELECT id FROM people WHERE kea_account_id = 'kea-ana'").id;
  ok(await call('POST', '/v1/earnings/bonus', pay, { personId: pid, amount: 100, discretionary: false, label: 'Attendance bonus' }), 201);
  ok(await call('POST', '/v1/earnings/bonus', pay, { personId: pid, amount: 50 }), 201);
  const l = lineOf(ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)), 'Ana Engine');
  const ot = l.earnings.find((x) => x.code === 'overtime');
  assert.deepEqual([ot.regularRateCents, ot.premiumCents], [1820, 9100], '($810 + $100) ÷ 50 h = $18.20');
  assert.deepEqual(l.earnings.filter((x) => x.code === 'bonus').map((x) => [x.cents, x.discretionary]), [[10000, false], [5000, true]]);
  assert.equal(l.gross, 45000 + 18000 + 18000 + 9100 + 10000 + 5000);
  app.h.run("DELETE FROM extra_earnings WHERE code = 'bonus'");
});

test('sick pay and paid time off are separate pay types, at the default code’s rate', async () => {
  const pid = app.h.get("SELECT id FROM people WHERE kea_account_id = 'kea-ana'").id;
  const d = addDays(ws, 6);
  app.h.run("INSERT INTO time_off_requests (id,org_id,person_id,policy_id,start_date,end_date,hours,status,created_at) VALUES ('to-s','org-demo',?,'pol-sick',?,?,4,'approved','2026-01-01'), ('to-v','org-demo',?,'pol-vac',?,?,8,'approved','2026-01-01')", pid, d, d, pid, period.end, period.end);
  const l = lineOf(ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)), 'Ana Engine');
  assert.deepEqual(l.earnings.filter((x) => ['sick', 'pto'].includes(x.code)).map((x) => [x.code, x.hours, x.rateCents, x.cents]), [['sick', 4, 1500, 6000], ['pto', 8, 1500, 12000]]);
  assert.deepEqual([l.hours.sick, l.hours.pto], [4, 8]);
  app.h.run("DELETE FROM time_off_requests WHERE id IN ('to-s','to-v')");
});

test('California: daily overtime over 8 h and double time over 12 h, weighted at the regular rate', async () => {
  app.h.run("UPDATE orgs SET state = 'CA' WHERE id = 'org-demo'");
  try {
    feed = [member('kea-ben', 'Ben Engine', stretch('b1', addDays(ws, 1), '06:00', 14, 'c-ca'), { codeIds: ['c-ca'], defaultCodeId: 'c-ca' })];
    const l = lineOf(ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)), 'Ben Engine');
    const by = (c) => l.earnings.find((x) => x.code === c);
    assert.deepEqual([by('regular').hours, by('regular').cents], [8, 16000]);
    assert.deepEqual([by('overtime').hours, by('overtime').straightCents, by('overtime').premiumCents, by('overtime').cents], [4, 8000, 4000, 12000]);
    assert.deepEqual([by('double_time').hours, by('double_time').straightCents, by('double_time').premiumCents, by('double_time').cents, by('double_time').multiplier], [2, 4000, 4000, 8000, 2]);
    assert.ok(by('double_time').working.includes('Double time 2 h x 1 x $20.00 premium = $40.00'));
    assert.ok(by('overtime').working.some((w) => /4 h over 8 h in a day/.test(w)), by('overtime').working.join('\n'));
    assert.equal(l.gross, 36000, '8 h x $20 + 4 h x $30 + 2 h x $40');
    assert.equal(l.hours.doubleTime, 2);
    const run = ok(await call('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay));
    assert.equal(run.canFinalize, false, 'unverified tables never finalize');
    assert.ok(run.tables.some((t) => t.key === 'labor:CA' && !t.missing && !t.verified));
  } finally { app.h.run("UPDATE orgs SET state = 'CO' WHERE id = 'org-demo'"); }
});

test('the rules: California seventh day, daily then weekly overtime, and Colorado unchanged', () => {
  const ca = mergeRules(labor('US'), labor('CA'), {});
  assert.equal(ca.overtime.combine, 'union');
  const ws7 = '2026-12-06'; // a Sunday
  const day = (i, h, from = '08:00') => { const t = zonedToUtc(addDays(ws7, i), from, TZ); return [{ id: `i${i}`, type: 'in', at: iso(t) }, { id: `o${i}`, type: 'out', at: iso(t + h * 3600_000) }]; };
  const opts = { tz: TZ, workweekStart: 0, now: NOW, periodStart: ws7, periodEnd: addDays(ws7, 6) };
  // Six days of 6 h, then 10 h on the seventh day in a row: its first 8 h are overtime, the last 2 double time.
  let tc = timecard([0, 1, 2, 3, 4, 5].flatMap((i) => day(i, 6)).concat(day(6, 10)), [], ca, opts);
  assert.deepEqual([tc.totals.regularMin, tc.totals.overtimeMin, tc.totals.doubleTimeMin], [36 * 60, 8 * 60, 2 * 60]);
  // Five 9-hour days and a 5-hour day (50 h): 5 h daily overtime, then 5 h weekly overtime on the regular hours.
  tc = timecard([1, 2, 3, 4, 5].flatMap((i) => day(i, 9)).concat(day(6, 5)), [], ca, opts);
  assert.deepEqual([tc.totals.regularMin, tc.totals.overtimeMin, tc.totals.doubleTimeMin], [40 * 60, 10 * 60, 0]);
  assert.equal(tc.weeks[0].method, 'daily+weekly');
  // Colorado is as before: the greater of daily (over 12) and weekly (over 40).
  const co = mergeRules(labor('US'), labor('CO'), {});
  tc = timecard([1, 2, 3, 4, 5].flatMap((i) => day(i, 9)).concat(day(6, 5)), [], co, opts);
  assert.deepEqual([tc.totals.overtimeMin, tc.totals.doubleTimeMin, tc.weeks[0].method], [10 * 60, 0, 'weekly']);
});

test('labor files: never verified by code, with sources, and a sick leave suggestion where the law has one', () => {
  const sickStates = ['CA', 'WA', 'OR', 'AZ', 'NJ', 'NY', 'MA', 'CT', 'MD', 'MI', 'MN', 'IL', 'NM', 'VT', 'RI', 'CO'];
  for (const st of ['US', 'CA', 'AK', 'NV', ...sickStates]) {
    const f = labor(st);
    assert.equal(f.verifiedFor, null, st);
    assert.ok(f.source.length && f.source.every((s) => /^https:\/\//.test(s.url)), st);
  }
  for (const st of sickStates) {
    const s = suggestSickPolicy(mergeRules(labor('US'), labor(st), {}));
    assert.ok(s && s.kind === 'sick' && s.method === 'per_hour_worked' && s.perHours > 0 && s.needsChecking, st);
  }
  const ca = suggestSickPolicy(mergeRules(labor('US'), labor('CA'), {}));
  assert.deepEqual([ca.perHours, ca.annualMaxHours, ca.capHours], [30, 40, 80]);
  assert.equal(suggestSickPolicy(mergeRules(labor('US'), labor('AK'), {})), null, 'no sick leave law in the Alaska file');
  for (const st of ['CA', 'AK', 'NV']) assert.ok(labor(st).overtime.dailyHours === 8, st);
});

test('the setup list and policy editor suggest a sick leave policy from the law; the labor rules show unverified', async () => {
  let r = ok(await call('GET', '/v1/setup/checklist', pay));
  const sick = r.steps.find((s) => s.id === 'sickLeave');
  assert.equal(sick.done, true, 'the sample workplace has a sick policy');
  assert.match(sick.text, /1 hour per 30 hours worked/);
  assert.ok(r.steps.find((s) => s.id === 'rules').rules.some((x) => x.labor && x.verified === false && /Labor rules/.test(x.name)));
  assert.ok(r.steps.find((s) => s.id === 'verified').laborUnverified.length >= 1);
  app.h.run("UPDATE pto_policies SET active = 0 WHERE kind = 'sick'");
  r = ok(await call('GET', '/v1/setup/checklist', pay));
  const s2 = r.steps.find((s) => s.id === 'sickLeave');
  assert.equal(s2.done, false);
  assert.deepEqual([s2.suggestion.perHours, s2.suggestion.annualMaxHours, s2.fix.suggest], [30, 48, 'sick']);
  const pol = ok(await call('GET', '/v1/pto/policies', pay));
  assert.equal(pol.suggested.kind, 'sick');
  // The owner saves it as is (or edits it): the step is done.
  ok(await call('POST', '/v1/pto/policies', pay, { ...pol.suggested, name: 'Sick time' }));
  assert.equal(ok(await call('GET', '/v1/setup/checklist', pay)).steps.find((s) => s.id === 'sickLeave').done, true);
});
