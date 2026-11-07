// The Hub setup can be closed, restarted or stepped back through at any point and never gets stuck: it picks up where
// it stopped with what was already chosen, and the owner step notices an owner who already has two-step sign-in on
// (audit 2: 1.1 and 1.2). Runs a real Hub on a throwaway folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { codeAt, stepOf } from '../../hub/lib/totp.mjs';

const require = createRequire(import.meta.url);
const flow = require('../../desktop/flow.cjs');
const owner = require('../../desktop/owner.cjs');

test('setup resumes at the saved step, with the folder and reachability already chosen', () => {
  const defaults = { hubData: 'D:\\Kea Hub' };
  assert.equal(flow.resumeStep({}), 'welcome');
  assert.equal(flow.resumeStep({ setupDone: true, setupStep: 'boot' }), 'status');
  assert.equal(flow.resumeStep({ setupStep: 'boot', dataDir: 'E:\\Hub' }), 'boot');
  assert.equal(flow.resumeStep({ setupStep: 'owner' }), 'storage', 'no folder saved yet: back to choosing one');
  assert.equal(flow.resumeStep({ setupStep: 'nonsense', dataDir: 'E:\\Hub' }), 'welcome');
  const r = flow.resumeChoices({ setupStep: 'owner', dataDir: 'E:\\Hub', storageDir: 'E:\\Hub\\storage', quotaGb: 7, tailscale: false }, defaults);
  assert.deepEqual(r, { step: 'owner', dataDir: 'E:\\Hub', storageDir: '', quotaGb: 7, reach: 'local', needsHub: true });
  assert.equal(flow.resumeChoices({}, defaults).dataDir, 'D:\\Kea Hub');
  assert.equal(flow.resumeChoices({ dataDir: 'E:\\Hub', storageDir: 'F:\\Files', tailscale: true }, defaults).storageDir, 'F:\\Files');
  assert.equal(flow.resumeChoices({ dataDir: 'E:\\Hub', tailscale: true }, defaults).reach, 'tailscale');
  // Back never leaves the wizard.
  assert.equal(flow.stepBack('welcome'), 'welcome');
  assert.equal(flow.stepBack('boot'), 'owner');
  assert.equal(flow.stepNext('owner'), 'boot');
  assert.equal(flow.stepNext('done'), 'done');
});

test('the owner step: two-step on, then Back or a restart: the owner is noticed and setup moves on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-owner-'));
  let clock = Date.UTC(2026, 10, 7, 15);
  const hub = createHub({ dataDir: dir, now: () => clock, log: false });
  try {
    const { port } = await hub.listen({ port: 0, ownerPort: 0 });
    const call = owner.localCaller(`http://127.0.0.1:${port}`);
    const t = (await call('/v1/terms')).terms;
    const form = { name: 'Sam Owner', email: 'Sam@Example.org', password: 'correct horse battery staple', termsVersion: t.version, termsSections: t.sections.map((s) => s.id) };
    assert.equal(owner.ownerState(hub.h, null), null);
    assert.deepEqual(owner.ownerState(hub.h, 'sam@example.org'), { email: 'sam@example.org', exists: false, owner: false, totp: false });

    // First time: the account is made and made owner; two-step sign-in still has to be turned on.
    const first = await owner.createOwner({ db: hub.h, call, ...form });
    assert.equal(first.email, 'sam@example.org');
    assert.ok(first.totp?.secret && first.totp.uri.startsWith('otpauth://'));
    assert.equal(owner.ownerDone(owner.ownerState(hub.h, first.email)), false);

    // Cut off before turning it on (Back, or KeaS closed): the same form just gives a new key.
    const again = await owner.createOwner({ db: hub.h, call, ...form });
    assert.ok(again.totp?.secret && again.totp.secret !== first.totp.secret);
    const on = await call('/v1/me/totp/enable', { method: 'POST', body: JSON.stringify({ code: codeAt(again.totp.secret, stepOf(clock)) }) }, again.token);
    // (ok stays as it was; the ten backup codes come along for the setup page to show once.)
    assert.equal(on.ok, true);
    assert.equal(on.backupCodes.length, 10);

    // Now the step is done: a restart or Back shows "done" with Next instead of the form.
    const st = owner.ownerState(hub.h, 'sam@example.org');
    assert.deepEqual(st, { email: 'sam@example.org', exists: true, owner: true, totp: true });
    assert.equal(owner.ownerDone(st), true);

    // Sending the form again anyway: the Hub asks for a code (the page shows a code field), and with one it works.
    await assert.rejects(owner.createOwner({ db: hub.h, call, ...form }), (e) => e instanceof owner.HubError && e.status === 401 && e.data?.totpRequired === true);
    clock += 30_000;
    const withCode = await owner.createOwner({ db: hub.h, call, ...form, code: codeAt(again.totp.secret, stepOf(clock)) });
    assert.equal(withCode.totp, null, 'two-step sign-in is already on: nothing more to set up');
    assert.ok(withCode.token);
    // Without the phone: a backup code instead, once.
    const withBackup = await owner.createOwner({ db: hub.h, call, ...form, code: on.backupCodes[0] });
    assert.ok(withBackup.token);
    await assert.rejects(owner.createOwner({ db: hub.h, call, ...form, code: on.backupCodes[0] }), (e) => e.status === 401 && e.data?.totpRequired === true);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the owner step ends the account’s earlier sign-ins, and KeaS ends up signed in as the owner with two-step passed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-owner-'));
  let clock = Date.UTC(2026, 10, 7, 15);
  const hub = createHub({ dataDir: dir, now: () => clock, log: false });
  try {
    const { port } = await hub.listen({ port: 0, ownerPort: 0 });
    const call = owner.localCaller(`http://127.0.0.1:${port}`);
    const t = (await call('/v1/terms')).terms;
    const form = { name: 'Sam Owner', email: 'sam@example.org', password: 'correct horse battery staple', termsVersion: t.version, termsSections: t.sections.map((s) => s.id) };
    // The account already existed, signed in somewhere with the password alone.
    await call('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password, displayName: form.name, age13: true, termsVersion: t.version, termsSections: form.termsSections }) });
    const earlier = (await call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) })).token;
    // Setup as packaged KeaS runs it: owner:create, then owner:totp with the new key's code, then finish.
    const made = await owner.createOwner({ db: hub.h, call, ...form });
    await assert.rejects(call('/v1/me', {}, earlier), (e) => e.status === 401, 'the earlier sign-in ended');
    const on = await call('/v1/me/totp/enable', { method: 'POST', body: JSON.stringify({ code: codeAt(made.totp.secret, stepOf(clock)) }) }, made.token);
    assert.equal(on.ok, true);
    // KeaS keeps that sign-in (account().adopt): it passed two-step, so owner powers work with it.
    const me = await call('/v1/me', {}, made.token);
    assert.equal(me.account.owner, true);
    const cls = await call('/v1/classes', { method: 'POST', body: JSON.stringify({ title: 'Owner class' }) }, made.token);
    assert.ok(cls.class || cls.id || cls.code, JSON.stringify(cls));
    assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', hub.h.get('SELECT id FROM accounts WHERE email = ?', form.email).id).n, 1);
    // An owner who already has two-step on, setting up again with a code: the earlier sign-ins end, the new one passed.
    clock += 30_000;
    const again = await owner.createOwner({ db: hub.h, call, ...form, code: codeAt(made.totp.secret, stepOf(clock)) });
    await assert.rejects(call('/v1/me', {}, made.token), (e) => e.status === 401);
    await call('/v1/classes', { method: 'POST', body: JSON.stringify({ title: 'Owner class 2' }) }, again.token);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
