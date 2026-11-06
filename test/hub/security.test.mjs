// Regression tests for the Hub security fixes (2026-11): request bodies before sign-in, answer keys, storage quota
// races, stored names Kea would decode into something else, client-address parsing and its warnings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { clientAddress, cleanIp, ipBucket } from '../../hub/lib/clientip.mjs';
import { failures, globalLockFor, GLOBAL_FREE, GLOBAL_IPS, GLOBAL_MAX_LOCK_MS } from '../../hub/lib/limiter.mjs';
import { payrollKey, payrollValue, checkNoPayroll, MAX_NODES } from '../../hub/org/payroll.mjs';

test('a record id is never taken for an SSN (the org tests that failed now and then: about 1% of random ids did)', () => {
  assert.equal(payrollValue('0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc'), false);
  assert.equal(payrollValue('see 0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc'), false);
  // A real one next to an id still counts.
  assert.equal(payrollValue('0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc 123-45-6789'), true);
  assert.equal(payrollValue('123456789'), true);
});
import { openDb } from '../../hub/db.mjs';

let hub, base, ownerBase, dir;
let clock = Date.UTC(2026, 10, 6, 15);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-hub-sec-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', defaultQuotaBytes: 1000, minFreeBytes: 0, fileOverheadBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });
async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const owner = async (method, path, body) => {
  const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body);
  return { status: r.status, body: await r.json() };
};
async function person(email, name = 'Pat') {
  const t = (await call('GET', '/v1/terms')).body.terms;
  const r = await call('POST', '/v1/auth/register', null, { email, password: 'lantern velvet orbit', displayName: name, age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }, freshIp());
  assert.equal(r.status, 202);
  const s = await call('POST', '/v1/auth/login', null, { email, password: 'lantern velvet orbit' }, freshIp());
  assert.equal(s.status, 200);
  return s.body.token;
}

/** Sends the headers and the first `sendBytes` of a body announced as `length` bytes; resolves with the answer. */
function partialPost(path, length, sendBytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(length), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(sendBytes, 0x20));
    // (The rest is never sent: if the Hub waited for the whole body before answering, this would hang.)
  });
}

test('before sign-in, a request body is never taken in: a 3 MB relay answer without a session is refused at once', async () => {
  const r = await partialPost('/v1/scan/x/calls/y/result', 3 * 1024 * 1024, 64 * 1024);
  assert.equal(r.status, 401);
  assert.equal(r.connection, 'close');
  // Sign-in itself only reads small bodies.
  const big = await partialPost('/v1/auth/login', 3 * 1024 * 1024, 1024, freshIp());
  assert.equal(big.status, 413);
});

test('the big relay-answer limit is only for the person whose job is running', async () => {
  const t = await person('relay-cap@example.com');
  // Signed in, but no running job of theirs: the usual 2 MB limit, refused from the announced size alone.
  const r = await partialPost('/v1/scan/nope/calls/y/result', 3 * 1024 * 1024, 1024, { authorization: `Bearer ${t}` });
  assert.equal(r.status, 413);
});

test('leaderboard sets never hand out the answer key for a wrong answer', async () => {
  const teach = await person('sec-teach@example.com', 'Tia');
  await owner('POST', '/owner/accounts/sec-teach@example.com', { canHost: true });
  const cls = (await call('POST', '/v1/classes', teach, { title: 'Harvest 101' })).body.class;
  const code = (await call('POST', `/v1/classes/${cls.id}/invites`, teach, {})).body.code;
  const s = await person('sec-student@example.com', 'Sam');
  await call('POST', '/v1/join', s, { code });
  const qs = Array.from({ length: 5 }, (_, i) => ({ q: `Q${i}?`, choices: ['a', 'b', 'c', 'd'], answer: i % 4, why: `because ${i}` }));
  const graded = (await call('POST', `/v1/classes/${cls.id}/sets`, teach, { title: 'Graded', questions: qs })).body.id;
  const practice = (await call('POST', `/v1/classes/${cls.id}/sets`, teach, { title: 'Practice', questions: qs, leaderboard: false })).body.id;

  // The harvest: answer every question with a (probably) wrong choice and collect what comes back.
  const view = (await call('GET', `/v1/sets/${graded}`, s)).body.questions;
  const leaked = [];
  for (const [i, q] of view.entries()) {
    const wrong = (i % 4 + 1) % 4;
    const r = await call('POST', `/v1/sets/${graded}/answer`, s, { questionId: q.id, choice: wrong });
    assert.equal(r.body.correct, false);
    assert.equal(r.body.again, true);
    if ('answer' in r.body || 'why' in r.body) leaked.push(i);
  }
  assert.deepEqual(leaked, [], 'nothing about the right answers came back');
  // Getting it right shows the answer and why; after that (not scoring until it's due again) a wrong pick shows it.
  const q0 = view[0];
  const right = await call('POST', `/v1/sets/${graded}/answer`, s, { questionId: q0.id, choice: 0 });
  assert.deepEqual([right.body.correct, right.body.answer, right.body.why], [true, 0, 'because 0']);
  const later = await call('POST', `/v1/sets/${graded}/answer`, s, { questionId: q0.id, choice: 3 });
  assert.deepEqual([later.body.correct, later.body.scoring, later.body.answer], [false, false, 0]);
  // Practice-only sets (no leaderboard) still explain a wrong answer straight away.
  const pv = (await call('GET', `/v1/sets/${practice}`, s)).body.questions;
  const p = await call('POST', `/v1/sets/${practice}/answer`, s, { questionId: pv[1].id, choice: 0 });
  assert.deepEqual([p.body.correct, p.body.answer, p.body.why], [false, 1, 'because 1']);
  // The instructor sees answers anyway.
  const tw = await call('POST', `/v1/sets/${graded}/answer`, teach, { questionId: view[2].id, choice: 0 });
  assert.equal(tw.body.answer, 2);
});

test('uploads at the same time cannot squeeze past the storage limit together', async () => {
  const t = await person('race@example.com');
  // 1000-byte limit in this Hub: eight 300-byte files at once; at most three fit.
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`${base}/v1/files/race-${i}.bin`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: Buffer.alloc(300, i) })));
  const ok = results.filter((r) => r.status === 201).length;
  assert.ok(ok <= 3, `${ok} uploads went through`);
  // (507: full; 429: more than two uploads at once for one account.)
  assert.ok(results.every((r) => [201, 507, 429].includes(r.status)), results.map((r) => r.status).join(','));
  const list = await call('GET', '/v1/files', t);
  assert.ok(list.body.used <= 1000, `used ${list.body.used}`);
});

test('stored names that Kea would decode into "..", a separator, a drive or a device name are refused', async () => {
  const t = await person('names@example.com');
  const put = (p) => fetch(`${base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: 'x' });
  for (const p of ['kea/~2e~~2e~/x', 'kea/~2e~', 'kea/a~2f~b', 'kea/a~5c~b', 'kea/C~3a~', 'kea/a~0~b', 'kea/~1f~', 'kea/CON', 'kea/aux.json', 'kea/n~75~l.txt', 'kea/com1', 'kea/~110000~'])
    assert.equal((await put(p)).status, 400, p);
  // Ordinary encoded characters are fine: "What is it~3f~.md" is "What is it?.md" in Kea.
  for (const p of [encodeURIComponent('kea/What is it~3f~.md').replace(/%2F/g, '/'), 'kea/a~7e~b', 'kea/console.txt'])
    assert.equal((await put(p)).status, 201, p);
});

test('client address: only the last X-Forwarded-For entry, only when configured, malformed values ignored', () => {
  // (X-Forwarded-For counts only on requests Tailscale Funnel marked as its own.)
  const h = (v) => ({ 'x-forwarded-for': v, 'tailscale-funnel-request': '?1' });
  const local = clientAddress({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', 'x-forwarded-for');
  assert.deepEqual(local, { ip: '127.0.0.1', shared: true, forwardedUntrusted: false }, 'a local program can’t pick its own address');
  assert.equal(clientAddress({ 'x-forwarded-for': '1.2.3.4', 'tailscale-funnel-request': '?0' }, '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1');
  // Another proxy's header, configured on purpose, is trusted as configured.
  assert.equal(clientAddress({ 'cf-connecting-ip': '9.9.9.9' }, '127.0.0.1', 'cf-connecting-ip').ip, '9.9.9.9');
  assert.deepEqual(clientAddress(h('1.2.3.4'), '127.0.0.1', 'x-forwarded-for'), { ip: '1.2.3.4', shared: false, forwardedUntrusted: false });
  assert.equal(clientAddress(h('6.6.6.6, 203.0.113.9'), '127.0.0.1', 'x-forwarded-for').ip, '203.0.113.9', 'earlier entries can be faked');
  assert.equal(clientAddress(h('203.0.113.9, garbage'), '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1', 'a malformed last entry is not used');
  assert.equal(clientAddress(h('203.0.113.9, garbage'), '127.0.0.1', 'x-forwarded-for').shared, true);
  assert.equal(clientAddress(h('1.2.3.4:5678'), '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1', 'ports are not part of an address');
  assert.equal(clientAddress(h('[2001:db8::1]'), '127.0.0.1', 'x-forwarded-for').ip, '2001:db8::1');
  assert.equal(clientAddress(h('::ffff:198.51.100.2'), '127.0.0.1', 'x-forwarded-for').ip, '198.51.100.2');
  assert.equal(clientAddress({}, '::ffff:127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1');
  // Not configured: the header is never trusted, and its presence is a setup warning.
  const u = clientAddress({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', null);
  assert.deepEqual(u, { ip: '127.0.0.1', shared: true, forwardedUntrusted: true });
  assert.deepEqual(clientAddress({}, '127.0.0.1', null), { ip: '127.0.0.1', shared: false, forwardedUntrusted: false });
  assert.equal(clientAddress({ 'tailscale-funnel-request': '?1' }, '127.0.0.1', null).forwardedUntrusted, true);
  assert.equal(cleanIp('fe80::1%eth0'), null);
  assert.equal(cleanIp('x'.repeat(100)), null);
  // IPv6 addresses count by their /64.
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), ipBucket('2001:db8:1:2:bbbb::2'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
});

test('a Hub behind a proxy with no address header set warns in /owner/stats, and loosens per-address limits', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-hub-sec2-'));
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  const h2 = createHub({ dataDir: d, log: false, ipHeader: null, minFreeBytes: 0 });
  try {
    const p = await h2.listen({ port: 0, ownerPort: 0 });
    const stats = async () => (await (await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, h2.ownerKey, 'GET', '/owner/stats')).json()).clientAddress;
    assert.deepEqual(await stats(), { header: null, warnings: [] });
    // 31 sign-in tries through "the proxy": everyone looks like 127.0.0.1, so the 30-per-address limit is raised for it.
    let last;
    for (let i = 0; i < 31; i++) last = await fetch(`http://127.0.0.1:${p.port}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${i}` }, body: JSON.stringify({ email: `p${i}@example.com`, password: 'x' }) });
    assert.equal(last.status, 401, 'not a Hub-wide lockout');
    const s = await stats();
    assert.deepEqual(s.warnings.map((w) => w.code), ['forwarded']);
    assert.equal(warned.filter((m) => /KEA_HUB_IP_HEADER/.test(m)).length, 1, 'logged once');
  } finally {
    console.warn = warn;
    await h2.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('lockout bookkeeping: per address, then everywhere only after many failures from many addresses', () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-hub-sec3-'));
  const db = openDb(join(d, 'x.db'));
  try {
    let t = 1_000_000;
    const f = failures(db, () => t);
    for (let i = 0; i < 5; i++) f.fail('n', '1.1.1.1');
    assert.ok(f.pairLocked('n', '1.1.1.1') > 0, 'one address gets locked');
    assert.equal(f.pairLocked('n', '2.2.2.2'), 0, 'another address is not');
    assert.equal(f.globalLocked('n'), 0, 'and the name is not locked everywhere');
    // Many failures from one address alone never lock the name everywhere.
    for (let i = 0; i < 200; i++) f.fail('n', '1.1.1.1');
    assert.equal(f.globalLocked('n'), 0);
    // Spread over GLOBAL_IPS addresses, past GLOBAL_FREE: locked everywhere, for at most GLOBAL_MAX_LOCK.
    for (let i = 0; i < GLOBAL_IPS; i++) f.fail('n', `3.3.3.${i}`);
    assert.ok(f.globalLocked('n') > 0);
    assert.ok(f.globalLocked('n') <= GLOBAL_MAX_LOCK_MS);
    assert.equal(globalLockFor(GLOBAL_FREE - 1, 100), 0);
    assert.equal(globalLockFor(GLOBAL_FREE + 100, GLOBAL_IPS - 1), 0);
    assert.equal(globalLockFor(GLOBAL_FREE + 100, GLOBAL_IPS), GLOBAL_MAX_LOCK_MS);
    f.clearAll('n');
    assert.equal(f.globalLocked('n'), 0);
    assert.equal(f.pairLocked('n', '1.1.1.1'), 0);
  } finally {
    db.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('payroll guard: disguised keys, SSN- and bank-shaped values, no depth limit, oversize refused', () => {
  for (const k of ['ssn', 'SSN', 'ѕѕn', 'ｓｓｎ', 's.s.n', 'S_S_N', 'socialSecurityNumber', 'bank_account', 'ΒankΑccount', 'routingNo', 'w4', 'directDeposit', 'payRuns', 'acct_no'])
    assert.equal(payrollKey(k), true, k);
  for (const k of ['className', 'assigned', 'waiting', 'notes', 'account', 'bank', 'route', 'payRate', 'session'])
    assert.equal(payrollKey(k), false, k);
  for (const v of ['123-45-6789', '123456789', 'SSN: 123-45-6789', '123 45 6789', '１２３-４５-６７８９', 'routing 102000021, account 000123456789'])
    assert.equal(payrollValue(v), true, v);
  for (const v of ['719-555-0134', '2026-12-01', '80202-1234', '1234567890', 'shift 9-5', '12345678'])
    assert.equal(payrollValue(v), false, v);
  const refuse = () => { throw new Error('refused'); };
  const tooBig = () => { throw new Error('too big'); };
  let deep = { bankAccount: 1 };
  for (let i = 0; i < 1000; i++) deep = [deep];
  assert.throws(() => checkNoPayroll({ x: deep }, refuse, tooBig), /refused/);
  assert.throws(() => checkNoPayroll({ list: Array.from({ length: MAX_NODES + 1 }, () => 1) }, refuse, tooBig), /too big/);
  checkNoPayroll({ a: [{ b: 'fine' }] }, refuse, tooBig);
});
