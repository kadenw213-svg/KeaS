// Phone numbers from passes: KeaC puts `phone` in a pass only when the person shares it with their organizations, and
// `phoneClassmates: true` only when they share it with classmates too. KeaS keeps what the newest pass says (a pass
// without them clears them), shows the number in member lists only to the person and to people.view, and in org class
// rosters only for someone with phoneClassmates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startHub } from './helpers.mjs';
import { openDb } from '../../hub/db.mjs';

let H;
before(async () => { H = await startHub({ prefix: 'keas-phone-' }); });
after(() => H.close());
const ok = (...a) => H.ok(...a);
const sec = () => Math.floor(H.t.now / 1000);

/** Signs in with a pass carrying these extra claims (phone, phoneClassmates). */
async function signIn(u, extra = {}, o = {}) {
  const r = ok(await H.call('POST', '/v1/auth/pass', null, { pass: H.pass(u.id, u.email, u.name, { extra, ...o }) }, H.ip()));
  u.token = r.token;
  return u;
}
const row = (id) => ({ ...H.hub.h.get('SELECT phone, phone_classmates FROM keas_members WHERE id = ?', id) });

let boss, mgr, ana, ben, cy, org;

test('a pass’s phone and phoneClassmates are stored on the member, and follow the newest pass', async () => {
  boss = await signIn({ id: randomUUID(), email: 'boss@phone.test', name: 'Boss' });
  mgr = await signIn({ id: randomUUID(), email: 'mgr@phone.test', name: 'Mona Manager' }, { phone: '+15550001111' });
  ana = await signIn({ id: randomUUID(), email: 'ana@phone.test', name: 'Ana' }, { phone: '+15551234567', phoneClassmates: true });
  ben = await signIn({ id: randomUUID(), email: 'ben@phone.test', name: 'Ben' }, { phone: '+15559876543' });
  cy = await signIn({ id: randomUUID(), email: 'cy@phone.test', name: 'Cy' });
  assert.deepEqual(row(ana.id), { phone: '+15551234567', phone_classmates: 1 });
  assert.deepEqual(row(ben.id), { phone: '+15559876543', phone_classmates: 0 });
  assert.deepEqual(row(cy.id), { phone: null, phone_classmates: 0 });
  // A claim that isn't an E.164 number is ignored (the pass still works); phoneClassmates must be exactly true.
  const odd = await signIn({ id: randomUUID(), email: 'odd@phone.test', name: 'Odd' }, { phone: '555-1234', phoneClassmates: 'yes' });
  assert.deepEqual(row(odd.id), { phone: null, phone_classmates: 0 });
  // Stopping sharing (a pass without the claims) clears both; turning it back on brings them back.
  H.t.now += 1000;
  await signIn(ben, {});
  assert.deepEqual(row(ben.id), { phone: null, phone_classmates: 0 });
  H.t.now += 1000;
  await signIn(ben, { phone: '+15559876543' });
  assert.deepEqual(row(ben.id), { phone: '+15559876543', phone_classmates: 0 });
  // An older pass than the one already seen never changes them.
  await signIn(ben, {}, { iat: sec() - 3600, exp: sec() + 86400 });
  assert.equal(row(ben.id).phone, '+15559876543');
});

test('member lists: the phone shows only to the person and to people.view', async () => {
  org = await H.orgWith(boss, 'Phone Pool', [[mgr, 'manager'], [ana, 'member'], [ben, 'member'], [cy, 'member']]);
  const list = async (u) => ok(await H.call('GET', `/v1/orgs/${org.id}/members`, u.token)).members;
  const asMgr = await list(mgr);
  assert.equal(asMgr.find((m) => m.id === ana.id).phone, '+15551234567');
  assert.equal(asMgr.find((m) => m.id === ben.id).phone, '+15559876543', 'orgs sharing alone is enough for people.view');
  assert.equal('phone' in asMgr.find((m) => m.id === cy.id), false, 'no number, no phone field');
  const asOwner = await list(boss);
  assert.equal(asOwner.find((m) => m.id === mgr.id).phone, '+15550001111');
  // A member without people.view never sees anyone else's number, not even a classmate-sharer's.
  const asAna = await list(ana);
  for (const m of asAna.filter((x) => x.id !== ana.id)) assert.equal(m.phone, undefined, m.name);
  assert.equal(asAna.find((m) => m.id === ana.id).phone, '+15551234567', 'their own');
  // The member view the org page gives (me) and an update's answer follow the same rule.
  assert.equal(ok(await H.call('GET', `/v1/orgs/${org.id}`, ana.token)).me.phone, '+15551234567');
  assert.equal(ok(await H.call('POST', `/v1/orgs/${org.id}/members/${ben.id}`, mgr.token, { title: 'Guard' })).member.phone, '+15559876543');
  // Stopping sharing takes it out of the lists at the next pass.
  H.t.now += 1000;
  await signIn(ben, {});
  assert.equal((await list(mgr)).find((m) => m.id === ben.id).phone, undefined);
  H.t.now += 1000;
  await signIn(ben, { phone: '+15559876543' });
});

test('org class rosters show a phone only for people who share it with classmates', async () => {
  const cls = ok(await H.call('POST', `/v1/orgs/${org.id}/classes`, mgr.token, { title: 'Water safety' }), 201).class;
  ok(await H.call('POST', `/v1/orgs/${org.id}/classes/${cls.id}/assign`, mgr.token, { accountIds: [ana.id, ben.id, cy.id] }));
  const roster = ok(await H.call('GET', `/v1/orgs/${org.id}/classes`, mgr.token)).classes.find((c) => c.id === cls.id).assigned;
  assert.equal(roster.find((a) => a.accountId === ana.id).phone, '+15551234567');
  assert.equal(roster.find((a) => a.accountId === ben.id).phone, undefined, 'orgs sharing only: not in the roster');
  assert.equal(roster.find((a) => a.accountId === cy.id).phone, undefined);
  // Members see no roster at all.
  assert.equal(ok(await H.call('GET', `/v1/orgs/${org.id}/classes`, ben.token)).classes[0].assigned, undefined);
});

test('an existing database gets the phone columns, its members kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-phone-migrate-'));
  try {
    const file = join(dir, 'keas.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE keas_members (id TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_pass_at INTEGER NOT NULL, pass_iat INTEGER NOT NULL DEFAULT 0);
      INSERT INTO keas_members (id,email,name,first_seen,last_pass_at,pass_iat) VALUES ('acct-1','old@phone.test','Old Timer',1,2,3);`);
    old.close();
    const h = openDb(file);
    const cols = h.all('PRAGMA table_info(keas_members)').map((c) => c.name);
    assert.ok(cols.includes('phone') && cols.includes('phone_classmates'));
    assert.deepEqual({ ...h.get('SELECT id, email, name, phone, phone_classmates FROM keas_members') }, { id: 'acct-1', email: 'old@phone.test', name: 'Old Timer', phone: null, phone_classmates: 0 });
    h.close();
    // Opening it again changes nothing.
    openDb(file).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
