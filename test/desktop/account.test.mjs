// The KeaS app's sign-in, end to end with a fake KeaC and a real KeaS server: trusting KeaC's key by its fingerprint,
// signing in to the Kea account (password, then the two-step code), setting up the server with its setup code and a
// pass, the organization, the payroll vault's token (and the "ask every time" one), and what's kept on disk.
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

const require = createRequire(import.meta.url);
const { createAccount, checkUrl } = require('../../desktop/account.cjs');
const { createKeasLink } = require('../../desktop/keas.cjs');
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
  const keac = await fakeKeac();
  keac.addAccount({ id: 'acct-pat', email: 'pat@pool.org', password: 'lantern velvet orbit', name: 'Pat', code: '424242' });
  const hub = createHub({ dataDir: join(dir, 'data'), log: false, minFreeBytes: 0 });
  try {
    const p = await hub.listen({ port: 0, ownerPort: 0 });
    const base = `http://127.0.0.1:${p.port}`;
    const owner = async (m, path, body) => { const r = await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, hub.ownerKey, m, path, body); return { status: r.status, body: await r.json() }; };
    let url = null;
    const account = createAccount({ dir: join(dir, 'app'), protect, getUrl: () => url, setUrl: (u) => (url = u) });
    const link = createKeasLink({ dir: join(dir, 'app'), protect, base: () => base, owner, serverId: async () => hub.serverId, account });

    // KeaC's key: shown with its fingerprint, trusted only with the right one.
    const offer = (await owner('GET', `/owner/keac/offer?url=${encodeURIComponent(keac.url)}`)).body;
    assert.equal(offer.keys[0].kid, keac.key.kid);
    assert.equal((await owner('POST', '/owner/keac/pin', { url: keac.url, kid: offer.keys[0].kid, fingerprint: 'AAAA' })).status, 409);
    assert.equal((await owner('POST', '/owner/keac/pin', { url: keac.url, kid: offer.keys[0].kid, fingerprint: offer.keys[0].fingerprint })).status, 200);
    await account.changeUrl(keac.url);

    // The Kea account: the password, then the code. Only KeaC ever sees them.
    await assert.rejects(account.login({ email: 'pat@pool.org', password: 'lantern velvet orbit' }), (e) => e.status === 401 && e.data?.totpRequired);
    const st = await account.login({ email: 'pat@pool.org', password: 'lantern velvet orbit', code: '424242' });
    assert.deepEqual([st.signedIn, st.account.email], [true, 'pat@pool.org']);
    assert.ok(!keac.st.calls.some((c) => c.includes(base)), 'nothing about the server’s address went to KeaC');

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
    // "Ask every time": a fresh KeaC sign-in (code last), its own short session, then ended.
    const sessionsBefore = hub.h.get('SELECT COUNT(*) AS n FROM keas_sessions').n;
    await assert.rejects(link.freshPayrollToken({ password: 'lantern velvet orbit' }), (e) => e.data?.totpRequired);
    const t2 = await link.freshPayrollToken({ password: 'lantern velvet orbit', code: '424242' });
    assert.equal(verifyToken(hub.identityKey.publicKey, t2, { aud: 'keas-payroll', iss: `keas:${hub.serverId}` }).sub, 'acct-pat');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM keas_sessions').n, sessionsBefore, 'its session ended');

    // A session the server ended is made again from a pass by itself.
    hub.h.run('DELETE FROM keas_sessions');
    assert.equal((await link.orgs()).length, 1);
    // Nothing secret is kept in the clear.
    for (const f of readdirSync(join(dir, 'app'))) {
      const b = readFileSync(join(dir, 'app', f), 'utf8');
      assert.ok(!b.includes('lantern') && !b.includes(link.session().token), f);
    }
    // Signing out of the Kea account here ends KeaC's session.
    await account.logout();
    assert.equal(account.signedIn(), false);
    assert.equal(keac.st.sessions.size, 0);
  } finally { await hub.close(); await keac.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('KeaC unreachable: the account says so and keeps what it knew; the server session keeps working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-app-down-'));
  const keac = await fakeKeac();
  keac.addAccount({ id: 'acct-sam', email: 'sam@pool.org', password: 'pw-pw-pw-pw', name: 'Sam' });
  const hub = createHub({ dataDir: join(dir, 'data'), log: false, minFreeBytes: 0, keacUrl: keac.url, keacKeys: [keac.key.jwk] });
  try {
    const p = await hub.listen({ port: 0, ownerPort: 0 });
    const owner = async (m, path, body) => { const r = await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, hub.ownerKey, m, path, body); return { status: r.status, body: await r.json() }; };
    const account = createAccount({ dir: join(dir, 'app'), protect, getUrl: () => keac.url });
    const link = createKeasLink({ dir: join(dir, 'app'), protect, base: () => `http://127.0.0.1:${p.port}`, owner, serverId: async () => hub.serverId, account, now: () => Date.now() + 25 * 3600_000 });
    await account.login({ email: 'sam@pool.org', password: 'pw-pw-pw-pw' });
    await link.claim(hub.setupSecret);
    keac.setDown(true);
    const st = await account.status();
    assert.deepEqual([st.signedIn, st.reachable, st.account.email], [true, false, 'sam@pool.org']);
    // A day later renewal can't reach KeaC: the session stays and keeps working.
    assert.equal((await link.ensure()).id, 'acct-sam');
    assert.deepEqual(await link.orgs(), []);
  } finally { keac.setDown(false); await hub.close(); await keac.close(); rmSync(dir, { recursive: true, force: true }); }
});
