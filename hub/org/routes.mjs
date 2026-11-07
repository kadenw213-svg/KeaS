// Organizations on the Kea Hub: members and join codes, structure and budgets, certifications and org classes,
// availability forms, schedules (manual, auto-fill, drafts), swaps, acknowledgments and the to-do box.
// Mounted from hub/index.mjs with mountOrgs(); the tables are in ./schema.mjs.
//
// Payroll data is refused here on purpose: SSNs, bank details and pay runs stay in the payroll vault on the payroll
// admin's own PC (see noPayroll below).
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORG_SCHEMA } from './schema.mjs';
import { checkNoPayroll, PAYROLL_MESSAGE } from './payroll.mjs';
import {
  isDate, isTime, toMin, nextMonth, datesIn, expandSlots, prefillUsual, prefillFrom, usualFromAnswers, cleanAnswers, hoursMarked,
  needOf, needTotal, autofill, sheetsExport, longExport, certStage, addMonths, sortTodo, fmtRange, DAY_NAMES, daysUntil,
} from './logic.mjs';
import { mergeRules, checkAssignment } from '../../server/lib/rules.mjs';
import { addDays, localDate, zonedToUtc, ageOn, dayNum, weekStartOf } from '../../server/lib/time.mjs';

const LABOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'labor');
const RANK = { member: 1, manager: 2, admin: 3, owner: 4 };
const ROLES = ['owner', 'admin', 'manager', 'member'];
const KINDS = ['nonprofit', 'government', 'private', 'school', 'other'];
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ORG_CODE_LEN = 12;
const newOrgCode = () => [...randomBytes(ORG_CODE_LEN)].map((b) => CODE_ALPHA[b % CODE_ALPHA.length]).join('');
const TODO_KINDS = ['availability', 'cert', 'class', 'swap', 'ack', 'missing', 'approvals', 'budget', 'drafts', 'staffcerts'];
export const ORG_DEFAULTS = {
  autoApproveJoins: false,
  swapNeedsApproval: true,
  budgetWarnPct: 90,
  certWarnDays: [60, 30, 7],
  reminders: [72, 24, 0],
  autofill: { useIfNeeded: true, hardMaxHours: false, allowOvertime: false },
  todoKinds: Object.fromEntries(TODO_KINDS.map((k) => [k, true])),
  ruleOverrides: {},
  membersSeeSchedule: true,
};
export function mountOrgs({ R, O, h, V, now, audit, limit, normCode, HttpError, bad, forbidden, notFound, rawOut, notify = () => {}, extrasFor = () => ({}) }) {
  h.db.exec(ORG_SCHEMA);
  // Org classes made before classes.org_id existed.
  h.run('UPDATE classes SET org_id = (SELECT org_id FROM org_classes WHERE class_id = classes.id) WHERE org_id IS NULL AND id IN (SELECT class_id FROM org_classes)');
  const id = () => randomUUID();
  const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
  const today = (tz) => localDate(now(), tz);

  /** Refuse payroll details anywhere in a request body (./payroll.mjs). */
  const noPayroll = (v) => checkNoPayroll(v, () => bad(PAYROLL_MESSAGE), () => { throw new HttpError(413, 'That request is too big to check. Send less at a time.'); });
  // Every org route goes through here: payroll guard first.
  const OR = (method, path, fn, opts) => R(method, path, (ctx) => { noPayroll(ctx.body); return fn(ctx); }, opts);

  // ---------- validation ----------
  const date = (v, name, { optional = false } = {}) => { if ((v == null || v === '') && optional) return null; if (!isDate(v)) bad(`${name} must be a date like 2026-12-01.`); return v; };
  const tod = (v, name) => { if (!isTime(v)) bad(`${name} must be a time like 09:30.`); return v; };
  const num = (v, name, { optional = true, min = 0, max = 1e9 } = {}) => {
    if ((v == null || v === '') && optional) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) bad(`${name} must be a number from ${min} to ${max}.`);
    return n;
  };
  const list = (v, name, max = 500) => { if (v == null) return []; if (!Array.isArray(v) || v.length > max) bad(`${name} must be a list.`); return v; };
  const tags = (v) => list(v, 'Tags', 30).map((t) => V.str(t, 'Tag', { min: 1, max: 30 }).toLowerCase());
  const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { bad('Pick a real time zone, like America/Denver.'); } };
  const cents = (v, name) => (v == null || v === '' ? null : Math.round(num(v, name, { min: 0, max: 1e7 }) * 100));

  // ---------- orgs and membership ----------
  const orgSettings = (o) => {
    const s = J(o.settings, {});
    return { ...ORG_DEFAULTS, ...s, autofill: { ...ORG_DEFAULTS.autofill, ...(s.autofill || {}) }, todoKinds: { ...ORG_DEFAULTS.todoKinds, ...(s.todoKinds || {}) } };
  };
  const loadOrg = (oid) => h.get('SELECT * FROM orgs WHERE id = ?', oid);
  const memberRow = (oid, aid) => h.get('SELECT * FROM org_members WHERE org_id = ? AND account_id = ?', oid, aid);
  const roleWord = { member: 'members', manager: 'managers', admin: 'admins', owner: 'the owner' };
  /** The org and my membership, or 404 (other orgs are invisible), or 403 for too low a role. */
  // An organization works only once the Hub's owner has approved it (active), and stops when it's suspended. A route
  // that must work before or after that (seeing the organization's own page) opts in with inactiveOk.
  function asOrg(oid, me, min = 'member', { pendingOk = false, inactiveOk = false } = {}) {
    const o = loadOrg(oid);
    const m = o && memberRow(oid, me.id);
    if (!o || !m) notFound('Organization not found.');
    if (m.status !== 'active' && !pendingOk) forbidden('Your request to join is waiting for approval.');
    if (o.status === 'suspended' && !inactiveOk) forbidden('This organization is suspended on the Kea Hub.');
    if (o.status !== 'active' && !inactiveOk) forbidden('This organization is still waiting for approval on the Kea Hub.');
    if (RANK[m.role] < RANK[min]) forbidden(`Only ${min === 'manager' ? 'managers and admins' : min === 'admin' ? 'admins' : roleWord[min]} can do that.`);
    return { o, m, s: orgSettings(o), tz: o.tz, mgr: RANK[m.role] >= RANK.manager, admin: RANK[m.role] >= RANK.admin };
  }
  const orgOut = (o, m) => ({
    id: o.id, name: o.name, kind: o.kind, tz: o.tz, state: o.state, workweekStart: o.workweek_start, status: o.status, createdAt: o.created_at,
    role: m?.role ?? null, memberStatus: m?.status ?? null,
    members: h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND status = 'active'", o.id).n,
    ...(m && RANK[m.role] >= RANK.admin ? { settings: orgSettings(o) } : {}),
  });
  const positionsOf = (oid, aid) => h.all('SELECT position_id FROM org_member_positions WHERE org_id = ? AND account_id = ?', oid, aid).map((r) => r.position_id);
  // The supporter badge for everyone; a phone number only between active coworkers, and only if its owner shares it
  // with organizations (accounts.phone_visibility).
  const memberOut = (r, viewer) => {
    const mgr = RANK[viewer.role] >= RANK.manager, admin = RANK[viewer.role] >= RANK.admin, self = r.account_id === viewer.account_id;
    return {
      id: r.account_id, name: r.display_name, role: r.role, status: r.status, departmentId: r.department_id, title: r.title, emailVerified: !!r.email_verified,
      positionIds: positionsOf(r.org_id, r.account_id), joinedAt: r.joined_at, you: self,
      ...extrasFor(r, 'orgs', { phone: r.status === 'active' && viewer.status === 'active' }),
      ...(mgr || self ? { email: r.email, desiredMin: r.desired_min, desiredMax: r.desired_max, prefs: J(r.prefs, []), minor: r.birthdate ? ageOn(r.birthdate, localDate(now(), 'UTC')) < 18 : null } : {}),
      ...(admin || self ? { birthdate: r.birthdate } : {}),
      ...(admin ? { costRate: r.cost_rate == null ? null : r.cost_rate / 100 } : {}),
    };
  };
  const membersOf = (oid, { status = 'active' } = {}) =>
    h.all(`SELECT m.*, a.display_name, a.email, a.email_verified, a.phone, a.phone_visibility, a.supporter_until FROM org_members m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = ?${status ? ' AND m.status = ?' : ''} ORDER BY a.display_name`, ...(status ? [oid, status] : [oid]));

  // How many rows of each kind one organization can have (audit 2026-11-06, section 2 L2): far above any real one, so a
  // script can't fill the Hub's database through one organization.
  const capRows = (table, oid, max, what) => {
    if (h.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, oid).n >= max) bad(`This organization has the most ${what} it can have (${max}). Remove some first.`);
  };
  const getSetting = (k, d) => { const r = h.get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : d; };
  const setSetting = (k, v) => h.run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));

  OR('POST', '/v1/orgs', ({ me, body, ip }) => {
    // (Joining doesn't need this: an unverified person's join waits for a manager. Making one does.)
    if (!me.email_verified && me.role !== 'owner') forbidden('Verify your email first (Settings > Account > Verify with Google, or ask the Kea Hub’s owner), then create the organization.');
    const name = V.name(body.name, 'Name', { min: 2, max: 120 });
    const kind = V.enum(body.kind ?? 'private', 'Kind', KINDS);
    const tz = validTz(V.str(body.tz ?? 'America/Denver', 'Time zone', { min: 3, max: 60 }));
    const state = body.state == null ? null : V.str(body.state, 'State', { min: 2, max: 10 }).toUpperCase();
    const ws = V.int(body.workweekStart ?? 0, 'Week start', { min: 0, max: 6 });
    if (h.get("SELECT COUNT(*) AS n FROM orgs WHERE created_by = ? AND status = 'pending'", me.id).n >= 3) bad('You already have three organizations waiting for approval.');
    const auto = me.role === 'owner' || getSetting('orgs', {}).autoApprove === true;
    const oid = id();
    h.tx(() => {
      h.run('INSERT INTO orgs (id,name,kind,tz,state,workweek_start,status,created_by,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)', oid, name, kind, tz, state, ws, auto ? 'active' : 'pending', me.id, now(), auto ? now() : null);
      h.run("INSERT INTO org_members (org_id,account_id,role,status,joined_at) VALUES (?,?,'owner','active',?)", oid, me.id, now());
    });
    audit(me.id, 'org.create', oid, { name, auto }, ip);
    return { status: 201, body: { org: orgOut(loadOrg(oid), memberRow(oid, me.id)) } };
  });
  // (Before /v1/orgs/:id, which would otherwise match "join".)
  OR('POST', '/v1/orgs/join', ({ me, body, ip }) => {
    limit('join', ip); limit('join', me.id);
    // Managers see the email as who someone is. One nobody has proven yet (an Outlook or school address can't be
    // verified with Google) doesn't get in by the code alone: it becomes a request a manager approves or declines.
    const unverified = !me.email_verified && me.role !== 'owner';
    const code = normCode(body.code);
    const c = code.length >= 10 ? h.get('SELECT * FROM org_codes WHERE code = ?', code) : null;
    const nope = "That code doesn't work. Check it, or ask for a new one.";
    if (!c || c.revoked || (c.expires_at != null && c.expires_at <= now()) || (c.max_uses != null && c.uses >= c.max_uses)) notFound(nope);
    const o = loadOrg(c.org_id);
    if (!o || o.status === 'suspended') notFound(nope);
    if (o.status === 'pending') forbidden('This organization is still waiting for approval on the Kea Hub. Try again later.');
    const existing = memberRow(o.id, me.id);
    if (existing) return { org: orgOut(o, existing), alreadyMember: true };
    // (An unverified email always waits, even with automatic approval on.)
    const pending = unverified || (!!c.needs_approval && !orgSettings(o).autoApproveJoins);
    h.tx(() => {
      capRows('org_members', o.id, 5000, 'members');
      h.run('INSERT INTO org_members (org_id,account_id,role,status,department_id,joined_at,via_code) VALUES (?,?,?,?,?,?,?)', o.id, me.id, c.role, pending ? 'pending' : 'active', c.department_id, now(), c.code);
      if (c.position_id) h.run('INSERT OR IGNORE INTO org_member_positions (org_id,account_id,position_id) VALUES (?,?,?)', o.id, me.id, c.position_id);
      h.run('UPDATE org_codes SET uses = uses + 1 WHERE code = ?', c.code);
    });
    audit(me.id, pending ? 'org.join_request' : 'org.join', o.id, { role: c.role, pending, emailVerified: !unverified }, ip);
    if (pending) tellApprovers(o, me, c.role, !unverified);
    return { org: orgOut(o, memberRow(o.id, me.id)), alreadyMember: false, pending, ...(pending ? { emailVerified: !unverified, message: 'Request sent. Your manager approves it.' } : {}) };
  });
  // A new request to join: a notice for everyone who can approve it (people above the role it asks for). An
  // organization that got a lot of requests today stops getting notices; the requests still wait under Approvals.
  function tellApprovers(o, me, role, emailVerified) {
    const today = h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND status = 'pending' AND joined_at > ?", o.id, now() - 86400_000).n;
    if (today > 20) return;
    const approvers = h.all("SELECT account_id, role FROM org_members WHERE org_id = ? AND status = 'active' AND role IN ('owner','admin','manager') ORDER BY joined_at LIMIT 200", o.id)
      .filter((m) => m.role === 'owner' || RANK[m.role] > RANK[role]).slice(0, 50);
    for (const m of approvers)
      notify(m.account_id, 'org_join', `Someone asks to join ${o.name}`, emailVerified
        ? 'Approve or decline it in Kea: Work, People, Approvals.'
        : 'Their email isn’t verified. Approve or decline it in Kea (Work, People, Approvals), and verify their email there if you know it’s theirs.',
      { data: { orgId: o.id, accountId: me.id, name: String(me.display_name ?? '').slice(0, 60), emailVerified } });
  }
  OR('GET', '/v1/orgs', ({ me }) => ({
    orgs: h.all('SELECT o.*, m.role AS m_role, m.status AS m_status FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.account_id = ? ORDER BY o.name', me.id)
      .map((o) => orgOut(o, { role: o.m_role, status: o.m_status })),
  }));
  OR('GET', '/v1/orgs/:id', ({ me, params }) => {
    const { o, m } = asOrg(params.id, me, 'member', { pendingOk: true, inactiveOk: true });
    return { org: orgOut(o, m), me: memberOut({ ...m, display_name: me.display_name, email: me.email, email_verified: me.email_verified, phone: me.phone, phone_visibility: me.phone_visibility, supporter_until: me.supporter_until }, m) };
  });
  OR('POST', '/v1/orgs/:id', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'admin');
    const next = { ...J(o.settings, {}) };
    if (body.settings) {
      const b = V.obj(body.settings);
      if ('autoApproveJoins' in b) next.autoApproveJoins = V.bool(b.autoApproveJoins, 'Approve joins automatically');
      if ('swapNeedsApproval' in b) next.swapNeedsApproval = V.bool(b.swapNeedsApproval, 'Swaps need approval');
      if ('membersSeeSchedule' in b) next.membersSeeSchedule = V.bool(b.membersSeeSchedule, 'Members see the whole schedule');
      if ('budgetWarnPct' in b) next.budgetWarnPct = V.int(b.budgetWarnPct, 'Budget warning', { min: 1, max: 200 });
      if ('certWarnDays' in b) next.certWarnDays = list(b.certWarnDays, 'Cert warnings', 6).map((d) => V.int(d, 'Days', { min: 1, max: 365 }));
      if ('reminders' in b) next.reminders = list(b.reminders, 'Reminders', 6).map((d) => V.int(d, 'Hours', { min: 0, max: 720 }));
      if ('autofill' in b) {
        const a = V.obj(b.autofill);
        next.autofill = { ...s.autofill };
        for (const k of ['useIfNeeded', 'hardMaxHours', 'allowOvertime']) if (k in a) next.autofill[k] = V.bool(a[k], k);
      }
      if ('todoKinds' in b) {
        const t = V.obj(b.todoKinds);
        next.todoKinds = { ...s.todoKinds };
        for (const [k, v] of Object.entries(t)) { if (!TODO_KINDS.includes(k)) bad(`Unknown to-do kind: ${k}`); next.todoKinds[k] = V.bool(v, k); }
      }
      if ('ruleOverrides' in b) next.ruleOverrides = V.obj(b.ruleOverrides);
    }
    h.run('UPDATE orgs SET name = ?, kind = ?, tz = ?, state = ?, workweek_start = ?, settings = ? WHERE id = ?',
      body.name != null ? V.name(body.name, 'Name', { min: 2, max: 120 }) : o.name,
      body.kind != null ? V.enum(body.kind, 'Kind', KINDS) : o.kind,
      body.tz != null ? validTz(V.str(body.tz, 'Time zone', { min: 3, max: 60 })) : o.tz,
      'state' in body ? (body.state == null ? null : V.str(body.state, 'State', { min: 2, max: 10 }).toUpperCase()) : o.state,
      body.workweekStart != null ? V.int(body.workweekStart, 'Week start', { min: 0, max: 6 }) : o.workweek_start,
      JSON.stringify(next), o.id);
    audit(me.id, 'org.update', o.id, null, ip);
    return { org: orgOut(loadOrg(o.id), memberRow(o.id, me.id)) };
  });

  // ---------- join codes ----------
  const codeOut = (c) => ({
    code: c.code, role: c.role, label: c.label, departmentId: c.department_id, positionId: c.position_id, needsApproval: !!c.needs_approval,
    uses: c.uses, maxUses: c.max_uses, expiresAt: c.expires_at, revoked: !!c.revoked, createdAt: c.created_at,
    usable: !c.revoked && (c.expires_at == null || c.expires_at > now()) && (c.max_uses == null || c.uses < c.max_uses),
  });
  OR('POST', '/v1/orgs/:id/codes', ({ me, params, body, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const role = V.enum(body.role ?? 'member', 'Role', ['admin', 'manager', 'member']);
    // A code can't hand out more than its maker has: managers make member codes, admins make manager codes, owners admin.
    if (RANK[role] >= RANK[m.role] && m.role !== 'owner') forbidden(`Only ${role === 'admin' ? 'the owner' : 'admins'} can make ${role} codes.`);
    const days = V.int(body.expiresDays ?? null, 'Days', { optional: true, min: 1, max: 365 });
    const dept = body.departmentId ? deptRow(o.id, body.departmentId).id : null;
    const pos = body.positionId ? positionRow(o.id, body.positionId).id : null;
    const code = newOrgCode();
    capRows('org_codes', o.id, 1000, 'join codes');
    h.run('INSERT INTO org_codes (code,org_id,role,label,department_id,position_id,needs_approval,max_uses,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      code, o.id, role, V.str(body.label, 'Label', { optional: true, max: 60 }), dept, pos,
      body.needsApproval == null ? (role === 'member' ? 0 : 1) : V.bool(body.needsApproval, 'Needs approval') ? 1 : 0,
      V.int(body.maxUses ?? null, 'Max uses', { optional: true, min: 1, max: 10000 }), days ? now() + days * 86400_000 : null, me.id, now());
    audit(me.id, 'org.code_create', o.id, { role }, ip);
    return { status: 201, body: { code: codeOut(h.get('SELECT * FROM org_codes WHERE code = ?', code)) } };
  });
  OR('GET', '/v1/orgs/:id/codes', ({ me, params, query }) => {
    const { o } = asOrg(params.id, me, 'manager');
    return { codes: h.all(`SELECT * FROM org_codes WHERE org_id = ?${query.all ? '' : ' AND revoked = 0'} ORDER BY created_at DESC`, o.id).map(codeOut) };
  });
  OR('POST', '/v1/orgs/:id/codes/:code/revoke', ({ me, params, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const c = h.get('SELECT * FROM org_codes WHERE code = ? AND org_id = ?', normCode(params.code), o.id) ?? notFound('Code not found.');
    if (RANK[c.role] >= RANK[m.role] && m.role !== 'owner') forbidden('You can only revoke codes you could make.');
    h.run('UPDATE org_codes SET revoked = 1 WHERE code = ?', c.code);
    audit(me.id, 'org.code_revoke', o.id, null, ip);
    return { ok: true };
  });

  // ---------- members ----------
  OR('GET', '/v1/orgs/:id/members', ({ me, params }) => {
    const { o, m, mgr } = asOrg(params.id, me);
    return {
      members: membersOf(o.id).map((r) => memberOut(r, m)),
      pending: mgr ? membersOf(o.id, { status: 'pending' }).map((r) => memberOut(r, m)) : [],
    };
  });
  OR('POST', '/v1/orgs/:id/members/:aid/approve', ({ me, params, body, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const t = memberRow(o.id, params.aid);
    if (!t || t.status !== 'pending') notFound('No request from that person.');
    if (RANK[t.role] >= RANK[m.role] && m.role !== 'owner') forbidden('Ask an admin to approve this one.');
    if (body.approve === false) h.run('DELETE FROM org_members WHERE org_id = ? AND account_id = ?', o.id, t.account_id);
    else h.run("UPDATE org_members SET status = 'active' WHERE org_id = ? AND account_id = ?", o.id, t.account_id);
    audit(me.id, body.approve === false ? 'org.join_deny' : 'org.join_approve', o.id, { account: t.account_id }, ip);
    if (body.approve === false) notify(t.account_id, 'org', `${o.name} didn’t approve your request to join`, 'Ask someone there for a new join code if you think this was a mistake.', { data: { orgId: o.id, approved: false } });
    else notify(t.account_id, 'org', `You’re in: ${o.name}`, 'Your request to join was approved. It’s in Work mode now.', { data: { orgId: o.id, approved: true } });
    return { ok: true };
  });
  // Marks a member's (or someone asking to join's) email as verified, for a manager who knows it's really theirs.
  // Managers and up, for people below them (an owner for anyone); the Hub's owner for anyone in any organization.
  // The one verifying must have a verified email themselves. It counts everywhere on the Hub, payroll included.
  OR('POST', '/v1/orgs/:id/members/:aid/verify-email', ({ me, params, ip }) => {
    const hubOwner = me.role === 'owner';
    let o, m = null;
    if (hubOwner) o = loadOrg(params.id) ?? notFound('Organization not found.');
    else {
      ({ o, m } = asOrg(params.id, me, 'manager'));
      if (!me.email_verified) forbidden('Verify your own email first.');
    }
    const t = memberRow(o.id, params.aid);
    if (!t) notFound('That person isn’t in this organization or asking to join it.');
    if (!hubOwner && t.account_id !== me.id && RANK[t.role] >= RANK[m.role] && m.role !== 'owner') forbidden('Ask an admin to verify this one.');
    const a = h.get('SELECT id, email, email_verified, verified_by FROM accounts WHERE id = ?', t.account_id) ?? notFound('Account not found.');
    if (a.email_verified) return { ok: true, already: true, emailVerified: true, verifiedBy: a.verified_by };
    const by = hubOwner ? 'Owner' : 'Manager';
    h.run('UPDATE accounts SET email_verified = 1, verified_by = ?, updated_at = ? WHERE id = ? AND email_verified = 0', by, now(), a.id);
    audit(me.id, 'account.verify_email', a.id, { by, org: o.id, email: a.email }, ip);
    notify(a.id, 'account', 'Your email is verified', hubOwner ? 'The Kea Hub’s owner verified it.' : `A manager at ${o.name} verified it.`, { data: { orgId: o.id, by } });
    return { ok: true, already: false, emailVerified: true, verifiedBy: by };
  });
  OR('POST', '/v1/orgs/:id/members/:aid', ({ me, params, body, ip }) => {
    const { o, m } = asOrg(params.id, me);
    const t = memberRow(o.id, params.aid) ?? notFound('Not a member.');
    const self = t.account_id === me.id;
    const mgr = RANK[m.role] >= RANK.manager, admin = RANK[m.role] >= RANK.admin;
    if (!self && !mgr) forbidden('Only managers and admins can change other people.');
    if (!self && RANK[t.role] >= RANK[m.role] && m.role !== 'owner') forbidden('You can only change people below your role.');
    const set = {};
    if (body.role != null) {
      const role = V.enum(body.role, 'Role', ROLES);
      if (!admin) forbidden('Only admins can change roles.');
      if ((role === 'owner' || role === 'admin' || t.role === 'admin' || t.role === 'owner') && m.role !== 'owner') forbidden('Only the owner can make or change admins.');
      if (self && m.role === 'owner' && role !== 'owner' && h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'", o.id).n < 2) bad('Make someone else an owner first.');
      set.role = role;
    }
    if ('departmentId' in body) { if (!mgr) forbidden('Only managers can change departments.'); set.department_id = body.departmentId ? deptRow(o.id, body.departmentId).id : null; }
    if ('title' in body) { if (!mgr) forbidden('Only managers can change titles.'); set.title = V.str(body.title, 'Title', { optional: true, max: 80 }); }
    if ('costRate' in body) { if (!admin) forbidden('Only admins can set cost rates.'); set.cost_rate = cents(body.costRate, 'Cost rate'); }
    if ('birthdate' in body) {
      if (!self && !admin) forbidden('Only admins can change a birthdate.');
      // (Your own only while it's empty: the minor labor rules depend on it, so changing it is an admin's job.)
      if (self && !admin && t.birthdate != null) forbidden('Your birthdate is already set. Ask an admin to correct it.');
      set.birthdate = date(body.birthdate, 'Birthdate', { optional: true });
    }
    if ('desiredMin' in body) set.desired_min = num(body.desiredMin, 'Desired hours', { max: 168 });
    if ('desiredMax' in body) set.desired_max = num(body.desiredMax, 'Desired hours', { max: 168 });
    if ('prefs' in body) set.prefs = JSON.stringify(tags(body.prefs));
    if ('usualWeek' in body) {
      const u = V.obj(body.usualWeek);
      const clean = {};
      for (const [k, v] of Object.entries(u)) if (/^[0-6]\|\d{2}:\d{2}-\d{2}:\d{2}$/.test(k) && (v === 'A' || v === 'I')) clean[k] = v;
      set.usual_week = JSON.stringify(clean);
    }
    const cols = Object.keys(set);
    h.tx(() => {
      if (cols.length) h.run(`UPDATE org_members SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE org_id = ? AND account_id = ?`, ...cols.map((c) => set[c]), o.id, t.account_id);
      if ('positionIds' in body) {
        if (!mgr) forbidden('Only managers can change positions.');
        const ids = list(body.positionIds, 'Positions', 50).map((p) => positionRow(o.id, p).id);
        h.run('DELETE FROM org_member_positions WHERE org_id = ? AND account_id = ?', o.id, t.account_id);
        for (const p of ids) h.run('INSERT OR IGNORE INTO org_member_positions (org_id,account_id,position_id) VALUES (?,?,?)', o.id, t.account_id, p);
      }
    });
    if (!self) audit(me.id, 'org.member_update', o.id, { account: t.account_id, ...Object.fromEntries(cols.filter((c) => c !== 'cost_rate' && c !== 'birthdate').map((c) => [c, set[c]])) }, ip);
    const r = h.get('SELECT m.*, a.display_name, a.email, a.email_verified, a.phone, a.phone_visibility, a.supporter_until FROM org_members m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = ? AND m.account_id = ?', o.id, t.account_id);
    return { member: { ...memberOut(r, m), ...(self ? { usualWeek: J(r.usual_week, {}) } : {}) } };
  });
  OR('POST', '/v1/orgs/:id/members/:aid/remove', ({ me, params, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const t = memberRow(o.id, params.aid) ?? notFound('Not a member.');
    if (t.account_id === me.id) bad('Use Leave to leave the organization.');
    if (RANK[t.role] >= RANK[m.role] && m.role !== 'owner') forbidden('You can only remove people below your role.');
    removeMember(o.id, t.account_id);
    audit(me.id, 'org.member_remove', o.id, { account: t.account_id }, ip);
    return { ok: true };
  });
  function removeMember(oid, aid) {
    h.tx(() => {
      h.run('DELETE FROM org_members WHERE org_id = ? AND account_id = ?', oid, aid);
      // Future draft and published shifts open up again; their past is kept for budgets.
      h.run('UPDATE org_shifts SET account_id = NULL WHERE org_id = ? AND account_id = ? AND start_at > ?', oid, aid, now());
      h.run("UPDATE org_swaps SET status = 'cancelled' WHERE org_id = ? AND (from_account = ? OR claimant = ?) AND status IN ('offered','claimed')", oid, aid, aid);
      h.run('DELETE FROM class_members WHERE account_id = ? AND class_id IN (SELECT class_id FROM org_classes WHERE org_id = ?) AND role != ?', aid, oid, 'instructor');
    });
  }
  OR('POST', '/v1/orgs/:id/leave', ({ me, params, ip }) => {
    const o = loadOrg(params.id);
    const m = o && memberRow(params.id, me.id);
    if (!m) notFound('Organization not found.');
    if (m.role === 'owner' && h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'", o.id).n < 2) bad('You are the only owner. Make someone else an owner first.');
    removeMember(o.id, me.id);
    audit(me.id, 'org.leave', o.id, null, ip);
    return { ok: true };
  });

  // ---------- structure: departments, positions, locations, cost centers ----------
  const deptRow = (oid, did) => h.get('SELECT * FROM org_departments WHERE id = ? AND org_id = ?', did, oid) ?? bad('That department is not in this organization.');
  const positionRow = (oid, pid) => h.get('SELECT * FROM org_positions WHERE id = ? AND org_id = ?', pid, oid) ?? bad('That position is not in this organization.');
  const locRow = (oid, lid) => h.get('SELECT * FROM org_locations WHERE id = ? AND org_id = ?', lid, oid) ?? bad('That location is not in this organization.');
  const ccRow = (oid, cid) => h.get('SELECT * FROM org_cost_centers WHERE id = ? AND org_id = ?', cid, oid) ?? bad('That cost center is not in this organization.');
  const deptOut = (d) => ({ id: d.id, parentId: d.parent_id, name: d.name, costCenterId: d.cost_center_id, locationId: d.location_id, sort: d.sort });
  const posOut = (p, admin) => ({ id: p.id, name: p.name, departmentId: p.department_id, tags: J(p.tags, []), color: p.color, ...(admin ? { costRate: p.cost_rate == null ? null : p.cost_rate / 100 } : {}) });
  /** A department and everything under it. */
  const subtree = (oid, did) => {
    const all = h.all('SELECT id, parent_id FROM org_departments WHERE org_id = ?', oid);
    const out = new Set([did]);
    for (let grew = true; grew;) { grew = false; for (const d of all) if (d.parent_id && out.has(d.parent_id) && !out.has(d.id)) { out.add(d.id); grew = true; } }
    return out;
  };
  OR('GET', '/v1/orgs/:id/structure', ({ me, params }) => {
    const { o, admin } = asOrg(params.id, me);
    return {
      departments: h.all('SELECT * FROM org_departments WHERE org_id = ? ORDER BY sort, name', o.id).map(deptOut),
      positions: h.all('SELECT * FROM org_positions WHERE org_id = ? ORDER BY name', o.id).map((p) => posOut(p, admin)),
      locations: h.all('SELECT * FROM org_locations WHERE org_id = ? ORDER BY name', o.id).map((l) => ({ id: l.id, name: l.name, address: l.address })),
      costCenters: h.all('SELECT * FROM org_cost_centers WHERE org_id = ? ORDER BY code', o.id).map((c) => ({ id: c.id, code: c.code, name: c.name })),
    };
  });
  OR('POST', '/v1/orgs/:id/departments', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const did = id();
    capRows('org_departments', o.id, 500, 'departments');
    h.run('INSERT INTO org_departments (id,org_id,parent_id,name,cost_center_id,location_id,sort) VALUES (?,?,?,?,?,?,?)', did, o.id,
      body.parentId ? deptRow(o.id, body.parentId).id : null, V.str(body.name, 'Name', { min: 1, max: 80 }),
      body.costCenterId ? ccRow(o.id, body.costCenterId).id : null, body.locationId ? locRow(o.id, body.locationId).id : null, V.int(body.sort ?? 0, 'Order', { min: 0, max: 10000 }));
    return { status: 201, body: { department: deptOut(deptRow(o.id, did)) } };
  });
  OR('POST', '/v1/orgs/:id/departments/:did', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const d = deptRow(o.id, params.did);
    let parent = d.parent_id;
    if ('parentId' in body) {
      parent = body.parentId ? deptRow(o.id, body.parentId).id : null;
      if (parent && subtree(o.id, d.id).has(parent)) bad("A department can't go under itself or one of its own teams.");
    }
    h.run('UPDATE org_departments SET name = ?, parent_id = ?, cost_center_id = ?, location_id = ?, sort = ? WHERE id = ?',
      body.name != null ? V.str(body.name, 'Name', { min: 1, max: 80 }) : d.name, parent,
      'costCenterId' in body ? (body.costCenterId ? ccRow(o.id, body.costCenterId).id : null) : d.cost_center_id,
      'locationId' in body ? (body.locationId ? locRow(o.id, body.locationId).id : null) : d.location_id,
      body.sort != null ? V.int(body.sort, 'Order', { min: 0, max: 10000 }) : d.sort, d.id);
    return { department: deptOut(deptRow(o.id, d.id)) };
  });
  OR('POST', '/v1/orgs/:id/departments/:did/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const d = deptRow(o.id, params.did);
    h.tx(() => {
      // Teams under it move up a level; people and positions in it keep working, with no department.
      h.run('UPDATE org_departments SET parent_id = ? WHERE parent_id = ? AND org_id = ?', d.parent_id, d.id, o.id);
      h.run('UPDATE org_members SET department_id = ? WHERE department_id = ? AND org_id = ?', d.parent_id, d.id, o.id);
      h.run('UPDATE org_positions SET department_id = ? WHERE department_id = ? AND org_id = ?', d.parent_id, d.id, o.id);
      h.run('DELETE FROM org_budgets WHERE department_id = ? AND org_id = ?', d.id, o.id);
      h.run('DELETE FROM org_departments WHERE id = ?', d.id);
    });
    return { ok: true };
  });
  OR('POST', '/v1/orgs/:id/positions', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const pid = id();
    capRows('org_positions', o.id, 500, 'positions');
    h.run('INSERT INTO org_positions (id,org_id,name,department_id,tags,cost_rate,color) VALUES (?,?,?,?,?,?,?)', pid, o.id, V.str(body.name, 'Name', { min: 1, max: 80 }),
      body.departmentId ? deptRow(o.id, body.departmentId).id : null, JSON.stringify(tags(body.tags)), cents(body.costRate, 'Cost rate'), V.str(body.color, 'Color', { optional: true, max: 20 }));
    return { status: 201, body: { position: posOut(positionRow(o.id, pid), true) } };
  });
  OR('POST', '/v1/orgs/:id/positions/:pid', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const p = positionRow(o.id, params.pid);
    h.run('UPDATE org_positions SET name = ?, department_id = ?, tags = ?, cost_rate = ?, color = ? WHERE id = ?',
      body.name != null ? V.str(body.name, 'Name', { min: 1, max: 80 }) : p.name,
      'departmentId' in body ? (body.departmentId ? deptRow(o.id, body.departmentId).id : null) : p.department_id,
      'tags' in body ? JSON.stringify(tags(body.tags)) : p.tags, 'costRate' in body ? cents(body.costRate, 'Cost rate') : p.cost_rate,
      'color' in body ? V.str(body.color, 'Color', { optional: true, max: 20 }) : p.color, p.id);
    return { position: posOut(positionRow(o.id, p.id), true) };
  });
  OR('POST', '/v1/orgs/:id/positions/:pid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const p = positionRow(o.id, params.pid);
    if (h.get("SELECT 1 FROM org_shifts WHERE position_id = ? AND org_id = ? AND end_at > ?", p.id, o.id, now())) bad('Upcoming shifts use this position. Move or remove them first.');
    h.tx(() => { h.run('DELETE FROM org_member_positions WHERE position_id = ? AND org_id = ?', p.id, o.id); h.run('DELETE FROM org_positions WHERE id = ?', p.id); });
    return { ok: true };
  });
  for (const [path, table, fields] of [
    ['locations', 'org_locations', [['name', 'Name', 1, 80], ['address', 'Address', 0, 200]]],
    ['cost-centers', 'org_cost_centers', [['code', 'Code', 1, 30], ['name', 'Name', 1, 80]]],
  ]) {
    const out = (r) => Object.fromEntries([['id', r.id], ...fields.map(([f]) => [f, r[f]])]);
    OR('POST', `/v1/orgs/:id/${path}`, ({ me, params, body }) => {
      const { o } = asOrg(params.id, me, 'admin');
      const rid = id();
      const vals = fields.map(([f, n, min, max]) => V.str(body[f], n, { min, max, optional: min === 0 }));
      capRows(table, o.id, 300, path.replace('-', ' '));
      h.run(`INSERT INTO ${table} (id,org_id,${fields.map((f) => f[0]).join(',')}) VALUES (?,?,${fields.map(() => '?').join(',')})`, rid, o.id, ...vals);
      return { status: 201, body: { item: out(h.get(`SELECT * FROM ${table} WHERE id = ?`, rid)) } };
    });
    OR('POST', `/v1/orgs/:id/${path}/:rid`, ({ me, params, body }) => {
      const { o } = asOrg(params.id, me, 'admin');
      const r = h.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`, params.rid, o.id) ?? notFound();
      const vals = fields.map(([f, n, min, max]) => (f in body ? V.str(body[f], n, { min, max, optional: min === 0 }) : r[f]));
      h.run(`UPDATE ${table} SET ${fields.map((f) => `${f[0]} = ?`).join(', ')} WHERE id = ?`, ...vals, r.id);
      return { item: out(h.get(`SELECT * FROM ${table} WHERE id = ?`, r.id)) };
    });
    OR('POST', `/v1/orgs/:id/${path}/:rid/delete`, ({ me, params }) => {
      const { o } = asOrg(params.id, me, 'admin');
      const col = table === 'org_locations' ? 'location_id' : 'cost_center_id';
      h.tx(() => { h.run(`UPDATE org_departments SET ${col} = NULL WHERE ${col} = ? AND org_id = ?`, params.rid, o.id); h.run(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`, params.rid, o.id); });
      return { ok: true };
    });
  }

  // ---------- labor rules and checks ----------
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const US = readJson(join(LABOR_DIR, 'US.json'));
  const stateRules = new Map();
  const rulesFor = (o, s) => {
    const st = o.state && /^[A-Z]{2}$/.test(o.state) ? o.state : null;
    if (st && !stateRules.has(st)) { const f = join(LABOR_DIR, `${st}.json`); stateRules.set(st, existsSync(f) ? readJson(f) : null); }
    return mergeRules(US, st ? stateRules.get(st) : null, s.ruleOverrides);
  };
  /** Everything checkAssignment needs about an org, loaded once per request. */
  function checkCtx(o, s) {
    const certTypes = h.all('SELECT * FROM org_cert_types WHERE org_id = ?', o.id).map((t) => ({ id: t.id, name: t.name, requiredForPositions: J(t.positions, []) }));
    const certs = new Map();
    for (const c of h.all('SELECT * FROM org_certs WHERE org_id = ?', o.id)) {
      if (!certs.has(c.account_id)) certs.set(c.account_id, []);
      certs.get(c.account_id).push({ typeId: c.type_id, expires: c.expires_on || '9999-12-31' });
    }
    const positions = h.all('SELECT * FROM org_positions WHERE org_id = ?', o.id).map((p) => ({ id: p.id, name: p.name, tags: J(p.tags, []), department_id: p.department_id, cost_rate: p.cost_rate }));
    const rules = rulesFor(o, s);
    const people = new Map(membersOf(o.id).map((r) => [r.account_id, {
      id: r.account_id, name: r.display_name, birthdate: r.birthdate, positions: positionsOf(o.id, r.account_id),
      desiredMin: r.desired_min, desiredMax: r.desired_max, prefs: J(r.prefs, []), departmentId: r.department_id, costRate: r.cost_rate,
    }]));
    const check = (person, shift, existing) => checkAssignment(person, shift, { certs: certs.get(person.id) || [], certTypes, positions, rules, existingShifts: existing, tz: o.tz, workweekStart: o.workweek_start });
    return { certTypes, positions, rules, people, check };
  }
  const shiftsOf = (oid, aid, from, to, exceptId = null) =>
    h.all('SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND end_at > ? AND start_at < ?' + (exceptId ? ' AND id != ?' : ''), oid, aid, from, to, ...(exceptId ? [exceptId] : []))
      .map((s) => ({ id: s.id, start: new Date(s.start_at).toISOString(), end: new Date(s.end_at).toISOString() }));
  // The rules engine writes times as ISO; people read "Sat, Dec 12, 5:00 PM" in the org's zone.
  const readable = (tz, list) => list.map((p) => ({ ...p, message: p.message
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (t) => new Date(t).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => new Date(Date.UTC(+y, +m - 1, +d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })) }));
  const problemsFor = (o, cx, aid, positionId, startAt, endAt, exceptId) => {
    const person = cx.people.get(aid) ?? bad('That person is not an active member.');
    return readable(o.tz, cx.check(person, { id: exceptId ?? undefined, positionId, start: new Date(startAt).toISOString(), end: new Date(endAt).toISOString() }, shiftsOf(o.id, aid, startAt - 8 * 86400_000, endAt + 8 * 86400_000, exceptId)));
  };

  // ---------- certifications ----------
  const certTypeRow = (oid, tid) => h.get('SELECT * FROM org_cert_types WHERE id = ? AND org_id = ?', tid, oid) ?? bad('That certification is not in this organization.');
  const certTypeOut = (t) => ({ id: t.id, name: t.name, validMonths: t.valid_months, positionIds: J(t.positions, []), warnDays: J(t.warn_days, [60, 30, 7]),
    classIds: h.all('SELECT class_id FROM org_classes WHERE cert_type_id = ?', t.id).map((r) => r.class_id) });
  const certOut = (c, tz, types) => {
    const t = types.get(c.type_id);
    return { id: c.id, accountId: c.account_id, typeId: c.type_id, typeName: t?.name ?? '', issuedOn: c.issued_on, expiresOn: c.expires_on, source: c.source, classId: c.class_id, note: c.note,
      ...certStage(c.expires_on, today(tz), t ? J(t.warn_days, [60, 30, 7]) : [60, 30, 7]) };
  };
  const typesMap = (oid) => new Map(h.all('SELECT * FROM org_cert_types WHERE org_id = ?', oid).map((t) => [t.id, t]));
  OR('GET', '/v1/orgs/:id/cert-types', ({ me, params }) => {
    const { o } = asOrg(params.id, me);
    return { certTypes: h.all('SELECT * FROM org_cert_types WHERE org_id = ? ORDER BY name', o.id).map(certTypeOut) };
  });
  const certTypeFields = (o, body, prev = {}) => ({
    name: body.name != null ? V.str(body.name, 'Name', { min: 1, max: 80 }) : prev.name,
    valid: 'validMonths' in body ? V.int(body.validMonths ?? null, 'Months valid', { optional: true, min: 1, max: 240 }) : prev.valid_months ?? null,
    positions: 'positionIds' in body ? JSON.stringify(list(body.positionIds, 'Positions', 100).map((p) => positionRow(o.id, p).id)) : prev.positions ?? '[]',
    warn: 'warnDays' in body ? JSON.stringify(list(body.warnDays, 'Warnings', 6).map((d) => V.int(d, 'Days', { min: 1, max: 365 }))) : prev.warn_days ?? JSON.stringify(orgSettings(o).certWarnDays),
  });
  OR('POST', '/v1/orgs/:id/cert-types', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const f = certTypeFields(o, body);
    if (!f.name) bad('Give the certification a name.');
    const tid = id();
    capRows('org_cert_types', o.id, 300, 'certification types');
    h.run('INSERT INTO org_cert_types (id,org_id,name,valid_months,positions,warn_days) VALUES (?,?,?,?,?,?)', tid, o.id, f.name, f.valid, f.positions, f.warn);
    return { status: 201, body: { certType: certTypeOut(certTypeRow(o.id, tid)) } };
  });
  OR('POST', '/v1/orgs/:id/cert-types/:tid', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const t = certTypeRow(o.id, params.tid);
    const f = certTypeFields(o, body, t);
    h.run('UPDATE org_cert_types SET name = ?, valid_months = ?, positions = ?, warn_days = ? WHERE id = ?', f.name, f.valid, f.positions, f.warn, t.id);
    return { certType: certTypeOut(certTypeRow(o.id, t.id)) };
  });
  OR('POST', '/v1/orgs/:id/cert-types/:tid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const t = certTypeRow(o.id, params.tid);
    h.tx(() => { h.run('DELETE FROM org_certs WHERE type_id = ? AND org_id = ?', t.id, o.id); h.run('UPDATE org_classes SET cert_type_id = NULL WHERE cert_type_id = ?', t.id); h.run('DELETE FROM org_cert_types WHERE id = ?', t.id); });
    return { ok: true };
  });
  OR('GET', '/v1/orgs/:id/certs', ({ me, params, query }) => {
    const { o, mgr, tz } = asOrg(params.id, me);
    const who = mgr ? (query.accountId || null) : me.id;
    const types = typesMap(o.id);
    const rows = h.all(`SELECT c.*, a.display_name FROM org_certs c JOIN accounts a ON a.id = c.account_id WHERE c.org_id = ?${who ? ' AND c.account_id = ?' : ''} ORDER BY c.expires_on`, ...(who ? [o.id, who] : [o.id]));
    // Required certs people don't have yet, for the positions they hold.
    const missing = [];
    for (const m of who ? [memberRow(o.id, who)].filter(Boolean) : membersOf(o.id)) {
      const pos = positionsOf(o.id, m.account_id);
      for (const t of types.values()) {
        const req = J(t.positions, []).filter((p) => pos.includes(p));
        if (req.length && !rows.some((c) => c.account_id === m.account_id && c.type_id === t.id)) missing.push({ accountId: m.account_id, typeId: t.id, typeName: t.name, positionIds: req });
      }
    }
    return { certs: rows.map((c) => ({ ...certOut(c, tz, types), name: c.display_name })), missing };
  });
  const issueCert = (o, aid, tid, issuedOn, expiresOn, by, source = 'manual', classId = null, note = null) => {
    const t = certTypeRow(o.id, tid);
    const cid = id();
    const exp = expiresOn ?? (t.valid_months ? addDays(addMonths(issuedOn, t.valid_months), -1) : null);
    capRows('org_certs', o.id, 50000, 'certification records');
    h.run('INSERT INTO org_certs (id,org_id,account_id,type_id,issued_on,expires_on,source,class_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', cid, o.id, aid, t.id, issuedOn, exp, source, classId, note, by, now());
    return cid;
  };
  OR('POST', '/v1/orgs/:id/certs', ({ me, params, body, ip }) => {
    const { o, tz } = asOrg(params.id, me, 'manager');
    const aid = V.str(body.accountId, 'Person', { min: 1, max: 80 });
    if (!memberRow(o.id, aid)) bad('That person is not in this organization.');
    const cid = issueCert(o, aid, V.str(body.typeId, 'Certification', { min: 1, max: 80 }), date(body.issuedOn ?? today(tz), 'Issued'), date(body.expiresOn, 'Expires', { optional: true }), me.id, 'manual', null, V.str(body.note, 'Note', { optional: true, max: 300 }));
    audit(me.id, 'org.cert_add', o.id, { account: aid }, ip);
    return { status: 201, body: { cert: certOut(h.get('SELECT * FROM org_certs WHERE id = ?', cid), tz, typesMap(o.id)) } };
  });
  OR('POST', '/v1/orgs/:id/certs/:cid/delete', ({ me, params, ip }) => {
    const { o } = asOrg(params.id, me, 'manager');
    h.run('DELETE FROM org_certs WHERE id = ? AND org_id = ?', params.cid, o.id);
    audit(me.id, 'org.cert_delete', o.id, { cert: params.cid }, ip);
    return { ok: true };
  });

  // ---------- org classes (Hub classes that belong to the org; finishing one can issue a cert) ----------
  const orgClassRow = (oid, cid) => h.get('SELECT oc.*, c.title, c.description, c.meeting_url, c.status FROM org_classes oc JOIN classes c ON c.id = oc.class_id WHERE oc.class_id = ? AND oc.org_id = ?', cid, oid) ?? notFound('Class not found.');
  const nextSession = (cid) => h.get('SELECT * FROM class_sessions WHERE class_id = ? AND end_at > ? ORDER BY start_at LIMIT 1', cid, now());
  const iso = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
  const sessOut = (s) => s && { id: s.id, title: s.title, start: iso(s.start_at), end: iso(s.end_at), startAt: s.start_at, location: s.location, meetingUrl: s.meeting_url };
  const orgClassOut = (c, viewer) => {
    const mine = h.get('SELECT * FROM org_class_assignments WHERE class_id = ? AND account_id = ?', c.class_id, viewer.account_id);
    return {
      id: c.class_id, title: c.title, description: c.description, meetingUrl: c.meeting_url, status: c.status, certTypeId: c.cert_type_id,
      sessions: h.all('SELECT * FROM class_sessions WHERE class_id = ? ORDER BY start_at', c.class_id).map(sessOut),
      mine: mine ? { dueOn: mine.due_on, completedOn: mine.completed_on } : null,
      ...(RANK[viewer.role] >= RANK.manager ? {
        assigned: h.all('SELECT x.*, a.display_name FROM org_class_assignments x JOIN accounts a ON a.id = x.account_id WHERE x.class_id = ? ORDER BY a.display_name', c.class_id)
          .map((x) => ({ accountId: x.account_id, name: x.display_name, dueOn: x.due_on, completedOn: x.completed_on })),
      } : {}),
    };
  };
  OR('GET', '/v1/orgs/:id/classes', ({ me, params }) => {
    const { o, m, mgr } = asOrg(params.id, me);
    const rows = mgr
      ? h.all("SELECT oc.*, c.title, c.description, c.meeting_url, c.status FROM org_classes oc JOIN classes c ON c.id = oc.class_id WHERE oc.org_id = ? AND c.status = 'active' ORDER BY c.title", o.id)
      : h.all("SELECT oc.*, c.title, c.description, c.meeting_url, c.status FROM org_classes oc JOIN classes c ON c.id = oc.class_id JOIN org_class_assignments x ON x.class_id = oc.class_id AND x.account_id = ? WHERE oc.org_id = ? AND c.status = 'active' ORDER BY c.title", me.id, o.id);
    return { classes: rows.map((c) => orgClassOut(c, m)) };
  });
  OR('POST', '/v1/orgs/:id/classes', ({ me, params, body, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    capRows('org_classes', o.id, 500, 'classes');
    const cid = id();
    const cert = body.certTypeId ? certTypeRow(o.id, body.certTypeId).id : null;
    h.tx(() => {
      h.run("INSERT INTO classes (id,owner_id,title,description,kind,meeting_url,created_at,org_id) VALUES (?,?,?,?,'class',?,?,?)", cid, me.id,
        V.name(body.title, 'Title', { min: 1, max: 120 }), V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '', V.url(body.meetingUrl, 'Meeting link'), now(), o.id);
      h.run("INSERT INTO class_members (class_id,account_id,role,joined_at) VALUES (?,?,'instructor',?)", cid, me.id, now());
      h.run('INSERT INTO org_classes (class_id,org_id,cert_type_id,created_at) VALUES (?,?,?,?)', cid, o.id, cert, now());
    });
    audit(me.id, 'org.class_create', o.id, { class: cid }, ip);
    return { status: 201, body: { class: orgClassOut(orgClassRow(o.id, cid), m) } };
  });
  OR('POST', '/v1/orgs/:id/classes/:cid', ({ me, params, body }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const c = orgClassRow(o.id, params.cid);
    h.tx(() => {
      h.run('UPDATE classes SET title = ?, description = ?, meeting_url = ?, status = ? WHERE id = ?',
        body.title != null ? V.name(body.title, 'Title', { min: 1, max: 120 }) : c.title,
        body.description != null ? V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '' : c.description,
        'meetingUrl' in body ? V.url(body.meetingUrl, 'Meeting link') : c.meeting_url,
        body.status != null ? V.enum(body.status, 'Status', ['active', 'archived']) : c.status, c.class_id);
      if ('certTypeId' in body) h.run('UPDATE org_classes SET cert_type_id = ? WHERE class_id = ?', body.certTypeId ? certTypeRow(o.id, body.certTypeId).id : null, c.class_id);
    });
    return { class: orgClassOut(orgClassRow(o.id, c.class_id), m) };
  });
  OR('POST', '/v1/orgs/:id/classes/:cid/sessions', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const c = orgClassRow(o.id, params.cid);
    const start = V.time(body.start, 'Start'), end = V.time(body.end, 'End');
    if (end <= start) bad('The end must be after the start.');
    const sid = id();
    h.run('INSERT INTO class_sessions (id,class_id,title,start_at,end_at,location,meeting_url,notes) VALUES (?,?,?,?,?,?,?,?)', sid, c.class_id,
      V.str(body.title ?? c.title, 'Title', { min: 1, max: 120 }), start, end, V.str(body.location, 'Location', { optional: true, max: 200 }), V.url(body.meetingUrl, 'Meeting link'), V.str(body.notes, 'Notes', { optional: true, max: 4000 }));
    return { status: 201, body: { session: sessOut(h.get('SELECT * FROM class_sessions WHERE id = ?', sid)) } };
  });
  OR('POST', '/v1/orgs/:id/classes/:cid/sessions/:sid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const c = orgClassRow(o.id, params.cid);
    h.run('DELETE FROM class_sessions WHERE id = ? AND class_id = ?', params.sid, c.class_id);
    return { ok: true };
  });
  OR('POST', '/v1/orgs/:id/classes/:cid/assign', ({ me, params, body, ip }) => {
    const { o, m } = asOrg(params.id, me, 'manager');
    const c = orgClassRow(o.id, params.cid);
    const due = date(body.dueOn, 'Due', { optional: true });
    const ids = list(body.accountIds, 'People', 2000).map((a) => V.str(a, 'Person', { min: 1, max: 80 }));
    // Whole departments or positions at once.
    for (const d of list(body.departmentIds, 'Departments', 100)) { const set = subtree(o.id, deptRow(o.id, d).id); for (const r of membersOf(o.id)) if (set.has(r.department_id)) ids.push(r.account_id); }
    for (const p of list(body.positionIds, 'Positions', 100)) { positionRow(o.id, p); for (const r of h.all('SELECT account_id FROM org_member_positions WHERE org_id = ? AND position_id = ?', o.id, p)) ids.push(r.account_id); }
    let n = 0;
    h.tx(() => {
      for (const aid of new Set(ids)) {
        const t = memberRow(o.id, aid);
        if (!t || t.status !== 'active') continue;
        h.run("INSERT OR IGNORE INTO class_members (class_id,account_id,role,joined_at) VALUES (?,?,'student',?)", c.class_id, aid, now());
        h.run('INSERT INTO org_class_assignments (class_id,account_id,org_id,due_on,assigned_by,assigned_at) VALUES (?,?,?,?,?,?) ON CONFLICT(class_id,account_id) DO UPDATE SET due_on = excluded.due_on', c.class_id, aid, o.id, due, me.id, now());
        n++;
      }
    });
    audit(me.id, 'org.class_assign', o.id, { class: c.class_id, count: n }, ip);
    return { assigned: n, class: orgClassOut(orgClassRow(o.id, c.class_id), m) };
  });
  OR('POST', '/v1/orgs/:id/classes/:cid/complete', ({ me, params, body, ip }) => {
    const { o, m, tz } = asOrg(params.id, me, 'manager');
    const c = orgClassRow(o.id, params.cid);
    const on = date(body.completedOn ?? today(tz), 'Completed');
    const issued = [];
    h.tx(() => {
      for (const aid of new Set(list(body.accountIds, 'People', 2000))) {
        const x = h.get('SELECT * FROM org_class_assignments WHERE class_id = ? AND account_id = ?', c.class_id, aid);
        if (!x) bad('Assign the class to that person first.');
        if (x.completed_on) continue;
        const cert = c.cert_type_id ? issueCert(o, aid, c.cert_type_id, on, null, me.id, 'class', c.class_id) : null;
        h.run('UPDATE org_class_assignments SET completed_on = ?, cert_id = ? WHERE class_id = ? AND account_id = ?', on, cert, c.class_id, aid);
        if (cert) issued.push({ accountId: aid, certId: cert });
      }
    });
    audit(me.id, 'org.class_complete', o.id, { class: c.class_id, issued: issued.length }, ip);
    return { issued, class: orgClassOut(orgClassRow(o.id, c.class_id), m) };
  });

  // ---------- block templates ----------
  const parseNeed = (oid, v) => list(v, 'Need', 30).map((n) => ({ positionId: positionRow(oid, n?.positionId).id, count: V.int(n.count, 'How many', { min: 0, max: 200 }) })).filter((n) => n.count > 0);
  const parseBlocks = (oid, v, { weekdays = true } = {}) => {
    const ids = new Set();
    return list(v, 'Blocks', 300).map((b, i) => {
      if (!b || typeof b !== 'object') bad(`Block ${i + 1} is empty.`);
      let bid = b.id == null ? `b${randomUUID().slice(0, 8)}` : V.str(b.id, 'Block id', { min: 1, max: 40 });
      while (ids.has(bid)) bid = `b${randomUUID().slice(0, 8)}`;
      ids.add(bid);
      const out = { id: bid, start: tod(b.start, `Block ${i + 1} start`), end: tod(b.end, `Block ${i + 1} end`), label: V.str(b.label, 'Block name', { optional: true, max: 60 }), need: parseNeed(oid, b.need), tags: tags(b.tags) };
      if (out.start === out.end) bad(`Block ${i + 1} starts and ends at the same time.`);
      if (weekdays) out.weekday = V.int(b.weekday, `Block ${i + 1} weekday`, { min: 0, max: 6 });
      return out;
    });
  };
  const setOut = (r) => ({ id: r.id, name: r.name, positionId: r.position_id, blocks: J(r.blocks, []), createdAt: r.created_at });
  OR('GET', '/v1/orgs/:id/block-sets', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    return { blockSets: h.all('SELECT * FROM org_block_sets WHERE org_id = ? ORDER BY name', o.id).map(setOut) };
  });
  OR('POST', '/v1/orgs/:id/block-sets', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const sid = id();
    capRows('org_block_sets', o.id, 300, 'block templates');
    h.run('INSERT INTO org_block_sets (id,org_id,name,position_id,blocks,created_at) VALUES (?,?,?,?,?,?)', sid, o.id, V.str(body.name, 'Name', { min: 1, max: 80 }),
      body.positionId ? positionRow(o.id, body.positionId).id : null, JSON.stringify(parseBlocks(o.id, body.blocks)), now());
    return { status: 201, body: { blockSet: setOut(h.get('SELECT * FROM org_block_sets WHERE id = ?', sid)) } };
  });
  OR('POST', '/v1/orgs/:id/block-sets/:sid', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const r = h.get('SELECT * FROM org_block_sets WHERE id = ? AND org_id = ?', params.sid, o.id) ?? notFound();
    h.run('UPDATE org_block_sets SET name = ?, position_id = ?, blocks = ? WHERE id = ?', body.name != null ? V.str(body.name, 'Name', { min: 1, max: 80 }) : r.name,
      'positionId' in body ? (body.positionId ? positionRow(o.id, body.positionId).id : null) : r.position_id, 'blocks' in body ? JSON.stringify(parseBlocks(o.id, body.blocks)) : r.blocks, r.id);
    return { blockSet: setOut(h.get('SELECT * FROM org_block_sets WHERE id = ?', r.id)) };
  });
  OR('POST', '/v1/orgs/:id/block-sets/:sid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    h.run('DELETE FROM org_block_sets WHERE id = ? AND org_id = ?', params.sid, o.id);
    return { ok: true };
  });

  // ---------- availability forms ----------
  const DEFAULT_QUESTIONS = { desiredHours: { on: true }, daysOff: { on: true }, notes: { on: true }, custom: [] };
  const formRow = (oid, fid) => h.get('SELECT * FROM org_forms WHERE id = ? AND org_id = ?', fid, oid) ?? notFound('Form not found.');
  const formObj = (f) => ({ ...f, periodStart: f.period_start, periodEnd: f.period_end, blocks: J(f.blocks, []), exceptions: J(f.exceptions, []), questions: { ...DEFAULT_QUESTIONS, ...J(f.questions, {}) }, audience: J(f.audience, {}) });
  const parseQuestions = (v) => {
    const q = V.obj(v);
    const out = { ...DEFAULT_QUESTIONS };
    for (const k of ['desiredHours', 'daysOff', 'notes']) if (k in q) out[k] = { on: V.bool(V.obj(q[k]).on, k) };
    out.custom = list(q.custom, 'Questions', 30).map((c, i) => ({
      id: c.id ? V.str(c.id, 'Question id', { min: 1, max: 40 }) : `q${i + 1}`,
      label: V.str(c.label, 'Question', { min: 1, max: 200 }),
      type: V.enum(c.type ?? 'text', 'Question type', ['text', 'yesno', 'choice', 'multi']),
      options: list(c.options, 'Options', 30).map((x) => V.str(x, 'Option', { min: 1, max: 80 })),
      on: c.on !== false,
    }));
    return out;
  };
  // Extra and special-hours blocks keep their ids unless one matches a weekly block (answers are keyed by date + id).
  const parseExceptions = (oid, v, start, end, weekly = []) => list(v, 'Date exceptions', 200).map((e) => {
    const d = date(e.date, 'Exception date');
    if (d < start || d > end) bad(`${d} is outside the form's dates.`);
    const kind = V.enum(e.kind, 'Exception', ['closed', 'hours', 'extra']);
    return { date: d, kind, note: V.str(e.note, 'Note', { optional: true, max: 200 }), ...(kind === 'closed' ? {} : { blocks: parseBlocks(oid, e.blocks, { weekdays: false }).map((b) => ({ ...b, id: weekly.some((w) => w.id === b.id) ? `x${b.id}` : b.id })) }) };
  });
  const parseAudience = (oid, v) => {
    const a = V.obj(v);
    return { departments: list(a.departments, 'Departments', 100).map((d) => deptRow(oid, d).id), positions: list(a.positions, 'Positions', 100).map((p) => positionRow(oid, p).id) };
  };
  /** Is this member asked to fill in this form? */
  const inAudience = (o, f, aid) => {
    const a = J(f.audience, {});
    const deps = a.departments || [], pos = a.positions || [];
    if (!deps.length && !pos.length) return true;
    const m = memberRow(o.id, aid);
    if (!m) return false;
    if (deps.length && m.department_id && deps.some((d) => subtree(o.id, d).has(m.department_id))) return true;
    return pos.length > 0 && positionsOf(o.id, aid).some((p) => pos.includes(p));
  };
  const audienceOf = (o, f) => membersOf(o.id).filter((r) => inAudience(o, f, r.account_id));
  const formOut = (f, extra = {}) => {
    const x = formObj(f);
    return {
      id: f.id, title: f.title, periodStart: f.period_start, periodEnd: f.period_end, status: f.status, deadlineAt: f.deadline_at, blocks: x.blocks, exceptions: x.exceptions,
      questions: x.questions, audience: x.audience, minorNote: f.minor_note, reminders: J(f.reminders, []), allowChanges: !!f.allow_changes, createdAt: f.created_at, publishedAt: f.published_at, ...extra,
    };
  };
  const defaultDeadline = (o, start) => {
    let d = addDays(start, -7);
    if (zonedToUtc(d, '23:59', o.tz) < now()) d = addDays(start, -1);
    return zonedToUtc(d, '23:59', o.tz);
  };
  OR('GET', '/v1/orgs/:id/forms', ({ me, params }) => {
    const { o, mgr } = asOrg(params.id, me);
    const rows = h.all('SELECT * FROM org_forms WHERE org_id = ? ORDER BY period_start DESC, created_at DESC', o.id);
    return {
      forms: rows.filter((f) => mgr || (f.status !== 'draft' && inAudience(o, f, me.id))).map((f) => {
        const r = h.get('SELECT submitted_at FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, me.id);
        return formOut(f, {
          submittedAt: r?.submitted_at ?? null,
          ...(mgr ? { responses: h.get('SELECT COUNT(*) AS n FROM org_responses WHERE form_id = ? AND submitted_at IS NOT NULL', f.id).n, audienceCount: audienceOf(o, f).length } : {}),
        });
      }),
    };
  });
  /** The form before this one (by period) for copying, or the one named. */
  const previousForm = (o, before, idOrLast) => idOrLast && idOrLast !== 'last'
    ? formRow(o.id, idOrLast)
    : h.get('SELECT * FROM org_forms WHERE org_id = ? AND period_start < ? ORDER BY period_start DESC, created_at DESC LIMIT 1', o.id, before);
  OR('POST', '/v1/orgs/:id/forms', ({ me, params, body, ip }) => {
    const { o, s, tz } = asOrg(params.id, me, 'manager');
    const def = nextMonth(today(tz));
    const start = date(body.periodStart ?? def.start, 'Start');
    const end = date(body.periodEnd ?? (body.periodStart ? addDays(nextMonth(start).start, -1) : def.end), 'End');
    if (end < start) bad('The end must be on or after the start.');
    if (dayNum(end) - dayNum(start) > 92) bad('A form can cover at most three months.');
    const prev = body.copyFrom ? previousForm(o, start, body.copyFrom) : null;
    if (body.copyFrom && !prev) bad('There is no earlier form to copy.');
    let blocks;
    if (body.blocks) blocks = parseBlocks(o.id, body.blocks);
    else if (prev) blocks = J(prev.blocks, []);
    else {
      blocks = [];
      for (const sid of list(body.blockSetIds, 'Block templates', 20)) {
        const set = h.get('SELECT * FROM org_block_sets WHERE id = ? AND org_id = ?', sid, o.id) ?? bad('That block template is not in this organization.');
        blocks = blocks.concat(J(set.blocks, []));
      }
      blocks = parseBlocks(o.id, blocks);
    }
    const month = new Date(`${start}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const fid = id();
    capRows('org_forms', o.id, 2000, 'availability forms');
    h.run('INSERT INTO org_forms (id,org_id,title,period_start,period_end,status,deadline_at,blocks,exceptions,questions,audience,minor_note,reminders,allow_changes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      fid, o.id, V.str(body.title ?? `${month} availability`, 'Title', { min: 1, max: 120 }), start, end, 'draft',
      body.deadline != null ? V.time(body.deadline, 'Deadline') : defaultDeadline(o, start),
      JSON.stringify(blocks), JSON.stringify(parseExceptions(o.id, body.exceptions, start, end, blocks)),
      JSON.stringify(body.questions ? parseQuestions(body.questions) : prev ? J(prev.questions, DEFAULT_QUESTIONS) : DEFAULT_QUESTIONS),
      JSON.stringify(body.audience ? parseAudience(o.id, body.audience) : prev ? J(prev.audience, {}) : {}),
      body.minorNote != null ? V.str(body.minorNote, 'Note for under-18s', { optional: true, max: 1000 }) : prev?.minor_note ?? null,
      JSON.stringify(body.reminders ? list(body.reminders, 'Reminders', 6).map((x) => V.int(x, 'Hours', { min: 0, max: 720 })) : prev ? J(prev.reminders, s.reminders) : s.reminders),
      body.allowChanges == null ? (prev ? prev.allow_changes : 1) : V.bool(body.allowChanges, 'Change requests') ? 1 : 0, me.id, now());
    if (body.open === true) openForm(o, fid);
    audit(me.id, 'org.form_create', o.id, { form: fid, copied: prev?.id ?? null }, ip);
    return { status: 201, body: { form: formOut(formRow(o.id, fid)) } };
  });
  const openForm = (o, fid) => {
    const f = formRow(o.id, fid);
    if (!J(f.blocks, []).length && !J(f.exceptions, []).some((e) => e.kind === 'extra')) bad('Add at least one block before sending the form out.');
    h.run("UPDATE org_forms SET status = 'open', published_at = COALESCE(published_at, ?) WHERE id = ?", now(), fid);
  };
  OR('POST', '/v1/orgs/:id/forms/:fid', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    // (Answers are keyed by date and block id, so blocks keep their ids when edited; answers for removed ones drop out.)
    const start = body.periodStart != null ? date(body.periodStart, 'Start') : f.period_start, end = body.periodEnd != null ? date(body.periodEnd, 'End') : f.period_end;
    if (end < start) bad('The end must be on or after the start.');
    const newBlocks = 'blocks' in body ? parseBlocks(o.id, body.blocks) : J(f.blocks, []);
    h.run('UPDATE org_forms SET title = ?, period_start = ?, period_end = ?, deadline_at = ?, blocks = ?, exceptions = ?, questions = ?, audience = ?, minor_note = ?, reminders = ?, allow_changes = ? WHERE id = ?',
      body.title != null ? V.str(body.title, 'Title', { min: 1, max: 120 }) : f.title, start, end,
      'deadline' in body ? (body.deadline == null ? null : V.time(body.deadline, 'Deadline')) : f.deadline_at,
      JSON.stringify(newBlocks),
      'exceptions' in body ? JSON.stringify(parseExceptions(o.id, body.exceptions, start, end, newBlocks)) : f.exceptions,
      'questions' in body ? JSON.stringify(parseQuestions(body.questions)) : f.questions,
      'audience' in body ? JSON.stringify(parseAudience(o.id, body.audience)) : f.audience,
      'minorNote' in body ? V.str(body.minorNote, 'Note for under-18s', { optional: true, max: 1000 }) : f.minor_note,
      'reminders' in body ? JSON.stringify(list(body.reminders, 'Reminders', 6).map((x) => V.int(x, 'Hours', { min: 0, max: 720 }))) : f.reminders,
      'allowChanges' in body ? (V.bool(body.allowChanges, 'Change requests') ? 1 : 0) : f.allow_changes, f.id);
    return { form: formOut(formRow(o.id, f.id)) };
  });
  OR('POST', '/v1/orgs/:id/forms/:fid/open', ({ me, params }) => { const { o } = asOrg(params.id, me, 'manager'); openForm(o, params.fid); return { form: formOut(formRow(o.id, params.fid)) }; });
  OR('POST', '/v1/orgs/:id/forms/:fid/close', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    h.run("UPDATE org_forms SET status = 'closed' WHERE id = ? AND org_id = ?", formRow(o.id, params.fid).id, o.id);
    return { form: formOut(formRow(o.id, params.fid)) };
  });
  OR('POST', '/v1/orgs/:id/forms/:fid/delete', ({ me, params, ip }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    h.tx(() => { h.run('UPDATE org_schedules SET form_id = NULL WHERE form_id = ?', f.id); h.run('DELETE FROM org_forms WHERE id = ?', f.id); });
    audit(me.id, 'org.form_delete', o.id, { form: f.id }, ip);
    return { ok: true };
  });

  const responseOut = (r) => r && { answers: J(r.answers, {}), dateNotes: J(r.date_notes, {}), note: r.note, desiredMin: r.desired_min, desiredMax: r.desired_max, daysOff: r.days_off, extra: J(r.extra, {}), submittedAt: r.submitted_at, updatedAt: r.updated_at };
  const slotsOf = (o, f) => expandSlots(formObj(f), o.tz);
  const periodDays = (f) => dayNum(f.period_end) - dayNum(f.period_start) + 1;
  const schedulePublishedFor = (f) => !!h.get("SELECT 1 FROM org_schedules WHERE form_id = ? AND status = 'published'", f.id);
  /** The form as a person fills it in: slots, their answers, prefill choices and where they stand. */
  OR('GET', '/v1/orgs/:id/forms/:fid', ({ me, params }) => {
    const { o, m, mgr } = asOrg(params.id, me);
    const f = formRow(o.id, params.fid);
    if (!mgr && (f.status === 'draft' || !inAudience(o, f, me.id))) notFound('Form not found.');
    const slots = slotsOf(o, f);
    const mine = h.get('SELECT * FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, me.id);
    const prev = previousForm(o, f.period_start, 'last');
    const prevResp = prev && h.get('SELECT * FROM org_responses WHERE form_id = ? AND account_id = ? AND submitted_at IS NOT NULL', prev.id, me.id);
    const change = h.get("SELECT * FROM org_response_changes WHERE form_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 1", f.id, me.id);
    const past = f.deadline_at != null && now() > f.deadline_at;
    const minor = m.birthdate ? ageOn(m.birthdate, f.period_start) < 18 : false;
    return {
      form: formOut(f, { minorNote: minor || mgr ? f.minor_note : null }),
      slots,
      response: responseOut(mine),
      prefill: {
        usual: prefillUsual(slots, J(m.usual_week, {})),
        last: prevResp ? prefillFrom(slotsOf(o, prev), J(prevResp.answers, {}), slots) : null,
        lastTitle: prevResp ? prev.title : null,
        desiredMin: mine?.desired_min ?? prevResp?.desired_min ?? m.desired_min, desiredMax: mine?.desired_max ?? prevResp?.desired_max ?? m.desired_max,
      },
      state: {
        pastDeadline: past, canEdit: f.status === 'open' && (!past || !mine?.submitted_at),
        changeRequest: f.status === 'open' && past && !!mine?.submitted_at && !!f.allow_changes && !schedulePublishedFor(f),
        scheduleOut: schedulePublishedFor(f),
        lastChange: change ? { id: change.id, status: change.status, createdAt: change.created_at } : null,
      },
    };
  });
  const parseResponse = (f, slots, body) => {
    const q = formObj(f).questions;
    const dn = {};
    for (const [d, n] of Object.entries(V.obj(body.dateNotes))) { if (!isDate(d) || d < f.period_start || d > f.period_end) continue; const t = V.str(n, 'Note', { optional: true, max: 300 }); if (t) dn[d] = t; }
    const extra = {};
    for (const c of q.custom.filter((x) => x.on)) {
      const v = V.obj(body.extra)[c.id];
      if (v == null || v === '') continue;
      if (c.type === 'yesno') extra[c.id] = V.bool(v, c.label);
      else if (c.type === 'choice') extra[c.id] = V.enum(v, c.label, c.options);
      else if (c.type === 'multi') extra[c.id] = list(v, c.label, 30).map((x) => V.enum(x, c.label, c.options));
      else extra[c.id] = V.str(v, c.label, { max: 1000 });
    }
    const dmin = num(body.desiredMin, 'Desired hours', { max: 168 }), dmax = num(body.desiredMax, 'Desired hours', { max: 168 });
    if (dmin != null && dmax != null && dmin > dmax) bad('The lowest desired hours must be at most the highest.');
    return {
      answers: cleanAnswers(slots, V.obj(body.answers)), dateNotes: dn, note: V.str(body.note, 'Note', { optional: true, max: 2000 }),
      desiredMin: dmin, desiredMax: dmax, daysOff: V.str(body.daysOff, 'Days off', { optional: true, max: 500 }), extra,
    };
  };
  const writeResponse = (fid, aid, r, submit) => h.run(
    `INSERT INTO org_responses (form_id,account_id,answers,date_notes,note,desired_min,desired_max,days_off,extra,submitted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(form_id,account_id) DO UPDATE SET answers=excluded.answers, date_notes=excluded.date_notes, note=excluded.note, desired_min=excluded.desired_min, desired_max=excluded.desired_max,
       days_off=excluded.days_off, extra=excluded.extra, submitted_at=COALESCE(excluded.submitted_at, org_responses.submitted_at), updated_at=excluded.updated_at`,
    fid, aid, JSON.stringify(r.answers), JSON.stringify(r.dateNotes), r.note, r.desiredMin, r.desiredMax, r.daysOff, JSON.stringify(r.extra), submit ? now() : null, now());
  OR('POST', '/v1/orgs/:id/forms/:fid/response', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me);
    const f = formRow(o.id, params.fid);
    if (f.status === 'draft' || !inAudience(o, f, me.id)) notFound('Form not found.');
    if (f.status === 'closed') bad('This form is closed.');
    const slots = slotsOf(o, f);
    const r = parseResponse(f, slots, body);
    const mine = h.get('SELECT * FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, me.id);
    const past = f.deadline_at != null && now() > f.deadline_at;
    let status = 'saved';
    if (!past || !mine?.submitted_at) {
      // Before the deadline (or a first, late answer): saved straight away.
      writeResponse(f.id, me.id, r, body.submit !== false);
      status = body.submit === false ? 'draft' : past ? 'late' : 'saved';
    } else {
      if (!f.allow_changes) bad('The deadline has passed. Ask your manager about changes.');
      if (schedulePublishedFor(f)) bad("The schedule for these dates is out, so changes count from the next form. Talk to your manager about this period.");
      h.tx(() => {
        h.run("UPDATE org_response_changes SET status = 'denied', decided_by = ?, decided_at = ? WHERE form_id = ? AND account_id = ? AND status = 'pending'", me.id, now(), f.id, me.id);
        h.run('INSERT INTO org_response_changes (id,form_id,account_id,proposal,reason,created_at) VALUES (?,?,?,?,?,?)', id(), f.id, me.id, JSON.stringify(r), V.str(body.reason, 'Reason', { optional: true, max: 500 }), now());
      });
      status = 'change_requested';
    }
    if (body.saveUsual === true) h.run('UPDATE org_members SET usual_week = ? WHERE org_id = ? AND account_id = ?', JSON.stringify(usualFromAnswers(slots, r.answers)), o.id, me.id);
    if (r.desiredMin != null || r.desiredMax != null) h.run('UPDATE org_members SET desired_min = ?, desired_max = ? WHERE org_id = ? AND account_id = ?', r.desiredMin, r.desiredMax, o.id, me.id);
    h.run('DELETE FROM org_nudges WHERE form_id = ? AND account_id = ?', f.id, me.id);
    return { status, response: responseOut(h.get('SELECT * FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, me.id)), hours: hoursMarked(slots, r.answers, periodDays(f)) };
  });
  OR('GET', '/v1/orgs/:id/forms/:fid/changes', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    return { changes: h.all('SELECT c.*, a.display_name FROM org_response_changes c JOIN accounts a ON a.id = c.account_id WHERE c.form_id = ? ORDER BY c.created_at DESC', f.id).map((c) => {
      const cur = h.get('SELECT answers FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, c.account_id);
      const p = J(c.proposal, {}), was = J(cur?.answers, {});
      const keys = new Set([...Object.keys(p.answers || {}), ...Object.keys(was)]);
      return { id: c.id, accountId: c.account_id, name: c.display_name, reason: c.reason, status: c.status, createdAt: c.created_at,
        diff: [...keys].filter((k) => (p.answers?.[k] || 'N') !== (was[k] || 'N')).sort().map((k) => ({ key: k, from: was[k] || 'N', to: p.answers?.[k] || 'N' })) };
    }) };
  });
  OR('POST', '/v1/orgs/:id/changes/:chid/decide', ({ me, params, body, ip }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const c = h.get('SELECT c.* FROM org_response_changes c JOIN org_forms f ON f.id = c.form_id WHERE c.id = ? AND f.org_id = ?', params.chid, o.id) ?? notFound('Change request not found.');
    if (c.status !== 'pending') bad('That change request was already decided.');
    const approve = V.bool(body.approve, 'Approve');
    h.tx(() => {
      if (approve) writeResponse(c.form_id, c.account_id, J(c.proposal, {}), true);
      h.run('UPDATE org_response_changes SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'denied', me.id, now(), c.id);
    });
    audit(me.id, approve ? 'org.change_approve' : 'org.change_deny', o.id, { change: c.id }, ip);
    return { ok: true };
  });
  /** Who answered what, for the matrix, the people view and the export. */
  const responsesFor = (o, f) => {
    const rows = new Map(h.all('SELECT * FROM org_responses WHERE form_id = ?', f.id).map((r) => [r.account_id, r]));
    return audienceOf(o, f).map((m) => {
      const r = rows.get(m.account_id);
      return { id: m.account_id, name: m.display_name, email: m.email, emailVerified: !!m.email_verified, departmentId: m.department_id, positionIds: positionsOf(o.id, m.account_id),
        minor: m.birthdate ? ageOn(m.birthdate, f.period_start) < 18 : false, desiredMinProfile: m.desired_min, desiredMaxProfile: m.desired_max,
        ...(responseOut(r) || { answers: {}, dateNotes: {}, note: null, desiredMin: null, desiredMax: null, daysOff: null, extra: {}, submittedAt: null, updatedAt: null }) };
    });
  };
  OR('GET', '/v1/orgs/:id/forms/:fid/matrix', ({ me, params, query }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    const slots = slotsOf(o, f);
    const sched = query.scheduleId ? h.get('SELECT * FROM org_schedules WHERE id = ? AND org_id = ?', query.scheduleId, o.id) : h.get('SELECT * FROM org_schedules WHERE form_id = ? ORDER BY created_at DESC LIMIT 1', f.id);
    const overrides = sched ? J(sched.need_overrides, {}) : {};
    const people = responsesFor(o, f).filter((p) => p.submittedAt);
    const posFilter = query.positionId || null;
    return {
      form: formOut(f),
      slots: slots.map((s) => {
        const need = needOf(s, overrides);
        const pick = (st) => people.filter((p) => p.answers[s.key] === st && (!posFilter || p.positionIds.includes(posFilter))).map((p) => ({ id: p.id, name: p.name }));
        const available = pick('A'), ifNeeded = pick('I');
        const n = posFilter ? need.filter((x) => x.positionId === posFilter).reduce((t, x) => t + x.count, 0) : needTotal(need);
        return { ...s, need, needTotal: n, available, ifNeeded, coverage: n ? Math.round((available.length / n) * 100) / 100 : null,
          notes: people.filter((p) => p.dateNotes[s.date]).map((p) => ({ id: p.id, name: p.name, note: p.dateNotes[s.date] })) };
      }),
      submitted: people.length,
    };
  });
  OR('GET', '/v1/orgs/:id/forms/:fid/people', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    const slots = slotsOf(o, f);
    const nudged = new Map(h.all('SELECT * FROM org_nudges WHERE form_id = ?', f.id).map((n) => [n.account_id, n.at]));
    const pending = new Set(h.all("SELECT account_id FROM org_response_changes WHERE form_id = ? AND status = 'pending'", f.id).map((r) => r.account_id));
    const people = responsesFor(o, f).map((p) => ({
      ...p, hours: hoursMarked(slots, p.answers, periodDays(f)), submitted: !!p.submittedAt,
      late: !!(p.submittedAt && f.deadline_at && p.submittedAt > f.deadline_at), nudgedAt: nudged.get(p.id) ?? null, pendingChange: pending.has(p.id),
    }));
    return { form: formOut(f), people, missing: people.filter((p) => !p.submitted).length };
  });
  OR('POST', '/v1/orgs/:id/forms/:fid/nudge', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    if (f.status !== 'open') bad('Send the form out first.');
    const answered = new Set(h.all('SELECT account_id FROM org_responses WHERE form_id = ? AND submitted_at IS NOT NULL', f.id).map((r) => r.account_id));
    const want = body.accountIds ? new Set(list(body.accountIds, 'People', 2000)) : null;
    let n = 0;
    for (const m of audienceOf(o, f)) {
      if (answered.has(m.account_id) || (want && !want.has(m.account_id))) continue;
      h.run('INSERT INTO org_nudges (form_id,account_id,at) VALUES (?,?,?) ON CONFLICT(form_id,account_id) DO UPDATE SET at = excluded.at', f.id, m.account_id, now());
      // A nudge brings a snoozed reminder back.
      h.run('DELETE FROM org_todo_snoozes WHERE account_id = ? AND item_key = ?', m.account_id, `${o.id}:availability:${f.id}`);
      n++;
    }
    return { nudged: n };
  });
  OR('GET', '/v1/orgs/:id/forms/:fid/export', ({ me, params, query }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = formRow(o.id, params.fid);
    const slots = slotsOf(o, f);
    const rows = responsesFor(o, f).filter((p) => p.submittedAt).sort((a, b) => a.submittedAt - b.submittedAt);
    const format = V.enum(query.format ?? 'sheets', 'Format', ['sheets', 'long']);
    const csv = format === 'long' ? longExport({ slots, rows }) : sheetsExport({ form: formObj(f), slots, rows, tz: o.tz, questions: formObj(f).questions });
    const filename = `${f.title.replace(/[^\w .-]+/g, '').trim() || 'availability'}${format === 'long' ? ' (by date)' : ''}.csv`;
    if (query.as === 'json') return { filename, csv };
    return rawOut(Buffer.from('﻿' + csv, 'utf8'), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` });
  });

  // ---------- schedules ----------
  const schedRow = (oid, sid) => h.get('SELECT * FROM org_schedules WHERE id = ? AND org_id = ?', sid, oid) ?? notFound('Schedule not found.');
  const shiftRow = (oid, shid) => h.get('SELECT * FROM org_shifts WHERE id = ? AND org_id = ?', shid, oid) ?? notFound('Shift not found.');
  const names = (oid) => new Map(h.all('SELECT a.id, a.display_name FROM org_members m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = ?', oid).map((r) => [r.id, r.display_name]));
  const posNames = (oid) => new Map(h.all('SELECT id, name FROM org_positions WHERE org_id = ?', oid).map((p) => [p.id, p.name]));
  const shiftOut = (s, nm, pn) => ({
    id: s.id, scheduleId: s.schedule_id, accountId: s.account_id, name: s.account_id ? nm.get(s.account_id) ?? null : null, positionId: s.position_id, positionName: pn.get(s.position_id) ?? null,
    departmentId: s.department_id, locationId: s.location_id, date: s.date, blockId: s.block_id, slotKey: s.block_id ? `${s.date}|${s.block_id}` : null,
    start: new Date(s.start_at).toISOString(), end: new Date(s.end_at).toISOString(), startAt: s.start_at, endAt: s.end_at, status: s.status, source: s.source, note: s.note, forced: !!s.forced,
  });
  const schedOut = (r) => ({ id: r.id, formId: r.form_id, title: r.title, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, needOverrides: J(r.need_overrides, {}), createdAt: r.created_at, publishedAt: r.published_at,
    drafts: h.get("SELECT COUNT(*) AS n FROM org_shifts WHERE schedule_id = ? AND status = 'draft'", r.id).n,
    published: h.get("SELECT COUNT(*) AS n FROM org_shifts WHERE schedule_id = ? AND status = 'published'", r.id).n });
  const schedSlots = (o, sc) => {
    const f = sc.form_id ? h.get('SELECT * FROM org_forms WHERE id = ?', sc.form_id) : null;
    return f ? slotsOf(o, f) : [];
  };
  OR('GET', '/v1/orgs/:id/schedules', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    return { schedules: h.all('SELECT * FROM org_schedules WHERE org_id = ? ORDER BY period_start DESC', o.id).map(schedOut) };
  });
  OR('POST', '/v1/orgs/:id/schedules', ({ me, params, body, ip }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const f = body.formId ? formRow(o.id, body.formId) : null;
    const start = f ? f.period_start : date(body.periodStart, 'Start'), end = f ? f.period_end : date(body.periodEnd, 'End');
    if (end < start) bad('The end must be on or after the start.');
    const sid = id();
    capRows('org_schedules', o.id, 2000, 'schedules');
    h.run('INSERT INTO org_schedules (id,org_id,form_id,title,period_start,period_end,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', sid, o.id, f?.id ?? null,
      V.str(body.title ?? (f ? f.title.replace(/availability/i, 'schedule') : `Schedule ${start}`), 'Title', { min: 1, max: 120 }), start, end, me.id, now());
    audit(me.id, 'org.schedule_create', o.id, { schedule: sid }, ip);
    return { status: 201, body: { schedule: schedOut(schedRow(o.id, sid)) } };
  });
  /** The schedule builder's data: slots with need, coverage and who's available, shifts, people's hours, budgets. */
  OR('GET', '/v1/orgs/:id/schedules/:sid', ({ me, params }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const slots = schedSlots(o, sc);
    const overrides = J(sc.need_overrides, {});
    const nm = names(o.id), pn = posNames(o.id);
    const shifts = h.all('SELECT * FROM org_shifts WHERE schedule_id = ? ORDER BY start_at', sc.id).map((x) => shiftOut(x, nm, pn));
    const f = sc.form_id ? h.get('SELECT * FROM org_forms WHERE id = ?', sc.form_id) : null;
    const resp = f ? new Map(responsesFor(o, f).map((p) => [p.id, p])) : new Map();
    const fromMs = zonedToUtc(sc.period_start, '00:00', o.tz), toMs = zonedToUtc(addDays(sc.period_end, 1), '00:00', o.tz);
    const people = membersOf(o.id).map((m) => {
      const r = resp.get(m.account_id);
      const all = h.all('SELECT start_at, end_at, date FROM org_shifts WHERE org_id = ? AND account_id = ? AND start_at < ? AND end_at > ?', o.id, m.account_id, toMs, fromMs);
      const byWeek = {};
      for (const x of all) { const wk = weekKey(o, x.date); byWeek[wk] = (byWeek[wk] || 0) + (x.end_at - x.start_at) / 3600_000; }
      return { id: m.account_id, name: m.display_name, positionIds: positionsOf(o.id, m.account_id), departmentId: m.department_id,
        desiredMin: r?.desiredMin ?? m.desired_min, desiredMax: r?.desiredMax ?? m.desired_max, minor: m.birthdate ? ageOn(m.birthdate, sc.period_start) < 18 : false,
        submitted: !!r?.submittedAt, note: r?.note ?? null, prefs: J(m.prefs, []),
        hours: Math.round(all.reduce((t, x) => t + (x.end_at - x.start_at) / 3600_000, 0) * 10) / 10, hoursByWeek: byWeek };
    });
    return {
      schedule: schedOut(sc), form: f ? formOut(f) : null, weeks: weeksOf(o, sc.period_start, sc.period_end),
      slots: slots.map((sl) => {
        const need = needOf(sl, overrides);
        const avail = [], ifn = [];
        for (const p of resp.values()) { if (p.answers[sl.key] === 'A') avail.push(p.id); else if (p.answers[sl.key] === 'I') ifn.push(p.id); }
        const assigned = shifts.filter((x) => x.slotKey === sl.key);
        return { ...sl, need, needTotal: needTotal(need), available: avail, ifNeeded: ifn, assigned: assigned.map((x) => x.id),
          dateNotes: [...resp.values()].filter((p) => p.dateNotes[sl.date]).map((p) => ({ id: p.id, name: p.name, note: p.dateNotes[sl.date] })) };
      }),
      shifts, people, budget: budgetRows(o, s, sc.period_start, sc.period_end),
      draftsWaiting: h.get("SELECT COUNT(*) AS n FROM org_drafts WHERE schedule_id = ? AND status = 'waiting'", sc.id).n,
      autofillDefaults: s.autofill,
    };
  });
  const weekKey = (o, d) => weekStartOf(d, o.workweek_start);
  const weeksOf = (o, start, end) => { const out = []; for (let w = weekKey(o, start); w <= end; w = addDays(w, 7)) out.push(w); return out; };
  OR('POST', '/v1/orgs/:id/schedules/:sid/needs', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const keys = new Set(schedSlots(o, sc).map((x) => x.key));
    const next = { ...J(sc.need_overrides, {}) };
    for (const [k, v] of Object.entries(V.obj(body.overrides))) {
      if (!keys.has(k)) bad(`${k} is not a block in this schedule.`);
      if (v == null) delete next[k]; else next[k] = parseNeed(o.id, v);
    }
    h.run('UPDATE org_schedules SET need_overrides = ? WHERE id = ?', JSON.stringify(next), sc.id);
    return { schedule: schedOut(schedRow(o.id, sc.id)) };
  });
  /** Where and when a shift is: a block of the schedule's form, or a date with times. */
  const placeOf = (o, sc, body, prev = null) => {
    if (body.blockId != null || (body.date != null && body.start == null)) {
      const d = date(body.date ?? prev?.date, 'Date');
      const sl = schedSlots(o, sc).find((x) => x.date === d && x.blockId === (body.blockId ?? prev?.block_id)) ?? bad('That block is not on that date in this schedule.');
      return { date: d, blockId: sl.blockId, startAt: sl.startAt, endAt: sl.endAt };
    }
    if (body.start != null || body.end != null) {
      const d = date(body.date ?? prev?.date, 'Date');
      const st = tod(body.start, 'Start'), en = tod(body.end, 'End');
      return { date: d, blockId: null, startAt: zonedToUtc(d, st, o.tz), endAt: zonedToUtc(toMin(en) > toMin(st) ? d : addDays(d, 1), en, o.tz) };
    }
    if (prev) return { date: prev.date, blockId: prev.block_id, startAt: prev.start_at, endAt: prev.end_at };
    bad('Pick a block, or a date with start and end times.');
  };
  const verdict = (problems) => ({ problems, blocked: problems.some((p) => p.blocking), canForce: problems.every((p) => !p.blocking || p.forceable) });
  OR('POST', '/v1/orgs/:id/schedules/:sid/check', ({ me, params, body }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const prev = body.shiftId ? shiftRow(o.id, body.shiftId) : null;
    const pl = placeOf(o, sc, body, prev);
    const cx = checkCtx(o, s);
    const positionId = positionRow(o.id, body.positionId ?? prev?.position_id).id;
    const aid = V.str(body.accountId, 'Person', { min: 1, max: 80 });
    return verdict(problemsFor(o, cx, aid, positionId, pl.startAt, pl.endAt, prev?.id));
  });
  OR('POST', '/v1/orgs/:id/shifts', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = body.scheduleId ? schedRow(o.id, body.scheduleId) : null;
    const pl = placeOf(o, sc ?? { form_id: null }, body);
    const pos = positionRow(o.id, body.positionId);
    const aid = body.accountId ? V.str(body.accountId, 'Person', { min: 1, max: 80 }) : null;
    let forced = 0;
    if (aid) {
      const v = verdict(problemsFor(o, checkCtx(o, s), aid, pos.id, pl.startAt, pl.endAt));
      if (v.blocked && (!v.canForce || body.force !== true)) throw new HttpError(409, v.canForce ? 'This shift has a problem. Assign anyway?' : "This person can't take this shift.", v);
      forced = v.blocked ? 1 : 0;
    }
    const shid = id();
    h.run('INSERT INTO org_shifts (id,org_id,schedule_id,account_id,position_id,department_id,location_id,date,block_id,start_at,end_at,status,source,note,forced,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      shid, o.id, sc?.id ?? null, aid, pos.id, body.departmentId ? deptRow(o.id, body.departmentId).id : pos.department_id, body.locationId ? locRow(o.id, body.locationId).id : null,
      pl.date, pl.blockId, pl.startAt, pl.endAt, 'draft', 'manual', V.str(body.note, 'Note', { optional: true, max: 300 }), forced, now());
    if (forced) audit(me.id, 'org.shift_forced', o.id, { shift: shid }, ip);
    const sh = shiftRow(o.id, shid);
    return { status: 201, body: { shift: shiftOut(sh, names(o.id), posNames(o.id)), ...(aid ? verdict(problemsFor(o, checkCtx(o, s), aid, pos.id, sh.start_at, sh.end_at, sh.id)) : {}) } };
  });
  OR('POST', '/v1/orgs/:id/shifts/:shid', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sh = shiftRow(o.id, params.shid);
    const sc = sh.schedule_id ? schedRow(o.id, sh.schedule_id) : { form_id: null };
    const pl = placeOf(o, sc, body, sh);
    const pos = body.positionId ? positionRow(o.id, body.positionId).id : sh.position_id;
    const aid = 'accountId' in body ? (body.accountId ? V.str(body.accountId, 'Person', { min: 1, max: 80 }) : null) : sh.account_id;
    let forced = 0;
    if (aid) {
      const v = verdict(problemsFor(o, checkCtx(o, s), aid, pos, pl.startAt, pl.endAt, sh.id));
      if (v.blocked && (!v.canForce || body.force !== true)) throw new HttpError(409, v.canForce ? 'This shift has a problem. Assign anyway?' : "This person can't take this shift.", v);
      forced = v.blocked ? 1 : 0;
    }
    // Changing a published shift makes it a draft again until the next publish, so people see only what's final.
    h.run("UPDATE org_shifts SET account_id = ?, position_id = ?, date = ?, block_id = ?, start_at = ?, end_at = ?, note = ?, forced = ?, status = CASE WHEN status = 'published' AND (? IS NOT account_id OR ? != start_at OR ? != end_at OR ? != position_id) THEN 'draft' ELSE status END WHERE id = ?",
      aid, pos, pl.date, pl.blockId, pl.startAt, pl.endAt, 'note' in body ? V.str(body.note, 'Note', { optional: true, max: 300 }) : sh.note, forced, aid, pl.startAt, pl.endAt, pos, sh.id);
    if (forced) audit(me.id, 'org.shift_forced', o.id, { shift: sh.id }, ip);
    return { shift: shiftOut(shiftRow(o.id, sh.id), names(o.id), posNames(o.id)) };
  });
  OR('POST', '/v1/orgs/:id/shifts/:shid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const sh = shiftRow(o.id, params.shid);
    h.tx(() => { h.run("UPDATE org_swaps SET status = 'cancelled' WHERE shift_id = ? AND status IN ('offered','claimed')", sh.id); h.run('DELETE FROM org_shifts WHERE id = ?', sh.id); });
    return { ok: true };
  });
  OR('POST', '/v1/orgs/:id/schedules/:sid/autofill', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const f = sc.form_id ? h.get('SELECT * FROM org_forms WHERE id = ?', sc.form_id) : null;
    if (!f) bad('Auto-fill needs a schedule made from an availability form.');
    const overrides = J(sc.need_overrides, {});
    const slots = slotsOf(o, f).map((x) => ({ ...x, need: needOf(x, overrides) })).filter((x) => x.endAt > now());
    const cx = checkCtx(o, s);
    const resp = responsesFor(o, f).filter((p) => p.submittedAt);
    const people = resp.map((p) => ({ ...cx.people.get(p.id), desiredMin: p.desiredMin ?? p.desiredMinProfile, desiredMax: p.desiredMax ?? p.desiredMaxProfile })).filter((p) => p.id);
    const fromMs = zonedToUtc(f.period_start, '00:00', o.tz) - 8 * 86400_000, toMs = zonedToUtc(addDays(f.period_end, 1), '00:00', o.tz) + 8 * 86400_000;
    // Everything people already work (this schedule and others) counts toward overlap, hours and minor limits.
    const existing = h.all('SELECT * FROM org_shifts WHERE org_id = ? AND account_id IS NOT NULL AND start_at < ? AND end_at > ?', o.id, toMs, fromMs)
      .map((x) => ({ accountId: x.account_id, positionId: x.position_id, slotKey: x.schedule_id === sc.id && x.block_id ? `${x.date}|${x.block_id}` : `other:${x.id}`, date: x.date, startAt: x.start_at, endAt: x.end_at }));
    // Open (unassigned) shifts in a slot count as filled places too: auto-fill gives them people instead of adding more.
    const openShifts = h.all('SELECT * FROM org_shifts WHERE schedule_id = ? AND account_id IS NULL', sc.id);
    const opts = { ...s.autofill, ...Object.fromEntries(['useIfNeeded', 'hardMaxHours', 'allowOvertime'].filter((k) => k in body).map((k) => [k, V.bool(body[k], k)])), workweekStart: o.workweek_start,
      onlySlots: body.dates ? new Set(slots.filter((x) => list(body.dates, 'Dates', 400).includes(x.date)).map((x) => x.key)) : null };
    const res = autofill({ slots, people, answers: new Map(resp.map((p) => [p.id, p.answers])), shifts: existing, check: (p, sh, theirs) => cx.check(p, sh, theirs), options: opts });
    h.tx(() => {
      for (const a of res.add) {
        const reuse = openShifts.findIndex((x) => `${x.date}|${x.block_id}` === a.slotKey && x.position_id === a.positionId);
        if (reuse >= 0) { h.run("UPDATE org_shifts SET account_id = ?, source = 'autofill' WHERE id = ?", a.accountId, openShifts[reuse].id); openShifts.splice(reuse, 1); continue; }
        const pos = cx.positions.find((p) => p.id === a.positionId);
        h.run("INSERT INTO org_shifts (id,org_id,schedule_id,account_id,position_id,department_id,date,block_id,start_at,end_at,status,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'draft','autofill',?)",
          id(), o.id, sc.id, a.accountId, a.positionId, pos?.department_id ?? null, a.date, a.blockId, a.startAt, a.endAt, now());
      }
    });
    audit(me.id, 'org.autofill', o.id, { schedule: sc.id, added: res.add.length, unfilled: res.unfilled.length }, ip);
    return { added: res.add.length, ifNeededUsed: res.add.filter((a) => a.state === 'I').length, unfilled: res.unfilled };
  });
  OR('POST', '/v1/orgs/:id/schedules/:sid/clear', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const only = V.enum(body.source ?? 'autofill', 'Which', ['autofill', 'drafts']);
    const r = h.run(`DELETE FROM org_shifts WHERE schedule_id = ? AND status = 'draft'${only === 'autofill' ? " AND source = 'autofill'" : ''}`, sc.id);
    return { removed: Number(r.changes) };
  });
  OR('POST', '/v1/orgs/:id/schedules/:sid/publish', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const over = budgetRows(o, s, sc.period_start, sc.period_end).filter((b) => b.current && b.scheduled > b.amount);
    if (over.length && body.confirmOverBudget !== true) throw new HttpError(409, 'This schedule goes over budget. Publish anyway?', { budgetWarnings: over });
    const r = h.run("UPDATE org_shifts SET status = 'published' WHERE schedule_id = ? AND status = 'draft' AND account_id IS NOT NULL", sc.id);
    h.run("UPDATE org_schedules SET status = 'published', published_at = ? WHERE id = ?", now(), sc.id);
    audit(me.id, 'org.schedule_publish', o.id, { schedule: sc.id, shifts: Number(r.changes), overBudget: over.length }, ip);
    return { published: Number(r.changes), schedule: schedOut(schedRow(o.id, sc.id)) };
  });

  // Drafts from elsewhere (for example an optional Claude client): stored and checked, never published on their own.
  const draftOut = (d, o, cx) => {
    const shifts = J(d.shifts, []);
    const nm = names(o.id);
    return { id: d.id, source: d.source, summary: d.summary, status: d.status, createdAt: d.created_at,
      shifts: shifts.map((x) => ({ ...x, name: nm.get(x.accountId) ?? null, ...(cx && d.status === 'waiting' ? verdict(problemsFor(o, cx, x.accountId, x.positionId, x.startAt, x.endAt)) : {}) })) };
  };
  OR('POST', '/v1/orgs/:id/schedules/:sid/drafts', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const cx = checkCtx(o, s);
    const shifts = list(body.shifts, 'Shifts', 3000).map((x, i) => {
      const pl = placeOf(o, sc, V.obj(x));
      const aid = V.str(x.accountId, `Shift ${i + 1} person`, { min: 1, max: 80 });
      if (!cx.people.has(aid)) bad(`Shift ${i + 1}: that person is not an active member.`);
      return { accountId: aid, positionId: positionRow(o.id, x.positionId).id, date: pl.date, blockId: pl.blockId, startAt: pl.startAt, endAt: pl.endAt, why: V.str(x.why, 'Reason', { optional: true, max: 500 }) };
    });
    const did = id();
    h.run('INSERT INTO org_drafts (id,schedule_id,source,summary,shifts,created_by,created_at) VALUES (?,?,?,?,?,?,?)', did, sc.id, V.str(body.source ?? 'claude', 'Source', { min: 1, max: 40 }),
      V.str(body.summary, 'Summary', { optional: true, max: 4000 }), JSON.stringify(shifts), me.id, now());
    audit(me.id, 'org.draft_submit', o.id, { schedule: sc.id, draft: did, shifts: shifts.length }, ip);
    return { status: 201, body: { draft: draftOut(h.get('SELECT * FROM org_drafts WHERE id = ?', did), o, cx) } };
  });
  OR('GET', '/v1/orgs/:id/schedules/:sid/drafts', ({ me, params }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const sc = schedRow(o.id, params.sid);
    const cx = checkCtx(o, s);
    return { drafts: h.all('SELECT * FROM org_drafts WHERE schedule_id = ? ORDER BY created_at DESC', sc.id).map((d) => draftOut(d, o, cx)) };
  });
  OR('POST', '/v1/orgs/:id/drafts/:did/apply', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const d = h.get('SELECT d.* FROM org_drafts d JOIN org_schedules sc ON sc.id = d.schedule_id WHERE d.id = ? AND sc.org_id = ?', params.did, o.id) ?? notFound('Draft not found.');
    if (d.status !== 'waiting') bad('That draft was already used or set aside.');
    const cx = checkCtx(o, s);
    const skip = [];
    let added = 0;
    h.tx(() => {
      if (body.replace === true) h.run("DELETE FROM org_shifts WHERE schedule_id = ? AND status = 'draft'", d.schedule_id);
      for (const x of J(d.shifts, [])) {
        // Applied one at a time so each sees the ones before it; anything blocked is left out and listed.
        const v = verdict(problemsFor(o, cx, x.accountId, x.positionId, x.startAt, x.endAt));
        if (v.blocked) { skip.push({ ...x, problems: v.problems }); continue; }
        const pos = cx.positions.find((p) => p.id === x.positionId);
        h.run("INSERT INTO org_shifts (id,org_id,schedule_id,account_id,position_id,department_id,date,block_id,start_at,end_at,status,source,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)",
          id(), o.id, d.schedule_id, x.accountId, x.positionId, pos?.department_id ?? null, x.date, x.blockId, x.startAt, x.endAt, `draft:${d.source}`, x.why ?? null, now());
        added++;
      }
      h.run("UPDATE org_drafts SET status = 'applied', decided_by = ?, decided_at = ? WHERE id = ?", me.id, now(), d.id);
    });
    audit(me.id, 'org.draft_apply', o.id, { draft: d.id, added, skipped: skip.length }, ip);
    return { added, skipped: skip };
  });
  OR('POST', '/v1/orgs/:id/drafts/:did/discard', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const d = h.get('SELECT d.* FROM org_drafts d JOIN org_schedules sc ON sc.id = d.schedule_id WHERE d.id = ? AND sc.org_id = ?', params.did, o.id) ?? notFound('Draft not found.');
    h.run("UPDATE org_drafts SET status = 'discarded', decided_by = ?, decided_at = ? WHERE id = ?", me.id, now(), d.id);
    return { ok: true };
  });

  // ---------- my shifts, the org schedule for members, the calendar ----------
  OR('GET', '/v1/orgs/:id/my-shifts', ({ me, params, query }) => {
    const { o } = asOrg(params.id, me);
    const from = query.from ? V.time(query.from, 'from') : now() - 7 * 86400_000, to = query.to ? V.time(query.to, 'to') : now() + 62 * 86400_000;
    const nm = names(o.id), pn = posNames(o.id);
    const swaps = new Map(h.all("SELECT * FROM org_swaps WHERE org_id = ? AND from_account = ? AND status IN ('offered','claimed')", o.id, me.id).map((w) => [w.shift_id, w]));
    return { shifts: h.all("SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND status = 'published' AND end_at > ? AND start_at < ? ORDER BY start_at", o.id, me.id, from, to)
      .map((x) => ({ ...shiftOut(x, nm, pn), swap: swaps.has(x.id) ? { id: swaps.get(x.id).id, status: swaps.get(x.id).status } : null })) };
  });
  OR('GET', '/v1/orgs/:id/schedule', ({ me, params, query }) => {
    const { o, s, mgr } = asOrg(params.id, me);
    if (!mgr && !s.membersSeeSchedule) forbidden('Your organization shows each person only their own shifts.');
    const from = query.from ? V.time(query.from, 'from') : now() - 86400_000, to = query.to ? V.time(query.to, 'to') : now() + 14 * 86400_000;
    if (to - from > 93 * 86400_000) bad('Ask for at most 93 days at a time.');
    const nm = names(o.id), pn = posNames(o.id);
    return { shifts: h.all("SELECT * FROM org_shifts WHERE org_id = ? AND status = 'published' AND end_at > ? AND start_at < ? ORDER BY start_at", o.id, from, to).map((x) => shiftOut(x, nm, pn)) };
  });
  /** Everything for Kea's calendar across my orgs: published shifts and org class sessions. */
  OR('GET', '/v1/orgs-calendar', ({ me, query }) => {
    const from = query.from ? V.time(query.from, 'from') : now() - 7 * 86400_000, to = query.to ? V.time(query.to, 'to') : now() + 62 * 86400_000;
    if (to - from > 400 * 86400_000) bad('Ask for at most 400 days at a time.');
    const events = [];
    for (const o of h.all("SELECT o.* FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.account_id = ? AND m.status = 'active' AND o.status = 'active'", me.id)) {
      const pn = posNames(o.id);
      for (const x of h.all("SELECT * FROM org_shifts WHERE org_id = ? AND account_id = ? AND status = 'published' AND end_at > ? AND start_at < ? ORDER BY start_at", o.id, me.id, from, to))
        events.push({ id: `shift:${x.id}`, kind: 'shift', orgId: o.id, orgName: o.name, title: pn.get(x.position_id) ?? 'Shift', start: new Date(x.start_at).toISOString(), end: new Date(x.end_at).toISOString(), date: x.date });
      for (const c of h.all("SELECT s.*, c.title AS class_title FROM class_sessions s JOIN org_classes oc ON oc.class_id = s.class_id JOIN classes c ON c.id = s.class_id JOIN class_members cm ON cm.class_id = s.class_id AND cm.account_id = ? WHERE oc.org_id = ? AND c.status = 'active' AND s.end_at >= ? AND s.start_at <= ?", me.id, o.id, from, to))
        events.push({ id: `class:${c.id}`, kind: 'class', orgId: o.id, orgName: o.name, title: c.title || c.class_title, classTitle: c.class_title, start: new Date(c.start_at).toISOString(), end: new Date(c.end_at).toISOString(), location: c.location, meetingUrl: c.meeting_url, date: localDate(c.start_at, o.tz) });
    }
    return { events: events.sort((a, b) => (a.start < b.start ? -1 : 1)) };
  });

  // ---------- swaps ----------
  const swapOut = (w, nm, pn) => {
    const sh = h.get('SELECT * FROM org_shifts WHERE id = ?', w.shift_id);
    return { id: w.id, shiftId: w.shift_id, from: w.from_account, fromName: nm.get(w.from_account) ?? null, to: w.to_account, toName: w.to_account ? nm.get(w.to_account) ?? null : null,
      claimant: w.claimant, claimantName: w.claimant ? nm.get(w.claimant) ?? null : null, note: w.note, status: w.status, createdAt: w.created_at, shift: sh ? shiftOut(sh, nm, pn) : null };
  };
  OR('POST', '/v1/orgs/:id/shifts/:shid/swap', ({ me, params, body, ip }) => {
    const { o } = asOrg(params.id, me);
    const sh = shiftRow(o.id, params.shid);
    if (sh.account_id !== me.id || sh.status !== 'published') bad('You can only offer your own published shifts.');
    if (sh.start_at <= now()) bad('That shift has already started.');
    if (h.get("SELECT 1 FROM org_swaps WHERE shift_id = ? AND status IN ('offered','claimed')", sh.id)) bad('That shift is already offered.');
    const to = body.toAccountId ? V.str(body.toAccountId, 'Person', { min: 1, max: 80 }) : null;
    if (to && (!memberRow(o.id, to) || to === me.id)) bad('Pick someone else in this organization.');
    const wid = id();
    h.run('INSERT INTO org_swaps (id,org_id,shift_id,from_account,to_account,note,created_at) VALUES (?,?,?,?,?,?,?)', wid, o.id, sh.id, me.id, to, V.str(body.note, 'Note', { optional: true, max: 300 }), now());
    audit(me.id, 'org.swap_offer', o.id, { swap: wid }, ip);
    return { status: 201, body: { swap: swapOut(h.get('SELECT * FROM org_swaps WHERE id = ?', wid), names(o.id), posNames(o.id)) } };
  });
  OR('GET', '/v1/orgs/:id/swaps', ({ me, params }) => {
    const { o, mgr } = asOrg(params.id, me);
    const nm = names(o.id), pn = posNames(o.id);
    const mine = positionsOf(o.id, me.id);
    const rows = h.all("SELECT w.*, s.position_id, s.start_at FROM org_swaps w JOIN org_shifts s ON s.id = w.shift_id WHERE w.org_id = ? AND (w.status IN ('offered','claimed') OR w.created_at > ?) ORDER BY s.start_at", o.id, now() - 30 * 86400_000);
    return { swaps: rows.filter((w) => mgr || w.from_account === me.id || w.claimant === me.id || w.to_account === me.id || (w.status === 'offered' && !w.to_account && mine.includes(w.position_id) && w.start_at > now()))
      .map((w) => swapOut(w, nm, pn)) };
  });
  const swapRow = (oid, wid) => h.get('SELECT * FROM org_swaps WHERE id = ? AND org_id = ?', wid, oid) ?? notFound('Swap not found.');
  const reassign = (o, w, to) => h.run('UPDATE org_shifts SET account_id = ? WHERE id = ?', to, w.shift_id);
  OR('POST', '/v1/orgs/:id/swaps/:wid/claim', ({ me, params, ip }) => {
    const { o, s } = asOrg(params.id, me);
    const w = swapRow(o.id, params.wid);
    if (w.status !== 'offered') bad('Someone already took that shift.');
    if (w.from_account === me.id) bad("That's your own shift.");
    if (w.to_account && w.to_account !== me.id) notFound('Swap not found.');
    const sh = shiftRow(o.id, w.shift_id);
    if (sh.start_at <= now()) bad('That shift has already started.');
    const v = verdict(problemsFor(o, checkCtx(o, s), me.id, sh.position_id, sh.start_at, sh.end_at));
    if (v.blocked) throw new HttpError(409, "You can't take this shift.", v);
    h.tx(() => {
      if (s.swapNeedsApproval) h.run("UPDATE org_swaps SET claimant = ?, status = 'claimed' WHERE id = ?", me.id, w.id);
      else { h.run("UPDATE org_swaps SET claimant = ?, status = 'approved', decided_at = ? WHERE id = ?", me.id, now(), w.id); reassign(o, w, me.id); }
    });
    audit(me.id, 'org.swap_claim', o.id, { swap: w.id }, ip);
    return { swap: swapOut(swapRow(o.id, w.id), names(o.id), posNames(o.id)), ...v };
  });
  OR('POST', '/v1/orgs/:id/swaps/:wid/decide', ({ me, params, body, ip }) => {
    const { o, s } = asOrg(params.id, me, 'manager');
    const w = swapRow(o.id, params.wid);
    if (!['offered', 'claimed'].includes(w.status)) bad(`That swap is already ${w.status}.`);
    const approve = V.bool(body.approve, 'Approve');
    if (approve) {
      if (w.status !== 'claimed') bad('Nobody has taken this shift yet.');
      const sh = shiftRow(o.id, w.shift_id);
      const v = verdict(problemsFor(o, checkCtx(o, s), w.claimant, sh.position_id, sh.start_at, sh.end_at));
      if (v.blocked) throw new HttpError(409, `${names(o.id).get(w.claimant)} can't take this shift now.`, v);
      h.tx(() => { reassign(o, w, w.claimant); h.run("UPDATE org_swaps SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", me.id, now(), w.id); });
    } else h.run("UPDATE org_swaps SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?", me.id, now(), w.id);
    audit(me.id, approve ? 'org.swap_approve' : 'org.swap_deny', o.id, { swap: w.id }, ip);
    return { swap: swapOut(swapRow(o.id, w.id), names(o.id), posNames(o.id)) };
  });
  OR('POST', '/v1/orgs/:id/swaps/:wid/cancel', ({ me, params }) => {
    const { o } = asOrg(params.id, me);
    const w = swapRow(o.id, params.wid);
    if (w.from_account !== me.id) forbidden('Only the person who offered it can take it back.');
    if (!['offered', 'claimed'].includes(w.status)) bad(`That swap is already ${w.status}.`);
    h.run("UPDATE org_swaps SET status = 'cancelled', decided_at = ? WHERE id = ?", now(), w.id);
    return { ok: true };
  });

  // ---------- budgets ----------
  /** Labor cost in cents per department (own shifts only) for shifts starting in [from, to). */
  function laborCost(o, fromMs, toMs) {
    const pos = new Map(h.all('SELECT * FROM org_positions WHERE org_id = ?', o.id).map((p) => [p.id, p]));
    const mem = new Map(h.all('SELECT account_id, cost_rate, department_id FROM org_members WHERE org_id = ?', o.id).map((m) => [m.account_id, m]));
    const out = new Map();
    for (const x of h.all('SELECT * FROM org_shifts WHERE org_id = ? AND start_at >= ? AND start_at < ?', o.id, fromMs, toMs)) {
      const p = pos.get(x.position_id), m = x.account_id ? mem.get(x.account_id) : null;
      const rate = m?.cost_rate ?? p?.cost_rate ?? 0;
      const dept = x.department_id ?? p?.department_id ?? m?.department_id ?? null;
      const c = Math.round(((x.end_at - x.start_at) / 3600_000) * rate);
      const t = out.get(dept) || { scheduled: 0, published: 0, worked: 0, hours: 0 };
      t.scheduled += c; t.hours += (x.end_at - x.start_at) / 3600_000;
      if (x.status === 'published') t.published += c;
      if (x.status === 'published' && x.end_at <= now()) t.worked += c;
      out.set(dept, t);
    }
    return out;
  }
  function budgetRows(o, s, from, to) {
    const rows = h.all('SELECT b.*, d.name AS dept_name FROM org_budgets b JOIN org_departments d ON d.id = b.department_id WHERE b.org_id = ? AND b.period_end >= ? AND b.period_start <= ? ORDER BY d.name, b.period_start, b.created_at', o.id, from, to);
    const latest = new Map();
    for (const b of rows) latest.set(`${b.department_id}|${b.period_start}|${b.period_end}`, b.id);
    return rows.map((b) => {
      const cost = laborCost(o, zonedToUtc(b.period_start, '00:00', o.tz), zonedToUtc(addDays(b.period_end, 1), '00:00', o.tz));
      const tree = subtree(o.id, b.department_id);
      const sum = { scheduled: 0, published: 0, worked: 0, hours: 0 };
      for (const [d, t] of cost) if (tree.has(d)) for (const k of Object.keys(sum)) sum[k] += t[k];
      const pct = b.amount ? Math.round((sum.scheduled / b.amount) * 100) : null;
      return { id: b.id, departmentId: b.department_id, departmentName: b.dept_name, periodStart: b.period_start, periodEnd: b.period_end, label: b.label, note: b.note,
        current: latest.get(`${b.department_id}|${b.period_start}|${b.period_end}`) === b.id,
        amount: b.amount / 100, scheduled: sum.scheduled / 100, published: sum.published / 100, worked: sum.worked / 100, hours: Math.round(sum.hours * 10) / 10,
        pct, warn: pct != null && pct >= s.budgetWarnPct, over: sum.scheduled > b.amount };
    });
  }
  OR('GET', '/v1/orgs/:id/budgets', ({ me, params, query }) => {
    const { o, s, tz } = asOrg(params.id, me, 'manager');
    const t = today(tz);
    const from = date(query.from ?? addDays(t, -31), 'From'), to = date(query.to ?? addDays(t, 93), 'To');
    // Departments without a budget still show what they're scheduled to cost.
    const cost = laborCost(o, zonedToUtc(from, '00:00', o.tz), zonedToUtc(addDays(to, 1), '00:00', o.tz));
    return { budgets: budgetRows(o, s, from, to), unbudgeted: [...cost.entries()].map(([d, c]) => ({ departmentId: d, scheduled: c.scheduled / 100, published: c.published / 100, hours: Math.round(c.hours * 10) / 10 })), warnPct: s.budgetWarnPct };
  });
  OR('POST', '/v1/orgs/:id/budgets', ({ me, params, body, ip }) => {
    const { o } = asOrg(params.id, me, 'admin');
    const d = deptRow(o.id, body.departmentId);
    const start = date(body.periodStart, 'Start'), end = date(body.periodEnd, 'End');
    if (end < start) bad('The end must be on or after the start.');
    const bid = id();
    h.run('INSERT INTO org_budgets (id,org_id,department_id,period_start,period_end,amount,label,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', bid, o.id, d.id, start, end,
      cents(body.amount, 'Amount') ?? bad('Give an amount.'), V.str(body.label ?? 'Original', 'Version', { min: 1, max: 40 }), V.str(body.note, 'Note', { optional: true, max: 300 }), me.id, now());
    audit(me.id, 'org.budget_set', o.id, { budget: bid }, ip);
    return { status: 201, body: { id: bid } };
  });
  OR('POST', '/v1/orgs/:id/budgets/:bid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'admin');
    h.run('DELETE FROM org_budgets WHERE id = ? AND org_id = ?', params.bid, o.id);
    return { ok: true };
  });

  // ---------- acknowledgments ----------
  OR('POST', '/v1/orgs/:id/policies', ({ me, params, body }) => {
    const { o } = asOrg(params.id, me, 'manager');
    const pid = id();
    capRows('org_policies', o.id, 1000, 'acknowledgments');
    h.run('INSERT INTO org_policies (id,org_id,title,body,url,due_on,audience,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', pid, o.id, V.str(body.title, 'Title', { min: 1, max: 120 }),
      V.str(body.body, 'Text', { optional: true, max: 20000 }), V.url(body.url, 'Link'), date(body.dueOn, 'Due', { optional: true }), JSON.stringify(body.audience ? parseAudience(o.id, body.audience) : {}), me.id, now());
    return { status: 201, body: { id: pid } };
  });
  OR('GET', '/v1/orgs/:id/policies', ({ me, params }) => {
    const { o, mgr } = asOrg(params.id, me);
    return { policies: h.all('SELECT * FROM org_policies WHERE org_id = ? ORDER BY created_at DESC', o.id).filter((p) => mgr || inAudience(o, p, me.id)).map((p) => ({
      id: p.id, title: p.title, body: p.body, url: p.url, dueOn: p.due_on, audience: J(p.audience, {}),
      ackedAt: h.get('SELECT at FROM org_policy_acks WHERE policy_id = ? AND account_id = ?', p.id, me.id)?.at ?? null,
      ...(mgr ? { acked: h.get('SELECT COUNT(*) AS n FROM org_policy_acks WHERE policy_id = ?', p.id).n, audienceCount: audienceOf(o, p).length } : {}),
    })) };
  });
  OR('POST', '/v1/orgs/:id/policies/:pid/ack', ({ me, params }) => {
    const { o } = asOrg(params.id, me);
    const p = h.get('SELECT * FROM org_policies WHERE id = ? AND org_id = ?', params.pid, o.id) ?? notFound();
    h.run('INSERT OR IGNORE INTO org_policy_acks (policy_id,account_id,at) VALUES (?,?,?)', p.id, me.id, now());
    return { ok: true };
  });
  OR('POST', '/v1/orgs/:id/policies/:pid/delete', ({ me, params }) => {
    const { o } = asOrg(params.id, me, 'manager');
    h.run('DELETE FROM org_policies WHERE id = ? AND org_id = ?', params.pid, o.id);
    return { ok: true };
  });

  // ---------- the to-do box ----------
  const endOfDay = (d, tz) => zonedToUtc(addDays(d, 1), '00:00', tz) - 1;
  function todoFor(me) {
    const items = [];
    const t0 = now();
    const memberships = h.all("SELECT m.*, o.name AS org_name, o.tz, o.status AS org_status, o.settings AS org_settings FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = ? AND m.status = 'active' AND o.status = 'active'", me.id);
    for (const m of memberships) {
      const o = loadOrg(m.org_id);
      const s = orgSettings(o);
      const td = today(o.tz);
      const push = (kind, idPart, x) => { if (s.todoKinds[kind] !== false) items.push({ key: `${o.id}:${kind}:${idPart}`, kind, orgId: o.id, orgName: o.name, ...x }); };
      const mgr = RANK[m.role] >= RANK.manager;

      // Availability forms waiting for me.
      for (const f of h.all("SELECT * FROM org_forms WHERE org_id = ? AND status = 'open' AND period_end >= ?", o.id, td)) {
        if (!inAudience(o, f, me.id)) continue;
        const r = h.get('SELECT submitted_at FROM org_responses WHERE form_id = ? AND account_id = ?', f.id, me.id);
        if (r?.submitted_at) continue;
        const nudge = h.get('SELECT at FROM org_nudges WHERE form_id = ? AND account_id = ?', f.id, me.id);
        const rem = J(f.reminders, []).some((hrs) => f.deadline_at && t0 >= f.deadline_at - hrs * 3600_000);
        push('availability', f.id, { title: `Availability: ${f.title}`, detail: nudge ? 'Your manager asked for this.' : `For ${f.period_start} to ${f.period_end}`, dueAt: f.deadline_at, overdue: !!f.deadline_at && t0 > f.deadline_at,
          urgency: (nudge ? 2 : 0) + (rem ? 1 : 0), action: { type: 'form', formId: f.id } });
      }
      // My certs: countdown stages, expired (shifts blocked), and required ones I don't have.
      const types = typesMap(o.id);
      const myPos = positionsOf(o.id, me.id);
      const latest = new Map();
      for (const c of h.all('SELECT * FROM org_certs WHERE org_id = ? AND account_id = ? ORDER BY issued_on', o.id, me.id)) {
        const cur = latest.get(c.type_id);
        if (!cur || (c.expires_on ?? '9999') > (cur.expires_on ?? '9999')) latest.set(c.type_id, c);
      }
      for (const [tid, c] of latest) {
        const t = types.get(tid);
        if (!t || !c.expires_on) continue;
        const st = certStage(c.expires_on, td, J(t.warn_days, s.certWarnDays));
        if (st.stage === 'ok') continue;
        const required = J(t.positions, []).some((p) => myPos.includes(p));
        push('cert', tid, { title: st.stage === 'expired' ? `${t.name} expired` : `${t.name} expires ${c.expires_on}`, detail: st.stage === 'expired' ? (required ? 'Expired, shifts blocked' : 'Expired') : 'Recertify before it runs out',
          dueAt: endOfDay(c.expires_on, o.tz), overdue: st.stage === 'expired', stage: st.stage, daysLeft: st.daysLeft, urgency: required ? 2 : 1, action: { type: 'cert', typeId: tid } });
      }
      for (const t of types.values()) {
        if (latest.has(t.id) || !J(t.positions, []).some((p) => myPos.includes(p))) continue;
        const cls = h.get('SELECT class_id FROM org_classes WHERE cert_type_id = ?', t.id);
        push('cert', t.id, { title: `You need ${t.name}`, detail: 'Required for your position', dueAt: null, overdue: false, stage: 'missing', urgency: 2, action: { type: 'cert', typeId: t.id, classId: cls?.class_id ?? null } });
      }
      // Assigned classes and their next sessions.
      for (const x of h.all("SELECT x.*, c.title FROM org_class_assignments x JOIN classes c ON c.id = x.class_id WHERE x.org_id = ? AND x.account_id = ? AND x.completed_on IS NULL AND c.status = 'active'", o.id, me.id)) {
        const ns = nextSession(x.class_id);
        const due = x.due_on ? endOfDay(x.due_on, o.tz) : ns?.start_at ?? null;
        push('class', x.class_id, { title: `Class: ${x.title}`, detail: ns ? `Next session ${new Date(ns.start_at).toISOString()}` : x.due_on ? `Finish by ${x.due_on}` : 'Assigned to you',
          dueAt: due, overdue: !!x.due_on && td > x.due_on, nextSession: sessOut(ns) ?? null, urgency: 1, action: { type: 'class', classId: x.class_id } });
      }
      // Swaps: shifts offered to me (or to anyone in my position), and mine waiting.
      for (const w of h.all("SELECT w.*, s.position_id, s.start_at, s.date FROM org_swaps w JOIN org_shifts s ON s.id = w.shift_id WHERE w.org_id = ? AND w.status = 'offered' AND s.start_at > ?", o.id, t0)) {
        if (w.from_account === me.id || (w.to_account && w.to_account !== me.id) || (!w.to_account && !myPos.includes(w.position_id))) continue;
        push('swap', w.id, { title: w.to_account ? 'A shift was offered to you' : 'Open shift up for grabs', detail: `${posNames(o.id).get(w.position_id) ?? 'Shift'} on ${w.date}`, dueAt: w.start_at, overdue: false, urgency: w.to_account ? 2 : 0, action: { type: 'swap', swapId: w.id } });
      }
      for (const w of h.all("SELECT w.*, s.start_at, s.date FROM org_swaps w JOIN org_shifts s ON s.id = w.shift_id WHERE w.org_id = ? AND w.from_account = ? AND w.status IN ('offered','claimed') AND s.start_at > ?", o.id, me.id, t0))
        push('swap', w.id, { title: w.status === 'claimed' ? 'Your swap is waiting for approval' : 'Your shift is offered', detail: `Shift on ${w.date}. Until it's taken, it's still yours.`, dueAt: w.start_at, overdue: false, urgency: 0, action: { type: 'swap', swapId: w.id } });
      // Acknowledgments.
      for (const p of h.all('SELECT * FROM org_policies WHERE org_id = ?', o.id)) {
        if (!inAudience(o, p, me.id) || h.get('SELECT 1 FROM org_policy_acks WHERE policy_id = ? AND account_id = ?', p.id, me.id)) continue;
        push('ack', p.id, { title: `Read and acknowledge: ${p.title}`, detail: p.due_on ? `By ${p.due_on}` : 'Needs your acknowledgment', dueAt: p.due_on ? endOfDay(p.due_on, o.tz) : null, overdue: !!p.due_on && td > p.due_on, urgency: 1, action: { type: 'ack', policyId: p.id } });
      }

      if (!mgr) continue;
      // Managers: forms with people missing, approvals waiting, budget warnings, staff with expired certs.
      for (const f of h.all("SELECT * FROM org_forms WHERE org_id = ? AND status = 'open' AND deadline_at IS NOT NULL", o.id)) {
        const aud = audienceOf(o, f);
        const done = new Set(h.all('SELECT account_id FROM org_responses WHERE form_id = ? AND submitted_at IS NOT NULL', f.id).map((r) => r.account_id));
        const missing = aud.filter((a) => !done.has(a.account_id)).length;
        if (!missing) continue;
        const past = t0 > f.deadline_at;
        if (!past && f.deadline_at - t0 > 3 * 86400_000) continue;
        push('missing', f.id, { title: past ? `${missing} ${missing === 1 ? 'person hasn’t' : 'people haven’t'} sent availability` : `${missing} still to answer: ${f.title}`, detail: f.title, dueAt: f.deadline_at, overdue: past, urgency: past ? 2 : 1, action: { type: 'formPeople', formId: f.id } });
      }
      const joins = h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND status = 'pending'", o.id).n;
      const changes = h.get("SELECT COUNT(*) AS n FROM org_response_changes c JOIN org_forms f ON f.id = c.form_id WHERE f.org_id = ? AND c.status = 'pending'", o.id).n;
      const swaps = h.get("SELECT COUNT(*) AS n FROM org_swaps WHERE org_id = ? AND status = 'claimed'", o.id).n;
      if (joins + changes + swaps) {
        const parts = [joins && `${joins} to join`, changes && `${changes} availability ${changes === 1 ? 'change' : 'changes'}`, swaps && `${swaps} ${swaps === 1 ? 'swap' : 'swaps'}`].filter(Boolean);
        push('approvals', 'all', { title: `${joins + changes + swaps} waiting for approval`, detail: parts.join(', '), dueAt: null, overdue: false, urgency: 2, counts: { joins, changes, swaps }, action: { type: 'approvals' } });
      }
      const drafts = h.all("SELECT d.id, sc.title, sc.id AS sid FROM org_drafts d JOIN org_schedules sc ON sc.id = d.schedule_id WHERE sc.org_id = ? AND d.status = 'waiting'", o.id);
      for (const d of drafts) push('drafts', d.id, { title: 'A schedule draft is waiting for review', detail: d.title, dueAt: null, overdue: false, urgency: 1, action: { type: 'schedule', scheduleId: d.sid } });
      for (const b of budgetRows(o, s, td, addDays(td, 62)).filter((x) => x.current && x.warn))
        push('budget', b.id, { title: b.over ? `${b.departmentName} is over budget` : `${b.departmentName} is at ${b.pct}% of budget`, detail: `${b.periodStart} to ${b.periodEnd}: $${b.scheduled.toFixed(2)} of $${b.amount.toFixed(2)}`, dueAt: endOfDay(b.periodStart < td ? td : b.periodStart, o.tz), overdue: b.over, urgency: b.over ? 2 : 1, action: { type: 'budgets' } });
      const blocked = new Set();
      const tlist = [...types.values()];
      for (const r of membersOf(o.id)) {
        const pos = positionsOf(o.id, r.account_id);
        for (const t of tlist) {
          if (!J(t.positions, []).some((p) => pos.includes(p))) continue;
          const c = h.get('SELECT MAX(COALESCE(expires_on, \'9999-12-31\')) AS e FROM org_certs WHERE org_id = ? AND account_id = ? AND type_id = ?', o.id, r.account_id, t.id).e;
          if (c && c < td && h.get("SELECT 1 FROM org_shifts WHERE org_id = ? AND account_id = ? AND start_at > ?", o.id, r.account_id, t0)) blocked.add(r.account_id);
        }
      }
      if (blocked.size) push('staffcerts', 'expired', { title: `${blocked.size} scheduled ${blocked.size === 1 ? 'person has' : 'people have'} an expired cert`, detail: 'Their upcoming shifts are blocked', dueAt: null, overdue: true, urgency: 2, action: { type: 'certs' } });
    }
    const snoozed = new Map(h.all('SELECT item_key, until FROM org_todo_snoozes WHERE account_id = ? AND until > ?', me.id, t0).map((r) => [r.item_key, r.until]));
    const out = sortTodo(items).map((x) => ({ ...x, msLeft: x.dueAt == null ? null : x.dueAt - t0 }));
    return { now: t0, items: out.filter((x) => !snoozed.has(x.key)), snoozed: out.filter((x) => snoozed.has(x.key)).map((x) => ({ ...x, snoozedUntil: snoozed.get(x.key) })) };
  }
  OR('GET', '/v1/todo', ({ me }) => todoFor(me));
  // Everything the Hub keeps about me in organizations (alongside /v1/me/export).
  OR('GET', '/v1/orgs-export', ({ me }) => ({
    exportedAt: new Date(now()).toISOString(),
    memberships: h.all('SELECT m.*, o.name AS org_name FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = ?', me.id)
      .map((m) => ({ orgId: m.org_id, org: m.org_name, role: m.role, status: m.status, title: m.title, birthdate: m.birthdate, desiredMin: m.desired_min, desiredMax: m.desired_max, usualWeek: J(m.usual_week, {}), joinedAt: m.joined_at, positionIds: positionsOf(m.org_id, me.id) })),
    availability: h.all('SELECT r.*, f.title, f.org_id FROM org_responses r JOIN org_forms f ON f.id = r.form_id WHERE r.account_id = ?', me.id).map((r) => ({ orgId: r.org_id, form: r.title, ...responseOut(r) })),
    certs: h.all('SELECT c.*, t.name FROM org_certs c LEFT JOIN org_cert_types t ON t.id = c.type_id WHERE c.account_id = ?', me.id).map((c) => ({ orgId: c.org_id, name: c.name, issuedOn: c.issued_on, expiresOn: c.expires_on })),
    shifts: h.all('SELECT org_id, date, start_at, end_at, status FROM org_shifts WHERE account_id = ? ORDER BY start_at', me.id),
    swaps: h.all('SELECT org_id, shift_id, status, created_at FROM org_swaps WHERE from_account = ? OR claimant = ?', me.id, me.id),
    acknowledgments: h.all('SELECT a.at, p.title, p.org_id FROM org_policy_acks a JOIN org_policies p ON p.id = a.policy_id WHERE a.account_id = ?', me.id),
  }), { terms: false });
  OR('POST', '/v1/todo/snooze', ({ me, body }) => {
    const key = V.str(body.key, 'Item', { min: 3, max: 200 });
    const hours = V.int(body.hours ?? 24, 'Hours', { min: 0, max: 24 * 30 });
    if (hours === 0) h.run('DELETE FROM org_todo_snoozes WHERE account_id = ? AND item_key = ?', me.id, key);
    else h.run('INSERT INTO org_todo_snoozes (account_id,item_key,until) VALUES (?,?,?) ON CONFLICT(account_id,item_key) DO UPDATE SET until = excluded.until', me.id, key, now() + hours * 3600_000);
    return todoFor(me);
  });

  /** A suspended organization's classes: archived, and their invite codes revoked (managers can reopen them later). */
  function shutClasses(oid) {
    h.tx(() => {
      h.run("UPDATE classes SET status = 'archived' WHERE org_id = ? OR id IN (SELECT class_id FROM org_classes WHERE org_id = ?)", oid, oid);
      h.run('UPDATE invites SET revoked = 1 WHERE class_id IN (SELECT id FROM classes WHERE org_id = ?) OR class_id IN (SELECT class_id FROM org_classes WHERE org_id = ?)', oid, oid);
    });
  }

  // ================= owner console: orgs hosted on the Hub =================
  O('GET', '/owner/orgs', ({ query }) => ({
    orgs: h.all(`SELECT o.*, a.email AS creator FROM orgs o JOIN accounts a ON a.id = o.created_by${query.status ? ' WHERE o.status = ?' : ''} ORDER BY o.created_at DESC LIMIT 500`, ...(query.status ? [query.status] : []))
      .map((o) => ({ id: o.id, name: o.name, kind: o.kind, status: o.status, creator: o.creator, createdAt: o.created_at, note: o.note, members: h.get('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?', o.id).n })),
    autoApprove: getSetting('orgs', {}).autoApprove === true,
  }));
  O('POST', '/owner/orgs/settings', ({ body }) => { setSetting('orgs', { ...getSetting('orgs', {}), autoApprove: V.bool(body.autoApprove, 'autoApprove') }); return { autoApprove: getSetting('orgs', {}).autoApprove }; });
  O('POST', '/owner/orgs/:id/decide', ({ params, body }) => {
    const o = loadOrg(params.id) ?? notFound();
    const approve = V.bool(body.approve, 'approve');
    h.run('UPDATE orgs SET status = ?, decided_at = ?, note = ? WHERE id = ?', approve ? 'active' : 'suspended', now(), V.str(body.note, 'note', { optional: true, max: 2000 }), o.id);
    if (!approve) shutClasses(o.id);
    audit('owner', approve ? 'owner.org_approve' : 'owner.org_deny', o.id, null, 'local');
    const why = V.str(body.note, 'note', { optional: true, max: 2000 });
    if (approve) notify(o.created_by, 'org', `${o.name} is approved on the Kea Hub`, 'Your organization is ready. Make join codes for your people in Work mode.', { note: why, data: { orgId: o.id, approved: true } });
    else notify(o.created_by, 'org', `${o.name} wasn’t approved on the Kea Hub`, 'Organizations can also run their own KeaS server.', { note: why, data: { orgId: o.id, approved: false } });
    return { ok: true };
  });
  O('POST', '/owner/orgs/:id/status', ({ params, body }) => {
    const o = loadOrg(params.id) ?? notFound();
    const st = V.enum(body.status, 'status', ['active', 'suspended']);
    h.run('UPDATE orgs SET status = ?, note = COALESCE(?, note) WHERE id = ?', st, V.str(body.note, 'note', { optional: true, max: 2000 }), o.id);
    if (st === 'suspended') { h.run('UPDATE org_codes SET revoked = 1 WHERE org_id = ?', o.id); shutClasses(o.id); }
    audit('owner', `owner.org_${st}`, o.id, null, 'local');
    return { ok: true };
  });
  O('POST', '/owner/orgs/:id/codes/revoke', ({ params }) => {
    const o = loadOrg(params.id) ?? notFound();
    const r = h.run('UPDATE org_codes SET revoked = 1 WHERE org_id = ? AND revoked = 0', o.id);
    audit('owner', 'owner.org_codes_revoke', o.id, null, 'local');
    return { revoked: Number(r.changes) };
  });

  return { todoFor };
}

export { DAY_NAMES, fmtRange, datesIn, daysUntil };
