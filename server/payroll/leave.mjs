// Time off and leave: accrual policies, balances (a ledger), time-off requests through approvals, holiday calendars,
// and FMLA / state leave cases. Eligibility is shown as facts; a person makes the leave decision.
import { addDays, dayNum, localDate } from '../lib/time.mjs';
import { byName } from '../db.mjs';
import { pairPunches } from '../lib/rules.mjs';

export const rowToPolicy = (r) => ({
  id: r.id, name: r.name, kind: r.kind, method: r.method, accrueHours: r.accrue_hours, perHours: r.per_hours, perPeriodHours: r.per_period_hours,
  annualHours: r.annual_hours, capHours: r.cap_hours, annualMaxHours: r.annual_max_hours, carryoverMax: r.carryover_max, waitingDays: r.waiting_days,
  allowNegative: !!r.allow_negative, payoutOnTerm: r.payout_on_term, protected: !!r.protected, paid: !!r.paid, autoEnroll: !!r.auto_enroll, active: !!r.active,
});
const rowToRequest = (r) => ({ id: r.id, personId: r.person_id, policyId: r.policy_id, startDate: r.start_date, endDate: r.end_date, hours: r.hours, note: r.note, status: r.status, approvalId: r.approval_id, leaveCaseId: r.leave_case_id, createdAt: r.created_at });
// A leave case's reason and notes are often medical: payroll and the owner see them; managers see dates and status.
const caseFor = (me, has) => (r) => (has(me, 'payroll') ? r : { ...r, reason: null, notes: null, restricted: true });
const rowToCase = (r) => ({ id: r.id, personId: r.person_id, law: r.law, reason: r.reason, startDate: r.start_date, endDate: r.end_date, intermittent: !!r.intermittent, entitlementHours: r.entitlement_hours, status: r.status, notes: r.notes, eligibility: r.eligibility ? JSON.parse(r.eligibility) : null, createdAt: r.created_at });
const r2 = (x) => Math.round(x * 100) / 100;
export const METHODS = ['per_hour_worked', 'per_period', 'annual_grant', 'none'];

/**
 * A sick-leave policy suggested from the location's law (the merged labor rules' sickLeave): accrual per hours worked,
 * the yearly cap, balance cap, carryover and waiting period the law allows. Only a starting point: the labor files
 * aren't verified, and the law often depends on the employer's size, so the owner checks and edits it before saving.
 * null when KeaS knows no sick-leave law for the place.
 */
export function suggestSickPolicy(rules) {
  const s = rules?.sickLeave;
  if (!s || !(s.accrueHoursPer > 0)) return null;
  const notes = [s.note, 'A suggestion from KeaS’s labor tables, which aren’t verified: check it against the law (and any city or county rule) before you save it.'].filter(Boolean);
  return {
    name: s.law ? `Paid sick leave (${s.law})` : 'Paid sick leave', kind: 'sick', method: 'per_hour_worked', accrueHours: 1, perHours: s.accrueHoursPer,
    annualMaxHours: s.cap ?? null, capHours: s.balanceCap ?? null, carryoverMax: s.carryoverCap ?? null, waitingDays: 0,
    // (A waiting period limits when sick time can be used, not when it accrues, so it's noted rather than set.)
    useWaitingDays: s.waitingDays ?? null, frontloadHours: s.frontloadHours ?? null,
    protected: true, payoutOnTerm: 'never', paid: true, autoEnroll: true, active: true,
    why: `1 hour per ${s.accrueHoursPer} hours worked${s.cap != null ? `, up to ${s.cap} hours (${s.capKind || 'a year'})` : ''}${s.balanceCap != null ? `, balance up to ${s.balanceCap} hours` : ''}${s.carryoverCap != null ? `, ${s.carryoverCap} hours carry over` : ''}.`,
    notes, employerSize: s.employerSize ?? null, from: s.from ?? null, needsChecking: true,
  };
}

export function balance(h, personId, policyId, asOf = '9999-12-31') {
  return r2(h.get('SELECT COALESCE(SUM(hours),0) AS b FROM pto_ledger WHERE person_id = ? AND policy_id = ? AND date <= ?', personId, policyId, asOf).b);
}
export function policiesFor(h, person) {
  return h.all(`SELECT p.*, e.start_date AS enrolled FROM pto_policies p JOIN pto_enrollments e ON e.policy_id = p.id WHERE e.person_id = ? AND p.active = 1 ORDER BY p.name`, person.id)
    .map((r) => ({ ...rowToPolicy(r), enrolled: r.enrolled }));
}

/**
 * Hours a policy accrues for one person in one pay period.
 * workedMin: minutes worked in the period. Returns { hours, explain[] } after caps.
 */
export function accrualFor(h, policy, person, period, workedMin) {
  const ex = [];
  if (policy.method === 'none') return { hours: 0, explain: ['No accrual (balance set by hand)'] };
  const startOk = addDays(policy.enrolled || person.hireDate || period.start, policy.waitingDays || 0);
  if (startOk > period.end) return { hours: 0, explain: [`Accrual starts ${startOk} (waiting period)`] };
  let hours = 0;
  if (policy.method === 'per_hour_worked') {
    if (!(policy.perHours > 0)) return { hours: 0, explain: ['Policy has no accrual rate'] };
    hours = (workedMin / 60) * (policy.accrueHours / policy.perHours);
    ex.push(`${r2(workedMin / 60)} h worked x ${policy.accrueHours} h per ${policy.perHours} h = ${r2(hours)} h`);
  } else if (policy.method === 'per_period') {
    hours = policy.perPeriodHours;
    ex.push(`${policy.perPeriodHours} h per pay period`);
  } else if (policy.method === 'annual_grant') {
    const years = new Set([period.start.slice(0, 4), period.end.slice(0, 4)]);
    for (const y of years) if (`${y}-01-01` >= period.start && `${y}-01-01` <= period.end) hours += policy.annualHours;
    if (!hours && policy.enrolled >= period.start && policy.enrolled <= period.end) hours = policy.annualHours;
    ex.push(hours ? `Yearly grant of ${policy.annualHours} h` : 'Yearly grant is given at the start of the year');
  }
  const year = period.end.slice(0, 4);
  if (policy.annualMaxHours != null) {
    const ytd = h.get(`SELECT COALESCE(SUM(hours),0) AS s FROM pto_ledger WHERE person_id = ? AND policy_id = ? AND kind = 'accrual' AND substr(date,1,4) = ? AND IFNULL(ref,'') != ?`, person.id, policy.id, year, `accrual:${period.start}`).s;
    if (ytd + hours > policy.annualMaxHours) { const was = hours; hours = Math.max(0, policy.annualMaxHours - ytd); ex.push(`Capped at ${policy.annualMaxHours} h a year (${r2(ytd)} h already): ${r2(was)} -> ${r2(hours)} h`); }
  }
  if (policy.capHours != null) {
    const bal = h.get(`SELECT COALESCE(SUM(hours),0) AS b FROM pto_ledger WHERE person_id = ? AND policy_id = ? AND IFNULL(ref,'') != ?`, person.id, policy.id, `accrual:${period.start}`).b;
    if (bal + hours > policy.capHours) { const was = hours; hours = Math.max(0, policy.capHours - bal); ex.push(`Balance cap ${policy.capHours} h (balance ${r2(bal)} h): ${r2(was)} -> ${r2(hours)} h`); }
  }
  return { hours: r2(hours), explain: ex };
}

/** Year-end carryover limits, applied once per year when the first accrual of a new year posts. */
function applyCarryover(h, policy, personId, year, nowIso) {
  if (policy.carryoverMax == null) return;
  const ref = `carryover:${year}`;
  if (h.get('SELECT 1 FROM pto_ledger WHERE person_id = ? AND policy_id = ? AND ref = ?', personId, policy.id, ref)) return;
  const bal = balance(h, personId, policy.id, `${year - 1}-12-31`);
  if (bal > policy.carryoverMax) h.run(`INSERT INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, personId, policy.id, `${year}-01-01`, r2(policy.carryoverMax - bal), 'carryover', ref, `Carryover limit ${policy.carryoverMax} h`, 'system', nowIso);
}

/** Post a period's accruals (idempotent per person, policy and period). */
export function postAccruals(h, people, period, workedMinBy, nowIso) {
  let n = 0;
  for (const person of people) {
    for (const pol of policiesFor(h, person)) {
      applyCarryover(h, pol, person.id, Number(period.end.slice(0, 4)), nowIso);
      const a = accrualFor(h, pol, person, period, workedMinBy.get(person.id) || 0);
      if (a.hours <= 0) continue;
      const r = h.run(`INSERT OR IGNORE INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, person.id, pol.id, period.end, a.hours, 'accrual', `accrual:${period.start}`, a.explain.join('; '), 'system', nowIso);
      n += Number(r.changes);
    }
  }
  return n;
}

/** Holidays that apply to a person between two dates. */
export function holidaysFor(h, person, orgId, from, to) {
  const cal = person.holidayCalendarId || h.get('SELECT id FROM holiday_calendars WHERE org_id = ? AND is_default = 1', orgId)?.id;
  if (!cal) return [];
  return h.all('SELECT * FROM holidays WHERE calendar_id = ? AND date >= ? AND date <= ? ORDER BY date', cal, from, to).map((x) => ({ id: x.id, date: x.date, name: x.name, paidHours: x.paid_hours, premiumMultiplier: x.premium_multiplier }));
}

/** Approved paid time off falling in a period, spread evenly over the request's days. */
export function ptoInPeriod(h, personId, period) {
  const rows = h.all(`SELECT r.*, p.name AS policy_name, p.paid, p.kind AS policy_kind FROM time_off_requests r JOIN pto_policies p ON p.id = r.policy_id WHERE r.person_id = ? AND r.status = 'approved' AND r.start_date <= ? AND r.end_date >= ?`, personId, period.end, period.start);
  const out = [];
  for (const r of rows) {
    const days = dayNum(r.end_date) - dayNum(r.start_date) + 1;
    let inside = 0;
    for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) if (d >= period.start && d <= period.end) inside++;
    if (inside) out.push({ requestId: r.id, policyId: r.policy_id, policyName: r.policy_name, kind: r.policy_kind, paid: !!r.paid, hours: r2((r.hours * inside) / days) });
  }
  return out;
}

export function registerLeave(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, approvals, now, iso, today } = c;
  const getPolicy = (id, orgId) => { const r = h.get('SELECT * FROM pto_policies WHERE id = ? AND org_id = ?', id, orgId); if (!r) throw new HttpError(404, 'policy not found'); return rowToPolicy(r); };
  const num = (v, name, { optional = false, min = 0, max = 10000 } = {}) => { if ((v == null || v === '') && optional) return null; const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) bad(`${name} must be a number from ${min} to ${max}`); return n; };

  route('GET', '/v1/pto/policies', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    const rules = c.rulesFor(org);
    return { policies: h.all('SELECT * FROM pto_policies WHERE org_id = ? ORDER BY name', org.id).map(rowToPolicy).map((p) => ({ ...p, enrolled: h.get('SELECT COUNT(*) AS n FROM pto_enrollments WHERE policy_id = ?', p.id).n })), stateSickLeave: rules.sickLeave ?? null, suggested: suggestSickPolicy(rules) };
  });
  /** What the law where people work suggests (sick leave), for the policy editor and the setup list. */
  route('GET', '/v1/pto/suggestions', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    const rules = c.rulesFor(org);
    const sick = suggestSickPolicy(rules);
    return { state: org.state, suggestions: sick ? [sick] : [], rule: rules.sickLeave ?? null, verified: false, note: sick ? null : `KeaS has no paid sick leave law for ${org.state || 'your state'}. You can still add a policy of your own.` };
  });
  route('POST', '/v1/pto/policies', ({ me, org, body }) => {
    need(me, 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('pol');
    if (body.id) getPolicy(id, org.id);
    const method = V.enum(body.method ?? 'per_hour_worked', 'method', METHODS);
    const p = {
      name: V.str(body.name, 'name', { min: 1, max: 80 }), kind: V.enum(body.kind ?? 'pto', 'kind', ['pto', 'vacation', 'sick', 'personal', 'other']), method,
      accrue: num(body.accrueHours ?? 0, 'accrueHours'), per: num(body.perHours ?? 0, 'perHours'), perPeriod: num(body.perPeriodHours ?? 0, 'perPeriodHours'), annual: num(body.annualHours ?? 0, 'annualHours'),
      cap: num(body.capHours, 'capHours', { optional: true }), annualMax: num(body.annualMaxHours, 'annualMaxHours', { optional: true }), carry: num(body.carryoverMax, 'carryoverMax', { optional: true }),
      waiting: Math.round(num(body.waitingDays ?? 0, 'waitingDays', { max: 3650 })),
      payout: V.enum(body.payoutOnTerm ?? 'state_rule', 'payoutOnTerm', ['state_rule', 'always', 'never']),
    };
    if (method === 'per_hour_worked' && !(p.accrue > 0 && p.per > 0)) bad('per-hour-worked accrual needs accrueHours and perHours (for example 1 per 30)');
    h.run(`INSERT INTO pto_policies (id,org_id,name,kind,method,accrue_hours,per_hours,per_period_hours,annual_hours,cap_hours,annual_max_hours,carryover_max,waiting_days,allow_negative,payout_on_term,protected,paid,auto_enroll,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, method=excluded.method, accrue_hours=excluded.accrue_hours, per_hours=excluded.per_hours,
      per_period_hours=excluded.per_period_hours, annual_hours=excluded.annual_hours, cap_hours=excluded.cap_hours, annual_max_hours=excluded.annual_max_hours, carryover_max=excluded.carryover_max, waiting_days=excluded.waiting_days,
      allow_negative=excluded.allow_negative, payout_on_term=excluded.payout_on_term, protected=excluded.protected, paid=excluded.paid, auto_enroll=excluded.auto_enroll, active=excluded.active`,
      id, org.id, p.name, p.kind, method, p.accrue, p.per, p.perPeriod, p.annual, p.cap, p.annualMax, p.carry, p.waiting, body.allowNegative ? 1 : 0, p.payout, body.protected ? 1 : 0, body.paid === false ? 0 : 1, body.autoEnroll === false ? 0 : 1, body.active === false ? 0 : 1);
    if (!body.id && body.autoEnroll !== false) {
      for (const r of h.all(`SELECT id, hire_date FROM people WHERE org_id = ? AND status IN ('active','onboarding','leave') AND worker_type = 'employee'`, org.id))
        h.run('INSERT OR IGNORE INTO pto_enrollments (person_id, policy_id, start_date) VALUES (?,?,?)', r.id, id, r.hire_date || today(org));
    }
    audit(org.id, me.id, 'pto_policy_save', id, p);
    return { policy: getPolicy(id, org.id) };
  });
  route('POST', '/v1/pto/enroll', ({ me, org, body }) => {
    need(me, 'payroll');
    const pol = getPolicy(V.id(body.policyId, 'policyId'), org.id);
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    if (body.enrolled === false) h.run('DELETE FROM pto_enrollments WHERE person_id = ? AND policy_id = ?', p.id, pol.id);
    else h.run('INSERT INTO pto_enrollments (person_id, policy_id, start_date) VALUES (?,?,?) ON CONFLICT DO UPDATE SET start_date = excluded.start_date', p.id, pol.id, V.date(body.startDate ?? p.hireDate ?? today(org), 'startDate'));
    audit(org.id, me.id, 'pto_enroll', p.id, { policyId: pol.id, enrolled: body.enrolled !== false });
    return { ok: true };
  });
  route('POST', '/v1/pto/adjust', ({ me, org, body }) => {
    need(me, 'payroll');
    const pol = getPolicy(V.id(body.policyId, 'policyId'), org.id);
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    c.notSelf(me, p.id, 'your own time-off balance');
    const hours = num(body.hours, 'hours', { min: -10000 });
    const note = V.str(body.note, 'note', { min: 3, max: 300 });
    h.run(`INSERT INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, p.id, pol.id, V.date(body.date ?? today(org), 'date'), hours, 'adjust', null, note, me.id, iso(now()));
    audit(org.id, me.id, 'pto_adjust', p.id, { policyId: pol.id, hours, note });
    return { balance: balance(h, p.id, pol.id) };
  });

  route('GET', '/v1/pto/balances', ({ me, org, query }) => {
    const pid = query.personId ? V.id(query.personId, 'personId') : null;
    if (pid !== me.id) need(me, 'manager', 'payroll');
    const people = pid ? [c.getPerson(pid, org.id)] : byName(h.all(`SELECT id, name FROM people WHERE org_id = ? AND status != 'terminated'`, org.id)).map((r) => c.getPerson(r.id, org.id));
    return {
      people: people.map((p) => ({
        id: p.id, name: p.name,
        balances: policiesFor(h, p).map((pol) => ({ policyId: pol.id, name: pol.name, kind: pol.kind, hours: balance(h, p.id, pol.id), pending: r2(h.get(`SELECT COALESCE(SUM(hours),0) AS s FROM time_off_requests WHERE person_id = ? AND policy_id = ? AND status = 'pending'`, p.id, pol.id).s) })),
      })),
    };
  });
  route('GET', '/v1/pto/ledger', ({ me, org, query }) => {
    const pid = V.id(query.personId ?? me.id, 'personId');
    if (pid !== me.id) need(me, 'manager', 'payroll');
    c.getPerson(pid, org.id);
    return { entries: h.all('SELECT l.*, p.name AS policy FROM pto_ledger l JOIN pto_policies p ON p.id = l.policy_id WHERE l.person_id = ? ORDER BY l.date DESC, l.id DESC LIMIT 500', pid).map((x) => ({ date: x.date, policy: x.policy, policyId: x.policy_id, hours: x.hours, kind: x.kind, note: x.note })) };
  });
  route('POST', '/v1/pto/accrue', async ({ me, org, body }) => {
    need(me, 'payroll');
    const period = c.parsePeriod(org, V.date(body.periodStart, 'periodStart'), null);
    await c.loadEngine?.(org, period);
    const people = h.all(`SELECT id FROM people WHERE org_id = ? AND status IN ('active','leave')`, org.id).map((r) => c.getPerson(r.id, org.id));
    const worked = new Map(people.map((p) => [p.id, c.computeTimecard(org, p, period).totals.workedMin]));
    const posted = postAccruals(h, people, period, worked, iso(now()));
    audit(org.id, me.id, 'pto_accrue', period.start, { posted });
    return { posted, period };
  });

  // ---------- time-off requests ----------
  const names = (orgId) => new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', orgId).map((r) => [r.id, r.name]));
  route('GET', '/v1/time-off', ({ me, org, query }) => {
    let rows = h.all('SELECT * FROM time_off_requests WHERE org_id = ? ORDER BY start_date DESC LIMIT 500', org.id).map(rowToRequest);
    if (!c.has(me, 'manager', 'payroll')) rows = rows.filter((r) => r.personId === me.id);
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    const nm = names(org.id), pol = new Map(h.all('SELECT id, name FROM pto_policies WHERE org_id = ?', org.id).map((r) => [r.id, r.name]));
    return { requests: rows.map((r) => ({ ...r, personName: nm.get(r.personId), policyName: pol.get(r.policyId) })) };
  });
  route('POST', '/v1/time-off', ({ me, org, body }) => {
    const personId = body.personId ? V.id(body.personId, 'personId') : me.id;
    if (personId !== me.id) need(me, 'manager', 'payroll');
    const p = c.getPerson(personId, org.id);
    const pol = getPolicy(V.id(body.policyId, 'policyId'), org.id);
    if (!h.get('SELECT 1 FROM pto_enrollments WHERE person_id = ? AND policy_id = ?', p.id, pol.id)) bad(`${p.name} isn’t in the ${pol.name} policy`);
    const startDate = V.date(body.startDate, 'startDate'), endDate = V.date(body.endDate ?? body.startDate, 'endDate');
    if (endDate < startDate) bad('endDate is before startDate');
    const hours = num(body.hours, 'hours', { min: 0.25, max: 2000 });
    const leaveCaseId = body.leaveCaseId ? V.id(body.leaveCaseId, 'leaveCaseId') : null;
    if (leaveCaseId && !h.get('SELECT 1 FROM leave_cases WHERE id = ? AND person_id = ?', leaveCaseId, p.id)) bad('unknown leaveCaseId');
    const pending = h.get(`SELECT COALESCE(SUM(hours),0) AS s FROM time_off_requests WHERE person_id = ? AND policy_id = ? AND status = 'pending'`, p.id, pol.id).s;
    const bal = balance(h, p.id, pol.id);
    if (!pol.allowNegative && pol.method !== 'none' && hours > bal - pending + 1e-9) throw new HttpError(409, `Not enough ${pol.name}: balance ${bal} h, ${r2(pending)} h already requested`);
    const id = uid('to');
    h.run(`INSERT INTO time_off_requests (id,org_id,person_id,policy_id,start_date,end_date,hours,note,status,leave_case_id,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
      id, org.id, p.id, pol.id, startDate, endDate, hours, V.str(body.note, 'note', { optional: true, max: 500 }), leaveCaseId, iso(now()));
    const ap = approvals.start({ orgId: org.id, kind: 'time_off', targetId: id, requestedBy: me.id, subjectPersonId: p.id, departmentId: p.departmentId, title: `${p.name}: ${hours} h ${pol.name}, ${startDate}${endDate !== startDate ? ' to ' + endDate : ''}` });
    h.run('UPDATE time_off_requests SET approval_id = ? WHERE id = ?', ap.id, id);
    audit(org.id, me.id, 'time_off_request', id, { personId: p.id, policyId: pol.id, hours });
    return { status: 201, body: { request: rowToRequest(h.get('SELECT * FROM time_off_requests WHERE id = ?', id)), approval: ap } };
  });
  route('POST', '/v1/time-off/:id/cancel', ({ me, org, params }) => {
    const r = h.get('SELECT * FROM time_off_requests WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!r) throw new HttpError(404, 'request not found');
    if (r.person_id !== me.id) need(me, 'manager', 'payroll');
    if (!['pending', 'approved'].includes(r.status)) throw new HttpError(409, `already ${r.status}`);
    h.tx(() => {
      if (r.status === 'pending' && r.approval_id) { const a = h.get('SELECT status FROM approval_requests WHERE id = ?', r.approval_id); if (a?.status === 'pending') h.run(`UPDATE approval_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`, iso(now()), r.approval_id); }
      if (r.status === 'approved') {
        h.run(`INSERT OR IGNORE INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, r.person_id, r.policy_id, r.start_date, r.hours, 'adjust', `tor-cancel:${r.id}`, 'Time off cancelled', me.id, iso(now()));
        // (Notes are sealed: find the usage this request added by reading them.)
        if (r.leave_case_id) for (const u of h.all('SELECT id, note FROM leave_usage WHERE case_id = ?', r.leave_case_id)) if (u.note === `tor:${r.id}`) h.run('DELETE FROM leave_usage WHERE id = ?', u.id);
      }
      h.run(`UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?`, r.id);
    });
    audit(org.id, me.id, 'time_off_cancel', r.id, null);
    return { ok: true };
  });
  approvals.on('time_off', {
    approved(a, actor) {
      const r = h.get('SELECT * FROM time_off_requests WHERE id = ?', a.targetId);
      h.run(`UPDATE time_off_requests SET status = 'approved' WHERE id = ?`, r.id);
      h.run(`INSERT OR IGNORE INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, r.person_id, r.policy_id, r.start_date, -r.hours, 'taken', `tor:${r.id}`, `${r.start_date} to ${r.end_date}`, actor, iso(now()));
      if (r.leave_case_id) h.run('INSERT INTO leave_usage (case_id, date, hours, note) VALUES (?,?,?,?)', r.leave_case_id, r.start_date, r.hours, `tor:${r.id}`);
    },
    denied: (a) => h.run(`UPDATE time_off_requests SET status = 'denied' WHERE id = ?`, a.targetId),
    cancelled: (a) => h.run(`UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?`, a.targetId),
  });

  // ---------- holidays ----------
  route('GET', '/v1/holidays', ({ me, org }) => {
    const cals = h.all('SELECT * FROM holiday_calendars WHERE org_id = ? ORDER BY is_default DESC, name', org.id);
    return { calendars: cals.map((x) => ({ id: x.id, name: x.name, isDefault: !!x.is_default, holidays: h.all('SELECT * FROM holidays WHERE calendar_id = ? ORDER BY date', x.id).map((d) => ({ id: d.id, date: d.date, name: d.name, paidHours: d.paid_hours, premiumMultiplier: d.premium_multiplier })) })) };
  });
  route('POST', '/v1/holiday-calendars', ({ me, org, body }) => {
    need(me, 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('hc');
    const isDefault = body.isDefault === true || !h.get('SELECT 1 FROM holiday_calendars WHERE org_id = ?', org.id) ? 1 : 0;
    h.tx(() => {
      if (isDefault) h.run('UPDATE holiday_calendars SET is_default = 0 WHERE org_id = ?', org.id);
      h.run('INSERT INTO holiday_calendars (id,org_id,name,is_default) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = MAX(excluded.is_default, holiday_calendars.is_default)', id, org.id, V.str(body.name, 'name', { min: 1, max: 80 }), isDefault);
    });
    audit(org.id, me.id, 'holiday_calendar_save', id, null);
    return { id };
  });
  route('POST', '/v1/holidays', ({ me, org, body }) => {
    need(me, 'payroll');
    const cal = V.id(body.calendarId, 'calendarId');
    if (!h.get('SELECT 1 FROM holiday_calendars WHERE id = ? AND org_id = ?', cal, org.id)) bad('unknown calendarId');
    const id = body.id ? V.id(body.id, 'id') : uid('hd');
    h.run(`INSERT INTO holidays (id,calendar_id,date,name,paid_hours,premium_multiplier) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date, name=excluded.name, paid_hours=excluded.paid_hours, premium_multiplier=excluded.premium_multiplier`,
      id, cal, V.date(body.date, 'date'), V.str(body.name, 'name', { min: 1, max: 80 }), num(body.paidHours ?? 8, 'paidHours', { max: 24 }), num(body.premiumMultiplier ?? 1, 'premiumMultiplier', { min: 1, max: 4 }));
    audit(org.id, me.id, 'holiday_save', id, null);
    return { id };
  });
  route('POST', '/v1/holidays/:id/delete', ({ me, org, params }) => {
    need(me, 'payroll');
    h.run('DELETE FROM holidays WHERE id = ? AND calendar_id IN (SELECT id FROM holiday_calendars WHERE org_id = ?)', params.id, org.id);
    return { ok: true };
  });

  // ---------- FMLA and state leave ----------
  function workedHoursBetween(personId, fromDate, toDate, tz) {
    const ps = h.all('SELECT * FROM punches WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at', personId, fromDate + 'T00:00:00Z', addDays(toDate, 1) + 'T12:00:00Z').map((p) => ({ id: p.id, type: p.type, at: p.at }));
    const { pairs } = pairPunches(ps, { now: now() });
    return r2(pairs.filter((x) => localDate(x.start, tz) >= fromDate && localDate(x.start, tz) <= toDate).reduce((a, x) => a + (x.end - x.start) / 3600000, 0));
  }
  function eligibility(org, p, law, asOf) {
    const rules = c.rulesFor(org);
    const def = (rules.leave || []).find((l) => l.law === law) || null;
    const facts = { law, asOf, definition: def };
    const months = p.hireDate ? Math.floor((dayNum(asOf) - dayNum(p.hireDate)) / 30.4375) : null;
    const hours = workedHoursBetween(p.id, addDays(asOf, -365), addDays(asOf, -1), org.tz) + (org.settings.leaveImportedHours?.[p.id] || 0);
    const worksite = org.settings.fmla?.worksiteEmployees ?? h.get(`SELECT COUNT(*) AS n FROM people WHERE org_id = ? AND status IN ('active','leave') AND worker_type = 'employee'`, org.id).n;
    facts.monthsEmployed = months;
    facts.hoursLast12Months = hours;
    facts.employeesWithin75Miles = worksite;
    if (def?.eligibility) {
      const e = def.eligibility;
      facts.checks = [
        e.monthsEmployed != null && { label: `Employed ${e.monthsEmployed}+ months`, met: months != null && months >= e.monthsEmployed, value: months },
        e.hoursWorked != null && { label: `${e.hoursWorked}+ hours in the last 12 months`, met: hours >= e.hoursWorked, value: hours },
        e.employeesWithin75Miles != null && { label: `${e.employeesWithin75Miles}+ employees within 75 miles`, met: worksite >= e.employeesWithin75Miles, value: worksite },
      ].filter(Boolean);
    }
    facts.note = 'These are the numbers KeaS has. Whoever handles leave makes the eligibility decision.';
    return facts;
  }
  route('GET', '/v1/leave/laws', ({ me, org }) => { need(me, 'manager', 'payroll'); return { laws: c.rulesFor(org).leave || [] }; });
  route('GET', '/v1/leave-cases', ({ me, org, query }) => {
    need(me, 'manager', 'payroll');
    const nm = names(org.id);
    let rows = h.all('SELECT * FROM leave_cases WHERE org_id = ? ORDER BY start_date DESC', org.id).map(rowToCase).map(caseFor(me, c.has));
    if (query.personId) rows = rows.filter((r) => r.personId === query.personId);
    return { cases: rows.map((r) => { const used = r2(h.get('SELECT COALESCE(SUM(hours),0) AS s FROM leave_usage WHERE case_id = ?', r.id).s); return { ...r, personName: nm.get(r.personId), usedHours: used, remainingHours: r2(r.entitlementHours - used) }; }) };
  });
  route('POST', '/v1/leave/eligibility', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    return { eligibility: eligibility(org, c.getPerson(V.id(body.personId, 'personId'), org.id), V.str(body.law, 'law', { min: 1, max: 60 }), V.date(body.asOf ?? today(org), 'asOf')) };
  });
  route('POST', '/v1/leave-cases', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const law = V.str(body.law, 'law', { min: 1, max: 60 });
    const startDate = V.date(body.startDate, 'startDate');
    const def = (c.rulesFor(org).leave || []).find((l) => l.law === law);
    let entitlement = body.entitlementHours != null ? num(body.entitlementHours, 'entitlementHours', { max: 5000 }) : null;
    if (entitlement == null) {
      if (!def?.weeks) bad('give entitlementHours (this law has no weeks in the tables)');
      const weekly = num(body.usualWeeklyHours ?? 40, 'usualWeeklyHours', { min: 1, max: 100 });
      entitlement = def.weeks * weekly;
    }
    const id = uid('lc');
    h.run(`INSERT INTO leave_cases (id,org_id,person_id,law,reason,start_date,end_date,intermittent,entitlement_hours,status,notes,eligibility,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`,
      id, org.id, p.id, law, V.str(body.reason, 'reason', { min: 1, max: 200 }), startDate, V.date(body.endDate, 'endDate', { optional: true }), body.intermittent ? 1 : 0, entitlement,
      V.str(body.notes, 'notes', { optional: true, max: 2000 }), JSON.stringify(eligibility(org, p, law, startDate)), me.id, iso(now()));
    audit(org.id, me.id, 'leave_case_open', id, { personId: p.id, law });
    return { status: 201, body: { case: caseFor(me, c.has)(rowToCase(h.get('SELECT * FROM leave_cases WHERE id = ?', id))) } };
  });
  route('POST', '/v1/leave-cases/:id/usage', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const lc = h.get('SELECT * FROM leave_cases WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!lc) throw new HttpError(404, 'leave case not found');
    h.run('INSERT INTO leave_usage (case_id, date, hours, note) VALUES (?,?,?,?)', lc.id, V.date(body.date, 'date'), num(body.hours, 'hours', { min: 0.25, max: 24 }), V.str(body.note, 'note', { optional: true, max: 200 }));
    audit(org.id, me.id, 'leave_usage', lc.id, { date: body.date, hours: body.hours });
    return { ok: true };
  });
  route('POST', '/v1/leave-cases/:id/close', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const r = h.run(`UPDATE leave_cases SET status = 'closed', end_date = COALESCE(end_date, ?) WHERE id = ? AND org_id = ?`, V.date(body.endDate ?? today(org), 'endDate'), params.id, org.id);
    if (!Number(r.changes)) throw new HttpError(404, 'leave case not found');
    audit(org.id, me.id, 'leave_case_close', params.id, null);
    return { ok: true };
  });
}
