// The payroll vault: passphrase encryption, Hub sign-in (Ed25519 tokens checked with the Hub's /v1/keys),
// the local-account fallback when the Hub can't be reached, and the locked state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';
import { loadOrCreateKey, signToken } from '../../hub/lib/tokens.mjs';
import { createVaultMeta, openVault, seal, unseal, canonical } from '../../server/lib/vault.mjs';
import { parseCsv, toCsv } from '../../server/lib/csv.mjs';
import { simplePdf } from '../../server/lib/pdf.mjs';
import { apportion } from '../../server/payroll/run.mjs';
import { diffApplies, splitNet } from '../../server/payroll/paystructure.mjs';
import { guessMapping, parseMoney, parseDate } from '../../server/payroll/importer.mjs';

let dir, hubServer, hubBase, hubUp = true, app, base, key, otherKey;
const ACCOUNT = { email: 'pat@example.org', password: 'correct horse battery', sub: 'acct-pat' };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-vault-test-'));
  key = loadOrCreateKey(join(dir, 'hub.key'));
  otherKey = loadOrCreateKey(join(dir, 'other.key'));
  // A stand-in Kea Hub with the same token format and endpoints.
  hubServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!hubUp) return send(502, { error: 'down' });
      const b = body ? JSON.parse(body) : {};
      if (req.url === '/v1/keys') return send(200, { keys: [key.jwk] });
      if (req.url === '/v1/auth/login') return b.email === ACCOUNT.email && b.password === ACCOUNT.password ? send(200, { token: 'hub-session' }) : send(401, { error: 'Wrong email or password.' });
      if (req.url === '/v1/auth/token') {
        if (req.headers.authorization !== 'Bearer hub-session') return send(401, { error: 'no' });
        const t = Math.floor(Date.now() / 1000);
        const signer = b.aud === 'forged' ? otherKey : key;
        return send(200, { token: signToken(signer, { iss: 'kea-hub', sub: ACCOUNT.sub, aud: 'keas-payroll', iat: t, exp: t + 300, email: ACCOUNT.email, name: 'Pat' }) });
      }
      if (req.url === '/v1/auth/logout') return send(200, { ok: true });
      send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
  hubBase = `http://127.0.0.1:${hubServer.address().port}`;
  app = createApp({ dbFile: join(dir, 'vault.db'), log: false, vault: true, hubUrl: hubBase });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app.close(); hubServer.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('crypto: AES-256-GCM sealing, wrong passphrase, tampering', () => {
  const { key: k, meta } = createVaultMeta('a long vault passphrase');
  assert.ok(openVault('a long vault passphrase', meta));
  assert.equal(openVault('a long vault passphrasE', meta), null);
  const s = seal(k, '123-45-6789');
  assert.equal(unseal(k, s), '123-45-6789');
  const parts = s.split('.');
  parts[3] = Buffer.from('xxxx').toString('base64url');
  assert.throws(() => unseal(k, parts.join('.')));
  assert.throws(() => createVaultMeta('short'), /12 characters/);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('helpers: CSV round trip, PDF, apportion, differential windows, deposit splits, import parsing', () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\n1,\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '']]);
  assert.match(toCsv(['f'], [{ f: '=SUM(A1)' }]), /'=SUM/);
  assert.equal(simplePdf({ title: 't', lines: Array.from({ length: 80 }, (_, i) => ({ text: `line ${i}` })) }).subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(apportion(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(apportion(7, [0, 0]).reduce((a, b) => a + b), 7);
  const night = { active: true, positionIds: [], days: [5], startMin: 22 * 60, endMin: 6 * 60 };
  assert.equal(diffApplies(night, 5, 23 * 60, 'x'), true);
  assert.equal(diffApplies(night, 6, 2 * 60, 'x'), true, 'after midnight belongs to the night it started');
  assert.equal(diffApplies(night, 6, 23 * 60, 'x'), false);
  assert.deepEqual(splitNet(50000, [{ account: '1', amountCents: 10000 }, { account: '2', remainder: true }]).map((x) => x.cents), [10000, 40000]);
  assert.equal(parseMoney('(1,234.50)'), -123450);
  assert.equal(parseDate('3/5/30'), '2030-03-05');
  assert.equal(guessMapping('ytd', ['Employee ID', 'YTD Gross', 'Fed Income Tax']).gross, 'YTD Gross');
});

test('a new vault is locked and empty; everything but status and setup waits', async () => {
  const st = await call('GET', '/v1/vault/status');
  assert.deepEqual([st.body.mode, st.body.initialized, st.body.locked], ['vault', false, true]);
  assert.equal((await call('GET', '/v1/org')).status, 423);
  assert.equal((await call('GET', '/v1/auth/demo-users')).status, 404, 'no development sign-in in the vault');
  assert.equal((await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'x' })).status, 409);
});

let token;
test('setup with the Kea Hub account; then sign-in needs the Hub password and the passphrase', async () => {
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: 'too short', org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { password: ACCOUNT.password } })).status, 400);
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: 'summer camp payroll vault', org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { password: 'wrong' } })).status, 401);
  const s = await call('POST', '/v1/vault/setup', null, { passphrase: 'summer camp payroll vault', org: { name: 'Lone Star Camp', state: 'TX', tz: 'America/Chicago' }, admin: { name: 'Pat Lee', email: ACCOUNT.email }, signIn: { mode: 'hub', password: ACCOUNT.password, localPassword: 'local fallback password' } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  token = s.body.token;
  assert.equal((await call('GET', '/v1/me', token)).body.mode, 'vault');
  assert.equal((await call('POST', '/v1/vault/setup', null, {})).status, 409);
  // Lock: the key leaves memory and sessions end.
  assert.equal((await call('POST', '/v1/vault/lock', token)).status, 200);
  assert.equal((await call('GET', '/v1/me', token)).status, 423);
  assert.equal((await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'not the passphrase' })).status, 401);
  assert.equal((await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: 'nope', passphrase: 'summer camp payroll vault' })).status, 401);
  assert.equal((await call('GET', '/v1/vault/status')).body.locked, true, 'a failed sign-in doesn’t leave the vault open');
  const ok = await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'summer camp payroll vault' });
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.equal(app.h.get('SELECT hub_sub FROM vault_users').hub_sub, ACCOUNT.sub);
});

test('a token signed with another key is refused', async () => {
  const { makeHubClient } = await import('../../server/payroll/hub.mjs');
  const hub = makeHubClient();
  const t = Math.floor(Date.now() / 1000);
  const forged = signToken(otherKey, { iss: 'kea-hub', sub: 'x', aud: 'keas-payroll', iat: t, exp: t + 300, email: ACCOUNT.email });
  await assert.rejects(hub.verify(hubBase, forged), /didn’t check out/);
  const good = signToken(key, { iss: 'kea-hub', sub: 'x', aud: 'keas-payroll', iat: t, exp: t + 300, email: ACCOUNT.email });
  assert.equal((await hub.verify(hubBase, good)).sub, 'x');
  const wrongAud = signToken(key, { iss: 'kea-hub', sub: 'x', aud: 'kea', iat: t, exp: t + 300 });
  await assert.rejects(hub.verify(hubBase, wrongAud));
});

test('when the Hub is unreachable, the local account works (passphrase still required)', async () => {
  hubUp = false;
  try {
    const r = await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'summer camp payroll vault' });
    assert.equal(r.status, 503);
    assert.equal(r.body.hubUnreachable, true);
    assert.equal(r.body.localAvailable, true);
    assert.equal((await call('POST', '/v1/vault/signin', null, { mode: 'local', email: ACCOUNT.email, password: 'wrong local password', passphrase: 'summer camp payroll vault' })).status, 401);
    const ok = await call('POST', '/v1/vault/signin', null, { mode: 'local', email: ACCOUNT.email, password: 'local fallback password', passphrase: 'summer camp payroll vault' });
    assert.equal(ok.status, 200);
  } finally { hubUp = true; }
});

test('the vault works with real data: an employee’s SSN and bank are sealed; changing the passphrase re-encrypts', async () => {
  const p = await call('POST', '/v1/people', token, { name: 'Jamie Cruz', hireDate: '2030-05-01', payRateCents: 1600, status: 'active', pii: { ssn: '123-45-6701' } });
  assert.equal(p.status, 201);
  await call('POST', `/v1/people/${p.body.profile.id}/deposit`, token, { routing: '990000013', account: '11112222' });
  const row = app.h.get('SELECT pii_enc, deposit FROM people WHERE id = ?', p.body.profile.id);
  assert.ok(!row.pii_enc.includes('6701') && !row.deposit.includes('11112222'));
  assert.equal((await call('POST', '/v1/vault/passphrase', token, { current: 'wrong passphrase!!', next: 'a brand new vault passphrase' })).status, 401);
  assert.equal((await call('POST', '/v1/vault/passphrase', token, { current: 'summer camp payroll vault', next: 'a brand new vault passphrase' })).status, 200);
  assert.notEqual(app.h.get('SELECT pii_enc FROM people WHERE id = ?', p.body.profile.id).pii_enc, row.pii_enc);
  assert.equal((await call('POST', `/v1/people/${p.body.profile.id}/reveal-ssn`, token)).body.ssn, '123-45-6701');
  await call('POST', '/v1/vault/lock', token);
  assert.equal((await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'summer camp payroll vault' })).status, 401);
  const ok = await call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: 'a brand new vault passphrase' });
  assert.equal(ok.status, 200);
  // A Texas org has no state tax table yet: the run shows that and can't be finalized.
  const pr = (await call('GET', '/v1/payrun/preview', ok.body.token)).body;
  assert.ok(pr.tables.some((t) => t.key === 'tax:TX' && t.missing));
  assert.equal(pr.canFinalize, false);
});
