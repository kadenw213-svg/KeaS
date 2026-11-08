// The KeaS org engine: one module for organizations that any KeaS server can mount (the KeaS server, hub/index.mjs;
// the Kea Hub of KeaS 0.5 while its accounts haven't moved; KeaC for the organizations it hosts). It brings its own tables (./schema.mjs, upgraded in place from earlier versions), roles with
// abilities (./roles.mjs), the org routes (./routes.mjs), roles routes (./roleRoutes.mjs), the time clock
// (./clock.mjs) and pay codes (./paycodes.mjs), and imports from an org server's database (./import.mjs).
//
//   const org = mountOrg({ R, h, now, audit, notify, identity, ...options })
//
// R(method, path, handler, opts): the host's router. Each handler gets { me, params, query, body, ip }, where me is
//   the signed-in caller with me.id their Kea account id (the identity adapter reads the rest from it).
// h: the host's database ({ db, get, all, run, tx }; node:sqlite). The engine's tables go in it.
// now(): the time in ms. audit(actor, action, target, detail, ip). notify(accountId, kind, title, body, { note, data }).
// identity: who people are, from whatever sign-in system the host uses (./identity.mjs).
// dataKey: the server's org data key (32 bytes, or 64 hex characters), which seals pay code rates. Without it the
//   engine works, but pay codes can't be made (their rates have nowhere safe to go). The host keeps it next to its
//   database, readable only by the account the server runs as (the Kea Hub: <data folder>/org-data.key).
// Options: O (the operator's console router, for approving organizations) with operator { autoApprove(),
//   setAutoApprove(v) }; classes: true when the host has the Kea Hub's class tables; kit: { HttpError, V, limit,
//   normCode, rawOut } to use the host's own error class, input checks, rate limits and file answers.
import { migrateOrg } from './schema.mjs';
import { makeCore } from './core.mjs';
import { OrgHttpError, makeValidators, defaultNormCode } from './kit.mjs';
import { mountRoutes } from './routes.mjs';
import { mountRoleRoutes } from './roleRoutes.mjs';
import { mountClock } from './clock.mjs';
import { importServerOrg } from './import.mjs';
import { dataKeyFrom, makeRateSealer, makePayLogic, mountPayCodes } from './paycodes.mjs';
import { mountStubs } from './stubs.mjs';

export { ABILITIES, ABILITY_LIST, TEMPLATES } from './roles.mjs';
export { ORG_SCHEMA, ORG_SCHEMA_VERSION, migrateOrg } from './schema.mjs';
export { staticIdentity, passIdentity } from './identity.mjs';
export { OrgHttpError } from './kit.mjs';
export { dataKeyFrom } from './paycodes.mjs';

export function mountOrg({ R, h, now = () => Date.now(), audit = () => {}, notify = () => {}, identity, O = null, operator = null, classes = false, kit = {}, dataKey = null }) {
  if (!identity?.who || !identity?.profiles) throw new Error('mountOrg needs an identity adapter (org/identity.mjs).');
  const HttpError = kit.HttpError ?? OrgHttpError;
  const fullKit = {
    HttpError, V: kit.V ?? makeValidators(HttpError), limit: kit.limit ?? (() => {}), normCode: kit.normCode ?? defaultNormCode,
    rawOut: kit.rawOut ?? ((data, headers) => ({ filename: /filename="([^"]*)"/.exec(headers?.['content-disposition'] || '')?.[1] ?? 'download', csv: Buffer.isBuffer(data) ? data.toString('utf8').replace(/^﻿/, '') : String(data) })),
  };
  const upgrade = migrateOrg(h.db, { now: now() });
  const core = makeCore({ h, now, audit, notify, identity, kit: fullKit });
  const key = dataKeyFrom(dataKey);
  core.pay = makePayLogic(core, key ? makeRateSealer(key) : null);
  // Pay stubs the payroll vault publishes, each sealed for its member (./stubs.mjs). Not through the payroll guard:
  // stubs carry pay amounts by design, and stubs.mjs refuses SSN- and bank-shaped values itself.
  core.stubs = mountStubs(core, { R, dataKey: key });
  const main = mountRoutes(core, { R, O, classes, operator });
  // (Through the same payroll guard as every org route.)
  mountRoleRoutes(core, { R: main.OR, deptRow: main.deptRow });
  const clock = mountClock(core, { R: main.OR, rulesFor: main.rulesFor, date: main.date, list: main.list });
  // (Pay code routes carry rates, so they go through the guard with rates allowed; SSNs and bank details still never.)
  const payCodes = mountPayCodes(core, { R: (m, p, fn, o) => main.OR(m, p, fn, { ...o, rates: true }), Rplain: main.OR, deptRow: main.deptRow, positionRow: main.positionRow, clock });

  /** Organizations where this account is the only owner and others are still members (it can't go yet). */
  const soleOwnerOrgs = (aid) => h.all('SELECT DISTINCT o.id, o.name FROM org_role_assignments a JOIN org_roles r ON r.id = a.role_id JOIN orgs o ON o.id = a.org_id WHERE a.account_id = ? AND r.template_key = ?', aid, 'owner')
    .filter((o) => core.ownersOf(o.id).filter((x) => x !== aid).length === 0 && h.get('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND account_id != ?', o.id, aid).n > 0);
  /** Who an organization goes to when this account goes: another owner, then an admin, then whoever joined first. */
  const heirOf = (oid, aid) => {
    const all = core.effAll(oid);
    const rank = (x) => (core.isOwner(oid, x) ? 0 : (all.get(x) && ['admin'].includes(core.legacyFor(oid, x, all)) ? 1 : 2));
    const rows = h.all('SELECT account_id, joined_at FROM org_members WHERE org_id = ? AND account_id != ? ORDER BY joined_at', oid, aid);
    return rows.sort((a, b) => rank(a.account_id) - rank(b.account_id) || a.joined_at - b.joined_at)[0]?.account_id ?? null;
  };
  /**
   * Everything the engine keeps for one account, gone (the account itself is being deleted): memberships, roles,
   * answers, certs, punches and time off. Shifts they worked stay, without them, for budgets. Run inside the host's
   * transaction for deleting the account.
   */
  function forgetAccount(aid) {
    h.run('INSERT OR IGNORE INTO org_erase (account_id) VALUES (?)', aid);
    h.run('DELETE FROM org_punch_codes WHERE punch_id IN (SELECT id FROM org_punches WHERE account_id = ?)', aid);
    h.run('DELETE FROM org_punches WHERE account_id = ?', aid);
    h.run('DELETE FROM org_erase WHERE account_id = ?', aid);
    h.run('UPDATE org_shifts SET account_id = NULL WHERE account_id = ?', aid);
    for (const t of ['org_stubs', 'org_role_assignments', 'org_member_positions', 'org_member_pay_codes', 'org_punch_requests', 'org_timecard_approvals', 'org_time_off', 'org_certs', 'org_class_assignments', 'org_responses', 'org_response_changes', 'org_nudges', 'org_policy_acks', 'org_todo_snoozes', 'org_members'])
      h.run(`DELETE FROM ${t} WHERE account_id = ?`, aid);
    h.run('DELETE FROM org_swaps WHERE from_account = ? OR claimant = ?', aid, aid);
  }
  /** One account's memberships, for the host's "export my data". */
  const membershipsOf = (aid) => h.all('SELECT org_id, status, joined_at FROM org_members WHERE account_id = ?', aid)
    .map((m) => ({ org_id: m.org_id, role: core.legacyFor(m.org_id, aid), roles: core.assignmentsOut(m.org_id, aid).map((r) => r.name), status: m.status, joined_at: m.joined_at }));

  return {
    upgrade, core, todoFor: main.todoFor, soleOwnerOrgs, heirOf, forgetAccount, membershipsOf, computeTimecard: clock.computeTimecard,
    /** What the payroll vault pays a period from (./paycodes.mjs payFeed): { from, to } local dates. */
    payFeed: payCodes.payFeed,
    /** The one-time import of an org server's people, shifts and punches (./import.mjs). */
    importServerOrg: (opts) => importServerOrg(core, { ...opts, addPunch: clock.addPunch }),
  };
}
