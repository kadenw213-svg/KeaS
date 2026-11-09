// KeaS 0.5 Kea Hub data folders, and moving one to a KeaS server (KeaS 0.6). Nothing here ever changes, moves or
// deletes the Hub's own files: hub.db, hub-signing-key.pem and storage/ stay exactly as they were.
//
// A 0.5 data folder holds every Kea account (hub.db: accounts, sessions, two-step codes, files...). Until those
// accounts have moved to KeaC (the Kea account server; KeaC server/migrate-from-hub.mjs reads this folder), KeaS 0.6
// keeps running the Kea Hub exactly as 0.5 did (hub/legacy/), so Kea keeps working. The folder says the move happened
// with a marker file, written by KeaC's migration or by the owner in the KeaS app:
//
//   moved-to-keac.json   { "at": <ms>, "keacUrl": <string or null>, "keacKeyKid": <string or null> }
//
// Then (upgradeHub05) KeaS makes its own database, keas.db, from a copy of hub.db: the organization side only (every
// orgs/org_* table, org classes with their members, sessions and invites, organization notices and audit entries, the
// 'orgs' setting), with references to the accounts table taken out of those tables' definitions. Organization members
// keep their ids (KeaC keeps the Hub's account ids), and their names and emails come along (keas_members) until each
// signs in again with a pass. The Hub's owner becomes the server's operator. A full copy of hub.db also goes to
// keas-0.5-archive/hub.db. keacUrl becomes the KeaC address; keacKeyKid, when it is the kid of this folder's own
// hub-signing-key.pem (KeaC took that key over to sign passes), pins that key as KeaC's without asking anyone.
// The report goes to keas-upgrade-report.json and the settings table ('upgrade.05'). hub.db is left for a later
// manual cleanup.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, isHub05 } from './db.mjs';
import { restrictFile } from './lib/secureFile.mjs';
import { keyFromPem } from './lib/tokens.mjs';

export const MARKER = 'moved-to-keac.json';
export const KEAS_DB = 'keas.db';
const ORG_SIDE = new Set(['classes', 'class_members', 'invites', 'class_sessions', 'notifications', 'audit', 'settings']);
const keptTable = (t) => t === 'orgs' || t.startsWith('org_') || ORG_SIDE.has(t) || t === 'sqlite_sequence';
const FK_ACCOUNTS = /\s+REFERENCES\s+"?accounts"?\s*\(\s*"?id"?\s*\)(\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gi;

/** The marker, checked: { at, keacUrl, keacKeyKid }, or null (missing or not one). */
export function readMarker(dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8'));
    if (!j || typeof j !== 'object' || typeof j.at !== 'number') return null;
    return {
      at: j.at,
      keacUrl: typeof j.keacUrl === 'string' && /^https?:\/\//.test(j.keacUrl) ? j.keacUrl.replace(/\/+$/, '') : null,
      keacKeyKid: typeof j.keacKeyKid === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(j.keacKeyKid) ? j.keacKeyKid : null,
    };
  } catch { return null; }
}
/** Writes the marker (the KeaS app, when the owner confirms the accounts moved). */
export function writeMarker(dataDir, { at = Date.now(), keacUrl = null, keacKeyKid = null } = {}) {
  const f = join(dataDir, MARKER);
  writeFileSync(f, JSON.stringify({ at, keacUrl, keacKeyKid }, null, 1));
  return f;
}
const hasAccounts = (file) => {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return isHub05(db); } finally { db.close(); }
};
/**
 * What a data folder is: 'keas' (a KeaS server: keas.db), 'legacy' (a 0.5 Hub whose accounts are still here), 'moved'
 * (a 0.5 Hub whose accounts moved; upgradeHub05 makes keas.db), or 'fresh'.
 */
export function folderState(dataDir) {
  if (existsSync(join(dataDir, KEAS_DB))) return 'keas';
  if (hasAccounts(join(dataDir, 'hub.db'))) return readMarker(dataDir) ? 'moved' : 'legacy';
  return 'fresh';
}
/** The folder's own Hub signing key (KeaC's current key after its migration): { kid, jwk }, or null. */
export function hubKeyOf(dataDir) {
  try { const k = keyFromPem(readFileSync(join(dataDir, 'hub-signing-key.pem'))); return { kid: k.kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: k.jwk.x, kid: k.kid } }; } catch { return null; }
}

/** Makes keas.db for a 'moved' folder (see the top). Returns the report, or null when the folder isn't one. */
export function upgradeHub05(dataDir, { now = Date.now() } = {}) {
  if (folderState(dataDir) !== 'moved') return null;
  const marker = readMarker(dataDir);
  const src = join(dataDir, 'hub.db');
  const report = { from: 'KeaS 0.5 (Kea Hub)', to: 'KeaS server', at: new Date(now).toISOString(), dataDir: resolve(dataDir), marker, archive: null, db: null, keac: null, operator: null, members: 0, kept: {}, left: {}, classes: { kept: 0, left: 0 }, notes: [] };
  let archive = join(dataDir, 'keas-0.5-archive');
  if (existsSync(join(archive, 'hub.db'))) archive = join(dataDir, `keas-0.5-archive-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(archive, { recursive: true });
  const archDb = join(archive, 'hub.db');
  const tmp = join(dataDir, `${KEAS_DB}.upgrading`);
  rmSync(tmp, { force: true });
  const s0 = new DatabaseSync(src, { readOnly: true });
  try {
    s0.exec('PRAGMA busy_timeout = 5000');
    s0.exec(`VACUUM INTO '${archDb.replace(/'/g, "''")}'`);
    s0.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally { s0.close(); }
  restrictFile(archDb);
  report.archive = { folder: resolve(archive), db: resolve(archDb), bytes: statSync(archDb).size };

  // Everything below works on the copy (keas.db.upgrading), never on hub.db.
  const db = new DatabaseSync(tmp);
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
    const has = (t) => tables.some((x) => x.name === t);
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    let rows = [];
    try {
      const owner = db.prepare("SELECT id, email, display_name FROM accounts WHERE role = 'owner' ORDER BY created_at LIMIT 1").get();
      // People the organizations know: members (and anyone who asked to join), creators, and the owner.
      const ids = new Set();
      if (has('org_members')) for (const r of db.prepare('SELECT DISTINCT account_id FROM org_members').all()) ids.add(r.account_id);
      if (has('orgs')) for (const r of db.prepare('SELECT DISTINCT created_by FROM orgs').all()) ids.add(r.created_by);
      if (owner) ids.add(owner.id);
      rows = db.prepare('SELECT id, email, display_name, created_at FROM accounts').all().filter((a) => ids.has(a.id));
      // Org classes only; the rest are personal (KeaC's now).
      if (has('classes')) {
        const hasOrgId = db.prepare('PRAGMA table_info(classes)').all().some((c) => c.name === 'org_id');
        const viaOrg = has('org_classes') ? 'id IN (SELECT class_id FROM org_classes)' : '0';
        const where = hasOrgId ? `org_id IS NOT NULL OR ${viaOrg}` : viaOrg;
        report.classes.kept = db.prepare(`SELECT COUNT(*) AS n FROM classes WHERE ${where}`).get().n;
        report.classes.left = count('classes') - report.classes.kept;
        db.exec(`DELETE FROM classes WHERE NOT (${where})`);
        for (const t of ['class_members', 'invites', 'class_sessions']) if (has(t)) db.exec(`DELETE FROM ${t} WHERE class_id NOT IN (SELECT id FROM classes)`);
        if (!hasOrgId) db.exec('ALTER TABLE classes ADD COLUMN org_id TEXT');
      }
      if (has('notifications')) db.exec("DELETE FROM notifications WHERE kind != 'org'");
      if (has('audit')) db.exec("DELETE FROM audit WHERE NOT (action LIKE 'org.%' OR action LIKE 'owner.org%')");
      if (has('settings')) db.exec("DELETE FROM settings WHERE key != 'orgs'");
      // Kept tables lose their references to accounts: each is made again from its own definition without them, with
      // its rows, indexes and triggers as they were.
      const fixes = tables.filter((t) => keptTable(t.name) && t.sql && new RegExp(FK_ACCOUNTS.source, 'i').test(t.sql));
      for (const t of fixes) {
        const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(t.name).map((r) => r.sql);
        db.exec(`CREATE TABLE "_keas_up_${t.name}" AS SELECT * FROM "${t.name}"`);
        db.exec(`DROP TABLE "${t.name}"`);
        db.exec(t.sql.replace(FK_ACCOUNTS, ''));
        db.exec(`INSERT INTO "${t.name}" SELECT * FROM "_keas_up_${t.name}"`);
        db.exec(`DROP TABLE "_keas_up_${t.name}"`);
        for (const x of extras) db.exec(x);
      }
      // The account side isn't part of keas.db (it stays in hub.db, and in the archive copy).
      const gone = tables.filter((t) => !keptTable(t.name));
      for (const t of gone) report.left[t.name] = count(t.name);
      for (const tr of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(?))").all(JSON.stringify(gone.map((t) => t.name)))) db.exec(`DROP TRIGGER IF EXISTS "${tr.name}"`);
      for (const t of gone) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
      db.exec(SCHEMA);
      const insMember = db.prepare('INSERT OR IGNORE INTO keas_members (id,email,name,first_seen,last_pass_at,pass_iat) VALUES (?,?,?,?,0,0)');
      for (const a of rows) insMember.run(a.id, a.email, a.display_name, a.created_at);
      report.members = rows.length;
      const put = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
      // KeaC: the address the marker names, and its key when it is this folder's own Hub signing key.
      const own = hubKeyOf(dataDir);
      report.keac = { url: marker.keacUrl, kid: marker.keacKeyKid, pinned: false };
      if (marker.keacUrl) put('keac.url', marker.keacUrl);
      if (own && marker.keacKeyKid && own.kid === marker.keacKeyKid) { put('keac.pinned', [{ ...own.jwk, status: 'current' }]); report.keac.pinned = true; }
      if (owner) { put('operator', owner.id); report.operator = { id: owner.id, email: owner.email }; }
      for (const t of tables.filter((x) => keptTable(x.name) && x.name !== 'sqlite_sequence')) report.kept[t.name] = count(t.name);
      report.notes.push(
        `The Kea Hub’s own files are untouched: ${resolve(src)}, hub-signing-key.pem and the storage folder stay as they were (remove them by hand once the Kea account server runs well). A copy of hub.db is also in ${report.archive.db}.`,
        `This KeaS server now uses ${KEAS_DB}, with the organizations, their members (${rows.length}), roles, schedules, time clock and pay codes.`,
        report.keac.pinned ? `The Kea account server’s key (kid ${own.kid}) is this folder’s own Hub signing key, so it is trusted without asking.` : 'The Kea account server’s key isn’t trusted yet: confirm its fingerprint in the KeaS app (Kea account server) before anyone can sign in.',
        'Organization members keep their Kea account ids and sign in again once with Kea (a pass from their Kea account).',
        owner ? `${owner.email} ran the Hub, so they run this KeaS server (they may make organizations).` : 'The Hub had no owner account, so nobody runs this server yet: set it up from the KeaS app on this PC.',
      );
      put('upgrade.05', report);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) report.notes.push(`${fk.length} rows refer to something that isn’t there (PRAGMA foreign_key_check); they were like that before.`);
  } catch (e) { db.close(); rmSync(tmp, { force: true }); throw e; }
  db.close();
  renameSync(tmp, join(dataDir, KEAS_DB));
  restrictFile(join(dataDir, KEAS_DB));
  report.db = resolve(join(dataDir, KEAS_DB));
  const file = join(dataDir, 'keas-upgrade-report.json');
  writeFileSync(file, JSON.stringify(report, null, 1));
  restrictFile(file);
  report.file = resolve(file);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { DATA_DIR } = await import('./db.mjs');
  const dir = process.argv[2] || DATA_DIR;
  const r = upgradeHub05(dir);
  if (!r) console.log(`${dir} is ${({ keas: 'a KeaS server already', legacy: `a Kea Hub whose accounts haven’t moved to KeaC yet (no ${MARKER})`, fresh: 'not a Kea Hub data folder', moved: 'a moved Kea Hub' })[folderState(dir)]}. Nothing to do.`);
  else { console.log(`Upgraded ${dir}.`); for (const n of r.notes) console.log(`- ${n}`); console.log(`Report: ${r.file}`); }
}
