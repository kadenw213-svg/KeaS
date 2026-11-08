// Roles and abilities (org/roles.mjs): the templates give exactly what KeaS 0.5's fixed roles gave, scopes reach a
// department and its teams, and nobody can outrank themselves into more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITY_LIST, TEMPLATES, effective, can, outranks, covers, legacyRole, abilitiesOut, templateOf } from '../../org/roles.mjs';

const tree = (edges) => (did) => { const out = new Set([did]); for (let grew = true; grew;) { grew = false; for (const [c, p] of edges) if (out.has(p) && !out.has(c)) { out.add(c); grew = true; } } return out; };
const flat = tree([]);
const as = (key, scope = null, t = flat) => effective([{ role: { template: key, abilities: templateOf(key).abilities }, scope }], t);
const RANK = { member: 1, manager: 2, admin: 3, owner: 4 };
const KEYS = ['owner', 'admin', 'manager', 'member'];

test('every ability belongs to the same lowest role that could do it in KeaS 0.5', () => {
  // The rank each 0.5 check needed (hub/org/routes.mjs asOrg(min) and the inline RANK comparisons).
  const min = {
    'people.view': 'manager', 'people.approve': 'manager', 'people.verify': 'manager', 'people.edit': 'manager', 'people.remove': 'manager',
    'people.birthdate': 'admin', 'roles.assign': 'admin', 'roles.manage': 'admin', 'codes.make': 'manager', 'structure.edit': 'admin', 'settings.edit': 'admin',
    'rates.view': 'admin', 'rates.assign': 'admin', 'budgets.view': 'manager', 'budgets.costs': 'admin', 'budgets.edit': 'admin', 'certs.manage': 'manager',
    'certs.types': 'admin', 'classes.manage': 'manager', 'forms.manage': 'manager', 'schedule.view': 'manager', 'schedule.edit': 'manager', 'schedule.publish': 'manager',
    'swaps.decide': 'manager', 'policies.manage': 'manager', 'timecards.view': 'manager', 'timecards.approve': 'manager', 'timeoff.decide': 'manager',
    'clock.self': 'member', 'timeoff.request': 'member',
    // (New since 0.5: pay codes, given to Admin.)
    'paycodes.manage': 'admin', 'paycodes.assign': 'admin',
  };
  assert.deepEqual(Object.keys(min).sort(), [...ABILITY_LIST].sort(), 'every ability is listed here');
  for (const a of ABILITY_LIST) for (const k of KEYS) assert.equal(can(as(k), a, null), RANK[k] >= RANK[min[a]], `${k} ${a}`);
});

test('acting on people, codes and roles: the same answers as the 0.5 rank rules, for every pair', () => {
  for (const a of KEYS) for (const t of KEYS) {
    // "below your role" (approve, verify, edit, remove, revoke codes): lower rank, or the actor is an owner.
    assert.equal(outranks(as(a), as(t)), RANK[t] < RANK[a] || a === 'owner', `${a} over ${t}`);
    // Codes: managers make member codes, admins manager codes, owners admin codes (never owner codes).
    if (t !== 'owner') assert.equal(outranks(as(a), as(t)), RANK[t] < RANK[a] || a === 'owner', `${a} makes ${t} code`);
    // Changing someone's role from t to n: admins and up; only the owner makes or changes admins (or owners).
    for (const n of KEYS) {
      const old = RANK[a] >= RANK.admin && (a === 'owner' || (RANK[t] < RANK[a] && !['admin', 'owner'].includes(t) && !['admin', 'owner'].includes(n)));
      const now = can(as(a), 'roles.assign', null) && (as(a).owner || (outranks(as(a), as(t)) && outranks(as(a), as(n))));
      assert.equal(now, old, `${a} changes ${t} to ${n}`);
    }
  }
  for (const k of KEYS) assert.equal(legacyRole(as(k)), k);
});

test('owners have every ability, even ones a role editor left out', () => {
  const e = effective([{ role: { template: 'owner', abilities: [] }, scope: ['d1'] }], flat);
  assert.equal(e.owner, true);
  for (const a of ABILITY_LIST) assert.equal(can(e, a, 'anything'), true);
  assert.equal(abilitiesOut(e).scopes['structure.edit'], 'org', 'the Owner role is always org-wide');
});

test('a department scope reaches its teams, not its parent or siblings; org-only abilities need the whole org', () => {
  const t = tree([['pool', 'aquatics'], ['lessons', 'pool'], ['front', null]]);
  const e = effective([{ role: { template: 'admin', abilities: templateOf('admin').abilities }, scope: ['pool'] }], t);
  assert.equal(can(e, 'people.edit', 'pool'), true);
  assert.equal(can(e, 'people.edit', 'lessons'), true, 'a team under it');
  assert.equal(can(e, 'people.edit', 'aquatics'), false, 'not the department above');
  assert.equal(can(e, 'people.edit', 'front'), false);
  assert.equal(can(e, 'people.edit', null), false, 'nothing without a department');
  assert.equal(can(e, 'people.edit'), true, 'somewhere');
  assert.equal(can(e, 'structure.edit'), false, 'org-only abilities never come from a department scope');
  assert.equal(can(e, 'clock.self', null), true, 'abilities about yourself have no scope');
  assert.deepEqual(abilitiesOut(e).scopes['people.edit'], ['lessons', 'pool']);
  assert.equal(legacyRole(e), 'member', 'a department-only role is no 0.5 manager');
});

test('outranking with scopes: more abilities or more places, never the same', () => {
  const t = tree([['a1', 'a'], ['b1', 'b']]);
  const mgrA = effective([{ role: TEMPLATES[2], scope: ['a'] }, { role: TEMPLATES[3], scope: null }].map((g) => ({ role: { template: g.role.key, abilities: g.role.abilities }, scope: g.scope })), t);
  const mgrB = effective([{ role: { template: 'manager', abilities: templateOf('manager').abilities }, scope: ['b'] }, { role: { template: 'member', abilities: templateOf('member').abilities }, scope: null }], t);
  const member = as('member', null, t);
  assert.equal(outranks(mgrA, member), true);
  assert.equal(outranks(mgrA, mgrB), false, 'a manager elsewhere is not below you');
  assert.equal(outranks(mgrA, mgrA), false);
  assert.equal(outranks(as('manager', null, t), mgrA), true, 'the whole org beats one department');
  assert.equal(covers(mgrA, mgrB), false);
  // A custom role with one admin ability: no manager has it, so no manager outranks its holder.
  const rates = effective([{ role: { template: null, abilities: ['rates.view'] }, scope: null }], t);
  assert.equal(outranks(as('manager'), rates), false);
  assert.equal(outranks(as('admin'), rates), true);
});
