import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandSlots, prefillUsual, prefillFrom, usualFromAnswers, cleanAnswers, hoursMarked, autofill, sheetsExport, longExport,
  certStage, addMonths, nextMonth, fmtTime, sortTodo, toCsv,
} from '../../hub/org/logic.mjs';

const TZ = 'America/Denver';
// A December form like the owner's: weekday blocks, a short Saturday, closed on Christmas, a swim meet added.
const form = {
  periodStart: '2026-12-01', periodEnd: '2026-12-31',
  blocks: [
    ...[1, 2, 3, 4, 5].flatMap((wd) => [
      { id: `m${wd}`, weekday: wd, start: '04:45', end: '09:00', need: [{ positionId: 'lg', count: 2 }] },
      { id: `d${wd}`, weekday: wd, start: '09:00', end: '13:00', need: [{ positionId: 'lg', count: 1 }] },
      { id: `e${wd}`, weekday: wd, start: '15:45', end: '20:45', need: [{ positionId: 'lg', count: 2 }], tags: ['closer'] },
    ]),
    { id: 'sat', weekday: 6, start: '06:45', end: '11:30', need: [{ positionId: 'lg', count: 1 }] },
  ],
  exceptions: [
    { date: '2026-12-25', kind: 'closed', note: 'Christmas' },
    { date: '2026-12-12', kind: 'extra', blocks: [{ id: 'xmeet', start: '17:00', end: '21:00', label: 'Swim meet', need: [{ positionId: 'lg', count: 3 }] }] },
    { date: '2026-12-24', kind: 'hours', blocks: [{ id: 'xeve', start: '06:00', end: '12:00', label: 'Christmas Eve' }] },
  ],
};

test('slots: weekday blocks over the period, closed dates, special hours, extra blocks, times in the org zone', () => {
  const s = expandSlots(form, TZ);
  assert.ok(!s.some((x) => x.date === '2026-12-25'), 'Christmas is closed');
  assert.deepEqual(s.filter((x) => x.date === '2026-12-24').map((x) => x.blockId), ['xeve'], 'Christmas Eve has only its special hours');
  const sat12 = s.filter((x) => x.date === '2026-12-12');
  assert.deepEqual(sat12.map((x) => x.blockId), ['sat', 'xmeet']);
  assert.equal(sat12[1].special, 'extra');
  const m = s.find((x) => x.key === '2026-12-01|m2');
  assert.equal(new Date(m.startAt).toISOString(), '2026-12-01T11:45:00.000Z', '4:45am Mountain is 11:45 UTC');
  assert.equal(m.minutes, 255);
  // No Sundays. 23 weekdays, minus Christmas (closed) and Christmas Eve (its own hours) = 21 x 3 blocks,
  // + the Eve block + 4 Saturdays + the swim meet.
  assert.equal(s.length, 21 * 3 + 1 + 4 + 1);
});

test('a block past midnight ends the next day', () => {
  const s = expandSlots({ periodStart: '2026-12-01', periodEnd: '2026-12-01', blocks: [{ id: 'n', weekday: 2, start: '22:00', end: '02:00' }], exceptions: [] }, TZ);
  assert.equal(s[0].minutes, 240);
  assert.equal(s[0].endAt - s[0].startAt, 4 * 3600_000);
});

test('prefill: usual week, last month by weekday and time, saving a usual week', () => {
  const s = expandSlots(form, TZ);
  const usual = prefillUsual(s, { '1|04:45-09:00': 'A', '3|15:45-20:45': 'I' });
  assert.equal(usual['2026-12-07|m1'], 'A');
  assert.equal(usual['2026-12-02|e3'], 'I');
  assert.equal(usual['2026-12-02|m3'], undefined);
  // November answers -> December: Mondays mornings were mostly A, one N.
  const nov = expandSlots({ ...form, periodStart: '2026-11-01', periodEnd: '2026-11-30', exceptions: [] }, TZ);
  const ans = { '2026-11-02|m1': 'A', '2026-11-09|m1': 'A', '2026-11-16|m1': 'A', '2026-11-04|d3': 'I' };
  const p = prefillFrom(nov, ans, s);
  assert.equal(p['2026-12-14|m1'], 'A');
  assert.equal(p['2026-12-02|d3'], undefined, 'one If needed out of four Wednesdays is mostly Not available');
  const back = usualFromAnswers(s, { ...usual });
  assert.equal(back['1|04:45-09:00'], 'A');
});

test('answers are cleaned to real slots and A/I only; hours add up per week', () => {
  const s = expandSlots(form, TZ);
  const a = cleanAnswers(s, { '2026-12-01|m2': 'A', '2026-12-01|d2': 'I', '2026-12-01|nope': 'A', '2026-12-02|m3': 'X', '2026-12-03|m4': 'N' });
  assert.deepEqual(a, { '2026-12-01|m2': 'A', '2026-12-01|d2': 'I' });
  const h = hoursMarked(s, a, 31);
  assert.equal(h.available, 4.3);
  assert.equal(h.ifNeeded, 4);
});

test('auto-fill: hard limits, Available before If needed, balances toward desired hours, deterministic', () => {
  const slots = [
    { key: 'd1|a', date: '2026-12-01', blockId: 'a', startAt: 0, endAt: 4 * 3600_000, minutes: 240, need: [{ positionId: 'lg', count: 1 }], tags: [] },
    { key: 'd1|b', date: '2026-12-01', blockId: 'b', startAt: 5 * 3600_000, endAt: 9 * 3600_000, minutes: 240, need: [{ positionId: 'lg', count: 1 }], tags: [] },
    { key: 'd2|a', date: '2026-12-02', blockId: 'a', startAt: 24 * 3600_000, endAt: 28 * 3600_000, minutes: 240, need: [{ positionId: 'lg', count: 2 }], tags: ['opener'] },
  ];
  const people = [
    { id: 'p1', name: 'Ana', positions: ['lg'], desiredMax: 4, prefs: [] },
    { id: 'p2', name: 'Ben', positions: ['lg'], desiredMax: 20, prefs: ['opener'] },
    { id: 'p3', name: 'Cy', positions: ['lg'], desiredMax: 20, prefs: [] },
    { id: 'p4', name: 'Dee', positions: ['front'], desiredMax: 20, prefs: [] },
  ];
  const answers = new Map([
    ['p1', { 'd1|a': 'A', 'd1|b': 'A', 'd2|a': 'A' }],
    ['p2', { 'd1|a': 'I', 'd1|b': 'A', 'd2|a': 'A' }],
    ['p3', { 'd1|a': 'A', 'd2|a': 'I' }],
    ['p4', { 'd1|a': 'A', 'd1|b': 'A', 'd2|a': 'A' }],
  ]);
  // Cy has a cert problem for d1|b only (blocking).
  const check = (p, sh) => (p.id === 'p3' && sh.start === new Date(5 * 3600_000).toISOString() ? [{ code: 'cert_missing', blocking: true }] : []);
  const run = () => autofill({ slots, people, answers, shifts: [], check, options: {} });
  const r = run();
  assert.deepEqual(r, run(), 'same input, same schedule');
  const who = (k) => r.add.filter((a) => a.slotKey === k).map((a) => a.accountId).sort();
  assert.ok(!r.add.some((a) => a.accountId === 'p4'), 'nobody without the position');
  assert.deepEqual(who('d1|a').length, 1);
  assert.ok(!who('d1|a').includes('p2'), 'Ben was only If needed for d1|a');
  assert.equal(r.unfilled.length, 0);
  // Ana wants at most 4 hours: after one shift she goes behind the others.
  assert.equal(r.add.filter((a) => a.accountId === 'p1').length, 1);
  // The scarcest place (two needed) goes first; Ben's "opener" preference matches it.
  assert.ok(who('d2|a').includes('p2'));
  assert.deepEqual(who('d1|b'), ['p2']);
  // Hard max: Ana can't go over; with nobody else, places stay open with the reason.
  const r2 = autofill({ slots, people: [people[0]], answers, shifts: [], check, options: { hardMaxHours: true } });
  assert.equal(r2.add.length, 1);
  assert.equal(r2.unfilled.reduce((t, u) => t + u.missing, 0), 3);
  assert.ok(r2.unfilled.some((u) => u.reasons.desired_max));
  // If needed can be turned off.
  const r3 = autofill({ slots, people, answers, shifts: [], check, options: { useIfNeeded: false } });
  assert.ok(!r3.add.some((a) => a.state === 'I'));
});

test('auto-fill counts shifts already there and skips blocked people with a reason', () => {
  const slots = [{ key: 'k', date: '2026-12-01', blockId: 'a', startAt: 0, endAt: 3600_000, minutes: 60, need: [{ positionId: 'lg', count: 2 }], tags: [] }];
  const people = [{ id: 'a', name: 'A', positions: ['lg'] }, { id: 'b', name: 'B', positions: ['lg'] }];
  const answers = new Map([['a', { k: 'A' }], ['b', { k: 'A' }]]);
  const r = autofill({ slots, people, answers, shifts: [{ accountId: 'a', positionId: 'lg', slotKey: 'k', date: '2026-12-01', startAt: 0, endAt: 3600_000 }], check: () => [{ code: 'minor_day_hours', blocking: true }], options: {} });
  assert.equal(r.add.length, 0);
  assert.deepEqual(r.unfilled, [{ slotKey: 'k', date: '2026-12-01', blockId: 'a', positionId: 'lg', missing: 1, reasons: { minor_day_hours: 1 } }]);
});

test('CSV: Google-Sheets shape (one column per weekday block, dates listed), and by date', () => {
  const s = expandSlots(form, TZ);
  const rows = [{ name: 'Ana Ruiz', email: 'ana@example.com', submittedAt: Date.UTC(2026, 10, 20, 21, 5, 33), answers: { '2026-12-01|m2': 'A', '2026-12-08|m2': 'A', '2026-12-15|m2': 'I', '2026-12-12|xmeet': 'A' },
    dateNotes: { '2026-12-03': 'dentist' }, note: 'Prefer opening', desiredMin: 15, desiredMax: 20, daysOff: '12/24-12/26', extra: { q1: 'Yes' } }];
  const csv = sheetsExport({ form, slots: s, rows, tz: TZ, questions: { custom: [{ id: 'q1', label: 'Can you teach lessons?', type: 'text' }] } });
  const [head, line] = csv.trim().split('\r\n');
  assert.ok(head.startsWith('Timestamp,Email Address,Name,Monday 4:45am-9am,Monday 9am-1pm,Monday 3:45pm-8:45pm,Tuesday 4:45am-9am'), head);
  assert.ok(head.includes('12/12 Swim meet 5pm-9pm'));
  assert.ok(head.endsWith('Desired hours per week,Days off needed,Can you teach lessons?,Notes by date,Notes,Email verified'));
  assert.ok(line.startsWith('11/20/2026 14:05:33,ana@example.com,Ana Ruiz,'), line);
  assert.ok(line.includes('"12/1, 12/8, 12/15 (if needed)"'));
  assert.ok(line.includes(',15-20,12/24-12/26,Yes,12/3: dentist,Prefer opening'));
  const long = longExport({ slots: s, rows }).split('\r\n');
  assert.equal(long[0], 'Name,Email,Date,Weekday,Block,Start,End,Answer,Note for the date,Email verified');
  assert.equal(long.length, s.length + 2);
  // Spreadsheet formulas are never passed through.
  assert.equal(toCsv([['=HYPERLINK("x")']]), `"'=HYPERLINK(""x"")"\r\n`);
});

test('countdowns: cert stages at 60, 30 and 7 days, expired; months; next month; to-do order', () => {
  assert.deepEqual(certStage('2026-11-04', '2026-11-05'), { stage: 'expired', daysLeft: -1 });
  assert.deepEqual(certStage('2026-11-10', '2026-11-05'), { stage: '7', daysLeft: 5 });
  assert.deepEqual(certStage('2026-11-30', '2026-11-05'), { stage: '30', daysLeft: 25 });
  assert.deepEqual(certStage('2026-12-30', '2026-11-05'), { stage: '60', daysLeft: 55 });
  assert.deepEqual(certStage('2027-03-01', '2026-11-05'), { stage: 'ok', daysLeft: 116 });
  assert.equal(certStage('2026-11-18', '2026-11-05', [14]).stage, '14');
  assert.equal(certStage('2026-11-20', '2026-11-05', [14]).stage, 'ok');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 24), '2028-11-15');
  assert.deepEqual(nextMonth('2026-11-05'), { start: '2026-12-01', end: '2026-12-31' });
  assert.deepEqual(nextMonth('2026-12-20'), { start: '2027-01-01', end: '2027-01-31' });
  assert.equal(fmtTime('00:00'), '12am');
  assert.equal(fmtTime('12:30'), '12:30pm');
  const order = sortTodo([{ key: 'c', dueAt: null }, { key: 'b', dueAt: 50 }, { key: 'a', dueAt: 100, overdue: true }, { key: 'd', dueAt: 10 }]).map((x) => x.key);
  assert.deepEqual(order, ['a', 'd', 'b', 'c']);
});
