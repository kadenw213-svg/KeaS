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
    await call('/v1/me/totp/enable', { method: 'POST', body: JSON.stringify({ code: codeAt(again.totp.secret, stepOf(clock)) }) }, again.token);

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
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
