// Roles in an organization: a role is a named list of abilities. Owner, Admin, Manager and Member are templates every
// organization starts with (they give exactly what the four fixed roles of KeaS 0.5 gave); owners can make more.
// A person can hold several roles, each for the whole organization or for chosen departments (and every team under
// them). What someone can do is the union of their roles.
//
// The rules (the same as with the fixed roles):
// - The Owner template always has every ability, including ones added later, and always applies org-wide.
// - Nobody can give abilities they don't have: to give a role, make a join code for it, or change or remove someone,
//   you must outrank them (have everything they would have, where they would have it, and something more). Owners
//   outrank everyone.
// - An organization always keeps an owner: the last one can't be removed, leave, or lose the Owner role.

/** Every ability, with what it lets someone do (shown in the role editor). */
export const ABILITIES = {
  'people.view': 'See coworkers’ email, desired hours and preferences, and who is under 18',
  'people.approve': 'Approve or decline requests to join',
  'people.verify': 'Mark a person’s email as verified',
  'people.edit': 'Change people’s department, title and positions',
  'people.birthdate': 'See and correct people’s birthdates',
  'people.remove': 'Remove people from the organization',
  'roles.assign': 'Give and take away roles',
  'roles.manage': 'Make, change and delete roles',
  'codes.make': 'Make and revoke join codes',
  'structure.edit': 'Change departments, positions, locations and cost centers',
  'settings.edit': 'Change the organization’s settings',
  'rates.view': 'See cost rates, and other people’s pay codes and pay rates',
  'rates.assign': 'Set cost rates',
  'paycodes.manage': 'Make and change pay codes (a job’s name and pay rate)',
  'paycodes.assign': 'Give people pay codes, take them away, and set each person’s default code',
  'budgets.view': 'See budgets and scheduled hours',
  'budgets.costs': 'See labor cost against budgets',
  'budgets.edit': 'Set and remove budgets',
  'certs.manage': 'See everyone’s certifications, add and remove them',
  'certs.types': 'Change certification types',
  'classes.manage': 'Run organization classes: make them, assign them, mark them done',
  'forms.manage': 'Make availability forms, see answers, decide change requests',
  'schedule.view': 'See the whole schedule even when the organization shows people only their own shifts',
  'schedule.edit': 'Build schedules: shifts, auto-fill, drafts',
  'schedule.publish': 'Publish schedules',
  'swaps.decide': 'Approve or deny shift swaps',
  'policies.manage': 'Post and remove acknowledgments',
  'timecards.view': 'See other people’s timecards and who is clocked in',
  'timecards.approve': 'Approve timecards and missed-punch requests',
  'timeoff.decide': 'Approve or deny time off',
  'clock.self': 'Clock in and out, and ask for missed punches to be fixed',
  'timeoff.request': 'Ask for time off',
};
export const ABILITY_LIST = Object.keys(ABILITIES);
/** Abilities about yourself only: a department scope means nothing for them. */
export const SELF_ABILITIES = new Set(['clock.self', 'timeoff.request']);
/** Abilities that only make sense for the whole organization (a department-scoped grant of one never counts). */
export const ORG_ONLY = new Set(['roles.manage', 'structure.edit', 'settings.edit', 'certs.types', 'paycodes.manage']);

const MEMBER = ['clock.self', 'timeoff.request'];
const MANAGER = [...MEMBER, 'people.view', 'people.approve', 'people.verify', 'people.edit', 'people.remove', 'codes.make', 'budgets.view',
  'certs.manage', 'classes.manage', 'forms.manage', 'schedule.view', 'schedule.edit', 'schedule.publish', 'swaps.decide', 'policies.manage',
  'timecards.view', 'timecards.approve', 'timeoff.decide'];
const ADMIN = [...MANAGER, 'people.birthdate', 'roles.assign', 'roles.manage', 'structure.edit', 'settings.edit', 'rates.view', 'rates.assign',
  'paycodes.manage', 'paycodes.assign', 'budgets.costs', 'budgets.edit', 'certs.types'];
/** The templates, highest first. `key` is how KeaS 0.5 named the role (Kea 0.70 still reads and sends it). */
export const TEMPLATES = [
  { key: 'owner', name: 'Owner', abilities: ABILITY_LIST },
  { key: 'admin', name: 'Admin', abilities: ADMIN },
  { key: 'manager', name: 'Manager', abilities: MANAGER },
  { key: 'member', name: 'Member', abilities: MEMBER },
];
export const LEGACY_ROLES = TEMPLATES.map((t) => t.key);
export const templateOf = (key) => TEMPLATES.find((t) => t.key === key) ?? null;

/** A role's abilities (the Owner template: all of them, always). Unknown names (from a newer KeaS) are dropped. */
export const roleAbilities = (role) => (role.template === 'owner' ? ABILITY_LIST : (Array.isArray(role.abilities) ? role.abilities : []).filter((a) => a in ABILITIES));

/**
 * What someone can do, from their roles: { owner, map: ability -> true (org-wide) | Set of department ids }.
 * grants: [{ role: { template, abilities }, scope: null (org-wide) | [department ids] }]. subtree(did) is that
 * department and every team under it.
 */
export function effective(grants, subtree) {
  const map = new Map();
  let owner = false;
  for (const g of grants) {
    if (g.role.template === 'owner') owner = true;
    const org = g.scope == null || g.role.template === 'owner';
    let depts = null;
    if (!org) { depts = new Set(); for (const d of g.scope) for (const x of subtree(d)) depts.add(x); }
    for (const a of roleAbilities(g.role)) {
      const self = SELF_ABILITIES.has(a);
      if (!org && ORG_ONLY.has(a)) continue;
      const cur = map.get(a);
      if (cur === true) continue;
      if (org || self) { map.set(a, true); continue; }
      map.set(a, cur ? new Set([...cur, ...depts]) : new Set(depts));
    }
  }
  if (owner) for (const a of ABILITY_LIST) map.set(a, true);
  return { owner, map };
}

/**
 * Can they do this? deptId: a department id (org-wide grants, or a grant for that department or one above it);
 * null (something that belongs to no department: org-wide grants only); undefined (anywhere: any grant at all).
 */
export function can(eff, ability, deptId) {
  const s = eff.map.get(ability);
  if (!s) return false;
  if (s === true || SELF_ABILITIES.has(ability)) return true;
  if (deptId === undefined) return s.size > 0;
  return deptId != null && s.has(deptId);
}
/** The departments an ability reaches: 'org', or a list of department ids (empty: nowhere). */
export const reach = (eff, ability) => { const s = eff.map.get(ability); return s === true ? 'org' : s ? [...s] : []; };

/** Does a have every ability b has, everywhere b has it? */
export function covers(a, b) {
  if (a.owner) return true;
  if (b.owner) return false;
  for (const [ab, s] of b.map) {
    const mine = a.map.get(ab);
    if (!mine) return false;
    if (mine === true || SELF_ABILITIES.has(ab)) continue;
    if (s === true) return false;
    for (const d of s) if (!mine.has(d)) return false;
  }
  return true;
}
/** a outranks b: owners outrank everyone; otherwise a covers b and b doesn't cover a. */
export const outranks = (a, b) => a.owner || (!b.owner && covers(a, b) && !covers(b, a));

/**
 * The KeaS 0.5 role name for someone (Kea 0.70 shows and checks it): the highest template whose abilities they have
 * org-wide. A person with a custom role counts as the highest template it covers.
 */
export function legacyRole(eff) {
  if (eff.owner) return 'owner';
  for (const t of TEMPLATES.slice(1)) if (t.abilities.every((a) => eff.map.get(a) === true || (SELF_ABILITIES.has(a) && eff.map.has(a)))) return t.key;
  return 'member';
}

/** For the apps: { abilities: [...], scopes: { ability: 'org' | [department ids] } }. */
export function abilitiesOut(eff) {
  const scopes = {};
  for (const [a, s] of eff.map) if (s === true || s.size) scopes[a] = s === true ? 'org' : [...s].sort();
  return { abilities: ABILITY_LIST.filter((a) => a in scopes), scopes };
}
