// The org engine's shared pieces: loading an organization and the caller's membership, roles and abilities,
// departments, and people's names (from the identity adapter). Used by routes.mjs, roleRoutes.mjs, clock.mjs and
// import.mjs.
import { randomUUID } from 'node:crypto';
import { localDate } from '../server/lib/time.mjs';
import { ABILITIES, effective, can, outranks, legacyRole, abilitiesOut, roleAbilities } from './roles.mjs';
import { seedTemplates } from './schema.mjs';

const TODO_KINDS = ['availability', 'cert', 'class', 'swap', 'ack', 'missing', 'approvals', 'budget', 'drafts', 'staffcerts', 'timecards', 'timeoff'];
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
  // The time clock: pay periods for timecards (weekly or every two weeks from the anchor date), how late counts as
  // late, and whether clocking in needs a published shift.
  clock: { periodDays: 14, periodAnchor: null, lateThresholdMin: 5, needShift: false },
  timeOffKinds: ['vacation', 'sick', 'personal', 'unpaid', 'other'],
};
export { TODO_KINDS };

export function makeCore({ h, now, audit, notify, identity, kit }) {
  const { HttpError, V } = kit;
  const bad = (m, extra) => { throw new HttpError(400, m, extra); };
  const forbidden = (m = 'Not allowed.') => { throw new HttpError(403, m); };
  const notFound = (m = 'Not found.') => { throw new HttpError(404, m); };
  let depth = 0;
  /** A transaction; one inside another joins it. */
  const tx = (fn) => { if (depth) return fn(); depth++; try { return h.tx(fn); } finally { depth--; } };
  const id = () => randomUUID();
  const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
  const today = (tz) => localDate(now(), tz);

  const orgSettings = (o) => {
    const s = J(o.settings, {});
    return { ...ORG_DEFAULTS, ...s, autofill: { ...ORG_DEFAULTS.autofill, ...(s.autofill || {}) }, todoKinds: { ...ORG_DEFAULTS.todoKinds, ...(s.todoKinds || {}) }, clock: { ...ORG_DEFAULTS.clock, ...(s.clock || {}) } };
  };
  const loadOrg = (oid) => h.get('SELECT * FROM orgs WHERE id = ?', oid);
  const memberRow = (oid, aid) => h.get('SELECT * FROM org_members WHERE org_id = ? AND account_id = ?', oid, aid);

  // ---------- departments ----------
  /** did -> that department and every team under it, for one organization (loaded once). */
  const deptTree = (oid) => {
    const all = h.all('SELECT id, parent_id FROM org_departments WHERE org_id = ?', oid);
    const cache = new Map();
    return (did) => {
      if (cache.has(did)) return cache.get(did);
      const out = new Set([did]);
      for (let grew = true; grew;) { grew = false; for (const d of all) if (d.parent_id && out.has(d.parent_id) && !out.has(d.id)) { out.add(d.id); grew = true; } }
      cache.set(did, out);
      return out;
    };
  };
  const subtree = (oid, did) => deptTree(oid)(did);

  // ---------- roles and abilities ----------
  const asRole = (r) => ({ template: r.template_key ?? null, abilities: J(r.abilities, []) });
  const roleOut = (r, holders = null) => ({
    id: r.id, name: r.name, description: r.description ?? null, template: !!r.template, templateKey: r.template_key ?? null,
    abilities: roleAbilities(asRole(r)), createdAt: r.created_at, ...(holders != null ? { holders } : {}),
  });
  const templateRole = (oid, key) => {
    let r = h.get('SELECT * FROM org_roles WHERE org_id = ? AND template_key = ?', oid, key);
    if (!r) { seedTemplates(h.db, oid, now()); r = h.get('SELECT * FROM org_roles WHERE org_id = ? AND template_key = ?', oid, key); }
    return r;
  };
  const roleRow = (oid, rid) => h.get('SELECT * FROM org_roles WHERE id = ? AND org_id = ?', rid, oid) ?? notFound('That role is not in this organization.');
  const scopeOf = (s) => (s == null ? null : J(s, []));
  const grantRows = (oid, aid) => h.all('SELECT a.scope AS a_scope, a.assigned_at AS a_at, r.* FROM org_role_assignments a JOIN org_roles r ON r.id = a.role_id WHERE a.org_id = ? AND a.account_id = ? ORDER BY r.template DESC, r.created_at', oid, aid);
  const grantsOf = (oid, aid) => grantRows(oid, aid).map((r) => ({ role: asRole(r), scope: scopeOf(r.a_scope), roleId: r.id, name: r.name }));
  const NOBODY = { owner: false, map: new Map() };
  /** What someone can do in an organization (nothing while their request to join waits). */
  const effOf = (oid, aid, tree = deptTree(oid), m = memberRow(oid, aid)) => (!m || m.status !== 'active' ? NOBODY : effective(grantsOf(oid, aid), tree));
  /** Everyone's at once: account id -> what they can do (as if active, for pending people too: see legacyFor). */
  const effAll = (oid, tree = deptTree(oid)) => {
    const by = new Map();
    for (const r of h.all('SELECT a.account_id AS a_account, a.scope AS a_scope, r.* FROM org_role_assignments a JOIN org_roles r ON r.id = a.role_id WHERE a.org_id = ?', oid)) {
      if (!by.has(r.a_account)) by.set(r.a_account, []);
      by.get(r.a_account).push({ role: asRole(r), scope: scopeOf(r.a_scope) });
    }
    const out = new Map();
    for (const [aid, g] of by) out.set(aid, effective(g, tree));
    return out;
  };
  /** What someone would have with only this role, here. */
  const effWith = (oid, role, scope, tree = deptTree(oid)) => effective([{ role: asRole(role), scope }], tree);
  /** What someone would have with their roles plus or minus one. */
  const effAfter = (oid, aid, { add = null, remove = null } = {}, tree = deptTree(oid)) => {
    const g = grantRows(oid, aid).filter((r) => r.id !== remove && r.id !== add?.role.id).map((r) => ({ role: asRole(r), scope: scopeOf(r.a_scope) }));
    if (add) g.push({ role: asRole(add.role), scope: add.scope });
    return effective(g, tree);
  };
  /** Account ids of the active members holding the Owner template. */
  const ownersOf = (oid) => h.all("SELECT a.account_id FROM org_role_assignments a JOIN org_roles r ON r.id = a.role_id JOIN org_members m ON m.org_id = a.org_id AND m.account_id = a.account_id WHERE a.org_id = ? AND r.template_key = 'owner' AND m.status = 'active'", oid).map((r) => r.account_id);
  const isOwner = (oid, aid) => ownersOf(oid).includes(aid);
  const grant = (oid, aid, roleId, scope, by) => h.run('INSERT INTO org_role_assignments (org_id,account_id,role_id,scope,assigned_by,assigned_at) VALUES (?,?,?,?,?,?) ON CONFLICT(org_id,account_id,role_id) DO UPDATE SET scope = excluded.scope, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at',
    oid, aid, roleId, scope == null ? null : JSON.stringify(scope), by, now());
  /** Everyone keeps at least one role: someone left with none gets Member. */
  const keepARole = (oid, aid, by) => { if (!h.get('SELECT 1 FROM org_role_assignments WHERE org_id = ? AND account_id = ?', oid, aid)) grant(oid, aid, templateRole(oid, 'member').id, null, by); };
  const assignmentsOut = (oid, aid) => grantRows(oid, aid).map((r) => ({ roleId: r.id, name: r.name, templateKey: r.template_key ?? null, scope: r.a_scope == null ? 'org' : J(r.a_scope, []) }));
  /** The 0.5 role name for someone, active or still waiting (for a waiting person: what they'd be once approved). */
  const legacyFor = (oid, aid, all = null, tree = null) => legacyRole(all ? all.get(aid) ?? NOBODY : effective(grantsOf(oid, aid), tree ?? deptTree(oid)));

  const deny = (ability) => forbidden(`Your role here doesn’t allow this. It needs: ${(ABILITIES[ability] || ability).replace(/^./, (c) => c.toLowerCase())}.`);

  /**
   * The org and my membership, or 404 (other orgs are invisible), or 403 without the ability. An organization works
   * only once the server's operator has approved it (active), and stops when it's suspended; a route that must work
   * before or after that opts in with inactiveOk. dept: the department the action is about (roles.mjs can).
   */
  function asOrg(oid, me, ability = null, { pendingOk = false, inactiveOk = false, dept } = {}) {
    const who = identity.who(me);
    const o = loadOrg(oid);
    const m = o && memberRow(oid, who.id);
    if (!o || !m) notFound('Organization not found.');
    if (m.status !== 'active' && !pendingOk) forbidden('Your request to join is waiting for approval.');
    if (o.status === 'suspended' && !inactiveOk) forbidden('This organization is suspended on this server.');
    if (o.status !== 'active' && !inactiveOk) forbidden('This organization is still waiting for approval on this server.');
    const tree = deptTree(oid);
    const eff = effOf(oid, who.id, tree, m);
    if (ability && !can(eff, ability, dept)) deny(ability);
    const x = {
      o, m, who, eff, tree, s: orgSettings(o), tz: o.tz,
      can: (ab, d) => can(eff, ab, d),
      need: (ab, d) => { if (!can(eff, ab, d)) deny(ab); },
      /** I outrank this member (owners outrank everyone). */
      outranks: (aid, all = null) => outranks(eff, all ? all.get(aid) ?? NOBODY : effective(grantsOf(oid, aid), tree)),
      owner: eff.owner,
    };
    return x;
  }

  // ---------- people ----------
  const profilesOf = (ids) => identity.profiles([...new Set(ids)].filter(Boolean));
  /** Members with their names and emails (from the identity adapter), sorted by name. */
  const membersOf = (oid, { status = 'active' } = {}) => {
    const rows = h.all(`SELECT * FROM org_members WHERE org_id = ?${status ? ' AND status = ?' : ''}`, ...(status ? [oid, status] : [oid]));
    const p = profilesOf(rows.map((r) => r.account_id));
    return rows.map((r) => withProfile(r, p.get(r.account_id))).sort((a, b) => (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : a.account_id < b.account_id ? -1 : 1));
  };
  const withProfile = (r, p) => ({ ...r, display_name: p?.name ?? '', email: p?.email ?? null, email_verified: p?.emailVerified ? 1 : 0, profile: p ?? null });
  const memberWithProfile = (oid, aid) => { const r = memberRow(oid, aid); return r && withProfile(r, profilesOf([aid]).get(aid)); };
  /** account id -> name, for everyone who is or asked to be in the organization. */
  const names = (oid) => {
    const ids = h.all('SELECT account_id FROM org_members WHERE org_id = ?', oid).map((r) => r.account_id);
    const p = profilesOf(ids);
    return new Map(ids.map((i) => [i, p.get(i)?.name ?? null]));
  };
  const positionsOf = (oid, aid) => h.all('SELECT position_id FROM org_member_positions WHERE org_id = ? AND account_id = ?', oid, aid).map((r) => r.position_id);

  return {
    h, now, audit, notify, identity, kit, HttpError, V, bad, forbidden, notFound, tx, id, J, today, orgSettings, loadOrg, memberRow,
    deptTree, subtree, asRole, roleOut, templateRole, roleRow, grantsOf, effOf, effAll, effWith, effAfter, ownersOf, isOwner, grant, keepARole,
    assignmentsOut, legacyFor, asOrg, profilesOf, membersOf, withProfile, memberWithProfile, names, positionsOf, abilitiesOut, outranks, NOBODY, deny,
  };
}
