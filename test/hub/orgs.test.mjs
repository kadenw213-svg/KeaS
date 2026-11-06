// Organizations on the Kea Hub, end to end over HTTP: permissions, join codes, structure, forms, scheduling, to-do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';

const DAY = 86400_000;
let hub, base, ownerBase, dir;
// 5 November 2026, 8am in Denver. The next month's form is December, like the owner's own.
let clock = Date.UTC(2026, 10, 5, 15);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-orgs-test-'));
  hub = createHub({ dataDir: dir, now: () => clock, log: false, ipHeader: 'x-test-ip', limits: { join: [6, 10 * 60_000] }, minFreeBytes: 0 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerBase = `http://127.0.0.1:${p.ownerPort}`;
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

let ipN = 0;
const freshIp = () => ({ 'x-test-ip': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });
async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const owner = async (method, path, body) => {
  const r = await ownerFetch(ownerBase, hub.ownerKey, method, path, body);
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function person(email, name, { verified = true } = {}) {
  const t = (await call('GET', '/v1/terms')).body.terms;
  ok(await call('POST', '/v1/auth/register', null, { email, password: 'lantern velvet orbit', displayName: name, age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }, freshIp()), 202);
  const r = ok(await call('POST', '/v1/auth/login', null, { email, password: 'lantern velvet orbit' }, freshIp()));
  if (verified) ok(await owner('POST', `/owner/accounts/${r.account.id}`, { emailVerified: true }));
  return { token: r.token, id: r.account.id, name };
}
const ip = () => freshIp();

// The cast: a Colorado pool (the owner's kind of org) and a Texas summer camp (very different), plus outsiders.
let boss, admin, mgr, ana, ben, cy, kid, outsider, camper;
let pool, camp, lgPos, frontPos, aquatics, lessons, deptTree, lgCert, form, sched;

test('setup: only verified accounts make orgs; new orgs wait for the Hub owner', async () => {
  [boss, admin, mgr, ana, ben, cy, kid, outsider, camper] = await Promise.all([
    person('boss@pool.org', 'Pat Boss'), person('admin@pool.org', 'Ada Admin'), person('mgr@pool.org', 'Max Manager'),
    person('ana@pool.org', 'Ana Ruiz'), person('ben@pool.org', 'Ben Ode'), person('cy@pool.org', 'Cy Lane'), person('kid@pool.org', 'Kit Young'),
    person('out@else.org', 'Out Sider'), person('camp@camp.org', 'Camp Director'),
  ]);
  const unverified = await person('nov@pool.org', 'No Verify', { verified: false });
  assert.match((await call('POST', '/v1/orgs', unverified.token, { name: 'Nope' })).body.error, /Verify your email/);
  pool = ok(await call('POST', '/v1/orgs', boss.token, { name: 'Westside Pool', kind: 'nonprofit', tz: 'America/Denver', state: 'CO' }), 201).org;
  assert.equal(pool.status, 'pending');
  assert.equal(pool.role, 'owner');
  assert.equal((await call('POST', '/v1/orgs', boss.token, { name: 'Bad tz', tz: 'Mars/Olympus' })).status, 400);
  // Nothing works until the org is approved: no join codes, no classes (only its own page).
  const early = await call('POST', `/v1/orgs/${pool.id}/codes`, boss.token, { role: 'member' });
  assert.deepEqual([early.status, /waiting for approval/.test(early.body.error)], [403, true]);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/classes`, boss.token, { title: 'Lifeguard training' })).status, 403);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}`, boss.token)).org.status, 'pending');
  const list = ok(await owner('GET', '/owner/orgs?status=pending'));
  assert.ok(list.orgs.some((o) => o.id === pool.id && o.creator === 'boss@pool.org'));
  ok(await owner('POST', `/owner/orgs/${pool.id}/decide`, { approve: true }));
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}`, boss.token)).org.status, 'active');
  // The camp: Texas, Central time, weeks starting Monday. The Hub owner turns on auto-approve first.
  ok(await owner('POST', '/owner/orgs/settings', { autoApprove: true }));
  camp = ok(await call('POST', '/v1/orgs', camper.token, { name: 'Pine Hollow Camp', kind: 'private', tz: 'America/Chicago', state: 'TX', workweekStart: 1 }), 201).org;
  assert.equal(camp.status, 'active');
});

test('join codes: roles, 12 random characters, approval, expiry, max uses, revoke, rate limit', async () => {
  const mk = async (tok, body) => call('POST', `/v1/orgs/${pool.id}/codes`, tok, body);
  const adminCode = ok(await mk(boss.token, { role: 'admin' }), 201).code;
  assert.match(adminCode.code, /^[A-HJ-KMNP-Z2-9]{12}$/);
  assert.equal(adminCode.needsApproval, true, 'codes above member need approval by default');
  ok(await call('POST', '/v1/orgs/join', admin.token, { code: adminCode.code.toLowerCase().replace(/(.{4})/g, '$1-') }, ip()));
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}`, admin.token)).org.memberStatus, 'pending');
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/members`, admin.token)).status, 403, 'pending members see nothing yet');
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${admin.id}/approve`, boss.token, {}));
  // Admins make manager codes but not admin codes.
  assert.equal((await mk(admin.token, { role: 'admin' })).status, 403);
  const mgrCode = ok(await mk(admin.token, { role: 'manager', needsApproval: false, maxUses: 1 }), 201).code;
  ok(await call('POST', '/v1/orgs/join', mgr.token, { code: mgrCode.code }, ip()));
  assert.equal((await call('POST', '/v1/orgs/join', ben.token, { code: mgrCode.code }, ip())).status, 404, 'used up');
  // Managers make member codes only.
  assert.equal((await mk(mgr.token, { role: 'manager' })).status, 403);
  const memberCode = ok(await mk(mgr.token, { role: 'member', expiresDays: 7 }), 201).code;
  for (const p of [ana, ben, cy, kid]) ok(await call('POST', '/v1/orgs/join', p.token, { code: memberCode.code }, ip()));
  // Joining twice is harmless.
  assert.equal(ok(await call('POST', '/v1/orgs/join', ana.token, { code: memberCode.code }, ip())).alreadyMember, true);
  // Expired.
  clock += 8 * DAY;
  assert.equal((await call('POST', '/v1/orgs/join', outsider.token, { code: memberCode.code }, ip())).status, 404);
  clock -= 8 * DAY;
  // Revoked.
  const rev = ok(await mk(mgr.token, {}), 201).code;
  ok(await call('POST', `/v1/orgs/${pool.id}/codes/${rev.code}/revoke`, mgr.token, {}));
  assert.equal((await call('POST', '/v1/orgs/join', outsider.token, { code: rev.code }, ip())).status, 404);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/codes/${adminCode.code}/revoke`, mgr.token, {})).status, 403, "managers can't revoke admin codes");
  // Members can't see or make codes.
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/codes`, ana.token)).status, 403);
  assert.equal((await mk(ana.token, {})).status, 403);
  // Guessing is rate-limited per account, whatever the IP.
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) limited = (await call('POST', '/v1/orgs/join', outsider.token, { code: `ZZZZZZZZZZ${i}Z` }, ip())).status === 429;
  assert.ok(limited);
});

test('permissions: other orgs are invisible; members, managers and admins see different things', async () => {
  assert.equal((await call('GET', `/v1/orgs/${pool.id}`, outsider.token)).status, 404);
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/members`, camper.token)).status, 404);
  assert.equal((await call('GET', `/v1/orgs/${camp.id}/members`, boss.token)).status, 404, 'even the pool owner sees nothing of the camp');
  assert.deepEqual(ok(await call('GET', '/v1/orgs', outsider.token)).orgs, []);
  const asMember = ok(await call('GET', `/v1/orgs/${pool.id}/members`, ana.token));
  const other = asMember.members.find((m) => m.id === ben.id);
  assert.equal(other.email, undefined, 'members do not see each other\'s email');
  assert.equal(other.birthdate, undefined);
  assert.equal(asMember.pending.length, 0);
  const asMgr = ok(await call('GET', `/v1/orgs/${pool.id}/members`, mgr.token));
  assert.equal(asMgr.members.find((m) => m.id === ben.id).email, 'ben@pool.org');
  assert.equal(asMgr.members.find((m) => m.id === ben.id).costRate, undefined, 'cost rates are admin-only');
  // Role changes: managers can't, admins can't make admins, the owner can.
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, mgr.token, { role: 'manager' })).status, 403);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, admin.token, { role: 'admin' })).status, 403);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${boss.id}`, admin.token, { title: 'x' })).status, 403, 'nobody changes people above them');
  // Members change only themselves.
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${ben.id}`, ana.token, { desiredMax: 10 })).status, 403);
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, { desiredMin: 15, desiredMax: 20, prefs: ['opener'] }));
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, { positionIds: [] })).status, 403);
  // Org settings are admin-only.
  assert.equal((await call('POST', `/v1/orgs/${pool.id}`, mgr.token, { name: 'Renamed' })).status, 403);
});

test('payroll details are refused anywhere on the Hub', async () => {
  for (const body of [{ ssn: '123-45-6789' }, { bankAccount: '1234' }, { routingNumber: '0' }, { profile: { directDeposit: {} } }, { socialSecurityNumber: 'x' }]) {
    const r = await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /payroll vault/);
  }
  // Disguised keys, values shaped like an SSN or bank details, and payroll hidden deep down are refused too.
  let deep = { ssn: 'x' };
  for (let i = 0; i < 40; i++) deep = { a: deep };
  for (const body of [{ 'ѕѕn': 'x' }, { 'ｓｓｎ': 'x' }, { 's.s.n': 'x' }, { 'ΒankΑccount': 'x' }, { note: 'my ssn is 123-45-6789' }, { note: '123456789' }, { note: 'routing 102000021 acct 12345678' }, deep]) {
    const r = await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  // A body too big to check is refused, not waved through.
  const wide = { list: Array.from({ length: 30_000 }, (_, i) => i) };
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, wide)).status, 413);
  // Ordinary words that merely contain those letters are fine, and so are phone numbers and dates.
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${ana.id}`, ana.token, { prefs: ['waiting', 'assigned'], className: 'x', note: 'call 719-555-0134 on 2026-12-01' }));
});

test('structure: department tree of any depth, no cycles, positions, locations, cost centers', async () => {
  const P = (path, body, tok = admin.token) => call('POST', `/v1/orgs/${pool.id}${path}`, tok, body);
  assert.equal((await P('/departments', { name: 'X' }, mgr.token)).status, 403);
  const cc = ok(await P('/cost-centers', { code: '510', name: 'Aquatics labor' }), 201).item;
  const loc = ok(await P('/locations', { name: 'Westside', address: '1 Pool Rd' }), 201).item;
  aquatics = ok(await P('/departments', { name: 'Aquatics', costCenterId: cc.id, locationId: loc.id }), 201).department;
  const guards = ok(await P('/departments', { name: 'Lifeguards', parentId: aquatics.id }), 201).department;
  const lead = ok(await P('/departments', { name: 'Head guards', parentId: guards.id }), 201).department;
  lessons = ok(await P('/departments', { name: 'Swim lessons', parentId: aquatics.id }), 201).department;
  assert.match((await P(`/departments/${aquatics.id}`, { parentId: lead.id })).body.error, /under itself/);
  lgPos = ok(await P('/positions', { name: 'Lifeguard', departmentId: guards.id, tags: ['lifeguard'], costRate: 16 }), 201).position;
  frontPos = ok(await P('/positions', { name: 'Front desk', departmentId: aquatics.id, costRate: 14.5 }), 201).position;
  const st = ok(await call('GET', `/v1/orgs/${pool.id}/structure`, ana.token));
  assert.equal(st.departments.length, 4);
  assert.equal(st.positions.find((p) => p.id === lgPos.id).costRate, undefined, 'members do not see cost rates');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/structure`, admin.token)).positions.find((p) => p.id === lgPos.id).costRate, 16);
  deptTree = { guards, lead };
  // Another org's department can't be used here.
  const campDept = ok(await call('POST', `/v1/orgs/${camp.id}/departments`, camper.token, { name: 'Waterfront' }), 201).department;
  assert.equal((await P('/departments', { name: 'Sneaky', parentId: campDept.id })).status, 400);
  // People: positions, departments, a 14-year-old.
  for (const p of [ana, ben, cy]) ok(await call('POST', `/v1/orgs/${pool.id}/members/${p.id}`, mgr.token, { positionIds: [lgPos.id], departmentId: guards.id }));
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${kid.id}`, admin.token, { positionIds: [lgPos.id, frontPos.id], departmentId: lessons.id, birthdate: '2012-06-01' }));
});

test('certs: types per org, records with expiry and countdowns; org classes issue certs', async () => {
  lgCert = ok(await call('POST', `/v1/orgs/${pool.id}/cert-types`, admin.token, { name: 'Lifeguard', validMonths: 24, positionIds: [lgPos.id] }), 201).certType;
  ok(await call('POST', `/v1/orgs/${pool.id}/cert-types`, admin.token, { name: 'CPR', validMonths: 12, warnDays: [30, 7] }), 201);
  // Ana: valid a long time. Ben: expires in 20 days. Cy: none yet. Kit: valid.
  ok(await call('POST', `/v1/orgs/${pool.id}/certs`, mgr.token, { accountId: ana.id, typeId: lgCert.id, issuedOn: '2026-06-01' }), 201);
  const benCert = ok(await call('POST', `/v1/orgs/${pool.id}/certs`, mgr.token, { accountId: ben.id, typeId: lgCert.id, issuedOn: '2024-11-26', expiresOn: '2026-11-25' }), 201).cert;
  assert.deepEqual([benCert.stage, benCert.daysLeft], ['30', 20]);
  ok(await call('POST', `/v1/orgs/${pool.id}/certs`, mgr.token, { accountId: kid.id, typeId: lgCert.id, issuedOn: '2026-05-01' }), 201);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/certs`, ana.token, { accountId: ana.id, typeId: lgCert.id })).status, 403);
  const mine = ok(await call('GET', `/v1/orgs/${pool.id}/certs`, ana.token));
  assert.ok(mine.certs.every((c) => c.accountId === ana.id), 'members see only their own certs');
  assert.equal(mine.certs[0].expiresOn, '2028-05-31', '24 months from the issue date');
  const all = ok(await call('GET', `/v1/orgs/${pool.id}/certs`, mgr.token));
  assert.ok(all.missing.some((m) => m.accountId === cy.id && m.typeId === lgCert.id));
  // An org class: Cy takes it, and finishing issues the Lifeguard cert.
  const cls = ok(await call('POST', `/v1/orgs/${pool.id}/classes`, mgr.token, { title: 'Lifeguard class', certTypeId: lgCert.id }), 201).class;
  ok(await call('POST', `/v1/orgs/${pool.id}/classes/${cls.id}/sessions`, mgr.token, { start: '2026-11-10T16:00:00Z', end: '2026-11-10T20:00:00Z', location: 'Pool' }), 201);
  ok(await call('POST', `/v1/orgs/${pool.id}/classes/${cls.id}/assign`, mgr.token, { accountIds: [cy.id], dueOn: '2026-11-20' }));
  const cyClasses = ok(await call('GET', `/v1/orgs/${pool.id}/classes`, cy.token)).classes;
  assert.equal(cyClasses.length, 1);
  assert.equal(cyClasses[0].assigned, undefined, 'members do not see the roster');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/classes`, ben.token)).classes.length, 0);
  // It's a real Hub class: Cy sees its sessions in the Hub calendar too.
  assert.equal(ok(await call('GET', '/v1/calendar', cy.token)).sessions.length, 1);
  const todo = ok(await call('GET', '/v1/todo', cy.token)).items;
  assert.ok(todo.some((t) => t.kind === 'class' && t.nextSession));
  assert.ok(todo.some((t) => t.kind === 'cert' && t.stage === 'missing'));
  const done = ok(await call('POST', `/v1/orgs/${pool.id}/classes/${cls.id}/complete`, mgr.token, { accountIds: [cy.id], completedOn: '2026-11-10' }));
  assert.equal(done.issued.length, 1);
  const cyCerts = ok(await call('GET', `/v1/orgs/${pool.id}/certs`, cy.token)).certs;
  assert.deepEqual([cyCerts[0].typeName, cyCerts[0].source, cyCerts[0].expiresOn], ['Lifeguard', 'class', '2028-11-09']);
  assert.ok(!ok(await call('GET', '/v1/todo', cy.token)).items.some((t) => t.kind === 'class'));
});

test('availability forms: blocks from templates, copy last month, exceptions, audience, tri-state answers', async () => {
  const P = (path, body, tok = mgr.token) => call('POST', `/v1/orgs/${pool.id}${path}`, tok, body);
  const need = (n) => [{ positionId: lgPos.id, count: n }];
  const set = ok(await P('/block-sets', { name: 'Lifeguard blocks', positionId: lgPos.id, blocks: [
    ...[1, 2, 3, 4, 5].flatMap((wd) => [
      { id: `m${wd}`, weekday: wd, start: '04:45', end: '09:00', need: need(2), tags: ['opener'] },
      { id: `d${wd}`, weekday: wd, start: '09:00', end: '13:00', need: need(1) },
      { id: `a${wd}`, weekday: wd, start: '13:00', end: '16:00', need: need(1) },
      { id: `e${wd}`, weekday: wd, start: '15:45', end: '20:45', need: need(2), tags: ['closer'] },
    ]),
    { id: 's6', weekday: 6, start: '06:45', end: '11:30', need: need(1) },
  ] }), 201).blockSet;
  assert.equal((await P('/block-sets', { name: 'x', blocks: [] }, ana.token)).status, 403);
  // November first (an old form), then December copied from it.
  const nov = ok(await P('/forms', { periodStart: '2026-11-01', periodEnd: '2026-11-30', blockSetIds: [set.id], deadline: '2026-11-01T06:00:00Z' }), 201).form;
  ok(await P(`/forms/${nov.id}/open`, {}));
  form = ok(await P('/forms', { copyFrom: 'last', exceptions: [{ date: '2026-12-25', kind: 'closed', note: 'Christmas' }, { date: '2026-12-12', kind: 'extra', blocks: [{ id: 'meet', start: '17:00', end: '21:00', label: 'Swim meet', need: need(3) }] }],
    questions: { custom: [{ id: 'teach', label: 'Can you teach swim lessons?', type: 'yesno' }] }, minorNote: 'Under 18: no shifts before 7am.' }), 201).form;
  assert.deepEqual([form.periodStart, form.periodEnd, form.title, form.status], ['2026-12-01', '2026-12-31', 'December 2026 availability', 'draft']);
  assert.equal(form.blocks.length, 21);
  assert.equal(new Date(form.deadlineAt).toISOString(), '2026-11-25T06:59:00.000Z', 'a week before, 11:59pm local');
  // Drafts are invisible to members.
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ana.token)).status, 404);
  ok(await P(`/forms/${form.id}/open`, {}));
  // Audience: a lessons-only form doesn't reach the guards.
  const lessonsForm = ok(await P('/forms', { title: 'Lesson instructors', periodStart: '2026-12-01', periodEnd: '2026-12-31', blocks: [{ id: 'l', weekday: 6, start: '09:00', end: '12:00' }], audience: { departments: [lessons.id] }, open: true }), 201).form;
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/forms/${lessonsForm.id}`, ana.token)).status, 404);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/forms/${lessonsForm.id}`, kid.token)).form.id, lessonsForm.id);
  assert.ok(!ok(await call('GET', `/v1/orgs/${pool.id}/forms`, ana.token)).forms.some((f) => f.id === lessonsForm.id));
  // Filling in: Ana marks every opener Available and Wednesday evenings If needed; junk is dropped.
  const view = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ana.token));
  assert.equal(view.form.minorNote, null, 'the under-18 note is only for minors');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, kid.token)).form.minorNote, 'Under 18: no shifts before 7am.');
  assert.ok(!view.slots.some((s) => s.date === '2026-12-25'));
  assert.ok(view.slots.some((s) => s.key === '2026-12-12|meet'));
  const answers = {};
  for (const s of view.slots) { if (s.blockId.startsWith('m')) answers[s.key] = 'A'; if (s.blockId === 'e3') answers[s.key] = 'I'; }
  answers['2026-12-12|meet'] = 'A';
  answers['2026-12-25|m5'] = 'A'; // closed: dropped
  answers['2026-12-01|d2'] = 'N';
  const saved = ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, ana.token, { answers, dateNotes: { '2026-12-03': 'Dentist at 10' }, note: 'Prefer opening', desiredMin: 15, desiredMax: 20, daysOff: '12/24-12/26', extra: { teach: true }, saveUsual: true }));
  assert.equal(saved.status, 'saved');
  assert.equal(Object.keys(saved.response.answers).length, Object.keys(answers).length - 2);
  assert.equal(saved.hours.ifNeeded, 25, 'five Wednesday evenings of 5 hours');
  // Her usual week now prefills mornings on the next form.
  const again = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ana.token));
  assert.equal(again.prefill.usual['2026-12-07|m1'], 'A');
  assert.equal(again.prefill.usual['2026-12-02|e3'], 'I');
  // Ben fills it from scratch; Cy: Available everywhere; Kit isn't on this form's... (yes he is: everyone).
  const benAns = {}, cyAns = {}, kidAns = {};
  for (const s of view.slots) {
    if (s.blockId.startsWith('e') || s.blockId.startsWith('m')) benAns[s.key] = s.blockId.startsWith('e') ? 'A' : 'I';
    cyAns[s.key] = 'A';
    if (s.blockId.startsWith('m') || s.blockId.startsWith('d')) kidAns[s.key] = 'A';
  }
  ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, ben.token, { answers: benAns, desiredMax: 30 }));
  ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, cy.token, { answers: cyAns, desiredMin: 10, desiredMax: 12 }));
  // Saving without sending keeps it a draft.
  assert.equal(ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, kid.token, { answers: kidAns, submit: false })).status, 'draft');
  // Custom answers are checked against the question type.
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, ben.token, { answers: benAns, extra: { teach: 'maybe' } })).status, 400);
});

test('results: matrix with coverage against need, people view, nudges, CSV export', async () => {
  const m = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/matrix`, mgr.token));
  const dec2open = m.slots.find((s) => s.key === '2026-12-02|m3');
  assert.deepEqual(dec2open.available.map((p) => p.name).sort(), ['Ana Ruiz', 'Cy Lane']);
  assert.deepEqual(dec2open.ifNeeded.map((p) => p.name), ['Ben Ode']);
  assert.equal(dec2open.needTotal, 2);
  assert.equal(dec2open.coverage, 1);
  assert.deepEqual(m.slots.find((s) => s.date === '2026-12-03').notes, [{ id: ana.id, name: 'Ana Ruiz', note: 'Dentist at 10' }]);
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/matrix`, ana.token)).status, 403);
  const people = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/people`, mgr.token));
  const missing = people.people.filter((p) => !p.submitted).map((p) => p.name).sort();
  assert.deepEqual(missing, ['Ada Admin', 'Kit Young', 'Max Manager', 'Pat Boss']);
  assert.equal(people.people.find((p) => p.id === ana.id).hours.perWeekIfNeeded > 0, true);
  // Nudge Kit: it shows on Kit's to-do, marked.
  ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/nudge`, mgr.token, { accountIds: [kid.id] }));
  const kt = ok(await call('GET', '/v1/todo', kid.token)).items.find((t) => t.kind === 'availability' && t.action.formId === form.id);
  assert.match(kt.detail, /manager asked/);
  assert.equal(kt.dueAt, form.deadlineAt);
  assert.ok(kt.msLeft > 19 * DAY && kt.msLeft < 21 * DAY);
  // CSV in the Google-Sheets shape, and by date.
  const csv = await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/export`, mgr.token);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(lines[0].startsWith('Timestamp,Email Address,Name,Monday 4:45am-9am,'));
  assert.ok(lines[0].includes('12/12 Swim meet 5pm-9pm'));
  assert.ok(lines[0].includes('Can you teach swim lessons?'));
  assert.equal(lines.length, 4, 'header + three people who sent it');
  assert.ok(lines.find((l) => l.includes('ana@pool.org')).includes(',Yes,12/3: Dentist at 10,Prefer opening'));
  const long = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/export?format=long&as=json`, mgr.token));
  assert.match(long.filename, /by date/);
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/export`, ben.token)).status, 403);
});

test('after the deadline: edits become change requests the manager approves', async () => {
  const saveClock = clock;
  clock = form.deadlineAt + 3600_000;
  // Kit never sent it: a late first answer is taken, and marked late.
  const kidAns = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, kid.token)).response.answers;
  assert.equal(ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, kid.token, { answers: kidAns })).status, 'late');
  // Ben changes his: it waits for approval.
  const benView = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ben.token));
  assert.equal(benView.state.changeRequest, true);
  const changed = { ...benView.response.answers, '2026-12-01|d2': 'A' };
  assert.equal(ok(await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, ben.token, { answers: changed, reason: 'Class moved' })).status, 'change_requested');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ben.token)).response.answers['2026-12-01|d2'], undefined, 'not applied yet');
  // Managers: missing submissions past deadline and the approval show in their to-do.
  const mt = ok(await call('GET', '/v1/todo', mgr.token)).items;
  assert.ok(mt.find((t) => t.kind === 'missing' && t.overdue));
  assert.equal(mt.find((t) => t.kind === 'approvals').counts.changes, 1);
  const ch = ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}/changes`, mgr.token)).changes[0];
  assert.deepEqual(ch.diff, [{ key: '2026-12-01|d2', from: 'N', to: 'A' }]);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/changes/${ch.id}/decide`, ben.token, { approve: true })).status, 403);
  ok(await call('POST', `/v1/orgs/${pool.id}/changes/${ch.id}/decide`, mgr.token, { approve: true }));
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/forms/${form.id}`, ben.token)).response.answers['2026-12-01|d2'], 'A');
  clock = saveClock;
});

test('scheduling: live rule checks (certs, minors, overlap), manual assign, auto-fill, budget, publish', async () => {
  sched = ok(await call('POST', `/v1/orgs/${pool.id}/schedules`, mgr.token, { formId: form.id }), 201).schedule;
  assert.equal(sched.title, 'December 2026 schedule');
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/schedules/${sched.id}`, ana.token)).status, 403);
  const chk = (body) => call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/check`, mgr.token, { positionId: lgPos.id, ...body });
  // Ben's Lifeguard cert expires 25 November: December shifts are blocked and can't be forced.
  const benChk = ok(await chk({ accountId: ben.id, date: '2026-12-01', blockId: 'e2' }));
  assert.ok(benChk.blocked && !benChk.canForce);
  assert.ok(benChk.problems.some((p) => p.code === 'cert_expired'));
  // Kit is 14: federal rules forbid lifeguarding under 15, and 4:45am starts.
  const kidChk = ok(await chk({ accountId: kid.id, date: '2026-12-01', blockId: 'm2' }));
  assert.ok(kidChk.problems.some((p) => p.code === 'position_min_age'));
  assert.ok(kidChk.problems.some((p) => p.code === 'minor_time_of_day'));
  // Manual: Ana on the Tuesday opener. Then overlapping: she's on a second block at the same time -> forceable.
  const s1 = ok(await call('POST', `/v1/orgs/${pool.id}/shifts`, mgr.token, { scheduleId: sched.id, accountId: ana.id, positionId: lgPos.id, date: '2026-12-01', blockId: 'm2' }), 201);
  assert.equal(s1.shift.status, 'draft');
  const clash = await call('POST', `/v1/orgs/${pool.id}/shifts`, mgr.token, { scheduleId: sched.id, accountId: ana.id, positionId: lgPos.id, date: '2026-12-01', start: '08:00', end: '10:00' });
  assert.equal(clash.status, 409);
  assert.ok(clash.body.canForce && clash.body.problems.some((p) => p.code === 'overlap'));
  // Messages read as local times, not ISO stamps.
  assert.match(clash.body.problems.find((p) => p.code === 'overlap').message, /Tue, Dec 1, 4:45 AM/);
  assert.match(benChk.problems.find((p) => p.code === 'cert_expired').message, /Nov 25, 2026/);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/shifts`, mgr.token, { scheduleId: sched.id, accountId: ben.id, positionId: lgPos.id, date: '2026-12-01', blockId: 'e2', force: true })).status, 409, 'cert blocks are never forced');
  // Budget: Lifeguards (department) gets $1,000 for December; its subtree's shifts count.
  ok(await call('POST', `/v1/orgs/${pool.id}/budgets`, admin.token, { departmentId: deptTree.guards.id, periodStart: '2026-12-01', periodEnd: '2026-12-31', amount: 1000 }), 201);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/budgets`, mgr.token, { departmentId: deptTree.guards.id, periodStart: '2026-12-01', periodEnd: '2026-12-31', amount: 1 })).status, 403);
  // Auto-fill.
  const af = ok(await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/autofill`, mgr.token, {}));
  assert.ok(af.added > 20);
  const view = ok(await call('GET', `/v1/orgs/${pool.id}/schedules/${sched.id}`, mgr.token));
  const shifts = view.shifts;
  assert.ok(!shifts.some((s) => s.accountId === ben.id), 'Ben has an expired cert: never placed');
  assert.ok(!shifts.some((s) => s.accountId === kid.id), 'Kit is too young to lifeguard');
  // No overlaps for anyone.
  for (const p of [ana.id, cy.id]) {
    const mine = shifts.filter((s) => s.accountId === p).sort((a, b) => a.startAt - b.startAt);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].startAt >= mine[i - 1].endAt, 'no overlapping shifts');
  }
  // Cy wanted 10-12 hours a week; Ana 15-20. Auto-fill never puts Cy over 40 (overtime is a hard stop).
  for (const [wk, h] of Object.entries(view.people.find((p) => p.id === cy.id).hoursByWeek)) assert.ok(h <= 40, `${wk}: ${h}`);
  // Deterministic: clear the auto-filled shifts, run again, same result.
  const key = (list) => list.filter((s) => s.source === 'autofill').map((s) => `${s.slotKey}|${s.accountId}`).sort().join(',');
  const first = key(shifts);
  ok(await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/clear`, mgr.token, { source: 'autofill' }));
  ok(await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/autofill`, mgr.token, {}));
  assert.equal(key(ok(await call('GET', `/v1/orgs/${pool.id}/schedules/${sched.id}`, mgr.token)).shifts), first);
  // The budget shows the scheduled cost, and publishing over budget needs a yes.
  const b = view.budget[0];
  assert.ok(b.scheduled > 0 && b.hours > 0);
  assert.ok(Math.abs(b.scheduled - b.hours * 16) < 1, `${b.scheduled} for ${b.hours} h at $16`);
  ok(await call('POST', `/v1/orgs/${pool.id}/budgets`, admin.token, { departmentId: deptTree.guards.id, periodStart: '2026-12-01', periodEnd: '2026-12-31', amount: 100, label: 'Revised' }), 201);
  const pub = await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/publish`, mgr.token, {});
  assert.equal(pub.status, 409);
  assert.equal(pub.body.budgetWarnings[0].label, 'Revised');
  // Manager to-do: a budget warning.
  assert.ok(ok(await call('GET', '/v1/todo', mgr.token)).items.some((t) => t.kind === 'budget'));
  // Nothing is published yet: Ana sees no shifts.
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, ana.token)).shifts.length, 0);
  const done = ok(await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/publish`, mgr.token, { confirmOverBudget: true }));
  assert.ok(done.published > 20);
  const anaShifts = ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, ana.token)).shifts;
  assert.ok(anaShifts.length > 0 && anaShifts.every((s) => s.accountId === ana.id && s.status === 'published'));
  const cal = ok(await call('GET', '/v1/orgs-calendar?from=2026-12-01&to=2027-01-01', ana.token)).events;
  assert.equal(cal.filter((e) => e.kind === 'shift').length, anaShifts.length);
  assert.equal(cal[0].orgName, 'Westside Pool');
  assert.equal((await call('GET', '/v1/orgs-calendar', outsider.token)).body.events.length, 0);
  // After publishing, availability changes are refused for this period.
  clock = form.deadlineAt + 2 * DAY;
  const r = await call('POST', `/v1/orgs/${pool.id}/forms/${form.id}/response`, ana.token, { answers: {} });
  assert.match(r.body.error, /schedule for these dates is out/);
  clock = Date.UTC(2026, 10, 5, 15);
});

test('schedule drafts from another client are checked and never publish themselves', async () => {
  const slot = ok(await call('GET', `/v1/orgs/${pool.id}/schedules/${sched.id}`, mgr.token)).slots.find((s) => s.key === '2026-12-12|meet');
  const draft = ok(await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/drafts`, mgr.token, {
    source: 'claude', summary: 'Ana prefers opening; Ben is out of cert.',
    shifts: [{ accountId: ben.id, positionId: lgPos.id, date: '2026-12-12', blockId: 'meet', why: 'Available' }, { accountId: cy.id, positionId: lgPos.id, date: '2026-12-31', start: '10:00', end: '11:00' }],
  }), 201).draft;
  assert.equal(draft.status, 'waiting');
  assert.ok(draft.shifts[0].blocked, 'the draft shows the cert problem');
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/schedules/${sched.id}/drafts`, ana.token, { shifts: [] })).status, 403);
  assert.ok(ok(await call('GET', '/v1/todo', mgr.token)).items.some((t) => t.kind === 'drafts'));
  const before = ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, cy.token)).shifts.length;
  const applied = ok(await call('POST', `/v1/orgs/${pool.id}/drafts/${draft.id}/apply`, mgr.token, {}));
  assert.equal(applied.added, 1);
  assert.equal(applied.skipped.length, 1);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, cy.token)).shifts.length, before, 'applied as a draft, not published');
  assert.ok(slot);
});

test('swaps: offer, claim with rule checks, manager approval', async () => {
  // Dee joins later, with a valid cert and no shifts yet.
  const dee = await person('dee@pool.org', 'Dee Late');
  const code = ok(await call('POST', `/v1/orgs/${pool.id}/codes`, mgr.token, {}), 201).code.code;
  ok(await call('POST', '/v1/orgs/join', dee.token, { code }, ip()));
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${dee.id}`, mgr.token, { positionIds: [lgPos.id] }));
  ok(await call('POST', `/v1/orgs/${pool.id}/certs`, mgr.token, { accountId: dee.id, typeId: lgCert.id, issuedOn: '2026-10-01' }), 201);
  const anaShift = ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, ana.token)).shifts[0];
  const offer = ok(await call('POST', `/v1/orgs/${pool.id}/shifts/${anaShift.id}/swap`, ana.token, { note: 'Family trip' }), 201).swap;
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/shifts/${anaShift.id}/swap`, ana.token, {})).status, 400, 'already offered');
  // Ben can see it but can't take it (expired cert); Kit holds no... Kit is a lifeguard but too young.
  assert.ok(ok(await call('GET', '/v1/todo', ben.token)).items.some((t) => t.kind === 'swap'));
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/claim`, ben.token, {})).status, 409);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/claim`, kid.token, {})).status, 409);
  // Dee can.
  assert.equal(ok(await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/claim`, dee.token, {})).swap.status, 'claimed');
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/claim`, cy.token, {})).status, 400, 'already taken');
  assert.equal(ok(await call('GET', '/v1/todo', mgr.token)).items.find((t) => t.kind === 'approvals').counts.swaps, 1);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/decide`, dee.token, { approve: true })).status, 403);
  ok(await call('POST', `/v1/orgs/${pool.id}/swaps/${offer.id}/decide`, mgr.token, { approve: true }));
  assert.ok(ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, dee.token)).shifts.some((s) => s.id === anaShift.id));
  assert.ok(!ok(await call('GET', `/v1/orgs/${pool.id}/my-shifts?from=2026-12-01&to=2027-01-01`, ana.token)).shifts.some((s) => s.id === anaShift.id));
});

test('to-do: cert countdown stages, acknowledgments, snooze', async () => {
  const bt = ok(await call('GET', '/v1/todo', ben.token)).items;
  const cert = bt.find((t) => t.kind === 'cert');
  assert.deepEqual([cert.stage, cert.daysLeft], ['30', 20]);
  ok(await call('POST', `/v1/orgs/${pool.id}/policies`, mgr.token, { title: 'Pool rules 2027', dueOn: '2026-11-15' }), 201);
  const ack = ok(await call('GET', '/v1/todo', ben.token)).items.find((t) => t.kind === 'ack');
  assert.ok(ack);
  // Ordered: overdue first, then soonest due, then undated.
  const items = ok(await call('GET', '/v1/todo', ben.token)).items;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    assert.ok((a.overdue ? 1 : 0) >= (b.overdue ? 1 : 0));
    if (!!a.overdue === !!b.overdue) assert.ok((a.dueAt ?? Infinity) <= (b.dueAt ?? Infinity));
  }
  // Snooze hides it for a while, then it comes back.
  const after = ok(await call('POST', '/v1/todo/snooze', ben.token, { key: ack.key, hours: 24 }));
  assert.ok(!after.items.some((t) => t.key === ack.key));
  assert.ok(after.snoozed.some((t) => t.key === ack.key));
  clock += 25 * 3600_000;
  assert.ok(ok(await call('GET', '/v1/todo', ben.token)).items.some((t) => t.key === ack.key));
  ok(await call('POST', `/v1/orgs/${pool.id}/policies/${ack.action.policyId}/ack`, ben.token, {}));
  assert.ok(!ok(await call('GET', '/v1/todo', ben.token)).items.some((t) => t.kind === 'ack'));
  // Days pass: 7-day stage, then expired with shifts blocked.
  clock = Date.UTC(2026, 10, 19, 15);
  assert.equal(ok(await call('GET', '/v1/todo', ben.token)).items.find((t) => t.kind === 'cert').stage, '7');
  clock = Date.UTC(2026, 10, 27, 15);
  const exp = ok(await call('GET', '/v1/todo', ben.token)).items.find((t) => t.kind === 'cert');
  assert.deepEqual([exp.stage, exp.detail, exp.overdue], ['expired', 'Expired, shifts blocked', true]);
  const top = ok(await call('GET', '/v1/todo', ben.token)).items;
  const firstLater = top.findIndex((t) => !t.overdue);
  assert.ok(top.findIndex((t) => t.kind === 'cert') < (firstLater < 0 ? top.length : firstLater), 'expired is with the overdue items at the top');
  clock = Date.UTC(2026, 10, 5, 15);
});

test('the Texas camp works the same way with its own zone, week and rules', async () => {
  const P = (path, body) => call('POST', `/v1/orgs/${camp.id}${path}`, camper.token, body);
  const counselor = ok(await P('/positions', { name: 'Counselor', costRate: 12 }), 201).position;
  const code = ok(await P('/codes', { role: 'member', positionId: counselor.id }), 201).code;
  ok(await call('POST', '/v1/orgs/join', ana.token, { code: code.code }, ip()));
  assert.deepEqual(ok(await call('GET', `/v1/orgs/${camp.id}/members`, ana.token)).members.find((m) => m.you).positionIds, [counselor.id], 'the code gave her the position');
  const f = ok(await P('/forms', { periodStart: '2027-06-07', periodEnd: '2027-06-13', blocks: [{ id: 'day', weekday: 1, start: '08:00', end: '17:00', need: [{ positionId: counselor.id, count: 1 }] }], open: true }), 201).form;
  const slots = ok(await call('GET', `/v1/orgs/${camp.id}/forms/${f.id}`, ana.token)).slots;
  assert.equal(new Date(slots[0].startAt).toISOString(), '2027-06-07T13:00:00.000Z', '8am Central in summer');
  ok(await call('POST', `/v1/orgs/${camp.id}/forms/${f.id}/response`, ana.token, { answers: { [slots[0].key]: 'A' } }));
  const sc = ok(await P('/schedules', { formId: f.id }), 201).schedule;
  assert.equal(ok(await P(`/schedules/${sc.id}/autofill`, {})).added, 1);
  // Ana is in two orgs; each sees only its own.
  assert.equal(ok(await call('GET', '/v1/orgs', ana.token)).orgs.length, 2);
  assert.equal((await call('GET', `/v1/orgs/${camp.id}/forms/${form.id}`, camper.token)).status, 404, "the pool's form can't be read through the camp");
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/forms/${f.id}`, mgr.token)).status, 404);
});

test('leave and remove; the only owner stays; the Hub owner can suspend an org', async () => {
  assert.match((await call('POST', `/v1/orgs/${pool.id}/leave`, boss.token, {})).body.error, /only owner/);
  ok(await call('POST', `/v1/orgs/${camp.id}/leave`, ana.token, {}));
  assert.equal((await call('GET', `/v1/orgs/${camp.id}`, ana.token)).status, 404);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/members/${admin.id}/remove`, mgr.token, {})).status, 403, 'managers cannot remove admins');
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${kid.id}/remove`, mgr.token, {}));
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/members`, kid.token)).status, 404);
  ok(await owner('POST', `/owner/orgs/${pool.id}/status`, { status: 'suspended', note: 'Test' }));
  assert.match((await call('GET', `/v1/orgs/${pool.id}/members`, ana.token)).body.error, /suspended/);
  assert.equal(ok(await call('GET', '/v1/orgs', ana.token)).orgs[0].status, 'suspended', 'still listed so it can be left');
  ok(await owner('POST', `/owner/orgs/${pool.id}/status`, { status: 'active' }));
  const exp = ok(await call('GET', '/v1/orgs-export', ana.token));
  assert.ok(exp.memberships.length >= 1 && exp.availability.length >= 1);
});
