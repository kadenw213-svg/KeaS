// Account features end to end over HTTP: notifications, the owner's per-account overrides (storage, shared Claude,
// supporter), the standard storage size, the supporter badge, and the optional phone number with who may see it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';

const DAY = 86400_000;
const GB = 1024 ** 3;
let hub, base, ownerBase, dir;
let clock = Date.UTC(2026, 10, 5, 15);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-account-test-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', defaultQuotaBytes: 1000, supporterQuotaBytes: 5000, minFreeBytes: 0, fileOverheadBytes: 0, limits: { phone: [3, DAY] } });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}` });
async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const owner = async (method, path, body) => {
  const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body);
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function person(email, name, extra = {}) {
  const t = (await call('GET', '/v1/terms')).body.terms;
  ok(await call('POST', '/v1/auth/register', null, { email, password: 'lantern velvet orbit', displayName: name, age13: true, birthYear: 1995, termsVersion: t.version, termsSections: t.sections.map((s) => s.id), ...extra }, freshIp()), 202);
  const r = ok(await call('POST', '/v1/auth/login', null, { email, password: 'lantern velvet orbit' }, freshIp()));
  ok(await owner('POST', `/owner/accounts/${r.account.id}`, { emailVerified: true }));
  return { token: r.token, id: r.account.id, name, email };
}
const put = (tok, p, data) => fetch(`${base}/v1/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}` }, body: data });
const notes = async (who) => ok(await call('GET', '/v1/me/notifications', who.token)).notifications;
const latest = async (who) => (await notes(who))[0];

test('terms: the three new sections are there, and only they are new since the last version', async () => {
  const t = ok(await call('GET', '/v1/terms')).terms;
  for (const id of ['phone-number', 'notifications', 'supporters']) assert.ok(t.sections.some((s) => s.id === id), id);
  const supp = t.sections.find((s) => s.id === 'supporters').body;
  assert.match(supp, /thank-you, not a purchase/);
  assert.match(supp, /storage/);
  assert.match(supp, /badge/);
  assert.match(supp, /can change/);
});

test('notifications: own only, newest first, polling with after, read and delete', async () => {
  const a = await person('note-a@example.com', 'Note A');
  const b = await person('note-b@example.com', 'Note B');
  // The owner's plain notice, and the email-verified notice from setup.
  const id1 = ok(await owner('POST', `/owner/accounts/${a.email}/notify`, { title: 'Hello', body: 'Welcome to Kea.' })).id;
  const id2 = ok(await owner('POST', `/owner/accounts/${a.id}/notify`, { title: 'Second' })).id;
  const list = ok(await call('GET', '/v1/me/notifications', a.token));
  assert.deepEqual(list.notifications.slice(0, 2).map((n) => n.title), ['Second', 'Hello']);
  assert.equal(list.unread, list.notifications.length);
  assert.equal(ok(await call('GET', `/v1/me/notifications?after=${id1}`, a.token)).notifications.length, 1);
  assert.equal(ok(await call('GET', '/v1/me', a.token)).notifications.unread, list.unread);
  // B can't read or mark A's.
  assert.ok(!(await notes(b)).some((n) => n.id === id1 || n.id === id2));
  ok(await call('POST', '/v1/me/notifications/read', b.token, { ids: [id1] }));
  assert.equal((await notes(a)).find((n) => n.id === id1).readAt, null);
  ok(await call('POST', '/v1/me/notifications/delete', b.token, { ids: [id1] }));
  assert.ok((await notes(a)).some((n) => n.id === id1));
  // A marks one read, then all; deletes the read ones.
  assert.equal(ok(await call('POST', '/v1/me/notifications/read', a.token, { ids: [id1] })).unread, list.unread - 1);
  assert.equal(ok(await call('GET', '/v1/me/notifications?unread=1', a.token)).notifications.some((n) => n.id === id1), false);
  assert.equal(ok(await call('POST', '/v1/me/notifications/read', a.token, { all: true })).unread, 0);
  ok(await call('POST', '/v1/me/notifications/delete', a.token, { all: true }));
  assert.equal((await notes(a)).length, 0);
  assert.equal((await call('POST', '/v1/me/notifications/read', a.token, {})).status, 400);
  assert.equal((await call('GET', '/v1/me/notifications')).status, 401);
  // In the data export.
  ok(await owner('POST', `/owner/accounts/${a.id}/notify`, { title: 'For the export' }));
  assert.equal(ok(await call('GET', '/v1/me/export', a.token)).notifications.at(-1).title, 'For the export');
});

test('storage override: any size, audited, with a plain notice and the owner’s note', async () => {
  const a = await person('big@example.com', 'Big Files');
  const r = ok(await owner('POST', `/owner/accounts/${a.id}/quota`, { gb: 5000, note: 'For your video project.' }));
  assert.equal(r.quota, 5000 * GB);
  const n = await latest(a);
  assert.deepEqual([n.kind, n.title, n.note], ['storage', 'Your Kea storage is now 5,000 GB', 'For your video project.']);
  assert.equal(ok(await call('GET', '/v1/me', a.token)).storage.quota, 5000 * GB);
  const audit = ok(await owner('GET', '/owner/audit?limit=20')).entries.find((e) => e.action === 'owner.quota' && e.target === a.id);
  assert.equal(JSON.parse(audit.detail).bytes, 5000 * GB);
  // Back to the standard size.
  ok(await owner('POST', `/owner/accounts/${a.id}/quota`, { gb: null }));
  assert.match((await latest(a)).body, /standard size/);
  assert.equal((await owner('POST', `/owner/accounts/${a.id}/quota`, { gb: -1 })).status, 400);
  assert.equal((await owner('POST', `/owner/accounts/${a.id}/quota`, { gb: '5' })).status, 400);
});

test('over the limit: nothing is deleted, new files wait, smaller replacements and deletes still work', async () => {
  const a = await person('over@example.com', 'Over Limit');
  ok(await owner('POST', `/owner/accounts/${a.id}/quota`, { bytes: 3000 }));
  assert.equal((await put(a.token, 'kea/a.bin', 'x'.repeat(1500))).status, 201);
  assert.equal((await put(a.token, 'kea/b.bin', 'x'.repeat(1000))).status, 201);
  // The limit goes back to the standard 1000 bytes: they're over it.
  ok(await owner('POST', `/owner/accounts/${a.id}/quota`, { bytes: null }));
  const n = await latest(a);
  assert.match(n.body, /Nothing has been deleted/);
  const me = ok(await call('GET', '/v1/me', a.token));
  assert.deepEqual([me.storage.used, me.storage.quota, me.storage.over], [2500, 1000, true]);
  const blocked = await put(a.token, 'kea/c.bin', 'x');
  assert.equal(blocked.status, 507);
  const why = await blocked.json();
  assert.match(why.error, /over its limit/);
  assert.match(why.error, /Nothing has been deleted/);
  assert.equal(why.storageFull, true);
  assert.equal((await put(a.token, 'kea/a.bin', 'x'.repeat(1600))).status, 507, 'growing a file waits too');
  assert.equal((await put(a.token, 'kea/a.bin', 'y'.repeat(1200))).status, 200, 'a smaller replacement is fine');
  assert.equal(ok(await call('GET', '/v1/files', a.token)).files.length, 2, 'nothing deleted');
  assert.equal((await fetch(`${base}/v1/files/kea/b.bin`, { method: 'DELETE', headers: { authorization: `Bearer ${a.token}` } })).status, 200);
});

test('standard storage: an owner setting; existing custom sizes stay; a notice to everyone it changes for', async () => {
  const a = await person('std-a@example.com', 'Std A');
  const b = await person('std-b@example.com', 'Std B');
  ok(await owner('POST', `/owner/accounts/${b.id}/quota`, { bytes: 9000 }));
  assert.equal((await put(a.token, 'kea/x.bin', 'x'.repeat(800))).status, 201);
  const bNotes = (await notes(b)).length;
  const s = ok(await owner('POST', '/owner/settings', { storage: { defaultQuotaBytes: 600 } }));
  assert.equal(s.storage.defaultQuotaBytes, 600);
  assert.equal(ok(await call('GET', '/v1/me', a.token)).storage.quota, 600);
  assert.equal(ok(await call('GET', '/v1/me', b.token)).storage.quota, 9000, 'a size set for one person stays');
  const na = await latest(a);
  assert.deepEqual([na.kind, na.data.quota, na.data.previous], ['storage', 600, 1000]);
  assert.match(na.body, /Nothing has been deleted/);
  assert.equal((await notes(b)).length, bNotes, 'nothing changed for b, so no notice');
  // In GB too (the owner console's usual way).
  assert.equal(ok(await owner('POST', '/owner/settings', { storage: { defaultGb: 2, supporterGb: 30 } })).storage.supporterQuotaBytes, 30 * GB);
  assert.equal((await latest(a)).title, 'Your Kea storage is now 2 GB');
  ok(await owner('POST', '/owner/settings', { storage: { defaultQuotaBytes: 1000, supporterQuotaBytes: 5000 } }));
  assert.equal((await owner('POST', '/owner/settings', { storage: { defaultGb: 'lots' } })).status, 400);
});

test('the standard size is 5 GB, and a Hub that ran with 25 GB tells people when it changes', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kea-std-'));
  try {
    let h2 = createHub({ dataDir: d, log: false, minFreeBytes: 0 });
    const p = await h2.listen({ port: 0, ownerPort: 0 });
    const t = (await (await fetch(`http://127.0.0.1:${p.port}/v1/terms`)).json()).terms;
    await fetch(`http://127.0.0.1:${p.port}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'old@example.com', password: 'lantern velvet orbit', displayName: 'Old', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
    const reg = await (await fetch(`http://127.0.0.1:${p.port}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'old@example.com', password: 'lantern velvet orbit' }) })).json();
    // (A verified account: an unverified one gets the small unverified size.)
    h2.h.run("UPDATE accounts SET email_verified = 1 WHERE email = 'old@example.com'");
    const me = await (await fetch(`http://127.0.0.1:${p.port}/v1/me`, { headers: { authorization: `Bearer ${reg.token}` } })).json();
    assert.equal(me.storage.quota, 5 * GB);
    assert.equal(me.storage.standard, 5 * GB);
    assert.equal(me.storage.supporterQuota, 25 * GB);
    // An older Hub: no record of the size it ran with (it was 25 GB then).
    h2.h.run("DELETE FROM settings WHERE key = 'storageSeen'");
    await h2.close();
    h2 = createHub({ dataDir: d, log: false, minFreeBytes: 0 });
    const n = h2.h.all("SELECT * FROM notifications WHERE kind = 'storage'");
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Your Kea storage is now 5 GB');
    await h2.close();
    // Started again with nothing changed: no second notice.
    h2 = createHub({ dataDir: d, log: false, minFreeBytes: 0 });
    assert.equal(h2.h.all("SELECT * FROM notifications WHERE kind = 'storage'").length, 1);
    await h2.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('shared Claude per account: limits, trusted, blocked, each with a notice; supporter status changes none of it', async () => {
  const a = await person('claude-a@example.com', 'Claude A');
  const course = (n) => ({ school: 'Test U', code: `BIO ${n}`, term: 'Spring 2027', section: '1' });
  // A weekly limit for this person.
  const r = ok(await owner('POST', `/owner/accounts/${a.id}/claude`, { limits: { perAccountWeekly: 20, perAccountDaily: 1 }, note: 'Finals week.' }));
  assert.equal(r.account.sharedClaude.applies.perAccountWeekly, 20);
  let n = await latest(a);
  assert.equal(n.kind, 'claude');
  assert.equal(n.title, 'Changes to Kea’s shared Claude for you');
  assert.match(n.body, /up to 20 times a week/);
  assert.match(n.body, /up to 1 time a day/);
  assert.equal(n.note, 'Finals week.');
  ok(await call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: course(1) }));
  assert.equal((await call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: course(2) })).body.code, 'day_cap');
  assert.equal(ok(await call('GET', '/v1/scan', a.token)).allowance.perDay, 1);

  // Supporter: storage and a badge; the shared Claude stays exactly as it was.
  ok(await owner('POST', `/owner/accounts/${a.id}/supporter`, { months: 1 }));
  assert.equal((await call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: course(2) })).body.code, 'day_cap', 'supporter changes nothing here');

  // Trusted lifts their caps.
  ok(await owner('POST', `/owner/accounts/${a.id}/claude`, { trusted: true }));
  assert.equal((await latest(a)).title, 'You can now use Kea’s shared Claude without the usual daily and weekly limits.');
  assert.equal(ok(await call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: course(2) })).status, 'queued');
  const al = ok(await call('GET', '/v1/scan', a.token)).allowance;
  assert.deepEqual([al.perDay, al.perWeek, al.trusted], [null, null, true]);

  // Blocked, with a reason they see.
  ok(await owner('POST', `/owner/accounts/${a.id}/claude`, { blocked: true, reason: 'Too many requests from scripts.' }));
  n = await latest(a);
  assert.match(n.title, /turned off for your account/);
  assert.match(n.title, /Too many requests from scripts/);
  const refused = await call('POST', '/v1/scan', a.token, { kind: 'initial_scan', course: course(3) });
  assert.deepEqual([refused.status, refused.body.code], [429, 'blocked']);
  ok(await owner('POST', `/owner/accounts/${a.id}/claude`, { blocked: false }));
  assert.equal((await latest(a)).title, 'Kea’s shared Claude works for your account again.');

  // Back to the usual; unknown keys are refused; every change is audited.
  ok(await owner('POST', `/owner/accounts/${a.id}/claude`, { reset: true }));
  assert.equal(ok(await owner('GET', `/owner/accounts/${a.id}`)).account.sharedClaude.applies.perAccountDaily, 3);
  assert.equal((await owner('POST', `/owner/accounts/${a.id}/claude`, { limits: { globalDaily: 1 } })).status, 400);
  assert.equal((await owner('POST', `/owner/accounts/${a.id}/claude`, { limits: { perAccountDaily: -1 } })).status, 400);
  assert.ok(ok(await owner('GET', '/owner/audit?limit=50')).entries.filter((e) => e.action === 'owner.claude' && e.target === a.id).length >= 5);
});

test('supporters: a month, renewing extends, badge in classes and orgs, storage, and when it lapses', async () => {
  const sup = await person('sup@example.com', 'Sam Supporter');
  const teach = await person('teach@example.com', 'Tia Teacher');
  const plain = await person('plain@example.com', 'Pat Plain');
  ok(await owner('POST', `/owner/accounts/${teach.id}`, { canHost: true }));
  assert.equal((await latest(teach)).title, 'You can host classes on the Kea Hub now');
  // A class with all three, and a leaderboard with points.
  const cls = ok(await call('POST', '/v1/classes', teach.token, { title: 'Biology' }), 201).class;
  const code = ok(await call('POST', `/v1/classes/${cls.id}/invites`, teach.token, { role: 'student' }), 201).code;
  for (const p of [sup, plain]) ok(await call('POST', '/v1/join', p.token, { code }, freshIp()));
  const set = ok(await call('POST', `/v1/classes/${cls.id}/sets`, teach.token, { title: 'Ch 1', questions: [{ q: '1+1', choices: ['2', '3'], answer: 0 }] }), 201);
  const qid = ok(await call('GET', `/v1/sets/${set.id}`, sup.token)).questions[0].id;
  for (const p of [sup, plain]) ok(await call('POST', `/v1/sets/${set.id}/answer`, p.token, { questionId: qid, choice: 0 }));

  const r = ok(await owner('POST', `/owner/accounts/${sup.id}/supporter`, { note: 'Thanks for the donation!' }));
  assert.equal(r.account.supporter.active, true);
  const firstEnd = r.account.supporter.until;
  assert.equal(new Date(firstEnd).toISOString().slice(0, 10), '2026-12-05');
  const n = await latest(sup);
  assert.deepEqual([n.kind, n.title, n.note], ['supporter', 'Thank you for supporting Kea!', 'Thanks for the donation!']);
  assert.match(n.body, /December 5, 2026/);
  assert.match(n.body, /your Kea storage is 4\.9 KB/);
  assert.equal(ok(await call('GET', '/v1/me', sup.token)).storage.quota, 5000);
  // Renewing adds to the end.
  const r2 = ok(await owner('POST', `/owner/accounts/${sup.id}/supporter`, { months: 1 }));
  assert.equal(new Date(r2.account.supporter.until).toISOString().slice(0, 10), '2027-01-05');
  assert.match((await latest(sup)).title, /runs until January 5, 2027/);
  assert.equal((await owner('POST', `/owner/accounts/${sup.id}/supporter`, { until: '2020-01-01' })).status, 400);

  // The badge: class members, leaderboard, org members; and nobody else gets one.
  const members = ok(await call('GET', `/v1/classes/${cls.id}/members`, plain.token)).members;
  assert.equal(members.find((m) => m.name === 'Sam Supporter').supporter, true);
  assert.equal(members.find((m) => m.name === 'Pat Plain').supporter, false);
  const board = ok(await call('GET', `/v1/classes/${cls.id}/leaderboard?period=all`, plain.token)).board;
  assert.equal(board.find((e) => e.name === 'Sam Supporter').supporter, true);
  assert.equal(board.find((e) => e.name === 'Pat Plain').supporter, false);
  ok(await owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  const org = ok(await call('POST', '/v1/orgs', teach.token, { name: 'Tutoring Co' }), 201).org;
  const oc = ok(await call('POST', `/v1/orgs/${org.id}/codes`, teach.token, { role: 'member' }), 201).code;
  ok(await call('POST', '/v1/orgs/join', sup.token, { code: oc.code }, freshIp()));
  const om = ok(await call('GET', `/v1/orgs/${org.id}/members`, teach.token)).members;
  assert.equal(om.find((m) => m.name === 'Sam Supporter').supporter, true);
  assert.equal(om.find((m) => m.name === 'Tia Teacher').supporter, false);

  // A bigger size set by hand wins over the supporter size.
  ok(await owner('POST', `/owner/accounts/${sup.id}/quota`, { bytes: 8000 }));
  assert.equal(ok(await call('GET', '/v1/me', sup.token)).storage.quota, 8000);
  ok(await owner('POST', `/owner/accounts/${sup.id}/quota`, { bytes: null }));
  assert.equal((await put(sup.token, 'kea/photos.bin', 'x'.repeat(3000))).status, 201);

  // It lapses: a notice (once), the badge goes, storage back to standard, nothing deleted.
  clock += 70 * DAY;
  hub.h.run('UPDATE sessions SET expires_at = expires_at + ?', 100 * DAY); // (the test's sign-ins would have expired)
  try {
    const me = ok(await call('GET', '/v1/me', sup.token));
    assert.equal(me.account.supporter.active, false);
    assert.deepEqual([me.storage.quota, me.storage.over], [1000, true]);
    const ended = await latest(sup);
    assert.equal(ended.title, 'Your supporter time has ended. Thank you!');
    assert.match(ended.body, /Nothing has been deleted/);
    ok(await call('GET', '/v1/me', sup.token));
    assert.equal((await notes(sup)).filter((x) => x.title.startsWith('Your supporter time has ended')).length, 1, 'once');
    assert.equal(ok(await call('GET', `/v1/classes/${cls.id}/members`, plain.token)).members.find((m) => m.name === 'Sam Supporter').supporter, false);
    assert.equal(ok(await call('GET', '/v1/files', sup.token)).files.length, 1);
    assert.equal((await put(sup.token, 'kea/more.bin', 'x')).status, 507);
    // Started again later: from now, not from the old end.
    const again = ok(await owner('POST', `/owner/accounts/${sup.id}/supporter`, { until: new Date(clock + 10 * DAY).toISOString() }));
    assert.equal(again.account.supporter.until, clock + 10 * DAY);
    ok(await owner('POST', `/owner/accounts/${sup.id}/supporter`, { end: true }));
    assert.equal(ok(await call('GET', '/v1/me', sup.token)).account.supporter.active, false);
    assert.equal((await latest(sup)).title, 'Your supporter time has ended. Thank you!');
  } finally {
    clock -= 70 * DAY;
  }
});

test('phone number: loose format check, rate limit, in the export', async () => {
  const a = await person('phone-a@example.com', 'Phone A');
  const set = (body) => call('POST', '/v1/me/phone', a.token, body);
  for (const bad of ['12', 'call me', '+0 123 4567', '1'.repeat(16), '++1 719 555 0100', 5551234]) assert.equal((await set({ phone: bad })).status, 400, String(bad));
  const r = ok(await set({ phone: '+1 (719) 555-0100' }));
  assert.deepEqual(r.account.phone, { number: '+17195550100', visibility: 'nobody' });
  assert.equal(ok(await set({ visibility: 'classes' })).account.phone.visibility, 'classes');
  assert.equal((await set({ visibility: 'everyone' })).status, 400);
  assert.equal(ok(await call('GET', '/v1/me/export', a.token)).account.phone.number, '+17195550100');
  ok(await set({ phone: '719.555.0101' }));
  ok(await set({ phone: null }));
  assert.deepEqual(ok(await call('GET', '/v1/me', a.token)).account.phone, { number: null, visibility: 'nobody' });
  // The fourth change in a day is refused (this test Hub allows 3); changing only who sees it isn't limited.
  const limited = await set({ phone: '+44 20 7946 0958' });
  assert.equal(limited.status, 429);
  ok(await set({ visibility: 'both' }));
  clock += DAY + 1000;
  try { ok(await set({ phone: '+44 20 7946 0958' })); } finally { clock -= DAY + 1000; }
});

test('phone number: shown only to classmates or coworkers it’s shared with, never on leaderboards or to outsiders', async () => {
  const host = await person('ph-host@example.com', 'Host Hana');
  const cm = await person('ph-cm@example.com', 'Classmate Cam');
  const cw = await person('ph-cw@example.com', 'Coworker Cole');
  const out = await person('ph-out@example.com', 'Outsider Oz');
  const pend = await person('ph-pend@example.com', 'Pending Pia');
  const hubOwner = await person('ph-owner@example.com', 'Hub Owner');
  // (The owner account has two-step sign-in on: owner powers wait for it.)
  hub.h.run("UPDATE accounts SET role = 'owner', totp_enabled = 1 WHERE id = ?", hubOwner.id);
  ok(await owner('POST', `/owner/accounts/${host.id}`, { canHost: true }));
  const cls = ok(await call('POST', '/v1/classes', host.token, { title: 'Chemistry' }), 201).class;
  const code = ok(await call('POST', `/v1/classes/${cls.id}/invites`, host.token, { role: 'student' }), 201).code;
  ok(await call('POST', '/v1/join', cm.token, { code }, freshIp()));
  ok(await owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  const org = ok(await call('POST', '/v1/orgs', host.token, { name: 'Lab Crew' }), 201).org;
  const oc = ok(await call('POST', `/v1/orgs/${org.id}/codes`, host.token, { role: 'member' }), 201).code;
  ok(await call('POST', '/v1/orgs/join', cw.token, { code: oc.code }, freshIp()));
  const gated = ok(await call('POST', `/v1/orgs/${org.id}/codes`, host.token, { role: 'member', needsApproval: true }), 201).code;
  ok(await call('POST', '/v1/orgs/join', pend.token, { code: gated.code }, freshIp()));
  // Points so the leaderboard has the classmate on it.
  const set = ok(await call('POST', `/v1/classes/${cls.id}/sets`, host.token, { title: 'Q', questions: [{ q: 'H2O?', choices: ['water', 'salt'], answer: 0 }] }), 201);
  const qid = ok(await call('GET', `/v1/sets/${set.id}`, cm.token)).questions[0].id;
  ok(await call('POST', `/v1/sets/${set.id}/answer`, cm.token, { questionId: qid, choice: 0 }));

  ok(await call('POST', '/v1/me/phone', cm.token, { phone: '+1 303 555 0111' }));
  ok(await call('POST', '/v1/me/phone', cw.token, { phone: '+1 303 555 0122' }));
  ok(await call('POST', '/v1/me/phone', pend.token, { phone: '+1 303 555 0133', visibility: 'both' }));
  const classPhones = async (who) => ok(await call('GET', `/v1/classes/${cls.id}/members`, who.token)).members.filter((m) => m.phone).map((m) => m.phone);
  const orgPhones = async (who) => {
    const r = ok(await call('GET', `/v1/orgs/${org.id}/members`, who.token));
    return [...r.members, ...r.pending].filter((m) => m.phone).map((m) => m.phone);
  };
  const vis = async (who, visibility) => ok(await call('POST', '/v1/me/phone', who.token, { visibility }));

  // Default: nobody.
  assert.deepEqual(await classPhones(host), []);
  assert.deepEqual(await orgPhones(host), [], 'and never the pending person’s, whatever they chose');

  // Classes only: classmates see it; coworkers don't.
  await vis(cm, 'classes');
  await vis(cw, 'classes');
  assert.deepEqual(await classPhones(host), ['+13035550111']);
  assert.deepEqual(await classPhones(cm), ['+13035550111'], 'they see their own');
  assert.deepEqual(await orgPhones(host), [], 'shared with classes only');
  // Orgs only.
  await vis(cm, 'orgs');
  await vis(cw, 'orgs');
  assert.deepEqual(await classPhones(host), []);
  assert.deepEqual(await orgPhones(host), ['+13035550122']);
  // Both.
  await vis(cw, 'both');
  await vis(cm, 'both');
  assert.deepEqual(await orgPhones(host), ['+13035550122']);
  assert.deepEqual(await classPhones(host), ['+13035550111']);

  // Outsiders: no class, no org, nothing. The Hub owner looking at a class they aren't in: names, no numbers.
  assert.equal((await call('GET', `/v1/classes/${cls.id}/members`, out.token)).status, 404);
  assert.equal((await call('GET', `/v1/orgs/${org.id}/members`, out.token)).status, 404);
  assert.deepEqual(await classPhones(hubOwner), []);
  // A pending member sees nothing at all, and isn't shown with a number.
  assert.equal((await call('GET', `/v1/orgs/${org.id}/members`, pend.token)).status, 403);
  // Never on the leaderboard, whatever they chose.
  const board = ok(await call('GET', `/v1/classes/${cls.id}/leaderboard?period=all`, host.token));
  assert.ok(!JSON.stringify(board).includes('303555'));
  assert.ok(!JSON.stringify(board).includes('phone'));
  // Nor anywhere else a classmate or coworker can read about them.
  for (const p of [`/v1/classes/${cls.id}`, `/v1/orgs/${org.id}`, '/v1/classes', '/v1/orgs', `/v1/orgs/${org.id}/structure`, '/v1/todo']) {
    const r = await call('GET', p, host.token);
    assert.ok(!JSON.stringify(r.body).includes('3035550111') && !JSON.stringify(r.body).includes('3035550122'), p);
  }
  // Cleared: gone everywhere.
  ok(await call('POST', '/v1/me/phone', cm.token, { phone: null }));
  assert.deepEqual(await classPhones(host), []);
});

test('notifications for existing events: org approved, join approved, sign-off decided, scan finished, material arrived', async () => {
  // An org waiting for the Hub owner.
  ok(await owner('POST', '/owner/orgs/settings', { autoApprove: false }));
  const boss = await person('ev-boss@example.com', 'Eve Boss');
  const worker = await person('ev-worker@example.com', 'Wes Worker');
  const org = ok(await call('POST', '/v1/orgs', boss.token, { name: 'Harbor Kitchen' }), 201).org;
  ok(await owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true, note: 'Welcome aboard.' }));
  let n = await latest(boss);
  assert.deepEqual([n.kind, n.title, n.note], ['org', 'Harbor Kitchen is approved on the Kea Hub', 'Welcome aboard.']);
  const gated = ok(await call('POST', `/v1/orgs/${org.id}/codes`, boss.token, { role: 'member', needsApproval: true }), 201).code;
  ok(await call('POST', '/v1/orgs/join', worker.token, { code: gated.code }, freshIp()));
  ok(await call('POST', `/v1/orgs/${org.id}/members/${worker.id}/approve`, boss.token, {}));
  assert.equal((await latest(worker)).title, 'You’re in: Harbor Kitchen');

  // A parent's sign-off, recorded by the owner.
  const teen = await person('ev-teen@example.com', 'Tess Teen', { birthYear: 2011 });
  ok(await owner('POST', `/owner/accounts/${teen.id}/consent`, { approved: true, parentEmail: 'mom@example.com' }));
  assert.equal((await latest(teen)).kind, 'parent_signoff');

  // A question batch two classmates asked for: the one who asked hears it finished; the one who joined hears the
  // material arrived (with the files in their own storage).
  const course = { school: 'Ev U', code: 'HIS 101', term: 'Spring 2027', section: '1' };
  const a = await person('ev-a@example.com', 'Ev A');
  const b = await person('ev-b@example.com', 'Ev B');
  for (const p of [a, b]) {
    // Each one's Kea folder: a device file so the Hub knows where course material goes.
    assert.equal((await put(p.token, 'kea/Kea/School/Devices/pc.json', '{}')).status, 201);
  }
  const ja = ok(await call('POST', '/v1/scan', a.token, { kind: 'more_questions', course, chapter: 'Ch 3', detail: { courseCode: 'HIS 101' } }));
  // (B gets into the section with the code A shares.)
  assert.equal((await call('POST', '/v1/scan', b.token, { kind: 'more_questions', course, chapter: 'Ch 3' })).body.status, 'pending');
  const sectionCode = ok(await call('POST', '/v1/course-sections/code', a.token, { course })).code;
  assert.equal(ok(await call('POST', '/v1/scan', b.token, { kind: 'more_questions', course, chapter: 'Ch 3', joinCode: sectionCode })).status, 'joined');
  let next = ok(await owner('POST', '/owner/scan/next')).job;
  while (next && next.id !== ja.job.id) { ok(await owner('POST', `/owner/scan/${next.id}/finish`, { ok: false, note: 'skip' })); next = ok(await owner('POST', '/owner/scan/next')).job; }
  await ownerFetch(ownerBase, hub.ownerKey, 'PUT', `/owner/scan/${ja.job.id}/course-file?path=material/questions/ch3.json`, '[]');
  ok(await owner('POST', `/owner/scan/${ja.job.id}/finish`, { ok: true }));
  n = await latest(a);
  assert.deepEqual([n.kind, n.title], ['scan_done', 'Your new practice questions are ready: HIS101, spring 2027, section 1, Ch 3']);
  n = await latest(b);
  assert.deepEqual([n.kind, n.title], ['material', 'New practice questions: HIS101, spring 2027, section 1, Ch 3']);
  assert.ok(ok(await call('GET', '/v1/files?prefix=kea/Kea/School/Shared/', b.token)).files.length >= 1);
});
