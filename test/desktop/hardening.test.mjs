// Audit section 5 (desktop): the elevated install only runs the script KeaS wrote and only copies the files KeaS
// staged (hash-checked); locking down a data folder that was open covers everything in it (links, hard links and other
// accounts' files are refused; the rest inherits); the Hub's keys are replaced after that; openFolder only opens the
// data folder. Everything runs un-elevated on throwaway folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const b = require('../../desktop/bootstart.cjs');
const { exportPath } = require('../../desktop/payroll.cjs');
const WIN = process.platform === 'win32';
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const mklink = (...a) => execFileSync('cmd.exe', ['/d', '/c', 'mklink', ...a], { stdio: 'ignore' });

test('L: the elevated side runs the staged script only if it still has the hash KeaS wrote (tampered: exit 97, nothing runs)', { skip: !WIN && 'Windows only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-elev-'));
  try {
    const marker = join(root, 'ran.txt');
    const script = [b.scriptParts.head, `Step 'mark' { [IO.File]::WriteAllText([string]$cfg.marker, 'ran') }`, b.scriptParts.tail].join('\n');
    const file = join(root, 'install.ps1');
    const bytes = Buffer.from('\ufeff' + b.composeScript(script, { marker, resultFile: join(root, 'install.result-x.json') }), 'utf8');
    writeFileSync(file, bytes);
    const runBoot = () => spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b.encodedCommand(b.elevateBootstrap(file, sha(bytes)))], { encoding: 'utf8', timeout: 60_000 });
    let r = runBoot();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'ran');
    assert.equal(JSON.parse(readFileSync(join(root, 'install.result-x.json'), 'utf8').replace(/^\ufeff/, '')).ok, true);
    // Something changes the script between KeaS writing it and Windows running it.
    rmSync(marker);
    appendFileSync(file, "\nNew-Item -ItemType File -Path ([string]$cfg.marker) | Out-Null\n");
    r = runBoot();
    assert.equal(r.status, 97);
    assert.ok(!existsSync(marker), 'nothing in it ran');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('L: staged files are copied only when every one still matches its hash (one changed: nothing is copied)', { skip: !WIN && 'Windows only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-stage-'));
  try {
    const src = join(root, 'src-hub');
    mkdirSync(join(src, 'lib'), { recursive: true });
    writeFileSync(join(src, 'index.mjs'), 'export {}');
    writeFileSync(join(src, 'lib', 'a.mjs'), 'export const a = 1');
    const stage = join(root, 'stage'), svc = join(root, 'svc');
    const service = 'C:\\Program Files\\KeaS Hub Service';
    const files = b.prepareFiles({ config: { dataDir: 'E:\\Kea Hub' }, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '9', userId: 'PC\\sam', stageDir: stage, service });
    const paths = files.manifest.map((m) => m.path).sort();
    assert.deepEqual(paths, ['hub\\index.mjs', 'hub\\lib\\a.mjs', 'kea-hub-task.xml', 'start-hub.cmd', 'version.txt']);
    for (const m of files.manifest) assert.equal(sha(readFileSync(join(stage, m.path))), m.sha256, m.path);
    const settings = b.scriptSettings({ config: { dataDir: 'E:\\Kea Hub' }, files, ownerSid: 'S-1-5-21-1-2-3-1001', manifest: files.manifest });
    // The copy step, pointed at throwaway folders (icacls is a no-op here: setting the owner to Administrators needs elevation).
    const runCopy = (result) => {
      const script = [b.scriptParts.head, "function ServiceDir { return [string]$cfg.service }\nfunction icacls { $global:LASTEXITCODE = 0 }", b.scriptParts.serviceLines()[2], b.scriptParts.tail].join('\n');
      const f = join(root, 'copy.ps1');
      writeFileSync(f, '\ufeff' + b.composeScript(script, { ...settings, service: svc, stage, resultFile: join(root, result) }));
      mkdirSync(svc, { recursive: true });
      spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 60_000 });
      return JSON.parse(readFileSync(join(root, result), 'utf8').replace(/^\ufeff/, ''));
    };
    // Tampered after staging: the launcher now runs something else.
    appendFileSync(join(stage, 'start-hub.cmd'), '\r\ncalc.exe\r\n');
    let r = runCopy('r1.json');
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.steps), /changed after KeaS wrote it \(start-hub\.cmd\)/);
    assert.ok(!existsSync(join(svc, 'hub')) && !existsSync(join(svc, 'start-hub.cmd')), 'nothing was copied');
    // As staged: copied, byte for byte.
    b.prepareFiles({ config: { dataDir: 'E:\\Kea Hub' }, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '9', userId: 'PC\\sam', stageDir: stage, service });
    r = runCopy('r2.json');
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const m of files.manifest) assert.equal(sha(readFileSync(join(svc, m.path))), m.sha256, m.path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const everyoneHas = async (p) => (await b.aclReport(p)).aces.some((a) => a.sid === 'S-1-1-0');

test('M: the elevated data folder step refuses links and hard links inside, and resets everything else (un-elevated run)', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-data-acl-'));
  try {
    const sid = await b.currentUserSid();
    const data = join(root, 'data'), elsewhere = join(root, 'attacker');
    mkdirSync(join(data, 'storage'), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(join(data, 'storage', 'f.bin'), 'x');
    writeFileSync(join(elsewhere, 'theirs.db'), 'theirs');
    execFileSync('icacls', [join(data, 'storage', 'f.bin'), '/grant', '*S-1-1-0:F'], { stdio: 'ignore' });
    const run = (name) => {
      const script = [b.scriptParts.head, ...b.scriptParts.dataAclLines(), b.scriptParts.tail].join('\n');
      writeFileSync(join(root, `${name}.ps1`), '\ufeff' + b.composeScript(script, { ownerSid: sid, dataDirs: [data], secretFiles: [], resultFile: join(root, `${name}.json`) }));
      spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, `${name}.ps1`)], { encoding: 'utf8', timeout: 120_000 });
      return JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8').replace(/^\ufeff/, ''));
    };
    // A junction someone planted (uploads would land in their folder).
    mklink('/J', join(data, 'uploads'), elsewhere);
    let r = run('junction');
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.steps), /link .*uploads/);
    assert.ok(await everyoneHas(join(data, 'storage', 'f.bin')), 'nothing inside was changed');
    rmSync(join(data, 'uploads'));
    // A hard link to a file elsewhere (resetting its permissions would change the other one's).
    mklink('/H', join(data, 'hub.db'), join(elsewhere, 'theirs.db'));
    r = run('hardlink');
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.steps), /hard link .*hub\.db/);
    rmSync(join(data, 'hub.db'));
    // Clean: everything inside inherits the locked-down permissions.
    r = run('clean');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await everyoneHas(join(data, 'storage', 'f.bin')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M: securing a data folder that was open refuses links, hard links and other accounts’ files, then resets everything inside', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-secure-'));
  try {
    const sid = await b.currentUserSid();
    const dir = join(root, 'Kea Hub'), elsewhere = join(root, 'attacker');
    assert.deepEqual(await b.secureDataFolder(dir), { ok: true, changed: true, wasOpen: false });
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'x.db'), 'x');
    mkdirSync(join(dir, 'storage'));
    writeFileSync(join(dir, 'storage', 'a.bin'), 'a');
    writeFileSync(join(dir, 'owner.key'), 'k');
    execFileSync('icacls', [join(dir, 'storage', 'a.bin'), '/grant', '*S-1-1-0:F'], { stdio: 'ignore' });
    const open = () => execFileSync('icacls', [dir, '/inheritance:e', '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'ignore' });
    // While it was open, someone made "storage\uploads" a junction to their own folder.
    open();
    mklink('/J', join(dir, 'storage', 'uploads'), elsewhere);
    await assert.rejects(b.secureDataFolder(dir), /links to other places \(storage\\uploads\)/);
    rmSync(join(dir, 'storage', 'uploads'));
    // ...or a hard link.
    open();
    mklink('/H', join(dir, 'hub.db'), join(elsewhere, 'x.db'));
    await assert.rejects(b.secureDataFolder(dir), /hard links: hub\.db/);
    rmSync(join(dir, 'hub.db'));
    // ...or a file that belongs to another account (owners as Windows would report them).
    open();
    await assert.rejects(b.secureDataFolder(dir, { owners: async (ps) => ps.map((p) => (p.endsWith('owner.key') ? 'S-1-5-21-9-9-9-1234' : sid)) }), /belong to another Windows account \(owner\.key\)/);
    // Clean: locked down, everything inside reset to inherit, and reported as having been open.
    open();
    assert.ok(await everyoneHas(join(dir, 'storage', 'a.bin')));
    assert.deepEqual(await b.secureDataFolder(dir), { ok: true, changed: true, wasOpen: true });
    assert.deepEqual(b.aclProblems(await b.aclReport(dir), sid), []);
    assert.equal(await everyoneHas(join(dir, 'storage', 'a.bin')), false, 'a file’s own grant is gone');
    // The data folder itself as a link is refused.
    const link = join(root, 'Link Hub');
    mklink('/J', link, elsewhere);
    await assert.rejects(b.secureDataFolder(link), /link to somewhere else/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M: after an open Hub folder is locked down, its owner key and signing key are replaced (the Hub makes new ones)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-rotate-'));
  try {
    writeFileSync(join(root, 'owner.key'), 'old-owner-key');
    writeFileSync(join(root, 'hub-signing-key.pem'), 'old-signing-key');
    writeFileSync(join(root, 'hub.db'), 'db');
    assert.deepEqual(b.rotateHubSecrets(root), ['owner.key', 'hub-signing-key.pem']);
    assert.ok(!existsSync(join(root, 'owner.key')) && !existsSync(join(root, 'hub-signing-key.pem')));
    assert.ok(existsSync(join(root, 'hub.db')), 'only the keys');
    rmSync(join(root, 'hub.db'));
    const { createHub } = await import('../../hub/index.mjs');
    const hub = createHub({ dataDir: root, log: false });
    try {
      assert.ok(existsSync(join(root, 'owner.key')) && existsSync(join(root, 'hub-signing-key.pem')), 'new keys at the next start');
      assert.notEqual(readFileSync(join(root, 'owner.key'), 'utf8').trim(), 'old-owner-key');
    } finally { await hub.close?.(); }
    assert.deepEqual(b.rotateHubSecrets(join(root, 'missing')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('L: openFolder opens only the data folder or a folder inside it (no .., no links out, no files)', () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-open-'));
  try {
    const data = join(root, 'data');
    mkdirSync(join(data, 'storage'), { recursive: true });
    writeFileSync(join(data, 'hub.db'), 'x');
    mkdirSync(join(root, 'other'));
    assert.ok(b.folderInside(data, data));
    assert.ok(b.folderInside(data, join(data, 'storage')));
    if (WIN) assert.ok(b.folderInside(data.toUpperCase(), join(data, 'storage')), 'Windows paths ignore case');
    assert.equal(b.folderInside(data, join(root, 'other')), null);
    assert.equal(b.folderInside(data, join(data, '..', 'other')), null);
    assert.equal(b.folderInside(data, 'C:\\Windows\\System32'), null);
    assert.equal(b.folderInside(data, join(data, 'hub.db')), null, 'a file isn’t opened (it could run)');
    assert.equal(b.folderInside(data, join(data, 'nope')), null);
    assert.equal(b.folderInside(null, data), null);
    assert.equal(b.folderInside(data, ''), null);
    if (WIN) {
      mklink('/J', join(data, 'out'), join(root, 'other'));
      assert.equal(b.folderInside(data, join(data, 'out')), null, 'a link that leads out');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('L: payroll exports get a safe name in the payroll folder, never overwriting', () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-exp-'));
  try {
    assert.equal(exportPath(root, 'w2-2030.csv'), join(root, 'w2-2030.csv'));
    writeFileSync(join(root, 'w2-2030.csv'), 'x');
    assert.equal(exportPath(root, 'w2-2030.csv'), join(root, 'w2-2030 (2).csv'));
    assert.equal(exportPath(root, '..\\..\\Windows\\evil.cmd'), join(root, '_.._Windows_evil.cmd'));
    assert.equal(exportPath(root, ''), join(root, 'export'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
