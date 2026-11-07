// Payroll's "Get set up" steps (server/payroll/checklist.mjs): each one done or not by the same checks the pay run
// uses, with where it's fixed. The tax tables step is never done by anything in the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';
import { localMinimumWage, withPlace } from '../../server/lib/rules.mjs';

let dir, app, base;
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-checklist-'));
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('local rules: a city the tables know raises the minimum wage there', () => {
  const rules = { minimumWage: { standard: 15.16, youthDiscountPct: 15, localOverrides: [{ place: 'Denver', standard: 19.29 }] } };
  assert.equal(localMinimumWage(rules, 'denver').standard, 19.29);
  assert.equal(localMinimumWage(rules, 'City and County of Denver').standard, 19.29);
  assert.equal(localMinimumWage(rules, 'Boulder'), null);
  assert.equal(withPlace(rules, 'Denver').minimumWage.standard, 19.29);
  assert.equal(withPlace(rules, 'Denver').minimumWage.youthDiscountPct, 0);
  assert.equal(withPlace(rules, 'Boulder'), rules);
});

test('the checklist: each step, re-checked as things are fixed; never the tables', async () => {
  const pay = await login('p03');
  assert.equal((await call('GET', '/v1/setup/checklist', await login('p04'))).status, 403, 'staff can’t see it');
  let r = (await call('GET', '/v1/setup/checklist', pay)).body;
  assert.deepEqual(r.steps.map((s) => s.id), ['org', 'rules', 'verified', 'employer', 'suta', 'people', 'employeeInfo', 'approvers', 'timecards']);
  for (const s of r.steps) { assert.equal(typeof s.text, 'string'); assert.ok(s.text.length > 0 && s.text.length < 600, s.id); }

  // Where people work: not given yet.
  assert.equal(stepOf(r, 'org').done, false);
  assert.equal(stepOf(r, 'org').fix.view, 'settings');
  await call('POST', '/v1/org/settings', pay, { workCity: 'Denver' });
  r = (await call('GET', '/v1/setup/checklist', pay)).body;
  assert.equal(stepOf(r, 'org').done, true);
  assert.match(stepOf(r, 'rules').rules.find((x) => x.name === 'Minimum wage').note, /19\.29.*Denver/);
  await call('POST', '/v1/org/settings', pay, { workCity: 'Boulder' });
  r = (await call('GET', '/v1/setup/checklist', pay)).body;
  assert.match(stepOf(r, 'rules').text, /no Boulder rules/);

  // The shipped tables aren't checked: never done, with what checking needs and the official sources.
  const v = stepOf(r, 'verified');
  assert.equal(v.done, false);
  assert.equal(v.fix, null, 'nothing in the app marks a table checked');
  assert.match(v.text, /official sources/);
  assert.match(v.text, /KeaS update/);
  assert.ok(v.sources.some((s) => /irs\.gov/.test(s.url)));
  assert.ok(r.left >= 1);

  // A person without a W-4: named, with a link to their tax card.
  app.h.run(`UPDATE people SET w4 = '{}' WHERE id = 'p05'`);
  r = (await call('GET', '/v1/setup/checklist', pay)).body;
  const info = stepOf(r, 'employeeInfo');
  assert.equal(info.done, false);
  const p5 = info.people.find((p) => p.personId === 'p05');
  assert.deepEqual(p5.needs, ['a W-4']);
  assert.deepEqual(info.fix.view, 'employees');

  // No EIN: the employer step says so.
  app.h.run(`UPDATE legal_entities SET ein = NULL`);
  r = (await call('GET', '/v1/setup/checklist', pay)).body;
  assert.equal(stepOf(r, 'employer').done, false);
  assert.match(stepOf(r, 'employer').text, /EIN/);

  // Timecards for the pay run: approving them ticks the step.
  const tc = stepOf(r, 'timecards');
  assert.equal(tc.done, false);
  assert.equal(tc.fix.team, true);
  const team = (await call('GET', `/v1/timecards/period?periodStart=${tc.fix.periodStart}`, await login('p02'))).body;
  const ids = team.people.filter((p) => !p.approved && p.workedMin > 0).map((p) => p.personId);
  await call('POST', '/v1/timecards/approve-many', await login('p01'), { periodStart: tc.fix.periodStart, personIds: ids });
  r = (await call('GET', '/v1/setup/checklist', pay)).body;
  assert.equal(stepOf(r, 'timecards').done, true);
});

test('with tables checked for the year (a test copy only), the tables step is done', async () => {
  const shared = new URL('../../shared/', import.meta.url);
  const d = join(dir, 'tables');
  cpSync(shared, d, { recursive: true });
  const probe = (await call('GET', '/v1/setup/checklist', await login('p03'))).body.year;
  for (const code of ['US', 'CO']) {
    const t = JSON.parse(readFileSync(join(d, 'tax', `${code}-2026.json`), 'utf8'));
    writeFileSync(join(d, 'tax', `${code}-${probe}.json`), JSON.stringify({ ...t, year: probe, verified: true }));
    const l = JSON.parse(readFileSync(join(d, 'labor', `${code}.json`), 'utf8'));
    writeFileSync(join(d, 'labor', `${code}.json`), JSON.stringify({ ...l, verifiedFor: probe }));
  }
  const app2 = createApp({ dbFile: join(dir, 'org2.db'), log: false, devKeyFile: true, demo: true, sharedDir: d });
  const b2 = `http://127.0.0.1:${await app2.listen(0)}`;
  try {
    const t = (await (await fetch(`${b2}/v1/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: 'p03' }) })).json()).token;
    const r = await (await fetch(`${b2}/v1/setup/checklist`, { headers: { authorization: `Bearer ${t}` } })).json();
    assert.equal(stepOf(r, 'verified').done, true);
  } finally { await app2.close(); }
});
