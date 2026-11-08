// KeaS opens with "Sign in to Kea" for everyone; the Hub's setup is there only with --host-hub or on a PC that already
// runs a Hub. The sign-in is the same Kea account (the Hub's /v1/auth routes), remembered encrypted between runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { codeAt, stepOf } from '../../hub/lib/totp.mjs';

const require = createRequire(import.meta.url);
const flow = require('../../desktop/flow.cjs');
const { createAccount, checkUrl, DEFAULT_HUB_URL } = require('../../desktop/account.cjs');

test('--host-hub: Hub setup only with the switch, or on a PC that already runs a Hub', () => {
  assert.equal(flow.hubMode({ argv: ['KeaS.exe'], config: {} }), false);
  assert.equal(flow.hubMode({ argv: ['KeaS.exe', '--host-hub'], config: {} }), true);
  assert.equal(flow.hubMode({ argv: ['KeaS.exe'], config: { role: 'hub', setupDone: true } }), true);
  // A Hub setup that was started but never finished doesn't show itself without the switch.
  assert.equal(flow.hubMode({ argv: ['KeaS.exe'], config: { role: 'hub', setupStep: 'owner', dataDir: 'E:\\Hub' } }), false);
  assert.equal(flow.hubMode({ argv: ['KeaS.exe', '--hidden'], config: { role: 'hub' } }), false);

  assert.equal(flow.firstView({ hub: false, config: {}, signedIn: false }), 'signin');
  assert.equal(flow.firstView({ hub: false, config: {}, signedIn: true }), 'home');
  assert.equal(flow.firstView({ hub: false, config: { role: 'hub', setupStep: 'owner', dataDir: 'E:\\Hub' }, signedIn: false }), 'signin');
  assert.equal(flow.firstView({ hub: true, config: {}, signedIn: false }), 'welcome');
  assert.equal(flow.firstView({ hub: true, config: { setupStep: 'boot', dataDir: 'E:\\Hub' }, signedIn: true }), 'boot');
  assert.equal(flow.firstView({ hub: true, config: { role: 'hub', setupDone: true }, signedIn: false }), 'status');

  // Starting with Windows: off for everyone unless chosen; a Hub set up before keeps it on.
  assert.equal(flow.startWithWindows({}), false);
  assert.equal(flow.startWithWindows({ role: 'hub', setupDone: true }), true);
  assert.equal(flow.startWithWindows({ role: 'hub', setupDone: true, startWithWindows: false }), false);
  assert.equal(flow.startWithWindows({ startWithWindows: true }), true);
});

test('every Hub setup call in the app is refused outside hub mode', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  for (const name of ['saveSetup', 'start', 'checkFolder', 'drives', 'pickFolder', 'boot:apply', 'boot:remove', 'boot:status', 'ts:install', 'ts:login', 'ts:funnel', 'ts:funnelOff', 'ts:status', 'owner:create', 'owner:totp', 'owner:state', 'setupStep', 'finish', 'terms']) {
    assert.match(main, new RegExp(`hubHandle\\('${name}'`), `${name} is hub-only`);
    assert.doesNotMatch(main, new RegExp(`[^b]handle\\('${name}'`), `${name} isn't also registered for everyone`);
  }
  assert.match(main, /if \(!hubMode\(\)\) throw/);
  // The switch is mentioned for developers only, never on a screen.
  const page = readFileSync(new URL('../../desktop/setup/setup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /host-hub/);
});

test('the Hub address: https anywhere, plain http only to this computer', () => {
  assert.equal(checkUrl(''), null);
  assert.equal(checkUrl('hub.example.ts.net'), 'https://hub.example.ts.net');
  assert.equal(checkUrl('http://127.0.0.1:48860/'), 'http://127.0.0.1:48860');
  assert.equal(checkUrl('http://localhost:4860'), 'http://localhost:4860');
  assert.throws(() => checkUrl('http://hub.example.org'), /https/);
  assert.throws(() => checkUrl('ftp://hub.example.org'), /https/);
  assert.throws(() => checkUrl('https://me:pw@hub.example.org'), /user name/);
});

/** Encrypting the way safeStorage does, as far as the test can tell: never the plain token on disk. */
const fakeProtect = () => ({ available: () => true, encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b) => Buffer.from(String(b).slice(4), 'base64').toString() });

test('sign in, create an account, two-step code, stay signed in, sign out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-acct-'));
  let clock = Date.UTC(2026, 10, 7, 15);
  const hub = createHub({ dataDir: join(dir, 'hub'), now: () => clock, log: false });
  try {
    const { port } = await hub.listen({ port: 0, ownerPort: 0 });
    let hubUrl = null;
    const make = () => createAccount({ dir: join(dir, 'profile'), protect: fakeProtect(), getUrl: () => hubUrl, setUrl: (u) => (hubUrl = u) });
    let a = make();
    assert.equal(a.url(), DEFAULT_HUB_URL);
    await a.changeUrl(`http://127.0.0.1:${port}`);
    let st = await a.status();
    assert.deepEqual([st.signedIn, st.reachable], [false, true]);

    // Create an account: the terms, then signed in at once.
    const t = (await a.terms()).terms;
    st = await a.register({ name: 'Riley', email: 'riley@example.org', password: 'correct horse battery staple', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) });
    assert.equal(st.signedIn, true);
    assert.equal(st.account.email, 'riley@example.org');
    const file = readFileSync(join(dir, 'profile', 'hub-session.bin'), 'utf8');
    assert.match(file, /^enc:/, 'the session is kept encrypted');

    // A later run: still signed in, nothing asked.
    a = make();
    assert.equal(a.signedIn(), true);
    st = await a.status();
    assert.equal(st.signedIn, true);
    assert.ok(await a.payrollToken(), 'payroll gets a token from the remembered sign-in');

    // Two-step sign-in on: the password alone is answered with "code needed", then the code signs in.
    const login = await (await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'riley@example.org', password: 'correct horse battery staple' }) })).json();
    const setup = await (await fetch(`http://127.0.0.1:${port}/v1/me/totp/setup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ password: 'correct horse battery staple' }) })).json();
    assert.ok(setup.uri.startsWith('otpauth://'));
    await fetch(`http://127.0.0.1:${port}/v1/me/totp/enable`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ code: codeAt(setup.secret, stepOf(clock)) }) });
    await a.logout();
    assert.equal(existsSync(join(dir, 'profile', 'hub-session.bin')), false, 'signing out forgets the session');
    await assert.rejects(a.login({ email: 'riley@example.org', password: 'correct horse battery staple' }), (e) => e.status === 401 && e.data?.totpRequired === true);
    clock += 30_000;
    st = await a.login({ email: 'riley@example.org', password: 'correct horse battery staple', code: codeAt(setup.secret, stepOf(clock)) });
    assert.equal(st.signedIn, true);
    assert.equal(st.account.totpEnabled, true);

    // "Ask for my sign-in every time": a fresh sign-in with the password and code, ended right after.
    await assert.rejects(a.freshPayrollToken({ password: 'correct horse battery staple' }), (e) => e.data?.totpRequired === true);
    clock += 30_000;
    assert.ok(await a.freshPayrollToken({ password: 'correct horse battery staple', code: codeAt(setup.secret, stepOf(clock)) }));
    await assert.rejects(a.freshPayrollToken({ password: 'wrong password entirely' }), (e) => e.status === 401 && !e.data?.totpRequired);
    assert.equal(a.signedIn(), true, 'the remembered sign-in stays');

    // Another Hub address: the sign-in belongs to the old one, so it goes.
    st = await a.changeUrl('https://other-hub.example.ts.net');
    assert.equal(a.signedIn(), false);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('people asking to join, verifying their email, and new backup codes, from KeaS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-people-'));
  let clock = Date.UTC(2026, 10, 7, 15);
  const hub = createHub({ dataDir: join(dir, 'hub'), now: () => clock, log: false });
  try {
    const { port, ownerPort } = await hub.listen({ port: 0, ownerPort: 0 });
    const url = `http://127.0.0.1:${port}`;
    const { ownerFetch } = await import('../../hub/lib/ownerauth.mjs');
    const make = (name) => { let u = url; return createAccount({ dir: join(dir, name), protect: fakeProtect(), getUrl: () => u, setUrl: (x) => (u = x) }); };
    const t = (await make('x').terms()).terms;
    const reg = async (name, email) => { const a = make(name); await a.register({ name, email, password: 'correct horse battery staple', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }); return a; };
    const boss = await reg('boss', 'boss@camp.org');
    const sam = await reg('sam', 'sam@school.edu');
    const bossId = hub.h.get('SELECT id FROM accounts WHERE email = ?', 'boss@camp.org').id;
    await ownerFetch(`http://127.0.0.1:${ownerPort}`, hub.ownerKey, 'POST', `/owner/accounts/${bossId}`, { emailVerified: true });
    await ownerFetch(`http://127.0.0.1:${ownerPort}`, hub.ownerKey, 'POST', '/owner/orgs/settings', { autoApprove: true });
    const org = (await boss.createOrg({ name: 'Camp', state: 'CO' })).org;
    const bossLogin = await (await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@camp.org', password: 'correct horse battery staple' }) })).json();
    const made = await (await fetch(`${url}/v1/orgs/${org.id}/codes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bossLogin.token}` }, body: JSON.stringify({ role: 'member', needsApproval: false }) })).json();
    const code = made.code.code;

    // Sam's email isn't verified: joining is a request, and the checklist says so.
    const j = await sam.joinOrg({ code });
    assert.deepEqual([j.pending, j.emailVerified], [true, false]);
    const { keasSteps } = require('../../desktop/checklist.cjs');
    const steps = keasSteps({ account: await sam.status(), orgs: await sam.orgs() });
    assert.match(steps.steps.find((s) => s.id === 'org').text, /Request sent to Camp\. Your manager approves it/);

    // The boss sees it, verifies the email, approves.
    let people = await boss.orgPeople();
    assert.deepEqual(people.map((g) => [g.org.name, g.pending.map((m) => [m.email, m.emailVerified])]), [['Camp', [['sam@school.edu', false]]]]);
    const samId = people[0].pending[0].id;
    assert.equal((await boss.orgVerifyEmail({ id: org.id, accountId: samId })).verifiedBy, 'Manager');
    await boss.orgApprove({ id: org.id, accountId: samId, approve: true });
    people = await boss.orgPeople();
    assert.deepEqual([people[0].pending.length, people[0].unverified.length], [0, 0]);
    assert.equal((await sam.status()).account.emailVerified, true);

    // Pay codes, for the checklist and payroll: how many the organization has, and the pay feed payroll reads.
    assert.deepEqual(await boss.orgPayCodes({ id: org.id }), { count: 0, given: 0 });
    const pcAuth = { 'content-type': 'application/json', authorization: 'Bearer ' + bossLogin.token };
    const pc = await (await fetch(url + '/v1/orgs/' + org.id + '/pay-codes', { method: 'POST', headers: pcAuth, body: JSON.stringify({ name: 'Lifeguard', rate: 15 }) })).json();
    await fetch(url + '/v1/orgs/' + org.id + '/members/' + samId + '/pay-codes', { method: 'POST', headers: pcAuth, body: JSON.stringify({ codeId: pc.code.id }) });
    assert.deepEqual(await boss.orgPayCodes({ id: org.id }), { count: 1, given: 1 });
    const feed = await boss.orgPayFeed({ id: org.id, from: '2026-12-01', to: '2026-12-14' });
    assert.deepEqual([feed.v, feed.codes[0].rateCents, feed.people.find((p) => p.accountId === samId).defaultCodeId], [1, 1500, pc.code.id]);
    await assert.rejects(sam.orgPayFeed({ id: org.id, from: '2026-12-01', to: '2026-12-14' }), (e) => e.status === 403);

    // Backup codes: with two-step sign-in on, the password and the app's code make new ones.
    const login = await (await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@school.edu', password: 'correct horse battery staple' }) })).json();
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
    const setup = await (await fetch(`${url}/v1/me/totp/setup`, { method: 'POST', headers: auth, body: JSON.stringify({ password: 'correct horse battery staple' }) })).json();
    await fetch(`${url}/v1/me/totp/enable`, { method: 'POST', headers: auth, body: JSON.stringify({ code: codeAt(setup.secret, stepOf(clock)) }) });
    clock += 30_000;
    // Turning two-step on (from another sign-in) ended KeaS's sign-in, which never passed it: KeaS signs in again with a code.
    assert.equal((await sam.status()).signedIn, false);
    await sam.login({ email: 'sam@school.edu', password: 'correct horse battery staple', code: codeAt(setup.secret, stepOf(clock)) });
    clock += 30_000;
    await assert.rejects(sam.backupCodes({ password: 'correct horse battery staple', code: '000000' }), (e) => e.status === 401);
    assert.equal(sam.signedIn(), true, 'a wrong code there doesn’t sign KeaS out');
    const r = await sam.backupCodes({ password: 'correct horse battery staple', code: codeAt(setup.secret, stepOf(clock)) });
    assert.equal(r.backupCodes.length, 10);
    assert.equal((await sam.status()).account.backupCodesLeft, 10);
    // A backup code signs KeaS in.
    await sam.logout();
    const st = await sam.login({ email: 'sam@school.edu', password: 'correct horse battery staple', code: r.backupCodes[0] });
    assert.equal(st.signedIn, true);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('against an older Kea Hub without these routes: a plain message', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const a = createAccount({ dir: mkdtempSync(join(tmpdir(), 'keas-old-')), protect: fakeProtect(), getUrl: () => 'http://127.0.0.1:1', setUrl: () => {}, fetchImpl: fakeFetch });
  await assert.rejects(a.orgVerifyEmail({ id: 'o', accountId: 'x' }), /can’t verify emails yet/);
  await assert.rejects(a.backupCodes({ password: 'p', code: '123456' }), /doesn’t have backup codes yet/);
});
