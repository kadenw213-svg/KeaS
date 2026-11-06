// Regression tests from the second verification pass: the data folder's lockdown holds across restarts, and the launcher
// and hub:stop don't lean on the account's environment or on command lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const b = require('../../desktop/bootstart.cjs');
const WIN = process.platform === 'win32';
const mklink = (kind, link, target) => execFileSync('cmd', ['/c', 'mklink', kind, link, target], { stdio: 'ignore' });
const icacls = (...a) => execFileSync('icacls', a, { stdio: 'ignore' });
const openUp = (d) => icacls(d, '/grant', '*S-1-1-0:(OI)(CI)F', '/C', '/Q');
const refused = (dir, opts, re) => assert.rejects(b.secureDataFolder(dir, opts), re);

test('MED: a refused folder stays refused at the next start, and comes clean with the keys rotated exactly once', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-lock2-'));
  try {
    const A = join(root, 'data'), outside = join(root, 'outside');
    mkdirSync(A); mkdirSync(outside);
    writeFileSync(join(A, 'owner.key'), 'k');
    mklink('/J', join(A, 'storage'), outside);
    openUp(A);
    let rotated = 0;
    const onWasOpen = () => { rotated++; };
    await refused(A, { onWasOpen }, /links to other places \(storage\)/);
    // The folder's own permissions are right by now, which used to be enough.
    await refused(A, { onWasOpen }, /links to other places \(storage\)/);
    assert.ok(existsSync(join(A, b.PENDING_FILE)), 'a Hub started by itself sees the refusal too');
    assert.equal(rotated, 0);
    rmSync(join(A, 'storage'));
    assert.deepEqual(await b.secureDataFolder(A, { onWasOpen }), { ok: true, changed: false, wasOpen: true });
    assert.equal(rotated, 1);
    assert.equal(existsSync(join(A, b.PENDING_FILE)), false);
    assert.deepEqual(await b.secureDataFolder(A, { onWasOpen }), { ok: true, changed: false, wasOpen: false });
    assert.equal(rotated, 1, 'only once');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MED: the same goes for a hard link', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-lock2-'));
  try {
    const B = join(root, 'data'), out = join(root, 'outside.txt');
    mkdirSync(B); writeFileSync(out, 'o');
    mklink('/H', join(B, 'hub.db'), out);
    openUp(B);
    await refused(B, {}, /hard links: hub\.db/);
    await refused(B, {}, /hard links: hub\.db/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MED: every start looks inside: a link or a re-opened child appearing in a clean, locked folder is caught', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-lock2-'));
  try {
    const C = join(root, 'data'), outside = join(root, 'outside');
    mkdirSync(outside);
    await b.secureDataFolder(C);
    mkdirSync(join(C, 'storage', 'u1'), { recursive: true });
    writeFileSync(join(C, 'owner.key'), 'k');
    const onWasOpen = () => {};
    assert.deepEqual(await b.secureDataFolder(C, { onWasOpen }), { ok: true, changed: false, wasOpen: false });
    assert.deepEqual(await b.secureDataFolder(C, { onWasOpen }), { ok: true, changed: false, wasOpen: false }, 'and again from the checked list');

    // A child with its own open permissions: closed again, and treated as having been open.
    let rotated = 0;
    icacls(join(C, 'storage'), '/inheritance:d', '/C', '/Q');
    icacls(join(C, 'storage'), '/grant', '*S-1-1-0:(OI)(CI)F', '/C', '/Q');
    const r = await b.secureDataFolder(C, { onWasOpen: () => { rotated++; } });
    assert.deepEqual(r, { ok: true, changed: true, wasOpen: true });
    assert.equal(rotated, 1);
    assert.doesNotMatch(execFileSync('icacls', [join(C, 'storage')], { encoding: 'utf8' }), /Everyone|S-1-1-0/);

    // The checked list doesn't hide something new.
    mklink('/J', join(C, 'storage', 'u1', 'link'), outside);
    await refused(C, { onWasOpen }, /links to other places/);
    rmSync(join(C, 'storage', 'u1', 'link'));
    // A file that changed since it was checked is asked about again.
    writeFileSync(join(C, 'owner.key'), 'changed');
    let asked = [];
    const sid = await b.currentUserSid();
    await b.secureDataFolder(C, { onWasOpen, owners: async (ps) => { asked = ps; return ps.map(() => sid); } });
    assert.ok(asked.some((p) => p.endsWith('owner.key')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LOW: the launcher sets Windows’ own settings itself, temp files in the service folder', () => {
  const cmd = b.launcherCmd({ exe: 'C:\\Program Files\\KeaS\\KeaS.exe', entry: 'C:\\ProgramData\\KeaS\\hub\\index.mjs', env: {}, logFile: 'C:\\ProgramData\\KeaS\\hub-service.log', sysRoot: 'C:\\Windows' });
  for (const line of ['set "SystemRoot=C:\\Windows"', 'set "windir=C:\\Windows"', 'set "COMSPEC=C:\\Windows\\System32\\cmd.exe"', 'set "TEMP=C:\\ProgramData\\KeaS\\tmp"', 'set "TMP=C:\\ProgramData\\KeaS\\tmp"']) assert.ok(cmd.includes(line), line);
  assert.ok(cmd.indexOf('set "TEMP=') < cmd.indexOf('KeaS.exe'));
});

test('LOW: hub:stop goes by the Hub’s recorded process; command lines only for a Hub older than the record', () => {
  const s = b.installScript({ power: {}, bootStart: true, stop: true });
  const step = s.split('\n').find((l) => l.includes("Step 'hub:stop'"));
  assert.match(step, /\$cfg\.pidFile/);
  assert.match(step, /\$r\.startedAt/);
  assert.match(step, /\$p\.Path -eq \$cfg\.exe/);
  assert.ok(step.indexOf('$cfg.pidFile') < step.indexOf('Win32_Process'));
  const set = b.scriptSettings({ config: { dataDir: 'D:\\Kea Hub' }, files: b.planFiles({ service: 'C:\\ProgramData\\KeaS', stageDir: 'C:\\s' }), ownerSid: 'S-1-5-21-1-2-3-1000', exe: 'C:\\K\\KeaS.exe' });
  assert.equal(set.pidFile, 'D:\\Kea Hub\\hub.pid');
  assert.equal(set.exe, 'C:\\K\\KeaS.exe');
});
