// The KeaS window's "Get set up" steps (desktop/checklist.cjs): what each checks, and when the list is all set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keasSteps } = require('../../desktop/checklist.cjs');
const ids = (r) => r.steps.map((s) => s.id);
const get = (r, id) => r.steps.find((s) => s.id === id);
const me = (x = {}) => ({ signedIn: true, reachable: true, account: { email: 'pat@example.org', emailVerified: true, owner: false, ...x } });

test('signed out: one step, sign in', () => {
  const r = keasSteps({ account: { signedIn: false } });
  assert.deepEqual(ids(r), ['account']);
  assert.equal(get(r, 'account').action, 'signin');
  assert.equal(r.allSet, false);
});

test('a normal user: email, organization (create, approval, state), payroll, then all set', () => {
  let r = keasSteps({ account: me({ emailVerified: false }), orgs: [] });
  assert.deepEqual(ids(r), ['account', 'email', 'org']);
  assert.equal(get(r, 'email').done, false);
  assert.match(get(r, 'email').text, /Verify with Google/);
  assert.equal(get(r, 'org').action, 'org');
  assert.ok(!ids(r).includes('payroll'), 'no payroll step for someone who doesn’t run an organization');

  // Created, waiting for the Hub's owner; no state yet.
  r = keasSteps({ account: me(), orgs: [{ id: 'o1', name: 'Camp', role: 'owner', status: 'pending', state: null }], payroll: { initialized: false } });
  assert.deepEqual(ids(r), ['account', 'email', 'org', 'orgApproved', 'orgPlace', 'payroll']);
  assert.equal(get(r, 'orgApproved').done, false);
  assert.match(get(r, 'orgApproved').text, /Waiting/);
  assert.equal(get(r, 'orgPlace').action, 'orgEdit');
  assert.equal(get(r, 'payroll').action, 'payroll');
  assert.equal(r.org.name, 'Camp');

  // Approved, state set, vault set up, Payroll's own list known: only the tables wait, so it's all set.
  r = keasSteps({ account: me(), orgs: [{ id: 'o1', name: 'Camp', role: 'owner', status: 'active', state: 'CO' }],
    payroll: { initialized: true, summary: { left: 1, total: 8, year: 2026, steps: [{ id: 'org', title: 'Organization details', done: true }, { id: 'verified', title: 'Tax tables checked for 2026', done: false, blocking: true }, { id: 'approvers', title: 'Who approves', done: false, optional: true }] } } });
  assert.equal(get(r, 'payrollSteps').done, true);
  assert.equal(get(r, 'tables').waiting, true);
  assert.equal(get(r, 'tables').action, null, 'nothing here marks tables checked');
  assert.equal(r.allSet, true);
  assert.equal(r.waiting, 1);

  // Something left in Payroll: named, and the button opens Payroll.
  r = keasSteps({ account: me(), orgs: [{ id: 'o1', name: 'Camp', role: 'owner', status: 'active', state: 'CO' }],
    payroll: { initialized: true, summary: { left: 1, total: 8, year: 2026, steps: [{ id: 'employeeInfo', title: 'What payroll needs for each person', done: false }] } } });
  assert.equal(get(r, 'payrollSteps').done, false);
  assert.match(get(r, 'payrollSteps').text, /what payroll needs for each person/);
  assert.equal(r.allSet, false);

  // Vault set up but not opened this run: "open Payroll to see".
  r = keasSteps({ account: me(), orgs: [{ id: 'o1', name: 'Camp', role: 'owner', status: 'active', state: 'CO' }], payroll: { initialized: true, summary: null } });
  assert.match(get(r, 'payrollSteps').text, /Open Payroll/);
  // New terms to agree to.
  r = keasSteps({ account: me({ terms: { needsAgreement: true } }), orgs: [] });
  assert.equal(get(r, 'terms').action, 'termsAccept');
  // The Hub can't be asked about organizations right now.
  r = keasSteps({ account: me(), orgs: null, orgsError: 'offline' });
  assert.match(get(r, 'org').text, /offline/);
});

test('the Hub’s PC: folder, running, reachable, owner with two-step, start before sign-in (optional), updates', () => {
  const config = { setupDone: true, role: 'hub', dataDir: 'E:\\Kea Hub', publicUrl: null, ownerEmail: 'sam@example.org' };
  let r = keasSteps({ hub: true, config, hubRunning: false, lastStartError: 'port 4860 is in use', owner: { exists: true, owner: true, totp: true }, update: { status: 'ready', version: '0.5.0' }, account: me({ owner: true }), orgs: [] });
  assert.deepEqual(ids(r).slice(0, 6), ['hubFolder', 'hubRunning', 'reach', 'owner', 'boot', 'updates']);
  assert.match(get(r, 'hubRunning').text, /port 4860 is in use/);
  assert.equal(get(r, 'reach').action, 'reach');
  assert.equal(get(r, 'owner').done, true);
  assert.equal(get(r, 'boot').optional, true);
  assert.equal(get(r, 'updates').done, false);
  assert.equal(get(r, 'email').done, true, 'the owner counts as verified');
  r = keasSteps({ hub: true, config: { ...config, publicUrl: 'https://keas-hub.example.ts.net', boot: { installed: false } }, hubRunning: true, owner: { exists: true, owner: true, totp: true }, update: { status: 'latest' }, account: me({ owner: true }), orgs: [{ id: 'o', name: 'Kea', role: 'owner', status: 'active', state: 'CO' }], payroll: { initialized: true, summary: { year: 2026, steps: [] } } });
  assert.equal(r.allSet, true, 'start before sign-in is optional');
  // Not the Hub's PC (or setup not finished): no Hub steps.
  assert.ok(!ids(keasSteps({ hub: false, config, account: me(), orgs: [] })).includes('hubRunning'));
});

test('pay codes: for whoever runs the organization; done once codes exist and people have them', () => {
  const org = [{ id: 'o1', name: 'Camp', role: 'owner', status: 'active', state: 'CO' }];
  const base = { account: me(), orgs: org, payroll: { initialized: false } };
  assert.ok(!ids(keasSteps(base)).includes('payCodes'), 'only when KeaS could ask the organization');
  let r = keasSteps({ ...base, payCodes: { o1: { count: 0, given: 0 } } });
  assert.deepEqual(ids(r), ['account', 'email', 'org', 'orgApproved', 'orgPlace', 'payCodes', 'payroll']);
  assert.equal(get(r, 'payCodes').done, false);
  assert.match(get(r, 'payCodes').text, /Lifeguard, \$15/);
  r = keasSteps({ ...base, payCodes: { o1: { count: 2, given: 0 } } });
  assert.match(get(r, 'payCodes').text, /not given to anyone/);
  r = keasSteps({ ...base, payCodes: { o1: { count: 2, given: 5 } } });
  assert.equal(get(r, 'payCodes').done, true);
  r = keasSteps({ ...base, payCodes: { o1: { error: 'offline' } } });
  assert.match(get(r, 'payCodes').text, /offline/);
  // A member never sees it.
  r = keasSteps({ account: me(), orgs: [{ ...org[0], role: 'member' }], payCodes: {} });
  assert.ok(!ids(r).includes('payCodes'));
});
