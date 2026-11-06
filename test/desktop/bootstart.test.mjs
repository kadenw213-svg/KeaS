// The before-sign-in Scheduled Task and power settings: everything that would change Windows is generated text, tested
// here without running it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const b = require('../../desktop/bootstart.cjs');

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

test('launcher: quoted sets, % doubled, logs to the data folder', () => {
  const cmd = b.launcherCmd({ exe: 'C:\\Program Files\\KeaS\\KeaS.exe', entry: 'E:\\Kea & Co 100%\\service\\hub\\index.mjs', env: { KEA_HUB_DATA: 'E:\\Kea & Co 100%' }, logFile: 'E:\\log.txt' });
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes('set "KEA_HUB_DATA=E:\\Kea & Co 100%%"'));
  assert.ok(cmd.includes('"C:\\Program Files\\KeaS\\KeaS.exe" "E:\\Kea & Co 100%%\\service\\hub\\index.mjs" >>"E:\\log.txt" 2>&1'));
  assert.ok(cmd.includes('cd /d "E:\\Kea & Co 100%%\\service\\hub"'));
  assert.throws(() => b.launcherCmd({ exe: 'a"b', entry: 'x', env: {}, logFile: 'l' }));
  assert.throws(() => b.launcherCmd({ exe: 'a', entry: 'x', env: { 'BAD NAME': '1' }, logFile: 'l' }));
});

test('task XML: at startup, S4U, highest privileges, no time limit, restarts, battery', () => {
  const xml = b.taskXml({ userId: 'PC\\sam', launcher: 'E:\\Kea Hub\\service\\start-hub.cmd', workDir: 'E:\\Kea Hub\\service\\hub' });
  assert.match(xml, /<BootTrigger>\s*<Enabled>true<\/Enabled>\s*<Delay>PT30S<\/Delay>/);
  assert.match(xml, /<UserId>PC\\sam<\/UserId>\s*<LogonType>S4U<\/LogonType>\s*<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>5<\/Count>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(xml.includes('<Arguments>/d /s /c &quot;&quot;E:\\Kea Hub\\service\\start-hub.cmd&quot;&quot;</Arguments>'));
  assert.ok(xml.includes('<URI>\\KeaS\\Kea Hub</URI>'));
  const x2 = b.taskXml({ userId: 'PC\\a&b', launcher: 'L', workDir: 'W', opts: { delaySeconds: 0, restartOnFailure: false, runOnBattery: false } });
  assert.ok(!x2.includes('<Delay>'));
  assert.ok(!x2.includes('RestartOnFailure'));
  assert.ok(x2.includes('PC\\a&amp;b'));
  assert.match(x2, /<DisallowStartIfOnBatteries>true</);
  assert.throws(() => b.taskXml({ userId: '', launcher: 'L', workDir: 'W' }));
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

test('install script: one task registration plus powercfg on the saved scheme', () => {
  const s = b.installScript({ xmlFile: "E:\\it's\\task.xml", resultFile: 'E:\\r.json', power: { standby: 0, wake: 1 }, scheme: '381b4222-f694-41f0-9685-ff5bb260df2e' });
  assert.ok(s.includes("schtasks /Create /TN '\\KeaS\\Kea Hub' /XML 'E:\\it''s\\task.xml' /F"));
  assert.ok(s.includes('powercfg /setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_SLEEP STANDBYIDLE 0'));
  assert.ok(s.includes('powercfg /setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_SLEEP RTCWAKE 1'));
  assert.ok(s.includes('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e'));
  assert.ok(!s.includes('HIBERNATEIDLE'));
  assert.ok(s.includes("[IO.File]::WriteAllText('E:\\r.json'"));
  const off = b.installScript({ xmlFile: 'x', resultFile: 'r', bootStart: false, removeTask: true, stopIn: 'E:\\Kea Hub\\service', power: {} });
  assert.ok(!off.includes('/Create'));
  assert.ok(off.includes("schtasks /Delete /TN '\\KeaS\\Kea Hub' /F"));
  assert.ok(off.includes("$_.CommandLine.Contains('E:\\Kea Hub\\service\\hub\\index.mjs')"));
  assert.ok(off.includes("$_.CommandLine.Contains('E:\\Kea Hub\\service\\start-hub.cmd')"));
  assert.ok(!off.includes('install.ps1'), 'never matches the elevated script itself');
  assert.ok(!off.includes('powercfg'));
});

test('undo script: removes the task and restores the saved values', () => {
  const s = b.uninstallScript({ resultFile: 'r', previous: { scheme: 'abc', values: { standby: 1800, disk: 1200, junk: 5 } } });
  assert.ok(s.includes("schtasks /End /TN '\\KeaS\\Kea Hub'"));
  assert.ok(s.includes("schtasks /Delete /TN '\\KeaS\\Kea Hub' /F"));
  assert.ok(s.includes('powercfg /setacvalueindex abc SUB_SLEEP STANDBYIDLE 1800'));
  assert.ok(s.includes('powercfg /setacvalueindex abc SUB_DISK DISKIDLE 1200'));
  assert.ok(!s.includes('junk'));
  assert.ok(!s.includes('hub:stop'), 'only stops the Hub process when asked');
  const none = b.uninstallScript({ resultFile: 'r', previous: null });
  assert.ok(!none.includes('powercfg'));
});

test('elevation: one Start-Process -Verb RunAs that waits and passes the exit code back', () => {
  const a = b.elevateArgs("C:\\Data\\it's\\install.ps1");
  const cmd = a[a.length - 1];
  assert.ok(cmd.includes('-Verb RunAs -Wait -PassThru'));
  assert.ok(cmd.includes(`'"C:\\Data\\it''s\\install.ps1"'`));
  assert.ok(cmd.endsWith('exit $p.ExitCode'));
});

test('parseTaskQuery', () => {
  assert.deepEqual(b.parseTaskQuery('', 1), { installed: false });
  const t = b.parseTaskQuery('Folder: \\KeaS\nTaskName: \\KeaS\\Kea Hub\nStatus: Running\nLast Run Time: 11/5/2026 7:00:00 AM\nLast Result: 267009\nRun As User: sam\n', 0);
  assert.equal(t.installed, true);
  assert.equal(t.state, 'Running');
  assert.equal(t.lastResult, '267009');
  assert.equal(t.runAs, 'sam');
});

test('prepareFiles: Hub copy (no data folder), launcher, UTF-16 task XML; refresh only when KeaS changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-boot-'));
  try {
    const src = join(root, 'src-hub');
    mkdirSync(join(src, 'lib'), { recursive: true });
    mkdirSync(join(src, 'data'), { recursive: true });
    writeFileSync(join(src, 'index.mjs'), 'export {}');
    writeFileSync(join(src, 'lib', 'a.mjs'), 'export {}');
    writeFileSync(join(src, 'data', 'hub.db'), 'secret');
    const config = { dataDir: join(root, 'Kea Hub'), quotaGb: 25 };
    const f = b.prepareFiles({ config, exe: 'C:\\KeaS\\KeaS.exe', hubSource: src, version: '0.1.0', userId: 'PC\\sam' });
    assert.ok(existsSync(join(f.hubDir, 'lib', 'a.mjs')));
    assert.ok(!existsSync(join(f.hubDir, 'data')), 'never copies a data folder');
    assert.ok(readFileSync(f.launcher, 'utf8').includes(`set "KEA_HUB_DATA=${config.dataDir}"`));
    const xml = readFileSync(f.xmlFile);
    assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe]);
    assert.ok(xml.subarray(2).toString('utf16le').includes('<LogonType>S4U</LogonType>'));
    assert.equal(b.refreshIfOutdated({ config, exe: 'x', hubSource: src, version: '0.1.0' }), false);
    writeFileSync(join(src, 'index.mjs'), 'export const v = 2');
    assert.equal(b.refreshIfOutdated({ config, exe: 'x', hubSource: src, version: '0.2.0' }), true);
    assert.equal(readFileSync(join(f.hubDir, 'index.mjs'), 'utf8'), 'export const v = 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry run returns the scripts and changes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keas-boot-'));
  try {
    const config = { dataDir: join(root, 'Kea Hub') };
    const previous = { scheme: 'abc', values: { standby: 1800, hibernate: 0, wake: 1, disk: 1200 } };
    const r = await b.install({ config, exe: 'x', hubSource: 'none', version: '1', previous, powerWasApplied: true, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.script.includes('/Create'));
    assert.ok(r.script.includes(join(config.dataDir, 'service', 'install.result.json')));
    assert.ok(!existsSync(config.dataDir), 'a dry run writes nothing');
    const u = await b.uninstall({ config, previous, stopHub: true, dryRun: true });
    assert.ok(u.script.includes(join(config.dataDir, 'service', 'hub', 'index.mjs')));
    assert.ok(u.script.includes('STANDBYIDLE 1800'));
    assert.ok(!existsSync(config.dataDir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hubAnswering: only a Kea Hub on the port counts', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/v1/health' ? { ok: true, service: 'kea-hub' } : {})); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal(await b.hubAnswering(port), true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  assert.equal(await b.hubAnswering(port, { timeoutMs: 500 }), false);
  const other = http.createServer((_q, res) => res.end('{"service":"other"}'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  assert.equal(await b.hubAnswering(other.address().port), false);
  other.close();
});
