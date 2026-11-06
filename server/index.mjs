// KeaS workforce server: schedules, punches, timecards, certifications and pay-run preparation (127.0.0.1 only).
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serveStatic, securityHeaders, DEFAULT_WEB_DIR } from './static.mjs';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB, rowToPerson, rowToOrg, rowToShift, rowToPosition, rowToCertType, rowToPunch, rowToRequest, rowToSwap } from './db.mjs';
import { seed } from './seed.mjs';
import { mergeRules, checkAssignment, timecard, unforceable, isBlocked } from './lib/rules.mjs';
import { makeVault, openDevVault, VaultLocked } from './payroll/vaultstate.mjs';
import { makeHubClient, checkHubUrl } from './payroll/hub.mjs';
import { makeTables } from './payroll/run.mjs';
import { makeApprovals } from './payroll/approvals.mjs';
import { registerPayroll } from './payroll/index.mjs';
import { localDate, zonedToUtc, addDays, dayNum, iso, toMs, ageOn } from './lib/time.mjs';

export const VERSION = '0.3.0';
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const SESSION_HOURS = 12;
export const COOKIE = 'keas_session';
const SHARED = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => { throw new HttpError(400, m, extra); };

// ---------- tiny validation ----------
const V = {
  str(v, name, { optional = false, max = 500, min = 0 } = {}) { if (v == null && optional) return null; if (typeof v !== 'string' || v.length < min || v.length > max) bad(`${name} must be a string (${min}-${max} chars)`); return v; },
  id(v, name, opt) { return V.str(v, name, { ...opt, max: 100, min: 1 }); },
  bool(v, name, { optional = false } = {}) { if (v == null && optional) return null; if (typeof v !== 'boolean') bad(`${name} must be true or false`); return v; },
  enum(v, name, list, { optional = false } = {}) { if (v == null && optional) return null; if (!list.includes(v)) bad(`${name} must be one of ${list.join(', ')}`); return v; },
  iso(v, name, { optional = false } = {}) { if (v == null && optional) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) bad(`${name} must be an ISO date-time`); return new Date(v).toISOString(); },
  date(v, name, { optional = false } = {}) { if ((v == null || v === '') && optional) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) bad(`${name} must be YYYY-MM-DD`); return v; },
  obj(v) { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) bad('body must be a JSON object'); return v; },
};

// ---------- cookies & CSRF ----------
const sessionCookie = (token, maxAge, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { const v = part.slice(i + 1).trim(); return /^[0-9a-f]{64}$/.test(v) ? v : null; }
  }
  return null;
}
/** True unless the browser tells us the request came from another site. Non-browser clients send neither header. */
function sameOrigin(req, secure) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin == null) return true;
  return origin === `${secure ? 'https' : 'http'}://${req.headers.host}`;
}

// ---------- server ----------
/**
 * vault: true runs the payroll vault (the payroll admin's own PC): it starts locked and empty, and payroll admins sign
 * in with their Kea Hub account plus the vault passphrase. Otherwise the workforce server runs with its vault opened by
 * `passphrase` (the KeaS app keeps it protected by Windows), and fills an empty database with the sample workplace.
 *
 * hubUrl: the Kea Hub payroll admins sign in at, set by the KeaS app (never by a request). localSignIn: true, or a
 * function returning it, when the owner turned on local passwords in the KeaS app. devKeyFile: development and tests
 * only, keep a generated passphrase in a file next to the database (never for a real organization's data).
 */
export function createApp({ dbFile = process.env.KEA_DB || DEFAULT_DB, webDir = process.env.KEAS_WEB_DIR || DEFAULT_WEB_DIR, log = true, now = () => Date.now(),
  vault: vaultMode = process.env.KEAS_VAULT === '1', hubUrl = process.env.KEAS_HUB_URL || null, sharedDir = SHARED, passphrase = process.env.KEAS_VAULT_PASSPHRASE || null, fetchImpl = globalThis.fetch,
  localSignIn = false, devKeyFile = dbFile === DEFAULT_DB || dbFile === ':memory:' || process.env.KEAS_DEV_KEYFILE === '1' } = {}) {
  const fixedHubUrl = checkHubUrl(hubUrl);
  const h = openDb(dbFile);
  const vault = makeVault(h);
  if (vaultMode) h.run('DELETE FROM sessions');
  else {
    try { openDevVault(vault, dbFile, passphrase, { keyFile: devKeyFile }); } catch (e) { h.close(); throw e; }
    if (h.isEmpty()) seed(h, { now: now(), vault });
  }
  const us = readJson(join(sharedDir, 'labor', 'US.json'));
  const tablesFor = makeTables(sharedDir);

  const loadOrg = (id) => rowToOrg(h.get('SELECT * FROM orgs WHERE id = ?', id));
  const rulesFor = (org) => {
    const f = join(sharedDir, 'labor', `${org.state}.json`);
    return mergeRules(us, existsSync(f) ? readJson(f) : null, org.ruleOverrides);
  };
  const audit = (org, actor, action, target, detail) => h.run('INSERT INTO audit_log (org_id,actor,action,target,detail,at) VALUES (?,?,?,?,?,?)', org, actor, action, target, JSON.stringify(detail ?? null), iso(now()));

  const has = (p, ...roles) => p.roles.includes('owner') || roles.some((r) => p.roles.includes(r));
  const need = (p, ...roles) => { if (!has(p, ...roles)) throw new HttpError(403, `requires role: ${roles.join(' or ')}`); };
  const privileged = (p) => has(p, 'manager', 'payroll');

  // Pay periods (biweekly from the org anchor).
  const periodOf = (org, date) => { const k = Math.floor((dayNum(date) - dayNum(org.payPeriodAnchor)) / 14); const start = addDays(org.payPeriodAnchor, k * 14); return { start, end: addDays(start, 13) }; };
  const currentPeriod = (org) => periodOf(org, localDate(now(), org.tz));
  const lastCompleted = (org) => { const c = currentPeriod(org); const start = addDays(c.start, -14); return { start, end: addDays(start, 13) }; };
  const parsePeriod = (org, v, fallback) => {
    if (v == null || v === '') return fallback;
    V.date(v, 'periodStart');
    const p = periodOf(org, v);
    if (p.start !== v) bad(`periodStart must be a pay-period start (e.g. ${p.start})`);
    return p;
  };

  const getPerson = (id, orgId) => { const p = rowToPerson(h.get('SELECT * FROM people WHERE id = ? AND org_id = ?', id, orgId)); if (!p) throw new HttpError(404, 'person not found'); return p; };
  const getShift = (id, orgId) => { const s = rowToShift(h.get('SELECT * FROM shifts WHERE id = ? AND org_id = ?', id, orgId)); if (!s) throw new HttpError(404, 'shift not found'); return s; };
  const positionsOf = (orgId) => h.all('SELECT * FROM positions WHERE org_id = ? ORDER BY name', orgId).map(rowToPosition);
  const certTypesOf = (orgId) => h.all('SELECT * FROM cert_types WHERE org_id = ? ORDER BY name', orgId).map(rowToCertType);
  const certsOf = (pid) => h.all('SELECT type_id, expires FROM certs WHERE person_id = ?', pid).map((r) => ({ typeId: r.type_id, expires: r.expires }));

  function publicPerson(p, viewer, org) {
    const out = { id: p.id, name: p.name, email: p.email, roles: p.roles, positions: p.positions, status: p.status };
    if (privileged(viewer) || viewer.id === p.id) {
      const age = p.birthdate ? ageOn(p.birthdate, localDate(now(), org.tz)) : null;
      Object.assign(out, { birthdate: p.birthdate, payRateCents: p.payRateCents, age, minor: age != null && age < 18 });
    }
    return out;
  }

  function check(org, person, shiftLike) {
    const s = toMs(shiftLike.start);
    const existing = h.all(`SELECT * FROM shifts WHERE org_id = ? AND person_id = ? AND start < ? AND "end" > ?`, org.id, person.id, iso(s + 9 * 86400000), iso(s - 9 * 86400000))
      .map(rowToShift).filter((x) => x.id !== shiftLike.id);
    return checkAssignment(person, shiftLike, {
      certs: certsOf(person.id), certTypes: certTypesOf(org.id), positions: positionsOf(org.id), rules: rulesFor(org),
      existingShifts: existing, tz: org.tz, workweekStart: org.workweekStart,
    });
  }

  function punchesFor(pid, fromMs, toMs_) {
    return h.all('SELECT * FROM punches WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at', pid, iso(fromMs), iso(toMs_)).map(rowToPunch);
  }

  function computeTimecard(org, person, period) {
    const from = zonedToUtc(addDays(period.start, -1), '00:00', org.tz), to = zonedToUtc(addDays(period.end, 2), '00:00', org.tz);
    const punches = punchesFor(person.id, from, to).map((p) => ({ ...p, shift_id: p.shiftId }));
    const shifts = h.all(`SELECT * FROM shifts WHERE person_id = ? AND status = 'published' AND start >= ? AND start < ?`, person.id, iso(from), iso(to)).map(rowToShift);
    const tc = timecard(punches, shifts, rulesFor(org), { workweekStart: org.workweekStart, tz: org.tz, lateThresholdMin: org.lateThresholdMin, now: now(), periodStart: period.start, periodEnd: period.end });
    const byDate = new Map(tc.days.map((d) => [d.date, d]));
    const days = [];
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
      const r = byDate.get(d) || { workedMin: 0, regularMin: 0, overtimeMin: 0, restPremiumMin: 0, punches: [] };
      days.push({ date: d, punches: r.punches.map((p) => ({ id: p.id, type: p.type, at: p.at, source: p.source, shiftId: p.shiftId })), workedMin: r.workedMin, regularMin: r.regularMin, overtimeMin: r.overtimeMin, restPremiumMin: r.restPremiumMin });
    }
    const appr = h.get('SELECT approved_by, at FROM timecard_approvals WHERE person_id = ? AND period_start = ?', person.id, period.start);
    const inPeriod = punches.filter((p) => { const d = localDate(p.at, org.tz); return d >= period.start && d <= period.end; });
    const pending = h.all(`SELECT id FROM punch_requests WHERE person_id = ? AND status = 'pending' AND at >= ? AND at < ?`, person.id, iso(from), iso(to)).length;
    return {
      person: { id: person.id, name: person.name }, period, days, weeks: tc.weeks,
      totals: { workedMin: tc.totals.workedMin, regularMin: tc.totals.regularMin, overtimeMin: tc.totals.overtimeMin, restPremiumMin: tc.totals.restPremiumMin },
      flags: tc.flags, approved: appr ? { by: appr.approved_by, at: appr.at } : null,
      editCount: inPeriod.filter((p) => String(p.source).startsWith('request:')).length,
      lateCount: tc.lateCount, pendingRequests: pending, openPunch: tc.open,
    };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, path, handler, { auth = true, maxBody = MAX_BODY, open = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, maxBody, open });
  };

  route('GET', '/v1/health', () => ({ ok: true, version: VERSION, minClient: '0.58.0', mode: vaultMode ? 'vault' : 'org' }), { auth: false, open: true });

  const newSession = (personId, secure) => {
    const token = randomBytes(32).toString('hex');
    const expiresAt = iso(now() + SESSION_HOURS * 3600000);
    h.run('INSERT INTO sessions (token_hash,person_id,created_at,expires_at) VALUES (?,?,?,?)', createHash('sha256').update(token).digest('hex'), personId, iso(now()), expiresAt);
    const p = rowToPerson(h.get('SELECT * FROM people WHERE id = ?', personId));
    return { token, expiresAt, person: publicPerson(p, p, loadOrg(p.orgId)), cookies: [sessionCookie(token, SESSION_HOURS * 3600, secure)] };
  };

  // Development sign-in (pick a person). Not available in the payroll vault.
  if (!vaultMode) route('GET', '/v1/auth/demo-users', () => h.all(`SELECT * FROM people ORDER BY id`).map(rowToPerson).map((p) => ({ id: p.id, name: p.name, roles: p.roles, positions: p.positions, status: p.status })), { auth: false });

  if (!vaultMode) route('POST', '/v1/auth/demo-login', ({ body, secure }) => {
    const personId = V.id(body.personId, 'personId');
    const row = h.get('SELECT * FROM people WHERE id = ?', personId);
    if (!row) throw new HttpError(404, 'person not found');
    const p = rowToPerson(row);
    const token = randomBytes(32).toString('hex');
    const expiresAt = iso(now() + SESSION_HOURS * 3600000);
    h.run('INSERT INTO sessions (token_hash,person_id,created_at,expires_at) VALUES (?,?,?,?)', createHash('sha256').update(token).digest('hex'), p.id, iso(now()), expiresAt);
    audit(p.orgId, p.id, 'login', p.id, { demo: true });
    return { token, expiresAt, person: publicPerson(p, p, loadOrg(p.orgId)), cookies: [sessionCookie(token, SESSION_HOURS * 3600, secure)] };
  }, { auth: false });

  // Logout always clears the cookie, even when the session has already expired.
  route('POST', '/v1/auth/logout', ({ token, secure }) => {
    if (token) h.run('DELETE FROM sessions WHERE token_hash = ?', createHash('sha256').update(token).digest('hex'));
    return { ok: true, cookies: [sessionCookie('', 0, secure)] };
  }, { auth: false, open: true });

  route('GET', '/v1/me', ({ me, org }) => ({ mode: vaultMode ? 'vault' : 'org', person: publicPerson(me, me, org), certs: certsOf(me.id), org: { id: org.id, name: org.name, state: org.state, tz: org.tz, lateThresholdMin: org.lateThresholdMin, workweekStart: org.workweekStart }, period: { current: currentPeriod(org), lastCompleted: lastCompleted(org) } }));

  route('GET', '/v1/org', ({ me, org }) => {
    const people = h.all('SELECT * FROM people WHERE org_id = ? ORDER BY name', org.id).map(rowToPerson);
    return {
      org: { id: org.id, name: org.name, state: org.state, tz: org.tz, lateThresholdMin: org.lateThresholdMin, workweekStart: org.workweekStart, payFrequency: org.payFrequency, payPeriodAnchor: org.payPeriodAnchor, futaExempt: org.futaExempt, sutaRate: org.sutaRate },
      positions: positionsOf(org.id), certTypes: certTypesOf(org.id),
      people: people.map((p) => { const o = publicPerson(p, me, org); if (privileged(me)) o.certs = certsOf(p.id).map((c) => ({ ...c, expired: c.expires < localDate(now(), org.tz) })); return o; }),
      period: { current: currentPeriod(org), lastCompleted: lastCompleted(org) },
      rules: rulesFor(org),
    };
  });

  const rangeFrom = (org, v, def) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? zonedToUtc(v, '00:00', org.tz) : toMs(V.iso(v, 'from'))) : def);
  const shiftOut = (s, people, positions) => ({ ...s, personName: s.personId ? people.get(s.personId) ?? null : null, positionName: positions.get(s.positionId) ?? null });
  const nameMaps = (org) => [new Map(h.all('SELECT id,name FROM people WHERE org_id = ?', org.id).map((r) => [r.id, r.name])), new Map(positionsOf(org.id).map((p) => [p.id, p.name]))];

  route('GET', '/v1/shifts', ({ me, org, query }) => {
    const today = localDate(now(), org.tz);
    const from = rangeFrom(org, query.from, zonedToUtc(addDays(today, -7), '00:00', org.tz));
    let to = query.to ? (/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? zonedToUtc(addDays(query.to, 1), '00:00', org.tz) : toMs(V.iso(query.to, 'to'))) : zonedToUtc(addDays(today, 15), '00:00', org.tz);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) bad('bad from/to');
    if (to - from > 92 * 86400000) bad('range too long (max 92 days)');
    let rows = h.all('SELECT * FROM shifts WHERE org_id = ? AND start < ? AND "end" > ? ORDER BY start', org.id, iso(to), iso(from)).map(rowToShift);
    if (!has(me, 'manager')) rows = rows.filter((s) => s.status === 'published' || s.personId === me.id);
    const [pm, posm] = nameMaps(org);
    return { from: iso(from), to: iso(to), shifts: rows.map((s) => shiftOut(s, pm, posm)) };
  });

  function shiftBody(org, body, { needTimes = true } = {}) {
    const positionId = V.id(body.positionId, 'positionId');
    if (!h.get('SELECT id FROM positions WHERE id = ? AND org_id = ?', positionId, org.id)) bad('unknown positionId');
    const personId = body.personId == null ? null : V.id(body.personId, 'personId');
    const start = V.iso(body.start, 'start'), end = V.iso(body.end, 'end');
    if (toMs(end) <= toMs(start)) bad('end must be after start');
    if (toMs(end) - toMs(start) > 24 * 3600000) bad('shift may not be longer than 24 h');
    return { positionId, personId, start, end, needTimes };
  }

  route('POST', '/v1/shifts/check', ({ me, org, body }) => {
    need(me, 'manager');
    const b = shiftBody(org, body);
    const id = body.id == null ? null : V.id(body.id, 'id');
    if (!b.personId) return { problems: [] };
    const person = getPerson(b.personId, org.id);
    return { problems: check(org, person, { id, position_id: b.positionId, start: b.start, end: b.end }) };
  });

  route('POST', '/v1/shifts/publish', ({ me, org, body }) => {
    need(me, 'manager');
    const from = V.date(body.from, 'from'), to = V.date(body.to, 'to');
    const r = h.run(`UPDATE shifts SET status = 'published' WHERE org_id = ? AND status = 'draft' AND start >= ? AND start < ?`, org.id, iso(zonedToUtc(from, '00:00', org.tz)), iso(zonedToUtc(addDays(to, 1), '00:00', org.tz)));
    audit(org.id, me.id, 'shifts_publish', `${from}..${to}`, { count: Number(r.changes) });
    return { published: Number(r.changes) };
  });

  route('POST', '/v1/shifts', ({ me, org, body, query }) => {
    need(me, 'manager');
    const b = shiftBody(org, body);
    const status = V.enum(body.status ?? 'draft', 'status', ['draft', 'published']);
    const note = V.str(body.note, 'note', { optional: true, max: 300 });
    const id = body.id == null ? null : V.id(body.id, 'id');
    const existing = id ? rowToShift(h.get('SELECT * FROM shifts WHERE id = ? AND org_id = ?', id, org.id)) : null;
    if (id && !existing) throw new HttpError(404, 'shift not found');
    let problems = [];
    let forced = false;
    if (b.personId) {
      const person = getPerson(b.personId, org.id);
      problems = check(org, person, { id, position_id: b.positionId, start: b.start, end: b.end });
      if (isBlocked(problems)) {
        const force = query.force === '1' || query.force === 'true';
        const reason = (query.reason || '').trim();
        if (!force) throw new HttpError(409, 'assignment blocked', { problems });
        if (unforceable(problems).length) throw new HttpError(409, 'certification, age and minor-labor blocks cannot be overridden', { problems });
        if (reason.length < 3) bad('force requires a reason (?force=1&reason=...)');
        forced = true;
        audit(org.id, me.id, 'shift_force_override', id || '(new)', { personId: b.personId, reason, problems: problems.filter((p) => p.blocking).map((p) => p.code) });
      }
    }
    const sid = id || 's-' + randomUUID();
    if (existing) h.run('UPDATE shifts SET position_id = ?, person_id = ?, start = ?, "end" = ?, status = ?, note = ? WHERE id = ?', b.positionId, b.personId, b.start, b.end, status, note, sid);
    else h.run('INSERT INTO shifts (id,org_id,position_id,person_id,start,"end",status,note) VALUES (?,?,?,?,?,?,?,?)', sid, org.id, b.positionId, b.personId, b.start, b.end, status, note);
    audit(org.id, me.id, existing ? 'shift_update' : 'shift_create', sid, { ...b, status, forced });
    const [pm, posm] = nameMaps(org);
    return { status: existing ? 200 : 201, body: { shift: shiftOut(getShift(sid, org.id), pm, posm), problems, forced } };
  });

  route('POST', '/v1/shifts/:id/check', ({ me, org, body, params }) => {
    need(me, 'manager');
    const s = getShift(params.id, org.id);
    const person = getPerson(V.id(body.personId, 'personId'), org.id);
    return { problems: check(org, person, { id: s.id, position_id: s.positionId, start: s.start, end: s.end }) };
  });

  // Swaps
  const swapOut = (sw, org) => { const s = rowToShift(h.get('SELECT * FROM shifts WHERE id = ?', sw.shiftId)); const [pm, posm] = nameMaps(org); return { ...sw, fromName: pm.get(sw.fromPerson) ?? null, claimantName: sw.claimant ? pm.get(sw.claimant) ?? null : null, shift: s ? shiftOut(s, pm, posm) : null }; };
  route('GET', '/v1/swaps', ({ me, org }) => {
    let rows = h.all('SELECT w.* FROM swaps w JOIN shifts s ON s.id = w.shift_id WHERE s.org_id = ? ORDER BY w.created_at DESC', org.id).map(rowToSwap);
    if (!has(me, 'manager')) rows = rows.filter((w) => w.status === 'offered' || w.fromPerson === me.id || w.claimant === me.id);
    return { swaps: rows.map((w) => swapOut(w, org)) };
  });
  route('POST', '/v1/swaps', ({ me, org, body }) => {
    const s = getShift(V.id(body.shiftId, 'shiftId'), org.id);
    if (s.personId !== me.id) throw new HttpError(403, 'you can only offer your own shift');
    if (s.status !== 'published') bad('only published shifts can be offered');
    if (toMs(s.start) <= now()) bad('shift has already started');
    if (h.get(`SELECT id FROM swaps WHERE shift_id = ? AND status IN ('offered','claimed')`, s.id)) throw new HttpError(409, 'shift is already offered');
    const id = 'sw-' + randomUUID();
    h.run('INSERT INTO swaps (id,shift_id,from_person,claimant,status,created_at) VALUES (?,?,?,?,?,?)', id, s.id, me.id, null, 'offered', iso(now()));
    audit(org.id, me.id, 'swap_offer', id, { shiftId: s.id });
    return { status: 201, body: { swap: swapOut(rowToSwap(h.get('SELECT * FROM swaps WHERE id = ?', id)), org) } };
  });
  const getSwap = (id, org) => { const r = h.get('SELECT w.* FROM swaps w JOIN shifts s ON s.id = w.shift_id WHERE w.id = ? AND s.org_id = ?', id, org.id); if (!r) throw new HttpError(404, 'swap not found'); return rowToSwap(r); };
  route('POST', '/v1/swaps/:id/claim', ({ me, org, params }) => {
    const sw = getSwap(params.id, org);
    if (sw.status !== 'offered') throw new HttpError(409, `swap is ${sw.status}`);
    if (sw.fromPerson === me.id) bad('you cannot claim your own shift');
    const s = getShift(sw.shiftId, org.id);
    const problems = check(org, me, { id: s.id, position_id: s.positionId, start: s.start, end: s.end });
    if (isBlocked(problems)) throw new HttpError(409, 'you are not eligible for this shift', { problems });
    h.run(`UPDATE swaps SET claimant = ?, status = 'claimed' WHERE id = ?`, me.id, sw.id);
    audit(org.id, me.id, 'swap_claim', sw.id, { problems: problems.map((p) => p.code) });
    return { swap: swapOut(getSwap(sw.id, org), org), problems };
  });
  route('POST', '/v1/swaps/:id/decide', ({ me, org, params, body }) => {
    need(me, 'manager');
    const approve = V.bool(body.approve, 'approve');
    const sw = getSwap(params.id, org);
    if (!['offered', 'claimed'].includes(sw.status)) throw new HttpError(409, `swap is already ${sw.status}`);
    if (approve) {
      if (sw.status !== 'claimed') throw new HttpError(409, 'nobody has claimed this swap yet');
      const s = getShift(sw.shiftId, org.id);
      const problems = check(org, getPerson(sw.claimant, org.id), { id: s.id, position_id: s.positionId, start: s.start, end: s.end });
      if (isBlocked(problems)) throw new HttpError(409, 'claimant is no longer eligible', { problems });
      h.tx(() => {
        h.run('UPDATE shifts SET person_id = ? WHERE id = ?', sw.claimant, s.id);
        h.run(`UPDATE swaps SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`, me.id, iso(now()), sw.id);
      });
    } else h.run(`UPDATE swaps SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?`, me.id, iso(now()), sw.id);
    audit(org.id, me.id, approve ? 'swap_approve' : 'swap_deny', sw.id, { shiftId: sw.shiftId, claimant: sw.claimant });
    return { swap: swapOut(getSwap(sw.id, org), org) };
  });

  // Time clock
  route('POST', '/v1/punches', ({ me, org, body }) => {
    const type = V.enum(body.type, 'type', ['in', 'out']);
    const restAttested = V.bool(body.restAttested, 'restAttested', { optional: true });
    const t = now();
    const last = h.get('SELECT * FROM punches WHERE person_id = ? ORDER BY at DESC LIMIT 1', me.id);
    const openIn = last && last.type === 'in' && t - toMs(last.at) < 16 * 3600000 ? rowToPunch(last) : null;
    if (type === 'in' && openIn) throw new HttpError(409, 'already clocked in');
    if (type === 'out' && !openIn) throw new HttpError(409, 'not clocked in');
    let shift = null;
    if (type === 'out') shift = openIn.shiftId ? getShift(openIn.shiftId, org.id) : null;
    else {
      const cands = h.all(`SELECT * FROM shifts WHERE org_id = ? AND person_id = ? AND status = 'published' AND start <= ? AND "end" >= ?`, org.id, me.id, iso(t + 2 * 3600000), iso(t - 2 * 3600000)).map(rowToShift);
      shift = cands.sort((a, b) => Math.abs(toMs(a.start) - t) - Math.abs(toMs(b.start) - t))[0] || null;
    }
    const id = 'pu-' + randomUUID();
    h.run('INSERT INTO punches (id,person_id,shift_id,type,at,source,rest_attested,created_at) VALUES (?,?,?,?,?,?,?,?)', id, me.id, shift?.id ?? null, type, iso(t), 'app', restAttested == null ? null : restAttested ? 1 : 0, iso(t));
    const minutesLate = type === 'in' && shift ? Math.max(0, Math.floor((t - toMs(shift.start)) / 60000)) : 0;
    return { status: 201, body: { punch: rowToPunch(h.get('SELECT * FROM punches WHERE id = ?', id)), shift, minutesLate, late: minutesLate > org.lateThresholdMin } };
  });

  function shiftState(org, s, t) {
    const ps = h.all('SELECT * FROM punches WHERE shift_id = ? ORDER BY at', s.id).map(rowToPunch);
    const firstIn = ps.find((p) => p.type === 'in');
    const lastOut = [...ps].reverse().find((p) => p.type === 'out');
    const lastP = ps.at(-1);
    const start = toMs(s.start), end = toMs(s.end), thr = org.lateThresholdMin;
    let state, minutesLate = 0, arrival = null;
    if (firstIn) {
      minutesLate = Math.max(0, Math.floor((toMs(firstIn.at) - start) / 60000));
      arrival = minutesLate > thr ? 'late' : 'on_time';
      state = lastP.type === 'out' ? 'clocked_out' : 'clocked_in';
    } else if (t >= end) state = 'no_show';
    else if (t >= start + thr * 60000) { state = 'late'; minutesLate = Math.floor((t - start) / 60000); }
    else state = 'upcoming';
    return { state, arrival, minutesLate, clockedInAt: firstIn?.at ?? null, clockedOutAt: state === 'clocked_out' ? lastOut.at : null };
  }

  route('GET', '/v1/status/today', ({ me, org }) => {
    const t = now(), today = localDate(t, org.tz);
    const from = zonedToUtc(today, '00:00', org.tz), to = zonedToUtc(addDays(today, 1), '00:00', org.tz);
    let rows = h.all(`SELECT * FROM shifts WHERE org_id = ? AND status = 'published' AND person_id IS NOT NULL AND start >= ? AND start < ? ORDER BY start`, org.id, iso(from), iso(to)).map(rowToShift);
    if (!has(me, 'manager')) rows = rows.filter((s) => s.personId === me.id);
    const [pm, posm] = nameMaps(org);
    return { date: today, now: iso(t), lateThresholdMin: org.lateThresholdMin, shifts: rows.map((s) => ({ shiftId: s.id, personId: s.personId, personName: pm.get(s.personId) ?? null, positionId: s.positionId, positionName: posm.get(s.positionId) ?? null, start: s.start, end: s.end, ...shiftState(org, s, t) })) };
  });

  route('GET', '/v1/alerts', ({ me, org }) => {
    need(me, 'manager');
    const t = now(), thr = org.lateThresholdMin * 60000;
    const rows = h.all(`SELECT * FROM shifts WHERE org_id = ? AND status = 'published' AND person_id IS NOT NULL AND start >= ? AND start <= ? ORDER BY start DESC`, org.id, iso(t - 24 * 3600000), iso(t - thr)).map(rowToShift);
    const [pm, posm] = nameMaps(org);
    const alerts = [];
    for (const s of rows) {
      const st = shiftState(org, s, t);
      const alertAt = iso(toMs(s.start) + thr);
      const base = { shiftId: s.id, personId: s.personId, personName: pm.get(s.personId) ?? null, positionId: s.positionId, positionName: posm.get(s.positionId) ?? null, start: s.start, end: s.end, alertAt };
      if (!st.clockedInAt) alerts.push({ ...base, type: st.state === 'no_show' ? 'no_show' : 'late', minutesLate: st.state === 'no_show' ? null : st.minutesLate, arrivedAt: null, resolved: false, message: st.state === 'no_show' ? `${base.personName} did not clock in` : `${base.personName} has not clocked in (${st.minutesLate} min past start)` });
      else if (st.arrival === 'late') alerts.push({ ...base, type: 'late', minutesLate: st.minutesLate, arrivedAt: st.clockedInAt, resolved: true, message: `${base.personName} clocked in ${st.minutesLate} min late` });
    }
    return { alerts };
  });

  // Missed-punch requests
  const REASONS = ['forgot', 'device', 'early_late_fix', 'other'];
  route('GET', '/v1/punch-requests', ({ me, org, query }) => {
    const status = V.enum(query.status, 'status', ['pending', 'approved', 'denied'], { optional: true });
    let rows = h.all('SELECT r.* FROM punch_requests r JOIN people p ON p.id = r.person_id WHERE p.org_id = ? ORDER BY r.created_at DESC', org.id).map(rowToRequest);
    if (!has(me, 'manager')) rows = rows.filter((r) => r.personId === me.id);
    if (status) rows = rows.filter((r) => r.status === status);
    const [pm] = nameMaps(org);
    return { requests: rows.map((r) => ({ ...r, personName: pm.get(r.personId) ?? null })) };
  });
  route('POST', '/v1/punch-requests', ({ me, org, body }) => {
    const shift = getShift(V.id(body.shiftId, 'shiftId'), org.id);
    if (shift.personId !== me.id) throw new HttpError(403, 'you can only request punches for your own shifts');
    const type = V.enum(body.type, 'type', ['in', 'out']);
    const at = V.iso(body.at, 'at');
    if (toMs(at) > now() + 5 * 60000) bad('at cannot be in the future');
    if (Math.abs(toMs(at) - toMs(shift.start)) > 36 * 3600000) bad('at must be near the shift');
    const reasonCode = V.enum(body.reasonCode, 'reasonCode', REASONS);
    const note = V.str(body.note, 'note', { optional: true, max: 500 });
    if (reasonCode === 'other' && !note) bad('note is required when reasonCode is other');
    const id = 'pr-' + randomUUID();
    h.run('INSERT INTO punch_requests (id,person_id,shift_id,type,at,reason_code,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, me.id, shift.id, type, at, reasonCode, note, 'pending', iso(now()));
    audit(org.id, me.id, 'punch_request', id, { shiftId: shift.id, type, at, reasonCode });
    return { status: 201, body: { request: rowToRequest(h.get('SELECT * FROM punch_requests WHERE id = ?', id)) } };
  });
  route('POST', '/v1/punch-requests/:id/decide', ({ me, org, params, body }) => {
    need(me, 'manager');
    const approve = V.bool(body.approve, 'approve');
    const row = h.get('SELECT r.* FROM punch_requests r JOIN people p ON p.id = r.person_id WHERE r.id = ? AND p.org_id = ?', params.id, org.id);
    if (!row) throw new HttpError(404, 'request not found');
    const r = rowToRequest(row);
    if (r.status !== 'pending') throw new HttpError(409, `request is already ${r.status}`);
    if (r.personId === me.id && !me.roles.includes('owner')) throw new HttpError(403, 'you cannot decide your own request');
    let punch = null;
    h.tx(() => {
      h.run('UPDATE punch_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'denied', me.id, iso(now()), r.id);
      if (approve) {
        const pid = 'pu-' + randomUUID();
        h.run('INSERT INTO punches (id,person_id,shift_id,type,at,source,rest_attested,created_at) VALUES (?,?,?,?,?,?,?,?)', pid, r.personId, r.shiftId, r.type, r.at, `request:${r.id}`, null, iso(now()));
        punch = rowToPunch(h.get('SELECT * FROM punches WHERE id = ?', pid));
      }
    });
    audit(org.id, me.id, approve ? 'punch_request_approve' : 'punch_request_deny', r.id, { personId: r.personId });
    return { request: rowToRequest(h.get('SELECT * FROM punch_requests WHERE id = ?', r.id)), punch };
  });

  // Timecards
  route('GET', '/v1/timecards', ({ me, org, query }) => {
    const pid = query.personId ? V.id(query.personId, 'personId') : me.id;
    if (pid !== me.id) need(me, 'manager', 'payroll');
    const person = getPerson(pid, org.id);
    return computeTimecard(org, person, parsePeriod(org, query.periodStart, currentPeriod(org)));
  });
  route('POST', '/v1/timecards/approve', ({ me, org, body }) => {
    need(me, 'manager');
    const person = getPerson(V.id(body.personId, 'personId'), org.id);
    const period = parsePeriod(org, V.date(body.periodStart, 'periodStart'), null);
    if (person.id === me.id && !me.roles.includes('owner')) throw new HttpError(403, 'you cannot approve your own timecard');
    if (h.get('SELECT 1 FROM timecard_approvals WHERE person_id = ? AND period_start = ?', person.id, period.start)) throw new HttpError(409, 'already approved');
    if (approvals.configured(org.id, 'timecard')) {
      // A configured chain: this approval is one step; the timecard counts as approved when the chain finishes.
      const target = `${person.id}:${period.start}`;
      let ap = approvals.find(org.id, 'timecard', target);
      if (!ap) ap = approvals.start({ orgId: org.id, kind: 'timecard', targetId: target, requestedBy: 'system', subjectPersonId: person.id, departmentId: person.departmentId, title: `Timecard: ${person.name}, ${period.start} to ${period.end}` });
      ap = approvals.decide(ap.id, me.id, true, null);
      audit(org.id, me.id, 'timecard_approve_step', person.id, { periodStart: period.start, status: ap.status });
      return { approval: ap, approved: ap.status === 'approved' ? { by: me.id, at: iso(now()) } : null, personId: person.id, period };
    }
    h.run('INSERT INTO timecard_approvals (person_id,period_start,approved_by,at) VALUES (?,?,?,?)', person.id, period.start, me.id, iso(now()));
    audit(org.id, me.id, 'timecard_approve', person.id, { periodStart: period.start });
    return { approved: { by: me.id, at: iso(now()) }, personId: person.id, period };
  });

  // ---------- payroll and HR ----------
  const approvals = makeApprovals({ h, now, iso, uid: (p) => `${p}-${randomUUID()}`, audit, HttpError });
  approvals.on('timecard', {
    approved(a, actor) { const [pid, ps] = a.targetId.split(':'); h.run('INSERT OR IGNORE INTO timecard_approvals (person_id,period_start,approved_by,at) VALUES (?,?,?,?)', pid, ps, actor, iso(now())); },
  });
  const ctx = {
    mode: vaultMode ? 'vault' : 'org', h, route, V, HttpError, bad, need, has, privileged, audit, now, iso, vault, approvals,
    hub: makeHubClient({ fetchImpl, now }), defaultHubUrl: fixedHubUrl,
    localSignIn: typeof localSignIn === 'function' ? localSignIn : () => !!localSignIn,
    uid: (p) => `${p}-${randomUUID()}`, today: (org) => localDate(now(), org.tz),
    getPerson, getShift, loadOrg, rulesFor, tablesFor, computeTimecard, positionsOf,
    periodOf, currentPeriod, lastCompleted, parsePeriod, newSession, sessionCookie,
    saveOrgSettings(org, patch) { org.settings = { ...org.settings, ...patch }; h.run('UPDATE orgs SET settings = ? WHERE id = ?', JSON.stringify(org.settings), org.id); },
  };
  registerPayroll(ctx);

  // ---------- dispatcher ----------
  async function readBody(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, `body too large (${Math.round(max / 1048576)} MB max)`)); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const t0 = Date.now();
    let status = 200, payload;
    let cookies = [];
    const url = new URL(req.url, 'http://localhost');
    const secure = !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) {
      serveStatic(req, res, webDir);
      if (log) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
      return;
    }
    try {
      // The payroll vault answers only to its own address on this computer, so a web page that points its own domain
      // name at 127.0.0.1 (DNS rebinding) can't reach it.
      if (vaultMode && !ownHost(req.headers.host)) throw new HttpError(421, 'This payroll vault only answers at its own address on this computer.');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(routes.some((x) => x.re.test(url.pathname)) ? 405 : 404, 'not found');
      const params = {}; const m = url.pathname.match(r.re); r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body = {};
      if (req.method === 'POST') {
        if (vaultMode && !r.open && !vault.unlocked()) throw new HttpError(423, 'The payroll vault is locked. Sign in with the vault passphrase.', { locked: true });
        const raw = await readBody(req, r.maxBody);
        if (raw.trim()) { try { body = JSON.parse(raw); } catch { bad('invalid JSON'); } }
        body = V.obj(body);
      }
      const ctx = { params, body, query: Object.fromEntries(url.searchParams), secure, ip: req.socket.remoteAddress || null };
      // Credentials: a bearer header (apps, scripts) or the web app's HttpOnly cookie.
      const auth = req.headers.authorization;
      const bearer = auth ? /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1] ?? null : null;
      if (auth && !bearer) throw new HttpError(401, 'missing or malformed bearer token');
      const cookieToken = bearer ? null : readCookie(req.headers.cookie, COOKIE);
      const viaCookie = !bearer && !!cookieToken;
      // CSRF: anything a browser could send cross-site must prove it came from our own page.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !bearer) {
        if (!sameOrigin(req, secure)) throw new HttpError(403, 'cross-site request refused');
        if (viaCookie && req.headers['x-keas'] !== '1') throw new HttpError(403, 'missing X-KeaS header');
      }
      ctx.token = bearer || cookieToken;
      if (vaultMode && !r.open && !vault.unlocked()) throw new HttpError(423, 'The payroll vault is locked. Sign in with the vault passphrase.', { locked: true });
      if (r.auth) {
        if (!ctx.token) throw new HttpError(401, 'missing or malformed bearer token');
        const sess = h.get('SELECT * FROM sessions WHERE token_hash = ?', createHash('sha256').update(ctx.token).digest('hex'));
        if (!sess || toMs(sess.expires_at) <= now()) {
          if (viaCookie) cookies = [sessionCookie('', 0, secure)];
          throw new HttpError(401, 'session expired or invalid');
        }
        ctx.me = rowToPerson(h.get('SELECT * FROM people WHERE id = ?', sess.person_id));
        ctx.org = loadOrg(ctx.me.orgId);
      }
      let out = await r.handler(ctx);
      if (out && out.raw) {
        // A file download (CSV, PDF, NACHA, a stored document).
        const body = Buffer.isBuffer(out.raw.body) ? out.raw.body : Buffer.from(String(out.raw.body), 'utf8');
        const name = String(out.raw.filename || 'download').replace(/[^A-Za-z0-9_.-]+/g, '_');
        res.writeHead(200, { ...securityHeaders(), 'content-type': out.raw.type, 'content-length': body.length, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
        res.end(body);
        if (log) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} 200 ${Date.now() - t0}ms`);
        return;
      }
      if (out && Array.isArray(out.cookies)) { cookies = out.cookies; const { cookies: _c, ...rest } = out; out = rest; }
      if (out && typeof out.status === 'number' && 'body' in out) { status = out.status; payload = out.body; } else payload = out;
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else if (e instanceof VaultLocked) { status = 423; payload = { error: e.message, locked: true }; }
      else { status = 500; payload = { error: 'internal error' }; console.error(e); }
    }
    const text = JSON.stringify(payload ?? {});
    const headers = { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(text);
    if (log) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms`);
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.writeHead(500); res.end('{"error":"internal error"}'); } catch {} }); });
  function ownHost(host) {
    const port = server.address()?.port;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(host || '').toLowerCase());
  }
  return {
    server, h, vault,
    /**
     * The owner (in the KeaS app, never over HTTP) accepts the Kea Hub's current signing key, after the Hub was moved
     * or reinstalled. Returns the pinned key ids.
     */
    async repinHub() {
      if (!vaultMode || !vault.initialized()) throw new Error('Set up payroll first.');
      if (!fixedHubUrl) throw new Error('No Kea Hub is set for payroll on this computer.');
      const keys = await ctx.hub.fetchKeys(fixedHubUrl);
      vault.setSetting('hubPin', { url: fixedHubUrl, iss: 'kea-hub', keys, at: iso(now()) });
      audit(h.get('SELECT id FROM orgs LIMIT 1')?.id ?? null, 'keas-app', 'vault_hub_key_pinned', null, { kids: keys.map((k) => k.kid) });
      return keys.map((k) => k.kid);
    },
    listen(port = Number(process.env.KEA_PORT) || 4850) { return new Promise((resolve) => server.listen(port, HOST, () => resolve(server.address().port))); },
    close() { return new Promise((resolve) => server.close(() => { h.close(); resolve(); })); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp();
  const port = await app.listen();
  console.log(`KeaS workforce server ${VERSION} on http://${HOST}:${port}`);
}
