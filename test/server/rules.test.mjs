import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeRules, timecard, checkAssignment, restOwed } from '../../server/lib/rules.mjs';
import { zonedToUtc, iso, addDays } from '../../server/lib/time.mjs';

const load = (p) => JSON.parse(readFileSync(new URL(`../../shared/${p}`, import.meta.url), 'utf8'));
const US = load('labor/US.json'), CO = load('labor/CO.json');
const rules = mergeRules(US, CO, {});
const TZ = 'America/Denver';
const SUN = '2026-10-18'; // a Sunday (school weeks in October)
let seq = 0;
function work(date, from, to, extra = {}) {
  const s = zonedToUtc(date, from, TZ);
  let e = zonedToUtc(date, to, TZ);
  if (e <= s) e = zonedToUtc(addDays(date, 1), to, TZ);
  const id = 'sh' + ++seq;
  return { shift: { id, start: iso(s), end: iso(e) }, punches: [
    { id: id + 'i', type: 'in', at: iso(s), shift_id: id },
    { id: id + 'o', type: 'out', at: iso(e), shift_id: id, restAttested: extra.restAttested ?? null },
  ] };
}
function card(list, r = rules) {
  return timecard(list.flatMap((x) => x.punches), list.map((x) => x.shift), r, { tz: TZ, workweekStart: 0, now: Date.parse('2026-12-01T00:00:00Z') });
}

test('mergeRules keeps the strictest value', () => {
  assert.equal(rules.overtime.weeklyHours, 40);
  assert.equal(rules.overtime.dailyHours, 12);
  assert.equal(rules.overtime.consecutiveHours, 12);
  assert.equal(rules.minimumWage.standard, 15.16);
  assert.equal(rules.minors.minimumWorkAge, 14);
  assert.equal(rules.verifiedFor, null);
  const tighter = mergeRules(US, CO, { overtime: { dailyHours: 10 } });
  assert.equal(tighter.overtime.dailyHours, 10);
  const looser = mergeRules(US, CO, { overtime: { weeklyHours: 50 } });
  assert.equal(looser.overtime.weeklyHours, 40, 'org cannot loosen');
});

test('weekly 40: five 9-hour days -> 5 h overtime', () => {
  const tc = card([1, 2, 3, 4, 5].map((i) => work(addDays(SUN, i), '07:00', '16:00')));
  assert.equal(tc.totals.workedMin, 45 * 60);
  assert.equal(tc.totals.overtimeMin, 300);
  assert.equal(tc.weeks[0].method, 'weekly');
  assert.equal(tc.days.find((d) => d.date === addDays(SUN, 5)).overtimeMin, 300, 'weekly OT lands on the last hours worked');
});

test('daily 12: a 14-hour day -> 2 h overtime (federal-only rules give none)', () => {
  const tc = card([work(addDays(SUN, 1), '06:00', '20:00')]);
  assert.equal(tc.totals.overtimeMin, 120);
  assert.equal(tc.weeks[0].method, 'daily/consecutive');
  const fed = card([work(addDays(SUN, 1), '06:00', '20:00')], mergeRules(US, null, {}));
  assert.equal(fed.totals.overtimeMin, 0);
});

test('12 consecutive hours across midnight -> 1 h overtime on the second day', () => {
  const tc = card([work(addDays(SUN, 5), '20:00', '09:00')]);
  const fri = tc.days.find((d) => d.date === addDays(SUN, 5)), sat = tc.days.find((d) => d.date === addDays(SUN, 6));
  assert.equal(fri.workedMin, 240);
  assert.equal(sat.workedMin, 540);
  assert.equal(tc.totals.overtimeMin, 60);
  assert.equal(sat.overtimeMin, 60);
  assert.equal(tc.weeks[0].consecutiveOvertimeMin, 60);
  assert.equal(tc.weeks[0].dailyOvertimeMin, 0);
});

test('no double counting: the larger of weekly vs daily wins, never the sum', () => {
  // 4 x 10 h + one 14 h day = 54 h: weekly 14 h, daily 2 h -> 14 h
  const a = card([...[1, 2, 3, 4].map((i) => work(addDays(SUN, i), '07:00', '17:00')), work(addDays(SUN, 5), '06:00', '20:00')]);
  assert.equal(a.totals.workedMin, 54 * 60);
  assert.equal(a.totals.overtimeMin, 14 * 60);
  assert.equal(a.totals.regularMin + a.totals.overtimeMin, a.totals.workedMin);
  // 3 x 14 h = 42 h: weekly 2 h, daily 6 h -> 6 h
  const b = card([1, 2, 3].map((i) => work(addDays(SUN, i), '06:00', '20:00')));
  assert.equal(b.totals.overtimeMin, 6 * 60);
  assert.equal(b.weeks[0].method, 'daily/consecutive');
  // a 14 h day is also 14 consecutive hours: its last 2 h count once
  const c = card([work(addDays(SUN, 2), '06:00', '20:00')]);
  assert.equal(c.totals.overtimeMin, 120);
});

test('rest breaks: owed per 4 h or major fraction; unattested -> premium', () => {
  assert.equal(restOwed(120, 4), 0);
  assert.equal(restOwed(121, 4), 1);
  assert.equal(restOwed(360, 4), 1);
  assert.equal(restOwed(361, 4), 2);
  const tc = card([work(addDays(SUN, 1), '09:00', '15:00', { restAttested: false }), work(addDays(SUN, 2), '08:00', '16:00', { restAttested: false }), work(addDays(SUN, 3), '08:00', '16:00', { restAttested: true })]);
  assert.equal(tc.totals.restPremiumMin, 10 + 20);
  assert.equal(tc.flags.filter((f) => f.code === 'missed_rest').length, 2);
});

test('flags: late arrival, missed punch, no-show', () => {
  const s1 = work(addDays(SUN, 1), '09:00', '15:00');
  s1.punches[0].at = iso(Date.parse(s1.punches[0].at) + 9 * 60000);
  const s2 = work(addDays(SUN, 2), '09:00', '15:00');
  s2.punches.pop();
  const s3 = work(addDays(SUN, 3), '09:00', '15:00');
  s3.punches = [];
  const tc = card([s1, s2, s3]);
  assert.equal(tc.flags.find((f) => f.code === 'late').minutes, 9);
  assert.ok(tc.flags.some((f) => f.code === 'missed_punch'));
  assert.ok(tc.flags.some((f) => f.code === 'no_show'));
  assert.equal(tc.totals.workedMin, 6 * 60 - 9);
});

// ---- checkAssignment ----
const positions = [{ id: 'lg', name: 'Lifeguard', tags: ['lifeguard'] }, { id: 'si', name: 'Swim Instructor', tags: [] }, { id: 'hg', name: 'Head Guard', tags: ['lifeguard'] }];
const certTypes = [
  { id: 'c-lg', name: 'Lifeguard', requiredForPositions: ['lg', 'hg'] },
  { id: 'c-cpr', name: 'CPR/AED', requiredForPositions: ['lg', 'si', 'hg'] },
  { id: 'c-wsi', name: 'Water Safety Instructor', requiredForPositions: ['si'] },
];
const good = [{ typeId: 'c-lg', expires: '2028-01-01' }, { typeId: 'c-cpr', expires: '2028-01-01' }];
const sh = (date, from, to, pos = 'lg', id) => { const s = zonedToUtc(date, from, TZ); let e = zonedToUtc(date, to, TZ); if (e <= s) e = zonedToUtc(addDays(date, 1), to, TZ); return { id, positionId: pos, start: iso(s), end: iso(e) }; };
const ctx = (extra) => ({ certTypes, positions, rules, tz: TZ, workweekStart: 0, ...extra });
const adult = { id: 'a', name: 'Adult', birthdate: '1995-03-01', positions: ['lg', 'si', 'hg'] };
const codes = (p) => p.map((x) => x.code);

test('expired certification blocks and cannot be forced', () => {
  const p = checkAssignment(adult, sh('2026-11-02', '09:00', '15:00'), ctx({ certs: [{ typeId: 'c-lg', expires: '2026-09-30' }, { typeId: 'c-cpr', expires: '2028-01-01' }] }));
  const e = p.find((x) => x.code === 'cert_expired');
  assert.ok(e && e.blocking && !e.forceable);
});

test('missing certification blocks', () => {
  const p = checkAssignment(adult, sh('2026-11-02', '09:00', '15:00', 'si'), ctx({ certs: good }));
  assert.ok(p.some((x) => x.code === 'cert_missing' && x.blocking));
});

test('14-year-old cannot be a lifeguard (29 CFR 570.34(l))', () => {
  const kid = { id: 'k', name: 'Kid', birthdate: '2012-05-01', positions: ['lg'] };
  const p = checkAssignment(kid, sh('2026-11-07', '10:00', '14:00'), ctx({ certs: good }));
  const b = p.find((x) => x.code === 'position_min_age');
  assert.ok(b && b.blocking && !b.forceable);
});

test('15-year-old certified lifeguard is allowed within hour limits', () => {
  const teen = { id: 't', name: 'Teen', birthdate: '2011-06-01', positions: ['lg'] };
  const p = checkAssignment(teen, sh('2026-11-03', '16:00', '19:00'), ctx({ certs: good }));
  assert.deepEqual(p.filter((x) => x.blocking), []);
  const late = checkAssignment(teen, sh('2026-11-03', '16:00', '20:00'), ctx({ certs: good }));
  assert.ok(codes(late).includes('minor_time_of_day'), 'past 7 pm outside summer');
  assert.ok(codes(late).includes('minor_day_hours'), 'over 3 h on a school day');
});

test('minor school-week limit (18 h for 14-15)', () => {
  const teen = { id: 't', name: 'Teen', birthdate: '2011-06-01', positions: ['lg'] };
  const existing = [2, 3, 4, 5, 6].map((d, i) => sh(`2026-11-0${d}`, '16:00', '19:00', 'lg', 'e' + i)); // Mon-Fri 3 h = 15 h
  const ok = checkAssignment(teen, sh('2026-11-07', '10:00', '13:00'), ctx({ certs: good, existingShifts: existing }));
  assert.ok(!codes(ok).includes('minor_week_hours'), 'exactly 18 h is allowed');
  const over = checkAssignment(teen, sh('2026-11-07', '10:00', '14:00'), ctx({ certs: good, existingShifts: existing }));
  const w = over.find((x) => x.code === 'minor_week_hours');
  assert.ok(w && w.blocking && !w.forceable);
});

test('overlap blocks but is forceable; overtime look-ahead warns', () => {
  const existing = [sh('2026-11-02', '08:00', '16:00', 'lg', 'x1')];
  const p = checkAssignment(adult, sh('2026-11-02', '15:00', '20:00'), ctx({ certs: good, existingShifts: existing }));
  const o = p.find((x) => x.code === 'overlap');
  assert.ok(o && o.blocking && o.forceable);
  const week = [2, 3, 4, 5].map((d, i) => sh(`2026-11-0${d}`, '07:00', '16:30', 'lg', 'w' + i)); // 38 h
  const w = checkAssignment(adult, sh('2026-11-06', '07:00', '12:00'), ctx({ certs: good, existingShifts: week }));
  assert.ok(w.some((x) => x.code === 'overtime_weekly' && !x.blocking));
});
