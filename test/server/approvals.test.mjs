// Approvals and pay changes (audit HIGH findings): only the owner changes approval chains; a pay-run approval is bound
// to a hash of the lines and totals, so a run that changed after approval can't be finalized; each step needs a
// different person; managers (who decide "manager of" steps) are set by the owner only; and nobody changes their own
// pay, raises, deposit, balances or job record but the owner. Includes the red team's PoCs as regression tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

const SHARED = new URL('../../shared/', import.meta.url);
let dir, base, app;

async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;
const audits = (action) => app.h.all('SELECT * FROM audit_log WHERE action = ? ORDER BY id', action).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-approvals-test-'));
  const probe = createApp({ dbFile: join(dir, 'probe.db'), log: false, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await probe.listen(0)}`;
  const year = (await call('GET', '/v1/payrun/preview', await login('p03'))).body.year;
  await probe.close();
  // Tables marked verified for that year, only in this temp folder (so the finalize path can be tested).
  const d = join(dir, 'tables');
  cpSync(SHARED, d, { recursive: true });
  for (const code of ['US', 'CO']) {
    const t = JSON.parse(readFileSync(join(d, 'tax', `${code}-2026.json`), 'utf8'));
    writeFileSync(join(d, 'tax', `${code}-${year}.json`), JSON.stringify({ ...t, year, verified: true }));
    const l = JSON.parse(readFileSync(join(d, 'labor', `${code}.json`), 'utf8'));
    writeFileSync(join(d, 'labor', `${code}.json`), JSON.stringify({ ...l, verifiedFor: year }));
  }
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, sharedDir: d, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test('HIGH PoC: a payroll admin can’t change, turn off or delete the owner’s approval chain', async () => {
  const owner = await login('p01'), pay = await login('p03');
  const chain = (await call('POST', '/v1/approval-chains', owner, { kind: 'payrun', name: 'Owner signs pay runs', steps: [{ type: 'role', role: 'owner' }] })).body.chain;
  assert.ok(chain?.id);
  const off = await call('POST', '/v1/approval-chains', pay, { id: chain.id, kind: 'payrun', name: 'x', steps: [{ type: 'role', role: 'payroll' }], active: false });
  assert.equal(off.status, 403);
  assert.equal((await call('POST', '/v1/approval-chains', pay, { kind: 'payrun', name: 'mine', steps: [{ type: 'role', role: 'payroll' }] })).status, 403);
  assert.equal((await call('POST', `/v1/approval-chains/${chain.id}/delete`, pay)).status, 403);
  const pv = (await call('GET', '/v1/payrun/preview', pay)).body;
  assert.equal(pv.needsApproval, true, 'the owner’s chain is still on');
  assert.ok((await call('GET', '/v1/approval-chains', pay)).body.chains.some((c) => c.id === chain.id && c.active));
});

test('HIGH: a pay-run approval covers exactly the run approved; a changed run is refused at finalize until approved again', async () => {
  const owner = await login('p01'), pay = await login('p03');
  const pr = (await call('GET', '/v1/payrun/preview', pay)).body;
  for (const l of pr.lines) await call('POST', '/v1/timecards/approve', owner, { personId: l.personId, periodStart: pr.period.start });
  const sub = await call('POST', '/v1/payrun/submit', pay, { periodStart: pr.period.start });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal((await call('POST', `/v1/approvals/${sub.body.approval.id}/decide`, pay, { approve: true })).status, 403, 'the requester can’t approve it');
  assert.equal((await call('POST', `/v1/approvals/${sub.body.approval.id}/decide`, owner, { approve: true })).status, 200);
  const ready = (await call('GET', `/v1/payrun/preview?periodStart=${pr.period.start}`, pay)).body;
  assert.equal(ready.canFinalize, true, ready.blockers.join(' '));
  // After approval, more pay appears for someone (here a pending bonus; it could be a rate or hours).
  app.h.run(`INSERT INTO extra_earnings (id,org_id,person_id,code,label,cents,taxable,status,created_at) VALUES ('ee-after','org-demo','p04','bonus','Bonus',50000,1,'pending','2030-01-01')`);
  const f = await call('POST', '/v1/payrun/finalize', pay, { periodStart: pr.period.start });
  assert.equal(f.status, 409);
  assert.match(f.body.error, /changed after approval/);
  assert.equal(f.body.changedSinceApproval, true);
  assert.equal(app.h.get(`SELECT COUNT(*) AS n FROM payruns WHERE org_id = 'org-demo' AND period_start = ?`, pr.period.start).n, 0);
  // Submitted again, the old approval is set aside and the new one covers the run as it is now.
  const again = await call('POST', '/v1/payrun/submit', pay, { periodStart: pr.period.start });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(app.h.get('SELECT status FROM approval_requests WHERE id = ?', sub.body.approval.id).status, 'superseded');
  await call('POST', `/v1/approvals/${again.body.approval.id}/decide`, owner, { approve: true });
  const ok = await call('POST', '/v1/payrun/finalize', pay, { periodStart: pr.period.start });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('HIGH: each step of a chain needs a different person (one payroll admin can’t approve two steps in a row)', async () => {
  const owner = await login('p01'), pay = await login('p03'), mgr = await login('p02');
  assert.equal((await call('POST', '/v1/people/p08/profile', owner, { roles: ['payroll'] })).status, 200);
  const pay2 = await login('p08');
  const ch = (await call('POST', '/v1/approval-chains', owner, { kind: 'raise', name: 'Two payroll sign-offs', steps: [{ type: 'role', role: 'payroll' }, { type: 'role', role: 'payroll' }] })).body.chain;
  const r = await call('POST', '/v1/raises', mgr, { personId: 'p04', newRateCents: 2050, effectiveDate: '2099-01-01' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ap = r.body.approval.id;
  assert.equal((await call('POST', `/v1/approvals/${ap}/decide`, pay, { approve: true })).status, 200);
  assert.equal((await call('POST', `/v1/approvals/${ap}/decide`, pay, { approve: true })).status, 403, 'the same person again');
  assert.ok(!(await call('GET', '/v1/approvals?scope=mine', pay)).body.approvals.some((a) => a.id === ap), 'it isn’t waiting on them');
  const done = await call('POST', `/v1/approvals/${ap}/decide`, pay2, { approve: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.approval.status, 'approved');
  await call('POST', `/v1/approval-chains/${ch.id}/delete`, owner);
});

test('HIGH: only the owner changes who manages whom (or a department’s head), and it’s audited', async () => {
  const owner = await login('p01'), pay = await login('p03');
  assert.equal((await call('POST', '/v1/people/p03/job', pay, { managerId: 'p02' })).status, 403, 'not your own');
  assert.equal((await call('POST', '/v1/people/p04/job', pay, { managerId: 'p03' })).status, 403, 'not someone else’s manager');
  assert.equal((await call('POST', '/v1/people/p04/job', pay, { defaultAllocations: [] })).status, 200, 'other job details are still payroll’s');
  const ok = await call('POST', '/v1/people/p04/job', owner, { managerId: 'p03' });
  assert.equal(ok.status, 200);
  const a = audits('manager_change').at(-1);
  assert.equal(a.target, 'p04');
  assert.deepEqual([a.actor, a.detail.to], ['p01', 'p03']);
  const dept = app.h.get(`SELECT id FROM departments WHERE org_id = 'org-demo' LIMIT 1`);
  if (dept) assert.equal((await call('POST', '/v1/departments', pay, { id: dept.id, name: 'Renamed', headPersonId: 'p03' })).status, 403);
  await call('POST', '/v1/people/p04/job', owner, { managerId: 'p02' });
});

test('HIGH PoC: a payroll admin can’t give themselves rates (backdated or not), raises, payouts or balance; others’ increases need approval', async () => {
  const pay = await login('p03'), owner = await login('p01');
  const org = (await call('GET', '/v1/org', pay)).body;
  const before = app.h.all(`SELECT id FROM pay_rates WHERE person_id = 'p03'`).length;
  for (const pos of org.positions) {
    const r = await call('POST', '/v1/people/p03/rates', pay, { positionId: pos.id, rateCents: 99900, effectiveFrom: '2020-01-01' });
    assert.equal(r.status, 403, `self rate for ${pos.id}`);
  }
  assert.equal(app.h.all(`SELECT id FROM pay_rates WHERE person_id = 'p03'`).length, before, 'no rate was added');
  assert.equal((await call('POST', '/v1/raises', pay, { personId: 'p03', newRateCents: 99900, effectiveDate: '2020-01-01' })).status, 403);
  assert.equal((await call('POST', '/v1/pto/adjust', pay, { personId: 'p03', policyId: app.h.get(`SELECT id FROM pto_policies LIMIT 1`)?.id ?? 'x', hours: 80, note: 'gift' })).status, 403);
  assert.equal((await call('POST', '/v1/contractor-payments', pay, { personId: 'p03', date: '2030-01-01', cents: 100000 })).status, 403);
  assert.equal((await call('POST', '/v1/offers', pay, { personId: 'p03', title: 'Boss', rateCents: 99900, startDate: '2030-01-01' })).status, 403);
  // Someone else's rate above their current one, or back-dated: a raise request waiting for approval, not a rate.
  const n4 = app.h.all(`SELECT id FROM pay_rates WHERE person_id = 'p04'`).length;
  const up = await call('POST', '/v1/people/p04/rates', pay, { positionId: 'pos-si', rateCents: 99900, effectiveFrom: '2020-01-01' });
  assert.equal(up.status, 202, JSON.stringify(up.body));
  assert.equal(up.body.needsApproval, true);
  assert.equal(up.body.raise.status, 'pending');
  assert.equal(app.h.all(`SELECT id FROM pay_rates WHERE person_id = 'p04'`).length, n4, 'no rate until it’s approved');
  const low = await call('POST', '/v1/people/p04/rates', pay, { positionId: 'pos-si', rateCents: 1000, effectiveFrom: '2099-01-01' });
  assert.equal(low.status, 201, 'a lower, future rate is still payroll’s to add');
  // The owner can change their own (it's recorded as theirs).
  const mine = await call('POST', '/v1/people/p01/rates', owner, { positionId: 'pos-si', rateCents: 3300, effectiveFrom: '2099-01-01' });
  assert.equal(mine.status, 201);
  assert.equal(audits('rate_add').at(-1).detail.self, true);
});

test('HIGH: direct deposit: your first account is yours to add; changing it is for payroll or the owner', async () => {
  const owner = await login('p01'), pay = await login('p03');
  const acct = { routing: '011000015', account: '99887766554433' };
  assert.equal((await call('POST', '/v1/people/p04/deposit', await login('p04'), acct)).status, 403, 'p04 already has an account');
  assert.equal((await call('POST', '/v1/people/p03/deposit', pay, acct)).status, 403, 'not even payroll, for themselves');
  const np = await call('POST', '/v1/people', pay, { name: 'New Hire', status: 'onboarding' });
  const nid = np.body.profile.id;
  const nt = await login(nid);
  assert.equal((await call('POST', `/v1/people/${nid}/deposit`, nt, acct)).status, 200, 'the first one');
  assert.equal((await call('POST', `/v1/people/${nid}/deposit`, nt, { routing: '011000015', account: '11112222' })).status, 403, 'a change');
  assert.equal((await call('POST', `/v1/people/${nid}/deposit`, pay, { routing: '011000015', account: '11112222' })).status, 200, 'payroll can');
  assert.equal((await call('POST', '/v1/people/p01/deposit', owner, acct)).status, 200, 'the owner can change their own');
});
