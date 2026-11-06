// Slow and heavy traffic (hub/lib/flow.mjs): the verification pass's memory and slot tests, with short limits so they run fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { jsonParts } from '../../hub/lib/flow.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHub(flow, fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kea-flow-'));
  const hub = createHub({ dataDir: dir, log: false, ipHeader: 'cf-connecting-ip', flow, limits: { rps: [5000, 5000], rpsAll: [50000, 50000], writes: [5000, 5000], register: [1000, 1000], login: [1000, 1000] }, ...opts });
  const { port, ownerPort } = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { token, body, raw, ip = '203.0.113.9' } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(bytes); } catch {}
    return { status: r.status, json, bytes, headers: r.headers };
  };
  const stats = async () => (await (await ownerFetch(`http://127.0.0.1:${ownerPort}`, hub.ownerKey, 'GET', '/owner/stats')).json()).busy;
  let n = 0;
  const account = async () => {
    const t = (await call('GET', '/v1/terms')).json.terms;
    const email = `flow${++n}@example.com`, password = 'correct horse battery staple 9';
    const reg = await call('POST', '/v1/auth/register', { body: { email, password, displayName: 'Tester', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) } });
    assert.equal(reg.status, 202, JSON.stringify(reg.json));
    const l = await call('POST', '/v1/auth/login', { body: { email, password } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    return { token: l.json.token, id: l.json.account.id };
  };
  const fill = (a, count, pad = '') => hub.h.tx(() => { for (let i = 0; i < count; i++) hub.h.run('INSERT INTO files (account_id,path,blob,size,version,sha256,updated_at) VALUES (?,?,?,?,?,?,?)', a.id, `many/${pad}f${String(i).padStart(6, '0')}.txt`, 'nope', 0, 1, 'e3b0c442', Date.now()); });
  const raw = (head, opts2 = {}) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.text = '';
    if (!opts2.paused) s.on('data', (d) => { s.text += d; });
    s.gone = new Promise((r) => s.on('close', r));
    if (head) s.write(head);
    return s;
  };
  try { await fn({ hub, base, call, stats, account, fill, raw, port }); } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }); }
}
const closedWithin = (s, ms) => Promise.race([s.gone.then(() => true), sleep(ms).then(() => false)]);
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

test('jsonParts: the same JSON as JSON.stringify, whatever the cuts, characters kept whole', () => {
  const emoji = '\u{1F600}'.repeat(100);
  const parts = [...jsonParts([['a', 1], ['b', () => ({ x: [1, 2] })], ['skip', undefined], ['c', (function* () { yield { p: emoji }; yield 2; })()], ['long', emoji], ['z', () => null]], 7)];
  assert.ok(parts.length > 5);
  assert.deepEqual(JSON.parse(Buffer.concat(parts)), { a: 1, b: { x: [1, 2] }, c: [{ p: emoji }, 2], long: emoji, z: null });
  assert.deepEqual(JSON.parse(Buffer.concat([...jsonParts([['c', (function* () {})()]])])), { c: [] });
  assert.deepEqual(JSON.parse(Buffer.concat([...jsonParts([])])), {});
});

test('M: a long file list is streamed with the fields Kea and the phone read, pages still work, exports too', async () => {
  await withHub({ listBatch: 100 }, async ({ call, account, fill }) => {
    const a = await account();
    fill(a, 350);
    const all = await call('GET', '/v1/files', { token: a.token });
    assert.equal(all.status, 200);
    assert.equal(all.headers.get('content-length'), null, 'written as it goes');
    assert.equal(all.json.files.length, 350);
    assert.deepEqual(Object.keys(all.json.files[0]), ['path', 'size', 'version', 'sha256', 'updatedAt']);
    assert.equal(typeof all.json.now, 'number');
    assert.equal(typeof all.json.quota, 'number');
    assert.equal(typeof all.json.used, 'number');
    assert.ok(!('next' in all.json));
    // The same filters as a short list.
    assert.equal((await call('GET', '/v1/files?prefix=nothing/', { token: a.token })).json.files.length, 0);
    assert.equal((await call('GET', `/v1/files?since=${Date.now() + 1000}`, { token: a.token })).json.files.length, 0);

    // Long pages: 150 at a time (over one batch), to the end.
    const seen = [];
    let after = '';
    for (let i = 0; i < 5; i++) {
      const p = (await call('GET', `/v1/files?limit=150&after=${encodeURIComponent(after)}`, { token: a.token })).json;
      seen.push(...p.files.map((f) => f.path));
      if (p.next == null) break;
      after = p.next;
    }
    assert.equal(seen.length, 350);
    assert.equal(new Set(seen).size, 350);
    // A page ending exactly at the end says there's no next one.
    assert.equal((await call('GET', `/v1/files?limit=150&after=${encodeURIComponent(seen[199])}`, { token: a.token })).json.next, null);

    const ex = await call('GET', '/v1/me/export', { token: a.token });
    assert.equal(ex.status, 200);
    assert.equal(ex.headers.get('content-length'), null);
    assert.equal(ex.json.account.id, a.id);
    assert.equal(ex.json.files.length, 350);
    assert.ok(Array.isArray(ex.json.activity));
  });
});

test('M: long lists run a few at a time, per account and in all, and a client that stops reading loses its place', async () => {
  await withHub({ listBatch: 100, heavyPerAccount: 1, heavyGlobal: 2, minRateWindowMs: 500 }, async ({ call, account, fill, raw, stats }) => {
    const [a, b, c] = [await account(), await account(), await account()];
    const pad = 'x'.repeat(300);
    for (const u of [a, b, c]) fill(u, 40_000, pad);
    const hold = (u, ip) => raw(`GET /v1/files HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${u.token}\r\nCf-Connecting-Ip: ${ip}\r\n\r\n`, { paused: true });
    const h1 = hold(a, '198.51.100.1');
    await sleep(150);
    assert.equal((await call('GET', '/v1/files', { token: a.token })).status, 429, 'per account');
    const h2 = hold(b, '198.51.100.2');
    await sleep(150);
    assert.equal((await call('GET', '/v1/files', { token: c.token })).status, 429, 'in all');
    // A short list isn't held up.
    const d = await account();
    assert.equal((await call('GET', '/v1/files', { token: d.token })).status, 200);
    // The stalled readers are dropped, and the slots come back.
    assert.ok(await until(async () => (await stats()).slowDropped >= 1 || false, 8000));
    assert.ok(await until(async () => (await call('GET', '/v1/files?limit=5', { token: c.token })).status === 200));
    h1.destroy(); h2.destroy();
  });
});

test('M: signed-in bodies: only so many read at once, kept at 2 MB, and a stalled one is dropped quickly', async () => {
  await withHub({ bodiesPerAccount: 1, bodyIdleMs: 300 }, async ({ account, raw }) => {
    const a = await account();
    const post = (len, ip) => `POST /v1/me/notifications/read HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${a.token}\r\nCf-Connecting-Ip: ${ip}\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\n\r\n`;
    const first = raw(post(1_000_000, '198.51.100.10'));
    first.write(Buffer.alloc(20_000, 0x20));
    await sleep(80);
    const second = raw(post(1_000_000, '198.51.100.11'));
    await closedWithin(second, 3000);
    assert.match(second.text, /^HTTP\/1\.1 429/, 'the second waits its turn');
    // Small bodies don't count.
    const small = raw(`${post(2, '198.51.100.12')}{}`);
    await sleep(100);
    assert.doesNotMatch(small.text, /^HTTP\/1\.1 429/);
    small.destroy();
    assert.equal(await closedWithin(first, 3000), true, 'stalled: dropped');
    const big = raw(post(3 * 1024 * 1024, '198.51.100.13'));
    await closedWithin(big, 3000);
    assert.match(big.text, /^HTTP\/1\.1 413/);
  });
});

test('M-L: a connection that says nothing is closed; a slow download and a trickling upload are dropped', async () => {
  await withHub({ noBytesMs: 300, minRateWindowMs: 400, bodyIdleMs: 2000 }, async ({ call, account, raw, stats }) => {
    const silent = raw('');
    assert.equal(await closedWithin(silent, 3000), true, 'the 0-of-20 case');
    // A connection in use isn't cut by that limit.
    const a = await account();
    await sleep(500);
    assert.equal((await call('GET', '/v1/health')).status, 200);

    const big = Buffer.alloc(30 * 1024 * 1024, 7);
    await withBigFile(call, a, big);
    const reader = raw(`GET /v1/files/big.bin HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${a.token}\r\nCf-Connecting-Ip: 198.51.100.20\r\n\r\n`, { paused: true });
    assert.ok(await until(async () => (await stats()).slowDropped >= 1, 10_000), 'slow reader dropped');
    reader.destroy();

    const before = (await stats()).slowDropped;
    const up = raw(`PUT /v1/files/trickle.bin HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${a.token}\r\nCf-Connecting-Ip: 198.51.100.21\r\nContent-Length: ${1024 * 1024}\r\n\r\n`);
    const drip = setInterval(() => { if (!up.destroyed) up.write(Buffer.alloc(100)); }, 50);
    assert.equal(await closedWithin(up, 5000), true, 'trickling upload dropped');
    clearInterval(drip);
    assert.ok((await stats()).slowDropped > before);
    assert.equal((await call('GET', '/v1/files/trickle.bin', { token: a.token })).status, 404);
  });
});
async function withBigFile(call, a, bytes) {
  const r = await call('PUT', '/v1/files/big.bin', { token: a.token, raw: bytes });
  assert.ok(r.status < 300, JSON.stringify(r.json));
}

test('M-L: small PUTs take no upload slot; an in-flight cap per client even when every connection comes from loopback', async () => {
  await withHub({ clientInflight: 3 }, async ({ call, account, raw }) => {
    const a = await account();
    // Three stalled small PUTs from different clients, on one account (its upload slots are 2).
    const stalled = [1, 2, 3].map((i) => raw(`PUT /v1/files/s${i}.txt HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${a.token}\r\nCf-Connecting-Ip: 198.51.100.3${i}\r\nContent-Length: 10\r\n\r\nx`));
    await sleep(150);
    const real = await call('PUT', '/v1/files/real.bin', { token: a.token, raw: Buffer.alloc(100 * 1024, 1) });
    assert.ok(real.status < 300, JSON.stringify(real.json));
    // A real upload still does: with its two slots taken the third waits.
    const big = (ip) => raw(`PUT /v1/files/b${ip}.bin HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${a.token}\r\nCf-Connecting-Ip: 198.51.100.4${ip}\r\nContent-Length: ${1024 * 1024}\r\n\r\nx`);
    const b1 = big(1), b2 = big(2);
    await sleep(150);
    const b3 = big(3);
    await closedWithin(b3, 3000);
    assert.match(b3.text, /^HTTP\/1\.1 429/);
    for (const s of [...stalled, b1, b2]) s.destroy();
    await sleep(100);

    // The in-flight cap, per client address.
    const open = [1, 2, 3].map(() => raw('POST /v1/auth/login HTTP/1.1\r\nHost: x\r\nCf-Connecting-Ip: 198.51.100.50\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
    await sleep(150);
    assert.equal((await call('GET', '/v1/health', { ip: '198.51.100.50' })).status, 429);
    assert.equal((await call('GET', '/v1/health', { ip: '198.51.100.51' })).status, 200, 'other people aren’t');
    for (const s of open) s.destroy();
    assert.ok(await until(async () => (await call('GET', '/v1/health', { ip: '198.51.100.50' })).status === 200), 'and the slots come back');
  });
});

test('M4: small answers count toward the account’s egress: no wait under its share, a wait over it', async () => {
  await withHub({ smallEgressBurstBytes: 40 * 1024 }, async ({ hub, call, account }) => {
    const a = await account();
    assert.equal((await call('PUT', '/v1/files/s16.bin', { token: a.token, raw: Buffer.alloc(16 * 1024, 1) })).status, 201);
    hub.h.run("INSERT INTO settings (key, value) VALUES ('limits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ maxSendMbps: 1 }));
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/v1/files/s16.bin', { token: a.token })).status, 200);
    // 160 KB at 1 Mb/s (125 KB/s) with 40 KB up front: about a second.
    const ms = Date.now() - t0;
    assert.ok(ms >= 600, `took ${ms} ms`);
  });
});
