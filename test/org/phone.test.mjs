// Phone numbers from passes: KeaC puts `phone` in a pass whenever the person shares it with anyone, with
// `phoneOrgs` and `phoneClassmates` saying who with; neither on, no phone claims. KeaS keeps what the newest pass says
// (a pass without them clears them), shows the number to the person themselves always, to people.view only with
// phoneOrgs, and in org class rosters only with phoneClassmates. Members without people.view never see others'.
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

/** Signs in with a pass carrying these extra claims (phone, phoneOrgs, phoneClassmates). */
async function signIn(u, extra = {}, o = {}) {
  const r = ok(await H.call('POST', '/v1/auth/pass', null, { pass: H.pass(u.id, u.email, u.name, { extra, ...o }) }, H.ip()));
  u.token = r.token;
  return u;
}
const share = (phone, orgs, classmates) => ({ phone, phoneOrgs: orgs, phoneClassmates: classmates });
const row = (id) => ({ ...H.hub.h.get('SELECT phone, phone_orgs AS o, phone_classmates AS c FROM keas_members WHERE id = ?', id) });

let boss, mgr, ana, ben, cy, dee, org;

test('a pass’s phone, phoneOrgs and phoneClassmates are stored on the member, and follow the newest pass', async () => {
  boss = await signIn({ id: randomUUID(), email: 'boss@phone.test', name: 'Boss' });
  mgr = await signIn({ id: randomUUID(), email: 'mgr@phone.test', name: 'Mona Manager' }, share('+15550001111', true, false));
  ana = await signIn({ id: randomUUID(), email: 'ana@phone.test', name: 'Ana' }, share('+15551234567', true, true));
  ben = await signIn({ id: randomUUID(), email: 'ben@phone.test', name: 'Ben' }, share('+15559876543', true, false));
  cy = await signIn({ id: randomUUID(), email: 'cy@phone.test', name: 'Cy' });
  // Classmates only, with an international number.
  dee = await signIn({ id: randomUUID(), email: 'dee@phone.test', name: 'Dee' }, share('+442079460958', false, true));
  assert.deepEqual(row(ana.id), { phone: '+15551234567', o: 1, c: 1 });
  assert.deepEqual(row(ben.id), { phone: '+15559876543', o: 1, c: 0 });
  assert.deepEqual(row(cy.id), { phone: null, o: 0, c: 0 });
  assert.deepEqual(row(dee.id), { phone: '+442079460958', o: 0, c: 1 });
  // A claim that isn't an E.164 number is ignored (the pass still works), and so are its switches; each switch must be
  // exactly true.
  for (const bad of ['555-1234', '+0123456789', '+1234567', '+1234567890123456', '442079460958']) {
    const odd = await signIn({ id: randomUUID(), email: `odd${Math.random()}@phone.test`, name: 'Odd' }, share(bad, true, true));
    assert.deepEqual(row(odd.id), { phone: null, o: 0, c: 0 }, bad);
  }
  const loose = await signIn({ id: randomUUID(), email: 'loose@phone.test', name: 'Loose' }, share('+15550002222', 'yes', 1));
  assert.deepEqual(row(loose.id), { phone: '+15550002222', o: 0, c: 0 });
  // Stopping sharing (a pass without the claims) clears all three; turning it back on brings them back.
  H.t.now += 1000;
  await signIn(ben, {});
  assert.deepEqual(row(ben.id), { phone: null, o: 0, c: 0 });
  H.t.now += 1000;
  await signIn(ben, share('+15559876543', true, false));
  assert.deepEqual(row(ben.id), { phone: '+15559876543', o: 1, c: 0 });
  // An older pass than the one already seen never changes them.
  await signIn(ben, {}, { iat: sec() - 3600, exp: sec() + 86400 });
  assert.deepEqual(row(ben.id), { phone: '+15559876543', o: 1, c: 0 });
});

test('member lists: the person always sees their own; people.view only with phoneOrgs; members never others’', async () => {
  org = await H.orgWith(boss, 'Phone Pool', [[mgr, 'manager'], [ana, 'member'], [ben, 'member'], [cy, 'member'], [dee, 'member']]);
  const list = async (u) => ok(await H.call('GET', `/v1/orgs/${org.id}/members`, u.token)).members;
  const asMgr = await list(mgr);
  assert.equal(asMgr.find((m) => m.id === ana.id).phone, '+15551234567');
  assert.equal(asMgr.find((m) => m.id === ben.id).phone, '+15559876543');
  assert.equal(asMgr.find((m) => m.id === dee.id).phone, undefined, 'classmates only: not to people.view');
  assert.equal('phone' in asMgr.find((m) => m.id === cy.id), false, 'no number, no phone field');
  const asOwner = await list(boss);
  assert.equal(asOwner.find((m) => m.id === mgr.id).phone, '+15550001111');
  assert.equal(asOwner.find((m) => m.id === dee.id).phone, undefined);
  // A member without people.view never sees anyone else's number.
  const asAna = await list(ana);
  for (const m of asAna.filter((x) => x.id !== ana.id)) assert.equal(m.phone, undefined, m.name);
  assert.equal(asAna.find((m) => m.id === ana.id).phone, '+15551234567', 'their own');
  assert.equal((await list(dee)).find((m) => m.id === dee.id).phone, '+442079460958', 'their own, even when not shared with organizations');
  // The member view the org page gives (me) and an update's answer follow the same rule.
  assert.equal(ok(await H.call('GET', `/v1/orgs/${org.id}`, dee.token)).me.phone, '+442079460958');
  assert.equal(ok(await H.call('POST', `/v1/orgs/${org.id}/members/${ben.id}`, mgr.token, { title: 'Guard' })).member.phone, '+15559876543');
  assert.equal(ok(await H.call('POST', `/v1/orgs/${org.id}/members/${dee.id}`, mgr.token, { title: 'Guard' })).member.phone, undefined);
  // Turning organizations off (phoneOrgs false) takes it out of the lists at the next pass.
  H.t.now += 1000;
  await signIn(ben, share('+15559876543', false, false));
  assert.equal((await list(mgr)).find((m) => m.id === ben.id).phone, undefined);
  H.t.now += 1000;
  await signIn(ben, share('+15559876543', true, false));
});

test('org class rosters show a phone only for people with phoneClassmates', async () => {
  const cls = ok(await H.call('POST', `/v1/orgs/${org.id}/classes`, mgr.token, { title: 'Water safety' }), 201).class;
  ok(await H.call('POST', `/v1/orgs/${org.id}/classes/${cls.id}/assign`, mgr.token, { accountIds: [ana.id, ben.id, cy.id, dee.id] }));
  const roster = ok(await H.call('GET', `/v1/orgs/${org.id}/classes`, mgr.token)).classes.find((c) => c.id === cls.id).assigned;
  assert.equal(roster.find((a) => a.accountId === ana.id).phone, '+15551234567');
  assert.equal(roster.find((a) => a.accountId === dee.id).phone, '+442079460958', 'classmates only is enough here');
  assert.equal(roster.find((a) => a.accountId === ben.id).phone, undefined, 'organizations only: not in the roster');
  assert.equal(roster.find((a) => a.accountId === cy.id).phone, undefined);
  // Members see no roster at all.
  assert.equal(ok(await H.call('GET', `/v1/orgs/${org.id}/classes`, ben.token)).classes[0].assigned, undefined);
});

test('an existing database gets the phone columns, its members kept (a number kept before phoneOrgs stays shared with organizations)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-phone-migrate-'));
  try {
    const file = join(dir, 'keas.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE keas_members (id TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_pass_at INTEGER NOT NULL, pass_iat INTEGER NOT NULL DEFAULT 0);
      INSERT INTO keas_members (id,email,name,first_seen,last_pass_at,pass_iat) VALUES ('acct-1','old@phone.test','Old Timer',1,2,3);`);
    old.close();
    let h = openDb(file);
    const cols = h.all('PRAGMA table_info(keas_members)').map((c) => c.name);
    assert.ok(['phone', 'phone_orgs', 'phone_classmates'].every((c) => cols.includes(c)));
    assert.deepEqual({ ...h.get('SELECT id, email, name, phone, phone_orgs, phone_classmates FROM keas_members') }, { id: 'acct-1', email: 'old@phone.test', name: 'Old Timer', phone: null, phone_orgs: 0, phone_classmates: 0 });
    h.close();
    // A database from the first phone release (phone and phone_classmates, no phone_orgs).
    const mid = new DatabaseSync(file);
    mid.exec("ALTER TABLE keas_members DROP COLUMN phone_orgs; INSERT INTO keas_members (id,email,name,first_seen,last_pass_at,pass_iat,phone,phone_classmates) VALUES ('acct-2','mid@phone.test','Mid',1,2,3,'+15550003333',1);");
    mid.close();
    h = openDb(file);
    assert.deepEqual(h.all('SELECT id, phone_orgs AS o, phone_classmates AS c FROM keas_members ORDER BY id').map((r) => [r.id, r.o, r.c]), [['acct-1', 0, 0], ['acct-2', 1, 1]]);
    h.close();
    // Opening it again changes nothing.
    openDb(file).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
