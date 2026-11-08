// The KeaS server's identity and sign-in (docs/protocol.md section 2), against a fake KeaC: /v1/identity, passes
// (good, wrong audience, expired, from the future, wrong key, revoked), sessions renewed by newer passes, the hourly
// and daily revocation checks, key rotation, KeaC being down, claiming a fresh server, members' files, the payroll
// vault's token, and the owner console's own checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../org/helpers.mjs';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch, ownerSign } from '../../hub/lib/ownerauth.mjs';
import { verifyToken } from '../../hub/lib/tokens.mjs';
import { rotateOwnerKey } from '../../hub/owner.mjs';
import { signWith } from '../helpers/keac.mjs';

const HOUR = 3600_000, DAY = 24 * HOUR;
let H;
before(async () => { H = await startHub({ prefix: 'keas-server-' }); });
after(() => H.close());
const sec = () => Math.floor(H.t.now / 1000);
const passFor = (u, o = {}) => H.pass(u.id, u.email, u.name ?? '', o);
const signInWith = (pass, token) => H.call('POST', '/v1/auth/pass', token ?? null, { pass }, H.ip());

test('identity: the server id is its key’s fingerprint, and it signs kea-server-identity:<serverId>:<nonce>', async () => {
  const nonce = 'n0nce-' + randomUUID();
  const r = H.ok(await H.call('GET', `/v1/identity?nonce=${nonce}`));
  assert.equal(r.serverId, createHash('sha256').update(Buffer.from(r.publicKey.x, 'base64url')).digest('base64url').slice(0, 22));
  assert.equal(r.serverId, H.hub.serverId);
  assert.ok(verify(null, Buffer.from(`kea-server-identity:${r.serverId}:${nonce}`), createPublicKey({ key: r.publicKey, format: 'jwk' }), Buffer.from(r.sig, 'base64url')));
  assert.equal(r.name, 'KeaS');
  assert.equal((await H.call('GET', '/v1/identity?nonce=short')).status, 400);
  const health = H.ok(await H.call('GET', '/v1/health'));
  assert.deepEqual([health.service, health.serverId, health.claimed, health.features.includes('passes')], ['keas', r.serverId, true, true]);
  // None of the Kea Hub's account routes are here.
  for (const p of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/google', '/v1/me/totp/setup', '/v1/auth/token']) assert.equal((await H.call('POST', p, null, {})).status, 404, p);
});

test('a pass makes a session: { token, exp }, and what makes one refused', async () => {
  const u = { id: randomUUID(), email: 'Pat@Pool.org', name: 'Pat' };
  const r = H.ok(await signInWith(passFor(u)));
  assert.match(r.token, /^[0-9a-f]{64}$/);
  assert.equal(typeof r.exp, 'number');
  assert.equal(r.exp, H.t.now + 30 * DAY);
  assert.deepEqual([r.me.id, r.me.email, r.me.name, r.renewed], [u.id, 'pat@pool.org', 'Pat', false]);
  assert.equal(H.ok(await H.call('GET', '/v1/me', r.token)).me.id, u.id);
  const refused = async (pass, reason) => { const x = await signInWith(pass); assert.equal(x.status, 401, reason); assert.equal(x.body.reason, reason); assert.ok(x.body.error); };
  await refused(passFor(u, { aud: 'keas:someOtherServerId0000' }), 'aud');
  await refused(passFor(u, { aud: `keac-org:${H.hub.serverId}` }), 'aud');
  await refused(passFor(u, { iat: sec() - 8 * 86400, exp: sec() - 60 }), 'expired');
  await refused(passFor(u, { iat: sec() + 300, exp: sec() + 7 * 86400 }), 'future');
  H.ok(await signInWith(passFor(u, { iat: sec() + 60, exp: sec() + 7 * 86400 })), 200);
  await refused(passFor(u, { iat: sec(), exp: sec() + 30 * 86400 }), 'lifetime');
  await refused(passFor(u, { iss: 'kea-hub' }), 'iss');
  await refused(passFor(u, { ev: false }), 'claims');
  await refused('not.a.pass', 'format');
  // Signed by a key KeaC never published, under KeaC's kid or one of its own.
  const { generateKeyPairSync } = await import('node:crypto');
  const evil = { privateKey: generateKeyPairSync('ed25519').privateKey, kid: H.keac.key.kid };
  const t = sec();
  await refused(signWith(evil, { iss: 'kea', aud: `keas:${H.hub.serverId}`, sub: u.id, ev: true, iat: t, exp: t + 3600 }), 'signature');
  await refused(signWith({ ...evil, kid: 'unknownkid000000' }, { iss: 'kea', aud: `keas:${H.hub.serverId}`, sub: u.id, ev: true, iat: t, exp: t + 3600 }), 'key');
  // A session token that isn't one.
  assert.equal((await H.call('GET', '/v1/me', 'f'.repeat(64))).status, 401);
});

test('a newer pass renews the session it comes with; an older one never stretches it', async () => {
  const u = { id: randomUUID(), email: 'renew@pool.org', name: 'Ren' };
  const first = H.ok(await signInWith(passFor(u)));
  H.t.now += DAY;
  const again = H.ok(await signInWith(passFor(u), first.token));
  assert.deepEqual([again.token, again.renewed, again.exp], [first.token, true, H.t.now + 30 * DAY]);
  // The name and email follow the newest pass.
  H.ok(await signInWith(passFor({ ...u, name: 'Renata' }), first.token));
  assert.equal(H.ok(await H.call('GET', '/v1/me', first.token)).me.name, 'Renata');
  const old = H.ok(await signInWith(passFor(u, { iat: sec() - 2 * 86400, exp: sec() + 86400 }), first.token));
  assert.notEqual(old.token, first.token, 'an older pass gets a session of its own');
  // Someone else's session never gets renewed with my pass.
  const v = { id: randomUUID(), email: 'v@pool.org' };
  assert.notEqual(H.ok(await signInWith(passFor(v), first.token)).token, first.token);
  // Sessions end by themselves after 30 days without a newer pass.
  H.t.now += 31 * DAY;
  assert.equal((await H.call('GET', '/v1/me', first.token)).status, 401);
});

test('revocation: the hourly check ends a revoked account’s sessions; the daily full list lets it back', async () => {
  const u = { id: randomUUID(), email: 'rev@pool.org', name: 'Rev' };
  const s = H.ok(await signInWith(passFor(u)));
  const kept = H.ok(await signInWith(passFor({ id: randomUUID(), email: 'keep@pool.org' })));
  await H.hub.keac.tick();
  H.keac.revoke(u.id);
  // Within the hour nothing is asked; after it, only what changed (since=).
  H.t.now += 10 * 60_000;
  await H.hub.keac.tick();
  assert.equal((await H.call('GET', '/v1/me', s.token)).status, 200);
  H.t.now += HOUR;
  H.keac.st.calls.length = 0;
  await H.hub.keac.tick();
  assert.ok(H.keac.st.calls.some((c) => /^GET \/v1\/revoked\?since=\d+$/.test(c)), H.keac.st.calls.join(','));
  assert.equal((await H.call('GET', '/v1/me', s.token)).status, 401, 'the session ended');
  assert.equal((await signInWith(passFor(u))).body.reason, 'revoked');
  assert.equal((await H.call('GET', '/v1/me', kept.token)).status, 200, 'nobody else');
  // Back on KeaC: the changes-only list never says so; the next full list does.
  H.keac.unrevoke(u.id);
  H.t.now += HOUR;
  await H.hub.keac.tick();
  assert.equal((await signInWith(passFor(u))).status, 401);
  H.t.now += DAY;
  H.keac.st.calls.length = 0;
  await H.hub.keac.tick();
  assert.ok(H.keac.st.calls.includes('GET /v1/revoked'), 'the daily full list');
  H.ok(await signInWith(passFor(u)));
});

test('key rotation: a next key is learned before it signs; retired keys still check; removed ones stop', async () => {
  const u = { id: randomUUID(), email: 'rot@pool.org' };
  const old = H.keac.key;
  const next = H.keac.addNext();
  H.t.now += 6 * HOUR;
  await H.hub.keac.tick();
  assert.ok(H.hub.keac.keys().some((k) => k.kid === next.kid && k.status === 'next'));
  H.ok(await signInWith(passFor(u, { key: next })), 200, 'a pass signed with the next key');
  H.keac.promote();
  H.ok(await signInWith(passFor(u)));
  H.ok(await signInWith(passFor(u, { key: old })), 200, 'retired: passes it signed still check out');
  H.keac.remove(old.kid);
  await H.hub.keac.refreshKeys();
  assert.equal((await signInWith(passFor(u, { key: old }))).body.reason, 'key');
  // A list with none of the trusted keys (someone else at the address) isn't taken.
  const before = H.hub.keac.keys().map((k) => k.kid).sort();
  const saved = H.keac.st.keys;
  H.keac.st.keys = [];
  H.keac.addNext(); H.keac.promote();
  assert.equal(await H.hub.keac.refreshKeys(), false);
  assert.deepEqual(H.hub.keac.keys().map((k) => k.kid).sort(), before);
  assert.match(H.hub.keac.status().keysError, /none of the keys this server trusts/);
  H.keac.st.keys = saved;
  assert.equal(await H.hub.keac.refreshKeys(), true);
});

test('KeaC down: sessions and passes keep working on the last good lists, even after a restart', async () => {
  const u = { id: randomUUID(), email: 'down@pool.org' };
  const s = H.ok(await signInWith(passFor(u)));
  H.keac.setDown(true);
  try {
    H.t.now += 7 * HOUR;
    await H.hub.keac.tick();
    const st = H.hub.keac.status();
    assert.ok(st.keysError && st.revokedError, JSON.stringify(st));
    assert.equal((await H.call('GET', '/v1/me', s.token)).status, 200);
    H.ok(await signInWith(passFor(u)));
    // A restart while KeaC is down: the key list kept in the database is used.
    const again = createHub({ dataDir: H.dir, now: () => H.t.now, log: false, minFreeBytes: 0, keacUrl: H.keac.url });
    try {
      const p = await again.listen({ port: 0, ownerPort: 0 });
      const r = await fetch(`http://127.0.0.1:${p.port}/v1/auth/pass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pass: passFor(u) }) });
      assert.equal(r.status, 200, await r.text());
    } finally { await again.close(); }
  } finally { H.keac.setDown(false); }
});

test('claiming a fresh server: only on this PC, with the setup code and a pass; once', async () => {
  const F = await startHub({ claim: false, prefix: 'keas-claim-' });
  try {
    const code = F.hub.setupSecret;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(readFileSync(join(F.dir, 'setup.secret'), 'utf8').trim(), code);
    assert.equal(F.ok(await F.call('GET', '/v1/health')).claimed, false);
    // Not on the public API at all.
    assert.equal((await F.call('POST', '/owner/claim', null, { secret: code })).status, 404);
    const me = { id: randomUUID(), email: 'first@camp.org', name: 'First' };
    const pass = F.pass(me.id, me.email, me.name);
    assert.equal((await F.owner('POST', '/owner/claim', { pass, secret: 'AAAA-BBBB-CCCC' })).status, 403);
    assert.equal((await F.owner('POST', '/owner/claim', { pass: F.pass(me.id, me.email, me.name, { aud: 'keas:other' }), secret: code })).status, 401);
    const s = F.ok(await F.owner('POST', '/owner/claim', { pass, secret: code.toLowerCase() }));
    assert.equal(s.me.operator, true);
    assert.equal(existsSync(join(F.dir, 'setup.secret')), false, 'the code is used up');
    assert.equal(F.hub.setupSecret, null);
    assert.equal((await F.owner('POST', '/owner/claim', { pass: F.pass(randomUUID(), 'late@x.org', 'Late'), secret: code })).status, 409);
    // The operator makes the organization (active at once, and theirs); nobody else may.
    const org = F.ok(await F.call('POST', '/v1/orgs', s.token, { name: 'Pine Camp', tz: 'America/Chicago', state: 'TX' }), 201).org;
    assert.deepEqual([org.status, org.role], ['active', 'owner']);
    const other = await F.person('other@camp.org', 'Other');
    assert.equal((await F.call('POST', '/v1/orgs', other.token, { name: 'Mine' })).status, 403);
    assert.equal(F.ok(await F.call('GET', `/v1/identity?nonce=${'a'.repeat(20)}`)).name, 'Pine Camp');
  } finally { await F.close(); }
});

test('members’ files: only in an organization, as big as it allows, versions and paths checked', async () => {
  const boss = await H.person('fboss@files.org', 'Boss');
  const mem = await H.person('fmem@files.org', 'Mem');
  const loner = await H.person('alone@files.org', 'Alone');
  const org = await H.orgWith(boss, 'Files Org', [[mem, 'member']]);
  const put = (u, p, body, headers = {}) => fetch(`${H.base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, ...headers }, body });
  assert.equal((await put(loner, 'kea/a.txt', 'x')).status, 507, 'no organization, no files');
  assert.equal(H.ok(await H.call('GET', '/v1/me', mem.token)).files.quota, 1024 ** 3, '1 GB by default');
  const a = await put(mem, 'kea/School/notes.txt', 'hello');
  assert.equal(a.status, 201);
  assert.equal(a.headers.get('etag'), '"1"');
  assert.equal(await (await fetch(`${H.base}/v1/files/kea/School/notes.txt`, { headers: { authorization: `Bearer ${mem.token}` } })).text(), 'hello');
  assert.equal((await put(mem, 'kea/School/notes.txt', 'again', { 'if-match': '"7"' })).status, 412);
  assert.equal((await put(mem, 'kea/School/notes.txt', 'again', { 'if-match': '"1"' })).status, 200);
  assert.equal((await fetch(`${H.base}/v1/files/kea/School/notes.txt`, { headers: { authorization: `Bearer ${boss.token}` } })).status, 404, 'each member’s own');
  assert.equal((await put(mem, 'kea/..%2F..%2Fx', 'x')).status, 400);
  assert.equal((await put(mem, 'kea/~2e~~2e~', 'x')).status, 400);
  const list = H.ok(await H.call('GET', '/v1/files?prefix=kea/', mem.token));
  assert.deepEqual(list.files.map((f) => [f.path, f.version, f.size]), [['kea/School/notes.txt', 2, 5]]);
  // The owner sets the size (settings.filesQuotaGb).
  H.ok(await H.call('POST', `/v1/orgs/${org.id}`, boss.token, { settings: { filesQuotaGb: 0.00001 } }));
  assert.equal((await put(mem, 'kea/big.bin', Buffer.alloc(20_000))).status, 507);
  assert.equal((await H.call('POST', `/v1/orgs/${org.id}`, mem.token, { settings: { filesQuotaGb: 5 } })).status, 403);
  // Leaving the server takes their files and everything else with them.
  assert.equal((await H.call('POST', '/v1/me/leave-server', mem.token, { confirm: 'wrong@x.org' })).status, 400);
  H.ok(await H.call('POST', '/v1/me/leave-server', mem.token, { confirm: 'fmem@files.org' }));
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM member_files WHERE account_id = ?', mem.id).n, 0);
  assert.equal((await H.call('GET', '/v1/me', mem.token)).status, 401);
});

test('the payroll vault’s token: from the owner console only, for a live session, signed by this server', async () => {
  const u = await H.person('payroll@pool.org', 'Pay Roll');
  const r = H.ok(await H.owner('POST', '/owner/payroll-token', { session: u.token }));
  const p = verifyToken(H.hub.identityKey.publicKey, r.token, { aud: 'keas-payroll', iss: `keas:${H.hub.serverId}`, nowMs: H.t.now });
  assert.deepEqual([p.sub, p.email, p.exp - p.iat], [u.id, 'payroll@pool.org', 15 * 60]);
  assert.equal((await H.owner('POST', '/owner/payroll-token', { session: 'a'.repeat(64) })).status, 401);
  assert.equal((await H.call('POST', '/owner/payroll-token', u.token, { session: u.token })).status, 404, 'not on the public API');
});

test('the owner console: each challenge works once, for one exact request; the key rotates; a taken port is a clear error', async () => {
  const ob = H.ownerBase;
  assert.equal((await fetch(`${ob}/owner/stats`)).status, 401);
  const { nonce } = await (await fetch(`${ob}/owner/nonce`)).json();
  const header = ownerSign(H.hub.ownerKey, nonce, 'GET', '/owner/stats', '');
  assert.equal((await fetch(`${ob}/owner/stats`, { headers: { 'x-kea-owner-auth': header } })).status, 200);
  assert.equal((await fetch(`${ob}/owner/stats`, { headers: { 'x-kea-owner-auth': header } })).status, 401, 'replay refused');
  const n2 = (await (await fetch(`${ob}/owner/nonce`)).json()).nonce;
  assert.equal((await fetch(`${ob}/owner/settings`, { method: 'POST', headers: { 'x-kea-owner-auth': ownerSign(H.hub.ownerKey, n2, 'POST', '/owner/settings', '{}') }, body: '{"orgs":{"anyoneCreates":true}}' })).status, 401, 'signed for another body');
  assert.equal((await fetch(`${ob}/owner/stats`, { headers: { origin: 'http://evil.example' } })).status, 403);
  const old = H.hub.ownerKey;
  rotateOwnerKey(H.dir);
  assert.notEqual(H.hub.ownerKey, old);
  assert.equal((await ownerFetch(ob, old, 'GET', '/owner/stats')).status, 401);
  assert.equal((await ownerFetch(ob, H.hub.ownerKey, 'GET', '/owner/stats')).status, 200);
  const squat = net.createServer();
  await new Promise((r) => squat.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'keas-port-'));
  const hub = createHub({ dataDir: dir, log: false, minFreeBytes: 0, keacStart: false });
  try { await assert.rejects(hub.listen({ port: squat.address().port, ownerPort: 0 }), (e) => e.code === 'EADDRINUSE' && /already in use/.test(e.message)); }
  finally { squat.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});
