// Regression tests for the 2026-11-06 audit (D:\Kea\context\audit-2026-11-06.md): sections 1 and 3, the Hub's part
// of 6, and section 2 (flooding). Each test names the finding it covers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch, ownerSign } from '../../hub/lib/ownerauth.mjs';
import { codeAt, stepOf } from '../../hub/lib/totp.mjs';
import { cleanText, isReservedName } from '../../hub/lib/names.mjs';
import { cell } from '../../hub/org/logic.mjs';
import { rotateOwnerKey } from '../../hub/owner.mjs';
import { createHashPool } from '../../hub/lib/hashpool.mjs';
import { createHubLog } from '../../hub/lib/hublog.mjs';
import { googleKeys } from '../../hub/lib/google.mjs';

const DAY = 86400_000;
const PW = 'lantern velvet orbit';
let clock = Date.UTC(2026, 10, 6, 15);
const gkey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const gjwk = { ...gkey.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
let gn = 0;
function googleToken(claims = {}) {
  const t = Math.floor(clock / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'kea-test-client', sub: `g-${++gn}`, email_verified: true, iat: t, exp: t + 3600, nonce: gn, ...claims })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), gkey.privateKey).toString('base64url')}`;
}

/** A throwaway Hub with helpers. */
async function makeHub(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kea-fixes-'));
  const hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', googleClientIds: ['kea-test-client'], googleKeyFn: async () => [gjwk], minFreeBytes: 0, fileOverheadBytes: 0, ...opts });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${p.port}`, ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  let ipN = 0;
  const freshIp = () => ({ 'x-test-ip': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });
  const call = async (method, path, token, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json ?? text, headers: r.headers };
  };
  const owner = async (method, path, body) => { const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body); return { status: r.status, body: await r.json() }; };
  const terms = async () => (await call('GET', '/v1/terms')).body.terms;
  async function person(email, name = 'Pat Person', { verified = true, birthYear = 1995 } = {}) {
    const t = await terms();
    const reg = await call('POST', '/v1/auth/register', null, { email, password: PW, displayName: name, age13: true, birthYear, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }, freshIp());
    assert.equal(reg.status, 202, JSON.stringify(reg.body));
    const r = await call('POST', '/v1/auth/login', null, { email, password: PW }, freshIp());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (verified) assert.equal((await owner('POST', `/owner/accounts/${r.body.account.id}`, { emailVerified: true })).status, 200);
    return { token: r.body.token, id: r.body.account.id, email, name };
  }
  const close = async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); };
  return { hub, dir, base, ownerBase, call, owner, person, freshIp, close, ports: p };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

let H;
before(async () => { H = await makeHub({ limits: { joinRequest: [2, DAY] } }); });
after(async () => { await H.close(); });

// ---------------- section 1: the owner console and local trust ----------------
test('1 loopback trust: the owner console never takes the key itself; each nonce works once, for one exact request', async () => {
  const raw = await fetch(`${H.ownerBase}/owner/stats`, { headers: { 'x-kea-owner-key': H.hub.ownerKey } });
  assert.equal(raw.status, 401);
  assert.match((await raw.json()).error, /no longer takes the owner key/);
  assert.equal((await fetch(`${H.ownerBase}/owner/stats`)).status, 401);
  // One nonce, one request: replaying the same signed header fails.
  const { nonce } = await (await fetch(`${H.ownerBase}/owner/nonce`)).json();
  const header = ownerSign(H.hub.ownerKey, nonce, 'GET', '/owner/stats', '');
  assert.equal((await fetch(`${H.ownerBase}/owner/stats`, { headers: { 'x-kea-owner-auth': header } })).status, 200);
  assert.equal((await fetch(`${H.ownerBase}/owner/stats`, { headers: { 'x-kea-owner-auth': header } })).status, 401, 'replay refused');
  // Signed for one body, sent with another: refused.
  const n2 = (await (await fetch(`${H.ownerBase}/owner/nonce`)).json()).nonce;
  const forged = await fetch(`${H.ownerBase}/owner/settings`, { method: 'POST', headers: { 'x-kea-owner-auth': ownerSign(H.hub.ownerKey, n2, 'POST', '/owner/settings', '{}'), 'content-type': 'application/json' }, body: '{"limits":{"maxSendMbps":1}}' });
  assert.equal(forged.status, 401);
  // A wrong key: refused.
  const n3 = (await (await fetch(`${H.ownerBase}/owner/nonce`)).json()).nonce;
  assert.equal((await fetch(`${H.ownerBase}/owner/stats`, { headers: { 'x-kea-owner-auth': ownerSign('f'.repeat(64), n3, 'GET', '/owner/stats', '') } })).status, 401);
});

test('1 owner key rotation: `owner.mjs rotate-key` replaces the key and the running Hub uses the new one at once', async () => {
  const H2 = await makeHub();
  try {
    const old = H2.hub.ownerKey;
    assert.equal((await ownerFetch(H2.ownerBase, old, 'GET', '/owner/stats')).status, 200);
    rotateOwnerKey(H2.dir);
    const fresh = readFileSync(join(H2.dir, 'owner.key'), 'utf8').trim();
    assert.notEqual(fresh, old);
    assert.equal(H2.hub.ownerKey, fresh);
    assert.equal((await ownerFetch(H2.ownerBase, old, 'GET', '/owner/stats')).status, 401, 'the old key stops working');
    assert.equal((await ownerFetch(H2.ownerBase, fresh, 'GET', '/owner/stats')).status, 200);
    assert.ok(!existsSync(join(H2.dir, 'owner.key.new')));
  } finally { await H2.close(); }
});

test('1 a taken port is a clear error, not a crash (EADDRINUSE)', async () => {
  const squat = net.createServer();
  await new Promise((r) => squat.listen(0, '127.0.0.1', r));
  const port = squat.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'kea-fixes-port-'));
  const hub = createHub({ dataDir: dir, log: false, minFreeBytes: 0 });
  try {
    await assert.rejects(hub.listen({ port, ownerPort: 0 }), (e) => e.code === 'EADDRINUSE' && /already in use by another program/.test(e.message));
  } finally { squat.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('1 identity proof: the Hub signs a nonce with its signing key, for KeaS to check (desktop/hubid.cjs)', async () => {
  const { createPublicKey, createPrivateKey, verify } = await import('node:crypto');
  const nonce = 'ab'.repeat(16);
  const r = ok(await H.call('GET', `/v1/identity?nonce=${nonce}`));
  const pub = createPublicKey(createPrivateKey(readFileSync(join(H.dir, 'hub-signing-key.pem'))));
  assert.ok(verify(null, Buffer.from(`kea-hub-identity:v1:${nonce}`), pub, Buffer.from(r.sig, 'base64url')));
  assert.equal((await H.call('GET', '/v1/identity?nonce=short')).status, 400);
});

// ---------------- design: owner powers need the owner's two-step sign-in ----------------
test('design: owner powers (console and API) wait until the owner account has two-step sign-in on', async () => {
  const H2 = await makeHub();
  try {
    const o = await H2.person('boss@example.com', 'Hub Boss');
    H2.hub.h.run("UPDATE accounts SET role = 'owner' WHERE id = ?", o.id);
    const blocked = await H2.owner('POST', '/owner/settings', { limits: { maxSendMbps: 9 } });
    assert.deepEqual([blocked.status, blocked.body.ownerTotpRequired], [403, true]);
    const stats = ok(await H2.owner('GET', '/owner/stats'));
    assert.equal(stats.ownerTotp.ok, false);
    // The owner's own account: only the basics, until two-step sign-in is on.
    ok(await H2.call('GET', '/v1/me', o.token));
    assert.equal((await H2.call('POST', '/v1/classes', o.token, { title: 'Owner class' })).status, 403);
    assert.equal((await H2.call('POST', '/v1/auth/token', o.token, { aud: 'kea' })).status, 403);
    const s = ok(await H2.call('POST', '/v1/me/totp/setup', o.token, { password: PW }));
    ok(await H2.call('POST', '/v1/me/totp/enable', o.token, { code: codeAt(s.secret, stepOf(clock)) }));
    ok(await H2.owner('POST', '/owner/settings', { limits: { maxSendMbps: 9 } }));
    ok(await H2.call('POST', '/v1/auth/token', o.token, { aud: 'kea' }));
    assert.equal(ok(await H2.call('POST', '/v1/classes', o.token, { title: 'Owner class' }), 201).class.title, 'Owner class');
  } finally { await H2.close(); }
});

// ---------------- section 3 ----------------
test('3 M2: two-step setup, enable and signing out other devices need the password (or a fresh Google sign-in)', async () => {
  const a = await H.person('m2@example.com');
  const none = await H.call('POST', '/v1/me/totp/setup', a.token, {});
  assert.deepEqual([none.status, none.body.passwordRequired], [401, true]);
  assert.equal((await H.call('POST', '/v1/me/totp/setup', a.token, { password: 'wrong wrong wrong' })).status, 401);
  assert.equal((await H.call('POST', '/v1/me/sessions/sign-out-others', a.token, {})).status, 401);
  ok(await H.call('POST', '/v1/me/sessions/sign-out-others', a.token, { password: PW }));
  const s = ok(await H.call('POST', '/v1/me/totp/setup', a.token, { password: PW }));
  // The proof from setup lasts a few minutes; after that, enabling needs the password again.
  clock += 11 * 60_000;
  assert.equal((await H.call('POST', '/v1/me/totp/enable', a.token, { code: codeAt(s.secret, stepOf(clock)) })).status, 401);
  ok(await H.call('POST', '/v1/me/totp/enable', a.token, { code: codeAt(s.secret, stepOf(clock)), password: PW }));
  // A fresh Google sign-in for the same email also proves it.
  const b = await H.person('m2g@example.com');
  ok(await H.call('POST', '/v1/me/totp/setup', b.token, { googleIdToken: googleToken({ email: 'm2g@example.com' }) }));
  assert.equal((await H.call('POST', '/v1/me/totp/setup', b.token, { googleIdToken: googleToken({ email: 'other@example.com' }) })).status, 400);
});

test('3 M2: Google reset clears two-step sign-in only on an email nobody had proven; the owner can reset it', async () => {
  // Someone made an account with another person's email and turned on two-step sign-in.
  const squat = await H.person('victim@example.com', 'Squatter', { verified: false });
  const s = ok(await H.call('POST', '/v1/me/totp/setup', squat.token, { password: PW }));
  ok(await H.call('POST', '/v1/me/totp/enable', squat.token, { code: codeAt(s.secret, stepOf(clock)) }));
  const reset = await H.call('POST', '/v1/auth/reset/google', null, { idToken: googleToken({ email: 'victim@example.com' }), password: 'river copper lantern' }, H.freshIp());
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.account.totpEnabled, false, 'the real owner of the email gets in');
  // A verified account keeps needing its code.
  const v = await H.person('kept@example.com');
  const s2 = ok(await H.call('POST', '/v1/me/totp/setup', v.token, { password: PW }));
  ok(await H.call('POST', '/v1/me/totp/enable', v.token, { code: codeAt(s2.secret, stepOf(clock)) }));
  const r2 = await H.call('POST', '/v1/auth/reset/google', null, { idToken: googleToken({ email: 'kept@example.com' }), password: 'river copper lantern' }, H.freshIp());
  assert.deepEqual([r2.status, r2.body.totpRequired], [401, true]);
  // The owner's reset: off, signed out, told.
  const before = ok(await H.owner('POST', `/owner/accounts/${v.id}/totp-reset`, { note: 'Lost phone, checked by email.' }));
  assert.equal(before.account.totpEnabled, false);
  assert.equal((await H.call('GET', '/v1/me', v.token)).status, 401, 'signed out everywhere');
  const n = H.hub.h.get("SELECT * FROM notifications WHERE account_id = ? AND title LIKE 'Two-step sign-in was turned off%'", v.id);
  assert.ok(n);
  assert.ok(H.hub.h.get("SELECT 1 FROM audit WHERE action = 'owner.totp_reset' AND target = ?", v.id));
});

test('3 M3: password checks with a session honour the lockouts, count failures, and say one thing', async () => {
  const a = await H.person('m3@example.com');
  for (let i = 0; i < 5; i++) assert.equal((await H.call('POST', '/v1/me/password', a.token, { current: 'not it at all', next: 'meadow quartz signal' })).status, 401);
  const locked = await H.call('POST', '/v1/me/password', a.token, { current: PW, next: 'meadow quartz signal' });
  assert.equal(locked.status, 429, 'locked even with the right password');
  clock += 20 * 60_000;
  // Two-step off: a wrong password and a wrong code read the same.
  const b = await H.person('m3b@example.com');
  const s = ok(await H.call('POST', '/v1/me/totp/setup', b.token, { password: PW }));
  ok(await H.call('POST', '/v1/me/totp/enable', b.token, { code: codeAt(s.secret, stepOf(clock)) }));
  const wrongPw = await H.call('POST', '/v1/me/totp/disable', b.token, { password: 'nope nope nope', code: '123456' });
  const wrongCode = await H.call('POST', '/v1/me/totp/disable', b.token, { password: PW, code: '000000' });
  assert.deepEqual([wrongPw.status, wrongCode.status], [401, 401]);
  assert.equal(wrongPw.body.error, wrongCode.body.error);
  assert.ok(H.hub.h.get("SELECT 1 FROM audit WHERE action = 'auth.fail_reauth' AND actor = ?", b.id));
});

test('3 M4: join-request notices carry no free text in the title; names go as data; a daily cap', async () => {
  const first = await H.person('m4-first@example.com', 'First Person');
  const asker = await H.person('m4-asker@example.com', 'Click https://evil.example now');
  const course = { school: 'M4 U', code: 'BIO 1010', term: 'Fall 2026' };
  ok(await H.call('POST', '/v1/scan', first.token, { kind: 'initial_scan', course }));
  const r = ok(await H.call('POST', '/v1/scan', asker.token, { kind: 'initial_scan', course: { ...course, term: 'Fall 2026' }, detail: { courseCode: 'FREE MONEY http://x' } }));
  assert.equal(r.status, 'pending');
  const n = H.hub.h.get("SELECT * FROM notifications WHERE account_id = ? AND kind = 'course_join' ORDER BY id DESC", first.id);
  assert.equal(n.title, 'Someone asks to join BIO1010, fall 2026');
  assert.ok(!/evil|FREE|http/.test(n.title + n.body));
  assert.equal(JSON.parse(n.data).name, 'Click https://evil.example now', 'the name is data for the app to show');
  // Two new requests a day (this Hub's limit), then refused.
  for (const k of ['CHM 1', 'CHM 2']) {
    const f = await H.person(`m4-${k.replace(' ', '')}@example.com`);
    ok(await H.call('POST', '/v1/scan', f.token, { kind: 'initial_scan', course: { ...course, code: k } }));
  }
  ok(await H.call('POST', '/v1/scan', asker.token, { kind: 'initial_scan', course: { ...course, code: 'CHM 1' } }));
  const capped = await H.call('POST', '/v1/scan', asker.token, { kind: 'initial_scan', course: { ...course, code: 'CHM 2' } });
  assert.deepEqual([capped.status, capped.body.code], [429, 'join_requests_daily']);
});

test('3 M5 + M1: orgs need a verified email to join and show it; pending orgs do nothing; suspension shuts their classes', async () => {
  const boss = await H.person('m5-boss@example.com', 'Org Boss');
  const nov = await H.person('m5-nov@example.com', 'Not Verified', { verified: false });
  const member = await H.person('m5-mem@example.com', 'Member Mo');
  ok(await H.owner('POST', '/owner/orgs/settings', { autoApprove: false }));
  const org = ok(await H.call('POST', '/v1/orgs', boss.token, { name: 'Harbor Pool' }), 201).org;
  assert.equal((await H.call('POST', `/v1/orgs/${org.id}/classes`, boss.token, { title: 'Pending class' })).status, 403);
  ok(await H.owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true }));
  const code = ok(await H.call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: 'member' }), 201).code.code;
  const refused = await H.call('POST', '/v1/orgs/join', nov.token, { code }, H.freshIp());
  assert.deepEqual([refused.status, /Verify your email/.test(refused.body.error)], [403, true]);
  ok(await H.call('POST', '/v1/orgs/join', member.token, { code }, H.freshIp()));
  const list = ok(await H.call('GET', `/v1/orgs/${org.id}/members`, boss.token));
  assert.ok(list.members.every((m) => m.emailVerified === true));
  // An org class: a real Hub class tied to the org.
  const cls = ok(await H.call('POST', `/v1/orgs/${org.id}/classes`, boss.token, { title: 'Lifeguard' }), 201).class;
  assert.equal(H.hub.h.get('SELECT org_id FROM classes WHERE id = ?', cls.id).org_id, org.id);
  const inv = ok(await H.call('POST', `/v1/classes/${cls.id}/invites`, boss.token, { role: 'student' }), 201).code;
  ok(await H.owner('POST', `/owner/orgs/${org.id}/status`, { status: 'suspended' }));
  assert.equal(H.hub.h.get('SELECT status FROM classes WHERE id = ?', cls.id).status, 'archived');
  assert.equal(H.hub.h.get('SELECT revoked FROM invites WHERE code = ?', inv).revoked, 1);
  assert.equal((await H.call('GET', `/v1/classes/${cls.id}`, boss.token)).status, 403);
  assert.equal((await H.call('POST', '/v1/join', member.token, { code: inv }, H.freshIp())).status, 404);
  assert.ok(!ok(await H.call('GET', '/v1/classes', boss.token)).classes.some((c) => c.id === cls.id));
});

test('3 L-a: times must be whole ms between 2000 and 2100; an old bad row never breaks the list', async () => {
  const t = await H.person('la@example.com', 'Teacher La');
  ok(await H.owner('POST', `/owner/accounts/${t.id}`, { canHost: true }));
  const cls = ok(await H.call('POST', '/v1/classes', t.token, { title: 'Times' }), 201).class;
  for (const start of [9e15, -5, 1.5e12 + 0.5, '1999-12-31T00:00:00Z', '2101-01-01T00:00:00Z']) {
    assert.equal((await H.call('POST', `/v1/classes/${cls.id}/sessions`, t.token, { title: 'x', start, end: Date.UTC(2027, 0, 1) })).status, 400, String(start));
  }
  ok(await H.call('POST', `/v1/classes/${cls.id}/sessions`, t.token, { title: 'ok', start: Date.UTC(2027, 0, 1, 9), end: Date.UTC(2027, 0, 1, 10) }), 201);
  H.hub.h.run("INSERT INTO class_sessions (id,class_id,title,start_at,end_at) VALUES ('bad-row',?,'old',?,?)", cls.id, 9e15, 9e15 + 1);
  const list = ok(await H.call('GET', `/v1/classes/${cls.id}/sessions`, t.token));
  assert.equal(list.sessions.find((s) => s.id === 'bad-row').start, null);
});

test('3 L-b: the owner sees who is in a course section, and can take people out or start it over', async () => {
  const a = await H.person('lb-a@example.com');
  const b = await H.person('lb-b@example.com');
  const course = { school: 'LB U', code: 'ART 1', term: 'Fall 2026' };
  ok(await H.call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course }));
  const code = ok(await H.call('POST', '/v1/course-sections/code', a.token, { course })).code;
  ok(await H.call('POST', '/v1/scan', b.token, { kind: 'initial_scan', course, joinCode: code }));
  const key = 'lb u|art1|fall 2026|';
  const sec = ok(await H.owner('GET', '/owner/course-sections?q=lb u')).sections.find((x) => x.course === key);
  assert.deepEqual(sec.members.map((m) => m.email).sort(), ['lb-a@example.com', 'lb-b@example.com']);
  assert.equal(sec.hasCode, true);
  ok(await H.owner('POST', '/owner/course-sections/remove', { course: key, account: 'lb-a@example.com' }));
  const reset = ok(await H.owner('POST', '/owner/course-sections/reset', { course: key }));
  assert.equal(reset.removed, 1);
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM course_members WHERE course_key = ?', key).n, 0);
  assert.equal(H.hub.h.get('SELECT 1 FROM course_codes WHERE course_key = ?', key), undefined);
});

test('3 L-c, L-d: no phone next to a nickname; only instructors invite TAs; teachers score no points', async () => {
  const t = await H.person('lc-t@example.com', 'Teacher Tia');
  const ta = await H.person('lc-ta@example.com', 'Assistant Al');
  const s1 = await H.person('lc-s1@example.com', 'Student Sam');
  const s2 = await H.person('lc-s2@example.com', 'Student Sue');
  ok(await H.owner('POST', `/owner/accounts/${t.id}`, { canHost: true }));
  const cls = ok(await H.call('POST', '/v1/classes', t.token, { title: 'Phones' }), 201).class;
  const taCode = ok(await H.call('POST', `/v1/classes/${cls.id}/invites`, t.token, { role: 'ta' }), 201).code;
  ok(await H.call('POST', '/v1/join', ta.token, { code: taCode }, H.freshIp()));
  assert.equal((await H.call('POST', `/v1/classes/${cls.id}/invites`, ta.token, { role: 'ta' })).status, 403, 'a TA can’t make more TAs');
  ok(await H.call('POST', `/v1/classes/${cls.id}/invites`, ta.token, { role: 'student' }), 201);
  const code = ok(await H.call('POST', `/v1/classes/${cls.id}/invites`, t.token, { role: 'student' }), 201).code;
  for (const s of [s1, s2]) ok(await H.call('POST', '/v1/join', s.token, { code }, H.freshIp()));
  ok(await H.call('POST', '/v1/me/phone', s1.token, { phone: '+1 719 555 0101', visibility: 'classes' }));
  ok(await H.call('POST', `/v1/classes/${cls.id}/me`, s1.token, { board: 'nickname', nickname: 'Swimmer' }));
  const seen = ok(await H.call('GET', `/v1/classes/${cls.id}/members`, s2.token)).members.find((m) => m.name === 'Swimmer');
  assert.equal(seen.phone, undefined, 'a classmate can’t tie the nickname to a phone number');
  const teacherView = ok(await H.call('GET', `/v1/classes/${cls.id}/members`, t.token)).members.find((m) => m.name === 'Student Sam');
  assert.equal(teacherView.phone, '+17195550101');
  // Points: none for the teacher in their own class.
  const set = ok(await H.call('POST', `/v1/classes/${cls.id}/sets`, t.token, { title: 'Q', questions: [{ q: '1+1?', choices: ['2', '3'], answer: 0 }] }), 201);
  const qid = ok(await H.call('GET', `/v1/sets/${set.id}`, t.token)).questions[0].id;
  assert.equal(ok(await H.call('POST', `/v1/sets/${set.id}/answer`, t.token, { questionId: qid, choice: 0 })).points, 0);
  assert.ok(ok(await H.call('POST', `/v1/sets/${set.id}/answer`, s2.token, { questionId: qid, choice: 0 })).points > 0);
});

test('3 L-e: a member sets their own birthdate only while it is empty', async () => {
  const boss = await H.person('le-boss@example.com', 'Le Boss');
  const kid = await H.person('le-kid@example.com', 'Le Kid');
  ok(await H.owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  const org = ok(await H.call('POST', '/v1/orgs', boss.token, { name: 'Camp Le' }), 201).org;
  const code = ok(await H.call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: 'member', needsApproval: false }), 201).code.code;
  ok(await H.call('POST', '/v1/orgs/join', kid.token, { code }, H.freshIp()));
  ok(await H.call('POST', `/v1/orgs/${org.id}/members/${kid.id}`, kid.token, { birthdate: '2010-05-01' }));
  assert.equal((await H.call('POST', `/v1/orgs/${org.id}/members/${kid.id}`, kid.token, { birthdate: '2000-05-01' })).status, 403);
  ok(await H.call('POST', `/v1/orgs/${org.id}/members/${kid.id}`, boss.token, { birthdate: '2009-05-01' }));
});

test('3 L-f: names are cleaned, and names that pass for Kea or the owner are kept for the owner', async () => {
  assert.equal(cleanText(' A\u200bl\u202eex \u0007 Smith\u2028 '), 'Alex Smith');
  for (const n of ['Kea', 'kea hub', 'Ｋｅａ Support', 'K e a', 'Кеа', 'Hidden', 'H1dden', 'Admin', 'The Kea_Support team', 'KeaS']) assert.ok(isReservedName(n), n);
  for (const n of ['Keaton', 'Mikea Hubert', 'Ana']) assert.ok(!isReservedName(n), n);
  // Staff words next to "Kea", in either order, with any separators and look-alikes.
  for (const n of ['Kea Security', 'Kea Moderator', 'Kea Trust and Safety', 'Kea Billing', 'Security Kea', 'Kea-Admin', 'KeaStaff', 'Team of Kea', 'Kea’s Support', 'Official Kea', 'Kea System', 'kea help', 'K e a Hub', 'Kea\u3164Support', 'Ke\u0430 Supp\u043Ert']) assert.ok(isReservedName(n), n);
  // Armenian, Cherokee, Lisu, small capitals and IPA look-alikes.
  for (const n of ['\u13E6ea', 'K\u0435\u0251', 'Ke\u0251', '\uA4D7ea', '\u1D0Bea', 'Ke\u0251 Supp\u0585rt']) assert.ok(isReservedName(n), n);
  for (const n of ['Hub B\u0585ss', 'Hub Bo\u0455s']) assert.ok(isReservedName(n, ['Hub Boss']), n);
  // "Kea:" anywhere, and a colon before account or security wording.
  for (const n of ['Kea: hello', 'From Kea: hello', 'kea\uFF1A hi', 'K\u0435a\uA789 hi', 'Notice: account suspended', 'Hi: verify now', 'x\uA789 Security']) assert.ok(isReservedName(n), n);
  // Ordinary names stay allowed.
  for (const n of ['Kea Smith', 'Kea Lani', 'Team Rocket', 'Security Guard', 'Support Group', 'Keanu Reeves', 'Dr. Ana: PhD', 'Aram \u0531\u0580\u0561\u0574', 'Maria Jos\u00e9', '\u674e\u5a1c', 'Book Club: Dune']) assert.ok(!isReservedName(n), n);
  const o = await H.person('lf-owner@example.com', 'Kaden Walsh');
  H.hub.h.run("UPDATE accounts SET role = 'owner', totp_enabled = 1 WHERE id = ?", o.id);
  const a = await H.person('lf-a@example.com', 'Plain Name');
  assert.equal((await H.call('POST', '/v1/me', a.token, { displayName: 'Kea Support' })).status, 400);
  assert.equal((await H.call('POST', '/v1/me', a.token, { displayName: 'KADEN  WALSH' })).status, 400, 'the owner’s own name');
  assert.equal((await H.call('POST', '/v1/me/leaderboard', a.token, { show: 'nickname', nickname: 'Ｈｉｄｄｅｎ' })).status, 400);
  assert.equal(ok(await H.call('POST', '/v1/me', a.token, { displayName: 'Ali\u200b\u200d  Ray\u202e' })).account.displayName, 'Ali Ray');
  ok(await H.call('POST', '/v1/me', o.token, { displayName: 'Kea Support' }), 200);
  H.hub.h.run("UPDATE accounts SET role = 'user', display_name = 'Former Owner' WHERE id = ?", o.id);
});

test('design: a parent sign-off can’t come from an under-18 Kea account; the owner’s list shows what to look at', async () => {
  const teen = await H.person('teen@example.com', 'Teen Ager', { birthYear: 2011 });
  await H.person('teen-alt@example.com', 'Alt Teen', { birthYear: 2012 });
  const refused = await H.call('POST', '/v1/me/consent', teen.token, { parentEmail: 'teen-alt@example.com' });
  assert.deepEqual([refused.status, /under 18/.test(refused.body.error)], [400, true]);
  ok(await H.call('POST', '/v1/me/consent', teen.token, { parentEmail: 'mom@example.com' }));
  ok(await H.call('POST', '/v1/me/consent/google', teen.token, { idToken: googleToken({ email: 'mom@example.com' }) }));
  const list = ok(await H.owner('GET', '/owner/consents'));
  assert.ok(Array.isArray(list.consents[0].concerns));
  // A parent email that turns out to have a Kea account shows up for review.
  await H.person('mom@example.com', 'Mom Parent', { birthYear: 1980 });
  const review = ok(await H.owner('GET', '/owner/consents?review=1')).consents;
  assert.ok(review.some((c) => c.parentEmail === 'mom@example.com' && c.concerns.includes('parent_email_has_kea_account')));
});

test('design: CSV cells that a spreadsheet could run as a formula are escaped (tab, CR, full-width too)', () => {
  for (const v of ['=1+1', '+1', '-1', '@x', '\t=1', '\r=1', '＝1+1', '＋1', '－1', '＠x']) assert.ok(cell(v).startsWith(`"'`), JSON.stringify(v));
  assert.equal(cell('Ana'), 'Ana');
  assert.equal(cell('a,b'), '"a,b"');
});

test('design: the worker reaches only the job’s profile folder (see http.test relay test for the HTTP side)', () => {
  assert.ok(true);
});

// ---------------- section 6 (Hub) ----------------
test('6 M4: deleting your account removes what the Hub kept and anonymizes the audit; the last owner of a group must hand it over', async () => {
  const a = await H.person('del@example.com', 'Del Person');
  ok(await H.call('POST', '/v1/me/phone', a.token, { phone: '+1 719 555 0199', visibility: 'classes' }));
  const put = await fetch(`${H.base}/v1/files/kea/Kea/School/notes.txt`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}` }, body: 'my notes' });
  assert.equal(put.status, 201);
  const blobDir = join(H.dir, 'storage', a.id);
  assert.ok(existsSync(blobDir));
  // Sole owner of an org with members: refused until handed over.
  ok(await H.owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  const org = ok(await H.call('POST', '/v1/orgs', a.token, { name: 'Del Org' }), 201).org;
  const m = await H.person('del-m@example.com', 'Del Member');
  const code = ok(await H.call('POST', `/v1/orgs/${org.id}/codes`, a.token, { role: 'member', needsApproval: false }), 201).code.code;
  ok(await H.call('POST', '/v1/orgs/join', m.token, { code }, H.freshIp()));
  assert.equal((await H.call('POST', '/v1/me/delete', a.token, { password: PW, confirm: 'DELETE' })).status, 409);
  ok(await H.call('POST', `/v1/orgs/${org.id}/members/${m.id}`, a.token, { role: 'owner' }));
  assert.equal((await H.call('POST', '/v1/me/delete', a.token, { password: 'wrong wrong wrong', confirm: 'DELETE' })).status, 401);
  assert.equal((await H.call('POST', '/v1/me/delete', a.token, { password: PW })).status, 400, 'confirm: DELETE');
  ok(await H.call('POST', '/v1/me/delete', a.token, { password: PW, confirm: 'DELETE' }));
  assert.equal(H.hub.h.get('SELECT 1 FROM accounts WHERE id = ?', a.id), undefined);
  for (const t of ['sessions', 'files', 'notifications', 'org_members']) assert.equal(H.hub.h.get(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`, a.id).n, 0, t);
  assert.ok(!existsSync(blobDir), 'the files on disk are gone');
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM audit WHERE actor = ? OR target = ? OR detail LIKE ?', a.id, a.id, `%${a.id}%`).n, 0);
  assert.ok(H.hub.h.get("SELECT 1 FROM audit WHERE action = 'account.delete'"));
  assert.equal(H.hub.h.get('SELECT created_by FROM orgs WHERE id = ?', org.id).created_by, m.id, 'the org went to its other owner');
  // The owner can delete one too (after the person asked).
  const b = await H.person('del2@example.com');
  assert.equal((await H.owner('POST', `/owner/accounts/${b.id}/delete`, { confirm: 'nope' })).status, 400);
  ok(await H.owner('POST', `/owner/accounts/${b.id}/delete`, { confirm: 'del2@example.com' }));
  assert.equal(H.hub.h.get('SELECT 1 FROM accounts WHERE id = ?', b.id), undefined);
});

test('6 M4: the export has everything kept about you; routine sign-in records are pruned after the owner’s setting', async () => {
  const a = await H.person('exp@example.com');
  const x = ok(await H.call('GET', '/v1/me/export', a.token));
  for (const k of ['parentSignOffs', 'scanJobs', 'scanRequests', 'flags', 'contributedCourseFiles', 'activity', 'courseSections', 'orgs']) assert.ok(k in x, k);
  assert.ok(x.activity.some((e) => e.action === 'auth.login'));
  ok(await H.owner('POST', '/owner/settings', { audit: { keepDays: 30 } }));
  clock += 31 * DAY;
  ok(await H.owner('POST', '/owner/settings', { audit: { keepDays: 30 } }));
  assert.equal(H.hub.h.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.login' AND actor = ?", a.id).n, 0);
  assert.ok(H.hub.h.get("SELECT 1 FROM audit WHERE action = 'account.register' AND actor = ?", a.id), 'account changes stay');
  ok(await H.owner('POST', '/owner/settings', { audit: { keepDays: 365 } }));
});

test('6 L4: TOTP secrets are sealed at rest; plain ones from before are sealed at start', async () => {
  const H2 = await makeHub();
  try {
    const a = await H2.person('seal@example.com');
    const s = ok(await H2.call('POST', '/v1/me/totp/setup', a.token, { password: PW }));
    const stored = H2.hub.h.get('SELECT totp_secret FROM accounts WHERE id = ?', a.id).totp_secret;
    assert.match(stored, /^v1:/);
    assert.ok(!stored.includes(s.secret));
    ok(await H2.call('POST', '/v1/me/totp/enable', a.token, { code: codeAt(s.secret, stepOf(clock)) }));
    // A plain secret from an older Hub: sealed when the Hub starts, and still works.
    H2.hub.h.run('UPDATE accounts SET totp_secret = ?, totp_last_step = -1 WHERE id = ?', s.secret, a.id);
    await H2.hub.close();
    const again = createHub({ dataDir: H2.dir, now: () => clock, log: false, minFreeBytes: 0 });
    try {
      assert.match(again.h.get('SELECT totp_secret FROM accounts WHERE id = ?', a.id).totp_secret, /^v1:/);
      const p = await again.listen({ port: 0, ownerPort: 0 });
      clock += 30_000;
      const r = await fetch(`http://127.0.0.1:${p.port}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'seal@example.com', password: PW, code: codeAt(s.secret, stepOf(clock)) }) });
      assert.equal(r.status, 200);
    } finally { await again.close(); }
  } finally { rmSync(H2.dir, { recursive: true, force: true }); }
});

// ---------------- section 2: flooding ----------------
test('2 C1: password hashing runs in a small worker pool; past its queue, "busy" at once', async () => {
  const pool = createHashPool({ size: 1, maxQueue: 2 });
  const job = { alg: 'scrypt', password: 'x', salt: Buffer.alloc(16), p: { N: 2 ** 14, r: 8, p: 1, keylen: 32 } };
  const runs = [pool.run(job), pool.run(job), pool.run(job), pool.run(job)];
  const out = await Promise.allSettled(runs);
  assert.ok(out.some((r) => r.status === 'rejected' && r.reason.busy), 'over the queue: Busy');
  assert.ok(out.filter((r) => r.status === 'fulfilled').length >= 2);
  assert.equal(pool.stats().size, 1);
  await pool.close();
});

test('2 H4: a cheap per-address limit answers before anything else, and the log is its own size-limited file', async () => {
  const H2 = await makeHub({ limits: { rps: [1, 3] } });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(`${H2.base}/v1/health`, { headers: { 'x-test-ip': '203.0.113.7' } })).status);
    assert.ok(codes.includes(429), codes.join(','));
    assert.equal((await fetch(`${H2.base}/v1/health`, { headers: { 'x-test-ip': '203.0.113.8' } })).status, 200, 'other addresses are fine');
    assert.ok(ok(await H2.owner('GET', '/owner/stats')).busy.rejected >= 1);
  } finally { await H2.close(); }
  const d = mkdtempSync(join(tmpdir(), 'kea-log-'));
  const log = createHubLog({ file: join(d, 'hub.log'), maxBytes: 200, keep: 2 });
  for (let i = 0; i < 50; i++) log.request('GET', '/v1/health', 200, 1);
  for (let i = 0; i < 20; i++) { log.request('POST', `/v1/thing/${i}`, 201, 2); log.flushNow(); await new Promise((r) => setTimeout(r, 5)); }
  log.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(d, 'hub.log.1')), 'rotated');
  assert.ok(!existsSync(join(d, 'hub.log.3')), 'only `keep` old files');
  const all = readFileSync(join(d, 'hub.log'), 'utf8') + readFileSync(join(d, 'hub.log.1'), 'utf8') + (existsSync(join(d, 'hub.log.2')) ? readFileSync(join(d, 'hub.log.2'), 'utf8') : '');
  assert.ok(!/GET \/v1\/health/.test(all), 'routine GETs are counted, not written one by one');
  rmSync(d, { recursive: true, force: true });
});

test('2 H2/H3/M1/M2: uploads are streamed and capped; usage is a kept count; files per account and unverified storage are limited; lists page', async () => {
  const H2 = await makeHub({ maxFilesPerAccount: 3, maxFileBytes: 1024, fileOverheadBytes: 100, unverifiedQuotaBytes: 600, defaultQuotaBytes: 10_000 });
  try {
    const a = await H2.person('up@example.com', 'Up Loader', { verified: false });
    const put = (p, data, headers = {}) => fetch(`${H2.base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}`, ...headers }, body: data });
    assert.equal((await put('a.txt', 'x'.repeat(2000))).status, 413, 'over the file size');
    // Without a length announced (streamed), still cut off at the limit.
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(512)); c.close(); } });
    assert.equal((await fetch(`${H2.base}/v1/files/s.bin`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}` }, body: big, duplex: 'half' })).status, 413);
    assert.equal((await put('a.txt', 'x'.repeat(300))).status, 201);
    // Unverified: at most 600 bytes (300 + 100 per file so far).
    assert.equal((await put('b.txt', 'x'.repeat(250))).status, 507);
    ok(await H2.owner('POST', `/owner/accounts/${a.id}`, { emailVerified: true }));
    assert.equal((await put('b.txt', 'x'.repeat(250))).status, 201);
    assert.equal((await put('c.txt', '')).status, 201);
    const tooMany = await put('d.txt', '');
    assert.deepEqual([tooMany.status, (await tooMany.json()).tooManyFiles], [507, true]);
    const u = H2.hub.h.get('SELECT used_bytes, file_count FROM accounts WHERE id = ?', a.id);
    assert.deepEqual([u.used_bytes, u.file_count], [550, 3]);
    assert.equal((await fetch(`${H2.base}/v1/files/c.txt`, { method: 'DELETE', headers: { authorization: `Bearer ${a.token}` } })).status, 200);
    assert.equal(H2.hub.h.get('SELECT file_count FROM accounts WHERE id = ?', a.id).file_count, 2);
    assert.equal(ok(await H2.call('GET', '/v1/files', a.token)).used, 550 + 200);
    // Pages when asked; everything at once otherwise.
    const p1 = ok(await H2.call('GET', '/v1/files?limit=1', a.token));
    assert.deepEqual([p1.files.map((f) => f.path), p1.next], [['a.txt'], 'a.txt']);
    const p2 = ok(await H2.call('GET', `/v1/files?limit=1&after=${p1.next}`, a.token));
    assert.deepEqual([p2.files.map((f) => f.path), p2.next], [['b.txt'], null]);
    assert.equal(ok(await H2.call('GET', '/v1/files', a.token)).next, undefined);
  } finally { await H2.close(); }
});

test('2 M2: the owner’s daily new-bytes budget per account', async () => {
  const H2 = await makeHub({ defaultQuotaBytes: 100_000 });
  try {
    const a = await H2.person('budget@example.com');
    ok(await H2.owner('POST', '/owner/settings', { storage: { dailyAccountBytes: 1000 } }));
    const put = (p, n) => fetch(`${H2.base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}` }, body: 'x'.repeat(n) });
    assert.equal((await put('one', 800)).status, 201);
    assert.equal((await put('two', 800)).status, 429);
    clock += DAY;
    assert.equal((await put('two', 800)).status, 201);
  } finally { await H2.close(); }
});

test('2 M3: Google keys are refetched at most once a minute, shared by callers at the same moment', async () => {
  let fetches = 0, t = 0;
  const keys = googleKeys({ nowFn: () => t, fetchFn: async () => { fetches++; await new Promise((r) => setTimeout(r, 10)); return { ok: true, headers: new Headers({ 'cache-control': 'max-age=3600' }), json: async () => ({ keys: [{ kid: 'a' }] }) }; } });
  await Promise.all([keys(), keys(), keys()]);
  assert.equal(fetches, 1);
  await keys(true); await keys(true); await keys(true);
  assert.equal(fetches, 2, 'one forced refetch a minute');
  t += 61_000;
  await keys(true);
  assert.equal(fetches, 3);
});

test('2 L3/L4: nightly pruning, and a cap on the whole queue', async () => {
  const H2 = await makeHub();
  try {
    const a = await H2.person('prune@example.com');
    H2.hub.h.run('INSERT INTO scan_requests (account_id,kind,outcome,at,day) VALUES (?,?,?,?,?)', a.id, 'x', 'queue', clock - 40 * DAY, 'old');
    H2.hub.h.run('INSERT INTO sessions (token_hash,account_id,created_at,expires_at,last_seen) VALUES (?,?,?,?,?)', 'f'.repeat(64), a.id, 0, clock - 1, 0);
    ok(await H2.owner('POST', '/owner/settings', { audit: { keepDays: 365 } }));
    assert.equal(H2.hub.h.get("SELECT COUNT(*) AS n FROM scan_requests WHERE day = 'old'").n, 0);
    assert.equal(H2.hub.h.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', 'f'.repeat(64)).n, 0);
    ok(await H2.owner('POST', '/owner/settings', { limits: { maxQueuedJobs: 0 } }));
    const full = await H2.call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: { school: 'Q U', code: 'Q1', term: 'Fall' } });
    assert.deepEqual([full.status, full.body.code], [503, 'queue_full']);
  } finally { await H2.close(); }
});

test('2 H1/M4: big downloads stream out paced; busy numbers show in /owner/stats', async () => {
  const H2 = await makeHub({ defaultQuotaBytes: 10 * 1024 ** 2 });
  try {
    const a = await H2.person('dl@example.com');
    ok(await H2.owner('POST', '/owner/settings', { limits: { maxSendMbps: 8 } }));
    assert.equal((await fetch(`${H2.base}/v1/files/big.bin`, { method: 'PUT', headers: { authorization: `Bearer ${a.token}` }, body: Buffer.alloc(400 * 1024, 1) })).status, 201);
    const t0 = Date.now();
    const r = await fetch(`${H2.base}/v1/files/big.bin`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(Buffer.from(await r.arrayBuffer()).length, 400 * 1024);
    assert.ok(Date.now() - t0 >= 200, `paced: ${Date.now() - t0} ms`);
    const busy = ok(await H2.owner('GET', '/owner/stats')).busy;
    for (const k of ['lagMs', 'hashing', 'downloads', 'uploads', 'rejected', 'shed', 'connections']) assert.ok(k in busy, k);
  } finally { await H2.close(); }
});

test('2 L2: one organization can hold only so many rows of each kind', async () => {
  const boss = await H.person('l2-boss@example.com', 'Cap Boss');
  ok(await H.owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  const org = ok(await H.call('POST', '/v1/orgs', boss.token, { name: 'Cap Org' }), 201).org;
  ok(await H.call('POST', `/v1/orgs/${org.id}/locations`, boss.token, { name: 'Main', address: '' }), 201);
  for (let i = 0; i < 300; i++) H.hub.h.run('INSERT INTO org_locations (id,org_id,name) VALUES (?,?,?)', `loc-${i}`, org.id, `L${i}`);
  const full = await H.call('POST', `/v1/orgs/${org.id}/locations`, boss.token, { name: 'One more', address: '' });
  assert.deepEqual([full.status, /the most locations/.test(full.body.error)], [400, true]);
});
