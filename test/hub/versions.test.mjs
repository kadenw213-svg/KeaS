// Versions (docs/protocol.md section 0) on the KeaS server: /v1/health says the protocol, the oldest app versions
// served and the newest released; a Kea that says it's older than the minimum gets a plain 426 with where to update;
// a Kea that says nothing (every Kea before this) is served as before; the operator can change both (Advanced); KeaS
// says who it is to KeaC, and when KeaC says KeaS is too old, the KeaS app is told.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { createKeac } from '../../hub/lib/keac.mjs';
import { fakeKeac } from '../helpers/keac.mjs';
import { MIN_CLIENTS, PROTOCOL } from '../../hub/lib/clients.mjs';

const closers = [];
after(async () => { for (const c of closers.reverse()) await c(); });

async function start(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keas-versions-'));
  const keac = await fakeKeac();
  const hub = createHub({ dataDir: dir, log: false, minFreeBytes: 0, keacUrl: keac.url, keacKeys: [keac.key.jwk], ...opts });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  closers.push(async () => { await hub.close(); await keac.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${p.port}`, ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  const call = async (path, client, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(client ? { 'x-kea-client': client } : {}), ...(init.headers || {}) } });
    return { status: r.status, body: await r.json() };
  };
  const owner = async (method, path, body) => { const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body); return { status: r.status, body: await r.json() }; };
  return { hub, call, owner, keac };
}

test('health says the protocol, the minimums and the newest versions; a too-old Kea gets 426, others are served as before', async () => {
  const { call } = await start({ minClients: { kea: '0.85.0' }, latest: { kea: '0.85.3' } });
  const h = (await call('/v1/health', 'Kea/0.10.0')).body;
  assert.equal(h.protocol, PROTOCOL);
  assert.deepEqual(h.minClients, { ...MIN_CLIENTS, kea: '0.85.0' });
  assert.equal(h.latest.kea, '0.85.3');
  assert.match(h.latest.keas, /^\d+\.\d+\.\d+$/, 'at least this server’s own version');
  assert.equal(h.latest.keas, h.version);
  assert.match(h.updateUrls.keaPhone, /releases\/latest$/);
  assert.equal(h.service, 'keas', 'what older Kea read is still there');
  const nonce = 'n0nce-0123456789abcdef';
  const old = await call(`/v1/identity?nonce=${nonce}`, 'Kea/0.84.1');
  assert.equal(old.status, 426);
  assert.deepEqual(old.body, { error: 'Update Kea to keep using this organization’s server.', upgradeRequired: true, app: 'kea', version: '0.84.1', minVersion: '0.85.0', updateUrl: h.updateUrls.kea });
  const phone = await call('/v1/auth/pass', 'Kea-Phone/0.70.0', { method: 'POST', body: '{}' });
  assert.equal(phone.status, 426);
  assert.equal(phone.body.app, 'keaPhone');
  for (const c of [null, 'Kea/0.85.0', 'Kea for Android', 'Kea/2.0.0']) assert.equal((await call(`/v1/identity?nonce=${nonce}`, c)).status, 200, String(c));
});

test('the operator changes the minimums and the newest versions (Advanced)', async () => {
  const { call, owner } = await start();
  const before = (await owner('GET', '/owner/settings')).body.clients;
  assert.deepEqual(before.minClients, MIN_CLIENTS);
  assert.equal((await owner('POST', '/owner/settings', { clients: { minClients: { kea: 'next week' } } })).status, 400);
  const s = (await owner('POST', '/owner/settings', { clients: { minClients: { kea: '0.90.0' }, latest: { kea: '0.91.0' } } })).body.clients;
  assert.equal(s.minClients.kea, '0.90.0');
  assert.equal(s.latest.kea, '0.91.0');
  assert.equal((await call('/v1/identity?nonce=n0nce-0123456789abcdef', 'Kea/0.89.9')).status, 426);
  (await owner('POST', '/owner/settings', { clients: { minClients: { kea: null } } }));
  assert.equal((await call('/v1/identity?nonce=n0nce-0123456789abcdef', 'Kea/0.89.9')).status, 200);
});

test('KeaS says who it is to KeaC, and remembers when KeaC says KeaS is too old until KeaC answers normally', async () => {
  const seen = [];
  let tooOld = true;
  const srv = http.createServer((q, s) => {
    seen.push(q.headers['x-kea-client']);
    s.writeHead(tooOld ? 426 : 200, { 'content-type': 'application/json' });
    s.end(JSON.stringify(tooOld ? { error: 'Update KeaS to keep signing people in with their Kea accounts.', upgradeRequired: true, app: 'keas', minVersion: '0.9.0', updateUrl: 'https://example.org/keas' } : { keys: [] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(r)));
  const store = new Map();
  const k = createKeac({ url: () => `http://127.0.0.1:${srv.address().port}`, builtIn: [], store: { get: (key, d) => (store.has(key) ? store.get(key) : d), set: (key, v) => store.set(key, v) }, revoked: { has: () => false, count: () => 0, add() {}, set() {} }, client: 'KeaS/0.8.2' });
  assert.equal(await k.refreshKeys(), false);
  assert.equal(seen[0], 'KeaS/0.8.2');
  assert.deepEqual({ ...k.status().updateRequired, at: 0 }, { error: 'Update KeaS to keep signing people in with their Kea accounts.', minVersion: '0.9.0', updateUrl: 'https://example.org/keas', at: 0 });
  assert.match(k.status().keysError || '', /Update KeaS/);
  tooOld = false;
  await k.refreshKeys();
  assert.equal(k.status().updateRequired, null);
  k.stop?.();
});
