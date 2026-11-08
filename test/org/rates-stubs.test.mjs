// Pay code rate history (a new rate from a date; hours paid at the rate of the day they were worked) and pay stubs
// published to members (each sees only their own, sealed for them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHub } from './helpers.mjs';
import { isSealed, unseal, sealContext } from '../../server/lib/vault.mjs';
import { zonedToUtc } from '../../server/lib/time.mjs';

let H, boss, adm, mgr, ana, ben, org, guard;
const O = (p) => `/v1/orgs/${org.id}${p}`;
before(async () => {
  H = await startHub({ prefix: 'keas-rates-', clock: Date.UTC(2026, 10, 2, 15) });
  [boss, adm, mgr, ana, ben] = await Promise.all([H.person('boss@r.org', 'Bo'), H.person('adm@r.org', 'Al'), H.person('mgr@r.org', 'Mo'), H.person('ana@r.org', 'Ana'), H.person('ben@r.org', 'Ben')]);
  org = await H.orgWith(boss, 'Rate Pool', [[adm, 'admin'], [mgr, 'manager'], [ana, 'member'], [ben, 'member']]);
  H.ok(await H.call('POST', O(''), boss.token, { settings: { clock: { periodDays: 14, periodAnchor: '2026-11-01' } } }));
  guard = H.ok(await H.call('POST', O('/pay-codes'), adm.token, { name: 'Lifeguard', rate: 15 }), 201).code;
  H.ok(await H.call('POST', O(`/members/${ana.id}/pay-codes`), adm.token, { codeId: guard.id }), 201);
});
after(() => H.close());

const work = async (u, day, hours) => {
  const t = zonedToUtc(day, '08:00', 'America/Denver');
  const keep = H.t.now;
  H.t.now = t; H.ok(await H.call('POST', O('/clock'), u.token, { type: 'in' }), 201);
  H.t.now = t + hours * 3600_000; H.ok(await H.call('POST', O('/clock'), u.token, { type: 'out' }), 201);
  H.t.now = keep;
};

test('a rate from a date: hours before it keep the old rate, hours from it get the new one', async () => {
  H.t.now = Date.UTC(2026, 10, 4, 15);
  // A raise from 6 November.
  const c = H.ok(await H.call('POST', O(`/pay-codes/${guard.id}`), adm.token, { rate: 17, effectiveFrom: '2026-11-06' })).code;
  assert.deepEqual(c.rates.map((r) => [r.from, r.rateCents]), [[null, 1500], ['2026-11-06', 1700]]);
  assert.equal(c.rateCents, 1500, 'today it’s still 15');
  assert.deepEqual(c.upcoming, [{ from: '2026-11-06', rateCents: 1700 }]);
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}`), adm.token, { rate: 17, effectiveFrom: '6 Nov' })).status, 400);
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}`), adm.token, { effectiveFrom: '2026-11-09' })).status, 400, 'a date needs a rate');
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}`), mgr.token, { rate: 30, effectiveFrom: '2026-11-09' })).status, 403);
  // Her own view says what's coming too.
  const mine0 = H.ok(await H.call('GET', O('/me/pay'), ana.token));
  assert.deepEqual(mine0.codes[0].upcoming, [{ from: '2026-11-06', rateCents: 1700 }]);
  await work(ana, '2026-11-04', 4);
  await work(ana, '2026-11-05', 4);
  await work(ana, '2026-11-06', 6);
  H.t.now = Date.UTC(2026, 10, 7, 15);
  const mine = H.ok(await H.call('GET', O('/me/pay'), ana.token));
  assert.deepEqual(mine.hours.map((x) => [x.name, x.rateCents, x.hours, x.from, x.to]), [['Lifeguard', 1500, 8, '2026-11-04', '2026-11-05'], ['Lifeguard', 1700, 6, '2026-11-06', '2026-11-06']]);
  assert.equal(mine.codes[0].rateCents, 1700, 'now it’s 17');
  // The pay feed carries the whole history; the vault pays each day at its rate (test/org/vault-engine.test.mjs).
  const feed = H.ok(await H.call('GET', O('/pay-feed?from=2026-11-01&to=2026-11-14'), adm.token));
  assert.deepEqual(feed.codes.find((x) => x.id === guard.id).rates, [{ from: null, rateCents: 1500 }, { from: '2026-11-06', rateCents: 1700 }]);
  // Each change is sealed for its code and date; none of it is in the audit log.
  const row = H.hub.h.get('SELECT * FROM org_pay_code_rates WHERE code_id = ?', guard.id);
  const key = Buffer.from(readFileSync(join(H.dir, 'org-data.key'), 'utf8').trim(), 'hex');
  assert.ok(isSealed(row.rate));
  assert.equal(unseal(key, row.rate, sealContext('org_pay_code_rates', 'rate', [guard.id, '2026-11-06'])), '1700');
  assert.throws(() => unseal(key, row.rate, sealContext('org_pay_code_rates', 'rate', [guard.id, '2026-11-07'])));
  assert.ok(H.hub.h.all("SELECT detail FROM audit WHERE action LIKE 'org.paycode%'").every((a) => !/1700|1500/.test(a.detail ?? '')));
});

test('a change that hasn’t started can be taken back; one that has, can’t', async () => {
  H.ok(await H.call('POST', O(`/pay-codes/${guard.id}`), adm.token, { rate: 20, effectiveFrom: '2026-12-01' }));
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}/rates/2026-11-06/delete`), adm.token, {})).status, 400);
  const c = H.ok(await H.call('POST', O(`/pay-codes/${guard.id}/rates/2026-12-01/delete`), adm.token, {})).code;
  assert.deepEqual(c.rates.map((r) => r.from), [null, '2026-11-06']);
  assert.equal((await H.call('POST', O(`/pay-codes/${guard.id}/rates/2026-12-01/delete`), adm.token, {})).status, 404);
});

let runStubs;
test('stubs: payroll publishes each person’s; each sees only their own, sealed for them', async () => {
  const body = (net) => ({ org: { name: 'Rate Pool' }, period: { start: '2026-11-01', end: '2026-11-14' }, payDate: '2026-11-20', line: { gross: net + 2000, net, earnings: [{ code: 'regular', label: 'Regular', hours: 14, rateCents: 1500, cents: net + 2000 }], taxes: [{ code: 'fed', cents: 2000 }] }, ytd: { gross: net + 2000 } });
  runStubs = { runId: 'run-1', periodStart: '2026-11-01', periodEnd: '2026-11-14', payDate: '2026-11-20', stubs: [{ accountId: ana.id, stub: body(19000) }, { accountId: ben.id, stub: body(5000) }] };
  // Publishing is for whoever may read the pay feed (rates.view and timecards.view everywhere).
  assert.equal((await H.call('POST', O('/stubs'), mgr.token, runStubs)).status, 403);
  assert.equal((await H.call('POST', O('/stubs'), adm.token, { ...runStubs, stubs: [{ accountId: 'not-a-member', stub: body(1) }] })).status, 400);
  assert.equal((await H.call('POST', O('/stubs'), adm.token, { ...runStubs, stubs: [{ accountId: ana.id, stub: { ...body(1), note: 'SSN 123-45-6789' } }] })).status, 400, 'never an SSN');
  assert.equal((await H.call('POST', O('/stubs'), adm.token, { ...runStubs, stubs: [{ accountId: ana.id, stub: { ...body(1), bank: 'routing 021000021 account 123456789012' } }] })).status, 400, 'never a bank account');
  assert.deepEqual(H.ok(await H.call('POST', O('/stubs'), adm.token, runStubs), 201), { runId: 'run-1', added: 2, replaced: 0 });
  const mine = H.ok(await H.call('GET', O('/me/pay'), ana.token)).stubs;
  assert.deepEqual(mine.map((s) => [s.payDate, s.netCents, s.grossCents]), [['2026-11-20', 19000, 21000]]);
  const full = H.ok(await H.call('GET', O(`/me/stubs/${mine[0].id}`), ana.token)).stub;
  assert.deepEqual([full.line.net, full.line.earnings[0].hours, full.periodStart], [19000, 14, '2026-11-01']);
  // Nobody else gets Ana's: not Ben, not the admin who published it, not the owner.
  for (const u of [ben, adm, boss]) assert.equal((await H.call('GET', O(`/me/stubs/${mine[0].id}`), u.token)).status, 404);
  assert.equal(H.ok(await H.call('GET', O('/me/stubs'), ben.token)).stubs[0].netCents, 5000);
  assert.deepEqual(H.ok(await H.call('GET', O('/me/stubs'), boss.token)).stubs, []);
  // She was told.
  assert.ok(H.ok(await H.call('GET', '/v1/me/notifications', ana.token)).notifications.some((n) => /pay stub/.test(n.title)));
  // Sealed whole, for her only: her stub copied onto Ben's row doesn't open.
  const row = H.hub.h.get('SELECT * FROM org_stubs WHERE account_id = ?', ana.id);
  const benRow = H.hub.h.get('SELECT * FROM org_stubs WHERE account_id = ?', ben.id);
  assert.ok(isSealed(row.body) && !row.body.includes('19000'));
  H.hub.h.run('UPDATE org_stubs SET body = ? WHERE id = ?', row.body, benRow.id);
  assert.equal(H.ok(await H.call('GET', O('/me/stubs'), ben.token)).stubs[0].damaged, true, 'a copied stub doesn’t open');
  H.hub.h.run('UPDATE org_stubs SET body = ? WHERE id = ?', benRow.body, benRow.id);
  // The same run again is a correction.
  runStubs.stubs[0].stub.line.net = 19500;
  assert.deepEqual(H.ok(await H.call('POST', O('/stubs'), adm.token, runStubs), 201), { runId: 'run-1', added: 0, replaced: 2 });
  assert.equal(H.ok(await H.call('GET', O('/me/stubs'), ana.token)).stubs[0].netCents, 19500);
});

test('leaving takes your stubs with you', async () => {
  H.ok(await H.call('POST', '/v1/me/leave-server', ben.token, { confirm: 'ben@r.org' }));
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_stubs WHERE account_id = ?', ben.id).n, 0);
});
