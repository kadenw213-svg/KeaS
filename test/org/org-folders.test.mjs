// Shared work folders (org/folders.mjs) on a real KeaS server: access, the files themselves (raw GET/PUT/DELETE),
// versions, storage, Claude, the bin, notices, the upgrade to schema 4 and forgetting an account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHub } from './helpers.mjs';
import { migrateOrg, ORG_SCHEMA_VERSION, matchFolderFile } from '../../org/index.mjs';

const DAY = 86400_000;
let H;
before(async () => { H = await startHub({ clock: Date.UTC(2026, 10, 21, 16), prefix: 'keas-folders-test-' }); });
after(() => H.close());
const call = (...a) => H.call(...a);
const ok = (...a) => H.ok(...a);

/** A raw file call: GET returns the bytes as text. */
async function raw(method, org, fid, path, who, body, headers = {}) {
  const r = await fetch(`${H.base}/v1/orgs/${org}/folders/${fid}/files/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, headers: r.headers };
}

let boss, adm, mgr, ana, ben, cy, out, pool, other, roles, folder;
const F = (fid = folder.id) => `/v1/orgs/${pool.id}/folders/${fid}`;

test('setup: an org with an owner, an admin, a manager and members; and another org', async () => {
  [boss, adm, mgr, ana, ben, cy, out] = await Promise.all([
    H.person('boss@pool.org', 'Pat Boss'), H.person('adm@pool.org', 'Ada Admin'), H.person('mgr@pool.org', 'Max Manager'),
    H.person('ana@pool.org', 'Ana Ruiz'), H.person('ben@pool.org', 'Ben Ode'), H.person('cy@pool.org', 'Cy Lane'), H.person('out@camp.org', 'Out Sider'),
  ]);
  pool = await H.orgWith(boss, 'Westside Pool', [[adm, 'admin'], [mgr, 'manager'], [ana, 'member'], [ben, 'member'], [cy, 'member']]);
  other = await H.orgWith(out, 'Pine Hollow Camp');
  roles = Object.fromEntries(ok(await call('GET', `/v1/orgs/${pool.id}/roles`, boss.token)).roles.map((r) => [r.templateKey ?? r.name, r]));
  assert.ok(roles.admin.abilities.includes('folders.manage'), 'Admin has folders.manage');
  assert.ok(!roles.manager.abilities.includes('folders.manage'));
  // The server says it has folders.
  assert.ok(ok(await call('GET', '/v1/health')).features.includes('folders'));
  // Nothing yet.
  assert.deepEqual(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, ana.token)).folders, []);
});

test('three accounts: the owner shares edit with a role and view with a person; the editor uploads, the viewer only reads; Claude off for one file', async () => {
  const made = ok(await call('POST', `/v1/orgs/${pool.id}/folders`, boss.token, { name: 'Lesson plans' }), 201).folder;
  assert.deepEqual([made.access, made.claude, made.size, made.fileCount, made.orgId], ['manage', true, 0, 0, pool.id]);
  folder = made;
  const acc = ok(await call('PUT', `${F()}/access`, boss.token, { grants: [
    { kind: 'account', id: boss.id, access: 'manage' },
    { kind: 'role', id: roles.manager.id, access: 'edit' },
    { kind: 'account', id: ana.id, access: 'view' },
  ] }));
  assert.deepEqual(acc.grants.map((g) => [g.kind, g.id, g.access, g.name]), [
    ['role', roles.manager.id, 'edit', 'Manager'], ['account', ana.id, 'view', 'Ana Ruiz'], ['account', boss.id, 'manage', 'Pat Boss'],
  ]);
  assert.deepEqual(acc.alwaysManage.owners.map((o) => o.id), [boss.id]);
  assert.ok(acc.alwaysManage.roles.some((r) => r.id === roles.admin.id));

  // The editor (a manager, through the role) uploads.
  const up = await raw('PUT', pool.id, folder.id, 'Week 1/plan.txt', mgr, 'Swim drills');
  assert.equal(up.status, 201, up.text);
  assert.deepEqual([up.json.version, up.json.size, up.json.claude, up.headers.get('etag')], [1, 11, true, '"1"']);
  assert.equal((await raw('PUT', pool.id, folder.id, 'notes.txt', mgr, 'Bring towels')).status, 201);
  // The viewer downloads, but can't change anything.
  const got = await raw('GET', pool.id, folder.id, 'Week 1/plan.txt', ana);
  assert.deepEqual([got.status, got.text, got.headers.get('etag'), got.headers.get('x-kea-claude')], [200, 'Swim drills', '"1"', '1']);
  assert.match(got.headers.get('x-kea-sha256'), /^[0-9a-f]{64}$/);
  const refused = await raw('PUT', pool.id, folder.id, 'Week 1/plan.txt', ana, 'mine now', { 'if-match': '"1"' });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /only view/);
  assert.equal((await raw('DELETE', pool.id, folder.id, 'notes.txt', ana)).status, 403);
  // The owner turns Claude off for one file; the listing says so.
  const set = ok(await call('PATCH', `${F()}/files/claude`, boss.token, { path: 'notes.txt', claude: false }));
  assert.deepEqual([set.file.claude, set.file.claudeOverride], [false, false]);
  const list = ok(await call('GET', `${F()}/files`, ana.token));
  const by = Object.fromEntries(list.files.map((f) => [f.path, f]));
  assert.deepEqual([by['notes.txt'].claude, by['Week 1/plan.txt'].claude, by['Week 1/plan.txt'].claudeOverride], [false, true, null]);
  assert.deepEqual([by['Week 1/plan.txt'].updatedBy, by['Week 1/plan.txt'].updatedByName, by['Week 1/plan.txt'].version], [mgr.id, 'Max Manager', 1]);
  assert.equal(list.folder.access, 'view');
  assert.equal(typeof list.used, 'number'); assert.equal(typeof list.quota, 'number'); assert.equal(typeof list.now, 'number');
  // A viewer can't turn Claude on or off, or see who has access.
  assert.equal((await call('PATCH', `${F()}/files/claude`, ana.token, { path: 'notes.txt', claude: true })).status, 403);
  assert.equal((await call('GET', `${F()}/access`, ana.token)).status, 403);
  assert.equal((await call('GET', `${F()}/access`, mgr.token)).status, 403, 'edit is not manage');
  // The editor sees the folder with edit; the folder list counts the files.
  const f = ok(await call('GET', `/v1/orgs/${pool.id}/folders`, mgr.token)).folders.find((x) => x.id === folder.id);
  assert.deepEqual([f.access, f.fileCount, f.size], ['edit', 2, 23]);
});

test('the access matrix: person, role, org-wide, owner, folders.manage, removed member, another org', async () => {
  const seen = async (u) => { const r = await call('GET', `/v1/orgs/${pool.id}/folders`, u.token); return r.status === 200 ? (r.body.folders.find((x) => x.id === folder.id)?.access ?? null) : r.status; };
  assert.equal(await seen(boss), 'manage', 'owner');
  assert.equal(await seen(adm), 'manage', 'folders.manage (Admin)');
  assert.equal(await seen(mgr), 'edit', 'role grant');
  assert.equal(await seen(ana), 'view', 'person grant');
  assert.equal(await seen(ben), null, 'no grant: not listed');
  assert.equal((await raw('GET', pool.id, folder.id, 'notes.txt', ben)).status, 404, 'a folder you can’t see isn’t there');
  assert.equal(await seen(out), 404, 'another org: the org isn’t there');
  assert.equal((await raw('GET', pool.id, folder.id, 'notes.txt', out)).status, 404);
  assert.equal((await raw('GET', other.id, folder.id, 'notes.txt', out)).status, 404, 'the folder isn’t in their org');
  assert.equal((await raw('GET', pool.id, folder.id, 'notes.txt', null)).status, 401);
  // Org-wide view, and the highest grant wins (Ana: view as a person, edit for everyone).
  ok(await call('PUT', `${F()}/access`, adm.token, { grants: [
    { kind: 'account', id: boss.id, access: 'manage' }, { kind: 'role', id: roles.manager.id, access: 'edit' }, { kind: 'account', id: ana.id, access: 'view' },
    { kind: 'org', access: 'view' }, { kind: 'account', id: cy.id, access: 'edit' },
  ] }));
  assert.equal(await seen(ben), 'view', 'org-wide grant');
  assert.equal(await seen(cy), 'edit');
  assert.equal((await raw('PUT', pool.id, folder.id, 'cy.txt', cy, 'hi')).status, 201);
  // A removed member gets nothing, whatever their grant says (and the grant list can be sent back as it came).
  ok(await call('POST', `/v1/orgs/${pool.id}/members/${cy.id}/remove`, boss.token, {}));
  assert.equal(await seen(cy), 404);
  assert.equal((await raw('GET', pool.id, folder.id, 'cy.txt', cy)).status, 404);
  assert.equal((await raw('PUT', pool.id, folder.id, 'cy.txt', cy, 'again', { 'if-match': '"1"' })).status, 404);
  const back = ok(await call('GET', `${F()}/access`, boss.token)).grants;
  assert.equal(back.find((g) => g.id === cy.id).member, false);
  ok(await call('PUT', `${F()}/access`, boss.token, { grants: back.map(({ kind, id, access }) => ({ kind, id, access })) }));
  assert.equal((await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'account', id: out.id, access: 'view' }, { kind: 'org', access: 'manage' }] })).status, 400, 'someone from another org');
  assert.equal((await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'role', id: 'nope', access: 'view' }, { kind: 'org', access: 'manage' }] })).status, 404);
  assert.equal((await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'org', access: 'admin' }] })).status, 400);
  // Managers (not editors) change access; a member can't make a folder... until the org lets anyone (the default).
  assert.equal((await call('PUT', `${F()}/access`, mgr.token, { grants: [{ kind: 'org', access: 'manage' }] })).status, 403);
  ok(await call('POST', `/v1/orgs/${pool.id}`, boss.token, { settings: { folders: { anyoneCreates: false } } }));
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders`, ben.token, { name: 'Ben’s' })).status, 403);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, ben.token)).canCreate, false);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, adm.token)).canCreate, true);
  ok(await call('POST', `/v1/orgs/${pool.id}`, boss.token, { settings: { folders: { anyoneCreates: true } } }));
  const bens = ok(await call('POST', `/v1/orgs/${pool.id}/folders`, ben.token, { name: 'Bens notes' }), 201).folder;
  assert.equal(bens.access, 'manage', 'the creator manages it');
  assert.equal(await seen(ana), 'view');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, ana.token)).folders.some((x) => x.id === bens.id), false, 'not shared with Ana');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, boss.token)).folders.find((x) => x.id === bens.id).access, 'manage', 'owners manage every folder');
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders`, ben.token, { name: 'bens NOTES' })).status, 409, 'names are unique');
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders`, ben.token, { name: 'a/b' })).status, 400);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders`, ben.token, { name: 'CON' })).status, 400);
});

test('paths: .., absolute paths, reserved and device names are refused', async () => {
  const put = (p) => fetch(`${H.base}/v1/orgs/${pool.id}/folders/${folder.id}/files/${p}`, { method: 'PUT', headers: { authorization: `Bearer ${mgr.token}` }, body: 'x' }).then((r) => r.status);
  for (const p of ['..%2Fescape.txt', 'a/..%2Fb.txt', '%2Fetc%2Fpasswd', 'C%3A%5Cwin.txt', 'a//b.txt', 'CON', 'nul.txt', '.kea-project.json', 'sub/.kea-state', 'bad%00name', 'trail%20', '~2f~x.txt', 'a%5Cb.txt'])
    assert.equal(await put(p), 400, p);
  assert.equal(matchFolderFile('GET', '/v1/orgs/o/folders/f/files'), null, 'the listing is a JSON route');
  assert.equal(matchFolderFile('GET', '/v1/orgs/o/folders/f/files/%E0%A4%A').path, null, 'a path that doesn’t decode');
  assert.equal(matchFolderFile('PATCH', '/v1/orgs/o/folders/f/files/claude'), null, 'PATCH …/files/claude is a JSON route');
  assert.equal((await fetch(`${H.base}/v1/orgs/${pool.id}/folders/${folder.id}/files/%E0%A4%A`, { headers: { authorization: `Bearer ${mgr.token}` } })).status, 400);
  assert.equal(await put('ok%20name%20(1).txt'), 201);
});

test('versions: If-Match conflicts (412), If-None-Match (304 and create-only), DELETE with a version', async () => {
  const a = await raw('PUT', pool.id, folder.id, 'v.txt', mgr, 'one');
  assert.equal(a.status, 201);
  const b = await raw('PUT', pool.id, folder.id, 'v.txt', boss, 'two', { 'if-match': '"1"' });
  assert.deepEqual([b.status, b.json.version], [200, 2]);
  const late = await raw('PUT', pool.id, folder.id, 'v.txt', mgr, 'three', { 'if-match': '"1"' });
  assert.equal(late.status, 412);
  assert.equal(late.json.error, 'This file was changed on another device. Get the newest copy first.');
  assert.equal(late.json.version, 2);
  assert.equal((await raw('PUT', pool.id, folder.id, 'v.txt', mgr, 'new', { 'if-none-match': '*' })).status, 412, 'create-only on a file that exists');
  assert.equal((await raw('PUT', pool.id, folder.id, 'w.txt', mgr, 'new', { 'if-match': '*' })).status, 412, 'replace-only on a file that doesn’t');
  assert.equal((await raw('GET', pool.id, folder.id, 'v.txt', ana, undefined, { 'if-none-match': '"2"' })).status, 304);
  assert.equal((await raw('GET', pool.id, folder.id, 'v.txt', ana)).text, 'two');
  assert.equal((await raw('DELETE', pool.id, folder.id, 'v.txt', mgr, undefined, { 'if-match': '"1"' })).status, 412);
  assert.equal((await raw('DELETE', pool.id, folder.id, 'v.txt', mgr, undefined, { 'if-match': '"2"' })).status, 200);
  assert.equal((await raw('GET', pool.id, folder.id, 'v.txt', ana)).status, 404);
  assert.equal((await raw('DELETE', pool.id, folder.id, 'v.txt', mgr)).status, 404);
  // ?since= lists only what changed after then.
  const t = H.t.now;
  H.t.now += 1000;
  ok(await raw('PUT', pool.id, folder.id, 'later.txt', mgr, 'later').then((r) => ({ status: r.status, body: r.json })), 201);
  assert.deepEqual(ok(await call('GET', `${F()}/files?since=${t}`, ana.token)).files.map((f) => f.path), ['later.txt']);
  const page = ok(await call('GET', `${F()}/files?limit=2`, ana.token));
  assert.equal(page.files.length, 2);
  assert.equal(page.next, page.files[1].path);
});

test('storage: the owner sets sharedFilesGb; full gives 507; replacing with something no bigger still works', async () => {
  assert.equal((await call('POST', `/v1/orgs/${pool.id}`, adm.token, { settings: { sharedFilesGb: 1 } })).status, 403, 'only an owner');
  const used = ok(await call('GET', `${F()}/files`, boss.token)).used;
  assert.ok(used > 0);
  ok(await call('POST', `/v1/orgs/${pool.id}`, boss.token, { settings: { sharedFilesGb: Math.ceil(((used + 10) / 1024 ** 3) * 1e6) / 1e6 } }));
  const lim = ok(await call('GET', `${F()}/files`, boss.token)).quota;
  assert.ok(lim >= used + 10 && lim <= used + 1100, `${lim} vs ${used}`);
  const full = await raw('PUT', pool.id, folder.id, 'big.txt', mgr, 'x'.repeat(5000));
  assert.equal(full.status, 507);
  assert.equal(full.json.storageFull, true);
  assert.match(full.json.error, /Westside Pool’s shared folders are full/);
  assert.equal((await raw('PUT', pool.id, folder.id, 'later.txt', mgr, 'lat', { 'if-match': '"1"' })).status, 200, 'smaller fits');
  ok(await call('POST', `/v1/orgs/${pool.id}`, boss.token, { settings: { sharedFilesGb: 5 } }));
  assert.equal((await raw('PUT', pool.id, folder.id, 'big.txt', mgr, 'x'.repeat(100))).status, 201);
});

test('the last manager can’t be removed', async () => {
  const r = await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'org', access: 'edit' }, { kind: 'account', id: ana.id, access: 'view' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least one person or role who manages it/);
  assert.equal((await call('PUT', `${F()}/access`, boss.token, { grants: [] })).status, 400);
  // Handing it to a role is fine.
  ok(await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'role', id: roles.manager.id, access: 'manage' }, { kind: 'account', id: ana.id, access: 'view' }] }));
  assert.equal(ok(await call('GET', `${F()}/access`, mgr.token)).grants.length, 2, 'the manager role manages it now');
});

test('Claude: the folder’s switch, each file’s override, and who may change them', async () => {
  const files = async () => Object.fromEntries(ok(await call('GET', `${F()}/files`, ana.token)).files.map((f) => [f.path, f.claude]));
  ok(await call('PATCH', `${F()}/files/claude`, mgr.token, { path: 'later.txt', claude: true }));
  ok(await call('PATCH', F(), mgr.token, { claude: false }));
  let c = await files();
  assert.deepEqual([c['notes.txt'], c['later.txt'], c['Week 1/plan.txt']], [false, true, false], 'off for the folder: only the file turned on stays on');
  assert.equal((await raw('GET', pool.id, folder.id, 'Week 1/plan.txt', ana)).status, 200, 'still downloadable');
  assert.equal((await raw('GET', pool.id, folder.id, 'Week 1/plan.txt', ana)).headers.get('x-kea-claude'), '0');
  ok(await call('PATCH', F(), mgr.token, { claude: true }));
  ok(await call('PATCH', `${F()}/files/claude`, mgr.token, { path: 'notes.txt', claude: null }));
  c = await files();
  assert.deepEqual([c['notes.txt'], c['later.txt'], c['Week 1/plan.txt']], [true, true, true]);
  assert.equal((await call('PATCH', `${F()}/files/claude`, mgr.token, { path: 'nope.txt', claude: false })).status, 404);
  assert.equal((await call('PATCH', `${F()}/files/claude`, mgr.token, { path: 'notes.txt', claude: 'no' })).status, 400);
  assert.equal((await call('PATCH', F(), ana.token, { claude: false })).status, 403);
  // An upload keeps a file's override.
  ok(await call('PATCH', `${F()}/files/claude`, mgr.token, { path: 'notes.txt', claude: false }));
  const v = ok(await call('GET', `${F()}/files`, ana.token)).files.find((f) => f.path === 'notes.txt').version;
  const up = await raw('PUT', pool.id, folder.id, 'notes.txt', mgr, 'Bring two towels', { 'if-match': `"${v}"` });
  assert.equal(up.json.claude, false);
  // Rename.
  assert.equal(ok(await call('PATCH', F(), mgr.token, { name: 'Lesson plans 2027' })).folder.name, 'Lesson plans 2027');
  const audit = H.hub.h.all("SELECT action FROM audit WHERE target = ? AND action LIKE 'folder.%'", folder.id).map((r) => r.action);
  for (const a of ['folder.create', 'folder.access', 'folder.file_claude', 'folder.claude', 'folder.rename']) assert.ok(audit.includes(a), a);
});

test('notices: people who can see the folder hear about new files, at most once an hour per folder', async () => {
  const notes = async (u) => ok(await call('GET', '/v1/me/notifications', u.token)).notifications.filter((n) => n.kind === 'folder' && n.data?.folderId === folder.id);
  const before = (await notes(ana)).length;
  assert.ok(before >= 1, 'Ana heard about the first upload');
  assert.equal((await notes(mgr)).length, 0, 'not for your own upload');
  assert.equal((await notes(ben)).length, 0, 'Ben can’t see this folder now');
  assert.equal((await raw('PUT', pool.id, folder.id, 'n1.txt', mgr, 'a')).status, 201);
  assert.equal((await notes(ana)).length, before, 'within the hour: no new notice');
  H.t.now += 3601_000;
  assert.equal((await raw('PUT', pool.id, folder.id, 'n2.txt', mgr, 'b')).status, 201);
  assert.equal((await notes(ana)).length, before + 1);
  assert.match((await notes(ana))[0].title, /New files in Lesson plans 2027/);
});

test('deleting a folder: into the bin, restorable by an owner, gone after 30 days', async () => {
  const bin = ok(await call('POST', `/v1/orgs/${pool.id}/folders`, mgr.token, { name: 'Old forms' }), 201).folder;
  assert.equal((await raw('PUT', pool.id, bin.id, 'form.txt', mgr, 'form')).status, 201);
  assert.equal((await call('DELETE', `/v1/orgs/${pool.id}/folders/${bin.id}`, ana.token)).status, 404, 'Ana can’t see it');
  const d = ok(await call('DELETE', `/v1/orgs/${pool.id}/folders/${bin.id}`, mgr.token));
  assert.equal(d.purgeAt - d.deletedAt, 30 * DAY);
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders`, mgr.token)).folders.some((f) => f.id === bin.id), false);
  assert.equal((await raw('GET', pool.id, bin.id, 'form.txt', mgr)).status, 404);
  assert.equal((await call('GET', `/v1/orgs/${pool.id}/folders?deleted=1`, adm.token)).status, 403, 'the bin is the owner’s');
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders?deleted=1`, boss.token)).folders.find((f) => f.id === bin.id).purgeAt, d.purgeAt);
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders/${bin.id}/restore`, mgr.token, {})).status, 403, 'restoring is for owners');
  // The name is free again while it's in the bin; restoring then needs it back.
  const again = ok(await call('POST', `/v1/orgs/${pool.id}/folders`, mgr.token, { name: 'Old forms' }), 201).folder;
  assert.equal((await call('POST', `/v1/orgs/${pool.id}/folders/${bin.id}/restore`, boss.token, {})).status, 409);
  ok(await call('PATCH', `/v1/orgs/${pool.id}/folders/${again.id}`, mgr.token, { name: 'Old forms (new)' }));
  const back = ok(await call('POST', `/v1/orgs/${pool.id}/folders/${bin.id}/restore`, boss.token, {})).folder;
  assert.deepEqual([back.name, back.fileCount, back.deletedAt], ['Old forms', 1, undefined]);
  assert.equal((await raw('GET', pool.id, bin.id, 'form.txt', mgr)).text, 'form');
  // Deleted again and left 31 days: gone, files and all.
  ok(await call('DELETE', `/v1/orgs/${pool.id}/folders/${bin.id}`, mgr.token));
  const blob = H.hub.h.get('SELECT blob FROM org_folder_files WHERE folder_id = ?', bin.id).blob;
  const dirs = readdirSync(join(H.dir, 'shared-folders'));
  assert.ok(dirs.some((d2) => existsSync(join(H.dir, 'shared-folders', d2, blob))));
  H.t.now += 31 * DAY;
  // (Sessions last 30 days: sign in again.)
  boss = await H.signIn(boss.id, boss.email, boss.name);
  for (const u of [adm, mgr, ana, ben]) Object.assign(u, await H.signIn(u.id, u.email, u.name));
  assert.equal(ok(await call('GET', `/v1/orgs/${pool.id}/folders?deleted=1`, boss.token)).folders.some((f) => f.id === bin.id), false);
  assert.equal(H.hub.h.get('SELECT COUNT(*) AS n FROM org_folder_files WHERE folder_id = ?', bin.id).n, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!dirs.some((d2) => existsSync(join(H.dir, 'shared-folders', d2, blob))), 'the blob went too');
  assert.ok(H.hub.h.all("SELECT action FROM audit WHERE target = ?", bin.id).some((r) => r.action === 'folder.delete'));
});

test('forgetting an account: its grants go, its name leaves the files it changed', async () => {
  ok(await call('PUT', `${F()}/access`, boss.token, { grants: [{ kind: 'role', id: roles.manager.id, access: 'manage' }, { kind: 'account', id: ana.id, access: 'view' }, { kind: 'account', id: ben.id, access: 'edit' }] }));
  assert.equal((await raw('PUT', pool.id, folder.id, 'ben.txt', ben, 'ben')).status, 201);
  ok(await call('POST', '/v1/me/leave-server', ben.token, { confirm: ben.email }));
  const h = H.hub.h;
  assert.equal(h.get("SELECT COUNT(*) AS n FROM org_folder_access WHERE subject_kind = 'account' AND subject_id = ?", ben.id).n, 0);
  assert.equal(h.get('SELECT updated_by FROM org_folder_files WHERE folder_id = ? AND path = ?', folder.id, 'ben.txt').updated_by, null);
  assert.equal(h.get('SELECT COUNT(*) AS n FROM org_folders WHERE created_by = ?', ben.id).n, 0);
  assert.equal(ok(await call('GET', `${F()}/files`, ana.token)).files.find((f) => f.path === 'ben.txt').updatedBy, null);
});

test('upgrading a schema 3 database: the folder tables arrive, Admin roles gain folders.manage, nothing else changes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateOrg(db, { now: 1 });
  // Make it look exactly like KeaS 0.9 left it: no folder tables, schema 3, Admin without folders.manage.
  db.exec('DROP TABLE org_folder_files; DROP TABLE org_folder_access; DROP TABLE org_folders');
  db.exec("UPDATE org_meta SET value = '3' WHERE key = 'schema'");
  db.exec("INSERT INTO orgs (id,name,created_by,created_at,status) VALUES ('o1','Pool','a1',1,'active')");
  migrateOrg(db, { now: 2 });
  db.exec("UPDATE org_meta SET value = '3' WHERE key = 'schema'");
  db.exec('DROP TABLE org_folder_files; DROP TABLE org_folder_access; DROP TABLE org_folders');
  const adminId = db.prepare("SELECT id FROM org_roles WHERE org_id = 'o1' AND template_key = 'admin'").get().id;
  const without = JSON.parse(db.prepare('SELECT abilities FROM org_roles WHERE id = ?').get(adminId).abilities).filter((a) => a !== 'folders.manage');
  db.prepare('UPDATE org_roles SET abilities = ? WHERE id = ?').run(JSON.stringify(without), adminId);
  db.exec("INSERT INTO org_roles (id,org_id,name,abilities,template,created_at) VALUES ('r-custom','o1','Front desk','[\"people.view\"]',0,1)");
  const report = migrateOrg(db, { now: 3 });
  assert.equal(report.to, ORG_SCHEMA_VERSION);
  assert.equal(ORG_SCHEMA_VERSION, 4);
  assert.equal(db.prepare("SELECT value FROM org_meta WHERE key = 'schema'").get().value, '4');
  for (const t of ['org_folders', 'org_folder_access', 'org_folder_files']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  assert.ok(JSON.parse(db.prepare('SELECT abilities FROM org_roles WHERE id = ?').get(adminId).abilities).includes('folders.manage'));
  assert.deepEqual(JSON.parse(db.prepare("SELECT abilities FROM org_roles WHERE id = 'r-custom'").get().abilities), ['people.view'], 'custom roles untouched');
  // Again: nothing changes.
  migrateOrg(db, { now: 4 });
  assert.equal(JSON.parse(db.prepare('SELECT abilities FROM org_roles WHERE id = ?').get(adminId).abilities).filter((a) => a === 'folders.manage').length, 1);
  db.close();
});
