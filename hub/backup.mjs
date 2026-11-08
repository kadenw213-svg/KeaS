// Encrypted KeaS server backups. A consistent snapshot of the database (VACUUM INTO) plus its keys, and optionally the
// KeaS payroll vault file, sealed with AES-256-GCM under a key derived from a recovery passphrase (scrypt). Safe to keep
// in OneDrive: without the passphrase it's unreadable. Keep the passphrase offline (printed, or in a password manager).
//
//   KEA_BACKUP_PASSPHRASE=... node hub/backup.mjs create <out-folder> [--payroll <payroll-vault.db>]
//   KEA_BACKUP_PASSPHRASE=... node hub/backup.mjs restore <file.keabak> <data-folder> [--payroll-dir <folder>]
//
// - The plaintext snapshot is written next to the database inside its (locked-down) folder, never the shared temp
//   folder, and is always deleted afterwards, even when something fails; any left over from a crash is removed at the
//   next backup.
// - Restored files are made readable by this Windows account only (hub/lib/secureFile.mjs).
// - The passphrase is normalized (Unicode NFC), so the same passphrase typed on another keyboard or system opens it.
// - The payroll vault (payroll-vault.db, in KeaS's Payroll folder) stays encrypted with its own passphrase inside the
//   backup; using a restored one needs that passphrase as well as this one.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { restrictFile } from './lib/secureFile.mjs';

const MAGIC = Buffer.from('KEABAK1\n');
const kdf = (pass, salt) => scryptSync(pass, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const nfc = (pass) => String(pass).normalize('NFC');

export function seal(plain, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kdf(nfc(pass), salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
export function open(sealed, pass) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Kea Hub backup.');
  let o = MAGIC.length;
  const salt = sealed.subarray(o, (o += 16)), iv = sealed.subarray(o, (o += 12)), tag = sealed.subarray(o, (o += 16));
  // (Backups made before passphrases were normalized used the passphrase exactly as typed.)
  for (const p of new Set([nfc(pass), String(pass)])) {
    const d = createDecipheriv('aes-256-gcm', kdf(p, salt), iv);
    d.setAuthTag(tag);
    try { return Buffer.concat([d.update(sealed.subarray(o)), d.final()]); } catch {}
  }
  throw new Error('Wrong passphrase, or the backup is damaged.');
}

/** One buffer: [4-byte length][json manifest][files...]. */
function pack(files) {
  const manifest = Buffer.from(JSON.stringify(Object.entries(files).map(([name, b]) => [name, b.length])));
  const len = Buffer.alloc(4); len.writeUInt32BE(manifest.length);
  return Buffer.concat([len, manifest, ...Object.values(files)]);
}
function unpack(buf) {
  const n = buf.readUInt32BE(0);
  const list = JSON.parse(buf.subarray(4, 4 + n));
  let o = 4 + n; const out = {};
  for (const [name, size] of list) { out[name] = buf.subarray(o, o + size); o += size; }
  return out;
}

const SNAP = /^\.backup-snap-[\w-]+\.db(-journal|-wal|-shm)?$/;
/** Removes plaintext snapshots a crashed backup left in a folder. Returns how many. */
export function removeLeftoverSnapshots(dir) {
  let n = 0;
  try { for (const f of readdirSync(dir)) if (SNAP.test(f)) { rmSync(join(dir, f), { force: true }); n++; } } catch {}
  return n;
}
/** A consistent copy of a SQLite database: VACUUM INTO a file next to it, read, then always deleted. */
export function snapshot(dbFile) {
  const dir = dirname(dbFile);
  removeLeftoverSnapshots(dir);
  const tmp = join(dir, `.backup-snap-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.db`);
  try {
    const db = new DatabaseSync(dbFile);
    try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
    return readFileSync(tmp);
  } finally {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  }
}

/** payrollDb: also back up the KeaS payroll vault (still encrypted with its own passphrase inside). */
export function createBackup(dataDir, outDir, pass, { payrollDb = null } = {}) {
  if (!pass || nfc(pass).length < 12) throw new Error('Use a recovery passphrase of at least 12 characters.');
  const dbs = ['keas.db', 'hub.db'].filter((f) => existsSync(join(dataDir, f)));
  if (!dbs.length) throw new Error(`${dataDir} has no keas.db or hub.db.`);
  if (payrollDb && !existsSync(payrollDb)) throw new Error(`There is no payroll vault at ${payrollDb}.`);
  // (keas.db: the KeaS server's; hub.db: a Kea Hub's, kept until it's cleaned up by hand after its accounts moved.)
  const files = Object.fromEntries(dbs.map((f) => [f, snapshot(join(dataDir, f))]));
  // The server's identity key (its server id), the org data key (pay code rates and stubs in hub.db only open with
  // it), and a KeaS 0.5 Hub's signing key if one is still there.
  for (const f of ['server-identity.pem', 'org-data.key', 'hub-signing-key.pem']) if (existsSync(join(dataDir, f))) files[f] = readFileSync(join(dataDir, f));
  if (payrollDb) files['payroll-vault.db'] = snapshot(payrollDb);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `keas-server-${new Date().toISOString().replace(/[:.]/g, '-')}.keabak`);
  writeFileSync(file, seal(pack(files), pass));
  return file;
}

/** Restores into an empty data folder. payrollDir: where the payroll vault goes (default: the data folder). */
export function restoreBackup(file, dataDir, pass, { payrollDir = null } = {}) {
  const files = unpack(open(readFileSync(file), pass));
  for (const f of ['keas.db', 'hub.db']) if (existsSync(join(dataDir, f))) throw new Error(`${dataDir} already has a ${f}. Restore into an empty folder.`);
  const where = (name) => (name === 'payroll-vault.db' && payrollDir ? payrollDir : dataDir);
  for (const name of Object.keys(files)) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Bad file name in backup.');
    if (existsSync(join(where(name), name))) throw new Error(`${join(where(name), name)} already exists. Restore into an empty folder.`);
  }
  const out = [];
  for (const [name, b] of Object.entries(files)) {
    const dir = where(name);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, name);
    writeFileSync(f, b, { mode: 0o600, flag: 'wx' });
    restrictFile(f); // this Windows account (and SYSTEM) only
    out.push(f);
  }
  return out;
}

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { DATA_DIR } = await import('./db.mjs');
  const args = process.argv.slice(2);
  const [cmd, a, b] = args;
  const pass = process.env.KEA_BACKUP_PASSPHRASE;
  if (cmd === 'create' && a) console.log('Backup written:', createBackup(DATA_DIR, a, pass, { payrollDb: flag(args, '--payroll') }));
  else if (cmd === 'restore' && a && b) console.log('Restored:', restoreBackup(a, b, pass, { payrollDir: flag(args, '--payroll-dir') }).join(', '));
  else console.log(`Usage (with KEA_BACKUP_PASSPHRASE set):
  create <out-folder> [--payroll <payroll-vault.db>]   (KeaS keeps the payroll vault in %APPDATA%\\KeaS\\Payroll)
  restore <file.keabak> <empty-data-folder> [--payroll-dir <folder for payroll-vault.db>]`);
}
