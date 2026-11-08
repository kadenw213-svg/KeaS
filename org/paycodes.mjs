// Pay codes: a job's pay rate (Lifeguard $15, Swim instructor $18). The owner, or anyone with paycodes.manage, makes
// them; anyone with paycodes.assign gives them to people. Each person has one default code. Every shift and punch
// carries a code, and a person switches freely among the codes they were given (no approval); they never see codes
// they weren't given. People always see their own codes, rates and hours (GET /v1/orgs/:id/me/pay); seeing other
// people's rates is rates.view.
//
// Rates are never stored in plain text. Each one is sealed with AES-256-GCM (server/lib/vault.mjs) under the org data
// key the host hands mountOrg (dataKey: 32 bytes), bound to the code's id, so a rate copied to another code doesn't
// open. The key is the server's, not the payroll vault's: a KeaS server opens rates while it runs, with no payroll
// passphrase. The Kea Hub keeps it in its data folder as org-data.key (hub/index.mjs; see docs/DEVELOPING.md).
//
// The payroll vault reads the hours to pay from here (payFeed, and GET /v1/orgs/:id/pay-feed): people, punches with
// their effective codes, the codes' rates, and whether timecards are approved. SSNs, bank details, tax forms, pay
// runs and stubs stay in the vault.
import { seal, unseal, isSealed, sealContext } from '../server/lib/vault.mjs';
import { pairPunches } from '../server/lib/rules.mjs';
import { localDate, zonedToUtc, addDays, iso, dayNum } from '../server/lib/time.mjs';

const MAX_CODES = 500;
const MAX_RATE = 10_000; // dollars an hour
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** The host's org data key as 32 bytes (a Buffer, or 64 hex characters), or null when the host gave none. */
export function dataKeyFrom(k) {
  if (k == null || k === '') return null;
  const b = Buffer.isBuffer(k) ? Buffer.from(k) : typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k.trim()) ? Buffer.from(k.trim(), 'hex') : null;
  if (!b || b.length !== 32) throw new Error('The org data key must be 32 bytes (64 hex characters).');
  return b;
}

/** Seals and opens pay code rates (whole cents) with the org data key, each bound to its code's id. */
export function makeRateSealer(key) {
  const ctx = (cid) => sealContext('org_pay_codes', 'rate', [cid]);
  return {
    seal: (cid, cents) => seal(key, String(cents), ctx(cid)),
    open(cid, v) {
      if (!isSealed(v)) throw new Error(`The pay rate of code ${cid} isn't sealed. The organization database may have been changed outside KeaS.`);
      const n = Number(unseal(key, v, ctx(cid)));
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`The pay rate of code ${cid} doesn't open as an amount.`);
      return n;
    },
  };
}

/** What the rest of the engine uses: who has which code, defaults, effective codes for punches and shifts. */
export function makePayLogic(core, sealer) {
  const { h, bad, notFound, HttpError } = core;
  const noKey = () => { throw new HttpError(503, 'This server has no org data key, so it can’t keep pay rates. Ask whoever runs the server.'); };
  const codeRow = (oid, cid) => h.get('SELECT * FROM org_pay_codes WHERE id = ? AND org_id = ?', cid, oid) ?? notFound('That pay code is not in this organization.');
  const rateOf = (r) => (sealer ? sealer.open(r.id, r.rate) : noKey());
  const grantRows = (oid, aid) => h.all('SELECT g.*, c.name, c.active, c.color, c.kind, c.rate, c.id AS cid, c.department_id, c.position_id FROM org_member_pay_codes g JOIN org_pay_codes c ON c.id = g.code_id WHERE g.org_id = ? AND g.account_id = ? ORDER BY g.is_default DESC, c.name, c.id', oid, aid);
  const defaultOf = (oid, aid) => (aid ? h.get('SELECT code_id FROM org_member_pay_codes WHERE org_id = ? AND account_id = ? AND is_default = 1', oid, aid)?.code_id ?? null : null);
  const granted = (oid, aid, cid) => !!(aid && cid && h.get('SELECT 1 FROM org_member_pay_codes WHERE org_id = ? AND account_id = ? AND code_id = ?', oid, aid, cid));
  /**
   * A code asked for on a shift or punch of `aid`: in the organization, turned on, and given to them (an open shift
   * with nobody on it takes any code that's on). Returns its id.
   */
  function pickFor(oid, aid, v) {
    if (typeof v !== 'string' || !v || v.length > 80) bad('Pick a pay code.');
    const r = h.get('SELECT * FROM org_pay_codes WHERE id = ? AND org_id = ?', v, oid) ?? bad('That pay code is not in this organization.');
    if (!r.active) bad(`${r.name} is turned off. Pick another pay code.`);
    if (aid && !granted(oid, aid, r.id)) bad('That pay code wasn’t given to this person. Pick one of their codes.');
    return r.id;
  }
  /** Each punch's code: one switched later, else the punch's own, else its shift's, else the person's default now. */
  function effectiveCodes(oid, aid, punches) {
    const ids = punches.map((p) => p.id);
    const over = ids.length ? new Map(h.all('SELECT punch_id, pay_code_id FROM org_punch_codes WHERE punch_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).map((r) => [r.punch_id, r.pay_code_id])) : new Map();
    const shiftIds = [...new Set(punches.map((p) => p.shift_id).filter(Boolean))];
    const shiftCode = shiftIds.length ? new Map(h.all('SELECT id, pay_code_id FROM org_shifts WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(shiftIds)).map((r) => [r.id, r.pay_code_id])) : new Map();
    const def = defaultOf(oid, aid);
    return new Map(punches.map((p) => [p.id, over.get(p.id) ?? p.pay_code_id ?? (p.shift_id ? shiftCode.get(p.shift_id) : null) ?? def]));
  }
  /**
   * Worked minutes by code for one person between two local dates (each stretch from clock-in to clock-out is paid at
   * the clock-in punch's code). Returns { byCode: Map(code id | null -> minutes), pairs }.
   */
  function workedByCode(o, aid, from, to, nowMs) {
    const fromMs = zonedToUtc(addDays(from, -1), '00:00', o.tz), toMs = zonedToUtc(addDays(to, 2), '00:00', o.tz);
    const rows = h.all('SELECT * FROM org_punches WHERE org_id = ? AND account_id = ? AND at >= ? AND at < ? ORDER BY at', o.id, aid, fromMs, toMs);
    const eff = effectiveCodes(o.id, aid, rows);
    const { pairs } = pairPunches(rows.map((p) => ({ id: p.id, type: p.type, at: iso(p.at), code: eff.get(p.id) ?? null })), { now: nowMs });
    const byCode = new Map();
    for (const pr of pairs) {
      const code = pr.in.code ?? null;
      for (let t = pr.start; t < pr.end; t += 60_000) {
        const d = localDate(t, o.tz);
        if (d >= from && d <= to) byCode.set(code, (byCode.get(code) || 0) + 1);
      }
    }
    return { byCode, pairs };
  }
  return { sealer, codeRow, rateOf, grantRows, defaultOf, granted, pickFor, effectiveCodes, workedByCode, hasKey: () => !!sealer, requireKey: () => { if (!sealer) noKey(); } };
}

/**
 * The pay code routes. R: the org router through the payroll guard with rates allowed (pay codes carry rates); Rplain:
 * the usual guard. clock: the time clock's periods and timecards.
 */
export function mountPayCodes(core, { R, Rplain, deptRow, positionRow, clock }) {
  const { h, now, audit, notify, V, bad, forbidden, notFound, tx, id, asOrg, memberRow, names, pay } = core;
  const deptOf = (oid, aid) => memberRow(oid, aid)?.department_id ?? null;

  const rateIn = (v) => {
    const n = typeof v === 'string' && v.trim() ? Number(v.trim().replace(/^\$/, '')) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_RATE) bad(`The rate must be an amount an hour from 0 to ${MAX_RATE}.`);
    const cents = Math.round(n * 100);
    if (Math.abs(cents - n * 100) > 1e-6) bad('The rate can have at most two decimal places.');
    return cents;
  };
  const colorIn = (v) => { if (v == null || v === '') return null; if (typeof v !== 'string' || !COLOR.test(v)) bad('A color looks like #2a7fff.'); return v.toLowerCase(); };
  const codeOut = (r, showRate, extra = {}) => ({
    id: r.id, name: r.name, kind: r.kind, color: r.color ?? null, active: !!r.active, departmentId: r.department_id ?? null, positionId: r.position_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at ?? null,
    ...(showRate ? { rateCents: pay.rateOf(r), rate: pay.rateOf(r) / 100 } : {}), ...extra,
  });
  /** May see this code's rate: paycodes.manage, or rates.view where the code belongs (the whole org when nowhere). */
  const seesRate = (x, r) => x.can('paycodes.manage', null) || x.can('rates.view', r.department_id ?? null);
  const seesCodes = (x) => ['paycodes.manage', 'paycodes.assign', 'rates.view', 'schedule.edit', 'timecards.approve'].some((a) => x.can(a));

  R('GET', '/v1/orgs/:id/pay-codes', ({ me, params }) => {
    const x = asOrg(params.id, me);
    if (!seesCodes(x)) forbidden('Your own pay codes are under My pay.');
    const holders = new Map(h.all('SELECT code_id, COUNT(*) AS n FROM org_member_pay_codes WHERE org_id = ? GROUP BY code_id', x.o.id).map((r) => [r.code_id, r.n]));
    const rows = h.all('SELECT * FROM org_pay_codes WHERE org_id = ? ORDER BY active DESC, name, id', x.o.id);
    return {
      codes: rows.map((r) => codeOut(r, seesRate(x, r), { holders: holders.get(r.id) || 0 })),
      canManage: x.can('paycodes.manage', null), canAssign: x.can('paycodes.assign'), canSeeRates: x.can('rates.view') || x.can('paycodes.manage', null), hasKey: pay.hasKey(),
    };
  });
  R('POST', '/v1/orgs/:id/pay-codes', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'paycodes.manage', { dept: null });
    pay.requireKey();
    if (h.get('SELECT COUNT(*) AS n FROM org_pay_codes WHERE org_id = ?', x.o.id).n >= MAX_CODES) bad(`An organization can have at most ${MAX_CODES} pay codes.`);
    const name = V.name(body.name, 'Name', { max: 60 });
    if (h.get('SELECT 1 FROM org_pay_codes WHERE org_id = ? AND lower(name) = lower(?) AND active = 1', x.o.id, name)) bad(`There’s already a pay code called ${name}.`);
    const cents = rateIn(body.rate);
    const cid = id();
    h.run('INSERT INTO org_pay_codes (id,org_id,name,rate,kind,color,active,department_id,position_id,created_by,created_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
      cid, x.o.id, name, pay.sealer.seal(cid, cents), 'hourly', colorIn(body.color),
      body.departmentId ? deptRow(x.o.id, body.departmentId).id : null, body.positionId ? positionRow(x.o.id, body.positionId).id : null, me.id, now());
    // (Rates never go into the audit log.)
    audit(me.id, 'org.paycode_create', x.o.id, { code: cid, name }, ip);
    return { status: 201, body: { code: codeOut(pay.codeRow(x.o.id, cid), true, { holders: 0 }) } };
  });
  R('POST', '/v1/orgs/:id/pay-codes/:cid', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'paycodes.manage', { dept: null });
    const r = pay.codeRow(x.o.id, params.cid);
    const set = {};
    if ('name' in body) {
      set.name = V.name(body.name, 'Name', { max: 60 });
      if (h.get('SELECT 1 FROM org_pay_codes WHERE org_id = ? AND lower(name) = lower(?) AND active = 1 AND id != ?', x.o.id, set.name, r.id)) bad(`There’s already a pay code called ${set.name}.`);
    }
    if ('rate' in body) { pay.requireKey(); set.rate = pay.sealer.seal(r.id, rateIn(body.rate)); }
    if ('color' in body) set.color = colorIn(body.color);
    if ('active' in body) set.active = V.bool(body.active, 'On') ? 1 : 0;
    if ('departmentId' in body) set.department_id = body.departmentId ? deptRow(x.o.id, body.departmentId).id : null;
    if ('positionId' in body) set.position_id = body.positionId ? positionRow(x.o.id, body.positionId).id : null;
    if (!Object.keys(set).length) bad('Nothing to change.');
    set.updated_at = now();
    h.run(`UPDATE org_pay_codes SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), r.id);
    audit(me.id, 'org.paycode_update', x.o.id, { code: r.id, ...(set.name ? { name: set.name } : {}), ...('rate' in set ? { rateChanged: true } : {}), ...('active' in set ? { active: !!set.active } : {}) }, ip);
    return { code: codeOut(pay.codeRow(x.o.id, r.id), true) };
  });
  R('POST', '/v1/orgs/:id/pay-codes/:cid/delete', ({ me, params, ip }) => {
    const x = asOrg(params.id, me, 'paycodes.manage', { dept: null });
    const r = pay.codeRow(x.o.id, params.cid);
    const used = h.get('SELECT 1 FROM org_shifts WHERE pay_code_id = ? UNION SELECT 1 FROM org_punches WHERE pay_code_id = ? UNION SELECT 1 FROM org_punch_codes WHERE pay_code_id = ? LIMIT 1', r.id, r.id, r.id);
    if (used) throw new core.HttpError(409, `${r.name} is on shifts or punches already, so it stays for pay. Turn it off instead.`);
    h.run('DELETE FROM org_pay_codes WHERE id = ?', r.id);
    audit(me.id, 'org.paycode_delete', x.o.id, { code: r.id, name: r.name }, ip);
    return { ok: true };
  });

  // ---------- people's codes ----------
  const memberCodesOut = (oid, aid, showRate) => pay.grantRows(oid, aid).map((g) => ({
    id: g.code_id, name: g.name, kind: g.kind, color: g.color ?? null, active: !!g.active, default: !!g.is_default, grantedAt: g.granted_at,
    ...(showRate ? { rateCents: pay.rateOf({ id: g.code_id, rate: g.rate }), rate: pay.rateOf({ id: g.code_id, rate: g.rate }) / 100 } : {}),
  }));
  const target = (x, aid) => { if (!memberRow(x.o.id, aid)) notFound('Not a member.'); return { aid, dept: deptOf(x.o.id, aid) }; };
  R('GET', '/v1/orgs/:id/members/:aid/pay-codes', ({ me, params }) => {
    const x = asOrg(params.id, me);
    const { aid, dept } = target(x, params.aid);
    const self = aid === me.id;
    if (!self && !x.can('paycodes.assign', dept) && !x.can('rates.view', dept) && !x.can('schedule.edit', dept) && !x.can('timecards.approve', dept)) forbidden('You can only see your own pay codes.');
    return { accountId: aid, codes: memberCodesOut(x.o.id, aid, self || x.can('rates.view', dept) || x.can('paycodes.manage', null)) };
  });
  const assigner = (me, params) => {
    const x = asOrg(params.id, me, 'paycodes.assign');
    const t = target(x, params.aid);
    x.need('paycodes.assign', t.dept);
    if (t.aid === me.id && !x.owner) forbidden('Someone else has to give you pay codes.');
    return { x, ...t };
  };
  /** After a change to someone's codes: they have a default whenever they have any code. */
  const keepDefault = (oid, aid) => {
    if (pay.defaultOf(oid, aid)) return;
    const first = h.get('SELECT code_id FROM org_member_pay_codes WHERE org_id = ? AND account_id = ? ORDER BY granted_at, code_id LIMIT 1', oid, aid);
    if (first) h.run('UPDATE org_member_pay_codes SET is_default = 1 WHERE org_id = ? AND account_id = ? AND code_id = ?', oid, aid, first.code_id);
  };
  const setDefault = (oid, aid, cid) => {
    h.run('UPDATE org_member_pay_codes SET is_default = 0 WHERE org_id = ? AND account_id = ? AND is_default = 1', oid, aid);
    h.run('UPDATE org_member_pay_codes SET is_default = 1 WHERE org_id = ? AND account_id = ? AND code_id = ?', oid, aid, cid);
  };
  R('POST', '/v1/orgs/:id/members/:aid/pay-codes', ({ me, params, body, ip }) => {
    const { x, aid } = assigner(me, params);
    const r = pay.codeRow(x.o.id, V.str(body.codeId, 'Pay code', { min: 1, max: 80 }));
    if (!r.active) bad(`${r.name} is turned off.`);
    const makeDefault = V.bool(body.default ?? false, 'Default');
    const had = pay.granted(x.o.id, aid, r.id);
    tx(() => {
      if (!had) h.run('INSERT INTO org_member_pay_codes (org_id,account_id,code_id,is_default,granted_by,granted_at) VALUES (?,?,?,0,?,?)', x.o.id, aid, r.id, me.id, now());
      if (makeDefault) setDefault(x.o.id, aid, r.id);
      keepDefault(x.o.id, aid);
    });
    audit(me.id, 'org.paycode_grant', x.o.id, { account: aid, code: r.id, default: makeDefault }, ip);
    if (!had) notify(aid, 'org', `You were given the pay code ${r.name}`, 'You can pick it on your shifts and when you clock in. Your codes and rates are under My pay.', { data: { orgId: x.o.id, payCodeId: r.id } });
    return { status: had ? 200 : 201, body: { accountId: aid, codes: memberCodesOut(x.o.id, aid, true) } };
  });
  R('POST', '/v1/orgs/:id/members/:aid/pay-codes/:cid/default', ({ me, params, ip }) => {
    const { x, aid } = assigner(me, params);
    const r = pay.codeRow(x.o.id, params.cid);
    if (!pay.granted(x.o.id, aid, r.id)) bad('Give them that code first.');
    tx(() => setDefault(x.o.id, aid, r.id));
    audit(me.id, 'org.paycode_default', x.o.id, { account: aid, code: r.id }, ip);
    return { accountId: aid, codes: memberCodesOut(x.o.id, aid, true) };
  });
  R('POST', '/v1/orgs/:id/members/:aid/pay-codes/:cid/delete', ({ me, params, ip }) => {
    const { x, aid } = assigner(me, params);
    const r = pay.codeRow(x.o.id, params.cid);
    if (!pay.granted(x.o.id, aid, r.id)) bad('They don’t have that code.');
    tx(() => {
      h.run('DELETE FROM org_member_pay_codes WHERE org_id = ? AND account_id = ? AND code_id = ?', x.o.id, aid, r.id);
      keepDefault(x.o.id, aid);
      // Their shifts still to come move to their default code; hours already worked keep the code they were worked at.
      h.run('UPDATE org_shifts SET pay_code_id = ? WHERE org_id = ? AND account_id = ? AND pay_code_id = ? AND start_at > ?', pay.defaultOf(x.o.id, aid), x.o.id, aid, r.id, now());
    });
    audit(me.id, 'org.paycode_ungrant', x.o.id, { account: aid, code: r.id }, ip);
    return { accountId: aid, codes: memberCodesOut(x.o.id, aid, true) };
  });

  // ---------- switching the code on a shift or a punch ----------
  /** My own shift: any of my codes. Someone else's: schedule.edit where the shift is, and one of their codes. */
  Rplain('POST', '/v1/orgs/:id/shifts/:shid/pay-code', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me);
    const sh = h.get('SELECT * FROM org_shifts WHERE id = ? AND org_id = ?', params.shid, x.o.id) ?? notFound('Shift not found.');
    if (sh.account_id !== me.id) x.need('schedule.edit', sh.department_id ?? null);
    const cid = pay.pickFor(x.o.id, sh.account_id, body.payCodeId);
    h.run('UPDATE org_shifts SET pay_code_id = ? WHERE id = ?', cid, sh.id);
    audit(me.id, 'org.shift_paycode', x.o.id, { shift: sh.id, code: cid }, ip);
    return { shiftId: sh.id, payCodeId: cid };
  });
  /**
   * My own punch (clock.self), or someone's with timecards.approve where they work. The code is set on the clock-in
   * of that stretch (a clock-out names its clock-in). Not once the timecard for that pay period is approved.
   */
  Rplain('POST', '/v1/orgs/:id/punches/:pid/pay-code', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me);
    let p = h.get('SELECT * FROM org_punches WHERE id = ? AND org_id = ?', params.pid, x.o.id) ?? notFound('Punch not found.');
    if (p.account_id === me.id) x.need('clock.self');
    else x.need('timecards.approve', deptOf(x.o.id, p.account_id));
    if (p.type === 'out') p = h.get("SELECT * FROM org_punches WHERE org_id = ? AND account_id = ? AND type = 'in' AND at <= ? ORDER BY at DESC, created_at DESC LIMIT 1", x.o.id, p.account_id, p.at) ?? bad('That clock-out has no clock-in before it.');
    const period = clock.periodOf(x.o, x.s, localDate(p.at, x.o.tz));
    if (h.get('SELECT 1 FROM org_timecard_approvals WHERE org_id = ? AND account_id = ? AND period_start = ?', x.o.id, p.account_id, period.start)) bad('That timecard is approved. Ask for it to be unapproved first.');
    const cid = pay.pickFor(x.o.id, p.account_id, body.payCodeId);
    h.run('INSERT INTO org_punch_codes (punch_id,pay_code_id,set_by,set_at) VALUES (?,?,?,?) ON CONFLICT(punch_id) DO UPDATE SET pay_code_id = excluded.pay_code_id, set_by = excluded.set_by, set_at = excluded.set_at', p.id, cid, me.id, now());
    audit(me.id, 'org.punch_paycode', x.o.id, { punch: p.id, account: p.account_id, code: cid }, ip);
    return { punchId: p.id, payCodeId: cid };
  });

  // ---------- my pay ----------
  /** Everything about my pay that's assigned to me: my codes and rates, and my hours by code for a pay period. */
  Rplain('GET', '/v1/orgs/:id/me/pay', ({ me, params, query }) => {
    const x = asOrg(params.id, me);
    const { o, s } = x;
    const cur = clock.currentPeriod(o, s);
    const period = query.periodStart ? clock.periodOf(o, s, core.kit.V.str(query.periodStart, 'Period start', { min: 10, max: 10 })) : cur;
    if (query.periodStart && period.start !== query.periodStart) bad(`That isn’t the first day of a pay period. Try ${period.start}.`);
    const codes = memberCodesOut(o.id, me.id, true);
    const tc = clock.computeTimecard(o, s, me.id, period);
    const { byCode } = pay.workedByCode(o, me.id, period.start, period.end, now());
    const known = new Map(codes.map((c) => [c.id, c]));
    const hours = [...byCode].map(([cid, min]) => {
      const c = cid ? known.get(cid) ?? (() => { const r = h.get('SELECT * FROM org_pay_codes WHERE id = ?', cid); return r && { id: r.id, name: r.name, color: r.color, rateCents: pay.rateOf(r), rate: pay.rateOf(r) / 100, granted: false }; })() : null;
      return { codeId: cid, name: c?.name ?? null, color: c?.color ?? null, rateCents: c?.rateCents ?? null, minutes: min, hours: +(min / 60).toFixed(2), ...(c && c.granted === false ? { noLongerGiven: true } : {}) };
    }).sort((a, b) => b.minutes - a.minutes);
    return {
      period, current: cur, codes, defaultCodeId: codes.find((c) => c.default)?.id ?? null, hours,
      totals: { workedMin: tc.totals.workedMin, regularMin: tc.totals.regularMin, overtimeMin: tc.totals.overtimeMin, doubleTimeMin: tc.totals.doubleTimeMin || 0 },
      approved: tc.approved,
      note: 'Pay stubs come from payroll: open Pay stubs in KeaS Payroll, or ask your payroll admin.',
    };
  });

  // ---------- the payroll vault's feed ----------
  R('GET', '/v1/orgs/:id/pay-feed', ({ me, params, query, ip }) => {
    const x = asOrg(params.id, me);
    x.need('rates.view', null);
    x.need('timecards.view', null);
    const from = V.str(query.from, 'From', { min: 10, max: 10 }), to = V.str(query.to, 'To', { min: 10, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) bad('From and to must be dates like 2026-12-01, to on or after from.');
    if (dayNum(to) - dayNum(from) > 62) bad('Ask for at most 62 days at a time.');
    audit(me.id, 'org.pay_feed', x.o.id, { from, to }, ip);
    return payFeed(x.o.id, { from, to });
  });

  /**
   * What the payroll vault needs to pay a period (from..to, local dates): the codes and their rates, and for each
   * member their punches with effective codes, published shifts, whether every timecard period it touches is approved,
   * and missed-punch requests still waiting.
   */
  function payFeed(oid, { from, to }) {
    const o = core.loadOrg(oid) ?? notFound('Organization not found.');
    const s = core.orgSettings(o);
    const fromMs = zonedToUtc(addDays(from, -1), '00:00', o.tz), toMs = zonedToUtc(addDays(to, 2), '00:00', o.tz);
    const codes = h.all('SELECT * FROM org_pay_codes WHERE org_id = ? ORDER BY name, id', oid).map((r) => ({ id: r.id, name: r.name, kind: r.kind, active: !!r.active, rateCents: pay.rateOf(r), departmentId: r.department_id ?? null, positionId: r.position_id ?? null }));
    const periods = [];
    for (let p = clock.periodOf(o, s, from); p.start <= to; p = clock.periodOf(o, s, addDays(p.end, 1))) periods.push(p.start);
    const members = h.all("SELECT * FROM org_members WHERE org_id = ? AND status = 'active'", oid);
    const prof = core.profilesOf(members.map((m) => m.account_id));
    const people = members.map((m) => {
      const aid = m.account_id;
      const rows = h.all('SELECT * FROM org_punches WHERE org_id = ? AND account_id = ? AND at >= ? AND at < ? ORDER BY at', oid, aid, fromMs, toMs);
      const eff = pay.effectiveCodes(oid, aid, rows);
      const def = pay.defaultOf(oid, aid);
      const shifts = h.all("SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND status = 'published' AND start_at >= ? AND start_at < ? ORDER BY start_at", oid, aid, fromMs, toMs);
      const approvedAll = periods.every((ps) => h.get('SELECT 1 FROM org_timecard_approvals WHERE org_id = ? AND account_id = ? AND period_start = ?', oid, aid, ps));
      const p = prof.get(aid);
      return {
        accountId: aid, name: p?.name ?? '', email: p?.email ?? null, departmentId: m.department_id ?? null, title: m.title ?? null,
        defaultCodeId: def, codeIds: pay.grantRows(oid, aid).map((g) => g.code_id),
        approved: approvedAll,
        pendingRequests: h.get("SELECT COUNT(*) AS n FROM org_punch_requests WHERE org_id = ? AND account_id = ? AND status = 'pending' AND at >= ? AND at < ?", oid, aid, fromMs, toMs).n,
        punches: rows.map((r) => ({ id: r.id, type: r.type, at: iso(r.at), shiftId: r.shift_id ?? null, payCodeId: eff.get(r.id) ?? null, source: r.source, restAttested: r.rest_attested == null ? null : !!r.rest_attested })),
        shifts: shifts.map((sh) => ({ id: sh.id, start: iso(sh.start_at), end: iso(sh.end_at), positionId: sh.position_id, departmentId: sh.department_id ?? null, payCodeId: sh.pay_code_id ?? def })),
      };
    });
    return { v: 1, org: { id: o.id, name: o.name, state: o.state ?? null, tz: o.tz, workweekStart: o.workweek_start }, from, to, timecardPeriods: periods, codes, people, generatedAt: iso(now()) };
  }
  return { payFeed };
}
