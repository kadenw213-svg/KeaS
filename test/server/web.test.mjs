// Cookie sessions, CSRF and static serving of the web app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';
import { DEFAULT_WEB_DIR } from '../../server/static.mjs';

let app, base, port, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-web-test-'));
  // A tiny stand-in for web/dist, so the static rules are tested even before the app is built.
  const web = join(dir, 'dist');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>KeaS</title><div id="root"></div>');
  writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"KeaS"}');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  app = createApp({ dbFile: join(dir, 'test.db'), webDir: web, log: false });
  port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

/** Raw request: node's http client sends the path exactly as given (no ".." normalisation). */
function raw(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const json = { 'content-type': 'application/json' };
const cookieFrom = (r) => (r.headers['set-cookie'] || []).find((c) => c.startsWith('keas_session='));

async function cookieLogin(personId = 'p04') {
  const r = await raw('POST', '/v1/auth/demo-login', json, { personId });
  assert.equal(r.status, 200);
  return cookieFrom(r).split(';')[0];
}

test('demo-login sets an HttpOnly SameSite=Strict session cookie', async () => {
  const r = await raw('POST', '/v1/auth/demo-login', json, { personId: 'p04' });
  assert.equal(r.status, 200);
  const c = cookieFrom(r);
  assert.ok(c, 'sets keas_session');
  assert.match(c, /^keas_session=[0-9a-f]{64}; /);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(c.includes(part), `cookie has ${part}`);
  assert.ok(!c.includes('Secure'), 'no Secure over plain http');
  const https = await raw('POST', '/v1/auth/demo-login', { ...json, 'x-forwarded-proto': 'https' }, { personId: 'p04' });
  assert.ok(cookieFrom(https).includes('; Secure'), 'Secure behind an https proxy');
});

test('the cookie authenticates reads and (with X-KeaS) writes', async () => {
  const cookie = await cookieLogin('p04');
  const me = await raw('GET', '/v1/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(JSON.parse(me.body).person.id, 'p04');
  const ok = await raw('POST', '/v1/punch-requests', { ...json, cookie, 'x-keas': '1' }, { shiftId: 'nope', type: 'in', at: new Date().toISOString(), reasonCode: 'forgot' });
  assert.equal(ok.status, 404, 'passes auth + CSRF and reaches the handler');
  assert.equal((await raw('GET', '/v1/me', { cookie: 'keas_session=' + 'f'.repeat(64) })).status, 401);
});

test('cookie-authenticated writes need X-KeaS and a same-origin Origin', async () => {
  const cookie = await cookieLogin('p04');
  const body = { type: 'in' };
  const noHeader = await raw('POST', '/v1/punches', { ...json, cookie }, body);
  assert.equal(noHeader.status, 403);
  assert.match(JSON.parse(noHeader.body).error, /X-KeaS/);
  const wrongValue = await raw('POST', '/v1/punches', { ...json, cookie, 'x-keas': 'yes' }, body);
  assert.equal(wrongValue.status, 403);
  const crossOrigin = await raw('POST', '/v1/punches', { ...json, cookie, 'x-keas': '1', origin: 'https://evil.example' }, body);
  assert.equal(crossOrigin.status, 403);
  const crossSite = await raw('POST', '/v1/punches', { ...json, cookie, 'x-keas': '1', 'sec-fetch-site': 'cross-site' }, body);
  assert.equal(crossSite.status, 403);
  const loginCsrf = await raw('POST', '/v1/auth/demo-login', { ...json, origin: 'https://evil.example' }, { personId: 'p04' });
  assert.equal(loginCsrf.status, 403, 'login from another site is refused too');
  const same = await raw('POST', '/v1/punches', { ...json, cookie, 'x-keas': '1', origin: base, 'sec-fetch-site': 'same-origin' }, body);
  assert.ok([201, 409].includes(same.status), 'same-origin page with the header reaches the clock (409 = seed already clocked in)');
  // Bearer clients (the Kea desktop app, scripts) are not affected.
  const token = JSON.parse((await raw('POST', '/v1/auth/demo-login', json, { personId: 'p05' })).body).token;
  const bearer = await raw('POST', '/v1/punches', { ...json, authorization: `Bearer ${token}` }, body);
  assert.ok([201, 409].includes(bearer.status), 'bearer needs no X-KeaS');
});

test('logout ends the session and clears the cookie', async () => {
  const cookie = await cookieLogin('p06');
  const noHeader = await raw('POST', '/v1/auth/logout', { cookie });
  assert.equal(noHeader.status, 403, 'logout is a write too');
  const out = await raw('POST', '/v1/auth/logout', { cookie, 'x-keas': '1' });
  assert.equal(out.status, 200);
  const cleared = cookieFrom(out);
  assert.match(cleared, /^keas_session=; /);
  assert.ok(cleared.includes('Max-Age=0') && cleared.includes('HttpOnly'));
  assert.equal((await raw('GET', '/v1/me', { cookie })).status, 401, 'old cookie no longer works');
});

test('static: index.html with CSP, cache headers, client-route fallback', async () => {
  const r = await raw('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.match(r.body, /<div id="root">/);
  assert.equal(r.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-cache');
  const route = await raw('GET', '/timecards');
  assert.equal(route.status, 200);
  assert.match(route.body, /<div id="root">/);
  const asset = await raw('GET', '/assets/app-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /^text\/javascript/);
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.match((await raw('GET', '/manifest.webmanifest')).headers['content-type'], /^application\/manifest\+json/);
  assert.equal((await raw('GET', '/assets/missing.js')).status, 404);
  assert.equal((await raw('GET', '/v1/nope')).status, 404, 'unknown API paths stay JSON 404s');
  assert.match((await raw('GET', '/v1/nope')).headers['content-type'], /json/);
});

test('static: path traversal is impossible', async () => {
  for (const p of ['/../server/index.mjs', '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/../../secret.txt', '/%2e%2e%2f%2e%2e%2fserver%2findex.mjs', '/server/index.mjs', '/index.html%00.js']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 404, `${p} -> ${r.status}`);
    assert.ok(!r.body.includes('outside') && !r.body.includes('createApp'), `${p} leaked a file`);
  }
});

const built = existsSync(join(DEFAULT_WEB_DIR, 'index.html'));
test('the real built web app is served with the CSP', { skip: built ? false : 'web/dist is missing: run "npm run web:build" to include this check' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-web-real-'));
  const real = createApp({ dbFile: join(d, 'test.db'), log: false });
  const p = await real.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${p}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    const html = await r.text();
    assert.match(html, /KeaS/);
    const m = /src="(\/assets\/[^"]+\.js)"/.exec(html);
    assert.ok(m, 'index.html references a hashed script');
    const js = await fetch(`http://127.0.0.1:${p}${m[1]}`);
    assert.equal(js.status, 200);
    assert.ok(!/<script>/.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, '')), 'no inline scripts (CSP would block them)');
    const sw = await fetch(`http://127.0.0.1:${p}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
  } finally {
    await real.close();
    rmSync(d, { recursive: true, force: true });
  }
});

