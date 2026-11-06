// Pay runs: earnings from punches (rates by position and date, differentials, overtime at the blended regular rate,
// paid time off, holidays, retro pay, reimbursements), taxes, labor allocation, finalizing, the NACHA file, pay stubs
// and the GL journal. A run is finalized only when that year's tax and labor tables are verified.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { payLine } from '../lib/pay.mjs';
import { buildNacha } from '../lib/nacha.mjs';
import { pairPunches } from '../lib/rules.mjs';
import { addDays, dayNum, localDate, localMinuteOfDay, weekday, zonedToUtc, iso, ageOn } from '../lib/time.mjs';
import { simplePdf } from '../lib/pdf.mjs';
import { toCsv } from '../lib/csv.mjs';
import { rateFor, rowToDiff, diffApplies, depositAccounts, splitNet } from './paystructure.mjs';
import { allocationFor, DEFAULT_GL } from './orgstructure.mjs';
import { policiesFor, balance, accrualFor, postAccruals, holidaysFor, ptoInPeriod } from './leave.mjs';
import { sha256, canonical } from '../lib/vault.mjs';
import { byName } from '../db.mjs';

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const $ = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);
const hrs = (min) => +(min / 60).toFixed(2);
export const PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

/**
 * What a pay-run approval is given for: a hash of the period, every line (pay, taxes, hours, earnings, accounts it
 * goes to), each person's direct deposit destinations (routing, account, type and the amount to each) and the totals.
 * Timecard sign-off and time-off balances aren't part of it. Finalizing recomputes the run and refuses when this
 * differs from the approved one, so a deposit account changed after approval needs approving again.
 */
export function payrunHash(pr) {
  const deposits = pr.lines.map((l) => [l.personId, (pr.deposits?.get?.(l.personId) ?? []).map((a) => [a.routing, a.account, a.accountType, a.cents])]);
  return sha256(canonical({ period: pr.period, payDate: pr.payDate, totals: pr.totals, lines: pr.lines.map(({ approved, flags, balances, ...l }) => l), deposits }));
}

/** Where a pay run's lines are paid, by person: kept off the JSON a preview returns (full account numbers). */
export const DEPOSITS = Symbol('deposits');
/** A net amount split across a person's deposit accounts: [{ routing, account, accountType, cents }]. */
export function depositSplit(net, accounts) {
  if (!(net > 0) || !accounts?.length) return [];
  return splitNet(net, accounts).map((a) => ({ routing: String(a.routing), account: String(a.account), accountType: a.accountType || 'checking', cents: a.cents }));
}

/** Split an integer total across weights so the parts add up exactly (largest remainder). */
export function apportion(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, x) => a + x, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

/** Tax and labor tables for a year and state, with whether each is verified for exactly that year. */
export function makeTables(sharedDir) {
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  const latest = (code, year) => {
    const exact = read(join(sharedDir, 'tax', `${code}-${year}.json`));
    if (exact) return exact;
    const years = readdirSync(join(sharedDir, 'tax')).map((f) => new RegExp(`^${code}-(\\d{4})\\.json$`).exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
    return years.length ? read(join(sharedDir, 'tax', `${code}-${years.find((y) => y <= year) ?? years.at(-1)}.json`)) : null;
  };
  return function tablesFor(state, year) {
    const us = latest('US', year), st = latest(state, year);
    const laborUs = read(join(sharedDir, 'labor', 'US.json')), laborSt = read(join(sharedDir, 'labor', `${state}.json`));
    const list = [
      { key: 'tax:US', name: `Federal tax tables ${year}`, year: us?.year ?? null, verified: !!us?.verified && us.year === year, missing: !us, note: us?.note ?? null },
      { key: `tax:${state}`, name: `${st?.label || state} tax tables ${year}`, year: st?.year ?? null, verified: !!st?.verified && st.year === year, missing: !st, note: st?.note ?? `No ${state} tax table yet.` },
      { key: 'labor:US', name: 'Labor rules (federal)', verified: laborUs?.verifiedFor === year, missing: !laborUs, note: null },
      { key: `labor:${state}`, name: `Labor rules (${state})`, verified: laborSt?.verifiedFor === year, missing: !laborSt, note: laborSt ? null : `No ${state} labor table yet.` },
    ];
    return { us, state: st, list, verified: list.every((t) => t.verified) };
  };
}

export function registerRun(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, approvals, now, iso: isoNow, today } = c;
  const tablesFor = c.tablesFor;

  const differentials = (orgId) => h.all('SELECT * FROM differentials WHERE org_id = ? AND active = 1', orgId).map(rowToDiff);
  const defaultEntity = (orgId) => h.get('SELECT id FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC, name LIMIT 1', orgId)?.id ?? null;

  /** Worked time split into segments by date, shift and position, with rates and differential pay. */
  function segmentsFor(org, person, period) {
    const tz = org.tz;
    const from = zonedToUtc(addDays(period.start, -1), '00:00', tz), to = zonedToUtc(addDays(period.end, 2), '00:00', tz);
    const punches = h.all('SELECT * FROM punches WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at', person.id, iso(from), iso(to)).map((p) => ({ id: p.id, type: p.type, at: p.at, shiftId: p.shift_id }));
    const { pairs } = pairPunches(punches, { now: now() });
    const shiftPos = new Map(h.all('SELECT id, position_id FROM shifts WHERE person_id = ? AND start >= ? AND start < ?', person.id, iso(from - 86400000), iso(to)).map((s) => [s.id, s.position_id]));
    const diffs = differentials(org.id);
    const map = new Map();
    for (const pr of pairs) {
      const shiftId = pr.in.shiftId ?? pr.out.shiftId ?? null;
      const positionId = (shiftId && shiftPos.get(shiftId)) || person.positions[0] || null;
      const n = Math.max(0, Math.round((pr.end - pr.start) / 60000));
      for (let i = 0; i < n; i++) {
        const ms = pr.start + i * 60000;
        const date = localDate(ms, tz);
        if (date < period.start || date > period.end) continue;
        const key = `${date}|${shiftId}|${positionId}`;
        let s = map.get(key);
        if (!s) map.set(key, (s = { date, shiftId, positionId, minutes: 0, diffMin: {} }));
        s.minutes++;
        if (diffs.length) {
          const dow = weekday(date), mod = localMinuteOfDay(ms, tz);
          for (const d of diffs) if (diffApplies(d, dow, mod, positionId)) s.diffMin[d.id] = (s.diffMin[d.id] || 0) + 1;
        }
      }
    }
    const segs = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const s of segs) {
      const r = rateFor(h, person, s.positionId, s.date);
      s.rateCents = r?.cents ?? 0;
      s.rateKind = r?.kind ?? 'hourly';
      s.positionRate = !!r?.positionRate;
      s.diffCents = 0;
      s.diffs = [];
      for (const [id, min] of Object.entries(s.diffMin)) {
        const d = diffs.find((x) => x.id === id);
        const cents = d.kind === 'per_hour' ? (d.amount * min) / 60 : (s.rateCents * d.amount / 100 * min) / 60;
        s.diffCents += cents;
        s.diffs.push({ id, name: d.name, minutes: min, cents: Math.round(cents) });
      }
      s.diffCents = Math.round(s.diffCents);
      delete s.diffMin;
    }
    return segs;
  }

  /** YTD gross before this period: opening YTD (imported or entered) plus finalized runs this year. */
  function ytdFor(person, year, beforeStart) {
    const opening = person.ytdYear == null || person.ytdYear === year ? person.ytdWagesCents || 0 : 0;
    // (Pay amounts are sealed in the database, so they're added up here rather than in SQL.)
    const fin = h.all(`SELECT l.gross FROM payrun_lines l JOIN payruns r ON r.id = l.run_id WHERE l.person_id = ? AND r.status = 'finalized' AND substr(r.pay_date,1,4) = ? AND r.period_start < ?`, person.id, String(year), beforeStart).reduce((t, r) => t + (Number(r.gross) || 0), 0);
    return opening + fin;
  }
  c.ytdFor = ytdFor;

  function lineFor(org, person, period, ctx) {
    const tc = c.computeTimecard(org, person, period);
    const rules = ctx.rules, mult = rules.overtime?.multiplier ?? 1.5;
    const segs = segmentsFor(org, person, period);
    const totalMin = segs.reduce((a, s) => a + s.minutes, 0);
    // Overtime minutes per day, spread over that day's segments.
    const otByDate = new Map(tc.days.map((d) => [d.date, d.overtimeMin]));
    for (const [date, ot] of otByDate) {
      const ds = segs.filter((s) => s.date === date);
      apportion(Math.min(ot, ds.reduce((a, s) => a + s.minutes, 0)), ds.map((s) => s.minutes)).forEach((v, i) => (ds[i].otMin = v));
    }
    for (const s of segs) s.otMin ??= 0;
    const otMin = segs.reduce((a, s) => a + s.otMin, 0);
    const base = rateFor(h, person, null, period.end);
    const salaried = base?.kind === 'salary';
    const earnings = [];
    let regularRate = 0;
    if (salaried) {
      const ppy = PERIODS_PER_YEAR[org.payFrequency] || 26;
      let cents = Math.round(base.cents / ppy);
      const startD = person.hireDate && person.hireDate > period.start ? person.hireDate : period.start;
      const endD = person.termDate && person.termDate < period.end ? person.termDate : period.end;
      const days = Math.max(0, dayNum(endD) - dayNum(startD) + 1), all = dayNum(period.end) - dayNum(period.start) + 1;
      const ex = [`Salary ${$(base.cents)} a year / ${ppy} periods = ${$(cents)}`];
      if (days < all) { const was = cents; cents = Math.round((cents * days) / all); ex.push(`Employed ${days} of ${all} days this period: ${$(was)} x ${days}/${all} = ${$(cents)}`); }
      earnings.push({ code: 'salary', label: 'Salary', cents, hours: hrs(totalMin), explain: ex });
    } else if (totalMin > 0) {
      const byRate = new Map();
      for (const s of segs) byRate.set(s.rateCents, (byRate.get(s.rateCents) || 0) + s.minutes);
      const straight = [...byRate].reduce((a, [r, m]) => a + Math.round((m * r) / 60), 0);
      earnings.push({ code: 'regular', label: 'Hours worked', cents: straight, hours: hrs(totalMin), explain: [...byRate].map(([r, m]) => `Hours worked: ${hrs(m)} h x ${$(r)} = ${$(Math.round((m * r) / 60))}`) });
      const diff = segs.reduce((a, s) => a + s.diffCents, 0);
      if (diff) {
        const byDiff = new Map();
        for (const s of segs) for (const d of s.diffs) { const x = byDiff.get(d.name) || { min: 0, cents: 0 }; x.min += d.minutes; x.cents += d.cents; byDiff.set(d.name, x); }
        earnings.push({ code: 'differential', label: 'Shift differentials', cents: diff, hours: hrs([...byDiff.values()].reduce((a, x) => a + x.min, 0)), explain: [...byDiff].map(([n, x]) => `${n}: ${hrs(x.min)} h = ${$(x.cents)}`) });
      }
      regularRate = (straight + diff) / (totalMin / 60);
      if (otMin) {
        const prem = Math.round((otMin / 60) * regularRate * (mult - 1));
        earnings.push({ code: 'overtime', label: `Overtime premium (x${mult})`, cents: prem, hours: hrs(otMin), explain: [`Regular rate = (${$(straight)} + ${$(diff)}) / ${hrs(totalMin)} h = ${$(Math.round(regularRate))}/h`, `Overtime: ${hrs(otMin)} h x ${$(Math.round(regularRate))} x ${(mult - 1).toFixed(2)} premium = ${$(prem)} (straight time already counted above)`] });
      }
      if (tc.totals.restPremiumMin) {
        const rp = Math.round((tc.totals.restPremiumMin / 60) * regularRate);
        earnings.push({ code: 'rest_premium', label: 'Missed rest-break pay', cents: rp, hours: hrs(tc.totals.restPremiumMin), explain: [`${tc.totals.restPremiumMin} min x ${$(Math.round(regularRate))}/h = ${$(rp)}`] });
      }
    }
    // Holidays: paid hours for hourly people employed that day; worked-holiday premium.
    for (const hd of holidaysFor(h, person, org.id, period.start, period.end)) {
      if (person.hireDate && person.hireDate > hd.date) continue;
      if (!salaried && hd.paidHours > 0) {
        const r = rateFor(h, person, null, hd.date)?.cents ?? 0;
        if (r) earnings.push({ code: 'holiday', label: `Holiday: ${hd.name}`, cents: Math.round(hd.paidHours * r), hours: hd.paidHours, explain: [`${hd.name} (${hd.date}): ${hd.paidHours} h x ${$(r)} = ${$(Math.round(hd.paidHours * r))}`] });
      }
      if (hd.premiumMultiplier > 1) {
        const worked = segs.filter((s) => s.date === hd.date);
        const cents = Math.round(worked.reduce((a, s) => a + (s.minutes / 60) * s.rateCents * (hd.premiumMultiplier - 1), 0));
        if (cents) earnings.push({ code: 'holiday_premium', label: `Worked holiday premium: ${hd.name}`, cents, hours: hrs(worked.reduce((a, s) => a + s.minutes, 0)), explain: [`Worked ${hd.name}: x${hd.premiumMultiplier} = ${$(cents)} extra`] });
      }
    }
    // Paid time off taken this period.
    const pto = ptoInPeriod(h, person.id, period);
    for (const t of pto) {
      if (!t.paid || salaried) continue;
      const r = rateFor(h, person, null, period.start)?.cents ?? 0;
      earnings.push({ code: 'pto', label: `Paid time off: ${t.policyName}`, cents: Math.round(t.hours * r), hours: t.hours, explain: [`${t.policyName}: ${t.hours} h x ${$(r)} = ${$(Math.round(t.hours * r))}`] });
    }
    // Retro pay, payouts, bonuses and reimbursements waiting for the next run.
    const extras = h.all(`SELECT * FROM extra_earnings WHERE person_id = ? AND status = 'pending' ORDER BY created_at`, person.id);
    for (const e of extras) earnings.push({ code: e.code, label: e.label, cents: e.cents, hours: e.hours ?? undefined, taxable: !!e.taxable, extraId: e.id, explain: [`${e.label}: ${$(e.cents)}${e.taxable ? '' : ' (not taxed)'}`] });

    if (!earnings.some((e) => e.cents) && totalMin === 0) return null;

    const year = Number(period.end.slice(0, 4));
    const ytd = ytdFor(person, year, period.start);
    const line = payLine({ person, earnings, periodsPerYear: PERIODS_PER_YEAR[org.payFrequency] || 26, ytdWagesCents: ytd, org: { employeeCount: ctx.employeeCount, futaExempt: org.futaExempt, sutaRate: org.sutaRate }, tables: { us: ctx.T.us, state: ctx.T.state } });
    line.unverified = !ctx.T.verified;
    line.hours = { regular: hrs(totalMin - otMin), overtime: hrs(otMin), restPremium: hrs(tc.totals.restPremiumMin), pto: +pto.reduce((a, t) => a + t.hours, 0).toFixed(2) };
    line.rateCents = base?.cents ?? null;
    line.salaried = salaried;
    line.otMultiplier = mult;
    line.earnings = earnings.map(({ explain, ...e }) => e);
    line.segments = segs.map((s) => ({ date: s.date, shiftId: s.shiftId, positionId: s.positionId, minutes: s.minutes, otMin: s.otMin, rateCents: s.rateCents, positionRate: s.positionRate, diffCents: s.diffCents }));
    line.entityId = person.entityId || defaultEntity(org.id);
    line.departmentId = person.departmentId;
    line.ytdBefore = ytd;
    line.approved = !!tc.approved;
    line.flags = tc.flags.filter((f) => ['missed_punch', 'missed_rest', 'late', 'no_show'].includes(f.code)).map((f) => f.code);
    line.tc = tc;
    line.distribution = distribute(person, line, segs, regularRate);
    line.balances = policiesFor(h, person).map((pol) => {
      const posted = h.get('SELECT 1 FROM pto_ledger WHERE person_id = ? AND policy_id = ? AND ref = ?', person.id, pol.id, `accrual:${period.start}`);
      const acc = posted ? null : accrualFor(h, pol, person, period, tc.totals.workedMin);
      const bal = balance(h, person.id, pol.id);
      return { policyId: pol.id, name: pol.name, hours: +(bal + (acc?.hours || 0)).toFixed(2), accrued: acc ? acc.hours : null };
    });
    return line;
  }

  /** Gross (taxable) split across departments / cost centers / programs. */
  function distribute(person, line, segs, regularRate) {
    const parts = [];
    const segCodes = new Set(['regular', 'differential', 'overtime', 'rest_premium', 'holiday_premium']);
    const segCost = line.earnings.filter((e) => segCodes.has(e.code) || (e.code === 'salary' && segs.length)).reduce((a, e) => a + e.cents, 0);
    const other = line.gross - segCost;
    const weights = segs.map((s) => s.minutes * (s.rateCents || regularRate || 1) + s.diffCents * 60 + s.otMin * (regularRate || s.rateCents) * 0.5);
    const segCents = apportion(segCost, weights);
    segs.forEach((s, i) => {
      const alloc = allocationFor(h, person, s.shiftId, s.minutes);
      const cents = apportion(segCents[i], alloc.map((a) => a.share));
      alloc.forEach((a, j) => parts.push({ departmentId: a.departmentId, costCenterId: a.costCenterId, program: a.program, hours: (s.minutes / 60) * a.share, cents: cents[j] }));
    });
    if (other) {
      const alloc = allocationFor(h, person, null, 0);
      apportion(other, alloc.map((a) => a.share)).forEach((cts, j) => parts.push({ departmentId: alloc[j].departmentId, costCenterId: alloc[j].costCenterId, program: alloc[j].program, hours: 0, cents: cts }));
    }
    const merged = new Map();
    for (const p of parts) {
      const k = `${p.departmentId}|${p.costCenterId}|${p.program}`;
      const m = merged.get(k) || { departmentId: p.departmentId, costCenterId: p.costCenterId, program: p.program, hours: 0, cents: 0 };
      m.hours += p.hours; m.cents += p.cents; merged.set(k, m);
    }
    return [...merged.values()].map((m) => ({ ...m, hours: +m.hours.toFixed(2) }));
  }

  /** The whole run for a period (a preview until finalized). */
  function payrun(org, period, { entityId = null } = {}) {
    const year = Number(addDays(period.end, 6).slice(0, 4));
    const T = tablesFor(org.state, year);
    const rules = c.rulesFor(org);
    const all = byName(h.all(`SELECT * FROM people WHERE org_id = ? AND status IN ('active','leave','terminated') AND worker_type = 'employee'`, org.id)).map((r) => c.getPerson(r.id, org.id))
      .filter((p) => p.status !== 'terminated' || (p.termDate && p.termDate >= period.start) || h.get(`SELECT 1 FROM extra_earnings WHERE person_id = ? AND status = 'pending'`, p.id));
    const employeeCount = all.filter((p) => p.status !== 'terminated').length;
    const lines = [], warnings = [], deposits = new Map();
    if (!T.verified) warnings.push({ code: 'unverified_tables', message: `The tax and labor tables haven’t been verified for ${year} yet, so this pay run can be reviewed but not finalized.` });
    if (!T.state) warnings.push({ code: 'no_state_table', message: `There is no ${org.state} tax table, so state taxes aren’t calculated.` });
    if (org.futaExempt) warnings.push({ code: 'futa_exempt', message: 'Org is marked FUTA-exempt (501(c)(3)); FUTA shows $0.' });
    const mw = rules.minimumWage;
    for (const p of all) {
      if (entityId && (p.entityId || defaultEntity(org.id)) !== entityId) continue;
      const line = lineFor(org, p, period, { rules, T, employeeCount });
      if (!line) continue;
      const tc = line.tc; delete line.tc;
      lines.push(line);
      if (!tc.approved && tc.totals.workedMin > 0) warnings.push({ code: 'timecard_not_approved', personId: p.id, message: `${p.name}: timecard not approved` });
      if (tc.flags.some((f) => f.code === 'missed_punch')) warnings.push({ code: 'missed_punch', personId: p.id, message: `${p.name}: missed punch in this period (hours may be short)` });
      if (tc.pendingRequests) warnings.push({ code: 'pending_requests', personId: p.id, message: `${p.name}: ${tc.pendingRequests} punch request(s) still pending` });
      const accts = depositAccounts(vault.openJson(p.depositRaw));
      deposits.set(p.id, depositSplit(line.net, accts));
      if (!accts.length) warnings.push({ code: 'no_deposit', personId: p.id, message: `${p.name}: no direct deposit account (pay by check)` });
      if (!vault.openJson(p.piiRaw)?.ssn) warnings.push({ code: 'no_ssn', personId: p.id, message: `${p.name}: no SSN on file` });
      if (mw?.standard != null && !line.salaried) {
        const age = p.birthdate ? ageOn(p.birthdate, period.end) : 99;
        const floor = Math.round(mw.standard * 100 * (age < 18 && mw.youthDiscountPct ? 1 - mw.youthDiscountPct / 100 : 1));
        const low = line.segments.filter((s) => s.rateCents < floor);
        if (low.length) warnings.push({ code: 'below_minimum_wage', personId: p.id, message: `${p.name}: $${(Math.min(...low.map((s) => s.rateCents)) / 100).toFixed(2)}/h is below the $${(floor / 100).toFixed(2)} minimum` });
      }
    }
    const sum = (f) => lines.reduce((s, l) => s + f(l), 0);
    const totals = { gross: sum((l) => l.gross), withheld: sum((l) => l.withheld), net: sum((l) => l.net), employer: sum((l) => l.employerTotal), nonTaxable: sum((l) => l.nonTaxable || 0), regularHours: +sum((l) => l.hours.regular).toFixed(2), overtimeHours: +sum((l) => l.hours.overtime).toFixed(2), people: lines.length };
    const finalized = h.get(`SELECT * FROM payruns WHERE org_id = ? AND period_start = ? AND status = 'finalized'`, org.id, period.start);
    const needsApproval = approvals.configured(org.id, 'payrun');
    const ap = needsApproval ? approvals.find(org.id, 'payrun', `${org.id}:${period.start}`) : null;
    const blockers = [];
    if (!T.verified) blockers.push(`The ${year} tax and labor tables aren’t verified.`);
    const unapproved = lines.filter((l) => !l.approved && l.hours.regular + l.hours.overtime > 0);
    if (unapproved.length) blockers.push(`${unapproved.length} timecard(s) aren’t approved.`);
    if (needsApproval && ap?.status !== 'approved') blockers.push(ap ? 'The pay run approval isn’t finished.' : 'The pay run needs approval first.');
    const hash = payrunHash({ period, payDate: addDays(period.end, 6), totals, lines, deposits });
    const changedSinceApproval = needsApproval && ap?.status === 'approved' && ap.bindHash !== hash;
    if (changedSinceApproval) blockers.push('The pay run changed after approval (hours, rates, earnings, deposit accounts or people are different now), so it needs approving again. Submit it for approval again.');
    if (finalized) blockers.push('This period is already finalized.');
    return {
      [DEPOSITS]: deposits,
      period, payDate: addDays(period.end, 6), units: 'cents', year, unverified: !T.verified, tablesVerified: T.verified, canFinalize: blockers.length === 0, blockers,
      tables: T.list, lines, totals, warnings, finalized: finalized ? { id: finalized.id, at: finalized.finalized_at, by: finalized.finalized_by } : null,
      approval: ap ? { id: ap.id, status: ap.status, changedSinceApproval } : null, needsApproval, hash,
    };
  }
  c.payrun = payrun;

  /**
   * Lines of a finalized run, or the live preview when the period isn't finalized. deposits: where each line is paid,
   * by person; for a finalized run, the destinations sealed with it when it was finalized (never today's accounts).
   */
  function runLines(org, period) {
    const run = h.get(`SELECT * FROM payruns WHERE org_id = ? AND period_start = ? AND status = 'finalized'`, org.id, period.start);
    if (run) {
      const rows = h.all('SELECT person_id, detail, deposits FROM payrun_lines WHERE run_id = ?', run.id);
      return { run, lines: rows.map((l) => J(l.detail, {})), deposits: new Map(rows.map((l) => [l.person_id, l.deposits == null ? null : J(l.deposits, null)])), payDate: run.pay_date, finalized: true };
    }
    const pr = payrun(org, period);
    return { run: null, lines: pr.lines, deposits: pr[DEPOSITS], payDate: pr.payDate, finalized: false };
  }
  c.runLines = runLines;

  route('GET', '/v1/payrun/preview', ({ me, org, query }) => {
    need(me, 'payroll');
    const pr = payrun(org, c.parsePeriod(org, query.periodStart, c.lastCompleted(org)), { entityId: query.entityId || null });
    return pr;
  });

  route('POST', '/v1/payrun/submit', ({ me, org, body }) => {
    need(me, 'payroll');
    const period = c.parsePeriod(org, V.date(body.periodStart, 'periodStart'), null);
    const existing = approvals.find(org.id, 'payrun', `${org.id}:${period.start}`);
    const pr = payrun(org, period);
    // An approval for a run that has changed since is set aside; the run as it is now is submitted instead.
    if (existing && (existing.status !== 'approved' || existing.bindHash === pr.hash)) throw new HttpError(409, `already ${existing.status}`, { approval: existing });
    if (existing) { h.run(`UPDATE approval_requests SET status = 'superseded', decided_at = ? WHERE id = ?`, isoNow(now()), existing.id); audit(org.id, me.id, 'approval_superseded', existing.id, { kind: 'payrun', reason: 'the pay run changed after approval' }); }
    const ap = approvals.start({ orgId: org.id, kind: 'payrun', targetId: `${org.id}:${period.start}`, requestedBy: me.id, amountCents: pr.totals.gross, title: `Pay run ${period.start} to ${period.end}: ${$(pr.totals.gross)} gross, ${pr.totals.people} people`, detail: { totals: pr.totals }, bindHash: pr.hash });
    return { status: 201, body: { approval: ap } };
  });

  route('POST', '/v1/payrun/finalize', ({ me, org, body }) => {
    need(me, 'payroll');
    const period = c.parsePeriod(org, V.date(body.periodStart, 'periodStart'), null);
    const pr = payrun(org, period);
    // The payroll safety rule: never finalize on tables that aren't verified for the year.
    if (!pr.tablesVerified) throw new HttpError(409, `The tax and labor tables for ${pr.year} aren’t verified, so this pay run can’t be finalized.`, { blockers: pr.blockers, tables: pr.tables });
    if (!pr.canFinalize) throw new HttpError(409, pr.blockers.join(' '), { blockers: pr.blockers, changedSinceApproval: !!pr.approval?.changedSinceApproval });
    const id = uid('run');
    const people = h.all(`SELECT * FROM people WHERE org_id = ? AND status IN ('active','leave')`, org.id).map((r) => c.getPerson(r.id, org.id));
    h.tx(() => {
      h.run(`INSERT INTO payruns (id,org_id,period_start,period_end,pay_date,status,finalized_by,finalized_at,totals,tables,approval_id) VALUES (?,?,?,?,?,'finalized',?,?,?,?,?)`,
        id, org.id, period.start, period.end, pr.payDate, me.id, isoNow(now()), JSON.stringify(pr.totals), JSON.stringify(pr.tables), pr.approval?.id ?? null);
      for (const l of pr.lines) {
        // The deposit destinations the approval covered are sealed with the line; the bank file is built from them.
        h.run('INSERT INTO payrun_lines (run_id,person_id,entity_id,gross,net,withheld,employer_total,detail,deposits) VALUES (?,?,?,?,?,?,?,?,?)', id, l.personId, l.entityId, l.gross, l.net, l.withheld, l.employerTotal, JSON.stringify(l), JSON.stringify(pr[DEPOSITS].get(l.personId) ?? []));
        for (const e of l.earnings) if (e.extraId) h.run(`UPDATE extra_earnings SET status = 'paid', paid_run_id = ? WHERE id = ?`, id, e.extraId);
      }
      h.run(`UPDATE expenses SET status = 'reimbursed' WHERE earning_id IN (SELECT id FROM extra_earnings WHERE paid_run_id = ?)`, id);
      const worked = new Map(pr.lines.map((l) => [l.personId, Math.round((l.hours.regular + l.hours.overtime) * 60)]));
      postAccruals(h, people, period, worked, isoNow(now()));
    });
    audit(org.id, me.id, 'payrun_finalize', id, { period: period.start, totals: pr.totals });
    return { status: 201, body: { run: { id, period, payDate: pr.payDate, totals: pr.totals } } };
  });

  route('GET', '/v1/payruns', ({ me, org }) => {
    need(me, 'payroll');
    return { runs: h.all('SELECT * FROM payruns WHERE org_id = ? ORDER BY period_start DESC', org.id).map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, payDate: r.pay_date, status: r.status, finalizedAt: r.finalized_at, finalizedBy: r.finalized_by, totals: J(r.totals, {}) })) };
  });

  // ---------- NACHA (for the org's own bank; KeaS never sends payments) ----------
  route('GET', '/v1/payrun/nacha', ({ me, org, query }) => {
    need(me, 'payroll');
    const period = c.parsePeriod(org, query.periodStart, c.lastCompleted(org));
    const { lines, deposits, payDate, finalized } = runLines(org, period);
    // With a pay-run approval set up, a bank file only comes from the finalized run that approval covered.
    if (!finalized && approvals.configured(org.id, 'payrun')) throw new HttpError(409, 'Pay runs here need approval, so the bank file is available once this run is approved and finalized.');
    const entityId = query.entityId || null;
    const ent = entityId ? h.get('SELECT * FROM legal_entities WHERE id = ? AND org_id = ?', entityId, org.id) : h.get('SELECT * FROM legal_entities WHERE org_id = ? AND bank_enc IS NOT NULL ORDER BY is_default DESC LIMIT 1', org.id);
    if (entityId && !ent) throw new HttpError(404, 'entity not found');
    const bank = (ent?.bank_enc && vault.openJson(ent.bank_enc)) || vault.openJson(org.bankRaw) || {};
    if (!bank.originRouting) throw new HttpError(409, 'Add the company bank details (Org structure → legal entity) first.');
    const entries = [], skipped = [];
    for (const l of lines) {
      if (ent && entityId && l.entityId !== ent.id) continue;
      if (l.net <= 0) continue;
      // A finalized run pays the accounts sealed with it (what was approved); today's deposit settings never count.
      const split = deposits.get(l.personId);
      if (split == null) { skipped.push({ personId: l.personId, name: l.name, reason: finalized ? 'this run was finalized before KeaS kept its deposit accounts with it: pay by check or build the bank file by hand' : 'no deposit account' }); continue; }
      if (!split.length) { skipped.push({ personId: l.personId, name: l.name, reason: 'no deposit account' }); continue; }
      const sum = split.reduce((a, x) => a + x.cents, 0);
      if (sum !== l.net) { skipped.push({ personId: l.personId, name: l.name, reason: 'the stored deposit amounts don’t add up to the net pay' }); continue; }
      for (const a of split) entries.push({ name: l.name, id: l.personId, routing: a.routing, account: a.account, accountType: a.accountType, amountCents: a.cents });
    }
    const file = buildNacha({ company: { name: bank.name || org.name, id: bank.companyId, originRouting: bank.originRouting, destinationRouting: bank.destinationRouting || bank.originRouting, destinationName: bank.destinationName || '' }, entries, effectiveDate: new Date(payDate + 'T12:00:00Z'), now: new Date(now()) });
    audit(org.id, me.id, 'nacha_file', period.start, { entries: file.entryCount, finalized });
    return { text: file.text, note: 'Upload this file to your bank. KeaS doesn’t send payments.', filename: `payroll-${period.start}.ach`, period, entryCount: file.entryCount, totalCreditCents: file.totalCreditCents, skipped, finalized, unverified: !finalized, canFinalize: false };
  });

  // ---------- pay stubs ----------
  function stub(org, period, personId) {
    const { lines, payDate, finalized } = runLines(org, period);
    const l = lines.find((x) => x.personId === personId);
    if (!l) throw new HttpError(404, 'no pay for this person in that period');
    const year = payDate.slice(0, 4);
    const ytd = {};
    const add = (code, cents) => (ytd[code] = (ytd[code] || 0) + cents);
    for (const r of h.all(`SELECT l.detail FROM payrun_lines l JOIN payruns r ON r.id = l.run_id WHERE l.person_id = ? AND r.status = 'finalized' AND substr(r.pay_date,1,4) = ? AND r.period_start <= ?`, personId, year, period.start)) {
      const d = J(r.detail, {});
      add('gross', d.gross); add('net', d.net);
      for (const t of d.taxes || []) add(t.code, t.cents);
    }
    // (Amounts are sealed, so they're added up here rather than in SQL.)
    for (const r of h.all('SELECT id, code, cents FROM ytd_imports WHERE person_id = ? AND year = ?', personId, Number(year))) add(r.code, Number(r.cents) || 0);
    if (!finalized) { add('gross', l.gross); add('net', l.net); for (const t of l.taxes) add(t.code, t.cents); }
    const person = c.getPerson(personId, org.id);
    return { org: { name: org.name }, person: { id: person.id, name: person.name, employeeNumber: person.employeeNumber }, period, payDate, finalized, line: l, ytd, balances: l.balances || [] };
  }
  route('GET', '/v1/payrun/stub', ({ me, org, query }) => {
    const personId = V.id(query.personId ?? me.id, 'personId');
    const period = c.parsePeriod(org, query.periodStart, c.lastCompleted(org));
    if (personId !== me.id) need(me, 'payroll');
    else if (!c.has(me, 'payroll') && !h.get(`SELECT 1 FROM payruns WHERE org_id = ? AND period_start = ? AND status = 'finalized'`, org.id, period.start)) throw new HttpError(404, 'no finalized pay for that period');
    const s = stub(org, period, personId);
    if (query.format === 'pdf') return { raw: { type: 'application/pdf', filename: `paystub-${personId}-${period.start}.pdf`, body: stubPdf(s) } };
    return { stub: s };
  });

  // ---------- GL journal ----------
  function glRows(org, period) {
    const { lines, payDate } = runLines(org, period);
    const gl = { ...DEFAULT_GL, ...(org.settings.glAccounts || {}) };
    const dn = new Map(h.all('SELECT id, code, name FROM departments WHERE org_id = ?', org.id).map((d) => [d.id, d.code || d.name]));
    const cn = new Map(h.all('SELECT id, code, gl_segment FROM cost_centers WHERE org_id = ?', org.id).map((x) => [x.id, x.gl_segment || x.code]));
    const en = new Map(h.all('SELECT id, name FROM legal_entities WHERE org_id = ?', org.id).map((x) => [x.id, x.name]));
    const acc = new Map();
    const put = (entity, account, dept, cc, program, debit, credit, memo) => {
      const k = [entity, account, dept, cc, program, memo].join('|');
      const r = acc.get(k) || { date: payDate, entity: en.get(entity) || '', account, department: dn.get(dept) || '', costCenter: cn.get(cc) || '', program: program || '', debit: 0, credit: 0, memo };
      r.debit += debit; r.credit += credit; acc.set(k, r);
    };
    for (const l of lines) {
      const dist = l.distribution?.length ? l.distribution : [{ departmentId: l.departmentId, costCenterId: null, program: null, cents: l.gross }];
      for (const d of dist) put(l.entityId, gl.wagesExpense, d.departmentId, d.costCenterId, d.program, d.cents, 0, 'Wages');
      const er = apportion(l.employerTotal, dist.map((d) => d.cents));
      dist.forEach((d, i) => er[i] && put(l.entityId, gl.employerTaxExpense, d.departmentId, d.costCenterId, d.program, er[i], 0, 'Employer payroll taxes'));
      if (l.nonTaxable) put(l.entityId, gl.reimbursementExpense, l.departmentId, null, null, l.nonTaxable, 0, 'Reimbursements');
      put(l.entityId, gl.taxesPayable, null, null, null, 0, l.withheld + l.employerTotal, 'Payroll taxes payable');
      put(l.entityId, gl.netPayClearing, null, null, null, 0, l.net, 'Net pay');
    }
    return [...acc.values()].filter((r) => r.debit || r.credit);
  }
  c.glRows = glRows;
  route('GET', '/v1/payrun/gl', ({ me, org, query }) => {
    need(me, 'payroll');
    const period = c.parsePeriod(org, query.periodStart, c.lastCompleted(org));
    const rows = glRows(org, period);
    const debit = rows.reduce((a, r) => a + r.debit, 0), credit = rows.reduce((a, r) => a + r.credit, 0);
    if (query.format === 'csv') {
      const headers = ['date', 'entity', 'account', 'department', 'costCenter', 'program', 'debit', 'credit', 'memo'];
      return { raw: { type: 'text/csv; charset=utf-8', filename: `gl-${period.start}.csv`, body: toCsv(headers, rows.map((r) => ({ ...r, debit: (r.debit / 100).toFixed(2), credit: (r.credit / 100).toFixed(2) }))) } };
    }
    return { period, rows, totals: { debit, credit, balanced: debit === credit } };
  });
}

function stubPdf(s) {
  const L = [];
  const m = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  L.push({ text: s.org.name, size: 16, bold: true });
  L.push({ text: `Pay statement for ${s.person.name}${s.person.employeeNumber ? ` (#${s.person.employeeNumber})` : ''}`, size: 11 });
  L.push({ text: `Period ${s.period.start} to ${s.period.end} - pay date ${s.payDate}${s.finalized ? '' : ' - preview, not final'}`, size: 9, gap: 2 });
  L.push({ text: 'Earnings', bold: true, gap: 8, rule: true, right: 'Amount' });
  for (const e of s.line.earnings) L.push({ text: `${e.label}${e.hours ? `   ${e.hours} h` : ''}`, right: m(e.cents) });
  L.push({ text: 'Gross pay', bold: true, right: m(s.line.gross) });
  L.push({ text: 'Taxes withheld', bold: true, gap: 8, rule: true, right: 'This period / Year to date' });
  for (const t of s.line.taxes) L.push({ text: t.label, right: `${m(t.cents)} / ${m(s.ytd[t.code] || 0)}` });
  L.push({ text: 'Net pay', bold: true, size: 12, gap: 6, right: m(s.line.net) });
  L.push({ text: `Year to date: gross ${m(s.ytd.gross || 0)}, net ${m(s.ytd.net || 0)}`, size: 9 });
  if (s.balances.length) {
    L.push({ text: 'Time off balances', bold: true, gap: 8, rule: true, right: 'Hours' });
    for (const b of s.balances) L.push({ text: `${b.name}${b.accrued ? ` (+${b.accrued} this period)` : ''}`, right: String(b.hours) });
  }
  L.push({ text: 'Employer taxes (not taken from your pay)', bold: true, gap: 8, rule: true });
  for (const t of s.line.employer) L.push({ text: t.label, right: m(t.cents) });
  return simplePdf({ title: `Pay statement ${s.period.start}`, lines: L });
}
