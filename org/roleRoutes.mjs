// Roles: list, make, change and delete them; give them to people and take them away, for the whole organization or
// for chosen departments. The rules are in ./roles.mjs (nobody gives what they don't have; owners keep everything; an
// organization always keeps an owner).
import { ABILITIES, ABILITY_LIST, SELF_ABILITIES, ORG_ONLY, outranks, effective } from './roles.mjs';

export function mountRoleRoutes(core, { R, deptRow }) {
  const { h, now, audit, V, bad, forbidden, notFound, tx, id, J, asOrg, memberRow } = core;
  const list = (v, name, max = 100) => { if (v == null) return []; if (!Array.isArray(v) || v.length > max) bad(`${name} must be a list.`); return v; };
  const parseScope = (oid, v) => {
    if (v == null || v === 'org') return null;
    const ids = list(v, 'Departments').map((d) => deptRow(oid, d).id);
    if (!ids.length) bad('Pick at least one department, or the whole organization.');
    return [...new Set(ids)];
  };
  /** A list of abilities: known ones only, each one I have myself (everywhere, for ones about the whole org). */
  const parseAbilities = (x, v) => {
    const out = [...new Set(list(v, 'Abilities', ABILITY_LIST.length).map((a) => V.enum(a, 'Ability', ABILITY_LIST)))];
    if (!x.owner) {
      const missing = out.filter((a) => !(SELF_ABILITIES.has(a) ? x.can(a) : x.can(a, null)));
      if (missing.length) forbidden(`You can only put abilities you have for the whole organization in a role. Not yours: ${missing.join(', ')}.`);
    }
    return ABILITY_LIST.filter((a) => out.includes(a));
  };
  const holders = (rid) => h.get('SELECT COUNT(*) AS n FROM org_role_assignments WHERE role_id = ?', rid).n;
  const catalog = () => ABILITY_LIST.map((a) => ({ id: a, label: ABILITIES[a], self: SELF_ABILITIES.has(a), orgOnly: ORG_ONLY.has(a) }));
  const capRoles = (oid) => { if (h.get('SELECT COUNT(*) AS n FROM org_roles WHERE org_id = ?', oid).n >= 200) bad('This organization has the most roles it can have (200). Remove some first.'); };

  R('GET', '/v1/orgs/:id/roles', ({ me, params }) => {
    const x = asOrg(params.id, me);
    const see = x.can('roles.assign') || x.can('roles.manage');
    return {
      roles: h.all('SELECT * FROM org_roles WHERE org_id = ? ORDER BY template DESC, created_at', x.o.id).map((r) => core.roleOut(r, see ? holders(r.id) : null)),
      abilities: catalog(),
    };
  });
  R('POST', '/v1/orgs/:id/roles', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'roles.manage', { dept: null });
    const name = V.name(body.name, 'Name', { min: 1, max: 60 });
    if (h.get('SELECT 1 FROM org_roles WHERE org_id = ? AND lower(name) = lower(?)', x.o.id, name)) bad('There is already a role with that name.');
    const abilities = parseAbilities(x, body.abilities);
    capRoles(x.o.id);
    const rid = id();
    h.run('INSERT INTO org_roles (id,org_id,name,abilities,template,template_key,description,created_by,created_at) VALUES (?,?,?,?,0,NULL,?,?,?)', rid, x.o.id, name, JSON.stringify(abilities),
      V.str(body.description, 'Description', { optional: true, max: 300 }), me.id, now());
    audit(me.id, 'org.role_create', x.o.id, { role: rid, abilities }, ip);
    return { status: 201, body: { role: core.roleOut(core.roleRow(x.o.id, rid), 0) } };
  });
  R('POST', '/v1/orgs/:id/roles/:rid', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'roles.manage', { dept: null });
    const r = core.roleRow(x.o.id, params.rid);
    if (!x.owner && !outranks(x.eff, core.effWith(x.o.id, r, null, x.tree))) forbidden('You can only change roles below your own.');
    let abilities = J(r.abilities, []);
    if ('abilities' in body) {
      if (r.template_key === 'owner') bad('The Owner role always has every ability.');
      abilities = parseAbilities(x, body.abilities);
      if (!x.owner && !outranks(x.eff, core.effWith(x.o.id, { ...r, abilities: JSON.stringify(abilities) }, null, x.tree))) forbidden('A role you change has to stay below your own.');
    }
    const name = body.name != null ? V.name(body.name, 'Name', { min: 1, max: 60 }) : r.name;
    if (name !== r.name && h.get('SELECT 1 FROM org_roles WHERE org_id = ? AND lower(name) = lower(?) AND id != ?', x.o.id, name, r.id)) bad('There is already a role with that name.');
    h.run('UPDATE org_roles SET name = ?, abilities = ?, description = ? WHERE id = ?', name, JSON.stringify(abilities),
      'description' in body ? V.str(body.description, 'Description', { optional: true, max: 300 }) : r.description, r.id);
    audit(me.id, 'org.role_update', x.o.id, { role: r.id, abilities }, ip);
    return { role: core.roleOut(core.roleRow(x.o.id, r.id), holders(r.id)) };
  });
  R('POST', '/v1/orgs/:id/roles/:rid/delete', ({ me, params, ip }) => {
    const x = asOrg(params.id, me, 'roles.manage', { dept: null });
    const r = core.roleRow(x.o.id, params.rid);
    if (r.template) bad('The Owner, Admin, Manager and Member roles can be changed but not deleted.');
    if (!x.owner && !outranks(x.eff, core.effWith(x.o.id, r, null, x.tree))) forbidden('You can only delete roles below your own.');
    const had = h.all('SELECT account_id FROM org_role_assignments WHERE role_id = ?', r.id).map((a) => a.account_id);
    tx(() => {
      h.run('DELETE FROM org_role_assignments WHERE role_id = ?', r.id);
      h.run('UPDATE org_codes SET revoked = 1 WHERE role_id = ? AND org_id = ?', r.id, x.o.id);
      h.run('DELETE FROM org_roles WHERE id = ?', r.id);
      for (const aid of had) core.keepARole(x.o.id, aid, me.id);
    });
    audit(me.id, 'org.role_delete', x.o.id, { role: r.id, holders: had.length }, ip);
    return { ok: true, holders: had.length };
  });

  // ---------- giving roles to people ----------
  const target = (x, aid) => memberRow(x.o.id, aid) ?? notFound('Not a member.');
  const out = (x, aid) => {
    const m = memberRow(x.o.id, aid);
    const eff = m.status === 'active' ? core.effOf(x.o.id, aid, x.tree, m) : effective(core.grantsOf(x.o.id, aid), x.tree);
    return { accountId: aid, role: core.legacyFor(x.o.id, aid, null, x.tree), roles: core.assignmentsOut(x.o.id, aid), ...core.abilitiesOut(eff) };
  };
  R('GET', '/v1/orgs/:id/members/:aid/roles', ({ me, params }) => {
    const x = asOrg(params.id, me);
    const t = target(x, params.aid);
    if (t.account_id !== me.id && !x.can('roles.assign', t.department_id ?? null)) forbidden('Only admins can see other people’s roles.');
    return out(x, t.account_id);
  });
  R('POST', '/v1/orgs/:id/members/:aid/roles', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me, 'roles.assign');
    const t = target(x, params.aid);
    const r = core.roleRow(x.o.id, V.str(body.roleId, 'Role', { min: 1, max: 80 }));
    const scope = r.template_key === 'owner' ? null : parseScope(x.o.id, body.scope);
    x.need('roles.assign', t.department_id ?? null);
    if (scope) for (const d of scope) x.need('roles.assign', d);
    else x.need('roles.assign', null);
    if (!x.owner) {
      const all = core.effAll(x.o.id, x.tree);
      if (!outranks(x.eff, all.get(t.account_id) ?? core.NOBODY)) forbidden('You can only give roles to people below your role.');
      if (!outranks(x.eff, core.effAfter(x.o.id, t.account_id, { add: { role: r, scope } }, x.tree))) forbidden('You can’t give someone a role that would put them level with or above you.');
    }
    tx(() => core.grant(x.o.id, t.account_id, r.id, scope, me.id));
    audit(me.id, 'org.role_assign', x.o.id, { account: t.account_id, role: r.id, scope: scope ?? 'org' }, ip);
    return out(x, t.account_id);
  });
  R('POST', '/v1/orgs/:id/members/:aid/roles/:rid/delete', ({ me, params, ip }) => {
    const x = asOrg(params.id, me, 'roles.assign');
    const t = target(x, params.aid);
    const r = core.roleRow(x.o.id, params.rid);
    x.need('roles.assign', t.department_id ?? null);
    if (!x.owner && !outranks(x.eff, core.effAll(x.o.id, x.tree).get(t.account_id) ?? core.NOBODY)) forbidden('You can only take roles from people below your role.');
    if (r.template_key === 'owner' && core.isOwner(x.o.id, t.account_id) && core.ownersOf(x.o.id).length < 2) bad('Make someone else an owner first.');
    tx(() => {
      h.run('DELETE FROM org_role_assignments WHERE org_id = ? AND account_id = ? AND role_id = ?', x.o.id, t.account_id, r.id);
      core.keepARole(x.o.id, t.account_id, me.id);
    });
    audit(me.id, 'org.role_unassign', x.o.id, { account: t.account_id, role: r.id }, ip);
    return out(x, t.account_id);
  });
}
