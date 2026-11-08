// The KeaS app's sign-in, end to end with a fake KeaC, a stand-in Google (test/helpers/idp.mjs: the system browser's
// round trip, loopback + PKCE) and a real KeaS server: trusting KeaC's key by its fingerprint, signing in to the Kea
// account with Google (no password; only the owner's account asks for its two-step code, sent with the same sign-in),
// setting up the server with its setup code and a pass, the organization, the payroll vault's token (and the "ask
// every time" one, a fresh Google sign-in), and what's kept on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { verifyToken } from '../../hub/lib/tokens.mjs';
import { fakeKeac } from '../helpers/keac.mjs';
import { fakeIdp } from '../helpers/idp.mjs';

const require = createRequire(import.meta.url);
const { createAccount, checkUrl } = require('../../desktop/account.cjs');
const { createKeasLink } = require('../../desktop/keas.cjs');
const oauth = require('../../desktop/oauth.cjs');
/** KeaS's idTokenFor, with the stand-in Google in place of the real one (the "browser" follows the redirect). */
const viaIdp = (idp, seen = []) => (provider, loginHint) => oauth.idToken({ provider, clientId: idp.clientId, loginHint, authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, open: async (u) => { seen.push(new URL(u)); await idp.open(u); } });
// Windows encryption, played by a reversible stand-in (the test checks nothing is written in the clear).
const protect = { available: () => true, encrypt: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString() };

test('KeaC addresses: https anywhere, plain http only on this PC', () => {
  assert.equal(checkUrl('keac.tail.ts.net'), 'https://keac.tail.ts.net');
  assert.equal(checkUrl('http://127.0.0.1:4870/'), 'http://127.0.0.1:4870');
  assert.throws(() => checkUrl('http://keac.example.net'), /https/);
  assert.throws(() => checkUrl('https://u:p@keac.example.net'), /user name/);
  assert.equal(checkUrl(''), null);
});

test('setting up: KeaC’s key trusted by fingerprint, the Kea account, the server claimed, the organization, payroll’s token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-app-'));
  const idp = await fakeIdp();
  const keac = await fakeKeac({ idp });
  // (Pat is the Kea account server owner's account here, the one account that still has a two-step code.)
  keac.addAccount({ id: 'acct-pat', email: 'pat@pool.org', name: 'Pat', code: '424242' });
  const hub = createHub({ dataDir: join(dir, 'data'), log: false, minFreeBytes: 0 });
  try {
    const p = await hub.listen({ port: 0, ownerPort: 0 });
    const base = `http://127.0.0.1:${p.port}`;
    const owner = async (m, path, body) => { const r = await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, hub.ownerKey, m, path, body); return { status: r.status, body: await r.json() }; };
    let url = null;
    const opened = [];
    const account = createAccount({ dir: join(dir, 'app'), protect, getUrl: () => url, setUrl: (u) => (url = u), idTokenFor: viaIdp(idp, opened) });
    const link = createKeasLink({ dir: join(dir, 'app'), protect, base: () => base, owner, serverId: async () => hub.serverId, account });

    // KeaC's key: shown with its fingerprint, trusted only with the right one.
    const offer = (await owner('GET', `/owner/keac/offer?url=${encodeURIComponent(keac.url)}`)).body;
    assert.equal(offer.keys[0].kid, keac.key.kid);
    assert.equal((await owner('POST', '/owner/keac/pin', { url: keac.url, kid: offer.keys[0].kid, fingerprint: 'AAAA' })).status, 409);
    assert.equal((await owner('POST', '/owner/keac/pin', { url: keac.url, kid: offer.keys[0].kid, fingerprint: offer.keys[0].fingerprint })).status, 200);
    await account.changeUrl(keac.url);

    // The Kea account: Continue with Google in the browser (PKCE, back to a one-time listener on this PC), then the
    // owner's code with the same sign-in. Only KeaC ever sees the ID token. No password anywhere.
    assert.equal(account.login, undefined, 'no password sign-in');
    await assert.rejects(account.oauth({ provider: 'google' }), (e) => e.status === 401 && e.data?.totpRequired);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].searchParams.get('code_challenge_method'), 'S256');
    assert.match(opened[0].searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(opened[0].searchParams.get('scope'), 'openid email profile');
    await assert.rejects(account.continueSignIn({ code: '000000' }), (e) => e.data?.totpRequired);
    const st = await account.continueSignIn({ code: '424242' });
    assert.deepEqual([st.signedIn, st.account.email], [true, 'pat@pool.org']);
    assert.equal(opened.length, 1, 'one trip to the browser for all three tries');
    assert.ok(idp.st.calls.includes('POST /token'));
    assert.ok(!keac.st.calls.some((c) => c.includes(base)), 'nothing about the server’s address went to KeaC');
    assert.ok(!keac.st.calls.some((c) => c.startsWith('POST /v1/auth/login')), 'no password sign-in was tried');

    // Setting up the server: its setup code (on this PC only) and a pass.
    await assert.rejects(link.claim('AAAA-BBBB-CCCC'), (e) => e.status === 403);
    const me = await link.claim(hub.setupSecret);
    assert.deepEqual([me.id, me.operator], ['acct-pat', true]);
    const org = (await link.createOrg({ name: 'Westside Pool', state: 'CO', tz: 'America/Denver' })).org;
    assert.deepEqual([org.status, org.role], ['active', 'owner']);
    await link.updateOrg({ id: org.id, settings: { clock: { periodDays: 7 } } });
    assert.equal((await link.orgs())[0].name, 'Westside Pool');
    assert.deepEqual(await link.orgPayCodes({ id: org.id }), { count: 0, given: 0 });

    // Payroll's token: this server's, for this session, 15 minutes.
    const t = await link.payrollToken();
    const pl = verifyToken(hub.identityKey.publicKey, t, { aud: 'keas-payroll', iss: `keas:${hub.serverId}` });
    assert.deepEqual([pl.sub, pl.email], ['acct-pat', 'pat@pool.org']);
    // "Ask every time": a fresh Google sign-in (the owner's code last, with the same sign-in), its own short session,
    // then ended.
    const sessionsBefore = hub.h.get('SELECT COUNT(*) AS n FROM keas_sessions').n;
    await assert.rejects(link.freshPayrollToken({ provider: 'google' }), (e) => e.data?.totpRequired);
    const t2 = await link.freshPayrollToken({ provider: 'google', code: '424242' });
    assert.equal(verifyToken(hub.identityKey.publicKey, t2, { aud: 'keas-payroll', iss: `keas:${hub.serverId}` }).sub, 'acct-pat');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM keas_sessions').n, sessionsBefore, 'its session ended');

    // A session the server ended is made again from a pass by itself.
    hub.h.run('DELETE FROM keas_sessions');
    assert.equal((await link.orgs()).length, 1);
    // Nothing secret is kept in the clear.
    for (const f of readdirSync(join(dir, 'app'))) {
      const b = readFileSync(join(dir, 'app', f), 'utf8');
      assert.ok(!b.includes(link.session().token) && !b.includes('eyJ'), f);
    }
    // Signing out of the Kea account here ends KeaC's session.
    await account.logout();
    assert.equal(account.signedIn(), false);
    assert.equal(keac.st.sessions.size, 0);
  } finally { await hub.close(); await keac.close(); await idp.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an operator with no two-step code signs in with one Google sign-in; another email, no account and no client id are said plainly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-app-google-'));
  const idp = await fakeIdp();
  const keac = await fakeKeac({ idp });
  keac.addAccount({ id: 'acct-lee', email: 'lee@pool.org', name: 'Lee' });
  try {
    // No client id in this KeaS: a plain sentence, nothing opened.
    const none = createAccount({ dir: join(dir, 'none'), protect, getUrl: () => keac.url });
    await assert.rejects(none.oauth({ provider: 'google' }), (e) => e.status === 503 && e.data?.notSetUp);
    await assert.rejects(oauth.idToken({ provider: 'microsoft', clientId: '', open: async () => {} }), /isn’t set up/);
    const account = createAccount({ dir: join(dir, 'app'), protect, getUrl: () => keac.url, idTokenFor: viaIdp(idp) });
    // An email with no Kea account: made in the Kea app (which shows the terms).
    idp.st.as = 'nobody@pool.org';
    await assert.rejects(account.oauth({ provider: 'google' }), (e) => e.status === 404 && e.data?.needsAccount && /Kea app/.test(e.message));
    assert.equal(account.signedIn(), false);
    idp.st.as = 'lee@pool.org';
    const st = await account.oauth({ provider: 'google' });
    assert.deepEqual([st.signedIn, st.account.email], [true, 'lee@pool.org']);
    // "Ask every time" with another Google account than the one signed in: refused before anything is sent.
    idp.st.as = 'someone@else.org';
    const calls = keac.st.calls.length;
    await assert.rejects(account.freshPass('a'.repeat(22), { provider: 'google' }), (e) => e.status === 409 && e.data?.mismatch);
    assert.equal(keac.st.calls.length, calls);
    // Microsoft's round trip: http://localhost, response_mode=query, the login hint.
    const seen = [];
    idp.st.as = 'lee@pool.org';
    const tok = await viaIdp(idp, seen)('microsoft', 'lee@pool.org');
    assert.equal(idp.check(tok).email, 'lee@pool.org');
    assert.match(seen[0].searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
    assert.equal(seen[0].searchParams.get('response_mode'), 'query');
    assert.equal(seen[0].searchParams.get('login_hint'), 'lee@pool.org');
  } finally { await keac.close(); await idp.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('KeaC unreachable: the account says so and keeps what it knew; the server session keeps working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-app-down-'));
  const idp = await fakeIdp();
  const keac = await fakeKeac({ idp });
  idp.st.as = 'sam@pool.org';
  keac.addAccount({ id: 'acct-sam', email: 'sam@pool.org', name: 'Sam' });
  const hub = createHub({ dataDir: join(dir, 'data'), log: false, minFreeBytes: 0, keacUrl: keac.url, keacKeys: [keac.key.jwk] });
  try {
    const p = await hub.listen({ port: 0, ownerPort: 0 });
    const owner = async (m, path, body) => { const r = await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, hub.ownerKey, m, path, body); return { status: r.status, body: await r.json() }; };
    const account = createAccount({ dir: join(dir, 'app'), protect, getUrl: () => keac.url, idTokenFor: viaIdp(idp) });
    const link = createKeasLink({ dir: join(dir, 'app'), protect, base: () => `http://127.0.0.1:${p.port}`, owner, serverId: async () => hub.serverId, account, now: () => Date.now() + 25 * 3600_000 });
    await account.oauth({ provider: 'google' });
    await link.claim(hub.setupSecret);
    keac.setDown(true);
    const st = await account.status();
    assert.deepEqual([st.signedIn, st.reachable, st.account.email], [true, false, 'sam@pool.org']);
    // A day later renewal can't reach KeaC: the session stays and keeps working.
    assert.equal((await link.ensure()).id, 'acct-sam');
    assert.deepEqual(await link.orgs(), []);
  } finally { keac.setDown(false); await hub.close(); await keac.close(); await idp.close(); rmSync(dir, { recursive: true, force: true }); }
});
