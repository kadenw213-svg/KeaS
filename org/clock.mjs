// The time clock for an organization: clocking in and out (append-only punches), missed-punch requests, timecards
// by pay period and their approval, who's in today and who's late, and time off requests (dates, kind and status;
// balances and pay stay in the payroll vault). Brought over from the org server (server/index.mjs) and keyed by the
// same member ids as everything else in the org engine.
import { timecard } from '../server/lib/rules.mjs';
import { localDate, zonedToUtc, addDays, dayNum, iso, weekStartOf } from '../server/lib/time.mjs';

const REASONS = ['forgot', 'device', 'early_late_fix', 'other'];
const H = 3600_000;

export function mountClock(core, { R, rulesFor, date, list }) {
  const { h, now, audit, notify, V, bad, forbidden, notFound, tx, id, asOrg, memberRow, names, pay } = core;
  const deptOf = (oid, aid) => memberRow(oid, aid)?.department_id ?? null;

  // ---------- pay periods ----------
  /** The org's pay periods: every 7 or 14 days from an anchor date (by default the workweek start on or before 2026-01-01). */
  const anchorOf = (o, s) => s.clock.periodAnchor || weekStartOf('2026-01-01', o.workweek_start);
  const periodOf = (o, s, d) => {
    const n = s.clock.periodDays === 7 ? 7 : 14, a = anchorOf(o, s);
    const k = Math.floor((dayNum(d) - dayNum(a)) / n);
    const start = addDays(a, k * n);
    return { start, end: addDays(start, n - 1) };
  };
  const currentPeriod = (o, s) => periodOf(o, s, localDate(now(), o.tz));
  const lastCompleted = (o, s) => periodOf(o, s, addDays(currentPeriod(o, s).start, -1));
  const parsePeriod = (o, s, v, fallback) => {
    if (v == null || v === '') return fallback;
    const d = date(v, 'Period start');
    const p = periodOf(o, s, d);
    if (p.start !== d) bad(`That isn’t the first day of a pay period. Try ${p.start}.`);
    return p;
  };

  // ---------- punches ----------
  const punchOut = (p, code = p.pay_code_id ?? null) => ({ id: p.id, accountId: p.account_id, shiftId: p.shift_id, type: p.type, at: iso(p.at), source: p.source, restAttested: p.rest_attested == null ? null : !!p.rest_attested, createdAt: iso(p.created_at), payCodeId: code });
  const lastPunch = (oid, aid) => h.get('SELECT * FROM org_punches WHERE org_id = ? AND account_id = ? ORDER BY at DESC, created_at DESC LIMIT 1', oid, aid);
  const openPunch = (oid, aid, t = now()) => { const l = lastPunch(oid, aid); return l && l.type === 'in' && t - l.at < 16 * H ? l : null; };
  const addPunch = (o, aid, { shiftId = null, type, at, source, restAttested = null, payCodeId = null }) => {
    const pid = id();
    h.run('INSERT INTO org_punches (id,org_id,account_id,shift_id,type,at,source,rest_attested,created_at,pay_code_id) VALUES (?,?,?,?,?,?,?,?,?,?)', pid, o.id, aid, shiftId, type, at, source, restAttested == null ? null : restAttested ? 1 : 0, now(), payCodeId);
    return h.get('SELECT * FROM org_punches WHERE id = ?', pid);
  };
  const shiftBrief = (sh) => sh && ({ id: sh.id, positionId: sh.position_id, start: iso(sh.start_at), end: iso(sh.end_at), date: sh.date, status: sh.status });

  R('POST', '/v1/orgs/:id/clock', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'clock.self');
    const { o, s } = x;
    const type = V.enum(body.type, 'Clock', ['in', 'out']);
    const restAttested = V.bool(body.restAttested, 'Breaks taken', { optional: true });
    const t = now();
    const open = openPunch(o.id, me.id, t);
    if (type === 'in' && open) bad('You’re already clocked in.');
    if (type === 'out' && !open) bad('You’re not clocked in.');
    let shift = null;
    if (type === 'out') shift = open.shift_id ? h.get('SELECT * FROM org_shifts WHERE id = ?', open.shift_id) : null;
    else {
      // The published shift of mine nearest to now, starting within two hours either way.
      const cands = h.all("SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND status = 'published' AND start_at <= ? AND end_at >= ?", o.id, me.id, t + 2 * H, t - 2 * H);
      shift = cands.sort((a, b) => Math.abs(a.start_at - t) - Math.abs(b.start_at - t))[0] ?? null;
      if (!shift && s.clock.needShift) bad('There’s no shift of yours around now. Ask a manager to add one, or to fix it with a missed-punch request.');
    }
    // The pay code: the one asked for (one of mine), else the shift's when I was given it, else my default. A
    // clock-out carries its clock-in's code.
    let payCodeId;
    if (type === 'in') payCodeId = body.payCodeId != null ? pay.pickFor(o.id, me.id, body.payCodeId) : (shift?.pay_code_id && pay.granted(o.id, me.id, shift.pay_code_id) ? shift.pay_code_id : pay.defaultOf(o.id, me.id));
    else payCodeId = pay.effectiveCodes(o.id, me.id, [open]).get(open.id) ?? null;
    const p = addPunch(o, me.id, { shiftId: shift?.id ?? null, type, at: t, source: V.enum(body.source ?? 'app', 'Source', ['app', 'kiosk', 'phone']), restAttested, payCodeId });
    const minutesLate = type === 'in' && shift ? Math.max(0, Math.floor((t - shift.start_at) / 60000)) : 0;
    audit(me.id, `org.clock_${type}`, o.id, { shift: shift?.id ?? null }, ip);
    return { status: 201, body: { punch: punchOut(p), shift: shiftBrief(shift), minutesLate, late: minutesLate > s.clock.lateThresholdMin } };
  });
  R('GET', '/v1/orgs/:id/clock', ({ me, params }) => {
    const x = asOrg(params.id, me);
    const open = openPunch(x.o.id, me.id);
    return { clockedIn: !!open, punch: open ? punchOut(open, pay.effectiveCodes(x.o.id, me.id, [open]).get(open.id) ?? null) : null, canClock: x.can('clock.self'), period: currentPeriod(x.o, x.s), defaultPayCodeId: pay.defaultOf(x.o.id, me.id) };
  });

  /** Where a published shift stands right now: upcoming, late, clocked in or out, or a no-show. */
  function shiftState(o, s, sh, t) {
    const ps = h.all('SELECT * FROM org_punches WHERE shift_id = ? ORDER BY at', sh.id);
    const firstIn = ps.find((p) => p.type === 'in');
    const lastOut = [...ps].reverse().find((p) => p.type === 'out');
    const lastP = ps.at(-1);
    const thr = s.clock.lateThresholdMin;
    let state, minutesLate = 0, arrival = null;
    if (firstIn) {
      minutesLate = Math.max(0, Math.floor((firstIn.at - sh.start_at) / 60000));
      arrival = minutesLate > thr ? 'late' : 'on_time';
      state = lastP.type === 'out' ? 'clocked_out' : 'clocked_in';
    } else if (t >= sh.end_at) state = 'no_show';
    else if (t >= sh.start_at + thr * 60000) { state = 'late'; minutesLate = Math.floor((t - sh.start_at) / 60000); }
    else state = 'upcoming';
    return { state, arrival, minutesLate, clockedInAt: firstIn ? iso(firstIn.at) : null, clockedOutAt: state === 'clocked_out' ? iso(lastOut.at) : null };
  }
  const posNames = (oid) => new Map(h.all('SELECT id, name FROM org_positions WHERE org_id = ?', oid).map((p) => [p.id, p.name]));
  R('GET', '/v1/orgs/:id/clock/today', ({ me, params }) => {
    const x = asOrg(params.id, me);
    const { o, s } = x;
    const t = now(), d = localDate(t, o.tz);
    const from = zonedToUtc(d, '00:00', o.tz), to = zonedToUtc(addDays(d, 1), '00:00', o.tz);
    const nm = names(o.id), pn = posNames(o.id);
    const rows = h.all("SELECT * FROM org_shifts WHERE org_id = ? AND status = 'published' AND account_id IS NOT NULL AND start_at >= ? AND start_at < ? ORDER BY start_at", o.id, from, to)
      .filter((sh) => sh.account_id === me.id || x.can('timecards.view', sh.department_id ?? deptOf(o.id, sh.account_id)));
    return { date: d, now: iso(t), lateThresholdMin: s.clock.lateThresholdMin,
      shifts: rows.map((sh) => ({ shiftId: sh.id, accountId: sh.account_id, name: nm.get(sh.account_id) ?? null, positionId: sh.position_id, positionName: pn.get(sh.position_id) ?? null, start: iso(sh.start_at), end: iso(sh.end_at), ...shiftState(o, s, sh, t) })) };
  });
  R('GET', '/v1/orgs/:id/clock/alerts', ({ me, params }) => {
    const x = asOrg(params.id, me, 'timecards.view');
    const { o, s } = x;
    const t = now(), thr = s.clock.lateThresholdMin * 60000;
    const nm = names(o.id), pn = posNames(o.id);
    const alerts = [];
    for (const sh of h.all("SELECT * FROM org_shifts WHERE org_id = ? AND status = 'published' AND account_id IS NOT NULL AND start_at >= ? AND start_at <= ? ORDER BY start_at DESC", o.id, t - 24 * H, t - thr)) {
      if (!x.can('timecards.view', sh.department_id ?? deptOf(o.id, sh.account_id))) continue;
      const st = shiftState(o, s, sh, t);
      const name = nm.get(sh.account_id) ?? null;
      const base = { shiftId: sh.id, accountId: sh.account_id, name, positionId: sh.position_id, positionName: pn.get(sh.position_id) ?? null, start: iso(sh.start_at), end: iso(sh.end_at), alertAt: iso(sh.start_at + thr) };
      if (!st.clockedInAt) alerts.push({ ...base, type: st.state === 'no_show' ? 'no_show' : 'late', minutesLate: st.state === 'no_show' ? null : st.minutesLate, arrivedAt: null, resolved: false, message: st.state === 'no_show' ? `${name} didn’t clock in` : `${name} hasn’t clocked in (${st.minutesLate} min past start)` });
      else if (st.arrival === 'late') alerts.push({ ...base, type: 'late', minutesLate: st.minutesLate, arrivedAt: st.clockedInAt, resolved: true, message: `${name} clocked in ${st.minutesLate} min late` });
    }
    return { alerts };
  });

  // ---------- missed-punch requests ----------
  const requestOut = (r, nm) => ({ id: r.id, accountId: r.account_id, name: nm ? nm.get(r.account_id) ?? null : undefined, shiftId: r.shift_id, type: r.type, at: iso(r.at), reasonCode: r.reason_code, note: r.note, status: r.status, createdAt: iso(r.created_at), decidedBy: r.decided_by, decidedAt: r.decided_at == null ? null : iso(r.decided_at) });
  R('GET', '/v1/orgs/:id/punch-requests', ({ me, params, query }) => {
    const x = asOrg(params.id, me);
    const status = V.enum(query.status || null, 'Status', ['pending', 'approved', 'denied'], { optional: true });
    const nm = names(x.o.id);
    const rows = h.all(`SELECT * FROM org_punch_requests WHERE org_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT 1000`, ...(status ? [x.o.id, status] : [x.o.id]))
      .filter((r) => r.account_id === me.id || x.can('timecards.approve', deptOf(x.o.id, r.account_id)));
    return { requests: rows.map((r) => requestOut(r, nm)) };
  });
  R('POST', '/v1/orgs/:id/punch-requests', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'clock.self');
    const { o } = x;
    const sh = h.get('SELECT * FROM org_shifts WHERE id = ? AND org_id = ?', V.str(body.shiftId, 'Shift', { min: 1, max: 80 }), o.id) ?? notFound('Shift not found.');
    if (sh.account_id !== me.id) forbidden('You can only ask about punches for your own shifts.');
    const type = V.enum(body.type, 'Punch', ['in', 'out']);
    const at = V.time(body.at, 'Time');
    if (at > now() + 5 * 60000) bad('That time hasn’t happened yet.');
    if (Math.abs(at - sh.start_at) > 36 * H) bad('The time has to be near the shift.');
    const reason = V.enum(body.reasonCode, 'Reason', REASONS);
    const note = V.str(body.note, 'Note', { optional: true, max: 500 });
    if (reason === 'other' && !note) bad('Say what happened in a note.');
    if (h.get("SELECT COUNT(*) AS n FROM org_punch_requests WHERE org_id = ? AND account_id = ? AND status = 'pending'", o.id, me.id).n >= 50) bad('You have 50 requests waiting already.');
    const rid = id();
    h.run("INSERT INTO org_punch_requests (id,org_id,account_id,shift_id,type,at,reason_code,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)", rid, o.id, me.id, sh.id, type, at, reason, note, now());
    audit(me.id, 'org.punch_request', o.id, { request: rid, type }, ip);
    return { status: 201, body: { request: requestOut(h.get('SELECT * FROM org_punch_requests WHERE id = ?', rid), null) } };
  });
  R('POST', '/v1/orgs/:id/punch-requests/:rid/decide', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'timecards.approve');
    const { o } = x;
    const r = h.get('SELECT * FROM org_punch_requests WHERE id = ? AND org_id = ?', params.rid, o.id) ?? notFound('Request not found.');
    x.need('timecards.approve', deptOf(o.id, r.account_id));
    if (r.status !== 'pending') bad(`That request was already ${r.status}.`);
    if (r.account_id === me.id && !x.owner) forbidden('Someone else has to decide your own request.');
    const approve = V.bool(body.approve, 'Approve');
    let punch = null;
    tx(() => {
      h.run('UPDATE org_punch_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'denied', me.id, now(), r.id);
      if (approve) punch = addPunch(o, r.account_id, { shiftId: r.shift_id, type: r.type, at: r.at, source: `request:${r.id}` });
    });
    audit(me.id, approve ? 'org.punch_request_approve' : 'org.punch_request_deny', o.id, { request: r.id, account: r.account_id }, ip);
    notify(r.account_id, 'org', approve ? 'Your missed punch was fixed' : 'Your missed-punch request wasn’t approved', approve ? 'It’s on your timecard now.' : 'Talk to your manager about it.', { data: { orgId: o.id, requestId: r.id, approved: approve } });
    return { request: requestOut(h.get('SELECT * FROM org_punch_requests WHERE id = ?', r.id), names(o.id)), punch: punch ? punchOut(punch) : null };
  });

  // ---------- timecards ----------
  function computeTimecard(o, s, aid, period, nm = names(o.id)) {
    const from = zonedToUtc(addDays(period.start, -1), '00:00', o.tz), to = zonedToUtc(addDays(period.end, 2), '00:00', o.tz);
    const raw = h.all('SELECT * FROM org_punches WHERE org_id = ? AND account_id = ? AND at >= ? AND at < ? ORDER BY at', o.id, aid, from, to);
    const eff = pay.effectiveCodes(o.id, aid, raw);
    const punches = raw.map((p) => ({ id: p.id, type: p.type, at: iso(p.at), source: p.source, shiftId: p.shift_id, shift_id: p.shift_id, restAttested: p.rest_attested == null ? null : !!p.rest_attested, payCodeId: eff.get(p.id) ?? null }));
    const shifts = h.all("SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND status = 'published' AND start_at >= ? AND start_at < ?", o.id, aid, from, to)
      .map((sh) => ({ id: sh.id, start: iso(sh.start_at), end: iso(sh.end_at), positionId: sh.position_id }));
    const tc = timecard(punches, shifts, rulesFor(o, s), { workweekStart: o.workweek_start, tz: o.tz, lateThresholdMin: s.clock.lateThresholdMin, now: now(), periodStart: period.start, periodEnd: period.end });
    const byDate = new Map(tc.days.map((d) => [d.date, d]));
    const days = [];
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
      const r = byDate.get(d) || { workedMin: 0, regularMin: 0, overtimeMin: 0, doubleTimeMin: 0, restPremiumMin: 0, punches: [] };
      const codeOf = new Map(punches.map((p) => [p.id, p.payCodeId]));
      days.push({ date: d, punches: r.punches.map((p) => ({ ...p, payCodeId: codeOf.get(p.id) ?? null })), workedMin: r.workedMin, regularMin: r.regularMin, overtimeMin: r.overtimeMin, doubleTimeMin: r.doubleTimeMin || 0, restPremiumMin: r.restPremiumMin });
    }
    const appr = h.get('SELECT approved_by, at FROM org_timecard_approvals WHERE org_id = ? AND account_id = ? AND period_start = ?', o.id, aid, period.start);
    const inPeriod = punches.filter((p) => { const d = localDate(p.at, o.tz); return d >= period.start && d <= period.end; });
    const timeOff = h.all("SELECT * FROM org_time_off WHERE org_id = ? AND account_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ? ORDER BY start_date", o.id, aid, period.end, period.start).map(timeOffOut);
    return {
      person: { id: aid, name: nm.get(aid) ?? null }, period, days, weeks: tc.weeks, totals: tc.totals, flags: tc.flags,
      approved: appr ? { by: appr.approved_by, at: iso(appr.at) } : null,
      editCount: inPeriod.filter((p) => String(p.source).startsWith('request:')).length,
      lateCount: tc.lateCount, openPunch: tc.open, timeOff,
      pendingRequests: h.get("SELECT COUNT(*) AS n FROM org_punch_requests WHERE org_id = ? AND account_id = ? AND status = 'pending' AND at >= ? AND at < ?", o.id, aid, from, to).n,
    };
  }
  R('GET', '/v1/orgs/:id/timecards', ({ me, params, query }) => {
    const x = asOrg(params.id, me);
    const { o, s } = x;
    const aid = query.accountId ? V.str(query.accountId, 'Person', { min: 1, max: 80 }) : me.id;
    if (aid !== me.id) {
      if (!memberRow(o.id, aid)) notFound('Not a member.');
      x.need('timecards.view', deptOf(o.id, aid));
    }
    return computeTimecard(o, s, aid, parsePeriod(o, s, query.periodStart, currentPeriod(o, s)));
  });
  /** Everyone's timecard for one pay period (by default the last finished one), for approving them together. */
  R('GET', '/v1/orgs/:id/timecards/period', ({ me, params, query }) => {
    const x = asOrg(params.id, me, 'timecards.view');
    const { o, s } = x;
    const period = parsePeriod(o, s, query.periodStart, lastCompleted(o, s));
    const nm = names(o.id);
    const people = core.membersOf(o.id).filter((r) => x.can('timecards.view', r.department_id ?? null)).map((r) => {
      const tc = computeTimecard(o, s, r.account_id, period, nm);
      return { accountId: r.account_id, name: r.display_name, workedMin: tc.totals.workedMin, overtimeMin: tc.totals.overtimeMin, approved: !!tc.approved, flags: tc.flags.length, pendingRequests: tc.pendingRequests, mine: r.account_id === me.id };
    });
    return { period, current: currentPeriod(o, s), people };
  });
  function approveTimecard(x, aid, periodStart, ip) {
    const { o, s } = x;
    if (!memberRow(o.id, aid)) notFound('Not a member.');
    x.need('timecards.approve', deptOf(o.id, aid));
    const period = parsePeriod(o, s, date(periodStart, 'Period start'), null);
    if (aid === x.who.id && !x.owner) forbidden('Someone else has to approve your own timecard.');
    if (h.get('SELECT 1 FROM org_timecard_approvals WHERE org_id = ? AND account_id = ? AND period_start = ?', o.id, aid, period.start)) bad('That timecard is already approved.');
    h.run('INSERT INTO org_timecard_approvals (org_id,account_id,period_start,approved_by,at) VALUES (?,?,?,?,?)', o.id, aid, period.start, x.who.id, now());
    audit(x.who.id, 'org.timecard_approve', o.id, { account: aid, periodStart: period.start }, ip);
    return { approved: { by: x.who.id, at: iso(now()) }, accountId: aid, period };
  }
  R('POST', '/v1/orgs/:id/timecards/approve', ({ me, params, body, ip }) => approveTimecard(asOrg(params.id, me, 'timecards.approve'), V.str(body.accountId, 'Person', { min: 1, max: 80 }), body.periodStart, ip));
  R('POST', '/v1/orgs/:id/timecards/approve-many', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'timecards.approve');
    const ids = list(body.accountIds, 'People', 500);
    return { results: ids.map((aid) => {
      try { return { accountId: aid, ok: true, ...approveTimecard(x, V.str(aid, 'Person', { min: 1, max: 80 }), body.periodStart, ip) }; }
      catch (e) { if (!(e instanceof core.HttpError)) throw e; return { accountId: aid, ok: false, error: e.message }; }
    }) };
  });
  R('POST', '/v1/orgs/:id/timecards/unapprove', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'timecards.approve');
    const aid = V.str(body.accountId, 'Person', { min: 1, max: 80 });
    x.need('timecards.approve', deptOf(x.o.id, aid));
    const period = parsePeriod(x.o, x.s, date(body.periodStart, 'Period start'), null);
    const r = h.run('DELETE FROM org_timecard_approvals WHERE org_id = ? AND account_id = ? AND period_start = ?', x.o.id, aid, period.start);
    if (!Number(r.changes)) bad('That timecard isn’t approved.');
    audit(me.id, 'org.timecard_unapprove', x.o.id, { account: aid, periodStart: period.start }, ip);
    return { ok: true };
  });

  // ---------- time off ----------
  function timeOffOut(r, nm = null) {
    return { id: r.id, accountId: r.account_id, ...(nm ? { name: nm.get(r.account_id) ?? null } : {}), kind: r.kind, startDate: r.start_date, endDate: r.end_date, hours: r.hours, status: r.status, createdAt: iso(r.created_at), decidedBy: r.decided_by, decidedAt: r.decided_at == null ? null : iso(r.decided_at) };
  }
  const timeOffRow = (oid, tid) => h.get('SELECT * FROM org_time_off WHERE id = ? AND org_id = ?', tid, oid) ?? notFound('Time off request not found.');
  R('GET', '/v1/orgs/:id/time-off', ({ me, params, query }) => {
    const x = asOrg(params.id, me);
    const status = V.enum(query.status || null, 'Status', ['pending', 'approved', 'denied', 'cancelled'], { optional: true });
    const from = query.from ? date(query.from, 'From') : addDays(localDate(now(), x.o.tz), -62);
    const nm = names(x.o.id);
    const rows = h.all(`SELECT * FROM org_time_off WHERE org_id = ? AND end_date >= ?${status ? ' AND status = ?' : ''} ORDER BY start_date LIMIT 2000`, ...(status ? [x.o.id, from, status] : [x.o.id, from]))
      .filter((r) => r.account_id === me.id || x.can('timeoff.decide', deptOf(x.o.id, r.account_id)) || (r.status === 'approved' && x.can('schedule.edit', deptOf(x.o.id, r.account_id))));
    return { timeOff: rows.map((r) => timeOffOut(r, nm)), kinds: x.s.timeOffKinds };
  });
  R('POST', '/v1/orgs/:id/time-off', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'timeoff.request');
    const { o, s } = x;
    const kind = V.enum(V.str(body.kind ?? 'vacation', 'Kind', { min: 1, max: 30 }).toLowerCase(), 'Kind', s.timeOffKinds);
    const start = date(body.startDate, 'First day'), end = date(body.endDate ?? body.startDate, 'Last day');
    if (end < start) bad('The last day must be on or after the first.');
    if (dayNum(end) - dayNum(start) > 366) bad('Ask for at most a year at a time.');
    const hours = body.hours == null ? null : (() => { const n = Number(body.hours); if (!Number.isFinite(n) || n <= 0 || n > 24 * 367) bad('Hours must be a number above 0.'); return Math.round(n * 100) / 100; })();
    if (h.get("SELECT COUNT(*) AS n FROM org_time_off WHERE org_id = ? AND account_id = ? AND status = 'pending'", o.id, me.id).n >= 50) bad('You have 50 requests waiting already.');
    if (h.get("SELECT 1 FROM org_time_off WHERE org_id = ? AND account_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?", o.id, me.id, end, start)) bad('You already asked for time off on some of those days.');
    const tid = id();
    h.run("INSERT INTO org_time_off (id,org_id,account_id,kind,start_date,end_date,hours,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)", tid, o.id, me.id, kind, start, end, hours, now());
    audit(me.id, 'org.timeoff_request', o.id, { request: tid }, ip);
    return { status: 201, body: { timeOff: timeOffOut(timeOffRow(o.id, tid)) } };
  });
  R('POST', '/v1/orgs/:id/time-off/:tid/cancel', ({ me, params, ip }) => {
    const x = asOrg(params.id, me);
    const r = timeOffRow(x.o.id, params.tid);
    if (r.account_id !== me.id) forbidden('Only the person who asked can take it back.');
    if (!['pending', 'approved'].includes(r.status)) bad(`That request is already ${r.status}.`);
    if (r.status === 'approved' && r.start_date <= localDate(now(), x.o.tz)) bad('That time off has started. Ask your manager to change it.');
    h.run("UPDATE org_time_off SET status = 'cancelled', decided_at = ? WHERE id = ?", now(), r.id);
    audit(me.id, 'org.timeoff_cancel', x.o.id, { request: r.id }, ip);
    return { timeOff: timeOffOut(timeOffRow(x.o.id, r.id)) };
  });
  R('POST', '/v1/orgs/:id/time-off/:tid/decide', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'timeoff.decide');
    const r = timeOffRow(x.o.id, params.tid);
    x.need('timeoff.decide', deptOf(x.o.id, r.account_id));
    if (r.account_id === me.id && !x.owner) forbidden('Someone else has to decide your own time off.');
    const approve = V.bool(body.approve, 'Approve');
    if (!(r.status === 'pending' || (r.status === 'approved' && !approve))) bad(`That request is already ${r.status}.`);
    h.run('UPDATE org_time_off SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'denied', me.id, now(), r.id);
    audit(me.id, approve ? 'org.timeoff_approve' : 'org.timeoff_deny', x.o.id, { request: r.id, account: r.account_id }, ip);
    notify(r.account_id, 'org', approve ? `Time off approved: ${r.start_date}${r.end_date !== r.start_date ? ` to ${r.end_date}` : ''}` : 'Your time off wasn’t approved', approve ? '' : 'Talk to your manager about it.', { data: { orgId: x.o.id, timeOffId: r.id, approved: approve } });
    return { timeOff: timeOffOut(timeOffRow(x.o.id, r.id), names(x.o.id)) };
  });

  return { computeTimecard, periodOf, currentPeriod, lastCompleted, addPunch };
}
