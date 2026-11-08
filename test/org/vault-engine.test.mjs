// The payroll vault reads the org engine: people by Kea account, punches with their pay codes, the codes' rates and
// the engine's timecard approvals, over the engine's pay feed (as the KeaS app does it, with a Kea account that has
// rates.view and timecards.view). The vault keeps its own sealed SSNs, W-4s and pay runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from './helpers.mjs';
import { createApp } from '../../server/index.mjs';
import { addDays, weekStartOf, zonedToUtc } from '../../server/lib/time.mjs';

const VAULT_NOW = Date.UTC(2026, 11, 20, 18);
let H, boss, adm, mgr, ana, org, dir, vault, vbase, pay, period;
const O = (p) => `/v1/orgs/${org.id}${p}`;
async function vcall(method, path, token, body) {
  const r = await fetch(vbase + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  H = await startHub({ prefix: 'keas-vault-engine-', clock: Date.UTC(2026, 10, 25, 15) });
  [boss, adm, mgr, ana] = await Promise.all([H.person('boss@v.org', 'Bea Boss'), H.person('adm@v.org', 'Al Admin'), H.person('mgr@v.org', 'Mo Manager'), H.person('ana@v.org', 'Ana Guard')]);
  org = await H.orgWith(boss, 'Vault Pool', [[adm, 'admin'], [mgr, 'manager'], [ana, 'member']]);
  dir = mkdtempSync(join(tmpdir(), 'keas-vault-engine-'));
  // The KeaS app's way to the engine: the pay feed, asked with the payroll admin's Kea account.
  const engineFeed = async ({ from, to }) => {
    const r = await H.call('GET', O(`/pay-feed?from=${from}&to=${to}`), adm.token);
    if (r.status !== 200) throw new Error(r.body?.error || `status ${r.status}`);
    return r.body;
  };
  vault = createApp({ dbFile: join(dir, 'org.db'), log: false, devKeyFile: true, demo: true, now: () => VAULT_NOW, engineFeed });
  vbase = `http://127.0.0.1:${await vault.listen(0)}`;
  pay = (await vcall('POST', '/v1/auth/demo-login', null, { personId: 'p03' })).body.token;
  period = (await vcall('GET', '/v1/me', pay)).body.period.lastCompleted;
  // The engine's pay periods match payroll's.
  H.ok(await H.call('POST', O(''), boss.token, { settings: { clock: { periodDays: 14, periodAnchor: period.start } } }));
});
after(async () => { await vault.close(); rmSync(dir, { recursive: true, force: true }); await H.close(); });

test('hours worked at two codes in the engine are paid by the vault at those codes’ rates, once approved', async () => {
  const guard = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Lifeguard', rate: 15 }), 201).code;
  const swim = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Swim instructor', rate: 18 }), 201).code;
  for (const c of [guard, swim]) H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes`), adm.token, { codeId: c.id }), 201);
  // One week inside the pay period: five 10-hour days, the last two teaching (she picks the code as she clocks in).
  let ws = weekStartOf(period.start, 0); if (ws < period.start) ws = addDays(ws, 7);
  for (let i = 1; i <= 5; i++) {
    const t = zonedToUtc(addDays(ws, i), '08:00', 'America/Denver');
    H.t.now = t;
    H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'in', ...(i > 3 ? { payCodeId: swim.id } : {}) }), 201);
    H.t.now = t + 10 * 3600_000;
    H.ok(await H.call('POST', O('/clock'), ana.token, { type: 'out' }), 201);
  }
  H.t.now = VAULT_NOW;
  let run = (await vcall('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)).body;
  let l = run.lines.find((x) => x.name === 'Ana Guard');
  assert.ok(l, JSON.stringify(run.warnings));
  assert.equal(l.approved, false);
  assert.ok(run.warnings.some((w) => w.code === 'timecard_not_approved' && w.message.startsWith('Ana Guard')));
  // The engine approves her timecard; the vault sees it.
  H.ok(await H.call('POST', O('/timecards/approve'), mgr.token, { accountId: ana.id, periodStart: period.start }));
  run = (await vcall('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)).body;
  l = run.lines.find((x) => x.name === 'Ana Guard');
  assert.equal(l.approved, true);
  assert.deepEqual(l.earnings.filter((e) => e.code === 'regular').map((e) => [e.payCodeName, e.hours, e.rateCents]), [['Lifeguard', 30, 1500], ['Swim instructor', 10, 1800]]);
  const ot = l.earnings.find((e) => e.code === 'overtime');
  assert.deepEqual([ot.hours, ot.regularRateCents, ot.cents], [10, 1620, 26100]);
  assert.equal(l.gross, 89100);
  assert.ok(!run.warnings.some((w) => w.code === 'timecard_not_approved' && w.message.startsWith('Ana Guard')));
  assert.equal(run.canFinalize, false, 'the tables aren’t verified');
  assert.equal((await vcall('POST', '/v1/payrun/finalize', pay, { periodStart: period.start })).status, 409);
  // She's on payroll by her Kea account, with what only the vault keeps (no SSN or W-4 yet: warnings).
  const p = vault.h.get('SELECT id, kea_account_id FROM people WHERE kea_account_id = ?', ana.id);
  assert.ok(p);
  assert.ok(run.warnings.some((w) => w.personId === p.id && w.code === 'no_ssn'));
  // Payroll's checklist knows her rates come from her pay codes: only the SSN and W-4 are asked for.
  const cl = (await vcall('GET', '/v1/setup/checklist', pay)).body;
  assert.deepEqual(cl.steps.find((x) => x.id === 'employeeInfo').people.find((g) => g.personId === p.id).needs, ['a W-4', 'an SSN']);
});

test('the vault needs a Kea account that may see rates and every timecard', async () => {
  const f = await H.call('GET', O(`/pay-feed?from=${period.start}&to=${period.end}`), mgr.token);
  assert.equal(f.status, 403);
});

test('a rate change in the middle of a pay period: the vault pays each day at the rate in effect that day', async () => {
  // (Made before the period: a rate dated on or before the day a code was made is its first rate.)
  H.t.now = zonedToUtc(addDays(period.start, -3), '09:00', 'America/Denver');
  const desk = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Front desk', rate: 12 }), 201).code;
  H.ok(await H.call('POST', O(`/members/${mgr.id}/pay-codes`), adm.token, { codeId: desk.id, default: true }), 201);
  // Mo works the desk on the period's 2nd and 3rd days; from the 3rd the rate is 14.
  const d2 = addDays(period.start, 1), d3 = addDays(period.start, 2);
  H.ok(await H.call('POST', O(`/pay-codes/${desk.id}`), adm.token, { rate: 14, effectiveFrom: d3 }));
  for (const d of [d2, d3]) {
    const t = zonedToUtc(d, '09:00', 'America/Denver');
    H.t.now = t;
    H.ok(await H.call('POST', O('/clock'), mgr.token, { type: 'in', payCodeId: desk.id }), 201);
    H.t.now = t + 5 * 3600_000;
    H.ok(await H.call('POST', O('/clock'), mgr.token, { type: 'out' }), 201);
  }
  H.t.now = VAULT_NOW;
  H.ok(await H.call('POST', O('/timecards/approve'), boss.token, { accountId: mgr.id, periodStart: period.start }));
  const run = (await vcall('GET', `/v1/payrun/preview?periodStart=${period.start}`, pay)).body;
  const l = run.lines.find((x) => x.name === 'Mo Manager');
  assert.deepEqual(l.earnings.filter((e) => e.code === 'regular').map((e) => [e.payCodeName, e.hours, e.rateCents]), [['Front desk', 5, 1200], ['Front desk', 5, 1400]]);
  assert.equal(l.gross, 5 * 1200 + 5 * 1400);
  // Publishing stubs is for finalized runs only.
  assert.equal((await vcall('POST', '/v1/payrun/publish-stubs', pay, { periodStart: period.start })).status, 409);
});
