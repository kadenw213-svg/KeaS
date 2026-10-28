// Labor rules engine (pure). PROTOTYPE: the rule tables it reads are unverified defaults.
import { toMs, localDate, localMinuteOfDay, weekStartOf, weekday, addDays, ageOn, isSummer, hhmmToMin } from './time.mjs';

const MIN = 60000;

// ---------- merge ----------
const minN = (...v) => { const x = v.filter((n) => n != null); return x.length ? Math.min(...x) : null; };
const maxN = (...v) => { const x = v.filter((n) => n != null); return x.length ? Math.max(...x) : null; };
const anyTrue = (...v) => v.some((b) => b === true);

function mergeTwo(a, b) {
  if (!a) return b ? structuredClone(b) : null;
  if (!b) return structuredClone(a);
  const out = { jurisdiction: [a.jurisdiction, b.jurisdiction].filter(Boolean).join('+') };
  const oa = a.overtime, ob = b.overtime;
  out.overtime = (oa || ob) ? {
    weeklyHours: minN(oa?.weeklyHours, ob?.weeklyHours),
    dailyHours: minN(oa?.dailyHours, ob?.dailyHours),
    consecutiveHours: minN(oa?.consecutiveHours, ob?.consecutiveHours),
    multiplier: maxN(oa?.multiplier, ob?.multiplier) ?? 1.5,
  } : null;
  const ma = a.meal, mb = b.meal;
  out.meal = (ma || mb) ? { afterHours: minN(ma?.afterHours, mb?.afterHours), minutes: maxN(ma?.minutes, mb?.minutes), paid: anyTrue(ma?.paid, mb?.paid) } : null;
  const ra = a.rest, rb = b.rest;
  out.rest = (ra || rb) ? { perHours: minN(ra?.perHours, rb?.perHours), minutes: maxN(ra?.minutes, rb?.minutes), paid: anyTrue(ra?.paid, rb?.paid), missedPremium: anyTrue(ra?.missedPremium, rb?.missedPremium) } : null;
  const na = a.minors, nb = b.minors;
  out.minors = (na || nb) ? {
    minimumWorkAge: maxN(na?.minimumWorkAge, nb?.minimumWorkAge),
    summer: nb?.summer || na?.summer || { start: '06-01', end: 'labor-day' },
    // Brackets are kept side by side; checkAssignment applies the strictest of every bracket that covers an age.
    ages: [...(na?.ages || []).map((x) => ({ ...x, from: a.jurisdiction })), ...(nb?.ages || []).map((x) => ({ ...x, from: b.jurisdiction }))],
  } : null;
  const wa = a.minimumWage, wb = b.minimumWage;
  out.minimumWage = (wa || wb) ? {
    standard: maxN(wa?.standard, wb?.standard),
    tipped: maxN(wa?.tipped, wb?.tipped),
    youthDiscountPct: minN(wa?.youthDiscountPct, wb?.youthDiscountPct),
    localOverrides: [...(wa?.localOverrides || []), ...(wb?.localOverrides || [])],
  } : null;
  const sa = a.sickLeave, sb = b.sickLeave;
  out.sickLeave = (sa || sb) ? { accrueHoursPer: minN(sa?.accrueHoursPer, sb?.accrueHoursPer), cap: maxN(sa?.cap, sb?.cap) } : null;
  out.notes = [...(a.notes || []), ...(b.notes || [])];
  out.source = [...(a.source || []), ...(b.source || [])];
  out.verifiedFor = a.verifiedFor && b.verifiedFor ? `${a.verifiedFor}+${b.verifiedFor}` : null;
  return out;
}

/** Strictest-wins merge of federal, state and org rule tables (org overrides may only tighten). */
export function mergeRules(us, state, orgOverrides) {
  let r = mergeTwo(us, state);
  if (orgOverrides && Object.keys(orgOverrides).length) {
    r = mergeTwo(r, { jurisdiction: 'org', verifiedFor: r.verifiedFor, ...orgOverrides });
  }
  return r;
}

// ---------- timecard ----------
/** Pair punches in -> out. Returns { pairs, missed, open }. */
export function pairPunches(punches, { now = Date.now(), maxOpenHours = 16 } = {}) {
  const sorted = [...punches].sort((x, y) => toMs(x.at) - toMs(y.at) || (x.id > y.id ? 1 : -1));
  const pairs = [], missed = [];
  let open = null;
  for (const p of sorted) {
    if (p.type === 'in') {
      if (open) missed.push({ kind: 'out_missing', punch: open });
      open = p;
    } else if (p.type === 'out') {
      if (open) { pairs.push({ in: open, out: p, start: toMs(open.at), end: toMs(p.at) }); open = null; }
      else missed.push({ kind: 'in_missing', punch: p });
    }
  }
  let current = null;
  if (open) {
    if (now - toMs(open.at) > maxOpenHours * 3600000) missed.push({ kind: 'out_missing', punch: open });
    else current = open;
  }
  return { pairs, missed, open: current };
}

/** Rest periods owed for a work span ("per N hours or major fraction"). */
export function restOwed(workedMin, perHours) {
  if (!perHours) return 0;
  const h = workedMin / 60;
  return Math.max(0, Math.ceil((h - perHours / 2) / perHours - 1e-9));
}

/**
 * Compute a timecard.
 * punches: [{id, type:'in'|'out', at, shift_id?, restAttested?:boolean|null}]
 * shifts:  [{id, start, end, restAttested?}]
 * Returns { days, weeks, totals, flags, open }.
 */
export function timecard(punches, shifts, rules, opts = {}) {
  const { workweekStart = 0, tz = 'America/Denver', lateThresholdMin = 5, now = Date.now(), periodStart = null, periodEnd = null, stretchGapMin = 30 } = opts;
  const ot = rules?.overtime || {};
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const { pairs, missed, open } = pairPunches(punches, { now });
  const flags = [];
  const inPeriod = (d) => (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);

  // Expand worked minutes (minute resolution, chronological).
  pairs.sort((x, y) => x.start - y.start);
  const minutes = []; // { ms, day, week, pair }
  let stretchCount = 0, lastEnd = null;
  const dayCount = new Map();
  for (const pr of pairs) {
    if (lastEnd == null || pr.start - lastEnd >= stretchGapMin * MIN) stretchCount = 0;
    const n = Math.max(0, Math.round((pr.end - pr.start) / MIN));
    for (let i = 0; i < n; i++) {
      const ms = pr.start + i * MIN;
      const day = localDate(ms, tz);
      const dc = (dayCount.get(day) || 0) + 1;
      dayCount.set(day, dc);
      stretchCount++;
      const dailyOt = ot.dailyHours != null && dc > ot.dailyHours * 60;
      const consecOt = ot.consecutiveHours != null && stretchCount > ot.consecutiveHours * 60;
      minutes.push({ ms, day, week: weekStartOf(day, workweekStart), pr, dailyOt, consecOt, ot: false });
    }
    lastEnd = pr.end;
  }
  const counted = minutes.filter((m) => inPeriod(m.day));

  // Per workweek: weekly-40 vs daily/consecutive (union, each minute once); pay whichever is greater.
  const weeks = new Map();
  for (const m of counted) { if (!weeks.has(m.week)) weeks.set(m.week, []); weeks.get(m.week).push(m); }
  const weekOut = [];
  for (const [ws, mins] of [...weeks.entries()].sort()) {
    const weeklyOt = ot.weeklyHours != null ? Math.max(0, mins.length - ot.weeklyHours * 60) : 0;
    const dailyFlagged = mins.filter((m) => m.dailyOt || m.consecOt);
    let method = 'none';
    if (dailyFlagged.length >= weeklyOt && dailyFlagged.length > 0) { method = 'daily/consecutive'; dailyFlagged.forEach((m) => (m.ot = true)); }
    else if (weeklyOt > 0) { method = 'weekly'; mins.slice(mins.length - weeklyOt).forEach((m) => (m.ot = true)); }
    const otMin = mins.filter((m) => m.ot).length;
    weekOut.push({
      weekStart: ws, workedMin: mins.length, overtimeMin: otMin, method,
      weeklyOvertimeMin: weeklyOt,
      dailyOvertimeMin: mins.filter((m) => m.dailyOt).length,
      consecutiveOvertimeMin: mins.filter((m) => m.consecOt).length,
      dailyOrConsecutiveMin: dailyFlagged.length,
    });
    if (otMin > 0) flags.push({ code: 'overtime', date: ws, minutes: otMin, message: `${(otMin / 60).toFixed(2)} h overtime in week of ${ws} (${method} method gives the most)` });
  }

  // Days.
  const days = new Map();
  const dayRow = (d) => { if (!days.has(d)) days.set(d, { date: d, workedMin: 0, regularMin: 0, overtimeMin: 0, restPremiumMin: 0, punches: [] }); return days.get(d); };
  for (const m of counted) { const r = dayRow(m.day); r.workedMin++; if (m.ot) r.overtimeMin++; else r.regularMin++; }
  for (const p of punches) { const d = localDate(p.at, tz); if (inPeriod(d)) dayRow(d).punches.push({ id: p.id, type: p.type, at: p.at, source: p.source || null, shiftId: p.shift_id ?? p.shiftId ?? null }); }

  // Rest breaks and meal periods per shift (pairs grouped by shift; unlinked pairs stand alone).
  const groups = new Map();
  pairs.forEach((pr, i) => {
    const sid = pr.in.shift_id ?? pr.in.shiftId ?? pr.out.shift_id ?? pr.out.shiftId ?? null;
    const key = sid ?? `pair${i}`;
    if (!groups.has(key)) groups.set(key, { shiftId: sid, pairs: [] });
    groups.get(key).pairs.push(pr);
  });
  let restPremiumMin = 0;
  for (const g of groups.values()) {
    const first = g.pairs[0];
    const day = localDate(first.start, tz);
    if (!inPeriod(day)) continue;
    const worked = g.pairs.reduce((s, p) => s + Math.round((p.end - p.start) / MIN), 0);
    const shift = g.shiftId != null ? shiftById.get(g.shiftId) : null;
    if (rules?.rest) {
      const owed = restOwed(worked, rules.rest.perHours);
      const attested = g.pairs.map((p) => p.out.restAttested ?? p.out.rest_attested).find((v) => v != null) ?? shift?.restAttested ?? shift?.rest_attested;
      const notTaken = attested === false || attested === 0;
      if (owed > 0 && notTaken) {
        const prem = rules.rest.missedPremium ? owed * rules.rest.minutes : 0;
        restPremiumMin += prem;
        dayRow(day).restPremiumMin += prem;
        flags.push({ code: 'missed_rest', date: day, shiftId: g.shiftId, minutes: prem, message: `${owed} rest break(s) owed, not attested as taken; ${prem} min premium` });
      }
    }
    if (rules?.meal && rules.meal.afterHours != null) {
      const span = Math.round((g.pairs[g.pairs.length - 1].end - first.start) / MIN);
      let longestGap = 0;
      for (let i = 1; i < g.pairs.length; i++) longestGap = Math.max(longestGap, Math.round((g.pairs[i].start - g.pairs[i - 1].end) / MIN));
      if (span > rules.meal.afterHours * 60 && longestGap < rules.meal.minutes) {
        flags.push({ code: 'meal_not_recorded', date: day, shiftId: g.shiftId, message: `Shift over ${rules.meal.afterHours} h with no ${rules.meal.minutes}-min off-duty meal punched; treated as an on-duty (paid) meal` });
      }
    }
  }

  // Missed punches.
  for (const m of missed) {
    const d = localDate(m.punch.at, tz);
    if (!inPeriod(d)) continue;
    flags.push({ code: 'missed_punch', date: d, shiftId: m.punch.shift_id ?? null, punchId: m.punch.id, kind: m.kind, message: m.kind === 'out_missing' ? 'Clock-in with no clock-out' : 'Clock-out with no clock-in' });
  }

  // Lateness / no-shows per shift.
  let lateCount = 0;
  for (const s of shifts) {
    const start = toMs(s.start), end = toMs(s.end);
    const d = localDate(start, tz);
    if (!inPeriod(d) || start > now) continue;
    const ins = punches.filter((p) => p.type === 'in' && ((p.shift_id ?? p.shiftId) === s.id || ((p.shift_id ?? p.shiftId) == null && Math.abs(toMs(p.at) - start) <= 2 * 3600000)));
    const first = ins.sort((x, y) => toMs(x.at) - toMs(y.at))[0];
    if (first) {
      const late = Math.floor((toMs(first.at) - start) / MIN);
      if (late > lateThresholdMin) { lateCount++; flags.push({ code: 'late', date: d, shiftId: s.id, minutes: late, message: `Clocked in ${late} min late` }); }
    } else if (end < now) {
      flags.push({ code: 'no_show', date: d, shiftId: s.id, message: 'No clock-in for a past shift' });
    }
  }

  const dayList = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = {
    workedMin: counted.length,
    regularMin: counted.filter((m) => !m.ot).length,
    overtimeMin: counted.filter((m) => m.ot).length,
    restPremiumMin,
  };
  flags.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { days: dayList, weeks: weekOut, totals, flags, lateCount, open: open ? { id: open.id, at: open.at, shiftId: open.shift_id ?? null } : null };
}

// ---------- scheduling checks ----------
function defaultSchoolDay(date) { const wd = weekday(date); return wd >= 1 && wd <= 5 && !isSummer(date); }

/** Minutes of [start,end) falling on each local date. */
export function minutesByDate(start, end, tz) {
  const out = new Map();
  for (let t = toMs(start); t < toMs(end); t += MIN) { const d = localDate(t, tz); out.set(d, (out.get(d) || 0) + 1); }
  return out;
}

function strictestMinorLimits(rules, age) {
  const brackets = (rules?.minors?.ages || []).filter((b) => age >= b.min && age <= b.max);
  if (!brackets.length) return null;
  const pick = (k, f) => f(...brackets.map((b) => b[k]));
  const timeMax = (...v) => { const x = v.filter(Boolean); return x.length ? x.sort().at(-1) : null; };
  const timeMin = (...v) => { const x = v.filter(Boolean); return x.length ? x.sort()[0] : null; };
  return {
    schoolDayMaxHours: pick('schoolDayMaxHours', minN), schoolWeekMaxHours: pick('schoolWeekMaxHours', minN),
    nonSchoolDayMaxHours: pick('nonSchoolDayMaxHours', minN), nonSchoolWeekMaxHours: pick('nonSchoolWeekMaxHours', minN),
    earliest: pick('earliest', timeMax), latest: pick('latest', timeMin), latestSummer: pick('latestSummer', timeMin),
    restrictedPositions: brackets.flatMap((b) => (b.restrictedPositions || []).map((r) => ({ ...r, from: b.from }))),
    from: brackets.map((b) => b.from).filter(Boolean),
  };
}

const fmtH = (min) => `${(min / 60).toFixed(min % 60 ? 2 : 0)} h`;

/**
 * Problems with assigning person to shift.
 * person: {id, name, birthdate, positions:[ids]}
 * shift: {id?, position_id|positionId, start, end}
 * ctx: {certs:[{type_id|typeId, expires}], certTypes:[{id,name,required_for_positions|requiredForPositions}], positions:[{id,name,tags}],
 *       rules, existingShifts:[{id,start,end}] (the person's other shifts), tz, workweekStart, schoolCalendar?:{isSchoolDay(date)}, now}
 */
export function checkAssignment(person, shift, ctx) {
  const { certs = [], certTypes = [], positions = [], rules, existingShifts = [], tz = 'America/Denver', workweekStart = 0, schoolCalendar } = ctx;
  const problems = [];
  const add = (code, message, blocking, forceable = false, extra = {}) => problems.push({ code, message, blocking, forceable: blocking ? forceable : true, ...extra });
  const positionId = shift.position_id ?? shift.positionId;
  const position = positions.find((p) => p.id === positionId) || { id: positionId, name: String(positionId), tags: [] };
  const start = toMs(shift.start), end = toMs(shift.end);
  const date = localDate(start, tz);
  const isSchoolDay = schoolCalendar?.isSchoolDay || defaultSchoolDay;

  if (!(end > start)) { add('bad_times', 'Shift must end after it starts', true); return problems; }

  const others = existingShifts.filter((s) => s.id == null || s.id !== shift.id);
  for (const o of others) {
    if (toMs(o.start) < end && start < toMs(o.end)) add('overlap', `Overlaps another shift (${o.start} - ${o.end})`, true, true, { shiftId: o.id });
  }

  const held = (person.positions || []).includes(positionId);
  if (!held) add('position_not_held', `${person.name} is not set up for ${position.name}`, false);

  // Certifications (org-defined; nothing cert-specific is hard-coded here).
  for (const ct of certTypes) {
    const req = ct.required_for_positions ?? ct.requiredForPositions ?? [];
    if (!req.includes(positionId)) continue;
    const mine = certs.filter((c) => (c.type_id ?? c.typeId) === ct.id).sort((a, b) => (a.expires < b.expires ? 1 : -1))[0];
    if (!mine) add('cert_missing', `${position.name} requires a ${ct.name} certification`, true, false, { certTypeId: ct.id });
    else if (toMs(mine.expires + (mine.expires.length === 10 ? 'T23:59:59Z' : '')) < end) add('cert_expired', `${ct.name} certification expired ${mine.expires}`, true, false, { certTypeId: ct.id });
    else if (toMs(mine.expires) - end < 30 * 86400000) add('cert_expiring', `${ct.name} certification expires ${mine.expires}`, false, true, { certTypeId: ct.id });
  }

  // Age rules.
  if (person.birthdate) {
    const age = ageOn(person.birthdate, date);
    const minWork = rules?.minors?.minimumWorkAge;
    if (minWork != null && age < minWork) add('under_minimum_age', `${person.name} is ${age}; minimum working age is ${minWork}`, true, false, { age });
    const lim = age < 18 ? strictestMinorLimits(rules, age) : null;
    if (lim) {
      const tags = [position.name, ...(position.tags || [])].map((t) => String(t).toLowerCase());
      for (const r of lim.restrictedPositions) {
        if (tags.some((t) => t.includes(r.match.toLowerCase())) && age < r.minAge) {
          add('position_min_age', `${position.name} requires age ${r.minAge}+ (${person.name} is ${age})${r.note ? ' - ' + r.note : ''}`, true, false, { age, minAge: r.minAge });
        }
      }
      // Hours per day / week (cross-midnight shifts split by local date).
      const mine = minutesByDate(start, end, tz);
      const theirs = new Map();
      for (const o of others) for (const [d, m] of minutesByDate(o.start, o.end, tz)) theirs.set(d, (theirs.get(d) || 0) + m);
      for (const [d, m] of mine) {
        const school = isSchoolDay(d);
        const max = school ? lim.schoolDayMaxHours : lim.nonSchoolDayMaxHours;
        const total = m + (theirs.get(d) || 0);
        if (max != null && total > max * 60) add('minor_day_hours', `Age ${age}: ${fmtH(total)} on ${d} exceeds the ${max} h ${school ? 'school-day' : 'non-school-day'} limit`, true, false, { date: d, age });
        const ws = weekStartOf(d, workweekStart);
        const weekDates = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
        const schoolWeek = weekDates.some(isSchoolDay);
        const wmax = schoolWeek ? lim.schoolWeekMaxHours : lim.nonSchoolWeekMaxHours;
        const wtotal = weekDates.reduce((s, x) => s + (mine.get(x) || 0) + (theirs.get(x) || 0), 0);
        if (wmax != null && wtotal > wmax * 60 && !problems.some((p) => p.code === 'minor_week_hours')) add('minor_week_hours', `Age ${age}: ${fmtH(wtotal)} in week of ${ws} exceeds the ${wmax} h ${schoolWeek ? 'school-week' : 'non-school-week'} limit`, true, false, { weekStart: ws, age });
      }
      const sMin = localMinuteOfDay(start, tz);
      const endDate = localDate(end - 1, tz);
      const eMin = endDate === date ? localMinuteOfDay(end, tz) || 1440 : 1440 + 1;
      const latest = isSummer(date) && lim.latestSummer ? lim.latestSummer : lim.latest;
      if (lim.earliest && sMin < hhmmToMin(lim.earliest)) add('minor_time_of_day', `Age ${age}: may not start before ${lim.earliest}`, true, false, { age });
      if (latest && eMin > hhmmToMin(latest)) add('minor_time_of_day', `Age ${age}: may not work past ${latest}`, true, false, { age });
    }
  }

  // Overtime look-ahead (warnings only).
  const ot = rules?.overtime;
  if (ot?.weeklyHours != null) {
    const ws = weekStartOf(date, workweekStart), we = addDays(ws, 7);
    const inWeek = (s) => { const d = localDate(s.start, tz); return d >= ws && d < we; };
    const total = (end - start) / MIN + others.filter(inWeek).reduce((s, o) => s + (toMs(o.end) - toMs(o.start)) / MIN, 0);
    if (total > ot.weeklyHours * 60) add('overtime_weekly', `Puts ${person.name} at ${fmtH(total)} this week (over ${ot.weeklyHours} h: overtime)`, false);
    else if (total > (ot.weeklyHours - 4) * 60) add('overtime_approaching', `Puts ${person.name} at ${fmtH(total)} this week (overtime after ${ot.weeklyHours} h)`, false);
  }
  if (ot?.dailyHours != null && (end - start) / MIN > ot.dailyHours * 60) add('overtime_daily', `Shift is over ${ot.dailyHours} h (daily overtime)`, false);
  return problems;
}

export const isBlocked = (problems) => problems.some((p) => p.blocking);
export const unforceable = (problems) => problems.filter((p) => p.blocking && !p.forceable);
