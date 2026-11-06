// Hub backups (audit L6 / section 5): the plaintext snapshot stays inside the data folder and is always deleted (and a
// crash's leftover is removed next time); the payroll vault can be included; restore writes files readable by this
// account only; the passphrase is NFC-normalized (and older, un-normalized backups still open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seal, open, createBackup, restoreBackup, snapshot, removeLeftoverSnapshots } from '../../hub/backup.mjs';

const require = createRequire(import.meta.url);
const WIN = process.platform === 'win32';
const PASS = 'a long recovery phrase';

function makeDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT)');
  for (const r of rows) db.prepare('INSERT INTO t (v) VALUES (?)').run(r);
  return db; // left open, like the running Hub
}
const rowsOf = (file) => { const db = new DatabaseSync(file); try { return db.prepare('SELECT v FROM t ORDER BY rowid').all().map((r) => r.v); } finally { db.close(); } };

test('L6: snapshots are made inside the data folder and always deleted; a crash’s leftover is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-backup-'));
  const tmpBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('kea-hub-snap-')));
  try {
    const data = join(root, 'data');
    mkdirSync(data);
    const db = makeDb(join(data, 'hub.db'), ['alice', 'bob']);
    writeFileSync(join(data, 'hub-signing-key.pem'), 'PEM');
    writeFileSync(join(data, '.backup-snap-1234-1-dead.db'), 'plaintext left by a crash');
    const file = createBackup(data, join(root, 'out'), PASS);
    assert.deepEqual(readdirSync(data).filter((f) => f.startsWith('.backup-snap')), [], 'no snapshot left, and the old one is gone');
    assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith('kea-hub-snap-') && !tmpBefore.has(f)), [], 'nothing in the shared temp folder');
    assert.ok(readFileSync(file).indexOf(Buffer.from('alice')) === -1, 'the backup is encrypted');
    // A failing snapshot still leaves nothing behind.
    writeFileSync(join(root, 'not-a-db.db'), 'this is not sqlite');
    assert.throws(() => snapshot(join(root, 'not-a-db.db')));
    assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('.backup-snap')), []);
    assert.equal(removeLeftoverSnapshots(join(root, 'missing')), 0);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('L6: the payroll vault can be included; restore puts files back for this account only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-backup-'));
  try {
    const data = join(root, 'data'), pay = join(root, 'Payroll');
    mkdirSync(data); mkdirSync(pay);
    const db = makeDb(join(data, 'hub.db'), ['alice']);
    const pdb = makeDb(join(pay, 'payroll-vault.db'), ['v2.sealed.value.x']);
    writeFileSync(join(data, 'hub-signing-key.pem'), 'PEM');
    assert.throws(() => createBackup(data, join(root, 'out'), PASS, { payrollDb: join(pay, 'nope.db') }), /no payroll vault/);
    const file = createBackup(data, join(root, 'out'), PASS, { payrollDb: join(pay, 'payroll-vault.db') });
    assert.deepEqual(readdirSync(pay).filter((f) => f.startsWith('.backup-snap')), []);
    db.close(); pdb.close();
    const into = join(root, 'restored'), payInto = join(root, 'payroll-restored');
    const restored = restoreBackup(file, into, PASS, { payrollDir: payInto });
    assert.equal(restored.length, 3);
    assert.deepEqual(rowsOf(join(into, 'hub.db')), ['alice']);
    assert.deepEqual(rowsOf(join(payInto, 'payroll-vault.db')), ['v2.sealed.value.x']);
    assert.equal(readFileSync(join(into, 'hub-signing-key.pem'), 'utf8'), 'PEM');
    assert.throws(() => restoreBackup(file, into, PASS), /already has a hub\.db/);
    if (WIN) {
      const b = require('../../desktop/bootstart.cjs');
      const sid = await b.currentUserSid();
      for (const f of [join(into, 'hub-signing-key.pem'), join(into, 'hub.db'), join(payInto, 'payroll-vault.db')]) {
        const rep = await b.aclReport(f);
        assert.equal(rep.protected, true, `${f}: nothing inherited`);
        assert.deepEqual(new Set(rep.aces.map((a) => a.sid)), new Set([sid, b.SID.SYSTEM]), f);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('L6: the backup passphrase is NFC-normalized; older backups sealed with the raw passphrase still open', () => {
  const composed = 'café au lait recovery', decomposed = 'café au lait recovery';
  assert.notEqual(composed, decomposed);
  const b = seal(Buffer.from('hub'), decomposed);
  assert.equal(open(b, composed).toString(), 'hub', 'typed the other way, same passphrase');
  assert.equal(open(b, decomposed).toString(), 'hub');
  assert.throws(() => open(b, 'cafe au lait recovery'), /passphrase/);
});
