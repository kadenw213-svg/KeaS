// Start the Kea Hub before anyone signs in, and keep the PC awake for it.
//
// How it works:
//   - A Scheduled Task ("\KeaS\Kea Hub") runs at system startup, before sign-in, as the person who set up KeaS, with
//     highest privileges. It runs a small launcher (start-hub.cmd, in the Hub's data folder) that starts the Hub with
//     KeaS's own executable in plain-Node mode (ELECTRON_RUN_AS_NODE), from a copy of the Hub's files in the data folder
//     (so it never depends on files inside the app package).
//   - The task signs in as "S4U" (run whether the person is signed in or not, without storing their password). The
//     price: an S4U task can't reach network shares or the person's saved Windows passwords. The Hub needs neither: its
//     data is on a local drive, and Tailscale Funnel is its own Windows service.
//   - When KeaS opens later (at sign-in), it sees the Hub already answering on its port and doesn't start a second one.
//   - Power: never sleep or hibernate on AC power, allow wake timers, and (optionally) keep drives spinning. The values
//     before the change are saved, and turning this off puts them back and removes the task.
//   - "Restart after power loss" is a setting in the PC's BIOS/UEFI firmware. Windows can't change it; KeaS explains it.
//
// Everything that changes the system runs in ONE elevated PowerShell script (one Windows permission prompt). The script
// text, the task XML and the launcher are built by the pure functions below, so they're unit-tested and can be shown
// without running anything (dry run).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK_FOLDER = '\\KeaS\\';
const TASK_NAME = `${TASK_FOLDER}Kea Hub`;

/** Every option, with its default. The setup step shows the first two; Advanced shows the rest. */
const DEFAULTS = Object.freeze({
  bootStart: true, // the Scheduled Task
  power: true, // the power settings below, as a group
  neverSleepAC: true,
  neverHibernateAC: true,
  wakeTimersAC: true,
  disksNeverOffAC: true,
  delaySeconds: 30, // after startup, so the network and Tailscale are up first
  restartOnFailure: true,
  restartCount: 5,
  restartMinutes: 1,
  runOnBattery: true, // a laptop or a PC on a UPS keeps the Hub running on battery
});

function options(o = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(o || {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
    else {
      const n = Math.round(Number(v));
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  out.delaySeconds = clamp(out.delaySeconds, 0, 3600);
  out.restartCount = clamp(out.restartCount, 1, 999);
  out.restartMinutes = clamp(out.restartMinutes, 1, 1440);
  return out;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- escaping ----------
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** A PowerShell single-quoted string literal. */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** A value inside `set "NAME=value"` in a .cmd file: quotes keep & | < > ^ literal; only % needs doubling. */
function cmdSetValue(s) {
  const v = String(s);
  if (/["\r\n]/.test(v)) throw new Error(`Can't use ${JSON.stringify(v)} in the Hub launcher.`);
  return v.replace(/%/g, '%%');
}
const cmdQuoted = (s) => `"${cmdSetValue(s)}"`;

// ---------- the launcher and the task ----------
/** The env the Hub's own `node hub/index.mjs` reads, from KeaS's config. */
function hubEnv(config, { port = 4860 } = {}) {
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    KEA_HUB_DATA: config.dataDir,
    KEA_HUB_STORAGE: config.storageDir || path.win32.join(config.dataDir, 'storage'),
    KEA_HUB_QUOTA_GB: String(config.quotaGb || 25),
    KEA_HUB_PORT: String(port),
    KEA_HUB_OWNER_PORT: String(port + 1),
  };
  if (config.tailscale) env.KEA_HUB_IP_HEADER = 'x-forwarded-for';
  if (Array.isArray(config.googleClientIds) && config.googleClientIds.length) env.KEA_GOOGLE_CLIENT_IDS = config.googleClientIds.join(',');
  // The parent sign-off page's Google button, and the public address its links use.
  if (config.googleWebClientId) env.KEA_GOOGLE_WEB_CLIENT_ID = String(config.googleWebClientId);
  if (config.publicUrl) env.KEA_HUB_PUBLIC_URL = String(config.publicUrl);
  return env;
}

/** start-hub.cmd: sets the Hub's settings and runs it with KeaS's executable as Node, logging to the data folder. */
function launcherCmd({ exe, entry, env, logFile }) {
  const lines = [
    '@echo off',
    'rem Starts the Kea Hub. Written by KeaS; run at startup by the Scheduled Task "\\KeaS\\Kea Hub". Changing KeaS\'s settings rewrites it.',
    'setlocal',
    ...Object.entries(env).map(([k, v]) => {
      if (!/^[A-Z0-9_]+$/.test(k)) throw new Error(`Bad setting name ${k}`);
      return `set "${k}=${cmdSetValue(v)}"`;
    }),
    `cd /d ${cmdQuoted(path.win32.dirname(entry))}`,
    `echo [%date% %time%] Starting the Kea Hub>>${cmdQuoted(logFile)}`,
    `${cmdQuoted(exe)} ${cmdQuoted(entry)} >>${cmdQuoted(logFile)} 2>&1`,
    `echo [%date% %time%] The Kea Hub stopped (code %errorlevel%)>>${cmdQuoted(logFile)}`,
    'exit /b %errorlevel%',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Task Scheduler XML (schema 1.2): at startup, before sign-in, highest privileges, restarted if it stops with an error. */
function taskXml({ userId, launcher, workDir, opts = {} }) {
  const o = options(opts);
  if (!userId) throw new Error('Missing the Windows account to run as.');
  const delay = o.delaySeconds ? `\n      <Delay>PT${o.delaySeconds}S</Delay>` : '';
  const restart = o.restartOnFailure ? `\n    <RestartOnFailure>\n      <Interval>PT${o.restartMinutes}M</Interval>\n      <Count>${o.restartCount}</Count>\n    </RestartOnFailure>` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>KeaS</Author>
    <Description>Starts the Kea Hub when Windows starts, before anyone signs in. Set up by KeaS; turn it off in KeaS (tray menu or Settings).</Description>
    <URI>${xmlEsc(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>${delay}
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(userId)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>${o.runOnBattery ? 'false' : 'true'}</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>${o.runOnBattery ? 'false' : 'true'}</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>${restart}
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\cmd.exe</Command>
      <Arguments>${xmlEsc(`/d /s /c ""${launcher}""`)}</Arguments>
      <WorkingDirectory>${xmlEsc(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// ---------- power ----------
// powercfg aliases: [subgroup, setting]. Values are seconds (0 = never) or, for wake timers, 0 off / 1 on / 2 important only.
const POWER = {
  standby: ['SUB_SLEEP', 'STANDBYIDLE'],
  hibernate: ['SUB_SLEEP', 'HIBERNATEIDLE'],
  wake: ['SUB_SLEEP', 'RTCWAKE'],
  disk: ['SUB_DISK', 'DISKIDLE'],
};
/** Which power settings to change, and to what, from the options. */
function powerTargets(opts) {
  const o = options(opts);
  if (!o.power) return {};
  const t = {};
  if (o.neverSleepAC) t.standby = 0;
  if (o.neverHibernateAC) t.hibernate = 0;
  if (o.wakeTimersAC) t.wake = 1;
  if (o.disksNeverOffAC) t.disk = 0;
  return t;
}
/** Reads `powercfg /query SCHEME_CURRENT <sub> <setting>`: { scheme, ac, dc } (the last two hex values, in any language). */
function parsePowerQuery(text) {
  const s = String(text || '');
  const scheme = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s)?.[1]?.toLowerCase() ?? null;
  const hex = [...s.matchAll(/:\s*0x([0-9a-f]+)\s*$/gim)].map((m) => parseInt(m[1], 16));
  if (hex.length < 2) return { scheme, ac: null, dc: null };
  return { scheme, ac: hex[hex.length - 2], dc: hex[hex.length - 1] };
}

// ---------- the elevated scripts ----------
const SCRIPT_HEAD = (resultFile) => `# Written by KeaS. Runs once, elevated, then KeaS reads ${resultFile.replace(/[\r\n]/g, '')}.
$ErrorActionPreference = 'Stop'
$steps = New-Object System.Collections.ArrayList
$failed = $false
function Step($name, [scriptblock]$do) {
  try { & $do | Out-Null; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }; [void]$steps.Add(@{ step = $name; ok = $true }) }
  catch { $script:failed = $true; [void]$steps.Add(@{ step = $name; ok = $false; error = "$_" }) }
  $global:LASTEXITCODE = 0
}
`;
const SCRIPT_TAIL = (resultFile) => `
[IO.File]::WriteAllText(${psq(resultFile)}, (@{ ok = -not $failed; steps = $steps } | ConvertTo-Json -Depth 4))
if ($failed) { exit 1 } else { exit 0 }
`;
const powerLine = (scheme, key, value) => {
  const [sub, setting] = POWER[key];
  return `Step ${psq(`power:${key}=${value}`)} { powercfg /setacvalueindex ${scheme} ${sub} ${setting} ${Number(value) >>> 0} }`;
};

/**
 * The install script: register the task from its XML, and change the power settings (on the scheme that was active
 * when the old values were read).
 */
// stopIn: the service folder. Also stops the Hub the task started (its launcher and the Hub from that folder's copy),
// matched by command line, so KeaS's own Hub and anything else on the PC are never touched.
const stopLines = (dir) => {
  const entry = path.win32.join(dir, 'hub', 'index.mjs'), launcher = path.win32.join(dir, 'start-hub.cmd');
  return [`Step 'hub:stop' { $ErrorActionPreference = 'Continue'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains(${psq(entry)}) -or $_.CommandLine.Contains(${psq(launcher)})) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`];
};
const taskRemoveLines = (stopIn) => [
  `Step 'task:end' { $ErrorActionPreference = 'Continue'; schtasks /End /TN ${psq(TASK_NAME)} 2>&1 | Out-Null; $global:LASTEXITCODE = 0 }`,
  ...(stopIn ? stopLines(stopIn) : []),
  `Step 'task:delete' { $ErrorActionPreference = 'Continue'; schtasks /Query /TN ${psq(TASK_NAME)} 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN ${psq(TASK_NAME)} /F } else { $global:LASTEXITCODE = 0 } }`,
];
/** power: { key: value } to set. Lines for each, then make the scheme active again so they take effect. */
function powerLines(scheme, power) {
  const keys = Object.keys(power || {}).filter((k) => POWER[k] && Number.isFinite(power[k]));
  if (!keys.length) return [];
  return [...keys.map((key) => powerLine(scheme, key, power[key])), `Step 'power:apply' { powercfg /setactive ${scheme} }`];
}

/**
 * The install (or change) script: register the task from its XML, or remove it when it's turned off (removeTask), and
 * set the power settings (on the scheme that was active when the old values were read). `power` holds every value to
 * set, including old values put back for options that were turned off.
 */
function installScript({ xmlFile, resultFile, power = {}, scheme = 'SCHEME_CURRENT', bootStart = true, removeTask = false, stopIn = null }) {
  const lines = [SCRIPT_HEAD(resultFile)];
  if (bootStart) lines.push(`Step 'task' { schtasks /Create /TN ${psq(TASK_NAME)} /XML ${psq(xmlFile)} /F }`);
  else if (removeTask) lines.push(...taskRemoveLines(stopIn));
  lines.push(...powerLines(scheme, power));
  lines.push(SCRIPT_TAIL(resultFile));
  return lines.join('\n');
}

/** What to set: the targets, plus the saved old value for anything KeaS changed before that's now turned off. */
function powerPlan(opts, previous, powerWasApplied) {
  const plan = { ...powerTargets(opts) };
  if (powerWasApplied && previous?.values) for (const [k, v] of Object.entries(previous.values)) if (!(k in plan) && POWER[k] && Number.isFinite(v)) plan[k] = v;
  return plan;
}

/**
 * The undo script: stop and delete the task, put back the saved power values. `stopIn`: the service folder, to also
 * stop the Hub the task started (passed when KeaS itself isn't the one running the Hub).
 */
function uninstallScript({ resultFile, previous = null, removeTask = true, stopIn = null }) {
  const lines = [SCRIPT_HEAD(resultFile)];
  if (removeTask) lines.push(...taskRemoveLines(stopIn));
  if (previous && previous.values) lines.push(...powerLines(previous.scheme || 'SCHEME_CURRENT', previous.values));
  lines.push(SCRIPT_TAIL(resultFile));
  return lines.join('\n');
}

/** The PowerShell command (run un-elevated) that runs a script elevated and waits: one Windows permission prompt. */
function elevateArgs(scriptFile) {
  const inner = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(`"${scriptFile}"`)}); exit $p.ExitCode`;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inner];
}

/** `schtasks /Query /TN ... /FO LIST /V` output -> { installed, state, lastResult, lastRun, nextRun }. */
function parseTaskQuery(text, code = 0) {
  if (code !== 0 || !text) return { installed: false };
  const field = (re) => re.exec(text)?.[1]?.trim() ?? null;
  return {
    installed: true,
    state: field(/^Status:\s*(.+)$/im),
    lastRun: field(/^Last Run Time:\s*(.+)$/im),
    lastResult: field(/^Last Result:\s*(.+)$/im),
    runAs: field(/^Run As User:\s*(.+)$/im),
  };
}

// ---------- side effects (thin wrappers) ----------
function run(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}
const SYS = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const powercfg = () => path.join(SYS(), 'powercfg.exe');
const schtasks = () => path.join(SYS(), 'schtasks.exe');
const powershell = () => path.join(SYS(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** The current values of every power setting KeaS can change (reading needs no permission). */
async function readPower() {
  const values = {}; let scheme = null;
  for (const [key, [sub, setting]] of Object.entries(POWER)) {
    const r = await run(powercfg(), ['/query', 'SCHEME_CURRENT', sub, setting]);
    const p = parsePowerQuery(r.out);
    scheme = scheme || p.scheme;
    if (p.ac != null) values[key] = p.ac;
  }
  return { scheme, values, at: Date.now() };
}

async function taskStatus() {
  const r = await run(schtasks(), ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
  return parseTaskQuery(r.out, r.code);
}

/** Copies the Hub's files (never its data folder) to <dataDir>\service\hub, file by file (works out of app.asar too). */
function copyHub(fromDir, toDir) {
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'data' && src === fromDir) continue;
      const s = path.join(src, name), d = path.join(dst, name);
      if (fs.statSync(s).isDirectory()) walk(s, d);
      else fs.writeFileSync(d, fs.readFileSync(s));
    }
  };
  walk(fromDir, toDir);
}

/** Writes the Hub copy, the launcher and the task XML into <dataDir>\service. Returns their paths. */
function prepareFiles({ config, exe, hubSource, version, opts, port = 4860, userId = currentUser() }) {
  const dir = path.join(config.dataDir, 'service');
  fs.mkdirSync(dir, { recursive: true });
  const hubDir = path.join(dir, 'hub');
  copyHub(hubSource, hubDir);
  fs.writeFileSync(path.join(dir, 'version.txt'), String(version || ''));
  const entry = path.join(hubDir, 'index.mjs');
  const launcher = path.join(dir, 'start-hub.cmd');
  fs.writeFileSync(launcher, launcherCmd({ exe, entry, env: hubEnv(config, { port }), logFile: path.join(dir, 'hub-service.log') }));
  const xmlFile = path.join(dir, 'kea-hub-task.xml');
  // Task Scheduler wants the XML as UTF-16 with a byte-order mark.
  fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ userId, launcher, workDir: hubDir, opts }), 'utf16le')]));
  return { dir, hubDir, entry, launcher, xmlFile };
}
/** Refreshes the Hub copy when KeaS was updated (the running Hub picks it up at its next start). */
function refreshIfOutdated({ config, exe, hubSource, version, opts, port }) {
  try {
    const dir = path.join(config.dataDir, 'service');
    if (!fs.existsSync(dir)) return false;
    const had = fs.existsSync(path.join(dir, 'version.txt')) ? fs.readFileSync(path.join(dir, 'version.txt'), 'utf8') : '';
    if (had === String(version)) return false;
    prepareFiles({ config, exe, hubSource, version, opts, port });
    return true;
  } catch { return false; }
}

const currentUser = () => `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;

/** Runs a script elevated (one permission prompt) and returns what it reported. dryRun: returns the script only. */
async function runElevated(script, { dir, name, dryRun = false }) {
  const scriptFile = path.join(dir, `${name}.ps1`);
  const resultFile = path.join(dir, `${name}.result.json`);
  script = script.split('%RESULT%').join(resultFile.replace(/'/g, "''"));
  if (dryRun) return { dryRun: true, script, scriptFile };
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  // UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads non-English folder names right.
  fs.writeFileSync(scriptFile, '\ufeff' + script);
  const r = await run(powershell(), elevateArgs(scriptFile), { timeout: 5 * 60_000 });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\ufeff/, '')); } catch {}
  if (!result) {
    if (/cancel/i.test(r.err + r.out)) throw new Error('Windows asked for permission and it was declined. Nothing was changed.');
    throw new Error(`The change didn’t run (${(r.err || r.out || `code ${r.code}`).trim().slice(0, 300)}).`);
  }
  const steps = Array.isArray(result.steps) ? result.steps : [result.steps].filter(Boolean);
  return { ok: !!result.ok, steps };
}

/**
 * Turns it on: writes the files, saves the current power values (unless already saved from an earlier install, so
 * undo always goes back to how the PC was before KeaS), then one elevated script.
 */
async function install({ config, exe, hubSource, version, opts, port = 4860, previous = null, wasInstalled = false, powerWasApplied = false, stopHub = false, dryRun = false }) {
  if (!config?.dataDir) throw new Error('Set up the Hub’s data folder first.');
  const o = options(opts);
  const files = dryRun || !o.bootStart ? planFiles(config) : prepareFiles({ config, exe, hubSource, version, opts: o, port });
  const before = previous || (await readPower());
  const power = powerPlan(o, before, powerWasApplied);
  const script = installScript({ xmlFile: files.xmlFile, resultFile: '%RESULT%', power, scheme: before.scheme || 'SCHEME_CURRENT', bootStart: o.bootStart, removeTask: wasInstalled, stopIn: stopHub ? files.dir : null });
  const r = await runElevated(script, { dir: files.dir, name: 'install', dryRun });
  return { ...r, previous: before, files, options: o, power };
}
async function uninstall({ config, previous = null, stopHub = false, removeTask = true, dryRun = false }) {
  const dir = path.join(config?.dataDir || os.tmpdir(), 'service');
  const script = uninstallScript({ resultFile: '%RESULT%', previous, removeTask, stopIn: stopHub ? dir : null });
  return runElevated(script, { dir, name: 'uninstall', dryRun });
}
const planFiles = (config) => {
  const dir = path.join(config.dataDir, 'service');
  return { dir, hubDir: path.join(dir, 'hub'), entry: path.join(dir, 'hub', 'index.mjs'), launcher: path.join(dir, 'start-hub.cmd'), xmlFile: path.join(dir, 'kea-hub-task.xml') };
};

/** Is a Kea Hub already answering on this port (started before sign-in by the task)? */
async function hubAnswering(port, { timeoutMs = 1500, fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.service === 'kea-hub';
  } catch { return false; }
}

const POWER_LOSS_NOTE = 'To have this PC turn itself back on after a power cut, turn on "Restore on AC power loss" (some PCs call it "AC Power Recovery" or "After Power Failure: Power On") in its BIOS/UEFI settings. Windows can’t change that setting: restart the PC, press the key it shows for Setup (often Del, F2 or F10), and look under Power or Advanced. With that on, the Kea Hub comes back by itself, before anyone signs in.';

module.exports = {
  TASK_NAME, DEFAULTS, POWER, POWER_LOSS_NOTE,
  options, hubEnv, launcherCmd, taskXml, powerTargets, powerPlan, parsePowerQuery, installScript, uninstallScript, elevateArgs, parseTaskQuery,
  readPower, taskStatus, prepareFiles, refreshIfOutdated, install, uninstall, hubAnswering, currentUser, copyHub, cmdSetValue, psq,
};
