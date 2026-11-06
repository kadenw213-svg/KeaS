// Audit 2026-11-06, section 1 CRITICAL (org role): the pick-a-person sign-in and the sample workplace exist only with
// demo on (development and tests), and every request must be addressed to the server itself (Host allowlist, every
// mode) and come from its own pages (Origin allowlist, never compared with the request's own Host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

/** A raw request, so the Host header can be anything (fetch won't let us set it). */
const raw = (port, method, path, headers = {}, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('without demo: no pick-a-person sign-in and no sample workplace in the database', async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-nodemo-'));
  const app = createApp({ dbFile: join(d, 'org.db'), log: false, passphrase: 'a passphrase from DPAPI-protected settings', devKeyFile: false });
  const port = await app.listen(0);
  try {
    assert.equal(app.h.get('SELECT COUNT(*) AS n FROM people').n, 0, 'nothing seeded');
    const host = `127.0.0.1:${port}`;
    assert.equal((await raw(port, 'GET', '/v1/auth/demo-users', { host })).status, 404);
    assert.equal((await raw(port, 'POST', '/v1/auth/demo-login', { host, 'content-type': 'application/json' }, '{"personId":"p01"}')).status, 404);
  } finally { await app.close(); rmSync(d, { recursive: true, force: true }); }
});

test('every mode: only requests to its own address (DNS rebinding), and writes only from its own origins', async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-host-'));
  const app = createApp({ dbFile: join(d, 'org.db'), log: false, devKeyFile: true, demo: true, publicHosts: ['https://pc.tail1234.ts.net'] });
  const port = await app.listen(0);
  try {
    const json = { 'content-type': 'application/json' };
    // A page at evil.example whose name now points at 127.0.0.1: refused before anything happens.
    assert.equal((await raw(port, 'POST', '/v1/auth/demo-login', { ...json, host: `evil.example:${port}` }, '{"personId":"p01"}')).status, 421);
    assert.equal((await raw(port, 'GET', '/v1/health', { host: 'evil.example' })).status, 421);
    assert.equal((await raw(port, 'GET', '/', { host: 'evil.example' })).status, 421, 'the web app’s files too');
    // Its own addresses: loopback with its port, and the Funnel name it was given.
    assert.equal((await raw(port, 'GET', '/v1/health', { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await raw(port, 'GET', '/v1/health', { host: `localhost:${port}` })).status, 200);
    assert.equal((await raw(port, 'GET', '/v1/health', { host: 'pc.tail1234.ts.net' })).status, 200);
    // Origin is checked against its own origins, not against whatever Host the request named.
    const login = (headers) => raw(port, 'POST', '/v1/auth/demo-login', { ...json, ...headers }, '{"personId":"p04"}');
    assert.equal((await login({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).status, 403);
    assert.equal((await login({ host: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net' })).status, 200);
    assert.equal((await login({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await login({ host: 'pc.tail1234.ts.net', origin: 'http://pc.tail1234.ts.net' })).status, 403, 'only https for the public name');
  } finally { await app.close(); rmSync(d, { recursive: true, force: true }); }
});
