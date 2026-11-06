// Pay structure: several rates per person (by position, with effective dates), shift differentials, pay grades and
// bands, raises that go through the approvals engine, and automatic retro pay for periods already paid.
// Also the person's payroll profile (SSN and bank details are sealed in the vault).
import { isValidRouting } from '../lib/nacha.mjs';
import { addDays } from '../lib/time.mjs';

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export const rowToRate = (r) => ({ id: r.id, personId: r.person_id, positionId: r.position_id, kind: r.kind, rateCents: r.rate_cents, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, label: r.label, createdAt: r.created_at });
export const rowToDiff = (r) => ({ id: r.id, name: r.name, kind: r.kind, amount: r.amount, days: J(r.days, []), startMin: r.start_min, endMin: r.end_min, positionIds: J(r.position_ids, []), active: !!r.active });
export const rowToGrade = (r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, minCents: r.min_cents, midCents: r.mid_cents, maxCents: r.max_cents });
const rowToRaise = (r) => ({ id: r.id, personId: r.person_id, positionId: r.position_id, kind: r.kind, oldRateCents: r.old_rate_cents, newRateCents: r.new_rate_cents, effectiveDate: r.effective_date, reason: r.reason, status: r.status, requestedBy: r.requested_by, approvalId: r.approval_id, createdAt: r.created_at, appliedAt: r.applied_at, retroCents: r.retro_cents });

/** The rate in force for a person on a date: a position-specific rate first, then their default rate. */
export function rateFor(h, person, positionId, date) {
  const rows = h.all('SELECT * FROM pay_rates WHERE person_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC', person.id, date, date);
  const pos = positionId ? rows.find((r) => r.position_id === positionId) : null;
  const def = rows.find((r) => r.position_id == null);
  const r = pos || def;
  if (r) return { cents: r.rate_cents, kind: r.kind, positionRate: !!pos, rateId: r.id };
  return person.payRateCents == null ? null : { cents: person.payRateCents, kind: 'hourly', positionRate: false, rateId: null };
}

/** Is this minute (local weekday 0-6, minute of day) inside the differential's window? */
export function diffApplies(d, dow, mod, positionId) {
  if (!d.active) return false;
  if (d.positionIds.length && !d.positionIds.includes(positionId)) return false;
  if (d.startMin === d.endMin) return d.days.includes(dow); // all day
  if (d.startMin < d.endMin) return d.days.includes(dow) && mod >= d.startMin && mod < d.endMin;
  // Overnight window (e.g. 22:00-06:00): the part after midnight belongs to the day the window started.
  if (mod >= d.startMin) return d.days.includes(dow);
  return mod < d.endMin && d.days.includes((dow + 6) % 7);
}

/** Retro pay owed on finalized runs when a raise is back-dated. */
export function retroFor(h, raise, otMultiplier = 1.5) {
  const lines = h.all(`SELECT l.detail, r.period_start, r.period_end, r.id AS run_id FROM payrun_lines l JOIN payruns r ON r.id = l.run_id
    WHERE l.person_id = ? AND r.status = 'finalized' AND r.period_end >= ? ORDER BY r.period_start`, raise.person_id, raise.effective_date);
  const out = [];
  for (const l of lines) {
    const d = J(l.detail, {});
    if (d.salaried) continue;
    let cents = 0, min = 0;
    for (const s of d.segments || []) {
      if (s.date < raise.effective_date) continue;
      if (raise.position_id ? s.positionId !== raise.position_id : s.positionRate) continue;
      const diff = raise.new_rate_cents - s.rateCents;
      if (diff <= 0) continue;
      cents += diff * (s.minutes + (s.otMin || 0) * ((d.otMultiplier ?? otMultiplier) - 1)) / 60;
      min += s.minutes;
    }
    if (Math.round(cents) > 0) out.push({ runId: l.run_id, periodStart: l.period_start, periodEnd: l.period_end, minutes: min, cents: Math.round(cents) });
  }
  return out;
}

export function maskSsn(ssn) { const d = String(ssn || '').replace(/\D/g, ''); return d.length === 9 ? `***-**-${d.slice(5)}` : null; }
export const validSsn = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 9 && !/^(000|666|9)/.test(d) && d.slice(3, 5) !== '00' && d.slice(5) !== '0000'; };
export function depositAccounts(dep) {
  if (!dep) return [];
  if (Array.isArray(dep.accounts)) return dep.accounts;
  return dep.routing ? [{ routing: dep.routing, account: dep.account, accountType: dep.accountType || 'checking', remainder: true }] : [];
}
/** Split a net amount across deposit accounts: fixed amounts first, then percentages, then the remainder account. */
export function splitNet(netCents, accounts) {
  let left = netCents;
  const out = [];
  for (const a of accounts.filter((x) => x.amountCents != null)) { const c = Math.min(left, a.amountCents); if (c > 0) out.push({ ...a, cents: c }); left -= c; }
  const base = left;
  for (const a of accounts.filter((x) => x.pct != null)) { const c = Math.min(left, Math.round(base * a.pct / 100)); if (c > 0) out.push({ ...a, cents: c }); left -= c; }
  const rem = accounts.find((x) => x.remainder) || accounts.at(-1);
  if (left > 0 && rem) { const ex = out.find((x) => x === rem || (x.routing === rem.routing && x.account === rem.account)); if (ex) ex.cents += left; else out.push({ ...rem, cents: left }); }
  return out;
}

export function registerPayStructure(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, approvals, now, iso, today } = c;
  const money = (v, name) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1e9) bad(`${name} must be an amount in cents`); return n; };

  // ---------- people: payroll profile ----------
  function profile(p, org) {
    const pii = vault.openJson(p.piiRaw) || {};
    const dep = vault.openJson(p.depositRaw);
    return {
      id: p.id, name: p.name, legalName: p.legalName, email: p.email, roles: p.roles, positions: p.positions, status: p.status, birthdate: p.birthdate,
      hireDate: p.hireDate, termDate: p.termDate, workerType: p.workerType, employeeNumber: p.employeeNumber, departmentId: p.departmentId, entityId: p.entityId,
      managerId: p.managerId, gradeId: p.gradeId, holidayCalendarId: p.holidayCalendarId, defaultAllocations: p.defaultAllocations,
      payRateCents: p.payRateCents, w4: p.w4, coAllowance: p.coAllowance, ytdWagesCents: p.ytdWagesCents, ytdYear: p.ytdYear,
      ssnMasked: maskSsn(pii.ssn), address: pii.address || null, phone: pii.phone || null,
      deposit: depositAccounts(dep).map((a) => ({ routing: a.routing, accountLast4: String(a.account).slice(-4), accountType: a.accountType, amountCents: a.amountCents ?? null, pct: a.pct ?? null, remainder: !!a.remainder })),
      rates: h.all('SELECT * FROM pay_rates WHERE person_id = ? ORDER BY effective_from DESC', p.id).map(rowToRate),
      currentRate: rateFor(h, p, null, today(org)),
    };
  }
  c.profile = profile;

  route('GET', '/v1/people/:id/profile', ({ me, org, params }) => {
    if (params.id !== me.id) need(me, 'payroll');
    return { profile: profile(c.getPerson(params.id, org.id), org) };
  });

  const ROLE_SET = ['member', 'manager', 'payroll', 'owner'];
  function applyProfile(p, body, me, org) {
    const sets = {};
    if (body.name !== undefined) sets.name = V.str(body.name, 'name', { min: 1, max: 120 });
    if (body.legalName !== undefined) sets.legal_name = V.str(body.legalName, 'legalName', { optional: true, max: 120 });
    if (body.email !== undefined) sets.email = V.str(body.email, 'email', { optional: true, max: 200 });
    if (body.birthdate !== undefined) sets.birthdate = V.date(body.birthdate, 'birthdate', { optional: true });
    if (body.hireDate !== undefined) sets.hire_date = V.date(body.hireDate, 'hireDate', { optional: true });
    if (body.status !== undefined) sets.status = V.enum(body.status, 'status', ['active', 'applicant', 'onboarding', 'leave', 'terminated']);
    if (body.workerType !== undefined) sets.worker_type = V.enum(body.workerType, 'workerType', ['employee', 'contractor']);
    if (body.employeeNumber !== undefined) sets.employee_number = V.str(body.employeeNumber, 'employeeNumber', { optional: true, max: 40 });
    if (body.positions !== undefined) { if (!Array.isArray(body.positions)) bad('positions must be a list'); for (const id of body.positions) if (!h.get('SELECT 1 FROM positions WHERE id = ? AND org_id = ?', id, org.id)) bad('unknown position'); sets.positions = JSON.stringify(body.positions); }
    if (body.roles !== undefined) {
      need(me, 'owner');
      if (!Array.isArray(body.roles) || body.roles.some((r) => !ROLE_SET.includes(r))) bad(`roles must be from ${ROLE_SET.join(', ')}`);
      sets.roles = JSON.stringify([...new Set(['member', ...body.roles])]);
    }
    if (body.gradeId !== undefined) { if (body.gradeId && !h.get('SELECT 1 FROM pay_grades WHERE id = ? AND org_id = ?', body.gradeId, org.id)) bad('unknown gradeId'); sets.grade_id = body.gradeId || null; }
    if (body.holidayCalendarId !== undefined) { if (body.holidayCalendarId && !h.get('SELECT 1 FROM holiday_calendars WHERE id = ? AND org_id = ?', body.holidayCalendarId, org.id)) bad('unknown holidayCalendarId'); sets.holiday_calendar_id = body.holidayCalendarId || null; }
    if (body.w4 !== undefined) sets.w4 = JSON.stringify(validateW4(body.w4, bad));
    if (body.coAllowance !== undefined) sets.co_allowance = body.coAllowance == null || body.coAllowance === '' ? null : Number(body.coAllowance);
    if (body.pii !== undefined) {
      const cur = vault.openJson(p?.piiRaw) || {};
      const next = { ...cur };
      if (body.pii.ssn !== undefined) { if (body.pii.ssn && !validSsn(body.pii.ssn)) bad('that SSN isn’t valid'); next.ssn = body.pii.ssn ? String(body.pii.ssn).replace(/\D/g, '') : null; }
      if (body.pii.address !== undefined) next.address = body.pii.address ? cleanAddress(body.pii.address) : null;
      if (body.pii.phone !== undefined) next.phone = body.pii.phone ? String(body.pii.phone).slice(0, 30) : null;
      sets.pii_enc = vault.sealJson(next);
    }
    return sets;
  }
  c.applyProfile = applyProfile;
  const writeSets = (id, sets) => { const keys = Object.keys(sets); if (keys.length) h.run(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), id); };
  c.writePersonSets = writeSets;

  c.createPerson = function createPerson(org, me, body) {
    const id = body.id && /^[\w-]{1,40}$/.test(body.id) && !h.get('SELECT 1 FROM people WHERE id = ?', body.id) ? body.id : uid('p');
    const name = V.str(body.name, 'name', { min: 1, max: 120 });
    h.run(`INSERT INTO people (id,org_id,name,email,roles,positions,status,w4,ytd_wages_cents) VALUES (?,?,?,?,?,?,?,?,0)`, id, org.id, name, null, '["member"]', '[]', 'onboarding', '{}');
    const sets = applyProfile({ piiRaw: null }, { ...body, roles: undefined }, me, org);
    writeSets(id, sets);
    if (body.payRateCents != null) {
      const rate = money(body.payRateCents, 'payRateCents');
      const kind = V.enum(body.payKind ?? 'hourly', 'payKind', ['hourly', 'salary']);
      h.run('INSERT INTO pay_rates (id,person_id,position_id,kind,rate_cents,effective_from,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', uid('rt'), id, null, kind, rate, body.hireDate || today(org), me.id, iso(now()));
      if (kind === 'hourly') h.run('UPDATE people SET pay_rate_cents = ? WHERE id = ?', rate, id);
    }
    audit(org.id, me.id, 'person_create', id, { name });
    return c.getPerson(id, org.id);
  };

  route('POST', '/v1/people', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = c.createPerson(org, me, body);
    return { status: 201, body: { profile: profile(p, org) } };
  });
  route('POST', '/v1/people/:id/profile', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(params.id, org.id);
    const sets = applyProfile(p, body, me, org);
    writeSets(p.id, sets);
    audit(org.id, me.id, 'person_profile', p.id, { fields: Object.keys(sets) });
    return { profile: profile(c.getPerson(p.id, org.id), org) };
  });
  route('POST', '/v1/people/:id/reveal-ssn', ({ me, org, params }) => {
    need(me, 'payroll');
    const p = c.getPerson(params.id, org.id);
    audit(org.id, me.id, 'ssn_reveal', p.id, null);
    const ssn = vault.openJson(p.piiRaw)?.ssn;
    return { ssn: ssn ? `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}` : null };
  });
  route('POST', '/v1/people/:id/deposit', ({ me, org, params, body }) => {
    if (params.id !== me.id) need(me, 'payroll');
    const p = c.getPerson(params.id, org.id);
    // Your own first account can be added (new hires do it while onboarding); changing it afterwards is for payroll
    // (or the owner), so a stolen sign-in can't send someone's pay to another account.
    const self = p.id === me.id;
    if (self && depositAccounts(vault.openJson(p.depositRaw)).length) c.notSelf(me, p.id, 'your own direct deposit once it’s set');
    const list = Array.isArray(body.accounts) ? body.accounts : [body];
    if (list.length < 1 || list.length > 4) bad('1 to 4 accounts');
    const accounts = list.map((a, i) => {
      const routing = String(a.routing || '').trim(), account = String(a.account || '').replace(/\s/g, '');
      if (!isValidRouting(routing)) bad(`account ${i + 1}: that routing number isn’t valid`);
      if (!/^[0-9A-Za-z-]{4,17}$/.test(account)) bad(`account ${i + 1}: account numbers are 4 to 17 characters`);
      const o = { routing, account, accountType: V.enum(a.accountType ?? 'checking', 'accountType', ['checking', 'savings']) };
      if (a.amountCents != null) o.amountCents = money(a.amountCents, 'amountCents'); else if (a.pct != null) { o.pct = Number(a.pct); if (!(o.pct > 0 && o.pct <= 100)) bad('pct must be 1-100'); } else o.remainder = true;
      return o;
    });
    if (!accounts.some((a) => a.remainder)) accounts[accounts.length - 1] = { ...accounts.at(-1), remainder: true, amountCents: undefined, pct: undefined };
    h.run('UPDATE people SET deposit = ? WHERE id = ?', vault.sealJson({ accounts }), p.id);
    audit(org.id, me.id, 'deposit_set', p.id, { accounts: accounts.length, ...(self ? { self: true } : {}) });
    c.markTask?.(p.id, 'deposit', me.id);
    return { profile: profile(c.getPerson(p.id, org.id), org) };
  });

  // ---------- rates ----------
  route('GET', '/v1/people/:id/rates', ({ me, org, params }) => {
    if (params.id !== me.id) need(me, 'payroll');
    const p = c.getPerson(params.id, org.id);
    return { rates: h.all('SELECT * FROM pay_rates WHERE person_id = ? ORDER BY effective_from DESC', p.id).map(rowToRate), current: rateFor(h, p, null, today(org)) };
  });
  // A first rate for a person or position. Changing an existing rate is a raise (it goes through approvals).
  // Only the owner adds a rate directly when it pays more than the person's current rate, or starts before today for
  // someone already paid (that would mean retro pay): anyone else's goes through the raise approval instead.
  route('POST', '/v1/people/:id/rates', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(params.id, org.id);
    const self = c.notSelf(me, p.id);
    const isOwner = me.roles.includes('owner');
    const positionId = body.positionId ? V.id(body.positionId, 'positionId') : null;
    if (positionId && !h.get('SELECT 1 FROM positions WHERE id = ? AND org_id = ?', positionId, org.id)) bad('unknown positionId');
    if (h.get('SELECT 1 FROM pay_rates WHERE person_id = ? AND position_id IS ?', p.id, positionId) && !isOwner) throw new HttpError(409, 'this person already has that rate; change it with a raise');
    const kind = V.enum(body.kind ?? 'hourly', 'kind', ['hourly', 'salary']);
    const rateCents = money(body.rateCents, 'rateCents');
    const effectiveFrom = V.date(body.effectiveFrom ?? p.hireDate ?? today(org), 'effectiveFrom');
    const cur = rateFor(h, p, positionId, today(org));
    const paidBefore = !!h.get('SELECT 1 FROM payrun_lines WHERE person_id = ? LIMIT 1', p.id);
    const higher = !!cur && rateCents > cur.cents;
    const backdated = effectiveFrom < today(org) && (!!cur || paidBefore);
    if (!isOwner && (higher || backdated)) {
      const r = requestRaise({ org, me, p, positionId, effectiveDate: effectiveFrom, newRate: rateCents, kind, reason: V.str(body.label, 'label', { optional: true, max: 60 }) || (higher ? 'New rate above the current one' : 'Back-dated rate') });
      return { status: 202, body: { ...r, needsApproval: true, message: `${higher ? 'This rate is above the current one' : 'This rate starts before today'}, so it goes through the raise approval.` } };
    }
    const id = uid('rt');
    h.run('INSERT INTO pay_rates (id,person_id,position_id,kind,rate_cents,effective_from,label,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, p.id, positionId, kind, rateCents, effectiveFrom, V.str(body.label, 'label', { optional: true, max: 60 }), me.id, iso(now()));
    if (!positionId && kind === 'hourly') h.run('UPDATE people SET pay_rate_cents = ? WHERE id = ?', rateCents, p.id);
    audit(org.id, me.id, 'rate_add', p.id, { positionId, kind, rateCents, effectiveFrom, ...(self ? { self: true } : {}), ...(higher || backdated ? { ownerDirect: true } : {}) });
    return { status: 201, body: { rate: rowToRate(h.get('SELECT * FROM pay_rates WHERE id = ?', id)) } };
  });

  // ---------- differentials ----------
  route('GET', '/v1/differentials', ({ me, org }) => { need(me, 'manager', 'payroll'); return { differentials: h.all('SELECT * FROM differentials WHERE org_id = ? ORDER BY name', org.id).map(rowToDiff) }; });
  route('POST', '/v1/differentials', ({ me, org, body }) => {
    need(me, 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('df');
    const name = V.str(body.name, 'name', { min: 1, max: 80 });
    const kind = V.enum(body.kind, 'kind', ['per_hour', 'percent']);
    const amount = Number(body.amount);
    if (!(amount > 0) || (kind === 'percent' && amount > 300)) bad('amount must be more than 0 (cents per hour, or a percent)');
    const days = Array.isArray(body.days) ? [...new Set(body.days.map(Number))].filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) bad('pick at least one day');
    const hm = (v, n, d) => { if (v == null || v === '') return d; if (!/^\d{1,2}:\d{2}$/.test(v)) bad(`${n} must be HH:MM`); const [a, b] = v.split(':').map(Number); if (a > 24 || b > 59) bad(`${n} must be HH:MM`); return a * 60 + b; };
    const startMin = hm(body.start, 'start', 0), endMin = hm(body.end, 'end', 1440);
    const positionIds = Array.isArray(body.positionIds) ? body.positionIds.filter((x) => h.get('SELECT 1 FROM positions WHERE id = ? AND org_id = ?', x, org.id)) : [];
    h.run(`INSERT INTO differentials (id,org_id,name,kind,amount,days,start_min,end_min,position_ids,active) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, amount=excluded.amount, days=excluded.days, start_min=excluded.start_min, end_min=excluded.end_min, position_ids=excluded.position_ids, active=excluded.active`,
      id, org.id, name, kind, amount, JSON.stringify(days), startMin, endMin, JSON.stringify(positionIds), body.active === false ? 0 : 1);
    audit(org.id, me.id, 'differential_save', id, { name, kind, amount });
    return { differential: rowToDiff(h.get('SELECT * FROM differentials WHERE id = ?', id)) };
  });
  route('POST', '/v1/differentials/:id/delete', ({ me, org, params }) => { need(me, 'payroll'); h.run('DELETE FROM differentials WHERE id = ? AND org_id = ?', params.id, org.id); audit(org.id, me.id, 'differential_delete', params.id, null); return { ok: true }; });

  // ---------- grades ----------
  route('GET', '/v1/pay-grades', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    const grades = h.all('SELECT * FROM pay_grades WHERE org_id = ? ORDER BY code', org.id).map(rowToGrade);
    const people = h.all(`SELECT * FROM people WHERE org_id = ? AND grade_id IS NOT NULL AND status != 'terminated'`, org.id).map((r) => c.getPerson(r.id, org.id));
    return {
      grades: grades.map((g) => ({
        ...g, people: people.filter((p) => p.gradeId === g.id).map((p) => {
          const r = rateFor(h, p, null, today(org));
          const mid = g.midCents ?? Math.round((g.minCents + g.maxCents) / 2);
          return { id: p.id, name: p.name, rateCents: r?.cents ?? null, compaRatio: r ? +(r.cents / mid).toFixed(3) : null, position: r ? (r.cents < g.minCents ? 'below' : r.cents > g.maxCents ? 'above' : 'within') : null };
        }),
      })),
    };
  });
  route('POST', '/v1/pay-grades', ({ me, org, body }) => {
    need(me, 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('gr');
    const minCents = money(body.minCents, 'minCents'), maxCents = money(body.maxCents, 'maxCents');
    if (maxCents < minCents) bad('the top of the band is below the bottom');
    const midCents = body.midCents == null || body.midCents === '' ? null : money(body.midCents, 'midCents');
    if (midCents != null && (midCents < minCents || midCents > maxCents)) bad('the midpoint must be inside the band');
    h.run(`INSERT INTO pay_grades (id,org_id,code,name,kind,min_cents,mid_cents,max_cents) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, kind=excluded.kind, min_cents=excluded.min_cents, mid_cents=excluded.mid_cents, max_cents=excluded.max_cents`,
      id, org.id, V.str(body.code, 'code', { min: 1, max: 20 }), V.str(body.name, 'name', { min: 1, max: 80 }), V.enum(body.kind ?? 'hourly', 'kind', ['hourly', 'salary']), minCents, midCents, maxCents);
    audit(org.id, me.id, 'grade_save', id, { minCents, maxCents });
    return { grade: rowToGrade(h.get('SELECT * FROM pay_grades WHERE id = ?', id)) };
  });

  // ---------- raises ----------
  route('GET', '/v1/raises', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    const names = new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', org.id).map((r) => [r.id, r.name]));
    return { raises: h.all('SELECT * FROM raises WHERE org_id = ? ORDER BY created_at DESC', org.id).map(rowToRaise).map((r) => ({ ...r, personName: names.get(r.personId) })) };
  });
  route('POST', '/v1/raises', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    c.notSelf(me, p.id);
    const positionId = body.positionId ? V.id(body.positionId, 'positionId') : null;
    const effectiveDate = V.date(body.effectiveDate, 'effectiveDate');
    const cur = rateFor(h, p, positionId, effectiveDate);
    let newRate;
    if (body.newRateCents != null) newRate = money(body.newRateCents, 'newRateCents');
    else if (body.percent != null) { if (!cur) bad('this person has no current rate to raise by a percent'); newRate = Math.round(cur.cents * (1 + Number(body.percent) / 100)); }
    else bad('give newRateCents or percent');
    const kind = cur?.kind ?? V.enum(body.kind ?? 'hourly', 'kind', ['hourly', 'salary']);
    return { status: 201, body: requestRaise({ org, me, p, positionId, effectiveDate, newRate, kind, reason: V.str(body.reason, 'reason', { optional: true, max: 300 }) }) };
  });
  /** Starts a raise (a new rate from a date) through the approvals engine. */
  function requestRaise({ org, me, p, positionId, effectiveDate, newRate, kind, reason }) {
    const cur = rateFor(h, p, positionId, effectiveDate);
    const warnings = [];
    if (p.gradeId) {
      const g = h.get('SELECT * FROM pay_grades WHERE id = ?', p.gradeId);
      if (g && (newRate < g.min_cents || newRate > g.max_cents)) warnings.push(`Outside pay grade ${g.code} ($${(g.min_cents / 100).toFixed(2)}–$${(g.max_cents / 100).toFixed(2)})`);
    }
    const id = uid('rs');
    h.run(`INSERT INTO raises (id,org_id,person_id,position_id,kind,old_rate_cents,new_rate_cents,effective_date,reason,status,requested_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      id, org.id, p.id, positionId, kind, cur?.cents ?? null, newRate, effectiveDate, reason ?? null, me.id, iso(now()));
    const fmt = (x) => (kind === 'salary' ? `$${(x / 100).toLocaleString('en-US')}/yr` : `$${(x / 100).toFixed(2)}/h`);
    const ap = approvals.start({ orgId: org.id, kind: 'raise', targetId: id, requestedBy: me.id, subjectPersonId: p.id, departmentId: p.departmentId, amountCents: newRate - (cur?.cents ?? 0), title: `${p.name}: ${cur ? fmt(cur.cents) + ' → ' : ''}${fmt(newRate)} from ${effectiveDate}`, detail: { warnings } });
    h.run('UPDATE raises SET approval_id = ? WHERE id = ?', ap.id, id);
    audit(org.id, me.id, 'raise_request', id, { personId: p.id, newRate, effectiveDate, ...(p.id === me.id ? { self: true } : {}) });
    return { raise: rowToRaise(h.get('SELECT * FROM raises WHERE id = ?', id)), approval: ap, warnings };
  }

  /** Put an approved raise into effect: close the old rate, add the new one, and owe retro pay for periods already paid. */
  function applyRaise(raiseId, actor) {
    const r = h.get('SELECT * FROM raises WHERE id = ?', raiseId);
    const org = c.loadOrg(r.org_id);
    h.run('UPDATE pay_rates SET effective_to = ? WHERE person_id = ? AND position_id IS ? AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)', addDays(r.effective_date, -1), r.person_id, r.position_id, r.effective_date, r.effective_date);
    h.run('INSERT INTO pay_rates (id,person_id,position_id,kind,rate_cents,effective_from,label,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid('rt'), r.person_id, r.position_id, r.kind, r.new_rate_cents, r.effective_date, 'Raise', actor, iso(now()));
    if (!r.position_id && r.kind === 'hourly' && r.effective_date <= today(org)) h.run('UPDATE people SET pay_rate_cents = ? WHERE id = ?', r.new_rate_cents, r.person_id);
    const retro = r.kind === 'hourly' ? retroFor(h, r, c.rulesFor(org).overtime?.multiplier ?? 1.5) : [];
    const total = retro.reduce((a, x) => a + x.cents, 0);
    if (total > 0) {
      h.run(`INSERT INTO extra_earnings (id,org_id,person_id,code,label,cents,hours,taxable,source,detail,status,created_at) VALUES (?,?,?,?,?,?,?,1,?,?,'pending',?)`,
        uid('ee'), r.org_id, r.person_id, 'retro', `Retro pay (raise from ${r.effective_date})`, total, +(retro.reduce((a, x) => a + x.minutes, 0) / 60).toFixed(2), `raise:${r.id}`, JSON.stringify(retro), iso(now()));
    }
    h.run(`UPDATE raises SET status = 'applied', applied_at = ?, retro_cents = ? WHERE id = ?`, iso(now()), total, r.id);
    audit(r.org_id, actor, 'raise_apply', r.id, { retroCents: total, periods: retro.length });
  }
  approvals.on('raise', {
    approved: (a, actor) => applyRaise(a.targetId, actor),
    denied: (a) => h.run(`UPDATE raises SET status = 'denied' WHERE id = ?`, a.targetId),
    cancelled: (a) => h.run(`UPDATE raises SET status = 'cancelled' WHERE id = ?`, a.targetId),
  });
}

export function validateW4(w, bad) {
  if (!w || typeof w !== 'object') bad('w4 must be an object');
  const n = (v, name) => { const x = v == null || v === '' ? 0 : Number(v); if (!Number.isFinite(x) || x < 0 || x > 1e7) bad(`${name} must be a dollar amount`); return x; };
  return {
    filing: ['single', 'married', 'hoh'].includes(w.filing) ? w.filing : bad('filing must be single, married or hoh'),
    step2: !!w.step2, dependentsCredit: n(w.dependentsCredit, 'dependentsCredit'), otherIncome: n(w.otherIncome, 'otherIncome'),
    deductions: n(w.deductions, 'deductions'), extraWithholding: n(w.extraWithholding, 'extraWithholding'), exempt: !!w.exempt,
  };
}
export function cleanAddress(a) {
  return { line1: String(a.line1 || '').slice(0, 120), line2: String(a.line2 || '').slice(0, 120), city: String(a.city || '').slice(0, 60), state: String(a.state || '').slice(0, 2).toUpperCase(), zip: String(a.zip || '').slice(0, 10) };
}
