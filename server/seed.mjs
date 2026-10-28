// Demo data for "Demo Aquatics" (all names and numbers are fake).
// Runs automatically when the db is empty; `node server/seed.mjs --reset` wipes and reseeds.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB } from './db.mjs';
import { localDate, weekStartOf, addDays, zonedToUtc, iso, ageOn } from './lib/time.mjs';
import { abaCheckDigit } from './lib/nacha.mjs';

const TZ = 'America/Denver';
const fakeRouting = (p8) => p8 + abaCheckDigit(p8);

export function seed(h, { now = Date.now() } = {}) {
  const today = localDate(now, TZ);
  const thisWeek = weekStartOf(today, 0);
  const anchor = addDays(thisWeek, -14); // completed period = the two weeks before this one
  const W2 = anchor, W1 = addDays(anchor, 7), W0 = thisWeek, WN = addDays(thisWeek, 7);
  const nowIso = iso(now);
  const birth = (age, extraDays) => { let d = addDays(today, -Math.round(age * 365.25) - extraDays); while (ageOn(d, today) > age) d = addDays(d, 1); while (ageOn(d, today) < age) d = addDays(d, -1); return d; };

  h.tx(() => {
    h.run(`INSERT INTO orgs (id,name,state,tz,late_threshold_min,workweek_start,pay_frequency,pay_period_anchor,futa_exempt,suta_rate,rule_overrides,bank)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 'org-demo', 'Demo Aquatics', 'CO', TZ, 5, 0, 'biweekly', anchor, 1, 0.0305, '{}',
      JSON.stringify({ name: 'DEMO AQUATICS', companyId: '1999999999', originRouting: fakeRouting('99000001'), destinationRouting: fakeRouting('99000002'), destinationName: 'SAMPLE BANK (FAKE)' }));
    const pos = [['pos-lg', 'Lifeguard', ['lifeguard']], ['pos-si', 'Swim Instructor', ['instructor']], ['pos-hg', 'Head Guard', ['lifeguard', 'lead']]];
    for (const [id, name, tags] of pos) h.run('INSERT INTO positions (id,org_id,name,tags) VALUES (?,?,?,?)', id, 'org-demo', name, JSON.stringify(tags));
    const ct = [
      ['ct-lg', 'Lifeguard', 'Lifeguard training provider', 24, ['pos-lg', 'pos-hg']],
      ['ct-cpr', 'CPR/AED', 'CPR/AED training provider', 24, ['pos-lg', 'pos-si', 'pos-hg']],
      ['ct-wsi', 'Water Safety Instructor', 'WSI training provider', 24, ['pos-si']],
    ];
    for (const [id, name, issuer, months, req] of ct) h.run('INSERT INTO cert_types (id,org_id,name,issuer,validity_months,required_for_positions) VALUES (?,?,?,?,?,?)', id, 'org-demo', name, issuer, months, JSON.stringify(req));

    const w4s = { s: { filing: 'single', step2: false, dependentsCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } };
    const people = [
      ['p01', 'Dana Whitfield', ['member', 'owner'], [], birth(46, 40), 3200, { ...w4s.s, filing: 'married', dependentsCredit: 4000 }, 5200000],
      ['p02', 'Rafael Ortega', ['member', 'manager'], ['pos-hg', 'pos-lg'], birth(37, 90), 2400, { ...w4s.s, filing: 'hoh', dependentsCredit: 2200 }, 3900000],
      ['p03', 'Priya Raman', ['member', 'payroll'], ['pos-si'], birth(40, 200), 2600, { ...w4s.s, filing: 'married', step2: true }, 4100000],
      ['p04', 'Marcus Bell', ['member'], ['pos-lg', 'pos-hg'], birth(29, 15), 1900, w4s.s, 2600000],
      ['p05', 'Elena Vasquez', ['member'], ['pos-hg', 'pos-lg'], birth(32, 300), 2100, { ...w4s.s, extraWithholding: 20 }, 3300000],
      ['p06', 'Tyler Brooks', ['member'], ['pos-lg'], birth(26, 60), 2000, w4s.s, 1800000],
      ['p07', 'Jordan Kim', ['member'], ['pos-lg', 'pos-si'], birth(27, 120), 1950, w4s.s, 2400000],
      ['p08', 'Hannah Moore', ['member'], ['pos-si'], birth(35, 10), 2300, { ...w4s.s, filing: 'married' }, 2900000],
      ['p09', 'Owen Patel', ['member'], ['pos-lg'], birth(15, 120), 1550, w4s.s, 180000],
      ['p10', 'Sofia Nguyen', ['member'], ['pos-lg'], birth(16, 200), 1600, w4s.s, 650000],
      ['p11', 'Caleb Foster', ['member'], ['pos-si', 'pos-lg'], birth(17, 45), 1700, w4s.s, 900000],
      ['p12', 'Mia Chen', ['member'], ['pos-lg'], birth(14, 150), 1500, w4s.s, 0],
    ];
    people.forEach(([id, name, roles, positions, bd, rate, w4, ytd], i) => {
      const deposit = { routing: fakeRouting('99' + String(100000 + i * 37).padStart(6, '0')), account: String(100200300 + i * 1111), accountType: i % 4 === 3 ? 'savings' : 'checking' };
      h.run(`INSERT INTO people (id,org_id,name,email,roles,positions,status,birthdate,pay_rate_cents,w4,co_allowance,ytd_wages_cents,deposit)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, 'org-demo', name, name.toLowerCase().replace(/[^a-z]+/g, '.') + '@demo-aquatics.example',
        JSON.stringify(roles), JSON.stringify(positions), id === 'p12' ? 'applicant' : 'active', bd, rate, JSON.stringify(w4), null, ytd, JSON.stringify(deposit));
    });

    const cert = (pid, type, days) => h.run('INSERT INTO certs (person_id,type_id,expires) VALUES (?,?,?)', pid, type, addDays(today, days));
    for (const [pid, d] of [['p02', 400], ['p04', 250], ['p05', 500], ['p07', 610], ['p09', 650], ['p10', 330], ['p11', 410]]) { cert(pid, 'ct-lg', d); cert(pid, 'ct-cpr', d); }
    cert('p06', 'ct-lg', -27); cert('p06', 'ct-cpr', 300); // EXPIRED lifeguard cert
    for (const [pid, d] of [['p03', 420], ['p07', 610], ['p08', 380], ['p11', 410]]) { cert(pid, 'ct-wsi', d); if (pid !== 'p07' && pid !== 'p11') cert(pid, 'ct-cpr', d); }
    cert('p12', 'ct-cpr', 700); // applicant: CPR only

    let n = 0;
    const shift = (date, from, to, posId, pid, status = 'published', note = null) => {
      const start = zonedToUtc(date, from, TZ);
      let end = zonedToUtc(date, to, TZ);
      if (end <= start) end = zonedToUtc(addDays(date, 1), to, TZ);
      const id = `s-${date}-${++n}`;
      h.run('INSERT INTO shifts (id,org_id,position_id,person_id,start,"end",status,note) VALUES (?,?,?,?,?,?,?,?)', id, 'org-demo', posId, pid, iso(start), iso(end), status, note);
      return { id, start, end, pid };
    };
    const punch = (s, type, ms, restAttested = null) => h.run('INSERT INTO punches (id,person_id,shift_id,type,at,source,rest_attested,created_at) VALUES (?,?,?,?,?,?,?,?)',
      randomUUID(), s.pid, s.id, type, iso(ms), 'seed', restAttested == null ? null : restAttested ? 1 : 0, iso(Math.min(ms, now)));
    const M = 60000;
    // worked: punch in/out with optional lateness, early leave and a 30-min meal in the middle for shifts > 5 h
    const work = (s, { late = 0, early = 0, rest = true, meal = true, noOut = false } = {}) => {
      const inAt = s.start + late * M, outAt = s.end - early * M;
      punch(s, 'in', inAt);
      if (meal && s.end - s.start > 5 * 3600000) {
        const mid = s.start + Math.round((s.end - s.start) / 2 / (15 * M)) * 15 * M;
        punch(s, 'out', mid, null); punch(s, 'in', mid + 30 * M);
      }
      if (!noOut) punch(s, 'out', outAt, rest);
    };

    // ---- Week -2 (completed period, ordinary week) ----
    for (let i = 1; i <= 5; i++) { const d = addDays(W2, i); work(shift(d, '06:00', '14:30', 'pos-hg', 'p02')); work(shift(d, '12:00', '20:00', i % 2 ? 'pos-lg' : 'pos-hg', 'p05')); }
    for (const i of [1, 3, 5]) { const d = addDays(W2, i); work(shift(d, '08:00', '16:30', 'pos-lg', 'p04')); work(shift(d, '09:00', '15:00', 'pos-si', 'p08')); }
    for (const i of [2, 4]) { const d = addDays(W2, i); work(shift(d, '14:00', '20:00', 'pos-lg', 'p07')); work(shift(d, '16:00', '19:00', 'pos-lg', 'p09')); work(shift(d, '16:00', '20:00', 'pos-lg', 'p10')); }
    work(shift(addDays(W2, 6), '09:00', '15:00', 'pos-lg', 'p09')); work(shift(addDays(W2, 6), '09:00', '17:00', 'pos-si', 'p11'));
    for (const i of [1, 2, 3, 4, 5]) work(shift(addDays(W2, i), '09:00', '17:30', 'pos-si', 'p03', 'published', 'Office + lessons'));

    // ---- Week -1 (completed period, the interesting cases) ----
    const d1 = (i) => addDays(W1, i);
    work(shift(d1(1), '06:00', '19:30', 'pos-lg', 'p04', 'published', 'Swim meet: 12+ hour day'));       // daily-12 OT
    work(shift(d1(3), '08:00', '16:30', 'pos-lg', 'p04'));
    for (let i = 1; i <= 5; i++) work(shift(d1(i), '07:00', '16:30', 'pos-hg', 'p05'));                  // 45 h -> weekly OT
    work(shift(d1(2), '14:00', '20:00', 'pos-lg', 'p07'), { late: 8 });                                 // late 8 min
    work(shift(d1(5), '20:00', '09:00', 'pos-lg', 'p07', 'published', 'Overnight lock-in event'), { meal: false }); // 13 h across midnight -> consecutive OT
    const missed = shift(d1(2), '09:00', '15:00', 'pos-si', 'p08');
    work(missed, { noOut: true });                                                                      // missed clock-out
    work(shift(d1(4), '09:00', '15:00', 'pos-si', 'p08'), { rest: false });                              // rest break not taken
    for (const i of [2, 4]) work(shift(d1(i), '16:00', '19:00', 'pos-lg', 'p09'));                       // 15-year-old, school days, 3 h
    work(shift(d1(6), '09:00', '15:00', 'pos-lg', 'p09'));
    work(shift(d1(6), '10:00', '16:00', 'pos-lg', 'p10'), { late: 15 });                                 // late 15 min
    work(shift(d1(3), '16:00', '20:00', 'pos-lg', 'p10'));
    work(shift(d1(6), '09:00', '17:00', 'pos-si', 'p11'));
    for (let i = 1; i <= 5; i++) work(shift(d1(i), '06:00', '14:30', 'pos-hg', 'p02'));
    for (const i of [1, 2, 3, 4, 5]) work(shift(d1(i), '09:00', '17:30', 'pos-si', 'p03', 'published', 'Office + lessons'));
    h.run(`INSERT INTO punch_requests (id,person_id,shift_id,type,at,reason_code,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      'pr-demo-1', 'p08', missed.id, 'out', iso(missed.end), 'forgot', 'Forgot to clock out after lessons.', 'pending', nowIso);

    // ---- This week: earlier days worked, today relative to now, later days published ----
    for (let i = 0; i < 7; i++) {
      const d = addDays(W0, i);
      if (d === today) continue;
      const past = d < today;
      const S = (from, to, p, pid) => { const s = shift(d, from, to, p, pid); if (past) work(s); };
      if (i >= 1 && i <= 5) { S('09:00', '17:30', 'pos-si', 'p03'); if (i % 2) S('16:00', '19:00', 'pos-lg', 'p09'); else S('16:00', '20:00', 'pos-lg', 'p10'); }
      if (i === 0 || i === 6) { S('09:00', '17:00', 'pos-si', 'p11'); S('10:00', '16:00', 'pos-lg', 'p10'); }
      if (i === 3 || i === 5) S('12:00', '20:00', 'pos-lg', 'p04');
    }
    const round5 = (ms) => Math.round(ms / (5 * M)) * 5 * M;
    const rel = (startOff, hours, posId, pid, note) => {
      const start = round5(now + startOff * M), end = start + hours * 3600000;
      const id = `s-${today}-${++n}`;
      h.run('INSERT INTO shifts (id,org_id,position_id,person_id,start,"end",status,note) VALUES (?,?,?,?,?,?,?,?)', id, 'org-demo', posId, pid, iso(start), iso(end), 'published', note);
      return { id, start, end, pid };
    };
    const t1 = rel(-60, 8, 'pos-hg', 'p02', 'Opening head guard'); punch(t1, 'in', t1.start - 3 * M);  // clocked in on time
    rel(-30, 6, 'pos-lg', 'p04', null);                                                               // no punch -> late alert
    const t3 = rel(-20, 7, 'pos-hg', 'p05', null); punch(t3, 'in', t3.start + 12 * M);                // arrived 12 min late
    rel(120, 6, 'pos-lg', 'p07', null);                                                               // upcoming
    const t5 = rel(-7 * 60, 5, 'pos-si', 'p08', 'Morning lessons'); punch(t5, 'in', t5.start - 1 * M); punch(t5, 'out', t5.end, true); // clocked out

    // ---- Next week: mostly draft, a few open shifts, one published shift offered for swap ----
    for (let i = 0; i < 7; i++) {
      const d = addDays(WN, i);
      if (i >= 1 && i <= 5) { shift(d, '06:00', '14:30', 'pos-hg', 'p02', 'draft'); shift(d, '12:00', '20:00', 'pos-lg', i % 2 ? 'p05' : 'p04', 'draft'); shift(d, '09:00', '17:30', 'pos-si', 'p03', 'draft'); }
      if (i === 2 || i === 4) shift(d, '16:00', '19:00', 'pos-lg', 'p09', 'draft');
      if (i === 1 || i === 3) shift(d, '15:00', '19:00', 'pos-si', null, 'draft', 'Open: evening lessons');
    }
    shift(addDays(WN, 6), '10:00', '16:00', 'pos-lg', null, 'published', 'Open: Saturday guard');
    const swapShift = shift(addDays(WN, 6), '09:00', '17:00', 'pos-si', 'p11', 'published');
    shift(addDays(WN, 0), '10:00', '16:00', 'pos-lg', 'p10', 'published');
    h.run('INSERT INTO swaps (id,shift_id,from_person,claimant,status,created_at) VALUES (?,?,?,?,?,?)', 'sw-demo-1', swapShift.id, 'p11', null, 'offered', nowIso);

    h.run('INSERT INTO audit_log (org_id,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)', 'org-demo', 'system', 'seed', 'org-demo', JSON.stringify({ anchor, today }), nowIso);
  });
  return { anchor };
}

export function resetDb(file = DEFAULT_DB) {
  for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
  const h = openDb(file);
  const r = seed(h);
  h.close();
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--reset')) {
    const r = resetDb(process.env.KEA_DB || DEFAULT_DB);
    console.log(`Demo db reset and seeded (pay periods anchored on ${r.anchor}).`);
  } else {
    const h = openDb(process.env.KEA_DB || DEFAULT_DB);
    if (h.isEmpty()) { const r = seed(h); console.log(`Seeded (anchor ${r.anchor}).`); } else console.log('Database already has data; use --reset to wipe and reseed.');
    h.close();
  }
}
