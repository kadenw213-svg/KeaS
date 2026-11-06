// The before-sign-in Scheduled Task and power settings: everything that would change Windows is generated text, tested
// here without running it elevated. On Windows, the scripts are also parsed by PowerShell itself, the launcher is run
// (un-elevated) against a stand-in Hub, and folder permissions are set on throwaway folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const b = require('../../desktop/bootstart.cjs');
const WIN = process.platform === 'win32';
const SVC = 'C:\\Program Files\\KeaS Hub Service';
const OWNER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
// The red team's folder name: a typographic apostrophe (U+2019) is a quote character to PowerShell.
const POC = 'D:\\Hub\u2019; Start-Process calc; echo \u2019x';
const SMART = ['\u2018', '\u2019', '\u201A', '\u201B', '\u201C', '\u201D', '\u201E', '\u201F', "'", '"', '`'];
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** PowerShell's own parser: { errors, commands } for a script (nothing is run). */
function psParse(script) {
  const dir = mkdtempSync(join(tmpdir(), 'keas-ps-'));
  try {
    const f = join(dir, 's.ps1');
    writeFileSync(f, '\ufeff' + script);
    const cmd = "$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile($env:KEAS_T_FILE,[ref]$t,[ref]$e);@{errors=@($e|%{$_.Message});commands=@($a.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true)|%{$_.GetCommandName()})}|ConvertTo-Json -Compress";
    const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: { ...process.env, KEAS_T_FILE: f }, encoding: 'utf8' });
    const j = JSON.parse(out);
    return { errors: [].concat(j.errors || []), commands: [].concat(j.commands || []) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Every command the elevated scripts may run.
const ALLOWED = new Set(['Step', 'ConvertFrom-Json', 'ConvertTo-Json', 'Out-Null', 'Join-Path', 'Test-Path', 'New-Item', 'icacls', 'Copy-Item', 'Remove-Item', 'Get-ChildItem', 'ForEach-Object', 'Where-Object', 'Get-CimInstance', 'Stop-Process', 'schtasks', 'powercfg', 'OwnerSid', 'ServiceDir', 'New-Object', 'Get-Acl', null]);

test('options: defaults, unknown keys dropped, numbers clamped', () => {
  const o = b.options({ delaySeconds: 99999, restartCount: 0, bogus: 1, power: 0 });
  assert.equal(o.bootStart, true);
  assert.equal(o.power, false);
  assert.equal(o.delaySeconds, 3600);
  assert.equal(o.restartCount, 1);
  assert.equal('bogus' in o, false);
  assert.deepEqual(b.options(), { ...b.DEFAULTS });
});

test('hubEnv carries every setting the Hub reads at start', () => {
  const env = b.hubEnv({ dataDir: 'E:\\Kea Hub', quotaGb: 50, tailscale: true, googleClientIds: ['a.apps', 'b.apps'] });
  assert.deepEqual(env, {
    ELECTRON_RUN_AS_NODE: '1', KEA_HUB_DATA: 'E:\\Kea Hub', KEA_HUB_STORAGE: 'E:\\Kea Hub\\storage', KEA_HUB_QUOTA_GB: '50',
    KEA_HUB_PORT: '4860', KEA_HUB_OWNER_PORT: '4861', KEA_HUB_IP_HEADER: 'x-forwarded-for', KEA_GOOGLE_CLIENT_IDS: 'a.apps,b.apps',
  });
  const local = b.hubEnv({ dataDir: 'D:\\H', storageDir: 'F:\\files' });
  assert.equal(local.KEA_HUB_STORAGE, 'F:\\files');
  assert.equal('KEA_HUB_IP_HEADER' in local, false);
});

test('data folder names: the PoC and every kind of quote are refused; drive roots too', () => {
  assert.throws(() => b.validateDataDir(POC), /quote/);
  for (const q of SMART) assert.throws(() => b.validateDataDir(`D:\\Kea${q}Hub`), /quote|valid/, `U+${q.codePointAt(0).toString(16)}`);
  for (const c of [';', '&', '|', '<', '>', '$', '%', '^', '!', '\n', '\r', '\t', '\u0000', '\u2028']) assert.throws(() => b.validateDataDir(`D:\\Kea${c}Hub`), undefined, JSON.stringify(c));
  for (const root of ['D:\\', 'D:', 'd:\\\\', 'C:\\.', 'E:\\Kea\\..']) assert.throws(() => b.validateDataDir(root), undefined, root);
  for (const bad of ['Kea Hub', '\\\\server\\share\\Kea', '\\\\?\\D:\\Kea', '/kea', 'D:\\a:b', ' D:\\Kea']) assert.throws(() => b.validateDataDir(bad), undefined, bad);
  assert.equal(b.validateDataDir('D:\\Kea Hub'), 'D:\\Kea Hub');
  assert.equal(b.validateDataDir('E:\\Data\\Kea Hub (2)\\'), 'E:\\Data\\Kea Hub (2)');
  assert.equal(b.validateDataDir('C:\\Users\\José\\Kea Hub'), 'C:\\Users\\José\\Kea Hub');
});

test('psq doubles every kind of single quote', () => {
  assert.equal(b.psq("it's"), "'it''s'");
  assert.equal(b.psq('a\u2019b\u2018c\u201Ad\u201Be'), "'a\u2019\u2019b\u2018\u2018c\u201A\u201Ad\u201B\u201Be'");
});

test('launcher: clears Node/Electron/libuv/OpenSSL/Kea variables, then sets only its own; absolute paths only', () => {
  const cmd = b.launcherCmd({ exe: 'C:\\Program Files\\KeaS\\KeaS.exe', entry: `${SVC}\\hub\\index.mjs`, env: { KEA_HUB_DATA: 'E:\\Kea & Co 100%' }, logFile: `${SVC}\\hub-service.log`, sysRoot: 'C:\\Windows' });
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes('setlocal DisableDelayedExpansion'));
  for (const p of ['NODE_', 'ELECTRON_', 'UV_', 'OPENSSL_', 'SSL_CERT_', 'KEA_', 'KEAS_']) assert.ok(cmd.includes(`for /f "delims==" %%V in ('set ${p} 2^>nul') do set "%%V="`), p);
  assert.ok(cmd.includes('set "SSLKEYLOGFILE="'));
  assert.ok(cmd.includes('set "PATH=C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem"'));
  // Cleared before anything is set.
  assert.ok(cmd.indexOf('set NODE_ 2^>nul') < cmd.indexOf('set "KEA_HUB_DATA='));
  assert.ok(cmd.indexOf('set ELECTRON_ 2^>nul') < cmd.lastIndexOf('set "ELECTRON_RUN_AS_NODE=1"'));
  assert.ok(cmd.includes('set "KEA_HUB_DATA=E:\\Kea & Co 100%%"'));
  // (The Hub keeps its own size-limited log; its output never piles up in the service folder.)
  assert.ok(cmd.includes(`"C:\\Program Files\\KeaS\\KeaS.exe" "${SVC}\\hub\\index.mjs" >NUL 2>&1`));
  assert.ok(cmd.includes(`cd /d "${SVC}\\hub"`));
  const ok = { exe: 'C:\\K\\KeaS.exe', entry: 'C:\\K\\hub\\index.mjs', env: {}, logFile: 'C:\\K\\l.log' };
  assert.throws(() => b.launcherCmd({ ...ok, exe: 'a"b.exe' }));
  assert.throws(() => b.launcherCmd({ ...ok, exe: 'KeaS.exe' }), /full path/);
  assert.throws(() => b.launcherCmd({ ...ok, exe: 'C:\\K\\evil.cmd' }), /\.exe/);
  assert.throws(() => b.launcherCmd({ ...ok, entry: 'hub\\index.mjs' }), /full path/);
  assert.throws(() => b.launcherCmd({ ...ok, env: { 'BAD NAME': '1' } }));
});

test('launcher run: NODE_OPTIONS, NODE_PATH, ELECTRON_* and KEA_* from the account never reach the Hub', { skip: !WIN && 'Windows only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-launch-'));
  try {
    const marker = join(root, 'preload-ran.txt');
    const evil = join(root, 'evil.cjs');
    writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const hubDir = join(root, 'svc', 'hub');
    mkdirSync(hubDir, { recursive: true });
    const report = join(root, 'env.json');
    writeFileSync(join(hubDir, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.env));`);
    const launcher = join(root, 'svc', 'start-hub.cmd');
    // The Hub "executable" here is this Node (ELECTRON_RUN_AS_NODE means nothing to it; the point is what it inherits).
    writeFileSync(launcher, b.launcherCmd({ exe: process.execPath, entry: join(hubDir, 'index.mjs'), env: b.hubEnv({ dataDir: 'D:\\Kea Hub' }), logFile: join(root, 'svc', 'hub.log') }));
    const env = { ...process.env, NODE_OPTIONS: `--require "${evil}"`, NODE_PATH: root, NODE_REPL_EXTERNAL_MODULE: evil, ELECTRON_NO_ASAR: '1', ELECTRON_ENABLE_LOGGING: '1', KEA_OWNER_KEY_FILE: 'C:\\attacker\\owner.key', KEA_HUB_DATA: 'C:\\attacker', UV_THREADPOOL_SIZE: '1', OPENSSL_CONF: evil, SSLKEYLOGFILE: join(root, 'keys.log') };
    const r = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${launcher}""`], { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout + (existsSync(join(root, 'svc', 'hub.log')) ? readFileSync(join(root, 'svc', 'hub.log'), 'utf8') : ''));
    assert.ok(!existsSync(marker), 'the NODE_OPTIONS --require preload never ran');
    const seen = JSON.parse(readFileSync(report, 'utf8'));
    const keys = Object.keys(seen).map((k) => k.toUpperCase());
    for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_NO_ASAR', 'ELECTRON_ENABLE_LOGGING', 'KEA_OWNER_KEY_FILE', 'UV_THREADPOOL_SIZE', 'OPENSSL_CONF', 'SSLKEYLOGFILE']) assert.ok(!keys.includes(k), `${k} was cleared`);
    assert.equal(seen.KEA_HUB_DATA, 'D:\\Kea Hub', 'only the launcher’s own setting');
    assert.equal(seen.ELECTRON_RUN_AS_NODE, '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task XML: at startup, S4U, normal rights, no time limit, restarts, battery, absolute cmd.exe', () => {
  const xml = b.taskXml({ userId: 'PC\\sam', launcher: `${SVC}\\start-hub.cmd`, workDir: `${SVC}\\hub`, sysRoot: 'C:\\Windows' });
  assert.match(xml, /<BootTrigger>\s*<Enabled>true<\/Enabled>\s*<Delay>PT30S<\/Delay>/);
  assert.match(xml, /<UserId>PC\\sam<\/UserId>\s*<LogonType>S4U<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(!xml.includes('HighestAvailable'), 'the Hub never runs with elevated rights');
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>5<\/Count>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(xml.includes('<Command>C:\\Windows\\System32\\cmd.exe</Command>'));
  assert.ok(xml.includes(`<Arguments>/d /s /c &quot;&quot;${SVC}\\start-hub.cmd&quot;&quot;</Arguments>`));
  assert.ok(xml.includes('<URI>\\KeaS\\Kea Hub</URI>'));
  const x2 = b.taskXml({ userId: 'PC\\a&b', launcher: 'C:\\L.cmd', workDir: 'C:\\W', opts: { delaySeconds: 0, restartOnFailure: false, runOnBattery: false } });
  assert.ok(!x2.includes('<Delay>'));
  assert.ok(!x2.includes('RestartOnFailure'));
  assert.ok(x2.includes('PC\\a&amp;b'));
  assert.match(x2, /<DisallowStartIfOnBatteries>true</);
  assert.throws(() => b.taskXml({ userId: '', launcher: 'C:\\L', workDir: 'C:\\W' }));
  assert.throws(() => b.taskXml({ userId: 'PC\\sam', launcher: 'start-hub.cmd', workDir: 'C:\\W' }), /full path/);
});

const QUERY = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  GUID Alias: SCHEME_BALANCED
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    GUID Alias: SUB_SLEEP
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      GUID Alias: STANDBYIDLE
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Possible Settings increment: 0x00000001
      Possible Settings units: Seconds
    Current AC Power Setting Index: 0x00000708
    Current DC Power Setting Index: 0x0000012c
`;
test('parsePowerQuery reads the scheme and the AC/DC values (any language)', () => {
  assert.deepEqual(b.parsePowerQuery(QUERY), { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 1800, dc: 300 });
  const german = QUERY.replace('Current AC Power Setting Index', 'Index der aktuellen Wechselstromeinstellung').replace('Current DC Power Setting Index', 'Index der aktuellen Gleichstromeinstellung');
  assert.equal(b.parsePowerQuery(german).ac, 1800);
  assert.deepEqual(b.parsePowerQuery('nothing'), { scheme: null, ac: null, dc: null });
});

test('power targets and the plan that puts back what was turned off', () => {
  assert.deepEqual(b.powerTargets({}), { standby: 0, hibernate: 0, wake: 1, disk: 0 });
  assert.deepEqual(b.powerTargets({ power: false }), {});
  assert.deepEqual(b.powerTargets({ disksNeverOffAC: false, wakeTimersAC: false }), { standby: 0, hibernate: 0 });
  const prev = { scheme: 's', values: { standby: 1800, hibernate: 0, wake: 2, disk: 1200 } };
  assert.deepEqual(b.powerPlan({ disksNeverOffAC: false }, prev, true), { standby: 0, hibernate: 0, wake: 1, disk: 1200 });
  assert.deepEqual(b.powerPlan({ power: false }, prev, true), prev.values);
  assert.deepEqual(b.powerPlan({ power: false }, prev, false), {});
});

test('install script: locked-down service folder in Program Files, locked-down data folder, then the task; no names in the text', () => {
  const s = b.installScript({ power: { standby: 0, wake: 1 }, scheme: '381b4222-f694-41f0-9685-ff5bb260df2e' });
  // Names come from the JSON next to the script.
  assert.ok(s.includes("[IO.Path]::ChangeExtension($PSCommandPath, '.json')"));
  assert.ok(s.includes("Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'KeaS Hub Service'"), 'the service folder can only be the one in Program Files');
  // The service folder: owned by Administrators, nothing inherited, SYSTEM + Administrators full, the owner Modify, nobody else.
  assert.ok(s.includes("icacls $svc /setowner '*S-1-5-32-544' /C /Q"));
  assert.ok(s.includes("icacls $svc /inheritance:r /grant:r $grantSystem $grantAdmins ('*' + (OwnerSid) + ':(OI)(CI)M') /C /Q"));
  assert.ok(s.includes("$grantSystem = '*S-1-5-18:(OI)(CI)F'") && s.includes("$grantAdmins = '*S-1-5-32-544:(OI)(CI)F'"));
  assert.ok(s.includes('icacls $_.FullName /reset /T /C /Q'), 'everything copied in inherits exactly that');
  assert.ok(!/S-1-5-32-545|S-1-5-11|S-1-1-0|\*Users|Everyone|Authenticated/.test(s), 'Users, Authenticated Users and Everyone get nothing');
  // The data folder and its secret files.
  assert.ok(s.includes("icacls $d /inheritance:r /grant:r $grantSystem $grantAdmins ($owner + ':(OI)(CI)F') /C /Q"));
  assert.ok(s.includes('icacls $d /setowner $owner /C /Q'));
  assert.ok(s.includes('foreach ($f in @($cfg.secretFiles)) { if ($f -and (Test-Path -LiteralPath $f)) { icacls $f /setowner $owner /C /Q; icacls $f /reset /C /Q } }'));
  assert.ok(s.includes("schtasks /Create /TN '\\KeaS\\Kea Hub' /XML ([string]$cfg.xmlFile) /F"));
  assert.ok(s.indexOf("Step 'service:folder'") < s.indexOf("Step 'service:copy'") && s.indexOf("Step 'service:copy'") < s.indexOf("Step 'task'"), 'permissions before files, files before the task');
  assert.ok(s.includes('powercfg /setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_SLEEP STANDBYIDLE 0'));
  assert.ok(s.includes('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e'));
  assert.ok(!s.includes('HIBERNATEIDLE'));
  assert.ok(!/[A-Za-z]:\\/.test(s), 'no folder or file name anywhere in the script text');
  assert.throws(() => b.installScript({ power: { standby: 0 }, scheme: "x'; calc; '" }), /power scheme/);
  const off = b.installScript({ bootStart: false, removeTask: true, stop: true, power: {} });
  assert.ok(!off.includes('/Create'));
  assert.ok(off.includes("schtasks /Delete /TN '\\KeaS\\Kea Hub' /F"));
  assert.ok(off.includes('$paths = @($cfg.stopPaths'));
  assert.ok(off.includes("Step 'service:remove'"));
  assert.ok(!off.includes('install.ps1'), 'never matches the elevated script itself');
  assert.ok(!off.includes('powercfg'));
});

test('script settings: the service in Program Files, the data folder and its secret files, the old folder to remove', () => {
  const files = b.planFiles({ service: SVC, stageDir: 'C:\\Users\\sam\\AppData\\Roaming\\KeaS\\hub-service' });
  assert.equal(files.launcher, `${SVC}\\start-hub.cmd`);
  assert.equal(files.xmlFile, `${SVC}\\kea-hub-task.xml`);
  assert.equal(files.entry, `${SVC}\\hub\\index.mjs`);
  const st = b.scriptSettings({ config: { dataDir: 'E:\\Kea Hub', storageDir: 'F:\\files' }, files, ownerSid: OWNER });
  assert.equal(st.service, SVC);
  assert.equal(st.xmlFile, `${SVC}\\kea-hub-task.xml`);
  assert.deepEqual(st.dataDirs, ['E:\\Kea Hub', 'F:\\files']);
  for (const f of ['owner.key', 'hub-signing-key.pem', 'hub.db']) assert.ok(st.secretFiles.includes(`E:\\Kea Hub\\${f}`), f);
  assert.deepEqual(st.legacy, ['E:\\Kea Hub\\service']);
  assert.ok(st.stopPaths.includes(`${SVC}\\hub\\index.mjs`) && st.stopPaths.includes('E:\\Kea Hub\\service\\start-hub.cmd'));
  assert.deepEqual(b.scriptSettings({ config: { dataDir: 'E:\\Kea Hub', storageDir: 'E:\\Kea Hub\\storage' }, files, ownerSid: OWNER }).dataDirs, ['E:\\Kea Hub']);
  for (const bad of ['S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', "S-1-5-21-1'; calc"]) assert.throws(() => b.scriptSettings({ config: { dataDir: 'E:\\K' }, files, ownerSid: bad }), /SID/);
  assert.equal(b.serviceDir({ ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files (x86)' }), SVC);
});

test('C3: the red team’s folder name can’t inject PowerShell (it’s refused, and it never reaches the script text anyway)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-boot-'));
  try {
    await assert.rejects(b.install({ config: { dataDir: POC }, exe: 'C:\\K\\KeaS.exe', hubSource: 'none', version: '1', previous: { scheme: null, values: {} }, stageDir: root, dryRun: true }), /quote/);
    // Even past the check, a name is only ever JSON data for the script.
    const files = b.planFiles({ service: SVC, stageDir: root });
    for (const q of SMART) {
      const evil = `D:\\Hub${q}; Start-Process calc; echo ${q}x`;
      const st = b.scriptSettings({ config: { dataDir: evil }, files, ownerSid: OWNER });
      assert.equal(st.dataDirs[0], evil);
      const s = b.installScript({ power: {} });
      assert.ok(!s.includes('Start-Process calc'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('C3: PowerShell itself parses the scripts to only the expected commands', { skip: !WIN && 'Windows only' }, () => {
  for (const s of [
    b.installScript({ power: { standby: 0, wake: 1 }, scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', stop: true }),
    b.installScript({ bootStart: false, removeTask: true, stop: true, power: { standby: 1800 } }),
    b.uninstallScript({ previous: { scheme: 'SCHEME_CURRENT', values: { standby: 1800 } }, stop: true }),
  ]) {
    const p = psParse(s);
    assert.deepEqual(p.errors, []);
    for (const c of p.commands) assert.ok(ALLOWED.has(c), `unexpected command ${c}`);
  }
  // A name inside a quoted string with psq's escaping: one string, no extra commands.
  for (const q of SMART.filter((c) => c !== '"' && c !== '`')) {
    const p = psParse(`Write-Output ${b.psq(`D:\\Hub${q}; Start-Process calc; echo ${q}x`)}`);
    assert.deepEqual(p.commands, ['Write-Output'], `U+${q.codePointAt(0).toString(16)}`);
  }
});

test('C1: the data folder step really locks a folder down, and the PoC name stays data (run un-elevated on throwaway folders)', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-acl-'));
  try {
    const sid = await b.currentUserSid();
    // A data folder whose name carries the PoC's quote characters, with a stand-in secret file.
    const data = join(root, 'Hub\u2019; New-Item injected; echo \u2019x');
    mkdirSync(data);
    writeFileSync(join(data, 'owner.key'), 'secret');
    // Opened up the way another account could have: an explicit grant on the folder and on the key.
    execFileSync('icacls', [data, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'ignore' });
    execFileSync('icacls', [join(data, 'owner.key'), '/grant', '*S-1-1-0:F'], { stdio: 'ignore' });
    const script = [b.scriptParts.head, ...b.scriptParts.dataAclLines(), b.scriptParts.tail].join('\n');
    writeFileSync(join(root, 'acl.ps1'), '\ufeff' + script);
    writeFileSync(join(root, 'acl.json'), JSON.stringify({ ownerSid: sid, dataDirs: [data], secretFiles: [join(data, 'owner.key')] }));
    spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'acl.ps1')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const result = JSON.parse(readFileSync(join(root, 'acl.result.json'), 'utf8').replace(/^\ufeff/, ''));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!readdirSync(root).includes('injected'), 'nothing in the name ran');
    for (const target of [data, join(data, 'owner.key')]) {
      const rep = await b.aclReport(target);
      if (target === data) assert.deepEqual(b.aclProblems(rep, sid), [], target);
      assert.deepEqual(new Set(rep.aces.map((a) => a.sid)), new Set([b.SID.SYSTEM, b.SID.ADMINS, sid]), target);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('C1: secureDataFolder locks a new folder at once, and repairs or refuses an existing one', { skip: !WIN && 'Windows only' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-acl-'));
  try {
    const sid = await b.currentUserSid();
    const dir = join(root, 'Kea Hub');
    assert.deepEqual(await b.secureDataFolder(dir), { ok: true, changed: true });
    assert.deepEqual(b.aclProblems(await b.aclReport(dir), sid), []);
    assert.deepEqual(await b.secureDataFolder(dir), { ok: true, changed: false }, 'already locked: nothing to do');
    // Opened up again (as if by an older KeaS): repaired.
    execFileSync('icacls', [dir, '/inheritance:e', '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'ignore' });
    assert.ok(b.aclProblems(await b.aclReport(dir), sid).length > 0);
    assert.equal((await b.secureDataFolder(dir)).changed, true);
    assert.deepEqual(b.aclProblems(await b.aclReport(dir), sid), []);
    // A folder another account owns is refused (simulated report).
    await assert.rejects(b.secureDataFolder(dir, { sid, report: async () => ({ owner: 'S-1-5-21-9-9-9-1234', protected: true, aces: [] }) }), /another Windows account/);
    await assert.rejects(b.secureDataFolder('D:\\'), /whole drive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('aclProblems: only SYSTEM, Administrators and the owner', () => {
  const good = { owner: OWNER, protected: true, aces: [{ sid: b.SID.SYSTEM, rights: 2032127, type: 'Allow' }, { sid: b.SID.ADMINS, rights: 2032127, type: 'Allow' }, { sid: OWNER, rights: 2032127, type: 'Allow' }] };
  assert.deepEqual(b.aclProblems(good, OWNER), []);
  assert.equal(b.aclProblems({ ...good, protected: false }, OWNER).length, 1);
  assert.equal(b.aclProblems({ ...good, owner: 'S-1-5-21-1-2-3-4' }, OWNER).length, 1);
  const users = { ...good, aces: [...good.aces, { sid: 'S-1-5-32-545', rights: 1179817, type: 'Allow' }] };
  assert.equal(b.aclProblems(users, OWNER).length, 1, 'no read access for Users on the data folder');
  assert.deepEqual(b.aclProblems(users, OWNER, { writeOnly: true }), [], 'read-only is fine for the service code');
  const writable = { ...good, aces: [...good.aces, { sid: 'S-1-5-11', rights: 1245631, type: 'Allow' }] };
  assert.equal(b.aclProblems(writable, OWNER, { writeOnly: true }).length, 1);
  assert.deepEqual(b.aclProblems({ ...good, aces: [...good.aces, { sid: 'S-1-1-0', rights: 2032127, type: 'Deny' }] }, OWNER), []);
  assert.deepEqual(b.dataAclArgs('E:\\Kea Hub', OWNER), ['E:\\Kea Hub', '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${OWNER}:(OI)(CI)F`, '/C', '/Q']);
  assert.equal(b.parseWhoami('"pc\\sam","S-1-5-21-1-2-3-1001"\r\n'), 'S-1-5-21-1-2-3-1001');
});

test('undo script: removes the task and the service folder, restores the saved values', () => {
  const s = b.uninstallScript({ previous: { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', values: { standby: 1800, disk: 1200, junk: 5 } } });
  assert.ok(s.includes("schtasks /End /TN '\\KeaS\\Kea Hub'"));
  assert.ok(s.includes("schtasks /Delete /TN '\\KeaS\\Kea Hub' /F"));
  assert.ok(s.includes("Step 'service:remove'"));
  assert.ok(s.includes('powercfg /setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_SLEEP STANDBYIDLE 1800'));
  assert.ok(s.includes('powercfg /setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_DISK DISKIDLE 1200'));
  assert.ok(!s.includes('junk'));
  assert.ok(!s.includes('hub:stop'), 'only stops the Hub process when asked');
  const none = b.uninstallScript({ previous: null });
  assert.ok(!none.includes('powercfg'));
});

test('elevation: one Start-Process -Verb RunAs that waits; the script path is passed in the environment, not the command', () => {
  const a = b.elevateArgs();
  const cmd = a[a.length - 1];
  assert.ok(cmd.includes('-Verb RunAs -Wait -PassThru'));
  assert.ok(cmd.includes('$env:KEAS_ELEVATE_SCRIPT'));
  assert.ok(cmd.endsWith('exit $p.ExitCode'));
  assert.ok(!/[A-Za-z]:\\/.test(cmd));
});

test('parseTaskQuery', () => {
  assert.deepEqual(b.parseTaskQuery('', 1), { installed: false });
  const t = b.parseTaskQuery('Folder: \\KeaS\nTaskName: \\KeaS\\Kea Hub\nStatus: Running\nLast Run Time: 11/5/2026 7:00:00 AM\nLast Result: 267009\nRun As User: sam\n', 0);
  assert.equal(t.installed, true);
  assert.equal(t.state, 'Running');
  assert.equal(t.lastResult, '267009');
  assert.equal(t.runAs, 'sam');
});

test('prepareFiles stages the Hub copy, launcher and UTF-16 task XML; refreshService only when KeaS changed and the permissions held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-boot-'));
  try {
    const src = join(root, 'src-hub');
    mkdirSync(join(src, 'lib'), { recursive: true });
    mkdirSync(join(src, 'data'), { recursive: true });
    writeFileSync(join(src, 'index.mjs'), 'export {}');
    writeFileSync(join(src, 'lib', 'a.mjs'), 'export {}');
    writeFileSync(join(src, 'data', 'hub.db'), 'secret');
    const config = { dataDir: 'E:\\Kea Hub', quotaGb: 25 };
    const stageDir = join(root, 'stage');
    const service = join(root, 'Program Files', 'KeaS Hub Service');
    const f = b.prepareFiles({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.1.0', userId: 'PC\\sam', stageDir, service });
    assert.ok(existsSync(join(stageDir, 'hub', 'lib', 'a.mjs')));
    assert.ok(!existsSync(join(stageDir, 'hub', 'data')), 'never copies a data folder');
    assert.ok(!existsSync(service), 'staging writes nothing to the service folder');
    const cmd = readFileSync(join(stageDir, 'start-hub.cmd'), 'utf8');
    assert.ok(cmd.includes('set "KEA_HUB_DATA=E:\\Kea Hub"'));
    assert.ok(cmd.includes(`"${f.entry}"`), 'the launcher runs the copy in the service folder');
    assert.ok(cmd.includes(`>>"${join(service, 'hub-service.log')}"`));
    const xml = readFileSync(join(stageDir, 'kea-hub-task.xml'));
    assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe]);
    assert.ok(xml.subarray(2).toString('utf16le').includes(`${service}\\start-hub.cmd`));
    assert.throws(() => b.prepareFiles({ config: { dataDir: POC }, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '1', stageDir, service }), /quote/);
    // Installed (as the elevated script would): refresh only on a new version, and only with intact permissions.
    assert.equal(await b.refreshService({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.1.0', service }), 'missing');
    mkdirSync(service, { recursive: true });
    for (const n of ['start-hub.cmd', 'version.txt']) writeFileSync(join(service, n), readFileSync(join(stageDir, n)));
    const sid = 'S-1-5-21-1-2-3-1001';
    const locked = async () => ({ owner: b.SID.ADMINS, protected: true, aces: [{ sid: b.SID.SYSTEM, rights: 2032127, type: 'Allow' }, { sid, rights: 1245631, type: 'Allow' }] });
    const opened = async () => ({ owner: b.SID.ADMINS, protected: false, aces: [{ sid: 'S-1-5-11', rights: 1245631, type: 'Allow' }] });
    assert.equal(await b.refreshService({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.1.0', service, sid, report: locked }), 'current');
    writeFileSync(join(src, 'index.mjs'), 'export const v = 2');
    assert.equal(await b.refreshService({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.2.0', service, sid, report: opened }), WIN ? 'repair' : 'updated');
    if (WIN) assert.ok(!existsSync(join(service, 'hub')), 'nothing written into a folder whose permissions changed');
    assert.equal(await b.refreshService({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.2.0', service, sid, report: locked }), 'updated');
    assert.equal(readFileSync(join(service, 'hub', 'index.mjs'), 'utf8'), 'export const v = 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry run returns the script and its settings, and changes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-boot-'));
  try {
    const config = { dataDir: 'E:\\Kea Hub' };
    const stageDir = join(root, 'stage');
    const previous = { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', values: { standby: 1800, hibernate: 0, wake: 1, disk: 1200 } };
    const r = await b.install({ config, exe: 'C:\\K\\KeaS.exe', hubSource: 'none', version: '1', previous, powerWasApplied: true, dryRun: true, stageDir, service: SVC, ownerSid: OWNER });
    assert.equal(r.dryRun, true);
    assert.ok(r.script.includes('/Create'));
    assert.equal(r.settings.service, SVC);
    assert.equal(r.settings.ownerSid, OWNER);
    assert.deepEqual(r.settings.dataDirs, ['E:\\Kea Hub']);
    assert.ok(r.script.includes('# install.json'), 'the dry run shows the names too');
    assert.ok(!existsSync(stageDir), 'a dry run writes nothing');
    const u = await b.uninstall({ config, previous, stopHub: true, dryRun: true, stageDir, service: SVC });
    assert.ok(u.settings.stopPaths.includes(`${SVC}\\hub\\index.mjs`));
    assert.ok(u.script.includes('STANDBYIDLE 1800'));
    assert.ok(!existsSync(stageDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hubAnswering: only OUR Kea Hub counts: it must prove it holds the signing key in the data folder', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const dataDir = mkdtempSync(join(tmpdir(), 'keas-hubid-'));
  const real = generateKeyPairSync('ed25519').privateKey;
  writeFileSync(join(dataDir, 'hub-signing-key.pem'), real.export({ type: 'pkcs8', format: 'pem' }));
  // A Kea Hub look-alike that signs identity nonces with `key`.
  const hubLike = (key) => http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/v1/health') return res.end(JSON.stringify({ ok: true, service: 'kea-hub' }));
    if (u.pathname === '/v1/identity') return res.end(JSON.stringify({ sig: sign(null, Buffer.from(`kea-hub-identity:v1:${u.searchParams.get('nonce')}`), key).toString('base64url') }));
    res.end('{}');
  });
  const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv.address().port; };
  const ours = hubLike(real);
  const port = await listen(ours);
  assert.equal(await b.hubAnswering(port, { dataDir }), true);
  assert.equal(await b.hubAnswering(port), false, 'nothing to check it against: not trusted');
  ours.close();
  await new Promise((r) => ours.once('close', r));
  assert.equal(await b.hubAnswering(port, { dataDir, timeoutMs: 500 }), false);
  // Another program on the port, answering like a Hub but with its own key (another Windows account's squatter).
  const squatter = hubLike(generateKeyPairSync('ed25519').privateKey);
  assert.equal(await b.hubAnswering(await listen(squatter), { dataDir }), false);
  squatter.close();
  const other = http.createServer((_q, res) => res.end('{"service":"other"}'));
  assert.equal(await b.hubAnswering(await listen(other), { dataDir }), false);
  other.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('a real Kea Hub proves its identity to KeaS (desktop/hubid.cjs against hub/index.mjs)', async () => {
  const { createHub } = await import('../../hub/index.mjs');
  const { verifyHubIdentity } = require('../../desktop/hubid.cjs');
  const dataDir = mkdtempSync(join(tmpdir(), 'keas-hubid-real-'));
  const hub = createHub({ dataDir, log: false });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  try {
    assert.equal(await verifyHubIdentity(p.port, dataDir), true);
    const elsewhere = mkdtempSync(join(tmpdir(), 'keas-hubid-other-'));
    const { generateKeyPairSync } = await import('node:crypto');
    writeFileSync(join(elsewhere, 'hub-signing-key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.equal(await verifyHubIdentity(p.port, elsewhere), false, 'a Hub with another key is not this data folder’s Hub');
    rmSync(elsewhere, { recursive: true, force: true });
    assert.equal((await fetch(`http://127.0.0.1:${p.port}/v1/identity?nonce=xyz`)).status, 400);
  } finally { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('tailscale: up keeps running unattended on Windows; Funnel off removes only KeaS’s handler', async () => {
  const ts = require('../../desktop/tailscale.cjs');
  assert.ok(ts.upArgs(60_000, 'win32').includes('--unattended'));
  assert.ok(!ts.upArgs(60_000, 'linux').includes('--unattended'));
  const mine = { AllowFunnel: { 'pc.tail.ts.net:443': true }, Web: { 'pc.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4860' } } } } };
  assert.equal(ts.servesPort(mine, 4860), true);
  assert.equal(ts.servesPort(mine, 4850), false, 'someone else’s Funnel is left alone');
  assert.equal(ts.servesPort({ Web: mine.Web }, 4860), false, 'served on the tailnet only is not a Funnel');
});
