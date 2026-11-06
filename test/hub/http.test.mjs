import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
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
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', googleClientIds: ['kea-test-client'], googleKeyFn: async () => [googleJwk], defaultQuotaBytes: 1000, minFreeBytes: 0, fileOverheadBytes: 0 });
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
  const r = await ownerFetch(ownerBase, key, method, path, body);
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
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.token, undefined, 'making an account never signs in by itself');
  const s = await call('POST', '/v1/auth/login', null, { email, password }, freshIp());
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body.token;
}

test('health and keys are public; the rest needs a session', async () => {
  assert.equal((await call('GET', '/v1/health')).body.service, 'kea-hub');
  assert.equal((await call('GET', '/v1/keys')).body.keys[0].kty, 'OKP');
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', 'f'.repeat(64))).status, 401);
  assert.equal((await call('GET', '/v1/me', 'not-hex')).status, 401);
});

test('register: validation, age gate, weak password; a taken email answers exactly like a new one', async () => {
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
  const reg = (email, password) => call('POST', '/v1/auth/register', null, { email, password, displayName: 'B', age13: true, ...ag }, freshIp());
  const taken = await reg('DUP@example.com', 'harbor maple quill');
  const fresh = await reg('brand-new@example.com', 'harbor maple quill');
  assert.deepEqual([taken.status, taken.body], [fresh.status, fresh.body], 'nothing tells a taken email apart');
  assert.equal(taken.status, 202);
  assert.equal(taken.headers.get('set-cookie'), null, 'no session either way');
  // The new one signs in; the taken one only with its owner's password, and its owner is unaffected.
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'brand-new@example.com', password: 'harbor maple quill' }, freshIp())).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'dup@example.com', password: 'harbor maple quill' }, freshIp())).status, 401);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'dup@example.com', password: 'lantern velvet orbit' }, freshIp())).status, 200);
});

test('login: right password works, wrong is generic, unknown email looks identical, lockout doubles', async () => {
  await register('learner@example.com', 'Lee Learner');
  const ok = await call('POST', '/v1/auth/login', null, { email: 'Learner@Example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /kea_hub=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
  const wrong = await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'nope nope nope' }, freshIp());
  const ghost = await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'nope nope nope' }, freshIp());
  assert.deepEqual([wrong.status, wrong.body], [ghost.status, ghost.body]);
  // Five wrong tries from one address -> that address is locked, even with the right password.
  const attacker = { 'x-test-ip': '198.18.0.66' };
  for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'nope nope nope' }, attacker);
  const locked = await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, attacker);
  assert.equal(locked.status, 429);
  assert.ok(locked.body.retryAfter >= 1);
  // ...but the account's owner, somewhere else, still signs in.
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, freshIp())).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, attacker)).status, 429, 'still locked there');
  // Unknown emails lock the same way, so a lock reveals nothing.
  const ghostIp = { 'x-test-ip': '198.18.0.67' };
  for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'x' }, ghostIp);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'ghost@example.com', password: 'x' }, ghostIp)).status, 429);
  // Time passes -> the right password works there too.
  clock += 60_000;
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'learner@example.com', password: 'lantern velvet orbit' }, attacker)).status, 200);
  // The owner console can unlock too.
  assert.equal((await owner('POST', '/owner/accounts/learner@example.com/unlock')).status, 200);
});

test('guessing one password from many addresses is still bounded; Google and two-step sign-in still get through', async () => {
  await register('target@example.com', 'Tara Target');
  const guess = (ip, extra = {}) => call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'wrong guess here', ...extra }, { 'x-test-ip': ip });
  // 4 tries from each of 13 addresses (each stays under its own lock): 52 failures from 13 places.
  for (let n = 0; n < 13; n++) for (let i = 0; i < 4; i++) await guess(`198.19.${n}.1`);
  // Now the name is locked everywhere for a short while: even a brand-new address can't try.
  const r = await guess('198.19.200.1');
  assert.deepEqual([r.status, /many places/.test(r.body.error)], [429, true]);
  // The real owner without two-step: the same short lock (a guess and a right password look alike).
  const own = await call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(own.status, 429);
  assert.ok(own.body.retryAfter <= 5 * 60, 'the everywhere-lock is short');
  // Sign in with Google is never blocked by it.
  assert.equal((await call('POST', '/v1/auth/google', null, { idToken: googleToken({ email: 'target@example.com', sub: 'g-target' }) }, freshIp())).status, 200);
  // Once it runs out, one more failure locks it again at once: tries stay rare however many addresses are used.
  clock += 5 * 60_000 + 1000;
  assert.equal((await guess('198.19.201.1')).status, 401, 'one try once the lock runs out');
  assert.equal((await guess('198.19.202.1')).status, 429, 'and locked again right away');
  clock += 5 * 60_000 + 1000;

  // With two-step sign-in on, a correct password and a correct code still get in during the lock.
  const t = await call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(t.status, 200);
  const s = await call('POST', '/v1/me/totp/setup', t.body.token, { password: 'lantern velvet orbit' });
  await call('POST', '/v1/me/totp/enable', t.body.token, { code: codeAt(s.body.secret, stepOf(clock)) });
  clock += 30_000;
  assert.equal((await guess('198.19.203.1')).status, 401); // (and locked again)
  const noCode = await call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'lantern velvet orbit' }, freshIp());
  assert.equal(noCode.status, 429, 'no code: just the lock, no "code needed" hint');
  const wrongPw = await call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'nope nope nope', code: codeAt(s.body.secret, stepOf(clock)) }, freshIp());
  assert.equal(wrongPw.status, 429, 'a wrong password with a right code looks the same');
  const both = await call('POST', '/v1/auth/login', null, { email: 'target@example.com', password: 'lantern velvet orbit', code: codeAt(s.body.secret, stepOf(clock)) }, freshIp());
  assert.equal(both.status, 200);
  assert.equal((await owner('POST', '/owner/accounts/target@example.com/unlock')).status, 200);
});

test('two-step: a right password without a code counts toward the lock like a wrong one', async () => {
  const t = await register('oracle@example.com');
  const s = await call('POST', '/v1/me/totp/setup', t, { password: 'lantern velvet orbit' });
  await call('POST', '/v1/me/totp/enable', t, { code: codeAt(s.body.secret, stepOf(clock)) });
  const ip = { 'x-test-ip': '198.18.5.5' };
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/v1/auth/login', null, { email: 'oracle@example.com', password: 'lantern velvet orbit' }, ip);
    assert.deepEqual([r.status, r.body.totpRequired], [401, true], 'the code prompt itself stays');
  }
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'oracle@example.com', password: 'lantern velvet orbit' }, ip)).status, 429, 'testing passwords this way is throttled too');
  clock += 30_000;
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'oracle@example.com', password: 'lantern velvet orbit', code: codeAt(s.body.secret, stepOf(clock)) }, freshIp())).status, 200);
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
  const s = await call('POST', '/v1/me/totp/setup', t, { password: 'lantern velvet orbit' });
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
  // Only known audiences: a signed-in account can't mint a token named for anything else.
  assert.equal((await call('POST', '/v1/auth/token', t, { aud: 'keas-payroll' })).status, 200);
  for (const aud of ['keas-payroll-admin', 'anything', 'org:', 'org:a/b', 'https://evil.example']) assert.equal((await call('POST', '/v1/auth/token', t, { aud })).status, 400, aud);
});

test('owner console: needs the key, and only exists on its own port', async () => {
  assert.equal((await owner('GET', '/owner/stats', undefined, 'wrong')).status, 401);
  assert.equal((await owner('GET', '/owner/stats')).status, 200);
  assert.equal((await call('GET', '/owner/stats')).status, 404, 'not on the public API');
  const browserish = await ownerFetch(ownerBase, hub.ownerKey, 'GET', '/owner/stats', undefined, { headers: { origin: 'https://evil.example' } });
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
  // A wrong answer while it scores: just "wrong, it comes back" (no answer key to collect).
  r = await ans(s1, q2, 1);
  assert.deepEqual([r.body.correct, r.body.answer, r.body.why, r.body.again, r.body.points], [false, undefined, undefined, true, 0]);
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

test('shared Claude: verified only, classmates share one scan, batches of 25, limits, owner queue and pause', async () => {
  const course = { school: 'UCCS', code: 'CHEM 1110', term: 'Spring 2027', section: '001' };
  const mk = async (email) => { const t = await register(email, undefined, undefined, { birthYear: 1995 }); await owner('POST', `/owner/accounts/${email}`, { emailVerified: true }); return t; };
  const unverified = await register('nov@example.com');
  assert.equal((await call('POST', '/v1/scan', unverified, { kind: 'initial_scan', course })).body.code, 'verify');
  const a = await mk('scan-a@example.com'), b = await mk('scan-b@example.com'), c = await mk('scan-c@example.com');

  // A queues the first scan of the course; B (same section, typed differently) joins it instead of a second run.
  const qa = await call('POST', '/v1/scan', a, { kind: 'initial_scan', course });
  assert.deepEqual([qa.status, qa.body.status, qa.body.job.position], [200, 'queued', 0]);
  // (Knowing the course isn't enough: A, already in the section, lets B in.)
  const jb = await call('POST', '/v1/scan', b, { kind: 'initial_scan', course: { ...course, code: 'chem-1110' } });
  assert.equal(jb.body.status, 'pending');
  const askB = (await call('GET', '/v1/course-sections/requests', a)).body.incoming;
  assert.deepEqual(askB.map((r) => r.name), ['Test Person']);
  assert.equal((await call('GET', '/v1/me/notifications', a)).body.notifications[0].kind, 'course_join');
  assert.equal((await call('POST', `/v1/course-sections/requests/${askB[0].id}/decide`, b, { approve: true })).status, 404, 'not by the one asking');
  assert.equal((await call('POST', `/v1/course-sections/requests/${askB[0].id}/decide`, a, { approve: true })).body.request.status, 'approved');
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'initial_scan', course })).body.code, 'already_scanned');
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'regenerate', course })).body.code, 'no_regenerate');

  // A's Kea uploads what it collected from the class site, then says it's ready. Not before.
  const jobId = qa.body.job.id;
  assert.equal(qa.body.uploadTo, `scan-inbox/${jobId}/`);
  assert.equal((await owner('POST', '/owner/scan/next')).body.job, null, 'waits for the upload');
  assert.equal((await call('POST', `/v1/scan/${jobId}/ready`, a)).status, 400, 'nothing uploaded yet');
  const up = await fetch(`${base}/v1/files/scan-inbox/${jobId}/content.md`, { method: 'PUT', headers: { authorization: `Bearer ${a}` }, body: '# CHEM 1110\nWeek 1: atoms' });
  assert.equal(up.status, 201);
  assert.equal((await call('POST', `/v1/scan/${jobId}/ready`, a)).status, 200);

  // The worker on the owner's PC runs it; then C gets it shared, with no Claude at all.
  const next = await owner('POST', '/owner/scan/next');
  assert.equal(next.body.job.id, jobId);
  assert.deepEqual(next.body.job.members.map((m) => m.email).sort(), ['scan-a@example.com', 'scan-b@example.com']);
  assert.equal((await owner('POST', '/owner/scan/next')).body.job, null, 'one at a time');
  const inbox = await owner('GET', `/owner/scan/${jobId}/inbox`);
  assert.deepEqual(inbox.body.files.map((f) => f.path), [`scan-inbox/${jobId}/content.md`]);
  const got = await ownerFetch(ownerBase, hub.ownerKey, 'GET', `/owner/scan/${jobId}/inbox-file?path=${encodeURIComponent(`scan-inbox/${jobId}/content.md`)}`);
  assert.equal(await got.text(), '# CHEM 1110\nWeek 1: atoms');
  // Results: a shared textbook chapter for the section, and a private file for one member.
  const putOwner = (p, data) => ownerFetch(ownerBase, hub.ownerKey, 'PUT', p, data);
  assert.equal((await putOwner(`/owner/scan/${jobId}/course-file?path=textbook/ch01.md`, '# Atoms')).status, 200);
  const bId = next.body.job.members.find((m) => m.email === 'scan-b@example.com').id;
  assert.equal((await putOwner(`/owner/scan/${jobId}/member-file?account=${bId}&path=guides.json`, '{"private":true}')).status, 200);
  assert.equal((await putOwner(`/owner/scan/${jobId}/member-file?account=nobody&path=x`, 'x')).status, 403);
  await owner('POST', `/owner/scan/${jobId}/finish`, { ok: true });
  assert.equal((await call('GET', '/v1/files?prefix=scan-inbox/', a)).body.files.length, 0, 'the upload is deleted after the job');
  assert.equal((await putOwner(`/owner/scan/${jobId}/course-file?path=late.md`, 'x')).status, 404, 'no writes after the job ends');
  assert.equal((await call('GET', '/v1/files?prefix=kea-results/', b)).body.files[0].path, 'kea-results/guides.json');

  const key = next.body.job.course;
  const sc = await call('POST', '/v1/scan', c, { kind: 'initial_scan', course });
  assert.equal(sc.body.status, 'pending');
  assert.equal(sc.body.allowance.today, 0, 'sharing costs nothing');
  assert.equal((await call('GET', `/v1/course-files?course=${encodeURIComponent(key)}`, c)).status, 404, 'nothing until someone lets them in');
  const askC = (await call('GET', '/v1/course-sections/requests', b)).body.incoming;
  assert.equal((await call('POST', `/v1/course-sections/requests/${askC[0].id}/decide`, b, { approve: true })).status, 200, 'anyone in the section can');
  assert.equal((await call('GET', '/v1/me/notifications', c)).body.notifications[0].title.startsWith('You’re in'), true);
  const cf = await call('GET', `/v1/course-files?course=${encodeURIComponent(key)}`, c);
  assert.deepEqual(cf.body.files.map((f) => f.path), ['textbook/ch01.md']);
  const ch = await fetch(`${base}/v1/course-file?course=${encodeURIComponent(key)}&path=textbook/ch01.md`, { headers: { authorization: `Bearer ${c}` } });
  assert.equal(await ch.text(), '# Atoms');
  assert.equal((await call('GET', `/v1/course-files?course=${encodeURIComponent(key)}`, unverified)).status, 404, 'only people in the section');

  // Updates: once per cooldown for the whole section.
  assert.equal((await call('POST', '/v1/scan', b, { kind: 'update_scan', course })).body.code, 'cooldown');

  // More questions: batches of 25, joined when someone already asked for that chapter, capped per day.
  const m1 = await call('POST', '/v1/scan', a, { kind: 'more_questions', course, chapter: 'Ch 2' });
  assert.equal(m1.body.status, 'queued');
  assert.equal(m1.body.allowance.batchSize, 25);
  assert.equal((await call('POST', '/v1/scan', c, { kind: 'more_questions', course, chapter: 'Ch 2' })).body.status, 'joined');
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'more_questions', course, chapter: 'Ch 3' })).body.status, 'queued');
  // (A has now started 3 jobs today: the day's limit.)
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'more_questions', course, chapter: 'Ch 4' })).body.code, 'batch_day');
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'initial_scan', course: { ...course, code: 'MATH 1120' } })).body.code, 'day_cap');
  const mine = await call('GET', '/v1/scan', c);
  assert.ok(mine.body.jobs.some((j) => j.chapter === 'Ch 2' && j.status === 'queued' && j.position >= 0));

  // Paused (the plan hit its limit): others wait; the owner's own jobs still run first.
  await owner('POST', '/owner/scan/pause', { hours: 5 });
  assert.equal((await owner('POST', '/owner/scan/next')).body.job, null);
  await owner('POST', '/owner/scan/pause', { hours: null });
  assert.equal((await owner('POST', '/owner/scan/next')).body.job.chapter, 'Ch 2');

  // Cancelling a job someone joined hands it to them instead.
  const qb = await call('POST', '/v1/scan', b, { kind: 'more_questions', course, chapter: 'Ch 7' });
  await call('POST', '/v1/scan', c, { kind: 'more_questions', course, chapter: 'Ch 7' });
  await call('POST', `/v1/scan/${qb.body.job.id}/cancel`, b);
  assert.ok((await call('GET', '/v1/scan', c)).body.jobs.some((j) => j.id === qb.body.job.id && j.status === 'queued'));

  // Settings and the quiet donation link.
  assert.equal((await owner('POST', '/owner/settings', { limits: { perAccountDaily: 5 }, donate: { url: 'https://ko-fi.com/example', message: 'Kea is free. If it helps you, you can chip in.' } })).body.limits.perAccountDaily, 5);
  assert.equal((await owner('POST', '/owner/settings', { limits: { nope: 1 } })).status, 400);
  assert.equal((await call('GET', '/v1/support')).body.url, 'https://ko-fi.com/example');
});

test('shared Claude: an account sending requests like a script is suspended and flagged for review', async () => {
  const t = await register('spam@example.com', undefined, undefined, { birthYear: 1990 });
  await owner('POST', '/owner/accounts/spam@example.com', { emailVerified: true });
  await owner('POST', '/owner/settings', { limits: { requestsBeforeSuspend: 12, refusalsBeforeFlag: 4 } });
  const course = { school: 'X', code: 'Y 1', term: 'Z' };
  let last;
  for (let i = 0; i < 12; i++) { clock += 61_000; last = await call('POST', '/v1/scan', t, { kind: 'regenerate', course }); }
  assert.equal(last.status, 403);
  assert.equal((await call('GET', '/v1/me', t)).status, 401, 'signed out');
  const flags = (await owner('GET', '/owner/flags')).body.flags.filter((f) => f.email === 'spam@example.com');
  assert.deepEqual(flags.map((f) => f.reason).sort(), ['many_refusals', 'script_requests']);
  const s = flags.find((f) => f.reason === 'script_requests');
  assert.equal(s.autoSuspended, true);
  assert.equal((await owner('POST', `/owner/flags/${s.id}/resolve`, { action: 'unsuspend', note: 'Was a test' })).status, 200);
  assert.equal((await call('POST', '/v1/auth/login', null, { email: 'spam@example.com', password: 'lantern velvet orbit' }, freshIp())).status, 200);
  await owner('POST', '/owner/settings', { limits: { requestsBeforeSuspend: 200, refusalsBeforeFlag: 15 } });
});

test('relay: the worker browses through the person’s own Kea; their Kea folder is open to the worker only while the job runs', async () => {
  const email = 'relay@example.com';
  const t = await register(email, undefined, undefined, { birthYear: 1990 });
  await owner('POST', `/owner/accounts/${email}`, { emailVerified: true });
  const other = await register('relay-other@example.com');
  const course = { school: 'Relay U', code: 'HIS 101', term: 'Fall 2027' };
  const q = await call('POST', '/v1/scan', t, { kind: 'initial_scan', course, target: 'kea/Kea/School/' });
  const jobId = q.body.job.id;
  await fetch(`${base}/v1/files/scan-inbox/${jobId}/school.json`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: '{"home":"https://d2l.relay.edu"}' });
  await call('POST', `/v1/scan/${jobId}/ready`, t);
  // (An earlier test leaves a job running; only one runs at a time.)
  for (const j of (await owner('GET', '/owner/scan/queue')).body.jobs.filter((x) => x.status === 'running')) await owner('POST', `/owner/scan/${j.id}/finish`, { ok: true });
  // Not running yet: nobody can poll it, and the worker can't touch their folder.
  assert.equal((await call('GET', `/v1/scan/${jobId}/calls`, t)).status, 404);
  assert.equal((await owner('GET', `/owner/scan/${jobId}/kea-files`)).status, 404);
  // (Earlier tests left other jobs queued ahead of this one: run through them.)
  for (let n = await owner('POST', '/owner/scan/next'); n.body.job.id !== jobId; n = await owner('POST', '/owner/scan/next')) await owner('POST', `/owner/scan/${n.body.job.id}/finish`, { ok: true });

  // Their Kea is waiting for calls; the worker asks to fetch a page; their Kea answers.
  const poll = call('GET', `/v1/scan/${jobId}/calls`, t);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await owner('GET', `/owner/scan/${jobId}/relay`)).body.connected, true);
  const asked = owner('POST', `/owner/scan/${jobId}/call`, { op: 'request', args: { url: 'https://d2l.relay.edu/d2l/api/lp/1.0/enrollments/myenrollments/' } });
  const got = await poll;
  assert.equal(got.body.calls.length, 1);
  const c1 = got.body.calls[0];
  assert.deepEqual([c1.op, c1.args.url], ['request', 'https://d2l.relay.edu/d2l/api/lp/1.0/enrollments/myenrollments/']);
  assert.equal((await call('POST', `/v1/scan/${jobId}/calls/${c1.id}/result`, other, { result: 'x' })).status, 404, 'only the job’s own person answers');
  assert.equal((await call('POST', `/v1/scan/${jobId}/calls/${c1.id}/result`, t, { result: { status: 200, body: '{"Items":[]}' } })).status, 200);
  const answer = await asked;
  assert.deepEqual(answer.body, { ok: true, result: { status: 200, body: '{"Items":[]}' }, error: null });
  // A call made before their Kea polls is queued for it.
  const asked2 = owner('POST', `/owner/scan/${jobId}/call`, { op: 'status' });
  await new Promise((r) => setTimeout(r, 50));
  const got2 = await call('GET', `/v1/scan/${jobId}/calls`, t);
  await call('POST', `/v1/scan/${jobId}/calls/${got2.body.calls[0].id}/result`, t, { ok: false, error: 'Not signed in' });
  assert.deepEqual((await asked2).body, { ok: false, result: null, error: 'Not signed in' });
  assert.equal((await owner('POST', `/owner/scan/${jobId}/call`, { op: 'postForm' })).status, 400, 'only read operations exist');

  // The worker acts as their primary device for the job's profile folder (kea/Kea/School/), nothing else: not their
  // Kea Cloud documents, not another profile.
  const putMineFile = (p, data) => fetch(`${base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: data });
  assert.equal((await putMineFile('kea/Documents/diary.docx', 'private')).status, 201);
  assert.equal((await putMineFile('kea/Kea/Work/notes.json', '{}')).status, 201);
  const putK = (p, data) => ownerFetch(ownerBase, hub.ownerKey, 'PUT', `/owner/scan/${jobId}/kea-file?path=${encodeURIComponent(p)}`, data);
  const getK = (p) => owner('GET', `/owner/scan/${jobId}/kea-file?path=${encodeURIComponent(p)}`);
  assert.equal((await putK('kea/Kea/School/Devices/primary.json', '{"id":"worker"}')).status, 200);
  assert.equal((await putK('scan-inbox/x', 'x')).status, 403);
  assert.equal((await putK('kea/Documents/diary.docx', 'x')).status, 403, 'never Kea Cloud documents');
  assert.equal((await putK('kea/Kea/Work/notes.json', '{}')).status, 403, 'never another profile');
  assert.equal((await getK('kea/Documents/diary.docx')).status, 403);
  assert.equal((await getK('kea/Kea/Work/notes.json')).status, 403);
  assert.equal((await owner('DELETE', `/owner/scan/${jobId}/kea-file?path=${encodeURIComponent('kea/Documents/diary.docx')}`)).status, 403);
  const kf = await owner('GET', `/owner/scan/${jobId}/kea-files`);
  assert.deepEqual(kf.body.files.map((f) => f.path), ['kea/Kea/School/Devices/primary.json']);
  const theirs = await call('GET', '/v1/files?prefix=kea/Kea/School/', t);
  assert.equal(theirs.body.files[0].path, 'kea/Kea/School/Devices/primary.json', 'it lands in their own storage, so their Kea follows it');

  // Finished: the relay closes and the folder is theirs alone again.
  await owner('POST', `/owner/scan/${jobId}/finish`, { ok: true });
  assert.equal((await putK('kea/Kea/School/x.json', '{}')).status, 404);
  assert.equal((await call('GET', `/v1/scan/${jobId}/calls`, t)).status, 404);
});

test('big downloads are paced to the owner’s send limit; small sync files are not; lists carry the server time', async () => {
  const t = await register('pace@example.com');
  await owner('POST', '/owner/accounts/pace@example.com/quota', { gb: 1 });
  await owner('POST', '/owner/settings', { limits: { maxSendMbps: 8 } }); // 1 MB/s
  const put = (p, data) => fetch(`${base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: data });
  assert.equal((await put('big.bin', Buffer.alloc(700 * 1024, 7))).status, 201);
  assert.equal((await put('small.json', '{"a":1}')).status, 201);
  const get = async (p) => { const t0 = Date.now(); const r = await fetch(`${base}/v1/files/${p}`, { headers: { authorization: `Bearer ${t}` } }); const b = Buffer.from(await r.arrayBuffer()); return { ms: Date.now() - t0, len: b.length }; };
  const big = await get('big.bin');
  assert.equal(big.len, 700 * 1024);
  assert.ok(big.ms >= 450, `700 KB at 1 MB/s took ${big.ms} ms`);
  assert.ok((await get('small.json')).ms < 300);
  const list = await call('GET', '/v1/files', t);
  assert.equal(list.body.now, clock);
  await owner('POST', '/owner/settings', { limits: { maxSendMbps: 10 } });
});

// Runs the queue until the given job is the running one (earlier tests leave jobs behind; they're finished as they come).
async function runUntil(jobId) {
  for (const j of (await owner('GET', '/owner/scan/queue')).body.jobs.filter((x) => x.status === 'running' && x.id !== jobId)) await owner('POST', `/owner/scan/${j.id}/finish`, { ok: false, note: 'test' });
  for (let n = await owner('POST', '/owner/scan/next'); n.body.job && n.body.job.id !== jobId; n = await owner('POST', '/owner/scan/next')) await owner('POST', `/owner/scan/${n.body.job.id}/finish`, { ok: false, note: 'test' });
}
const putOwnerFile = (p, data) => ownerFetch(ownerBase, hub.ownerKey, 'PUT', p, data);
const putMine = (t, p, data) => fetch(`${base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: data });
const readMine = async (t, p) => (await fetch(`${base}/v1/files/${p.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${t}` } })).text();

test('under 18: birth year, a parent signs off with Google (link page or in Kea), the owner can override', async () => {
  const course = { school: 'Teen High', code: 'BIO 100', term: 'Fall 2026', section: '3' };
  const ask = (t) => call('POST', '/v1/scan', t, { kind: 'more_questions', course, chapter: 'Ch 1' });
  assert.match((await call('POST', '/v1/auth/register', null, { email: 'kid@example.com', password: 'lantern velvet orbit', displayName: 'Kid', age13: true, birthYear: 2016, ...(await agreement()) }, freshIp())).body.error, /13/);

  // No birth year yet: asked for first; then set once, and it can't be changed to dodge the sign-off.
  const t = await register('teen@example.com', 'Tess Teen');
  await owner('POST', '/owner/accounts/teen@example.com', { emailVerified: true });
  assert.equal((await ask(t)).body.code, 'birth_year');
  const by = await call('POST', '/v1/me/birth-year', t, { birthYear: 2011 });
  assert.deepEqual([by.body.account.minor, by.body.account.parentSignOff], [true, 'needed']);
  assert.equal((await call('POST', '/v1/me/birth-year', t, { birthYear: 1990 })).status, 403);
  assert.equal((await ask(t)).body.code, 'parent_consent');

  // Ask a parent: not their own email; the link opens a page naming them both.
  assert.equal((await call('POST', '/v1/me/consent', t, { parentEmail: 'teen@example.com' })).status, 400);
  const req = await call('POST', '/v1/me/consent', t, { parentEmail: 'Parent@Example.com' });
  assert.equal(req.body.parentSignOff, 'pending');
  const link = new URL(req.body.link);
  assert.equal(link.pathname, '/consent');
  const page = await fetch(`${base}/consent${link.search}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /accounts\.google\.com\/gsi\/client/);
  const html = await page.text();
  assert.match(html, /Tess Teen/);
  assert.match(html, /parent@example\.com/);
  assert.equal((await fetch(`${base}/consent?t=${'0'.repeat(48)}`)).status, 404);

  // Confirming takes Google sign-in as that parent: the member's own Google, or another address, don't count.
  const token = link.searchParams.get('t');
  const confirm = (claims, approve = true) => call('POST', '/v1/consent/confirm', null, { token, approve, idToken: googleToken(claims) }, freshIp());
  assert.equal((await confirm({ email: 'someone@example.com', sub: 'g-x1' })).status, 400);
  assert.equal((await confirm({ email: 'teen@example.com', sub: 'g-x2' })).status, 400);
  assert.equal((await confirm({ email: 'parent@example.com', sub: 'g-parent' })).body.status, 'approved');
  assert.match(await (await fetch(`${base}/consent${link.search}`)).text(), /Signed off/);
  assert.equal((await call('GET', '/v1/me', t)).body.account.parentSignOff, 'approved');
  assert.equal((await ask(t)).body.status, 'queued');

  // In Kea instead: the parent signs in to Google on the member's computer.
  const t2 = await register('teen2@example.com', 'Theo Teen', undefined, { birthYear: 2010 });
  assert.equal((await call('POST', '/v1/me/consent/google', t2, { idToken: googleToken({ email: 'mom@example.com', sub: 'g-mom' }) })).status, 400, 'ask first');
  await call('POST', '/v1/me/consent', t2, { parentEmail: 'mom@example.com' });
  assert.equal((await call('POST', '/v1/me/consent/google', t2, { idToken: googleToken({ email: 'dad@example.com', sub: 'g-dad' }) })).status, 400);
  const ok2 = await call('POST', '/v1/me/consent/google', t2, { idToken: googleToken({ email: 'mom@example.com', sub: 'g-mom2' }) });
  assert.equal(ok2.body.account.parentSignOff, 'approved');
  assert.equal((await call('GET', '/v1/me/consent', t2)).body.requests[0].method, 'google-kea');

  // A parent who declines.
  const t3 = await register('teen3@example.com', 'Tia Teen', undefined, { birthYear: 2012 });
  const link3 = new URL((await call('POST', '/v1/me/consent', t3, { parentEmail: 'gran@example.com' })).body.link);
  const dec = await call('POST', '/v1/consent/confirm', null, { token: link3.searchParams.get('t'), approve: false, idToken: googleToken({ email: 'gran@example.com', sub: 'g-gran' }) }, freshIp());
  assert.equal(dec.body.status, 'declined');
  assert.equal((await call('GET', '/v1/me', t3)).body.account.parentSignOff, 'needed');

  // The owner sees who's waiting and can approve or withdraw by hand.
  const list = await owner('GET', '/owner/consents');
  assert.ok(list.body.waiting.some((w) => w.email === 'teen3@example.com'));
  assert.ok(list.body.consents.some((c) => c.email === 'teen@example.com' && c.status === 'approved' && c.method === 'google-link'));
  assert.equal((await owner('POST', '/owner/accounts/teen3@example.com/consent', { approved: true, note: 'Parent emailed' })).body.account.parentSignOff, 'approved');
  assert.equal((await owner('POST', '/owner/accounts/teen@example.com/consent', { approved: false })).body.account.parentSignOff, 'needed');
  assert.equal((await owner('POST', '/owner/accounts/teen@example.com', { birthYear: 1999 })).body.account.minor, false, 'the owner can correct a birth year');
  // Adults never see any of it.
  const adult = await register('adult@example.com', 'Ada', undefined, { birthYear: 1980 });
  assert.equal((await call('GET', '/v1/me', adult)).body.account.parentSignOff, 'not_needed');
  assert.equal((await call('POST', '/v1/me/consent', adult, { parentEmail: 'x@example.com' })).status, 400);
});

test('course material: a question batch reaches everyone who asked; classmates who joined a scan get its material; later ones share it', async () => {
  const mk = async (email) => { const t = await register(email, undefined, undefined, { birthYear: 1999 }); await owner('POST', `/owner/accounts/${email}`, { emailVerified: true }); return t; };
  const a = await mk('mat-a@example.com'), b = await mk('mat-b@example.com'), c = await mk('mat-c@example.com'), d = await mk('mat-d@example.com');
  const course = { school: 'Material State', code: 'BIO 2010', term: 'Spring 2027', section: '5' };
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'more_questions', course, chapter: 'Ch 4', target: '../x' })).status, 400, 'only a Kea folder');

  // A asks for 25 more on Ch 4; B (same section) joins. Each says where their Kea's folder is.
  const qa = await call('POST', '/v1/scan', a, { kind: 'more_questions', course, chapter: 'Ch 4', target: 'kea/Kea/School/', detail: { courseCode: 'BIO 2010', chapter: 'Ch 4' } });
  assert.equal(qa.body.status, 'queued');
  // (B isn't in A's section yet: asking makes a request to A instead of joining A's batch.)
  assert.equal((await call('POST', '/v1/scan', b, { kind: 'more_questions', course, chapter: 'Ch 4', target: 'kea/Kea/Biology' })).body.status, 'pending');
  const code = (await call('POST', '/v1/course-sections/code', a, { course })).body.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal((await call('POST', '/v1/course-sections/code', b, { course })).status, 404, 'only people in the section see its code');
  assert.equal((await call('POST', '/v1/scan', b, { kind: 'more_questions', course, chapter: 'Ch 4', target: 'kea/Kea/Biology', joinCode: 'AAAAAAAAAA' })).status, 404);
  assert.equal((await call('POST', '/v1/scan', b, { kind: 'more_questions', course, chapter: 'Ch 4', target: 'kea/Kea/Biology', joinCode: code.toLowerCase() })).body.status, 'joined');
  const jobId = qa.body.job.id;
  await runUntil(jobId);
  const info = await owner('GET', `/owner/scan/${jobId}`);
  assert.deepEqual([info.body.job.kind, info.body.job.chapter, info.body.job.target, info.body.job.batchSize, info.body.job.detail.courseCode], ['more_questions', 'Ch 4', 'kea/Kea/School/', 25, 'BIO 2010']);
  assert.deepEqual(info.body.members.map((m) => m.target), ['kea/Kea/Biology/']);
  // The worker adds the batch to the section's pool; the Hub copies it to both when the job finishes.
  const set = JSON.stringify({ entry: { id: 'exam-q1', kind: 'exam', chapters: ['Ch 4'] }, set: { questions: [{ q: 'What is ATP?', choices: ['a', 'b'], answer: 0 }] } });
  assert.equal((await putOwnerFile(`/owner/scan/${jobId}/course-file?path=material/questions/exam-q1.json`, set)).status, 200);
  assert.deepEqual((await owner('GET', `/owner/scan/${jobId}/course-files?prefix=material/`)).body.files.map((f) => f.path), ['material/questions/exam-q1.json']);
  const fin = await owner('POST', `/owner/scan/${jobId}/finish`, { ok: true });
  assert.equal(fin.body.delivered, 2);
  assert.equal(await readMine(a, 'kea/Kea/School/Shared/questions/exam-q1.json'), set);
  assert.equal(await readMine(b, 'kea/Kea/Biology/Shared/questions/exam-q1.json'), set);

  // A first scan: C asks; D joins without saying where (D's Kea folder is found from what D already syncs).
  const course2 = { ...course, code: 'BIO 2020' };
  assert.equal((await putMine(d, 'kea/Kea/Dee/Devices/primary.json', '{"id":"d1"}')).status, 201);
  const sc = await call('POST', '/v1/scan', c, { kind: 'initial_scan', course: course2, target: 'kea/Kea/School/' });
  assert.equal((await call('POST', '/v1/scan', d, { kind: 'initial_scan', course: course2 })).body.status, 'pending');
  const scanId = sc.body.job.id;
  const askD = (await call('GET', '/v1/course-sections/requests', c)).body.incoming[0];
  await call('POST', `/v1/course-sections/requests/${askD.id}/decide`, c, { approve: true });
  await putMine(c, `scan-inbox/${scanId}/job.json`, '{}');
  await call('POST', `/v1/scan/${scanId}/ready`, c);
  await runUntil(scanId);
  await putOwnerFile(`/owner/scan/${scanId}/course-file?path=material/Textbooks/BIO 2020/Chapter 1.pdf`, '%PDF chapter one');
  assert.equal((await owner('POST', `/owner/scan/${scanId}/finish`, { ok: true })).body.delivered, 1, 'the requester already has it (the worker wrote their folder)');
  assert.equal(await readMine(d, 'kea/Kea/Dee/Shared/Textbooks/BIO 2020/Chapter 1.pdf'), '%PDF chapter one');
  assert.equal((await call('GET', '/v1/files?prefix=kea/Kea/School/Shared/', c)).body.files.length, 0);

  // Someone in the section later: shared at once, material included, no Claude.
  const code2 = (await call('POST', '/v1/course-sections/code', d, { course: course2 })).body.code;
  // Asking without the code: a request (once; no new notices for each try); a "no" holds for a day.
  const ask = await call('POST', '/v1/scan', a, { kind: 'initial_scan', course: course2, target: 'kea/Kea/School/' });
  assert.equal(ask.body.status, 'pending');
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'initial_scan', course: course2 })).body.request.id, ask.body.request.id);
  await call('POST', `/v1/course-sections/requests/${ask.body.request.id}/decide`, d, { approve: false });
  assert.equal((await call('POST', '/v1/scan', a, { kind: 'initial_scan', course: course2 })).body.status, 'declined');
  assert.equal(await readMine(a, 'kea/Kea/School/Shared/Textbooks/BIO 2020/Chapter 1.pdf'), '{"error":"No such file."}');
  // With the code: in at once, material included, no Claude.
  const sh = await call('POST', '/v1/scan', a, { kind: 'initial_scan', course: course2, target: 'kea/Kea/School/', joinCode: code2 });
  assert.deepEqual([sh.body.status, sh.body.delivered], ['shared', 1]);
  assert.equal(await readMine(a, 'kea/Kea/School/Shared/Textbooks/BIO 2020/Chapter 1.pdf'), '%PDF chapter one');
  // A failed job delivers nothing.
  const qf = await call('POST', '/v1/scan', b, { kind: 'more_questions', course, chapter: 'Ch 9', target: 'kea/Kea/Biology/' });
  await runUntil(qf.body.job.id);
  await putOwnerFile(`/owner/scan/${qf.body.job.id}/course-file?path=material/questions/exam-bad.json`, '{}');
  assert.equal((await owner('POST', `/owner/scan/${qf.body.job.id}/finish`, { ok: false, note: 'Claude stopped' })).body.delivered, 0);
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

test('leaderboard name for every class, invite preview, invite link page, leaving a class', async () => {
  const teach = await register('lb-inst@example.com', 'Lena Instructor');
  await owner('POST', '/owner/accounts/lb-inst@example.com', { canHost: true });
  const a = (await call('POST', '/v1/classes', teach, { title: 'Chemistry 110' })).body.class;
  const b = (await call('POST', '/v1/classes', teach, { title: 'Physics 120' })).body.class;
  const codeA = (await call('POST', `/v1/classes/${a.id}/invites`, teach, {})).body.code;
  const codeB = (await call('POST', `/v1/classes/${b.id}/invites`, teach, {})).body.code;
  const s = await register('lb-s@example.com', 'Rita Real');

  // The account's choice starts as the real name.
  assert.deepEqual((await call('GET', '/v1/me', s)).body.account.leaderboard, { show: 'name', nickname: null });
  assert.equal((await call('POST', '/v1/me/leaderboard', s, { show: 'nickname' })).status, 400, 'a nickname is needed first');

  // Preview before joining: the class, not the members.
  const pre = await call('GET', `/v1/invites/${codeA.toLowerCase()}`, s);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.class.title, 'Chemistry 110');
  assert.equal(pre.body.role, 'student');
  assert.equal(pre.body.alreadyMember, false);
  assert.equal((await call('GET', '/v1/invites/AAAAAAAAAA', s)).status, 404);

  await call('POST', '/v1/join', s, { code: codeA });
  assert.equal((await call('GET', `/v1/invites/${codeA}`, s)).body.alreadyMember, true);
  const set = await call('POST', '/v1/me/leaderboard', s, { show: 'nickname', nickname: 'Rocket' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.account.leaderboard, { show: 'nickname', nickname: 'Rocket' });
  // Applied to the class already joined, and the default for the next one.
  assert.equal((await call('GET', `/v1/classes/${a.id}`, s)).body.class.board, 'nickname');
  await call('POST', '/v1/join', s, { code: codeB });
  const inB = (await call('GET', `/v1/classes/${b.id}`, s)).body.class;
  assert.equal(inB.board, 'nickname');
  assert.equal(inB.nickname, 'Rocket');

  // Hidden everywhere, but keep a class's own choice when asked.
  await call('POST', `/v1/classes/${a.id}/me`, s, { board: 'name' });
  await call('POST', '/v1/me/leaderboard', s, { show: 'hidden', everyClass: false });
  assert.equal((await call('GET', `/v1/classes/${a.id}`, s)).body.class.board, 'name');
  assert.equal((await call('GET', '/v1/me', s)).body.account.leaderboard.show, 'hidden');

  // The link page names the code and nothing else.
  const page = await fetch(`${base}/join/${codeA.toLowerCase()}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.ok(html.includes(codeA));
  assert.ok(!html.includes('Chemistry'));
  assert.equal((await fetch(`${base}/join/<script>`)).status, 404);

  // Leaving: gone from My classes; the creator can't leave.
  assert.equal((await call('POST', `/v1/classes/${b.id}/leave`, s)).status, 200);
  assert.deepEqual((await call('GET', '/v1/classes', s)).body.classes.map((c) => c.title), ['Chemistry 110']);
  assert.equal((await call('POST', `/v1/classes/${a.id}/leave`, teach)).status, 400);
});
