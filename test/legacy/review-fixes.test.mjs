// Review fixes: sign-ins record whether they passed two-step and the owner's powers need one that did; make-owner ends
// the account's earlier sign-ins; wrong two-step codes are capped per account from any address (and that can't lock
// anyone out for good); the owner console won't reset the owner's own two-step sign-in. End to end over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../../hub/legacy/index.mjs';
import { openDb } from '../../hub/legacy/db.mjs';
import { ownerFetch } from '../../hub/legacy/lib/ownerauth.mjs';
import { codeAt, stepOf } from '../../hub/legacy/lib/totp.mjs';

let hub, base, ownerBase, dir;
let clock = Date.UTC(2026, 10, 7, 15);
const PW = 'lantern velvet orbit';
const MIN = 60_000;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-review-test-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });
async function call(method, path, token, body, headers = freshIp()) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const owner = async (method, path, body) => {
  const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body);
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function person(email, name) {
  const t = (await call('GET', '/v1/terms')).body.terms;
  ok(await call('POST', '/v1/auth/register', null, { email, password: PW, displayName: name, age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }), 202);
  const r = ok(await call('POST', '/v1/auth/login', null, { email, password: PW }));
  ok(await owner('POST', `/owner/accounts/${r.account.id}`, { emailVerified: true }));
  return { token: r.token, id: r.account.id, name, email };
}
async function twoStep(p) {
  const s = ok(await call('POST', '/v1/me/totp/setup', p.token, { password: PW }));
  const on = ok(await call('POST', '/v1/me/totp/enable', p.token, { code: codeAt(s.secret, stepOf(clock)) }));
  return { secret: s.secret, backupCodes: on.backupCodes };
}
const login = (email, code) => call('POST', '/v1/auth/login', null, { email, password: PW, ...(code ? { code } : {}) });
const audits = (id, action) => hub.h.all('SELECT * FROM audit WHERE target = ? AND action = ?', id, action);

test('sessions say whether they passed two-step; the owner account’s powers need one that did', async () => {
  const o = await person('boss@hub.org', 'Hub Boss');
  const t = await twoStep(o);
  hub.h.run("UPDATE accounts SET role = 'owner' WHERE id = ?", o.id);
  // Turning two-step on in this sign-in gave a right code: it counts as passed, so the owner's setup goes on with it.
  assert.equal(hub.h.get('SELECT mfa FROM sessions WHERE account_id = ?', o.id).mfa, 1);
  ok(await call('POST', '/v1/classes', o.token, { title: 'Owner class' }), 201);
  // A sign-in from before sessions recorded it (the migration leaves those at 0): owner powers refuse it and the apps
  // sign in again; the basics still answer.
  hub.h.run('UPDATE sessions SET mfa = 0 WHERE account_id = ?', o.id);
  const refused = await call('POST', '/v1/classes', o.token, { title: 'Owner class 2' });
  assert.deepEqual([refused.status, refused.body.mfaRequired], [401, true]);
  assert.match(refused.body.error, /sign-in that used its two-step code/);
  ok(await call('GET', '/v1/me', o.token));
  // Signing in with the code (or a backup code) makes a sign-in that passed.
  clock += 30_000;
  const withCode = ok(await login(o.email, codeAt(t.secret, stepOf(clock))));
  ok(await call('POST', '/v1/classes', withCode.token, { title: 'Owner class 3' }), 201);
  const withBackup = ok(await login(o.email, t.backupCodes[0]));
  ok(await call('POST', '/v1/classes', withBackup.token, { title: 'Owner class 4' }), 201);
  // Someone else's account with two-step on is the same as before (only owner powers need a passed sign-in), and an
  // account without two-step gets sign-ins that didn't pass.
  const plain = await person('plain@hub.org', 'Plain');
  assert.equal(hub.h.get('SELECT mfa FROM sessions WHERE account_id = ?', plain.id).mfa, 0);
});

test('migration: an older hub.db gets sessions.mfa, existing sign-ins at 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-mfa-mig-'));
  try {
    const file = join(d, 'hub.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, client TEXT)');
    raw.exec("INSERT INTO sessions VALUES ('t1', 'a1', 1, 2, 1, 'old')");
    raw.close();
    const h = openDb(file);
    assert.deepEqual({ ...h.get('SELECT token_hash, mfa FROM sessions') }, { token_hash: 't1', mfa: 0 });
    h.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('wrong two-step codes are capped per account from any address, growing, never for good; the owner console lifts it', async () => {
  const q = await person('quinn@hub.org', 'Quinn');
  const t = await twoStep(q);
  const right = () => codeAt(t.secret, stepOf(clock));
  const wrongTimes = async (n) => { for (let i = 0; i < n; i++) assert.equal((await login(q.email, '000000')).status, 401); };
  // Ten wrong codes in a few minutes, each from a different address (no single address is ever locked).
  await wrongTimes(10);
  clock += 30_000;
  let r = await login(q.email, right());
  assert.deepEqual([r.status, r.body.codeLocked], [429, true], 'the right code waits too');
  assert.match(r.body.error, /Too many wrong two-step codes for this account\. Wait 15 minutes/);
  assert.equal((await login(q.email, t.backupCodes[0])).status, 429, 'backup codes too');
  // The same pause where a signed-in person gives a code again (making new backup codes, say).
  r = await call('POST', '/v1/me/totp/backup-codes', q.token, { password: PW, code: right() });
  assert.deepEqual([r.status, r.body.codeLocked], [429, true]);
  assert.equal(audits(q.id, 'auth.totp_locked').length, 1);
  assert.ok(ok(await call('GET', '/v1/me/notifications', q.token)).notifications.some((n) => /paused/.test(n.title)));
  // Over in 15 minutes.
  clock += 15 * MIN;
  ok(await login(q.email, right()));
  // A second pause soon after is longer: 30 minutes. Backup codes count toward it.
  await wrongTimes(9);
  assert.equal((await login(q.email, 'ABCDE-FGHJK')).status, 401);
  clock += 16 * MIN;
  assert.equal((await login(q.email, right())).status, 429);
  clock += 15 * MIN;
  ok(await login(q.email, right()));
  // However many pauses, one is never longer than 4 hours.
  hub.h.run('UPDATE totp_failures SET level = 20, last_lock_at = ? WHERE account_id = ?', clock, q.id);
  await wrongTimes(10);
  const row = hub.h.get('SELECT * FROM totp_failures WHERE account_id = ?', q.id);
  assert.equal(row.locked_until - clock, 4 * 60 * MIN);
  // A calm day after the last pause starts over at 15 minutes.
  clock += 25 * 60 * MIN;
  ok(await login(q.email, right()));
  await wrongTimes(10);
  assert.equal(hub.h.get('SELECT locked_until FROM totp_failures WHERE account_id = ?', q.id).locked_until - clock, 15 * MIN);
  // The owner console on the Hub's PC lifts a pause at once (the owner's own account included).
  clock += 30_000;
  assert.equal((await login(q.email, right())).status, 429);
  ok(await owner('POST', `/owner/accounts/${q.id}/unlock`));
  ok(await login(q.email, right()));
  // Without the password nobody can pause someone's codes: a wrong password never reaches the code.
  for (let i = 0; i < 12; i++) await call('POST', '/v1/auth/login', null, { email: q.email, password: 'not the password at all', code: '000000' });
  clock += 30_000;
  ok(await login(q.email, right()));
});

test('the owner console won’t reset the owner account’s own two-step sign-in (anyone else’s, as before)', async () => {
  const o = hub.h.get("SELECT id FROM accounts WHERE role = 'owner'");
  const r = await owner('POST', `/owner/accounts/${o.id}/totp-reset`, { note: 'lost phone' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /can’t be reset for the Hub owner’s own account.*backup codes/);
  assert.equal(hub.h.get('SELECT totp_enabled FROM accounts WHERE id = ?', o.id).totp_enabled, 1);
  const q = hub.h.get("SELECT id FROM accounts WHERE email = 'quinn@hub.org'");
  assert.equal(ok(await owner('POST', `/owner/accounts/${q.id}/totp-reset`, { note: 'checked by phone' })).account.totpEnabled, false);
});

test('make-owner (node hub/owner.mjs) ends the account’s earlier sign-ins', async () => {
  const p = await person('next@hub.org', 'Next Owner');
  const t = await twoStep(p);
  clock += 30_000;
  ok(await login(p.email, codeAt(t.secret, stepOf(clock))));
  assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', p.id).n, 2);
  const script = fileURLToPath(new URL('../../hub/legacy/owner.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, 'make-owner', p.email], { env: { ...process.env, KEA_HUB_DATA: dir }, encoding: 'utf8' });
  assert.match(out, /is now the Hub owner/);
  assert.match(out, /Signed out of 2 places/);
  assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', p.id).n, 0);
  assert.equal((await call('GET', '/v1/me', p.token)).status, 401);
  assert.equal(audits(p.id, 'owner.make_owner').length, 1);
});
