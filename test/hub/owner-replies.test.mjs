// The owner console's answers prove they came from the Hub, its challenges can't be flooded, and a held port is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch, ownerNonces, OwnerReplyError, OWNER_REPLY_HEADER } from '../../hub/lib/ownerauth.mjs';

const HUB_ENTRY = fileURLToPath(new URL('../../hub/index.mjs', import.meta.url));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

test('LOW: a real Hub’s answers verify, including its errors; a wrong key gets a plain failure', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-owner-'));
  const hub = createHub({ dataDir: d, log: false });
  const { ownerPort } = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${ownerPort}`;
  try {
    const ok = await ownerFetch(base, hub.ownerKey, 'GET', '/owner/stats');
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get(OWNER_REPLY_HEADER));
    assert.equal(typeof (await ok.json()), 'object');
    assert.equal((await ownerFetch(base, hub.ownerKey, 'GET', '/owner/no-such-thing')).status, 404);
    const wrong = await ownerFetch(base, 'not-the-key', 'GET', '/owner/stats');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get(OWNER_REPLY_HEADER), null, 'no proof handed out for a failed sign-in');
  } finally { await hub.close(); rmSync(d, { recursive: true, force: true }); }
});

test('LOW: a squatter on the owner port can’t feed made-up answers or replay real ones', async () => {
  let reply = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs: [{ id: 'fake-job' }] }) });
  const seen = [];
  const squat = http.createServer((req, res) => {
    if (req.url === '/owner/nonce') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ nonce: 'a'.repeat(32) })); return; }
    seen.push(req.url);
    const r = reply(req);
    res.writeHead(r.status, r.headers); res.end(r.body);
  });
  const base = await listen(squat);
  try {
    await assert.rejects(ownerFetch(base, 'owner-key', 'GET', '/owner/scan/next'), OwnerReplyError);
    // A proof of some other answer doesn't do.
    reply = () => ({ status: 200, headers: { 'content-type': 'application/json', [OWNER_REPLY_HEADER]: 'b'.repeat(64) }, body: '{}' });
    await assert.rejects(ownerFetch(base, 'owner-key', 'GET', '/owner/scan/next'), OwnerReplyError);
    assert.equal(seen.length, 2);
  } finally { squat.close(); }

  // A real answer, recorded and replayed under the same nonce, fails on the client's own challenge.
  const d = mkdtempSync(join(tmpdir(), 'kea-owner-'));
  const hub = createHub({ dataDir: d, log: false });
  const { ownerPort } = await hub.listen({ port: 0, ownerPort: 0 });
  let recorded = null;
  const mitm = http.createServer(async (req, res) => {
    const up = `http://127.0.0.1:${ownerPort}${req.url}`;
    if (req.url === '/owner/nonce') {
      const n = await fetch(up); const t = await n.text();
      if (!recorded) res.setHeader('x-first', '1');
      if (recorded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ nonce: recorded.nonce })); return; }
      recorded = { nonce: JSON.parse(t).nonce };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(t); return;
    }
    if (recorded.status) { res.writeHead(recorded.status, recorded.headers); res.end(recorded.body); return; }
    const r = await fetch(up, { method: req.method, headers: { 'x-kea-owner-auth': req.headers['x-kea-owner-auth'], 'x-kea-owner-challenge': req.headers['x-kea-owner-challenge'] } });
    recorded.status = r.status;
    recorded.body = await r.text();
    recorded.headers = { 'content-type': 'application/json', [OWNER_REPLY_HEADER]: r.headers.get(OWNER_REPLY_HEADER) };
    res.writeHead(recorded.status, recorded.headers); res.end(recorded.body);
  });
  const mbase = await listen(mitm);
  try {
    assert.equal((await ownerFetch(mbase, hub.ownerKey, 'GET', '/owner/stats')).status, 200);
    await assert.rejects(ownerFetch(mbase, hub.ownerKey, 'GET', '/owner/stats'), OwnerReplyError);
  } finally { mitm.close(); await hub.close(); rmSync(d, { recursive: true, force: true }); }
});

test('LOW: asking for many challenges pushes out the asker’s own oldest, not another caller’s', () => {
  const n = ownerNonces(() => 1000);
  const mine = n.issue('127.0.0.1');
  for (let i = 0; i < 5000; i++) n.issue('127.0.0.2');
  assert.ok(n.sizeFor('127.0.0.2') <= 512);
  assert.ok(n.size() <= 2000);
  assert.ok(n.take(`${mine}.${'0'.repeat(64)}`), 'still there');
  assert.equal(n.sizeFor('127.0.0.1'), 0, 'and counted down when used');
});

test('LOW: a held port is written to logs/hub.log before the Hub exits', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-owner-log-'));
  const blocker = http.createServer(() => {});
  await listen(blocker);
  const port = blocker.address().port;
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  try {
    const code = await new Promise((resolve) => {
      execFile(process.execPath, [HUB_ENTRY], { env: { ...env, KEA_HUB_DATA: d, KEA_HUB_PORT: '0', KEA_HUB_OWNER_PORT: String(port), KEA_HUB_STORAGE: join(d, 'storage') }, timeout: 30_000 }, (e) => resolve(e ? e.code : 0));
    });
    assert.equal(code, 1);
    const log = readFileSync(join(d, 'logs', 'hub.log'), 'utf8');
    assert.match(log, /already in use by another program/);
    assert.equal(existsSync(join(d, 'hub.pid')), false);
  } finally { blocker.close(); rmSync(d, { recursive: true, force: true }); }
});

test('MED: the Hub started by itself won’t serve from a folder KeaS refused', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-owner-refused-'));
  writeFileSync(join(d, '.keas-lockdown-pending'), 'x');
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  try {
    const code = await new Promise((resolve) => {
      execFile(process.execPath, [HUB_ENTRY], { env: { ...env, KEA_HUB_DATA: d, KEA_HUB_PORT: '0', KEA_HUB_OWNER_PORT: '0', KEA_HUB_STORAGE: join(d, 'storage') }, timeout: 30_000 }, (e) => resolve(e ? e.code : 0));
    });
    assert.equal(code, 3);
    assert.equal(existsSync(join(d, 'hub.db')), false, 'nothing was opened');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
