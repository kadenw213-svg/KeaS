// The one-time import from an org server's database (org/import.mjs, hub/import-org-server.mjs): people matched to
// Kea accounts by their linked account or email, their shifts, punches, requests and approvals brought in, a report
// of who wasn't matched, and running it again bringing in nothing twice. Timecards come out the same as on the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';
import { openDb } from '../../server/db.mjs';
import { makeVault } from '../../server/payroll/vaultstate.mjs';
import { readFileSync } from 'node:fs';
import { runImport } from '../../hub/import-org-server.mjs';
import { startHub } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 20, 18);
let H, sdir, serverDb, boss, org, dana, rafael, priya, marcus;
const O = (path) => `/v1/orgs/${org.id}${path}`;
const email = (n) => `${n}@demo-aquatics.example`;
before(async () => {
  sdir = mkdtempSync(join(tmpdir(), 'keas-import-src-'));
  serverDb = join(sdir, 'org.db');
  const app = createApp({ dbFile: serverDb, log: false, devKeyFile: true, demo: true, now: () => NOW });
  await app.close();
  H = await startHub({ prefix: 'keas-import-', clock: NOW });
  [boss, dana, rafael, priya, marcus] = await Promise.all([
    H.person('boss@import.org', 'Imogen Boss'), H.person(email('dana.whitfield'), 'Dana W'), H.person(email('rafael.ortega'), 'Rafael O'),
    H.person('priya@elsewhere.org', 'Priya R'), H.person(email('marcus.bell'), 'Marcus B'),
  ]);
  // Priya's payroll sign-in is linked to a Kea account with another email.
  const src = openDb(serverDb);
  src.run("INSERT INTO vault_users (id,person_id,email,hub_sub,created_at) VALUES ('vu-t','p03',?,?,'2026-11-01')", 'priya.payroll@demo-aquatics.example', priya.id);
  src.close();
  org = H.ok(await H.call('POST', '/v1/orgs', boss.token, { name: 'Imported Aquatics', tz: 'America/Denver', state: 'CO' }), 201).org;
  H.ok(await H.owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true }));
});
after(async () => { await H.close(); rmSync(sdir, { recursive: true, force: true }); });

const counts = () => Object.fromEntries(['org_members', 'org_shifts', 'org_punches', 'org_punch_requests', 'org_timecard_approvals', 'org_positions', 'org_roles'].map((t) => [t, H.hub.h.get(`SELECT COUNT(*) AS n FROM ${t}`).n]));

test('a dry run reports and changes nothing', () => {
  const before = counts();
  const r = runImport({ hubData: H.dir, server: serverDb, org: org.id, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.people.matched.length, 4);
  assert.deepEqual(counts(), before);
});

let first;
test('people are matched by linked Kea account, then email; the rest are listed by name', () => {
  first = runImport({ hubData: H.dir, server: serverDb, org: org.id, by: boss.id });
  const by = Object.fromEntries(first.people.matched.map((m) => [m.personId, [m.accountId, m.by]]));
  assert.deepEqual(by, { p01: [dana.id, 'email'], p02: [rafael.id, 'email'], p03: [priya.id, 'linked Kea account'], p04: [marcus.id, 'email'] });
  assert.equal(first.people.added, 4);
  assert.equal(first.people.unmatched.length, 8);
  assert.ok(first.people.unmatched.some((u) => u.name === 'Elena Vasquez' && u.email === email('elena.vasquez')), 'names come out of the sealed vault');
  assert.deepEqual([first.positions.created, first.positions.matched], [3, 0]);
  assert.ok(first.shifts.imported > 50 && first.shifts.unassigned > 0);
  assert.ok(first.punches.imported > 0 && first.punches.notMatched > 0);
  assert.deepEqual(first.payPeriods.days, 14);
  // Nothing about pay came along.
  assert.equal(JSON.stringify(first).includes('rate'), false);
});

test('their roles: owner, manager, and the server’s payroll role as its own role', async () => {
  const role = async (u) => H.ok(await H.call('GET', O(''), u.token)).me;
  assert.equal((await role(dana)).role, 'owner');
  assert.equal((await role(rafael)).role, 'manager');
  const p = await role(priya);
  assert.deepEqual(p.roles.map((r) => r.name).sort(), ['Member', 'Payroll']);
  assert.ok(p.abilities.includes('timecards.approve') && !p.abilities.includes('schedule.edit'));
  assert.equal((await role(marcus)).role, 'member');
  assert.equal((await role(boss)).role, 'owner', 'the org’s own owner is still there');
  assert.ok(H.ok(await H.call('GET', O('/my-shifts?from=2026-11-01T00:00:00Z'), marcus.token)).shifts.length > 0);
});

test('timecards come out the same as on the org server', async () => {
  const app = createApp({ dbFile: serverDb, log: false, devKeyFile: true, demo: true, now: () => NOW });
  const base = `http://127.0.0.1:${await app.listen(0)}`;
  try {
    const tok = (await (await fetch(base + '/v1/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: 'p04' }) })).json()).token;
    const me = await (await fetch(base + '/v1/me', { headers: { authorization: `Bearer ${tok}` } })).json();
    const ps = me.period.lastCompleted.start;
    const there = await (await fetch(base + `/v1/timecards?periodStart=${ps}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    const here = H.ok(await H.call('GET', O(`/timecards?periodStart=${ps}`), marcus.token));
    assert.ok(there.totals.workedMin > 0);
    assert.deepEqual(here.totals, there.totals);
    assert.deepEqual(here.period, there.period);
    assert.deepEqual(here.flags.map((f) => f.code), there.flags.map((f) => f.code));
  } finally { await app.close(); }
});

test('running it again brings in nothing twice; a person matched later comes in with their punches', async () => {
  const before = counts();
  const again = runImport({ hubData: H.dir, server: serverDb, org: org.id });
  assert.deepEqual(counts(), before);
  assert.deepEqual([again.people.added, again.people.alreadyMembers, again.shifts.imported, again.punches.imported], [0, 4, 0, 0]);
  assert.equal(again.punches.already, first.punches.imported);
  const elena = await H.person(email('elena.vasquez'), 'Elena V');
  const third = runImport({ hubData: H.dir, server: serverDb, org: org.id });
  assert.equal(third.people.added, 1);
  assert.ok(third.punches.imported > 0);
  assert.ok(H.ok(await H.call('GET', O('/my-shifts?from=2026-11-01T00:00:00Z'), elena.token)).shifts.length > 0, 'her shifts are hers now');
});

test('the import needs the vault’s passphrase and a real organization', () => {
  assert.throws(() => runImport({ hubData: H.dir, server: serverDb, org: 'nope' }), /isn’t on this server/);
  const key = readFileSync(serverDb + '.vaultkey', 'utf8');
  assert.ok(key.length > 10);
  assert.throws(() => runImport({ hubData: H.dir, server: serverDb + '.missing', org: org.id }), /--server/);
  const src = openDb(serverDb);
  assert.equal(makeVault(src).initialized(), true);
  src.close();
});
