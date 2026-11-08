// Payroll with the KeaS app's own Kea sign-in: the app's KeaS session (made from a KeaC pass) gets a 15-minute
// "keas-payroll" token from the KeaS server on this PC (its owner console), signed with the server's identity key, and
// hands it to the vault in this process only, with the passphrase. The passphrase is kept in the app's memory for one
// run (desktop/passkeeper.cjs) and forgotten when the vault locks; it's never written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../org/helpers.mjs';
import { createApp } from '../../server/index.mjs';
import { loadOrCreateKey, signToken } from '../../hub/lib/tokens.mjs';

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
  const src = readFileSync(new URL('../../desktop/passkeeper.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(['"](fs|node:fs|electron)['"]\)/);
});

test('vault: set up and sign in with the KeaS server’s token for the app’s session; the passphrase opens it once per lock', async () => {
  const H = await startHub({ prefix: 'keas-vk-' });
  const dir = mkdtempSync(join(tmpdir(), 'keas-vk-pay-'));
  const locks = [];
  let vault;
  try {
    const pat = await H.person('pat@example.org', 'Pat');
    const grant = async (u = pat) => H.ok(await H.owner('POST', '/owner/payroll-token', { session: u.token })).token;
    const own = [{ kty: 'OKP', crv: 'Ed25519', x: H.hub.identityKey.jwk.x }];
    vault = createApp({ dbFile: join(dir, 'vault.db'), log: false, vault: true, setupToken: false, now: () => H.t.now, hubUrl: H.base, hubTrustKeys: () => own, serverIssuer: `keas:${H.hub.serverId}`, onVaultLock: (why) => locks.push(why) });
    const vbase = `http://127.0.0.1:${await vault.listen(0)}`;
    const k = vault.keas;
    assert.deepEqual([k.status().initialized, k.status().unlocked, k.status().ownHub], [false, false, true]);

    // A token that isn't this server's, or isn't one at all, is refused.
    await assert.rejects(k.setup({ hubToken: 'not.a.token', passphrase: PASS, org: { name: 'Camp', state: 'CO' } }), (e) => e.status === 401);
    const other = await startHub({ prefix: 'keas-vk-other-' });
    try {
      const o = await other.person('pat@example.org', 'Pat');
      const foreign = other.ok(await other.owner('POST', '/owner/payroll-token', { session: o.token })).token;
      await assert.rejects(k.setup({ hubToken: foreign, passphrase: PASS, org: { name: 'Camp', state: 'CO' } }), (e) => e.status === 401);
    } finally { await other.close(); }
    // No passwords over HTTP here: Kea accounts sign in at KeaC.
    const http1 = await fetch(`${vbase}/v1/vault/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS, org: { name: 'Camp', state: 'CO' }, admin: { name: 'Pat', email: 'pat@example.org' }, signIn: { mode: 'hub', password: PW } }) });
    assert.equal(http1.status, 410);
    const s = await k.setup({ hubToken: await grant(), passphrase: PASS, org: { name: 'Camp', state: 'CO', tz: 'America/Denver' } });
    assert.match(s.token, /^[0-9a-f]{64}$/);
    const me = await (await fetch(`${vbase}/v1/me`, { headers: { authorization: `Bearer ${s.token}` } })).json();
    assert.equal(me.person.name, 'Pat');

    vault.keas.lock('idle');
    assert.deepEqual(locks, ['idle']);
    assert.equal(k.status().unlocked, false);
    assert.equal(k.checkPassphrase({ email: 'pat@example.org', passphrase: PASS }), true);
    assert.throws(() => k.checkPassphrase({ email: 'pat@example.org', passphrase: 'nope nope nope' }), (e) => e.status === 401 && e.extra?.passphrase);
    assert.equal(k.status().unlocked, false);

    assert.throws(() => k.signIn({ hubToken: 'x.y.z', passphrase: PASS }), (e) => e.status === 401);
    const g = await grant();
    assert.throws(() => k.signIn({ hubToken: g, passphrase: 'wrong passphrase here' }), (e) => e.status === 401 && e.extra?.passphrase);
    assert.equal(k.status().unlocked, false, 'a wrong passphrase leaves it locked');
    const s2 = k.signIn({ hubToken: g, passphrase: PASS });
    assert.ok(s2.token);
    assert.equal(k.status().unlocked, true);
    assert.equal((await fetch(`${vbase}/v1/vault/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pat@example.org', password: PW, passphrase: PASS }) })).status, 410);

    const r = await fetch(`${vbase}/v1/vault/lock`, { method: 'POST', headers: { authorization: `Bearer ${s2.token}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(locks, ['idle', 'locked']);

    // Another Kea account on the same server isn't a payroll admin here; a revoked one gets no token at all.
    const sam = await H.person('sam@example.org', 'Sam');
    const samGrant = await grant(sam);
    assert.throws(() => k.signIn({ hubToken: samGrant, passphrase: PASS }), (e) => e.status === 403 && /isn’t a payroll admin/.test(e.message));
    H.keac.revoke(pat.id);
    await H.hub.keac.pollRevoked({ full: true });
    assert.equal((await H.owner('POST', '/owner/payroll-token', { session: pat.token })).status, 401);

    await vault.close(); vault = null;
    for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f)).includes(Buffer.from(PASS)), `${f} doesn't hold the passphrase`);
  } finally {
    await vault?.close();
    await H.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a vault set up with the Kea Hub on this PC moves to the KeaS server’s key by itself once the PC becomes one', async () => {
  const H = await startHub({ prefix: 'keas-vk-move-' });
  const dir = mkdtempSync(join(tmpdir(), 'keas-vk-move-pay-'));
  try {
    const hubKey = loadOrCreateKey(join(dir, 'old-hub.pem'));
    const pat = await H.person('pat@example.org', 'Pat');
    const t = () => Math.floor(H.t.now / 1000);
    const hubToken = () => signToken(hubKey, { iss: 'kea-hub', aud: 'keas-payroll', sub: pat.id, email: pat.email, name: 'Pat', ev: true, iat: t(), exp: t() + 600 });
    // Set up while this PC was the Kea Hub: tokens from the Hub's key, issuer 'kea-hub'.
    let v = createApp({ dbFile: join(dir, 'vault.db'), log: false, vault: true, setupToken: false, now: () => H.t.now, hubUrl: H.base, hubTrustKeys: () => [{ kty: 'OKP', crv: 'Ed25519', x: hubKey.jwk.x }] });
    await v.keas.setup({ hubToken: hubToken(), passphrase: PASS, org: { name: 'Camp', state: 'CO' } });
    await v.close();
    // Now a KeaS server: its own key and issuer, from the app.
    v = createApp({ dbFile: join(dir, 'vault.db'), log: false, vault: true, setupToken: false, now: () => H.t.now, hubUrl: H.base, hubTrustKeys: () => [{ kty: 'OKP', crv: 'Ed25519', x: H.hub.identityKey.jwk.x }], serverIssuer: `keas:${H.hub.serverId}` });
    try {
      const g = H.ok(await H.owner('POST', '/owner/payroll-token', { session: pat.token })).token;
      assert.ok(v.keas.signIn({ hubToken: g, passphrase: PASS }).token);
      v.keas.lock('locked');
      assert.throws(() => v.keas.signIn({ hubToken: hubToken(), passphrase: PASS }), (e) => e.status === 401, 'the old Hub’s tokens don’t open it any more');
    } finally { await v.close(); }
  } finally { await H.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('vault sign-in over HTTP: a used-up two-step code says so (not "wrong password")', async () => {
  // (For a vault still paired with a Kea Hub; vault.test.mjs's fake Hub covers the rest.)
  const { makeHubClient, HubRefused } = await import('../../server/payroll/hub.mjs');
  const client = makeHubClient({ fetchImpl: async () => new Response(JSON.stringify({ error: 'That code is wrong or already used.', totpRequired: true }), { status: 401, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.fetchKeys('http://127.0.0.1:1'), (e) => e instanceof HubRefused && e.extra?.totpRequired === true);
});
