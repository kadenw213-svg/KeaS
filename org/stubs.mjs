// Pay stubs for members. When the payroll vault (on the payroll admin's PC) finalizes a pay run, the KeaS app publishes
// each person's stub here (POST /v1/orgs/:id/stubs), so they see their own stubs in Kea (GET /v1/orgs/:id/me/pay and
// /me/stubs). Only the person a stub is for ever gets it back: not the owner, not an admin, not the operator. Each stub
// is sealed whole (AES-256-GCM, server/lib/vault.mjs) with a key only for that member, derived from the server's org
// data key and their Kea account id (HKDF), and bound to the stub's id and the account; a stub copied to someone else's
// row doesn't open.
//
// What a stub may hold: what the person sees on their own pay statement (period, pay date, earnings with hours and
// rates, taxes, deductions, net, year to date, balances). Never an SSN or a bank account: values shaped like either are
// refused, and the vault leaves them out (server/payroll/stubpublish.mjs).
//
// Publishing needs what reading the pay feed needs (rates.view and timecards.view for the whole organization). The
// same run published again replaces its stubs (a correction).
import { hkdfSync, randomUUID } from 'node:crypto';
import { seal, unseal, sealContext } from '../server/lib/vault.mjs';
import { payrollValue } from './payroll.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STUB = 64 * 1024;
const MAX_STUBS = 5000;

/** The key one member's stubs are sealed with. */
const memberKey = (dataKey, accountId) => Buffer.from(hkdfSync('sha256', dataKey, Buffer.from(String(accountId)), 'keas org stub v1', 32));
const ctx = (id, aid) => sealContext('org_stubs', 'body', [id, aid]);

/** Throws when a stub carries something shaped like an SSN or a bank account anywhere in it. */
function clean(v, bad, depth = 0) {
  if (depth > 20) bad('That stub is nested too deeply.');
  if (typeof v === 'string') { if (payrollValue(v)) bad('A stub can’t carry an SSN or a bank account. Payroll keeps those.'); return; }
  if (Array.isArray(v)) { for (const x of v) clean(x, bad, depth + 1); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { clean(k, bad, depth + 1); clean(x, bad, depth + 1); }
}

export function mountStubs(core, { R, dataKey }) {
  const { h, now, audit, notify, bad, notFound, HttpError, asOrg, memberRow, tx } = core;
  const noKey = () => { throw new HttpError(503, 'This server has no org data key, so it can’t keep pay stubs.'); };
  const sealFor = (id, aid, obj) => seal(memberKey(dataKey, aid), JSON.stringify(obj), ctx(id, aid));
  const openFor = (row) => JSON.parse(unseal(memberKey(dataKey, row.account_id), row.body, ctx(row.id, row.account_id)));
  const money = (v) => (Number.isSafeInteger(v) ? v : null);
  const summary = (row) => {
    let s = {};
    try { s = openFor(row); } catch { return { id: row.id, periodStart: row.period_start, periodEnd: row.period_end, payDate: row.pay_date, damaged: true }; }
    return { id: row.id, runId: row.run_id, periodStart: row.period_start, periodEnd: row.period_end, payDate: row.pay_date, grossCents: money(s.line?.gross), netCents: money(s.line?.net), publishedAt: row.published_at };
  };
  /** Someone's own stubs in an organization, newest first (summaries). */
  const listFor = (oid, aid) => (dataKey ? h.all('SELECT * FROM org_stubs WHERE org_id = ? AND account_id = ? ORDER BY pay_date DESC, period_start DESC LIMIT 200', oid, aid).map(summary) : []);

  R('POST', '/v1/orgs/:id/stubs', ({ me, params, body, ip }) => {
    const x = asOrg(params.id, me);
    x.need('rates.view', null);
    x.need('timecards.view', null);
    if (!dataKey) noKey();
    const runId = typeof body.runId === 'string' && /^[\w-]{1,80}$/.test(body.runId) ? body.runId : bad('runId is the pay run’s id.');
    const dates = ['periodStart', 'periodEnd', 'payDate'].map((k) => (typeof body[k] === 'string' && DATE.test(body[k]) ? body[k] : bad(`${k} looks like 2026-12-01.`)));
    if (!Array.isArray(body.stubs) || body.stubs.length > MAX_STUBS) bad(`stubs is a list of at most ${MAX_STUBS}.`);
    const seen = new Set();
    const rows = body.stubs.map((s) => {
      const aid = typeof s?.accountId === 'string' && s.accountId.length <= 80 ? s.accountId : bad('Each stub says whose it is (accountId).');
      if (seen.has(aid)) bad('One stub per person.');
      seen.add(aid);
      if (!memberRow(x.o.id, aid)) bad('A stub is for someone who isn’t in this organization.');
      if (!s.stub || typeof s.stub !== 'object' || Array.isArray(s.stub)) bad('Each stub has its content (stub).');
      if (JSON.stringify(s.stub).length > MAX_STUB) bad('A stub is too big.');
      clean(s.stub, bad);
      return { aid, stub: s.stub };
    });
    let added = 0, replaced = 0;
    tx(() => {
      for (const r of rows) {
        const old = h.get('SELECT id FROM org_stubs WHERE org_id = ? AND run_id = ? AND account_id = ?', x.o.id, runId, r.aid);
        const id = old?.id ?? randomUUID();
        const sealed = sealFor(id, r.aid, r.stub);
        if (old) { h.run('UPDATE org_stubs SET period_start = ?, period_end = ?, pay_date = ?, body = ?, published_by = ?, published_at = ? WHERE id = ?', ...dates, sealed, me.id, now(), id); replaced++; }
        else { h.run('INSERT INTO org_stubs (id,org_id,account_id,run_id,period_start,period_end,pay_date,body,published_by,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, x.o.id, r.aid, runId, ...dates, sealed, me.id, now()); added++; }
      }
    });
    for (const r of rows) notify(r.aid, 'org', `Your pay stub for ${dates[0]} to ${dates[1]} is ready`, `Pay date ${dates[2]}. Open My pay to see it.`, { data: { orgId: x.o.id, runId, payDate: dates[2] } });
    // (No amounts in the audit log.)
    audit(me.id, 'org.stubs_publish', x.o.id, { runId, added, replaced }, ip);
    return { status: 201, body: { runId, added, replaced } };
  });
  R('GET', '/v1/orgs/:id/me/stubs', ({ me, params }) => {
    const x = asOrg(params.id, me);
    return { stubs: listFor(x.o.id, me.id) };
  });
  R('GET', '/v1/orgs/:id/me/stubs/:sid', ({ me, params }) => {
    const x = asOrg(params.id, me);
    if (!dataKey) noKey();
    const row = h.get('SELECT * FROM org_stubs WHERE id = ? AND org_id = ? AND account_id = ?', params.sid, x.o.id, me.id) ?? notFound('No such stub of yours.');
    return { stub: { id: row.id, runId: row.run_id, periodStart: row.period_start, periodEnd: row.period_end, payDate: row.pay_date, publishedAt: row.published_at, ...openFor(row) } };
  });
  return { listFor };
}
