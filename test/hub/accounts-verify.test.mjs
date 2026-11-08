// Joining an organization without Google (an unverified email asks, a manager approves), verifying an email by a
// manager or the Hub's owner, and two-step backup codes. End to end over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { codeAt, stepOf } from '../../hub/lib/totp.mjs';

let hub, base, ownerBase, dir;
let clock = Date.UTC(2026, 10, 7, 15);
const PW = 'lantern velvet orbit';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-accts-test-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}` });
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
async function person(email, name, { verified = true } = {}) {
  const t = (await call('GET', '/v1/terms')).body.terms;
  ok(await call('POST', '/v1/auth/register', null, { email, password: PW, displayName: name, age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }), 202);
  const r = ok(await call('POST', '/v1/auth/login', null, { email, password: PW }));
  if (verified) ok(await owner('POST', `/owner/accounts/${r.account.id}`, { emailVerified: true }));
  return { token: r.token, id: r.account.id, name, email };
}
/** Two-step sign-in on: { secret, backupCodes }. */
async function twoStep(p) {
  const s = ok(await call('POST', '/v1/me/totp/setup', p.token, { password: PW }));
  const on = ok(await call('POST', '/v1/me/totp/enable', p.token, { code: codeAt(s.secret, stepOf(clock)) }));
  return { secret: s.secret, backupCodes: on.backupCodes };
}
const accountRow = (id) => ({ ...hub.h.get('SELECT email_verified, verified_by FROM accounts WHERE id = ?', id) });
const notes = async (p) => ok(await call('GET', '/v1/me/notifications', p.token)).notifications ?? ok(await call('GET', '/v1/me/notifications', p.token));

let boss, mgr, worker, org, memberCode, managerCode;

test('the Hub says what it can do', async () => {
  const h = ok(await call('GET', '/v1/health'));
  for (const f of ['orgJoinRequests', 'verifyEmailByManager', 'backupCodes']) assert.ok(h.features.includes(f), f);
});

test('an unverified email can’t make an organization, but its join with a code becomes a request', async () => {
  boss = await person('boss@pool.org', 'Pat Boss');
  mgr = await person('mgr@pool.org', 'Max Manager');
  worker = await person('sam@school.edu', 'Sam Outlook', { verified: false });
  ok(await owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  org = ok(await call('POST', '/v1/orgs', boss.token, { name: 'Westside Pool', tz: 'America/Denver', state: 'CO' }), 201).org;
  const refused = await call('POST', '/v1/orgs', worker.token, { name: 'Nope' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /^Verify your email first/);

  // A manager code (needs approval anyway) and a member code that needs none, with automatic approval on.
  managerCode = ok(await call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: 'manager' }), 201).code.code;
  ok(await call('POST', `/v1/orgs/${org.id}`, boss.token, { settings: { autoApproveJoins: true } }));
  memberCode = ok(await call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: 'member', needsApproval: false }), 201).code.code;
  const m = ok(await call('POST', '/v1/orgs/join', mgr.token, { code: managerCode }));
  assert.equal(m.pending, false, 'automatic approval lets a verified manager in');

  // A wrong code is still just a wrong code.
  assert.equal((await call('POST', '/v1/orgs/join', worker.token, { code: 'ABCDEFGHJKMN' })).status, 404);
  const r = ok(await call('POST', '/v1/orgs/join', worker.token, { code: memberCode }));
  assert.deepEqual([r.pending, r.alreadyMember, r.emailVerified, r.org.memberStatus], [true, false, false, 'pending']);
  assert.match(r.message, /manager approves/);
  // Asking again: the same request.
  const again = ok(await call('POST', '/v1/orgs/join', worker.token, { code: memberCode }));
  assert.equal(again.alreadyMember, true);
  // Waiting: nothing of the organization yet.
  assert.equal((await call('GET', `/v1/orgs/${org.id}/members`, worker.token)).status, 403);
  const mine = ok(await call('GET', '/v1/orgs', worker.token)).orgs;
  assert.deepEqual(mine.map((o) => [o.name, o.memberStatus]), [['Westside Pool', 'pending']]);
  // The approvers heard about it, with the email marked unverified; the audit has it.
  const n = (await notes(boss)).find((x) => x.kind === 'org_join');
  assert.ok(n, 'the org owner got a notice');
  assert.deepEqual([n.data.orgId, n.data.accountId, n.data.emailVerified], [org.id, worker.id, false]);
  assert.ok(hub.h.get("SELECT 1 FROM audit WHERE action = 'org.join_request' AND actor = ?", worker.id));
});

test('a manager sees the request, verifies the email, and approves it', async () => {
  const list = ok(await call('GET', `/v1/orgs/${org.id}/members`, mgr.token));
  assert.deepEqual(list.pending.map((p) => [p.id, p.emailVerified, p.email]), [[worker.id, false, 'sam@school.edu']]);
  // Members can't verify anyone; the manager can (the member is below them).
  const member = await person('mo@pool.org', 'Mo Member');
  ok(await call('POST', '/v1/orgs/join', member.token, { code: memberCode }));
  assert.equal((await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/verify-email`, member.token, {})).status, 403);
  // Someone outside the organization: it doesn't exist for them.
  const outsider = await person('out@else.org', 'Out Sider');
  assert.equal((await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/verify-email`, outsider.token, {})).status, 404);
  // A manager can't verify someone at or above them.
  assert.equal((await call('POST', `/v1/orgs/${org.id}/members/${boss.id}/verify-email`, mgr.token, {})).status, 403);

  const v = ok(await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/verify-email`, mgr.token, {}));
  assert.deepEqual([v.emailVerified, v.verifiedBy, v.already], [true, 'Manager', false]);
  assert.deepEqual(accountRow(worker.id), { email_verified: 1, verified_by: 'Manager' });
  const a = hub.h.get("SELECT actor, target, detail FROM audit WHERE action = 'account.verify_email' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([a.actor, a.target, JSON.parse(a.detail).by], [mgr.id, worker.id, 'Manager']);
  assert.ok((await notes(worker)).some((x) => x.title === 'Your email is verified'));
  // Again: nothing changes.
  assert.equal(ok(await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/verify-email`, mgr.token, {})).already, true);
  // The account says so too (payroll reads the same flag).
  const me = ok(await call('GET', '/v1/me', worker.token)).account;
  assert.deepEqual([me.emailVerified, me.verifiedBy], [true, 'Manager']);
  const payTok = ok(await call('POST', '/v1/auth/token', worker.token, { aud: 'keas-payroll' })).token;
  assert.equal(JSON.parse(Buffer.from(payTok.split('.')[1], 'base64url')).ev, true, 'payroll’s sign-in sees the email as verified');

  ok(await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/approve`, mgr.token, { approve: true }));
  assert.equal(ok(await call('GET', `/v1/orgs/${org.id}`, worker.token)).org.memberStatus, 'active');
  assert.ok((await notes(worker)).some((x) => x.data?.approved === true));
});

test('declining an unverified request removes it; approving one without verifying lets them in, still unverified', async () => {
  const a = await person('ari@mail.com', 'Ari Unverified', { verified: false });
  const b = await person('bo@mail.com', 'Bo Unverified', { verified: false });
  ok(await call('POST', '/v1/orgs/join', a.token, { code: memberCode }));
  ok(await call('POST', '/v1/orgs/join', b.token, { code: memberCode }));
  ok(await call('POST', `/v1/orgs/${org.id}/members/${a.id}/approve`, boss.token, { approve: false }));
  assert.equal(ok(await call('GET', '/v1/orgs', a.token)).orgs.length, 0);
  ok(await call('POST', `/v1/orgs/${org.id}/members/${b.id}/approve`, boss.token, { approve: true }));
  const list = ok(await call('GET', `/v1/orgs/${org.id}/members`, boss.token));
  assert.equal(list.members.find((m) => m.id === b.id).emailVerified, false);
  assert.equal(accountRow(b.id).email_verified, 0);
  // Still can't make an organization of their own.
  assert.equal((await call('POST', '/v1/orgs', b.token, { name: 'Mine' })).status, 403);
  // Joining doesn't make anyone a verifier: an unverified manager can't verify others.
  hub.h.run("UPDATE org_role_assignments SET role_id = (SELECT id FROM org_roles WHERE org_id = ? AND template_key = 'manager') WHERE org_id = ? AND account_id = ?", org.id, org.id, b.id);
  const c = await person('cy@mail.com', 'Cy Unverified', { verified: false });
  ok(await call('POST', '/v1/orgs/join', c.token, { code: memberCode }));
  const refused = await call('POST', `/v1/orgs/${org.id}/members/${c.id}/verify-email`, b.token, {});
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /your own email/);
});

test('the Hub’s owner verifies anyone in any organization, and from the owner console', async () => {
  const hubOwner = await person('owner@hub.org', 'Hub Owner');
  hub.h.run("UPDATE accounts SET role = 'owner' WHERE id = ?", hubOwner.id);
  await twoStep(hubOwner);
  const d = await person('dee@mail.com', 'Dee Unverified', { verified: false });
  ok(await call('POST', '/v1/orgs/join', d.token, { code: memberCode }));
  const v = ok(await call('POST', `/v1/orgs/${org.id}/members/${d.id}/verify-email`, hubOwner.token, {}));
  assert.equal(v.verifiedBy, 'Owner');
  assert.deepEqual(accountRow(d.id), { email_verified: 1, verified_by: 'Owner' });
  // Not in that organization: 404.
  const e = await person('eve@mail.com', 'Eve Unverified', { verified: false });
  assert.equal((await call('POST', `/v1/orgs/${org.id}/members/${e.id}/verify-email`, hubOwner.token, {})).status, 404);
  // The owner console (this PC only).
  ok(await owner('POST', `/owner/accounts/${e.id}`, { emailVerified: true }));
  assert.deepEqual(accountRow(e.id), { email_verified: 1, verified_by: 'Owner' });
  assert.ok(hub.h.get("SELECT 1 FROM audit WHERE action = 'owner.account_update' AND target = ?", e.id));
  // Already verified by Google: it stays Google.
  hub.h.run("UPDATE accounts SET verified_by = 'Google' WHERE id = ?", e.id);
  ok(await owner('POST', `/owner/accounts/${e.id}`, { emailVerified: true }));
  assert.equal(accountRow(e.id).verified_by, 'Google');
});

test('backup codes: ten when two-step sign-in goes on, each signs in once, wrong ones count as failures', async () => {
  const p = await person('two@step.org', 'Two Step');
  const { secret, backupCodes } = await twoStep(p);
  assert.equal(backupCodes.length, 10);
  assert.equal(new Set(backupCodes).size, 10);
  for (const c of backupCodes) assert.match(c, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  // Only hashes are stored.
  const rows = hub.h.all('SELECT hash FROM totp_backup_codes WHERE account_id = ?', p.id);
  assert.equal(rows.length, 10);
  for (const c of backupCodes) assert.ok(!rows.some((r) => r.hash.includes(c.replace('-', ''))));
  assert.ok(!JSON.stringify(hub.h.all('SELECT * FROM audit')).includes(backupCodes[0]));
  assert.equal(ok(await call('GET', '/v1/me', p.token)).account.backupCodesLeft, 10);

  const login = (code) => call('POST', '/v1/auth/login', null, { email: p.email, password: PW, code });
  const ask = await login(undefined);
  assert.deepEqual([ask.status, ask.body.totpRequired, ask.body.backupCodes], [401, true, true]);
  assert.match(ask.body.error, /backup code/);
  // Typed loosely: lower case, spaces instead of the dash.
  const loose = backupCodes[0].toLowerCase().replace('-', ' ');
  const first = await login(loose);
  assert.equal(first.status, 200);
  assert.equal(first.body.account.backupCodesLeft, 9);
  // Used: never again.
  const twice = await login(backupCodes[0]);
  assert.deepEqual([twice.status, twice.body.totpRequired], [401, true]);
  // A made-up one.
  assert.equal((await login('ABCDE-FGHJK')).status, 401);
  assert.ok(hub.h.get("SELECT 1 FROM audit WHERE action = 'auth.backup_code_used' AND actor = ?", p.id));
  assert.ok((await notes(p)).some((n) => /backup code was used/.test(n.title)));
  // The app's code still works as before.
  clock += 60_000;
  assert.equal((await login(codeAt(secret, stepOf(clock)))).status, 200);
  // Someone else's code doesn't work for this account.
  const q = await person('other@step.org', 'Other Step');
  const theirs = await twoStep(q);
  assert.equal((await login(theirs.backupCodes[0])).status, 401);
  // A backup code also works where the code is asked again (turning two-step sign-in off).
  const off = ok(await call('POST', '/v1/me/totp/disable', q.token, { password: PW, code: theirs.backupCodes[1] }));
  assert.equal(off.ok, true);
  assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM totp_backup_codes WHERE account_id = ?', q.id).n, 0, 'off: the codes go');
});

test('new backup codes: password and the app’s code; the old ones stop working', async () => {
  const p = await person('regen@step.org', 'Re Gen');
  const { secret, backupCodes: old } = await twoStep(p);
  clock += 60_000;
  // Wrong password, missing code, or a backup code instead of the app's: refused.
  assert.equal((await call('POST', '/v1/me/totp/backup-codes', p.token, { password: 'wrong wrong wrong', code: codeAt(secret, stepOf(clock)) })).status, 401);
  assert.equal((await call('POST', '/v1/me/totp/backup-codes', p.token, { password: PW })).status, 401);
  assert.equal((await call('POST', '/v1/me/totp/backup-codes', p.token, { password: PW, code: old[0] })).status, 401);
  assert.equal((await call('POST', '/v1/me/totp/backup-codes', p.token, { password: PW, code: '000000' })).status, 401);
  clock += 60_000;
  const r = ok(await call('POST', '/v1/me/totp/backup-codes', p.token, { password: PW, code: codeAt(secret, stepOf(clock)) }));
  assert.equal(r.backupCodes.length, 10);
  assert.equal(r.left, 10);
  assert.ok(!r.backupCodes.some((c) => old.includes(c)));
  assert.deepEqual(ok(await call('GET', '/v1/me/totp/backup-codes', p.token)), { enabled: true, left: 10 });
  const login = (code) => call('POST', '/v1/auth/login', null, { email: p.email, password: PW, code });
  assert.equal((await login(old[1])).status, 401, 'an old code stops working');
  assert.equal((await login(r.backupCodes[3])).status, 200);
  assert.ok(hub.h.get("SELECT 1 FROM audit WHERE action = 'account.backup_codes' AND actor = ? AND detail LIKE '%replaced%'", p.id));
  // Without two-step sign-in there's nothing to make.
  const none = await person('none@step.org', 'No Step');
  assert.equal((await call('POST', '/v1/me/totp/backup-codes', none.token, { password: PW, code: '123456' })).status, 400);
  assert.deepEqual(ok(await call('GET', '/v1/me/totp/backup-codes', none.token)), { enabled: false, left: 0 });
  // The owner console's two-step reset clears them.
  ok(await owner('POST', `/owner/accounts/${p.id}/totp-reset`, {}));
  assert.equal(hub.h.get('SELECT COUNT(*) AS n FROM totp_backup_codes WHERE account_id = ?', p.id).n, 0);
});
