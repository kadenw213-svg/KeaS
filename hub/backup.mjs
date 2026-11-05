// Encrypted Hub backups. A consistent snapshot of the database (VACUUM INTO) plus the signing key, sealed with
// AES-256-GCM under a key derived from a recovery passphrase (scrypt). Safe to keep in OneDrive: without the passphrase
// it's unreadable. Keep the passphrase offline (printed, or in a password manager).
//
//   KEA_BACKUP_PASSPHRASE=... node hub/backup.mjs create <out-folder>
//   KEA_BACKUP_PASSPHRASE=... node hub/backup.mjs restore <file.keabak> <data-folder>
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MAGIC = Buffer.from('KEABAK1\n');
const kdf = (pass, salt) => scryptSync(pass, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

export function seal(plain, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kdf(pass, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
export function open(sealed, pass) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Kea Hub backup.');
  let o = MAGIC.length;
  const salt = sealed.subarray(o, (o += 16)), iv = sealed.subarray(o, (o += 12)), tag = sealed.subarray(o, (o += 16));
  const d = createDecipheriv('aes-256-gcm', kdf(pass, salt), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(sealed.subarray(o)), d.final()]); } catch { throw new Error('Wrong passphrase, or the backup is damaged.'); }
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

export function createBackup(dataDir, outDir, pass) {
  if (!pass || pass.length < 12) throw new Error('Use a recovery passphrase of at least 12 characters.');
  const tmp = join(tmpdir(), `kea-hub-snap-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseSync(join(dataDir, 'hub.db'));
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  const files = { 'hub.db': readFileSync(tmp), 'hub-signing-key.pem': readFileSync(join(dataDir, 'hub-signing-key.pem')) };
  rmSync(tmp, { force: true });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `kea-hub-${new Date().toISOString().replace(/[:.]/g, '-')}.keabak`);
  writeFileSync(file, seal(pack(files), pass));
  return file;
}

export function restoreBackup(file, dataDir, pass) {
  const files = unpack(open(readFileSync(file), pass));
  if (existsSync(join(dataDir, 'hub.db'))) throw new Error(`${dataDir} already has a hub.db. Restore into an empty folder.`);
  mkdirSync(dataDir, { recursive: true });
  for (const [name, b] of Object.entries(files)) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Bad file name in backup.');
    writeFileSync(join(dataDir, name), b, { mode: 0o600 });
  }
  return Object.keys(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { DATA_DIR } = await import('./db.mjs');
  const [cmd, a, b] = process.argv.slice(2);
  const pass = process.env.KEA_BACKUP_PASSPHRASE;
  if (cmd === 'create' && a) console.log('Backup written:', createBackup(DATA_DIR, a, pass));
  else if (cmd === 'restore' && a && b) console.log('Restored:', restoreBackup(a, b, pass).join(', '));
  else console.log('Usage: create <out-folder> | restore <file.keabak> <empty-data-folder>   (KEA_BACKUP_PASSPHRASE set)');
}
