import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHub } from '../../hub/index.mjs';
import { codeAt, stepOf } from '../../hub/lib/totp.mjs';
import { verifyToken } from '../../hub/lib/tokens.mjs';
import { POINTS } from '../../hub/lib/study.mjs';

const DAY = 86400_000;
let hub, base, ownerBase, dir;
let clock = Date.UTC(2026, 10, 5, 15);

// A stand-in for Google: our own RSA key, published the way Google publishes its keys.
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
function googleToken(claims = {}, key = google.privateKey) {
  const t = Math.floor(clock / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'kea-test-client', sub: 'g-123', email_verified: true, iat: t, exp: t + 3600, ...claims })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-hub-test-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', googleClientIds: ['kea-test-client'], googleKeyFn: async () => [googleJwk], defaultQuotaBytes: 1000, minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function owner(method, path, body, key = hub.ownerKey) {
  const r = await fetch(ownerBase + path, { method, headers: { 'content-type': 'application/json', 'x-kea-owner-key': key }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}` });
async function agreement() {
  const t = (await call('GET', '/v1/terms')).body.terms;
  return { termsVersion: t.version, termsSections: t.sections.map((s) => s.id) };
}
async function register(email, name = 'Test Person', password = 'lantern velvet orbit', extra = {}) {
  const r = await call('POST', '/v1/auth/register', null, { email, password, displayName: name, age13: true, ...(await agreement()), ...extra }, freshIp());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}

test('health and keys are public; the rest needs a session', async () => {
  assert.equal((await call('GET', '/v1/health')).body.service, 'kea-hub');
  assert.equal((await call('GET', '/v1/keys')).body.keys[0].kty, 'OKP');
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', 'f'.repeat(64))).status, 401);
  assert.equal((await call('GET', '/v1/me', 'not-hex')).status, 401);
});

test('register: validation, age gate, weak password, duplicate email', async () => {
  const ag = await agreement();
  const bad = (b) => call('POST', '/v1/auth/register', null, { email: 'a@b.co', password: 'lantern velvet orbit', displayName: 'A', age13: true, ...ag, ...b }, freshIp());
  assert.equal((await bad({ email: 'nope' })).status, 400);
  assert.match((await bad({ age13: false })).body.error, /13/);
  assert.match((await bad({ password: 'password123' })).body.error, /common/);
  // Terms: every section must be agreed to, on the current version.
  assert.equal((await bad({ termsVersion: undefined })).status, 409);
  const partial = await bad({ termsSections: ag.termsSections.slice(1) });
  assert.deepEqual([partial.status, partial.body.missing], [400, [ag.termsSections[0]]]);
  await register('dup@example.com');
  assert.equal((await call('POST', '/v1/auth/register', null, { email: 'DUP@example.com', password: 'lantern velvet orbit', displayName: 'B', age13: true, ...ag }, freshIp())).status, 409);
});

test('login: right password works, wrong is generic, unknown email looks identical, lockout doubles', async () => {
  await register('learner@example.com', 'Lee Learner');
  const ok = await call('POST', '/v1/auth/login', null, { email: 'Learner@Example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /kea_hub=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
  const wrong = await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'nope nope nope' }, freshIp());
  const ghost = await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'nope nope nope' }, freshIp());
  assert.deepEqual([wrong.status, wrong.body], [ghost.status, ghost.body]);
  // Four more wrong tries (5 total) -> locked, even with the right password, even from new IPs.
  for (let i = 0; i < 4; i++) await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'nope nope nope' }, freshIp());
  const locked = await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(locked.status, 429);
  assert.ok(locked.body.retryAfter >= 1);
  // Unknown emails lock the same way, so a lock reveals nothing.
  for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'x' }, freshIp());
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'x' }, freshIp())).status, 429);
  // Time passes -> the right password works and clears the count.
  clock += 60_000;
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, freshIp())).status, 200);
  // The owner console can unlock too.
  assert.equal((await owner('POST', '/owner/accounts/learner@example.com/unlock')).status, 200);
});

test('a faked forwarded address does not escape the per-IP limit', async () => {
  // The proxy appends the real address last; a client-supplied first entry is ignored.
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/v1/auth/login', null, { email: `fake${i}@example.com`, password: 'x' }, { 'x-test-ip': `1.2.3.${i}, 198.51.100.7` });
  assert.equal(last.status, 429);
});

test('per-IP limit on sign-in attempts', async () => {
  const ip = { 'x-test-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/v1/auth/login', null, { email: `spray${i}@example.com`, password: 'x' }, ip);
  assert.equal(last.status, 429);
});

test('cookie sessions need same-origin + X-Kea header for POST; logout ends the session', async () => {
  const t = await register('cookie@example.com');
  const cookie = { cookie: `kea_hub=${t}` };
  const r1 = await fetch(base + '/v1/me', { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{"displayName":"X"}' });
  assert.equal(r1.status, 403);
  const r2 = await fetch(base + '/v1/me', { method: 'POST', headers: { ...cookie, 'x-kea': '1', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"displayName":"X"}' });
  assert.equal(r2.status, 403);
  const r3 = await fetch(base + '/v1/me', { method: 'POST', headers: { ...cookie, 'x-kea': '1', 'content-type': 'application/json' }, body: '{"displayName":"Cookie Cat"}' });
  assert.equal(r3.status, 200);
  assert.equal((await call('POST', '/v1/auth/logout', t)).status, 200);
  assert.equal((await call('GET', '/v1/me', t)).status, 401);
});

test('two-step sign-in: setup, enable, login needs code, replay refused', async () => {
  const t = await register('totp@example.com');
  const s = await call('POST', '/v1/me/totp/setup', t);
  assert.match(s.body.uri, /^otpauth:\/\/totp\/Kea:/);
  assert.equal((await call('POST', '/v1/me/totp/enable', t, { code: '000000' })).status, 400);
  const code = codeAt(s.body.secret, stepOf(clock));
  assert.equal((await call('POST', '/v1/me/totp/enable', t, { code })).status, 200);
  const creds = { email: 'totp@example.com', password: 'lantern velvet orbit' };
  const need = await call('POST', '/v1/auth/login', null, creds, freshIp());
  assert.deepEqual([need.status, need.body.totpRequired], [401, true]);
  assert.equal((await call('POST', '/v1/auth/login', null, { ...creds, code }, freshIp())).status, 401, 'code used at enable cannot be reused');
  clock += 30_000;
  const fresh = codeAt(s.body.secret, stepOf(clock));
  assert.equal((await call('POST', '/v1/auth/login', null, { ...creds, code: fresh }, freshIp())).status, 200);
});

test('password change signs out other sessions', async () => {
  const a = await register('pw@example.com');
  const b = (await call('POST', '/v1/auth/login', null, { email: 'pw@example.com', password: 'lantern velvet orbit' }, freshIp())).body.token;
  assert.equal((await call('POST', '/v1/me/password', a, { current: 'wrong wrong', next: 'meadow quartz signal' })).status, 401);
  assert.equal((await call('POST', '/v1/me/password', a, { current: 'lantern velvet orbit', next: 'meadow quartz signal' })).status, 200);
  assert.equal((await call('GET', '/v1/me', b)).status, 401);
  assert.equal((await call('GET', '/v1/me', a)).status, 200);
});

test('signed token for other services', async () => {
  const t = await register('tok@example.com', 'Tok');
  const r = await call('POST', '/v1/auth/token', t, { aud: 'org:pool' });
  const p = verifyToken(hub.key.publicKey, r.body.token, { aud: 'org:pool', nowMs: clock });
  assert.deepEqual([p.email, p.name, p.owner], ['tok@example.com', 'Tok', false]);
});

test('owner console: needs the key, and only exists on its own port', async () => {
  assert.equal((await owner('GET', '/owner/stats', undefined, 'wrong')).status, 401);
  assert.equal((await owner('GET', '/owner/stats')).status, 200);
  assert.equal((await call('GET', '/owner/stats')).status, 404, 'not on the public API');
  const browserish = await fetch(ownerBase + '/owner/stats', { headers: { 'x-kea-owner-key': hub.ownerKey, origin: 'https://evil.example' } });
  assert.equal(browserish.status, 403);
});

test('hosting: classes need approval; apply, owner approves, general needs identity', async () => {
  const t = await register('teacher@example.com', 'Tia Teacher');
  assert.equal((await call('POST', '/v1/classes', t, { title: 'Lifeguarding' })).status, 403);
  assert.equal((await call('POST', '/v1/hosting/apply', t, { reason: 'short' })).status, 400);
  const app = await call('POST', '/v1/hosting/apply', t, { reason: 'I teach lifeguarding and CPR classes for my pool.' });
  assert.equal(app.body.status, 'pending');
  const list = await owner('GET', '/owner/hosting');
  assert.equal(list.body.applications.length, 1);
  assert.equal((await owner('POST', `/owner/hosting/${app.body.id}/decide`, { approve: true })).status, 200);
  assert.equal((await call('GET', '/v1/hosting', t)).body.status, 'approved');
  assert.equal((await call('POST', '/v1/classes', t, { title: 'CPR for parents', kind: 'general' })).status, 403);
  const c = await call('POST', '/v1/classes', t, { title: 'Lifeguarding', meetingUrl: 'https://meet.jit.si/kea-lifeguarding' });
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/v1/classes', t, { title: 'X', meetingUrl: 'javascript:alert(1)' })).status, 400);
});

test('classes end to end: invite, join, calendar, study, scoring, leaderboard, privacy', async () => {
  const teach = await register('inst@example.com', 'Ivy Instructor');
  await owner('POST', '/owner/accounts/inst@example.com', { canHost: true });
  const cls = (await call('POST', '/v1/classes', teach, { title: 'Biology 101' })).body.class;

  const inv = await call('POST', `/v1/classes/${cls.id}/invites`, teach, { maxUses: 2 });
  assert.match(inv.body.code, /^[A-HJ-NP-Z2-9]{10}$/);
  const s1 = await register('s1@example.com', 'Sam One');
  const s2 = await register('s2@example.com', 'Sue Two');
  const s3 = await register('s3@example.com', 'Sid Three');
  // Codes are typed loosely: lower case and dashes are fine.
  const pretty = inv.body.code.toLowerCase().replace(/(.{5})/, '$1-');
  assert.equal((await call('POST', '/v1/join', s1, { code: pretty })).status, 200);
  assert.equal((await call('POST', '/v1/join', s2, { code: inv.body.code, board: 'hidden' })).status, 200);
  assert.equal((await call('POST', '/v1/join', s3, { code: inv.body.code })).status, 404, 'max uses reached');
  assert.equal((await call('POST', '/v1/join', s3, { code: 'AAAAAAAAAA' })).status, 404);
  assert.equal((await call('GET', `/v1/classes/${cls.id}`, s3)).status, 404, 'non-members cannot see the class');

  // Students can't manage the class.
  assert.equal((await call('POST', `/v1/classes/${cls.id}/invites`, s1, {})).status, 403);
  assert.equal((await call('POST', `/v1/classes/${cls.id}/sessions`, s1, { title: 'x', start: clock, end: clock + 1 })).status, 403);

  // Calendar.
  const start = new Date(clock + 2 * DAY).toISOString();
  const end = new Date(clock + 2 * DAY + 3600_000).toISOString();
  assert.equal((await call('POST', `/v1/classes/${cls.id}/sessions`, teach, { title: 'Cells', start: end, end: start })).status, 400);
  const sess = await call('POST', `/v1/classes/${cls.id}/sessions`, teach, { title: 'Cells', start, end, meetingUrl: 'https://meet.jit.si/kea-bio' });
  assert.equal(sess.status, 201);
  const cal = await call('GET', '/v1/calendar', s1);
  assert.deepEqual(cal.body.sessions.map((s) => [s.title, s.classTitle]), [['Cells', 'Biology 101']]);

  // A study set; students never receive the answers.
  const set = await call('POST', `/v1/classes/${cls.id}/sets`, teach, {
    title: 'Cells quiz',
    questions: [
      { q: 'Powerhouse of the cell?', choices: ['Nucleus', 'Mitochondria', 'Ribosome'], answer: 1, why: 'ATP is made there.' },
      { q: 'Holds DNA?', choices: ['Nucleus', 'Golgi'], answer: 0 },
    ],
  });
  assert.equal(set.status, 201);
  const view = await call('GET', `/v1/sets/${set.body.id}`, s1);
  assert.equal(view.body.questions.length, 2);
  assert.equal('answer' in view.body.questions[0], false);
  assert.equal((await call('GET', `/v1/sets/${set.body.id}`, teach)).body.questions[0].answer, 1);
  const [q1, q2] = view.body.questions;

  const ans = (tok, q, choice) => call('POST', `/v1/sets/${set.body.id}/answer`, tok, { questionId: q.id, choice });
  let r = await ans(s1, q1, 1);
  assert.deepEqual([r.body.correct, r.body.points], [true, POINTS.newFirstTry]);
  r = await ans(s1, q1, 1);
  assert.deepEqual([r.body.points, r.body.scoring], [0, false], 'repeat is practice only');
  r = await ans(s1, q2, 1);
  assert.deepEqual([r.body.correct, r.body.answer, r.body.points], [false, 0, 0]);
  r = await ans(s1, q2, 0);
  assert.equal(r.body.points, POINTS.afterMiss, 'brute force still earns a little');
  r = await ans(s2, q1, 1);
  assert.equal(r.body.points, POINTS.newFirstTry);
  assert.equal((await call('POST', `/v1/sets/${set.body.id}/answer`, s1, { questionId: q1.id, choice: 9 })).status, 400);

  const sets = await call('GET', `/v1/classes/${cls.id}/sets`, s1);
  assert.deepEqual([sets.body.sets[0].questions, sets.body.sets[0].due], [2, 0]);

  // Leaderboard: s2 chose hidden, so others don't see them; s2 still sees their own rank.
  const b1 = await call('GET', `/v1/classes/${cls.id}/leaderboard`, s1);
  assert.deepEqual(b1.body.board.map((e) => [e.name, e.points]), [['Sam One', POINTS.newFirstTry + POINTS.afterMiss]]);
  const b2 = await call('GET', `/v1/classes/${cls.id}/leaderboard`, s2);
  assert.equal(b2.body.you.points, POINTS.newFirstTry);
  assert.ok(b2.body.board.some((e) => e.you));
  // Nickname.
  assert.equal((await call('POST', `/v1/classes/${cls.id}/me`, s1, { board: 'nickname', nickname: 'Mito' })).status, 200);
  assert.equal((await call('GET', `/v1/classes/${cls.id}/leaderboard?period=all`, s1)).body.board[0].name, 'Mito');

  // Members list: classmates see names per their choice, the hidden one is left out; instructors see everyone.
  const ms = await call('GET', `/v1/classes/${cls.id}/members`, s1);
  assert.deepEqual(ms.body.members.map((m) => m.name).sort(), ['Ivy Instructor', 'Mito']);
  assert.equal((await call('GET', `/v1/classes/${cls.id}/members`, teach)).body.members.length, 3);

  // Next day: q1 is due again and earns review points; the week board keeps counting until Monday.
  clock += DAY;
  r = await ans(s1, q1, 1);
  assert.equal(r.body.points, POINTS.reviewFirstTry + POINTS.reviewBoxBonus);
  const me = await call('GET', '/v1/me', s1);
  assert.equal(me.body.progress.streak, 2);
  assert.equal(me.body.progress.level, 1);

  // Removal and leaving.
  const t3 = await call('POST', `/v1/classes/${cls.id}/invites`, teach, {});
  await call('POST', '/v1/join', s3, { code: t3.body.code });
  assert.equal((await call('POST', `/v1/classes/${cls.id}/leave`, s3)).status, 200);
  assert.equal((await call('GET', `/v1/classes/${cls.id}`, s3)).status, 404);
  assert.equal((await call('POST', `/v1/classes/${cls.id}/leave`, teach)).status, 400);
  assert.equal((await call('POST', `/v1/invites/${t3.body.code}/revoke`, teach)).status, 200);
  assert.equal((await call('POST', '/v1/join', s3, { code: t3.body.code })).status, 404);
});

test('suspension signs the account out everywhere', async () => {
  const t = await register('bad@example.com');
  assert.equal((await owner('POST', '/owner/accounts/bad@example.com', { status: 'suspended' })).status, 200);
  assert.equal((await call('GET', '/v1/me', t)).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'bad@example.com', password: 'lantern velvet orbit' }, freshIp())).status, 403);
  const audit = await owner('GET', '/owner/audit');
  assert.ok(audit.body.entries.some((e) => e.action === 'owner.account_update'));
  assert.ok(!JSON.stringify(audit.body).includes('lantern'), 'passwords never reach the audit log');
});

test('verify with Google: right email verifies; wrong app, wrong email, forged, stale and reused tokens are refused', async () => {
  const t = await register('gwen@example.com', 'Gwen');
  const bad = async (tok) => (await call('POST', '/v1/me/verify/google', t, { idToken: tok })).status;
  assert.equal(await bad(googleToken({ email: 'gwen@example.com', aud: 'other-app' })), 401);
  assert.equal(await bad(googleToken({ email: 'someone@example.com' })), 400);
  assert.equal(await bad(googleToken({ email: 'gwen@example.com', email_verified: false })), 401);
  assert.equal(await bad(googleToken({ email: 'gwen@example.com', iat: Math.floor(clock / 1000) - 3600 })), 401);
  assert.equal(await bad(googleToken({ email: 'gwen@example.com' }, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)), 401);
  const good = googleToken({ email: 'Gwen@example.com' });
  const ok = await call('POST', '/v1/me/verify/google', t, { idToken: good });
  assert.deepEqual([ok.status, ok.body.account.emailVerified, ok.body.account.verifiedBy], [200, true, 'Google']);
  assert.equal(await bad(good), 401, 'a Google sign-in works once');
});

test('register with Google, sign in with Google, reset a forgotten password with Google', async () => {
  const reg = await register('grace@example.com', 'Grace', 'lantern velvet orbit', { googleIdToken: googleToken({ email: 'grace@example.com', sub: 'g-grace' }) });
  assert.equal((await call('GET', '/v1/me', reg)).body.account.emailVerified, true);
  const g = await call('POST', '/v1/auth/google', null, { idToken: googleToken({ email: 'grace@example.com', sub: 'g-grace', nonce: 1 }) }, freshIp());
  assert.equal(g.status, 200);
  const none = await call('POST', '/v1/auth/google', null, { idToken: googleToken({ email: 'nobody@example.com', nonce: 2 }) }, freshIp());
  assert.deepEqual([none.status, none.body.email], [404, 'nobody@example.com']);
  const reset = await call('POST', '/v1/auth/reset/google', null, { idToken: googleToken({ email: 'grace@example.com', nonce: 3 }), password: 'river copper lantern' }, freshIp());
  assert.equal(reset.status, 200);
  assert.equal((await call('GET', '/v1/me', reg)).status, 401, 'old sessions end');
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'grace@example.com', password: 'river copper lantern' }, freshIp())).status, 200);
});

test('Kea storage: write, read, versions and conflicts, quota, path safety, isolation', async () => {
  const a = await register('files@example.com');
  const b = await register('other@example.com');
  const put = (tok, path, data, headers = {}) => fetch(`${base}/v1/files/${path}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, ...headers }, body: data });
  const get = (tok, path, headers = {}) => fetch(`${base}/v1/files/${path}`, { headers: { authorization: `Bearer ${tok}`, ...headers } });
  let r = await put(a, 'kea/School/notes.json', '{"n":1}');
  assert.equal(r.status, 201);
  assert.equal((await r.json()).version, 1);
  r = await get(a, 'kea/School/notes.json');
  assert.deepEqual([r.status, await r.text(), r.headers.get('etag')], [200, '{"n":1}', '"1"']);
  assert.equal((await get(a, 'kea/School/notes.json', { 'if-none-match': '"1"' })).status, 304);
  // A device writes with the version it knows; a stale device is refused.
  assert.equal((await put(a, 'kea/School/notes.json', '{"n":2}', { 'if-match': '"1"' })).status, 200);
  const stale = await put(a, 'kea/School/notes.json', '{"n":"stale"}', { 'if-match': '"1"' });
  assert.deepEqual([stale.status, (await stale.json()).version], [412, 2]);
  assert.equal((await put(a, 'kea/School/notes.json', 'x', { 'if-none-match': '*' })).status, 412);
  // Names with spaces and accents are fine; tricks are not.
  assert.equal((await put(a, encodeURIComponent('kea/Café notes/Week 1 (draft).md').replace(/%2F/g, '/'), 'hi')).status, 201);
  // (A literal "/../" is resolved by URL parsing before it reaches the Hub; an encoded slash isn't, so test that.)
  for (const p of ['kea/..%2Fx', 'kea/%2E%2E%2Fx', 'kea//x', 'kea/a%5Cb', 'kea/%00', 'kea/a%3Ab', 'kea/%20lead']) assert.equal((await put(a, p, 'x')).status, 400, p);
  // Quota (1000 bytes in this test).
  assert.equal((await put(a, 'big.bin', 'x'.repeat(2000))).status, 507);
  // Other accounts can't see it.
  assert.equal((await get(b, 'kea/School/notes.json')).status, 404);
  const list = await call('GET', '/v1/files?prefix=kea/School/', a);
  assert.deepEqual(list.body.files.map((f) => [f.path, f.version]), [['kea/School/notes.json', 2]]);
  assert.equal((await call('GET', '/v1/files', b)).body.files.length, 0);
  assert.equal((await fetch(`${base}/v1/files/kea/School/notes.json`, { method: 'DELETE', headers: { authorization: `Bearer ${a}` } })).status, 200);
  assert.equal((await get(a, 'kea/School/notes.json')).status, 404);
  assert.equal((await fetch(`${base}/v1/files/x`)).status, 401);
  const exp = await call('GET', '/v1/me/export', a);
  assert.equal(exp.body.account.email, 'files@example.com');
  assert.equal(exp.body.termsAgreements.length, 1);
});

// Last: publishing new terms locks everyone out until they agree again.
test('terms change: everyone must re-agree; only changes shown; reading, export and sign-out still work', async () => {
  const t = await register('reader@example.com', 'Rae Reader');
  const page = await fetch(`${base}/terms`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Use the official software only/);

  const doc = (await call('GET', '/v1/terms')).body.terms;
  const v1 = doc.version;
  const next = structuredClone(doc);
  next.label = '2026-12-01';
  next.summary = 'Storage limits explained; new section on study groups.';
  next.sections.find((s) => s.id === 'storage').body += '\n- Example change.';
  next.sections.splice(9, 0, { id: 'study-groups', title: '8b. Study groups', body: 'Study groups share materials members made.' });
  next.sections = next.sections.filter((s) => s.id !== 'minors');
  const pub = await owner('POST', '/owner/terms', next);
  assert.deepEqual([pub.status, pub.body.published, pub.body.n], [200, true, v1 + 1]);
  assert.equal((await owner('POST', '/owner/terms', next)).body.published, false, 'same text is not a new version');

  // Locked out of everything that uses the Hub...
  const blocked = await call('GET', '/v1/classes', t);
  assert.deepEqual([blocked.status, blocked.body.termsRequired, blocked.body.current, blocked.body.accepted], [428, true, v1 + 1, v1]);
  assert.equal((await call('POST', '/v1/auth/token', t, {})).status, 428);
  assert.equal((await fetch(`${base}/v1/files/a`, { headers: { authorization: `Bearer ${t}` } })).status, 428);
  // ...but can see their status, read what changed, export, and sign out.
  assert.equal((await call('GET', '/v1/me', t)).body.terms.needsAgreement, true);
  const ch = await call('GET', '/v1/terms/changes', t);
  assert.deepEqual([ch.body.added.map((s) => s.id), ch.body.changed.map((s) => s.id), ch.body.removed.map((s) => s.id)], [['study-groups'], ['storage'], ['minors']]);
  assert.equal((await call('GET', '/v1/me/export', t)).status, 200);
  const diffPage = await (await fetch(`${base}/terms?since=${v1}`)).text();
  assert.match(diffPage, /Changes from version 1 to version 2/);
  assert.match(diffPage, /New<\/span><h2>8b\. Study groups/);
  assert.doesNotMatch(diffPage, /Use the official software only/, 'unchanged sections are left out');

  // Agreeing to the old version, or to only part of the new one, doesn't count.
  assert.equal((await call('POST', '/v1/terms/accept', t, { termsVersion: v1, termsSections: doc.sections.map((s) => s.id) })).status, 409);
  assert.equal((await call('POST', '/v1/terms/accept', t, { termsVersion: v1 + 1, termsSections: ['storage'] })).status, 400);
  const acc = await call('POST', '/v1/terms/accept', t, { termsVersion: v1 + 1, termsSections: next.sections.map((s) => s.id) });
  assert.deepEqual([acc.status, acc.body.terms.needsAgreement], [200, false]);
  assert.equal((await call('GET', '/v1/classes', t)).status, 200);
  assert.equal((await owner('GET', '/owner/terms')).body.agreedToCurrent, 1);
  assert.equal((await owner('POST', '/owner/terms', { sections: [{ id: 'Bad Id', title: 'x', body: 'y' }] })).status, 400);
  assert.equal((await call('POST', '/v1/auth/logout', t)).status, 200);
});
