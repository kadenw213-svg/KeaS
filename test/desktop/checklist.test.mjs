// The KeaS window's "Get set up" steps (desktop/checklist.cjs): the server's steps and Payroll's own in one list, what
// each checks, and when the list is all set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keasSteps } = require('../../desktop/checklist.cjs');
const ids = (r) => r.steps.map((s) => s.id);
const get = (r, id) => r.steps.find((s) => s.id === id);
const base = { config: { dataDir: 'D:\\KeaS', publicUrl: 'https://pool.tail.ts.net' }, running: true, keac: { url: 'https://keac.example.net', trusted: 1 } };
const me = { signedIn: true, reachable: true, account: { email: 'pat@example.org' } };

test('a Kea Hub whose accounts haven’t moved: the move is the step, nothing about KeaC yet', () => {
  const r = keasSteps({ ...base, legacy: true });
  assert.deepEqual(ids(r), ['folder', 'running', 'move', 'updates']);
  assert.match(get(r, 'move').text, /Your Kea accounts are still here\. Move them to your Kea account server/);
  assert.equal(r.allSet, false);
});

test('a fresh server: trust KeaC, sign in, claim with the setup code, then the organization', () => {
  let r = keasSteps({ config: { dataDir: 'D:\\KeaS' }, running: true, keac: { url: null, trusted: 0 }, account: { signedIn: false } });
  assert.deepEqual(ids(r), ['folder', 'running', 'keac', 'account', 'server', 'reach', 'updates']);
  assert.deepEqual([get(r, 'keac').done, get(r, 'account').action, get(r, 'server').action], [false, 'signin', 'claim']);
  r = keasSteps({ ...base, account: me, server: { claimed: true, signedIn: false } });
  assert.equal(get(r, 'server').action, 'serverSignIn');
  r = keasSteps({ ...base, account: me, server: { claimed: true, signedIn: true, operator: true }, orgs: [] });
  assert.deepEqual([get(r, 'org').done, get(r, 'org').action], [false, 'org']);
  r = keasSteps({ ...base, account: me, server: { claimed: true, signedIn: true }, orgs: [{ id: 'o1', name: 'Pool', role: 'owner', status: 'active', memberStatus: 'active', state: null }], payCodes: { o1: { count: 0, given: 0 } } });
  assert.deepEqual([get(r, 'orgPlace').done, get(r, 'payCodes').done, get(r, 'payroll').done], [false, false, false]);
});

test('Payroll’s own steps come in one by one; the unverified tax tables wait without holding the list open', () => {
  const r = keasSteps({
    ...base, account: me, server: { claimed: true, signedIn: true },
    orgs: [{ id: 'o1', name: 'Pool', role: 'owner', status: 'active', memberStatus: 'active', state: 'CO', tz: 'America/Denver' }], payCodes: { o1: { count: 2, given: 3 } },
    payroll: { initialized: true, summary: { year: 2026, steps: [{ id: 'org', title: 'Organization details', done: true }, { id: 'verified', title: 'Tax tables', done: false, blocking: true }, { id: 'employer', title: 'Employer details', done: false }, { id: 'sickLeave', title: 'Paid sick leave policy', done: false, optional: true }] } },
  });
  assert.deepEqual(ids(r).filter((x) => x.startsWith('payroll')), ['payroll', 'payroll.org', 'payroll.verified', 'payroll.employer', 'payroll.sickLeave']);
  assert.equal(get(r, 'payroll.verified').waiting, true);
  assert.equal(get(r, 'payroll.employer').action, 'payroll');
  assert.deepEqual([r.left, r.allSet], [1, false], 'only the employer details are left');
  assert.equal(r.org.state, 'CO');
});

test('everything done: all set (start before sign-in is optional)', () => {
  const r = keasSteps({
    ...base, account: me, server: { claimed: true, signedIn: true },
    orgs: [{ id: 'o1', name: 'Pool', role: 'admin', status: 'active', memberStatus: 'active', state: 'CO', tz: 'America/Denver' }], payCodes: { o1: { count: 1, given: 1 } },
    payroll: { initialized: true, summary: { year: 2026, steps: [{ id: 'org', title: 'Organization details', done: true }] } },
  });
  assert.equal(get(r, 'boot').optional, true);
  assert.equal(r.allSet, true);
  assert.equal(get(r, 'org').text, 'Pool (you’re an admin).');
});

test('"KeaS is up to date" is not done while updates are stuck, and says why', () => {
  const stuck = { status: 'error', info: { problem: { kind: 'failing', text: 'KeaS can’t check for updates: 4 failed checks in a row.' } } };
  const s = get(keasSteps({ ...base, update: stuck }), 'updates');
  assert.equal(s.done, false);
  assert.match(s.detail ?? s.text ?? JSON.stringify(s), /4 failed checks in a row/);
  assert.equal(get(keasSteps({ ...base, update: { status: 'latest', info: { problem: null } } }), 'updates').done, true);
});
