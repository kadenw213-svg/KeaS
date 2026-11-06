// The payroll vault: passphrase encryption, Hub sign-in (Ed25519 tokens checked against the Hub key pinned at setup),
// the opt-in local fallback when the Hub can't be reached, per-account wrong-try limits, sealed pay amounts, birthdates
// and emails, and the locked state. Includes the red team's proof of concept (a fake Hub) as regression tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/index.mjs';
import { openDb } from '../../server/db.mjs';
import { makeVault } from '../../server/payroll/vaultstate.mjs';
import { loadOrCreateKey, signToken } from '../../hub/lib/tokens.mjs';
import { createVaultMeta, openVault, seal, unseal, canonical, isSealed } from '../../server/lib/vault.mjs';
import { parseCsv, toCsv } from '../../server/lib/csv.mjs';
import { simplePdf } from '../../server/lib/pdf.mjs';
import { apportion } from '../../server/payroll/run.mjs';
import { diffApplies, splitNet } from '../../server/payroll/paystructure.mjs';
import { guessMapping, parseMoney, parseDate } from '../../server/payroll/importer.mjs';
import { makeHubClient, checkHubUrl } from '../../server/payroll/hub.mjs';
import { checkLocalStrength } from '../../server/payroll/vaultauth.mjs';

let dir, hubServer, hubBase, hubUp = true, hubKey, app, base, key, otherKey, localOn = false;
const ACCOUNT = { email: 'pat@example.org', password: 'correct horse battery', sub: 'acct-pat' };
const PASS = 'summer camp payroll vault';
const LOCAL_PW = 'river lantern copper meadow';
let hubCalls = [];

/** A stand-in Kea Hub with the same token format and endpoints; `signer` and `claims` let a test change what it issues. */
function fakeHub({ accept = (b) => b.email === ACCOUNT.email && b.password === ACCOUNT.password, signer = () => hubKey, claims = () => ({}), log = hubCalls, up = () => hubUp } = {}) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!up()) return send(502, { error: 'down' });
      const b = body ? JSON.parse(body) : {};
      log.push({ url: req.url, body: b });
      if (req.url === '/v1/health') return send(200, { ok: true, service: 'kea-hub' });
      if (req.url === '/v1/keys') return send(200, { keys: [signer().jwk] });
      if (req.url === '/v1/auth/login') return accept(b) ? send(200, { token: 'hub-session' }) : send(401, { error: 'Wrong email or password.' });
      if (req.url === '/v1/auth/token') {
        if (req.headers.authorization !== 'Bearer hub-session') return send(401, { error: 'no' });
        const t = Math.floor(Date.now() / 1000);
        return send(200, { token: signToken(signer(), { iss: 'kea-hub', sub: ACCOUNT.sub, aud: b.aud, iat: t, exp: t + 300, email: ACCOUNT.email, name: 'Pat', ev: true, ...claims() }) });
      }
      if (req.url === '/v1/auth/logout') return send(200, { ok: true });
      send(404, { error: 'not found' });
    });
  });
}
const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${srv.address().port}`; };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-vault-test-'));
  key = loadOrCreateKey(join(dir, 'hub.key'));
  otherKey = loadOrCreateKey(join(dir, 'other.key'));
  hubKey = key;
  hubServer = fakeHub();
  hubBase = await listen(hubServer);
  app = createApp({ dbFile: join(dir, 'vault.db'), log: false, vault: true, hubUrl: hubBase, localSignIn: () => localOn });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app.close(); hubServer.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
/** A raw request with any Host header (fetch won't send a foreign one). */
function rawPost(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port: new URL(base).port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, async (r) => { let t = ''; for await (const c of r) t += c; resolve({ status: r.statusCode, body: JSON.parse(t || '{}') }); });
    rq.on('error', reject); rq.end(data);
  });
}
const signin = (extra = {}) => call('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase: PASS, ...extra });

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
  assert.deepEqual([st.body.mode, st.body.initialized, st.body.locked, st.body.localSignIn], ['vault', false, true, false]);
  assert.equal((await call('GET', '/v1/org')).status, 423);
  assert.equal((await call('GET', '/v1/auth/demo-users')).status, 404, 'no development sign-in in the vault');
  assert.equal((await signin({ passphrase: 'x' })).status, 409);
});

test('H1 PoC: setup refuses a Hub named by the request, and never sends the password there', async () => {
  const captured = [];
  const evilKey = loadOrCreateKey(join(dir, 'evil.key'));
  const evil = fakeHub({ accept: () => true, signer: () => evilKey, log: captured, up: () => true });
  const evilUrl = await listen(evil);
  try {
    const r = await call('POST', '/v1/vault/setup', null, { hubUrl: evilUrl, passphrase: 'owner-pass-phrase-1', org: { name: 'Victim Org', state: 'CO' }, admin: { email: 'owner@victim.org', name: 'Owner' }, signIn: { mode: 'hub', password: 'Real-Hub-Password!', code: '123456' } });
    assert.equal(r.status, 400);
    assert.deepEqual(captured, [], 'nothing reached the address the request named');
    assert.equal((await call('GET', '/v1/vault/status')).body.initialized, false);
    // Through a DNS-rebinding page (its own host name pointed at 127.0.0.1): refused before anything happens.
    const port = new URL(base).port;
    const reb = await rawPost('/v1/vault/setup', { passphrase: 'owner-pass-phrase-1', org: { name: 'Victim Org', state: 'CO' }, admin: { email: ACCOUNT.email, name: 'Owner' }, signIn: { mode: 'hub', password: ACCOUNT.password } }, { host: `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(reb.status, 421);
    assert.equal((await call('GET', '/v1/vault/status')).body.initialized, false);
    // A Hub address the vault would send passwords to in the clear is refused outright.
    assert.throws(() => createApp({ dbFile: ':memory:', vault: true, hubUrl: 'http://hub.example.org', log: false }), /https/);
    assert.equal(checkHubUrl('https://hub.example.org/'), 'https://hub.example.org');
    assert.equal(checkHubUrl('http://127.0.0.1:4860'), 'http://127.0.0.1:4860');
  } finally { evil.close(); }
});

let token;
test('setup with the Kea Hub account pins its key; sign-in needs the Hub password and the passphrase', async () => {
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: 'too short', org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { password: ACCOUNT.password } })).status, 400);
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { password: 'wrong' } })).status, 401);
  // H2: a local password at setup only when the owner turned local sign-in on in the KeaS app.
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { mode: 'hub', password: ACCOUNT.password, localPassword: LOCAL_PW } })).status, 403);
  assert.equal((await call('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: ACCOUNT.email }, signIn: { mode: 'local', password: LOCAL_PW } })).status, 403);
  const s = await call('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Lone Star Camp', state: 'TX', tz: 'America/Chicago' }, admin: { name: 'Pat Lee', email: ACCOUNT.email }, signIn: { mode: 'hub', password: ACCOUNT.password } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  token = s.body.token;
  const pin = app.vault.setting('hubPin');
  assert.equal(pin.url, hubBase);
  assert.equal(pin.iss, 'kea-hub');
  assert.deepEqual(pin.keys.map((k) => k.x), [key.jwk.x]);
  assert.equal((await call('GET', '/v1/me', token)).body.mode, 'vault');
  assert.equal((await call('POST', '/v1/vault/setup', null, {})).status, 409);
  assert.equal((await call('POST', '/v1/vault/hub-url', token, { hubUrl: 'https://evil.example' })).status, 410, 'the Hub address can’t be changed over HTTP');
  // Lock: the key leaves memory and sessions end.
  assert.equal((await call('POST', '/v1/vault/lock', token)).status, 200);
  assert.equal((await call('GET', '/v1/me', token)).status, 423);
  assert.equal((await signin({ passphrase: 'not the passphrase' })).status, 401);
  assert.equal((await signin({ password: 'nope' })).status, 401);
  assert.equal((await call('GET', '/v1/vault/status')).body.locked, true, 'a failed sign-in doesn’t leave the vault open');
  const ok = await signin();
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.equal(app.h.get('SELECT hub_sub FROM vault_users').hub_sub, ACCOUNT.sub);
});

test('H1: a token from another key, issuer or audience, or with odd times, is refused', async () => {
  const hub = makeHubClient();
  const t = Math.floor(Date.now() / 1000);
  const pinned = [{ kty: 'OKP', crv: 'Ed25519', x: key.jwk.x, kid: key.kid }];
  const tok = (k, claims) => signToken(k, { iss: 'kea-hub', sub: 'x', aud: 'keas-payroll', iat: t, exp: t + 300, email: ACCOUNT.email, ...claims });
  assert.equal(hub.verifyWith(pinned, tok(key, {})).sub, 'x');
  assert.throws(() => hub.verifyWith(pinned, tok(otherKey, {})), /signing key isn’t the one/);
  for (const bad of [{ aud: 'kea' }, { aud: 'org:pool' }, { iss: 'evil-hub' }, { iat: t + 3600 }, { nbf: t + 3600 }, { exp: t - 10 }, { iat: t - 10, exp: t + 7 * 86400 }, { sub: '' }]) {
    assert.throws(() => hub.verifyWith(pinned, tok(key, bad)), undefined, JSON.stringify(bad));
  }
});

test('H1: once pinned, a different Hub key is refused (even at the right address) until the owner accepts it in the KeaS app', async () => {
  await call('POST', '/v1/vault/lock', token);
  hubKey = otherKey; // the Hub at the vault's address now signs with another key (moved, reinstalled, or impersonated)
  try {
    const r = await signin();
    assert.equal(r.status, 401);
    assert.equal(r.body.hubKeyChanged, true);
    assert.equal((await call('GET', '/v1/vault/status')).body.locked, true);
    // The owner accepts the new key in the KeaS app (not over HTTP).
    await app.repinHub();
    const ok = await signin();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await call('POST', '/v1/vault/lock', ok.body.token);
    await app.repinHub();
  } finally { hubKey = key; await app.repinHub(); }
  token = (await signin()).body.token;
});

test('H2: the local password is off by default, needs a strong password, and works only while the Hub can’t be reached', async () => {
  assert.equal(checkLocalStrength('short'), 'The local password needs at least 16 characters. A few unrelated words work well.');
  assert.ok(checkLocalStrength('aaaaaaaaaaaaaaaaaaaa'));
  assert.equal(checkLocalStrength(LOCAL_PW), null);
  // Off: neither setting one nor using one.
  assert.equal((await call('POST', '/v1/vault/local-password', token, { password: LOCAL_PW })).status, 403);
  hubUp = false;
  try { assert.equal((await signin({ mode: 'local', password: LOCAL_PW })).status, 403); } finally { hubUp = true; }
  // The owner turns it on in the KeaS app.
  localOn = true;
  assert.equal((await call('GET', '/v1/vault/status')).body.localSignIn, true);
  assert.equal((await call('POST', '/v1/vault/local-password', token, { password: 'local password' })).status, 400, 'too weak');
  assert.equal((await call('POST', '/v1/vault/local-password', token, { password: LOCAL_PW })).status, 200);
  await call('POST', '/v1/vault/lock', token);
  // The Hub can be reached: the local password doesn't skip it (or its two-step code).
  const before = hubCalls.filter((c) => c.url === '/v1/auth/login').length;
  const up = await signin({ mode: 'local', password: LOCAL_PW });
  assert.equal(up.status, 409);
  assert.equal(hubCalls.filter((c) => c.url === '/v1/auth/login').length, before, 'no password went to the Hub');
  hubUp = false;
  try {
    const r = await signin();
    assert.equal(r.status, 503);
    assert.equal(r.body.hubUnreachable, true);
    assert.equal(r.body.localAvailable, true);
    assert.equal((await signin({ mode: 'local', password: 'wrong local password!!' })).status, 401);
    assert.equal((await signin({ mode: 'local', password: LOCAL_PW, passphrase: 'wrong passphrase' })).status, 401);
    const ok = await signin({ mode: 'local', password: LOCAL_PW });
    assert.equal(ok.status, 200);
    await call('POST', '/v1/vault/lock', ok.body.token);
    // Rate-limited per account: five wrong tries lock that account's local sign-in for a while.
    for (let i = 0; i < 5; i++) assert.equal((await signin({ mode: 'local', password: `wrong guess number ${i}` })).status, 401);
    assert.equal((await signin({ mode: 'local', password: LOCAL_PW })).status, 429);
  } finally { hubUp = true; }
  // ...but the Hub sign-in (password and two-step code at the Hub) still works for that account.
  const viaHub = await signin();
  assert.equal(viaHub.status, 200, 'someone else’s wrong local tries don’t lock out the Hub sign-in');
  token = viaHub.body.token;
  localOn = false;
});

test('M2: wrong tries by anyone else never lock out the payroll admin who signs in at the Hub', async () => {
  await call('POST', '/v1/vault/lock', token);
  // The red team's lockout: many wrong guesses, any emails, any passphrases.
  for (let i = 0; i < 12; i++) {
    assert.equal((await call('POST', '/v1/vault/signin', null, { email: `x${i}@x.example`, password: 'x', passphrase: `wrong-${i}` })).status, 401);
    assert.equal((await signin({ password: `guess-${i}`, passphrase: `wrong-${i}` })).status, 401);
  }
  const ok = await signin();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await call('POST', '/v1/vault/lock', ok.body.token);
  // The admin's own wrong passphrases (after the Hub sign-in) are limited for that admin.
  for (let i = 0; i < 5; i++) assert.equal((await signin({ passphrase: `not it ${i}` })).status, 401);
  assert.equal((await signin()).status, 429);
});

test('M3: pay amounts, birthdates and emails are sealed in the database file; the app reads them as usual', async () => {
  // A fresh vault (the one above is rate-limited now).
  const d = mkdtempSync(join(tmpdir(), 'keas-vault-m3-'));
  const a2 = createApp({ dbFile: join(d, 'payroll-vault.db'), log: false, vault: true, hubUrl: hubBase });
  const b2 = `http://127.0.0.1:${await a2.listen(0)}`;
  const c2 = async (method, path, t, body) => { const r = await fetch(b2 + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const s = await c2('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Lone Star Camp', state: 'TX', tz: 'America/Chicago' }, admin: { name: 'Pat Lee', email: ACCOUNT.email }, signIn: { password: ACCOUNT.password } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const t = s.body.token;
    const p = await c2('POST', '/v1/people', t, { name: 'Alice Employee', email: 'alice.home@example.net', birthdate: '1990-04-17', hireDate: '2030-05-01', payRateCents: 4321, status: 'active', pii: { ssn: '123-45-6701' } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const id = p.body.profile.id;
    assert.equal((await c2('POST', `/v1/people/${id}/rates`, t, { kind: 'salary', rateCents: 5678000 })).status, 201);
    const prof = (await c2('GET', `/v1/people/${id}/profile`, t)).body.profile;
    assert.deepEqual([prof.email, prof.birthdate, prof.payRateCents], ['alice.home@example.net', '1990-04-17', 4321], 'the app sees the values');
    const org = (await c2('GET', '/v1/org', t)).body;
    assert.equal(org.people.find((x) => x.id === id).payRateCents, 4321);
    await c2('POST', '/v1/vault/lock', t);
  } finally { await a2.close(); }
  try {
    // The file itself (and its write-ahead log): sealed values only, no plaintext anywhere.
    const db = new DatabaseSync(join(d, 'payroll-vault.db'), { readOnly: true });
    const row = db.prepare(`SELECT email, birthdate, pay_rate_cents, ytd_wages_cents FROM people WHERE name = 'Alice Employee'`).get();
    for (const [k, v] of Object.entries(row)) assert.ok(isSealed(v), `${k} is sealed`);
    for (const r of db.prepare('SELECT rate_cents FROM pay_rates').all()) assert.ok(isSealed(r.rate_cents));
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM pay_rates').get().n >= 1);
    db.close();
    const raw = Buffer.concat(['payroll-vault.db', 'payroll-vault.db-wal'].map((f) => join(d, f)).filter(existsSync).map((f) => readFileSync(f)));
    for (const needle of ['alice.home@example.net', '1990-04-17', '123-45-6701', '123456701']) assert.equal(raw.indexOf(Buffer.from(needle)), -1, `${needle} isn't in the file`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('M3: rows written before sealing are sealed when the vault opens, and old plaintext is cleared from the file', () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-vault-mig-'));
  try {
    const file = join(d, 'old.db');
    let h = openDb(file);
    let v = makeVault(h);
    v.create(PASS);
    h.run(`INSERT INTO orgs (id,name,state,tz,pay_period_anchor) VALUES ('o1','Org','CO','America/Denver','2030-01-06')`);
    // As an older KeaS wrote them: plain values (the sealing triggers didn't exist yet).
    for (const r of h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'seal_%'").all()) h.db.exec(`DROP TRIGGER ${r.name}`);
    h.run(`INSERT INTO people (id,org_id,name,email,birthdate,pay_rate_cents) VALUES ('p1','o1','Old Row','old.row@example.net','1985-12-24',2500)`);
    h.run(`INSERT INTO pay_rates (id,person_id,kind,rate_cents,effective_from,created_at) VALUES ('r1','p1','hourly',2500,'2030-01-01','2030-01-01')`);
    h.close();
    h = openDb(file);
    v = makeVault(h);
    assert.equal(v.unlock(PASS), true);
    const p = h.get(`SELECT * FROM people WHERE id = 'p1'`);
    assert.deepEqual([p.email, p.birthdate, p.pay_rate_cents], ['old.row@example.net', '1985-12-24', 2500]);
    assert.equal(h.get(`SELECT rate_cents FROM pay_rates WHERE id = 'r1'`).rate_cents, 2500);
    const raw = h.db.prepare(`SELECT email, birthdate, pay_rate_cents FROM people WHERE id = 'p1'`).get();
    for (const x of Object.values(raw)) assert.ok(isSealed(x));
    v.lock();
    assert.throws(() => h.get(`SELECT * FROM people WHERE id = 'p1'`), /locked/, 'locked: sealed values can’t be read');
    assert.throws(() => h.run(`UPDATE people SET birthdate = '2000-01-01' WHERE id = 'p1'`), /locked/, 'locked: nothing can be written unsealed');
    h.close();
    const bytes = Buffer.concat([file, file + '-wal'].filter(existsSync).map((f) => readFileSync(f)));
    for (const needle of ['old.row@example.net', '1985-12-24']) assert.equal(bytes.indexOf(Buffer.from(needle)), -1, needle);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('M1: the organization server never writes its vault key next to the database', async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-org-'));
  try {
    const file = join(d, 'org.db');
    // Without a passphrase from the KeaS app it refuses to start, rather than writing a key file.
    assert.throws(() => createApp({ dbFile: file, log: false, devKeyFile: false }), /passphrase/);
    const a = createApp({ dbFile: file, log: false, devKeyFile: false, passphrase: 'a passphrase from DPAPI-protected settings' });
    await a.close();
    assert.ok(!existsSync(file + '.vaultkey'));
    // Reopened with the same passphrase: the data is there; with none, it doesn't open.
    const b2 = createApp({ dbFile: file, log: false, devKeyFile: false, passphrase: 'a passphrase from DPAPI-protected settings' });
    assert.ok(b2.h.get('SELECT COUNT(*) AS n FROM people').n > 0);
    await b2.close();
    assert.throws(() => createApp({ dbFile: file, log: false, devKeyFile: false }), /passphrase/);
    assert.ok(!existsSync(file + '.vaultkey'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the vault works with real data: an employee’s SSN and bank are sealed; changing the passphrase re-encrypts', async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-vault-real-'));
  const a2 = createApp({ dbFile: join(d, 'v.db'), log: false, vault: true, hubUrl: hubBase });
  const b2 = `http://127.0.0.1:${await a2.listen(0)}`;
  const c2 = async (method, path, t, body) => { const r = await fetch(b2 + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const sign = (passphrase) => c2('POST', '/v1/vault/signin', null, { email: ACCOUNT.email, password: ACCOUNT.password, passphrase });
  try {
    const t = (await c2('POST', '/v1/vault/setup', null, { passphrase: PASS, org: { name: 'Lone Star Camp', state: 'TX', tz: 'America/Chicago' }, admin: { name: 'Pat Lee', email: ACCOUNT.email }, signIn: { password: ACCOUNT.password } })).body.token;
    const p = await c2('POST', '/v1/people', t, { name: 'Jamie Cruz', hireDate: '2030-05-01', payRateCents: 1600, status: 'active', pii: { ssn: '123-45-6701' } });
    assert.equal(p.status, 201);
    await c2('POST', `/v1/people/${p.body.profile.id}/deposit`, t, { routing: '990000013', account: '11112222' });
    const raw = () => a2.h.db.prepare('SELECT pii_enc, deposit, pay_rate_cents FROM people WHERE id = ?').get(p.body.profile.id);
    const row = raw();
    assert.ok(!row.pii_enc.includes('6701') && !row.deposit.includes('11112222'));
    assert.equal((await c2('POST', '/v1/vault/passphrase', t, { current: 'wrong passphrase!!', next: 'a brand new vault passphrase' })).status, 401);
    assert.equal((await c2('POST', '/v1/vault/passphrase', t, { current: PASS, next: 'a brand new vault passphrase' })).status, 200);
    assert.notEqual(raw().pii_enc, row.pii_enc);
    assert.notEqual(raw().pay_rate_cents, row.pay_rate_cents, 'sealed values are re-encrypted too');
    assert.equal((await c2('POST', `/v1/people/${p.body.profile.id}/reveal-ssn`, t)).body.ssn, '123-45-6701');
    await c2('POST', '/v1/vault/lock', t);
    assert.equal((await sign(PASS)).status, 401);
    const ok = await sign('a brand new vault passphrase');
    assert.equal(ok.status, 200);
    assert.equal((await c2('GET', `/v1/people/${p.body.profile.id}/profile`, ok.body.token)).body.profile.payRateCents, 1600);
    // A Texas org has no state tax table yet: the run shows that and can't be finalized.
    const pr = (await c2('GET', '/v1/payrun/preview', ok.body.token)).body;
    assert.ok(pr.tables.some((x) => x.key === 'tax:TX' && x.missing));
    assert.equal(pr.canFinalize, false);
    // Hours imported into the vault become timecards and pay.
    const me = (await c2('GET', '/v1/me', ok.body.token)).body;
    const ps = me.period.lastCompleted.start;
    const day = (n) => new Date(Date.parse(ps + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const csv = `Employee,Date,In,Out,Position\r\nJamie Cruz,${day(1)},8:00 AM,4:30 PM,Counselor\r\nJamie Cruz,${day(2)},08:00,18:00,Counselor\r\n`;
    assert.equal((await c2('POST', '/v1/import/preview', ok.body.token, { kind: 'hours', csv })).body.matched, 2);
    assert.equal((await c2('POST', '/v1/import/commit', ok.body.token, { kind: 'hours', csv })).body.updated, 2);
    assert.equal((await c2('POST', '/v1/import/commit', ok.body.token, { kind: 'hours', csv })).body.skipped, 2, 'importing twice adds nothing');
    const pid = p.body.profile.id;
    const tc = (await c2('GET', `/v1/timecards?personId=${pid}&periodStart=${ps}`, ok.body.token)).body;
    assert.equal(tc.totals.workedMin, 8.5 * 60 + 10 * 60);
    const run = (await c2('GET', `/v1/payrun/preview?periodStart=${ps}`, ok.body.token)).body;
    assert.equal(run.lines.find((l) => l.personId === pid).gross, Math.round(18.5 * 1600));
  } finally { await a2.close(); rmSync(d, { recursive: true, force: true }); }
});
