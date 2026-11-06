// What managers see (audit LOW): a leave case's reason and notes (often medical) are for payroll and the owner only;
// managers see dates and status. Pay amounts in custom reports and pay grades are for payroll and the owner, or
// managers when the owner turns that on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

let dir, app, base;
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-visibility-test-'));
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test('leave cases: managers see dates and status, not the medical reason or notes', async () => {
  const pay = await login('p03'), mgr = await login('p02');
  const made = await call('POST', '/v1/leave-cases', pay, { personId: 'p05', law: 'fmla', reason: 'Own serious health condition', startDate: '2030-01-05', notes: 'Surgery and recovery', entitlementHours: 480 });
  assert.equal(made.status, 201);
  const asMgr = (await call('GET', '/v1/leave-cases', mgr)).body.cases.find((c) => c.id === made.body.case.id);
  assert.equal(asMgr.reason, null);
  assert.equal(asMgr.notes, null);
  assert.equal(asMgr.restricted, true);
  assert.equal(asMgr.startDate, '2030-01-05');
  assert.equal(asMgr.status, 'open');
  const asPay = (await call('GET', '/v1/leave-cases', pay)).body.cases.find((c) => c.id === made.body.case.id);
  assert.deepEqual([asPay.reason, asPay.notes], ['Own serious health condition', 'Surgery and recovery']);
  const own = await call('POST', '/v1/leave-cases', mgr, { personId: 'p04', law: 'fmla', reason: 'Medical', startDate: '2030-02-01', entitlementHours: 80 });
  assert.equal(own.body.case.reason, null, 'not even in what comes back to a manager');
});

test('custom reports and pay grades: no pay amounts for managers unless the owner turns it on', async () => {
  const owner = await login('p01'), pay = await login('p03'), mgr = await login('p02');
  const fields = (await call('GET', '/v1/reports/fields', mgr)).body.datasets;
  assert.ok(!('rate' in fields.people.fields), 'no rate field');
  assert.ok(!fields.pay && !fields.time, 'no pay datasets');
  assert.equal((await call('POST', '/v1/reports/run', mgr, { dataset: 'people', fields: ['name', 'rate'] })).status, 400);
  const all = await call('POST', '/v1/reports/run', mgr, { dataset: 'people' });
  assert.equal(all.status, 200);
  assert.ok(!all.body.columns.includes('rate'));
  assert.equal((await call('POST', '/v1/reports/run', mgr, { dataset: 'pay' })).status, 403);
  // A report payroll saved with pay in it doesn't show pay to a manager either.
  assert.equal((await call('POST', '/v1/reports/saved', pay, { name: 'Rates', spec: { dataset: 'people', fields: ['name', 'rate'] } })).status, 200);
  assert.equal((await call('POST', '/v1/reports/run', mgr, { dataset: 'people', fields: ['name', 'rate'] })).status, 400);
  assert.ok((await call('POST', '/v1/reports/run', pay, { dataset: 'people', fields: ['name', 'rate'] })).body.rows.some((r) => r.rate > 0), 'payroll still sees rates');
  // Pay grades: the band is there, each person's rate isn't.
  const g = (await call('POST', '/v1/pay-grades', pay, { code: 'G1', name: 'Guards', minCents: 1500, maxCents: 3000 })).body.grade;
  await call('POST', '/v1/people/p04/profile', pay, { gradeId: g.id });
  const mg = (await call('GET', '/v1/pay-grades', mgr)).body.grades.find((x) => x.id === g.id);
  assert.equal(mg.people[0].rateCents, null);
  assert.ok((await call('GET', '/v1/pay-grades', pay)).body.grades.find((x) => x.id === g.id).people[0].rateCents > 0);
  // Only the owner turns it on.
  assert.equal((await call('POST', '/v1/org/settings', pay, { managersSeePay: true })).status, 403);
  assert.equal((await call('POST', '/v1/org/settings', owner, { managersSeePay: true })).status, 200);
  assert.ok((await call('POST', '/v1/reports/run', mgr, { dataset: 'people', fields: ['name', 'rate'] })).body.rows.some((r) => r.rate > 0));
  await call('POST', '/v1/org/settings', owner, { managersSeePay: false });
});
