// The payroll vault reads the hours it pays from the org engine (org/paycodes.mjs payFeed): who works there (by Kea
// account id), their punches with the pay code each stretch was worked at, the codes' rates, and whether their
// timecards are approved. The vault keeps only what's sensitive: SSNs, bank details, W-4s, tax settings, pay runs,
// stubs and time-off balances, on the people rows linked to those Kea accounts (people.kea_account_id).
//
//   makeEngineSource({ h, feed, uid, now }) -> { load, memberFor, codeOf, defaultRateOf, status }
//
// feed({ from, to }): the host's way to the engine, resolving to the feed (the KeaS app: GET
// /v1/orgs/:id/pay-feed with the signed-in Kea account, which needs rates.view and timecards.view for the whole
// organization). The vault asks for each pay period before working it out (preview, submit, finalize, stubs, the
// bank file, the GL journal); the last answer is kept in memory only.
import { byName } from '../db.mjs';

export class EngineUnavailable extends Error {}

export function makeEngineSource({ h, feed, uid, now, iso }) {
  let cache = null; // { from, to, at, feed, byAccount, codes }
  let lastError = null;

  /** Finds or adds the vault person for each engine member; returns account id -> person id. */
  function link(org, f) {
    const people = h.all('SELECT id, email, kea_account_id FROM people WHERE org_id = ?', org.id);
    const byAccount = new Map(people.filter((p) => p.kea_account_id).map((p) => [p.kea_account_id, p.id]));
    const out = new Map();
    for (const m of f.people) {
      let pid = byAccount.get(m.accountId);
      // (A payroll sign-in already linked to that Kea account, then the same email.)
      if (!pid) pid = h.get('SELECT v.person_id AS id FROM vault_users v JOIN people p ON p.id = v.person_id WHERE v.hub_sub = ? AND p.org_id = ? AND p.kea_account_id IS NULL', m.accountId, org.id)?.id;
      if (!pid && m.email) pid = people.find((p) => !p.kea_account_id && p.email && String(p.email).toLowerCase() === String(m.email).toLowerCase())?.id;
      if (pid) { if (!byAccount.has(m.accountId)) h.run('UPDATE people SET kea_account_id = ? WHERE id = ?', m.accountId, pid); }
      else {
        pid = uid('p');
        h.run(`INSERT INTO people (id,org_id,name,email,roles,positions,status,worker_type,kea_account_id,hire_date) VALUES (?,?,?,?,'["member"]','[]','active','employee',?,NULL)`, pid, org.id, m.name || m.email || 'New person', m.email ?? null, m.accountId);
      }
      byAccount.set(m.accountId, pid);
      out.set(m.accountId, pid);
    }
    return out;
  }

  /** Asks the engine for a pay period's hours (and links its people). Throws EngineUnavailable when it can't. */
  async function load(org, period) {
    let f;
    try { f = await feed({ from: period.start, to: period.end }); }
    catch (e) { lastError = e.message; throw new EngineUnavailable(`Payroll can’t get the hours from the organization server right now (${e.message}). Check that KeaS is signed in and can reach it, then try again.`); }
    if (!f || f.v !== 1 || !Array.isArray(f.people) || !Array.isArray(f.codes)) { lastError = 'unexpected answer'; throw new EngineUnavailable('The organization server answered with something payroll doesn’t understand. Update KeaS.'); }
    const ids = h.tx(() => link(org, f));
    const byPerson = new Map(f.people.map((m) => [ids.get(m.accountId), m]));
    cache = { from: period.start, to: period.end, at: now(), feed: f, byPerson, codes: new Map(f.codes.map((c) => [c.id, c])) };
    lastError = null;
    return cache;
  }
  const covers = (period) => cache && cache.from <= period.start && cache.to >= period.end;
  return {
    load,
    /** The engine's record for a vault person for this period (null when it isn't loaded or they aren't a member). */
    memberFor: (person, period) => (covers(period) ? cache.byPerson.get(person.id) ?? null : null),
    codeOf: (id) => cache?.codes.get(id) ?? null,
    /** A person's default code's rate (for holidays and paid time off when the vault has no rate of its own). */
    defaultRateOf(person, period) { const m = covers(period) ? cache.byPerson.get(person.id) : null; return m?.defaultCodeId ? cache.codes.get(m.defaultCodeId)?.rateCents ?? null : null; },
    org: () => cache?.feed.org ?? null,
    status: () => ({ loaded: cache ? { from: cache.from, to: cache.to, at: iso(cache.at), people: cache.feed.people.length, codes: cache.feed.codes.length } : null, error: lastError }),
    people: (org) => byName(h.all('SELECT id, name FROM people WHERE org_id = ? AND kea_account_id IS NOT NULL', org.id)),
  };
}
