// A KeaS 0.5 Kea Hub data folder (test/fixtures/hub-0.5.0-orgs.sql, made by 0.5.0's code) under KeaS 0.6:
//   - while its accounts haven't moved to KeaC, it is still the Kea Hub: the same sign-in as 0.5, nothing of the Hub's
//     touched, and the status line says so;
//   - after moved-to-keac.json, keas.db is made from a copy (hub.db, the signing key and storage stay byte for byte),
//     the old Hub's key is trusted as KeaC's when the marker names its kid, and members sign in with passes under
//     the ids they had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openServer, folderState, writeMarker, LEGACY_MESSAGE } from '../../hub/index.mjs';
import { readMarker, upgradeHub05 } from '../../hub/upgrade.mjs';
import { ownerFetch } from '../../hub/lib/ownerauth.mjs';
import { keyFromPem } from '../../hub/lib/tokens.mjs';
import { signWith, fakeKeac } from '../helpers/keac.mjs';
import { newKeyPem } from '../helpers/pem.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hub-0.5.0-orgs.sql');
const ORG = '4c7bf4bc-c90a-4b73-9e02-29b451f29508';
const PW = 'lantern velvet orbit';
const hashOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A 0.5 data folder: hub.db from the fixture, the Hub's signing key, the owner key and a personal file. */
function hubFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'keas-upgrade-'));
  const db = new DatabaseSync(join(dir, 'hub.db'));
  db.exec(readFileSync(FIXTURE, 'utf8'));
  db.close();
  writeFileSync(join(dir, 'hub-signing-key.pem'), newKeyPem());
  writeFileSync(join(dir, 'owner.key'), 'ab'.repeat(32));
  mkdirSync(join(dir, 'storage', 'acct'), { recursive: true });
  writeFileSync(join(dir, 'storage', 'acct', 'blob1'), 'a personal file');
  return dir;
}
const call = async (base, method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('accounts not moved yet: KeaS 0.6 is still the Kea Hub, with 0.5 sign-in, and says so', async () => {
  const dir = hubFolder();
  const before = hashOf(join(dir, 'hub-signing-key.pem'));
  try {
    assert.equal(folderState(dir), 'legacy');
    const hub = await openServer({ dataDir: dir, log: false, minFreeBytes: 0 });
    try {
      assert.equal(hub.mode, 'legacy');
      assert.equal(hub.status, LEGACY_MESSAGE);
      assert.match(LEGACY_MESSAGE, /Your Kea accounts are still here\. Move them to your Kea account server/);
      const p = await hub.listen({ port: 0, ownerPort: 0 });
      const base = `http://127.0.0.1:${p.port}`;
      assert.equal((await call(base, 'GET', '/v1/health')).body.service, 'kea-hub');
      const r = await call(base, 'POST', '/v1/auth/login', null, { email: 'ana@old.org', password: PW });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await call(base, 'GET', '/v1/me', r.body.token)).body.account.email, 'ana@old.org');
      assert.equal((await call(base, 'POST', '/v1/auth/login', null, { email: 'ana@old.org', password: 'wrong one here' })).status, 401);
      const orgs = (await call(base, 'GET', '/v1/orgs', r.body.token)).body.orgs;
      assert.equal(orgs[0].id, ORG, 'organizations work as before');
    } finally { await hub.close(); }
    assert.equal(existsSync(join(dir, 'keas.db')), false, 'no KeaS database yet');
    assert.equal(hashOf(join(dir, 'hub-signing-key.pem')), before);
    assert.equal(upgradeHub05(dir), null, 'no upgrade without the marker');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after the move: keas.db from a copy, the Hub’s files untouched, its key trusted as KeaC’s, passes under the old ids', async () => {
  const dir = hubFolder();
  try {
    const hubKey = keyFromPem(readFileSync(join(dir, 'hub-signing-key.pem')));
    // A bad marker isn't one.
    writeFileSync(join(dir, 'moved-to-keac.json'), '{"keacUrl":"https://x"}');
    assert.equal(readMarker(dir), null);
    assert.equal(folderState(dir), 'legacy');
    // What KeaC writes after its migration: { at, keacUrl, keacKeyKid }.
    const keac = await fakeKeac();
    keac.st.keys = [{ privateKey: hubKey.privateKey, kid: hubKey.kid, jwk: { ...hubKey.jwk }, status: 'current' }];
    writeMarker(dir, { at: Date.UTC(2026, 10, 8, 9), keacUrl: keac.url, keacKeyKid: hubKey.kid });
    assert.deepEqual(readMarker(dir), { at: Date.UTC(2026, 10, 8, 9), keacUrl: keac.url, keacKeyKid: hubKey.kid });
    assert.equal(folderState(dir), 'moved');
    const sums = Object.fromEntries(['hub.db', 'hub-signing-key.pem', join('storage', 'acct', 'blob1')].map((f) => [f, hashOf(join(dir, f))]));
    const hub = await openServer({ dataDir: dir, log: false, minFreeBytes: 0 });
    try {
      assert.equal(hub.mode, 'keas');
      const r = hub.upgraded;
      assert.ok(r && existsSync(r.file) && existsSync(join(dir, 'keas-0.5-archive', 'hub.db')));
      assert.equal(r.keac.pinned, true);
      assert.equal(r.operator, null, 'the fixture Hub had no owner account: the server is set up from the KeaS app');
      assert.ok(hub.setupSecret, 'so it has a setup code');
      assert.equal(r.members, 6);
      assert.ok(r.left.accounts === 6 && r.left.terms_versions === 1, 'the account side is listed as left in hub.db');
      for (const [f, h] of Object.entries(sums)) assert.equal(hashOf(join(dir, f)), h, `${f} is untouched`);
      const live = hub.h;
      assert.equal(live.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'accounts'"), undefined, 'keas.db has no accounts');
      assert.equal(live.get('SELECT COUNT(*) AS n FROM org_members').n, 6);
      assert.deepEqual(live.db.prepare('PRAGMA foreign_key_check').all(), []);
      // The archive copy still has every account (for KeaC, or for looking back).
      const arch = new DatabaseSync(join(dir, 'keas-0.5-archive', 'hub.db'), { readOnly: true });
      assert.equal(arch.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 6);
      arch.close();
      const p = await hub.listen({ port: 0, ownerPort: 0 });
      const base = `http://127.0.0.1:${p.port}`;
      assert.equal((await call(base, 'POST', '/v1/auth/login', null, { email: 'ana@old.org', password: PW })).status, 404, 'no more Hub sign-in');
      // Ana's pass from KeaC (signed with the key KeaC took over), for her old account id.
      const old = new DatabaseSync(join(dir, 'hub.db'), { readOnly: true });
      const ana = old.prepare("SELECT id FROM accounts WHERE email = 'ana@old.org'").get().id;
      old.close();
      const t = Math.floor(Date.now() / 1000);
      const pass = signWith(hubKey, { iss: 'kea', aud: `keas:${hub.serverId}`, sub: ana, email: 'ana@old.org', name: 'Ana', ev: true, iat: t, exp: t + 7 * 86400 });
      const s = await call(base, 'POST', '/v1/auth/pass', null, { pass });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const orgs = (await call(base, 'GET', '/v1/orgs', s.body.token)).body.orgs;
      assert.deepEqual([orgs[0].id, orgs[0].role], [ORG, 'member'], 'she is who she was');
      const stats = await (await ownerFetch(`http://127.0.0.1:${p.ownerPort}`, hub.ownerKey, 'GET', '/owner/stats')).json();
      assert.equal(stats.upgrade.members, 6);
      assert.equal(stats.keac.url, keac.url);
    } finally { await hub.close(); await keac.close(); }
    // Starting again: it's a KeaS server now, and nothing is upgraded twice.
    assert.equal(folderState(dir), 'keas');
    const again = await openServer({ dataDir: dir, log: false, minFreeBytes: 0, keacStart: false });
    assert.equal(again.upgraded, null);
    await again.close();
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('keas-0.5-archive')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after the move, with a marker naming another key: nothing is trusted until the owner confirms a fingerprint', async () => {
  const dir = hubFolder();
  const keac = await fakeKeac();
  try {
    writeMarker(dir, { keacUrl: keac.url, keacKeyKid: keac.key.kid });
    const hub = await openServer({ dataDir: dir, log: false, minFreeBytes: 0 });
    try {
      assert.equal(hub.upgraded.keac.pinned, false);
      const p = await hub.listen({ port: 0, ownerPort: 0 });
      const base = `http://127.0.0.1:${p.port}`, own = `http://127.0.0.1:${p.ownerPort}`;
      const pass = keac.pass({ serverId: hub.serverId, sub: 'acct-new-1', email: 'new@x.org' });
      await hub.keac.refreshKeys();
      assert.equal((await call(base, 'POST', '/v1/auth/pass', null, { pass })).status, 401, 'an unconfirmed key isn’t taken from the address alone');
      const offer = await (await ownerFetch(own, hub.ownerKey, 'GET', `/owner/keac/offer?url=${encodeURIComponent(keac.url)}`)).json();
      assert.equal(offer.suggested, keac.key.kid, 'the marker’s kid is the one suggested');
      const k = offer.keys.find((x) => x.kid === keac.key.kid);
      assert.match(k.fingerprint, /^([0-9A-F]{4} ){15}[0-9A-F]{4}$/);
      assert.equal((await ownerFetch(own, hub.ownerKey, 'POST', '/owner/keac/pin', { url: keac.url, kid: k.kid, fingerprint: '0000 1111' })).status, 409);
      assert.equal((await ownerFetch(own, hub.ownerKey, 'POST', '/owner/keac/pin', { url: keac.url, kid: k.kid, fingerprint: k.fingerprint })).status, 200);
      assert.equal((await call(base, 'POST', '/v1/auth/pass', null, { pass })).status, 200);
    } finally { await hub.close(); }
  } finally { await keac.close(); rmSync(dir, { recursive: true, force: true }); }
});
