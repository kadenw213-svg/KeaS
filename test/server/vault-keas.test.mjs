// Payroll with the KeaS app's own Kea sign-in: the app hands the vault a short-lived "keas-payroll" token from the Hub
// it's signed in to, in this process only, so the email and password aren't asked again. The passphrase is kept in
// the app's memory for one run (desktop/passkeeper.cjs) and forgotten when the vault locks; it's never written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { createApp } from '../../server/index.mjs';

const require = createRequire(import.meta.url);
const { createPassKeeper } = require('../../desktop/passkeeper.cjs');
const PASS = 'orchard ledger quiet harbor';
const PW = 'correct horse battery staple';

test('the passphrase keeper: memory only, forgotten on lock, sign-out, and after Payroll has been closed a while', () => {
  const timers = [];
  const keeper = createPassKeeper({ setTimer: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: (t) => { t.on = false; } });
  assert.equal(keeper.has(), false);
  keeper.remember(PASS);
  assert.equal(keeper.get(), PASS);
  // Payroll closed: forgotten after the vault's quiet-spell time, unless it's opened again first.
  keeper.idle(15 * 60_000);
  assert.equal(timers.at(-1).ms, 15 * 60_000);
  keeper.active();
  assert.equal(timers.at(-1).on, false);
  keeper.idle(60_000);
  timers.at(-1).fn();
  assert.equal(keeper.has(), false, 'forgotten after the quiet spell');
  keeper.remember(PASS);
  keeper.forget();
  assert.equal(keeper.get(), null);
  // The keeper module can't write anything anywhere.
  const src = readFileSync(new URL('../../desktop/passkeeper.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(['"](fs|node:fs|electron)['"]\)/);
});

test('vault: set up and sign in with the KeaS app’s Kea sign-in; the passphrase opens it once per lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-vk-'));
  const hub = createHub({ dataDir: join(dir, 'hub'), log: false });
  let locks = [];
  let vault;
  try {
    const { port } = await hub.listen({ port: 0, ownerPort: 0 });
    const base = `http://127.0.0.1:${port}`;
    const j = async (p, body, token) => (await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
    const t = (await j('/v1/terms')).terms;
    await j('/v1/auth/register', { email: 'pat@example.org', password: PW, displayName: 'Pat', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) });
    const session = (await j('/v1/auth/login', { email: 'pat@example.org', password: PW })).token;
    const grant = async () => (await j('/v1/auth/token', { aud: 'keas-payroll' }, session)).token;

    vault = createApp({ dbFile: join(dir, 'payroll', 'vault.db'), log: false, vault: true, setupToken: false, hubUrl: base, onVaultLock: (why) => locks.push(why) });
    const vbase = `http://127.0.0.1:${await vault.listen(0)}`;
    const k = vault.keas;
    assert.deepEqual([k.status().initialized, k.status().unlocked], [false, false]);

    // An email nobody has verified can't run payroll yet: the message says how to fix that.
    await assert.rejects(k.setup({ hubToken: await grant(), passphrase: PASS, org: { name: 'Camp', state: 'CO', tz: 'America/Denver' } }), (e) => e.status === 403 && /Verify your email/.test(e.message));
    assert.equal(k.status().initialized, false);
    hub.h.run('UPDATE accounts SET email_verified = 1 WHERE email = ?', 'pat@example.org');

    // A token that isn't from the trusted Hub, or for something else, is refused.
    await assert.rejects(k.setup({ hubToken: 'not.a.token', passphrase: PASS, org: { name: 'Camp', state: 'CO' } }), (e) => e.status === 401);
    const s = await k.setup({ hubToken: await grant(), passphrase: PASS, org: { name: 'Camp', state: 'CO', tz: 'America/Denver' } });
    assert.match(s.token, /^[0-9a-f]{64}$/);
    // The session works for the payroll page (the app puts it in the window's cookie).
    const me = await (await fetch(`${vbase}/v1/me`, { headers: { authorization: `Bearer ${s.token}` } })).json();
    assert.equal(me.person.name, 'Pat');

    // Locked (a quiet spell): the app is told, so it forgets the passphrase it kept.
    vault.keas.lock('idle');
    assert.deepEqual(locks, ['idle']);
    assert.equal(k.status().unlocked, false);

    // The passphrase check before the two-step code: right or wrong, it never unlocks anything.
    assert.equal(k.checkPassphrase({ email: 'pat@example.org', passphrase: PASS }), true);
    assert.throws(() => k.checkPassphrase({ email: 'pat@example.org', passphrase: 'nope nope nope' }), (e) => e.status === 401 && e.extra?.passphrase);
    assert.equal(k.status().unlocked, false);

    // Sign in again with a fresh grant and the passphrase.
    assert.throws(() => k.signIn({ hubToken: 'x.y.z', passphrase: PASS }), (e) => e.status === 401);
    const g = await grant();
    assert.throws(() => k.signIn({ hubToken: g, passphrase: 'wrong passphrase here' }), (e) => e.status === 401 && e.extra?.passphrase);
    assert.equal(k.status().unlocked, false, 'a wrong passphrase leaves it locked');
    const s2 = k.signIn({ hubToken: g, passphrase: PASS });
    assert.ok(s2.token);
    assert.equal(k.status().unlocked, true);

    // Lock from the page: the app hears about that too.
    const r = await fetch(`${vbase}/v1/vault/lock`, { method: 'POST', headers: { authorization: `Bearer ${s2.token}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(locks, ['idle', 'locked']);

    // Another Kea account on the same Hub isn't a payroll admin here.
    await j('/v1/auth/register', { email: 'sam@example.org', password: PW, displayName: 'Sam', age13: true, termsVersion: t.version, termsSections: t.sections.map((x) => x.id) });
    hub.h.run('UPDATE accounts SET email_verified = 1 WHERE email = ?', 'sam@example.org');
    const sam = (await j('/v1/auth/login', { email: 'sam@example.org', password: PW })).token;
    const samGrant = (await j('/v1/auth/token', { aud: 'keas-payroll' }, sam)).token;
    assert.throws(() => k.signIn({ hubToken: samGrant, passphrase: PASS }), (e) => e.status === 403 && /isn’t a payroll admin/.test(e.message));

    // None of this put the passphrase on disk.
    await vault.close(); vault = null;
    for (const f of readdirSync(join(dir, 'payroll'))) assert.ok(!readFileSync(join(dir, 'payroll', f)).includes(Buffer.from(PASS)), `${f} doesn't hold the passphrase`);
  } finally {
    await vault?.close();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault sign-in over HTTP: a used-up two-step code says so (not "wrong password")', async () => {
  // (The fake Hub in vault.test.mjs covers the rest; this one only needs the Hub's answer to pass through.)
  const { makeHubClient, HubRefused } = await import('../../server/payroll/hub.mjs');
  const client = makeHubClient({ fetchImpl: async () => new Response(JSON.stringify({ error: 'That code is wrong or already used.', totpRequired: true }), { status: 401, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.fetchKeys('http://127.0.0.1:1'), (e) => e instanceof HubRefused && e.extra?.totpRequired === true);
});
