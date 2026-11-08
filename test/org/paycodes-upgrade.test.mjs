// The upgrade to pay codes (org schema 3): shifts and punches get a pay code column (old ones stay without one and are
// paid at the person's default), the Admin template gains the pay code abilities, and a host with no org data key
// still runs, just without pay codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateOrg, ORG_SCHEMA, mountOrg, staticIdentity, OrgHttpError } from '../../org/index.mjs';

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('a version 2 database: columns added, admins can manage pay codes, nothing else changes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(ORG_SCHEMA);
  // Made by the engine before pay codes: no pay_code_id, no triggers using it, schema 2, Admin without the abilities.
  for (const t of ['org_shifts_code_ins', 'org_shifts_code_acct']) db.exec(`DROP TRIGGER ${t}`);
  db.exec('ALTER TABLE org_shifts DROP COLUMN pay_code_id');
  db.exec('DROP TRIGGER org_punches_no_update');
  db.exec('ALTER TABLE org_punches DROP COLUMN pay_code_id');
  db.exec("CREATE TRIGGER org_punches_no_update BEFORE UPDATE ON org_punches BEGIN SELECT RAISE(ABORT, 'punches are append-only'); END;");
  db.exec("INSERT INTO org_meta (key,value) VALUES ('schema','2')");
  db.exec("INSERT INTO orgs (id,name,created_by,created_at,status) VALUES ('o1','Pool','a1',1,'active')");
  db.exec("INSERT INTO org_roles (id,org_id,name,abilities,template,template_key,created_at) VALUES ('r-admin','o1','Admin','[\"rates.view\",\"roles.assign\"]',1,'admin',1), ('r-own','o1','Owner','[]',1,'owner',1)");
  db.exec("INSERT INTO org_members (org_id,account_id,joined_at) VALUES ('o1','a1',1)");
  db.exec("INSERT INTO org_shifts (id,org_id,account_id,position_id,date,start_at,end_at,created_at) VALUES ('s1','o1','a1','p1','2026-12-01',10,20,1)");
  db.exec("INSERT INTO org_punches (id,org_id,account_id,type,at,source,created_at) VALUES ('pu1','o1','a1','in',10,'app',1)");
  assert.equal(cols(db, 'org_shifts').includes('pay_code_id'), false);

  migrateOrg(db, { now: 5 });
  assert.ok(cols(db, 'org_shifts').includes('pay_code_id') && cols(db, 'org_punches').includes('pay_code_id'));
  assert.equal(db.prepare("SELECT value FROM org_meta WHERE key = 'schema'").get().value, '3');
  const admin = JSON.parse(db.prepare("SELECT abilities FROM org_roles WHERE id = 'r-admin'").get().abilities);
  assert.deepEqual(admin.sort(), ['paycodes.assign', 'paycodes.manage', 'rates.view', 'roles.assign']);
  assert.equal(db.prepare("SELECT pay_code_id FROM org_shifts WHERE id = 's1'").get().pay_code_id, null, 'old shifts have no code (paid at the default)');
  assert.throws(() => db.exec('UPDATE org_punches SET at = 1'), /append-only/, 'still append-only');
  // Running it again changes nothing.
  migrateOrg(db, { now: 6 });
  assert.equal(JSON.parse(db.prepare("SELECT abilities FROM org_roles WHERE id = 'r-admin'").get().abilities).length, 4);
});

test('a host without an org data key: everything else works; pay codes say why they can’t be made', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const h = { db, get: (s, ...a) => db.prepare(s).get(...a), all: (s, ...a) => db.prepare(s).all(...a), run: (s, ...a) => db.prepare(s).run(...a), tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const routes = [];
  const R = (method, path, fn) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  mountOrg({ R, h, identity: staticIdentity([{ id: 'k1', name: 'Ola', email: 'o@x.org', emailVerified: true }]) });
  const call = (method, path, me, body = {}) => {
    const r = routes.find((x) => x.method === method && x.re.test(path));
    try { const out = r.fn({ me: { id: me }, params: { ...r.re.exec(path).groups }, body, query: {}, ip: 't' }); return out?.status && 'body' in out ? out.body : out; }
    catch (e) { if (e instanceof OrgHttpError) return { error: e.message, status: e.status }; throw e; }
  };
  const org = call('POST', '/v1/orgs', 'k1', { name: 'No Key Pool' }).org;
  const r = call('POST', `/v1/orgs/${org.id}/pay-codes`, 'k1', { name: 'Lifeguard', rate: 15 });
  assert.equal(r.status, 503);
  assert.match(r.error, /org data key/);
  assert.equal(call('GET', `/v1/orgs/${org.id}/pay-codes`, 'k1').hasKey, false);
  assert.ok(call('GET', `/v1/orgs/${org.id}/me/pay`, 'k1').period);
  assert.throws(() => mountOrg({ R: () => {}, h, identity: staticIdentity([]), dataKey: 'short' }), /32 bytes/);
});
