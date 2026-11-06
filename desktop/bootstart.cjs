// Start the Kea Hub before anyone signs in, and keep the PC awake for it.
//
// How it works:
//   - A Scheduled Task ("\KeaS\Kea Hub") runs at system startup, before sign-in, as the person who set up KeaS, with
//     that person's normal (not elevated) rights. It runs a small launcher (start-hub.cmd) that starts the Hub with
//     KeaS's own executable in plain-Node mode (ELECTRON_RUN_AS_NODE), from a copy of the Hub's files.
//   - The launcher, the Hub copy and the task definition live in "<Program Files>\KeaS Hub Service". Only SYSTEM,
//     Administrators and the person who set up KeaS can change anything there (other accounts can't even read it), so
//     no other account on the PC can change what the task runs. The Hub's data folder gets the same kind of
//     permissions (no access at all for other accounts), which protects the owner key, the signing key and the database.
//   - The task signs in as "S4U" (run whether the person is signed in or not, without storing their password). The
//     price: an S4U task can't reach network shares or the person's saved Windows passwords. The Hub needs neither: its
//     data is on a local drive, and Tailscale Funnel is its own Windows service.
//   - When KeaS opens later (at sign-in), it sees the Hub already answering on its port and doesn't start a second one.
//   - Power: never sleep or hibernate on AC power, allow wake timers, and (optionally) keep drives spinning. The values
//     before the change are saved, and turning this off puts them back and removes the task.
//   - "Restart after power loss" is a setting in the PC's BIOS/UEFI firmware. Windows can't change it; KeaS explains it.
//
// Everything that changes the system runs in ONE elevated PowerShell script (one Windows permission prompt). The script
// text holds no folder or file names as code: they're JSON data (base64 inside the script), so no name (whatever quote
// characters it contains) can ever become PowerShell code. The script text, its settings, the task XML and the
// launcher are built by the pure functions below, so they're unit-tested and can be shown without running anything.
//
// What's staged for the elevated script sits in KeaS's own (user-writable) folder until Windows asks for permission,
// so nothing there is trusted as it is: the elevated PowerShell is started with a short command (passed in its
// command line, not a file) that holds the SHA-256 of the script KeaS wrote, and runs the script only if it still has
// exactly that hash. The script in turn carries the SHA-256 of every staged file (the Hub copy, the launcher, the task
// XML), reads each one once, checks it, and writes those same bytes into the service folder, which no other account
// can change while that happens. A changed file stops the install before anything is copied.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK_FOLDER = '\\KeaS\\';
const TASK_NAME = `${TASK_FOLDER}Kea Hub`;
const SERVICE_FOLDER_NAME = 'KeaS Hub Service';
/** Well-known SIDs (the same in every Windows language). */
const SID = Object.freeze({ SYSTEM: 'S-1-5-18', ADMINS: 'S-1-5-32-544' });
/** Files in the Hub's data folder that hold secrets, re-protected one by one by the elevated script. */
const SECRET_FILES = ['owner.key', 'hub-signing-key.pem', 'hub.db', 'hub.db-wal', 'hub.db-shm'];
/** Layout version of the installed service (2: Program Files with locked-down permissions). */
const LAYOUT = 2;

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

// ---------- escaping and checking ----------
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** Every character PowerShell treats as a single quote: ' and the typographic ‘ ’ ‚ ‛. */
const PS_SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
/** A PowerShell single-quoted string literal. Each kind of single quote is doubled, which PowerShell reads as that character. */
const psq = (s) => `'${String(s).replace(PS_SINGLE_QUOTES, (c) => c + c)}'`;
/** A value inside `set "NAME=value"` in a .cmd file: quotes keep & | < > ^ literal; only % needs doubling. */
function cmdSetValue(s) {
  const v = String(s);
  if (/["\r\n\0]/.test(v)) throw new Error(`Can't use ${JSON.stringify(v)} in the Hub launcher.`);
  return v.replace(/%/g, '%%');
}
const cmdQuoted = (s) => `"${cmdSetValue(s)}"`;

/** Quote characters of every kind (ASCII and typographic, single and double), and the backtick. */
const ANY_QUOTE = /['"`\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u2035\u2036\uFF02\uFF07]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * A data folder KeaS will use: an absolute folder on a local drive (C:\...), not the drive itself, with no quote
 * characters of any kind and none of ; & | < > $ % ^ ` ! or control characters. Returns the normalized path or throws.
 */
function validateDataDir(dir, label = 'The data folder') {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${label} is missing.`);
  if (dir !== dir.trim()) throw new Error(`${label} can’t start or end with a space.`);
  if (dir.length > 200) throw new Error(`${label} path is too long (200 characters at most).`);
  if (CONTROL.test(dir)) throw new Error(`${label} can’t contain control characters.`);
  if (ANY_QUOTE.test(dir)) throw new Error(`${label} can’t contain quote marks or apostrophes of any kind. Pick a folder whose name has none.`);
  if (/[;&|<>$%^!]/.test(dir)) throw new Error(`${label} can’t contain any of these characters: ; & | < > $ % ^ !`);
  if (!/^[A-Za-z]:\\/.test(dir)) throw new Error(`${label} must be a full path on a drive inside this PC, like D:\\Kea Hub.`);
  if (/[*?"/]/.test(dir) || dir.indexOf(':', 2) !== -1) throw new Error(`${label} isn’t a valid Windows folder.`);
  const norm = path.win32.normalize(dir).replace(/\\+$/, '');
  if (norm.split('\\').some((part) => part === '..' || part === '.')) throw new Error(`${label} can’t contain . or .. parts.`);
  if (norm.length <= 2) throw new Error(`${label} can’t be a whole drive. Pick or make a folder on it, like ${dir.slice(0, 2)}\\Kea Hub.`);
  return norm;
}
/** An absolute Windows file path the launcher or task may name. */
function checkAbsolute(p, what) {
  if (typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p) || /["\r\n\0]/.test(p) || CONTROL.test(p)) throw new Error(`${what} must be a full path (got ${JSON.stringify(p)}).`);
  return p;
}
/** A Windows account SID for a real person's account (local, domain or Microsoft Entra), never a group like Users. */
function checkUserSid(sid) {
  if (typeof sid !== 'string' || !/^S-1-(5-21|12-1)(-\d{1,10}){2,14}$/.test(sid)) throw new Error(`Not a Windows account SID: ${JSON.stringify(sid)}`);
  return sid;
}

// ---------- folders ----------
/** "<Program Files>\KeaS Hub Service": where the launcher, the Hub copy and the task XML live. */
function serviceDir(env = process.env) {
  const pf = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  return path.win32.join(checkAbsolute(pf, 'Program Files'), SERVICE_FOLDER_NAME);
}
const systemRoot = (env = process.env) => { const r = env.SystemRoot || env.windir || 'C:\\Windows'; return /^[A-Za-z]:\\[^"%]*$/.test(r) ? r : 'C:\\Windows'; };
/** The paths of everything the task uses (in the service folder) and of the staging copy KeaS writes first. */
function planFiles({ service = serviceDir(), stageDir }) {
  const svc = (...p) => path.win32.join(service, ...p);
  return {
    dir: service, hubDir: svc('hub'), entry: svc('hub', 'index.mjs'), launcher: svc('start-hub.cmd'), xmlFile: svc('kea-hub-task.xml'), logFile: svc('hub-service.log'),
    stage: stageDir ? { dir: stageDir, hubDir: path.join(stageDir, 'hub'), launcher: path.join(stageDir, 'start-hub.cmd'), xmlFile: path.join(stageDir, 'kea-hub-task.xml'), version: path.join(stageDir, 'version.txt') } : null,
  };
}

// ---------- the launcher and the task ----------
/** The env the Hub's own `node hub/index.mjs` reads, from KeaS's config. */
function hubEnv(config, { port = 4860 } = {}) {
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    KEA_HUB_DATA: config.dataDir,
    KEA_HUB_STORAGE: config.storageDir || path.win32.join(config.dataDir, 'storage'),
    KEA_HUB_QUOTA_GB: String(config.quotaGb || 5),
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

/**
 * Every environment variable family that can change what Node, Electron, libuv or OpenSSL load or do (NODE_OPTIONS
 * with --require, NODE_PATH, NODE_REPL_EXTERNAL_MODULE, ELECTRON_RUN_AS_NODE and the other ELECTRON_ switches,
 * UV_THREADPOOL_SIZE, OPENSSL_CONF/OPENSSL_MODULES, SSL_CERT_FILE, ...), plus the Hub's own KEA_ settings. The launcher
 * clears every variable starting with one of these, then sets only its own.
 */
const CLEARED_PREFIXES = ['NODE_', 'ELECTRON_', 'UV_', 'OPENSSL_', 'SSL_CERT_', 'KEA_', 'KEAS_', 'V8_', 'NPM_CONFIG_'];
/** Single variables (no shared prefix) that also change how Node runs or what it trusts. */
const CLEARED_VARS = ['SSLKEYLOGFILE', 'NODE', 'NODEJS', 'CHROME_CRASHPAD_PIPE_NAME', 'GOOGLE_API_KEY', 'TZDIR', 'ICU_DATA', 'PSModulePath'];

/** start-hub.cmd: a clean environment, the Hub's settings, then KeaS's executable as Node on the Hub copy, logging to the service folder. */
function launcherCmd({ exe, entry, env, logFile, sysRoot = systemRoot() }) {
  checkAbsolute(exe, 'KeaS’s executable');
  if (!/\.exe$/i.test(exe)) throw new Error('KeaS’s executable must be an .exe file.');
  checkAbsolute(entry, 'The Hub’s entry file');
  checkAbsolute(logFile, 'The Hub’s log file');
  checkAbsolute(sysRoot, 'The Windows folder');
  const sys32 = path.win32.join(sysRoot, 'System32');
  const lines = [
    '@echo off',
    'rem Starts the Kea Hub. Written by KeaS; run at startup by the Scheduled Task "\\KeaS\\Kea Hub". Changing KeaS\'s settings rewrites it.',
    'setlocal DisableDelayedExpansion',
    'rem Nothing from the account\'s environment may change how Node or Electron run: clear every variable they read.',
    ...CLEARED_PREFIXES.map((p) => `for /f "delims==" %%V in ('set ${p} 2^>nul') do set "%%V="`),
    ...CLEARED_VARS.map((v) => `set "${v}="`),
    `set "PATH=${cmdSetValue(`${sys32};${sysRoot};${path.win32.join(sys32, 'Wbem')}`)}"`,
    'set "PATHEXT=.COM;.EXE;.BAT;.CMD"',
    ...Object.entries(env).map(([k, v]) => {
      if (!/^[A-Z0-9_]+$/.test(k)) throw new Error(`Bad setting name ${k}`);
      return `set "${k}=${cmdSetValue(v)}"`;
    }),
    'set "ELECTRON_RUN_AS_NODE=1"',
    `cd /d ${cmdQuoted(path.win32.dirname(entry))}`,
    `echo [%date% %time%] Starting the Kea Hub>>${cmdQuoted(logFile)}`,
    // (The Hub writes its own size-limited log in its data folder (logs\hub.log); its output here would grow forever.)
    `${cmdQuoted(exe)} ${cmdQuoted(entry)} >NUL 2>&1`,
    `echo [%date% %time%] The Kea Hub stopped (code %errorlevel%)>>${cmdQuoted(logFile)}`,
    'exit /b %errorlevel%',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Task Scheduler XML (schema 1.2): at startup, before sign-in, normal rights, restarted if it stops with an error. */
function taskXml({ userId, launcher, workDir, opts = {}, sysRoot = systemRoot() }) {
  const o = options(opts);
  if (!userId) throw new Error('Missing the Windows account to run as.');
  checkAbsolute(launcher, 'The launcher');
  checkAbsolute(workDir, 'The working folder');
  const cmdExe = path.win32.join(checkAbsolute(sysRoot, 'The Windows folder'), 'System32', 'cmd.exe');
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
      <RunLevel>LeastPrivilege</RunLevel>
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
      <Command>${xmlEsc(cmdExe)}</Command>
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
const checkScheme = (s) => {
  const v = String(s || 'SCHEME_CURRENT');
  if (v !== 'SCHEME_CURRENT' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error(`Not a power scheme: ${JSON.stringify(v)}`);
  return v;
};

// ---------- the elevated scripts ----------
// The head reads the settings from "<script name>.json" next to the script and writes the result to
// "<script name>.result.json": the script text itself never contains a folder or file name.
const SETTINGS_SLOT = '__KEAS_SETTINGS_BASE64__';
const SCRIPT_HEAD = `# Written by KeaS. Runs once, elevated. Folder and file names are JSON data (base64 below), never code.
$ErrorActionPreference = 'Stop'
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${SETTINGS_SLOT}')) | ConvertFrom-Json
$resultFile = [string]$cfg.resultFile
$grantSystem = '*${SID.SYSTEM}:(OI)(CI)F'
$grantAdmins = '*${SID.ADMINS}:(OI)(CI)F'
$steps = New-Object System.Collections.ArrayList
$failed = $false
function Step($name, [scriptblock]$do) {
  try { & $do | Out-Null; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }; [void]$steps.Add(@{ step = $name; ok = $true }) }
  catch { $script:failed = $true; [void]$steps.Add(@{ step = $name; ok = $false; error = "$_" }) }
  $global:LASTEXITCODE = 0
}
function OwnerSid { if ([string]$cfg.ownerSid -notmatch '^S-1-(5-21|12-1)(-\\d{1,10}){2,14}$') { throw 'Not a Windows account SID.' }; return [string]$cfg.ownerSid }
function ServiceDir {
  $expected = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) '${SERVICE_FOLDER_NAME}'
  if ([string]$cfg.service -ne $expected) { throw "The service folder must be $expected." }
  return $expected
}
function Sha256Hex([byte[]]$b) { return -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function IsLink($i) { return [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint) }
$keaLinksSource = @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class KeaLinks {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct Info { public uint Attr, C1, C2, A1, A2, W1, W2, Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  public static uint Count(string path) {
    using (SafeFileHandle h = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (h.IsInvalid) return 0;
      Info i;
      return GetFileInformationByHandle(h, out i) ? i.Links : 0;
    }
  }
}
'@
function LinkCount([string]$p) { if (-not ('KeaLinks' -as [type])) { Add-Type -TypeDefinition $keaLinksSource }; return [KeaLinks]::Count($p) }
# What can't stay in a data folder that's being locked down: links (followed by icacls /T), files with a second name
# elsewhere (a hard link: changing its permissions changes the other one's), found without following any link.
function DataProblems([string]$root) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push((Get-Item -LiteralPath $root -Force))
  while ($stack.Count -gt 0) {
    foreach ($i in $stack.Pop().GetFileSystemInfos()) {
      if (IsLink $i) { [void]$out.Add('link ' + $i.FullName); continue }
      if ($i -is [IO.DirectoryInfo]) { $stack.Push($i) } elseif ((LinkCount $i.FullName) -gt 1) { [void]$out.Add('hard link ' + $i.FullName) }
    }
  }
  return ,$out
}
`;
// The result goes next to the script under a name only this run knows, and never through a link.
const SCRIPT_TAIL = `
$rd = [IO.Path]::GetDirectoryName($resultFile)
if ($resultFile -and (Test-Path -LiteralPath $rd) -and -not (IsLink (Get-Item -LiteralPath $rd -Force)) -and -not (Test-Path -LiteralPath $resultFile)) {
  [IO.File]::WriteAllText($resultFile, (@{ ok = -not $failed; steps = $steps } | ConvertTo-Json -Depth 4))
}
if ($failed) { exit 1 } else { exit 0 }
`;
const powerLine = (scheme, key, value) => {
  const [sub, setting] = POWER[key];
  return `Step ${psq(`power:${key}=${Number(value) >>> 0}`)} { powercfg /setacvalueindex ${checkScheme(scheme)} ${sub} ${setting} ${Number(value) >>> 0} }`;
};

/**
 * The service folder: made (if needed), owned by Administrators, with only SYSTEM and Administrators in full control
 * and, while the install runs, the owner able to read only. Nothing is inherited from Program Files, and no other
 * account gets any access. Whatever was in it is moved aside (moving a link moves the link, never what it points to;
 * KeaS removes the old copy later, un-elevated). Then the staged files are checked against their hashes and written in,
 * everything inside inherits exactly that, and after the task is registered the owner may change files again (so
 * KeaS can update the Hub copy without asking).
 */
const serviceLines = () => [
  `Step 'service:folder' { $svc = ServiceDir; if (-not (Test-Path -LiteralPath $svc)) { [void](New-Item -ItemType Directory -Path $svc) }; if (IsLink (Get-Item -LiteralPath $svc -Force)) { throw 'The service folder is a link.' }; icacls $svc /setowner '*${SID.ADMINS}' /C /Q; icacls $svc /inheritance:r /grant:r $grantSystem $grantAdmins ('*' + (OwnerSid) + ':(OI)(CI)RX') /C /Q }`,
  `Step 'service:clear' { $svc = ServiceDir; $old = Join-Path $svc ('.old-' + [Guid]::NewGuid().ToString('N')); [void](New-Item -ItemType Directory -Path $old); Get-ChildItem -LiteralPath $svc -Force | Where-Object { $_.Name -notlike '.old-*' } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $old -Force } }`,
  `Step 'service:copy' { $svc = ServiceDir; $stage = [string]$cfg.stage; $files = [ordered]@{}; foreach ($f in @($cfg.manifest)) { $rel = [string]$f.path; if (-not $rel -or [IO.Path]::IsPathRooted($rel) -or $rel.Contains(':') -or ($rel.Split([char]92) -contains '..') -or ($rel.Split([char]92) -contains '.')) { throw 'A staged file has a bad name.' }; $b = [IO.File]::ReadAllBytes((Join-Path $stage $rel)); if ((Sha256Hex $b) -ne [string]$f.sha256) { throw ('A staged file changed after KeaS wrote it (' + $rel + '). Nothing was copied. Run it again from KeaS.') }; $files[$rel] = $b }; if ($files.Count -lt 1) { throw 'Nothing was staged.' }; foreach ($rel in $files.Keys) { $dst = Join-Path $svc $rel; [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dst)); [IO.File]::WriteAllBytes($dst, $files[$rel]) }; Get-ChildItem -LiteralPath $svc -Force | Where-Object { $_.Name -notlike '.old-*' } | ForEach-Object { icacls $_.FullName /setowner '*${SID.ADMINS}' /T /C /Q; icacls $_.FullName /reset /T /C /Q } }`,
];
const serviceOwnerLines = () => [
  `Step 'service:owner' { $svc = ServiceDir; icacls $svc /grant ('*' + (OwnerSid) + ':(OI)(CI)M') /C /Q }`,
];
/**
 * The data folder (and a separate storage folder): owned by the owner, with SYSTEM, Administrators and the owner in
 * full control and nobody else at all, and everything inside given to the owner and made to inherit exactly that
 * (icacls /T), in case another account put things there first or changed their permissions. A folder that's a link,
 * or that holds links or hard-linked files (found without following any link), is refused before anything changes:
 * icacls would follow them out of the folder.
 */
const dataAclLines = () => [
  `Step 'data:acl' { $owner = '*' + (OwnerSid); $keep = @('${SID.SYSTEM}', '${SID.ADMINS}', (OwnerSid)); foreach ($d in @($cfg.dataDirs)) { if ($d -and (Test-Path -LiteralPath $d)) { if (IsLink (Get-Item -LiteralPath $d -Force)) { throw ('The data folder is a link to somewhere else: ' + $d) }; icacls $d /setowner $owner /C /Q; icacls $d /inheritance:r /grant:r $grantSystem $grantAdmins ($owner + ':(OI)(CI)F') /C /Q; foreach ($r in @((Get-Acl -LiteralPath $d).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $s = $r.IdentityReference.Value; if ([string]$r.AccessControlType -eq 'Allow' -and $keep -notcontains $s) { icacls $d /remove:g ('*' + $s) /C /Q } }; $bad = DataProblems $d; if ($bad.Count -gt 0) { throw ('These must not stay in the data folder (another account may have put them there). Remove them, then run this again: ' + (($bad | Select-Object -First 10) -join '; ')) }; Get-ChildItem -LiteralPath $d -Force | ForEach-Object { icacls $_.FullName /setowner $owner /T /C /Q; icacls $_.FullName /reset /T /C /Q } } }; foreach ($f in @($cfg.secretFiles)) { if ($f -and (Test-Path -LiteralPath $f)) { icacls $f /setowner $owner /C /Q; icacls $f /reset /C /Q } } }`,
];
/** Removes the launcher and Hub copy older KeaS versions kept in "<data folder>\service" (only if it is one). */
const legacyLines = () => [
  `Step 'legacy:remove' { $ErrorActionPreference = 'Continue'; foreach ($l in @($cfg.legacy)) { if ($l -and (Test-Path -LiteralPath (Join-Path $l 'start-hub.cmd'))) { Remove-Item -LiteralPath $l -Recurse -Force -ErrorAction SilentlyContinue } } }`,
];
// Stops the Hub the task started (its launcher and the Hub from the service copy, or an older copy), matched by command
// line, so KeaS's own Hub and anything else on the PC are never touched.
const stopLines = () => [
  `Step 'hub:stop' { $ErrorActionPreference = 'Continue'; $paths = @($cfg.stopPaths | Where-Object { $_ }); Get-CimInstance Win32_Process | Where-Object { $cl = $_.CommandLine; $cl -and ($paths | Where-Object { $cl.Contains([string]$_) }) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
];
const taskRemoveLines = (stop) => [
  `Step 'task:end' { $ErrorActionPreference = 'Continue'; schtasks /End /TN ${psq(TASK_NAME)} 2>&1 | Out-Null; $global:LASTEXITCODE = 0 }`,
  ...(stop ? stopLines() : []),
  `Step 'task:delete' { $ErrorActionPreference = 'Continue'; schtasks /Query /TN ${psq(TASK_NAME)} 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN ${psq(TASK_NAME)} /F } else { $global:LASTEXITCODE = 0 } }`,
];
const serviceRemoveLines = () => [
  `Step 'service:remove' { $svc = ServiceDir; if (Test-Path -LiteralPath $svc) { Remove-Item -LiteralPath $svc -Recurse -Force } }`,
];
/** power: { key: value } to set. Lines for each, then make the scheme active again so they take effect. */
function powerLines(scheme, power) {
  const keys = Object.keys(power || {}).filter((k) => POWER[k] && Number.isFinite(power[k]));
  if (!keys.length) return [];
  return [...keys.map((key) => powerLine(scheme, key, power[key])), `Step 'power:apply' { powercfg /setactive ${checkScheme(scheme)} }`];
}

/**
 * The install (or change) script: put the service files in place with locked-down permissions, lock down the data
 * folder, and register the task from its XML; or remove it all when it's turned off (removeTask). Then set the power
 * settings (on the scheme that was active when the old values were read). `power` holds every value to set, including
 * old values put back for options that were turned off.
 */
function installScript({ power = {}, scheme = 'SCHEME_CURRENT', bootStart = true, removeTask = false, stop = false }) {
  const lines = [SCRIPT_HEAD];
  if (bootStart) {
    lines.push(...serviceLines(), ...dataAclLines());
    if (stop) lines.push(...stopLines());
    lines.push(...legacyLines(), `Step 'task' { schtasks /Create /TN ${psq(TASK_NAME)} /XML ([string]$cfg.xmlFile) /F }`, ...serviceOwnerLines());
  } else if (removeTask) lines.push(...taskRemoveLines(stop), ...serviceRemoveLines(), ...legacyLines());
  lines.push(...powerLines(scheme, power));
  lines.push(SCRIPT_TAIL);
  return lines.join('\n');
}

/** What to set: the targets, plus the saved old value for anything KeaS changed before that's now turned off. */
function powerPlan(opts, previous, powerWasApplied) {
  const plan = { ...powerTargets(opts) };
  if (powerWasApplied && previous?.values) for (const [k, v] of Object.entries(previous.values)) if (!(k in plan) && POWER[k] && Number.isFinite(v)) plan[k] = v;
  return plan;
}

/**
 * The undo script: stop and delete the task, remove the service folder, put back the saved power values. `stop`: also
 * stop the Hub the task started (passed when KeaS itself isn't the one running the Hub).
 */
function uninstallScript({ previous = null, removeTask = true, stop = false }) {
  const lines = [SCRIPT_HEAD];
  if (removeTask) lines.push(...taskRemoveLines(stop), ...serviceRemoveLines(), ...legacyLines());
  if (previous && previous.values) lines.push(...powerLines(previous.scheme || 'SCHEME_CURRENT', previous.values));
  lines.push(SCRIPT_TAIL);
  return lines.join('\n');
}

/** The settings file the elevated script reads (every folder and file name it uses). */
function scriptSettings({ config, files, ownerSid, manifest = [], resultFile = null }) {
  // (install() has already refused a folder name it doesn't accept; these are data for the script, never code.)
  const norm = (d) => (typeof d === 'string' && /^[A-Za-z]:\\/.test(d) ? path.win32.normalize(d).replace(/\\+$/, '') : null);
  const dataDir = norm(config?.dataDir);
  const storageDir = norm(config?.storageDir);
  const legacy = dataDir ? path.win32.join(dataDir, 'service') : null;
  return {
    ownerSid: ownerSid ? checkUserSid(ownerSid) : null,
    service: files.dir,
    stage: files.stage?.dir || null,
    xmlFile: files.xmlFile,
    dataDirs: [dataDir, storageDir && !storageDir.toLowerCase().startsWith(`${(dataDir || '').toLowerCase()}\\`) ? storageDir : null].filter(Boolean),
    secretFiles: dataDir ? SECRET_FILES.map((f) => path.win32.join(dataDir, f)) : [],
    stopPaths: [files.entry, files.launcher, ...(legacy ? [path.win32.join(legacy, 'hub', 'index.mjs'), path.win32.join(legacy, 'start-hub.cmd')] : [])],
    legacy: legacy ? [legacy] : [],
    manifest: manifest.map((m) => ({ path: m.path, sha256: m.sha256 })),
    resultFile,
  };
}

/** The runnable script: the template with its settings in it (base64 JSON, so a name can only ever be data). */
function composeScript(template, settings) {
  if (template.split(SETTINGS_SLOT).length !== 2) throw new Error('The script has no place for its settings.');
  return template.replace(SETTINGS_SLOT, Buffer.from(JSON.stringify(settings), 'utf8').toString('base64'));
}
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/**
 * The short command the elevated PowerShell runs (passed as -EncodedCommand): read the script file once, run it only
 * if it still has the hash KeaS wrote (exit 97 if not), from those same bytes.
 */
function elevateBootstrap(scriptFile, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad script hash');
  const p64 = Buffer.from(String(scriptFile), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${p64}'))`,
    '$b = [IO.File]::ReadAllBytes($p)',
    "$h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') })",
    `if ($h -ne '${hash}') { exit 97 }`,
    '$t = [Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)',
    '. ([scriptblock]::Create($t))',
  ].join('\n');
}
const encodedCommand = (text) => Buffer.from(text, 'utf16le').toString('base64');

/**
 * The PowerShell command (run un-elevated) that runs the check-then-run command elevated and waits: one Windows
 * permission prompt. The command (base64, from elevateBootstrap) is passed in the environment (KEAS_ELEVATE_CMD) and
 * given to the elevated PowerShell as -EncodedCommand: it never comes from a file another program could change.
 */
function elevateArgs() {
  const inner = "$c = $env:KEAS_ELEVATE_CMD; if (-not $c -or $c -notmatch '^[A-Za-z0-9+/=]+$') { exit 2 }; $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$c); exit $p.ExitCode";
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

// ---------- permissions (checked and repaired without elevation where Windows allows it) ----------
/** icacls arguments that give a folder SYSTEM, Administrators and the owner full control, and nobody else anything. */
function dataAclArgs(dir, ownerSid) {
  return [dir, '/inheritance:r', '/grant:r', `*${SID.SYSTEM}:(OI)(CI)F`, `*${SID.ADMINS}:(OI)(CI)F`, `*${checkUserSid(ownerSid)}:(OI)(CI)F`, '/C', '/Q'];
}
// Rights that let an account change or replace a file or folder.
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
/**
 * What's wrong with a folder's permissions (an empty list when nothing is): report is { owner, protected, aces:
 * [{ sid, rights, type }] } from aclReport(). writeOnly: other accounts may read (the service folder's code), but not
 * change; otherwise they may have no access at all (the data folder).
 */
function aclProblems(report, ownerSid, { writeOnly = false, owners = null } = {}) {
  if (!report) return ['the permissions couldn’t be read'];
  const ok = new Set([SID.SYSTEM, SID.ADMINS, ownerSid]);
  const out = [];
  if (!(owners || [...ok]).includes(report.owner)) out.push(`owned by another account (${report.owner})`);
  if (!report.protected) out.push('inherits permissions from the folder above it');
  for (const a of report.aces || []) {
    if (a.type !== 'Allow' || ok.has(a.sid)) continue;
    if (!writeOnly || (Number(a.rights) & WRITE_RIGHTS)) out.push(`${a.sid} has access`);
  }
  return out;
}

// ---------- side effects (thin wrappers) ----------
function run(file, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}
/** Runs a program with `input` on its standard input (UTF-8). */
function runInput(file, args, input, { timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const c = spawn(file, args, { windowsHide: true });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeout);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: 1, out, err: err || e.message }); } });
    c.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code: code ?? 1, out, err }); } });
    c.stdin.end(input);
  });
}
const SYS = () => path.join(systemRoot(), 'System32');
const powercfg = () => path.join(SYS(), 'powercfg.exe');
const schtasks = () => path.join(SYS(), 'schtasks.exe');
const icacls = () => path.join(SYS(), 'icacls.exe');
const whoami = () => path.join(SYS(), 'whoami.exe');
const powershell = () => path.join(SYS(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** `whoami /user /fo csv /nh` -> the SID. */
const parseWhoami = (text) => /"(S-1-[0-9-]+)"/.exec(String(text || ''))?.[1] ?? null;
let sidCache = null;
async function currentUserSid() {
  if (sidCache) return sidCache;
  const r = await run(whoami(), ['/user', '/fo', 'csv', '/nh']);
  const sid = parseWhoami(r.out);
  if (!sid) throw new Error('Couldn’t read this Windows account’s ID.');
  return (sidCache = checkUserSid(sid));
}
// Reads a folder's owner and access rules as SIDs (the same in every Windows language). The path goes in the
// environment, never into the command text.
const ACL_REPORT = "$a = Get-Acl -LiteralPath $env:KEAS_ACL_PATH; $t = [Security.Principal.SecurityIdentifier]; @{ owner = $a.GetOwner($t).Value; protected = $a.AreAccessRulesProtected; aces = @($a.GetAccessRules($true, $true, $t) | ForEach-Object { @{ sid = $_.IdentityReference.Value; rights = [int64]$_.FileSystemRights; type = [string]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress";
async function aclReport(dir) {
  const r = await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ACL_REPORT], { env: { KEAS_ACL_PATH: dir } });
  try { const j = JSON.parse(r.out); return { owner: j.owner, protected: !!j.protected, aces: Array.isArray(j.aces) ? j.aces : j.aces ? [j.aces] : [] }; } catch { return null; }
}

/**
 * Everything in a folder, found without following links: { entries, links, hardLinks }. links: junctions and symbolic
 * links (an icacls /T would follow them out of the folder); hardLinks: files that also have another name somewhere
 * else (their permissions are shared with that other name).
 */
function walkFolder(dir) {
  const entries = [], links = [], hardLinks = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      let st;
      try { st = fs.lstatSync(p); } catch { links.push(p); continue; }
      if (st.isSymbolicLink()) { links.push(p); continue; }
      entries.push(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.nlink > 1) hardLinks.push(p);
    }
  }
  return { entries, links, hardLinks };
}
// The owners of many files at once (SIDs, '' when one can't be read). The list goes in on standard input.
const OWNERS_PS = "$l = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json; $t = [Security.Principal.SecurityIdentifier]; $o = @(foreach ($p in @($l)) { try { (Get-Acl -LiteralPath $p).GetOwner($t).Value } catch { '' } }); ConvertTo-Json -Compress -InputObject $o";
async function ownersOf(paths) {
  if (!paths.length) return [];
  const r = await runInput(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', OWNERS_PS], Buffer.from(JSON.stringify(paths), 'utf8').toString('base64'));
  try { const j = JSON.parse(r.out); const a = Array.isArray(j) ? j : [j]; return paths.map((_, i) => String(a[i] ?? '')); } catch { return paths.map(() => ''); }
}
const short = (list, root) => list.slice(0, 5).map((p) => path.relative(root, p) || p).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
/**
 * Refuses a folder that holds what another account could have slipped in while it was open: links, hard-linked files,
 * or anything owned by another account (not this one, SYSTEM or Administrators).
 */
async function checkContents(dir, sid, owners) {
  const { entries, links, hardLinks } = walkFolder(dir);
  const ownerOf = await owners(entries);
  const foreign = entries.filter((_, i) => ![sid, SID.SYSTEM, SID.ADMINS].includes(ownerOf[i]));
  const found = [];
  if (links.length) found.push(`links to other places (${short(links, dir)})`);
  if (hardLinks.length) found.push(`files that also have another name somewhere else (hard links: ${short(hardLinks, dir)})`);
  if (foreign.length) found.push(`files or folders that belong to another Windows account (${short(foreign, dir)})`);
  if (found.length) throw new Error(`KeaS can’t lock this folder down: it has ${found.join('; ')}. Another account on this PC could have put them there while the folder was open to everyone. Remove them (or move your data to a new folder), then start KeaS again.`);
}

/**
 * Makes a data folder safe to use: a new folder is made and locked down at once (and must still be empty afterwards, so
 * nothing could be slipped in first); an existing one must belong to this account, and is locked down if it isn't
 * already. Only SYSTEM, Administrators and this account can then open anything in it. No elevation needed: the owner of
 * a folder may always set its permissions.
 *
 * Locking down an existing folder that was open: its contents are checked first (no links, no hard links, nothing
 * owned by another account; see checkContents), then everything inside is made to inherit the folder's permissions
 * (icacls /reset /T), then checked again. Returns { ok, changed, wasOpen }: wasOpen means secrets in it may have been
 * read while it was open, so the caller makes new ones (rotateHubSecrets).
 */
async function secureDataFolder(dir, { sid, report = aclReport, apply = (d, s) => run(icacls(), dataAclArgs(d, s)), removeGrant = (d, s) => run(icacls(), [d, '/remove:g', `*${s}`, '/C', '/Q']), owners = ownersOf, reset = (p) => run(icacls(), [p, '/reset', '/T', '/C', '/Q'], { timeout: 10 * 60_000 }) } = {}) {
  dir = validateDataDir(dir);
  if (process.platform !== 'win32') { fs.mkdirSync(dir, { recursive: true }); return { ok: true, changed: false, wasOpen: false }; }
  sid = sid || (await currentUserSid());
  const existed = fs.existsSync(dir);
  if (existed && fs.lstatSync(dir).isSymbolicLink()) throw new Error('That folder is a link to somewhere else. Pick the real folder, or make a new one.');
  if (existed && !fs.statSync(dir).isDirectory()) throw new Error('That’s a file, not a folder.');
  if (!existed) fs.mkdirSync(dir, { recursive: true });
  const before = await report(dir);
  if (existed && before && ![sid, SID.ADMINS, SID.SYSTEM].includes(before.owner)) throw new Error('That folder belongs to another Windows account. Pick a different folder, or make a new one.');
  if (!existed || aclProblems(before, sid).length) {
    const r = await apply(dir, sid);
    if (r.code !== 0) throw new Error(`Couldn’t set the folder’s permissions (${(r.err || r.out || `code ${r.code}`).trim().slice(0, 200)}). Use a folder on a drive formatted as NTFS, so other accounts on this PC can’t open the data.`);
    let after = await report(dir);
    // /grant:r replaces only the named accounts' entries: take away any other account's own entry too.
    const extra = [...new Set((after?.aces || []).filter((a) => a.type === 'Allow' && ![SID.SYSTEM, SID.ADMINS, sid].includes(a.sid)).map((a) => a.sid))];
    for (const s of extra) if (/^S-1-[0-9-]+$/.test(s)) await removeGrant(dir, s);
    if (extra.length) after = await report(dir);
    const left = aclProblems(after, sid);
    if (left.length) throw new Error(`The folder’s permissions are still too open: ${left.join('; ')}.`);
    if (!existed && fs.readdirSync(dir).length) throw new Error('Something was put in the new folder before KeaS could lock it. Pick a different folder.');
    if (existed) {
      await checkContents(dir, sid, owners);
      for (const name of fs.readdirSync(dir)) {
        const rr = await reset(path.join(dir, name));
        if (rr.code !== 0) throw new Error(`Couldn’t reset the permissions of ${name} (${(rr.err || rr.out || `code ${rr.code}`).trim().slice(0, 200)}).`);
      }
      await checkContents(dir, sid, owners);
    }
    return { ok: true, changed: true, wasOpen: existed };
  }
  return { ok: true, changed: false, wasOpen: false };
}

/**
 * After a Hub data folder that was open to other accounts is locked down: its owner key and signing key may have been
 * read, so they're wiped and removed, and the Hub makes new ones when it starts (it creates both when they're
 * missing). Payroll vaults that trusted the old signing key then ask the owner to check and accept the new one.
 * Returns the names removed.
 */
function rotateHubSecrets(dataDir) {
  const gone = [];
  for (const name of ['owner.key', 'hub-signing-key.pem']) {
    const f = path.join(dataDir, name);
    try {
      const st = fs.lstatSync(f);
      if (st.isFile()) fs.writeFileSync(f, Buffer.alloc(st.size));
      fs.rmSync(f, { force: true });
      gone.push(name);
    } catch {}
  }
  return gone;
}

/** The real path of `p` when it's `root` or a folder inside it (links resolved first); otherwise null. */
function folderInside(root, p) {
  if (!root || typeof p !== 'string' || !p.trim()) return null;
  let r, t;
  try { r = fs.realpathSync.native(path.resolve(root)); t = fs.realpathSync.native(path.resolve(p)); } catch { return null; }
  const rel = path.relative(r, t);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(t).isDirectory()) return null; } catch { return null; }
  return t;
}

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

/**
 * Copies the Hub's files (never its data folder) to toDir, file by file (works out of app.asar too). onFile(rel, bytes)
 * hears about each file written (for the hashes the elevated script checks).
 */
function copyHub(fromDir, toDir, onFile = () => {}) {
  const walk = (src, dst, rel) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'data' && src === fromDir) continue;
      const s = path.join(src, name), d = path.join(dst, name), r = rel ? `${rel}\\${name}` : name;
      if (fs.statSync(s).isDirectory()) walk(s, d, r);
      else { const b = fs.readFileSync(s); fs.writeFileSync(d, b); onFile(r, b); }
    }
  };
  walk(fromDir, toDir, '');
}

/**
 * Writes the Hub copy, the launcher, the task XML and version.txt into `to` (the staging folder or the service folder).
 * Returns the manifest: [{ path (relative, backslashes), sha256 }] of exactly the bytes written.
 */
function writeServiceFiles(to, { config, exe, hubSource, version, opts, port = 4860, userId = currentUser(), files }) {
  validateDataDir(config.dataDir);
  if (config.storageDir) validateDataDir(config.storageDir, 'The storage folder');
  fs.mkdirSync(to, { recursive: true });
  const manifest = [];
  const put = (rel, bytes) => { fs.writeFileSync(path.join(to, rel), bytes); manifest.push({ path: rel, sha256: sha256Hex(bytes) }); };
  const hubDir = path.join(to, 'hub');
  fs.rmSync(hubDir, { recursive: true, force: true });
  copyHub(hubSource, hubDir, (rel, b) => manifest.push({ path: `hub\\${rel}`, sha256: sha256Hex(b) }));
  put('start-hub.cmd', Buffer.from(launcherCmd({ exe, entry: files.entry, env: hubEnv(config, { port }), logFile: files.logFile })));
  // Task Scheduler wants the XML as UTF-16 with a byte-order mark.
  put('kea-hub-task.xml', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ userId, launcher: files.launcher, workDir: files.hubDir, opts }), 'utf16le')]));
  put('version.txt', Buffer.from(String(version || '')));
  return manifest;
}
/** Stages the service files in KeaS's own folder (the elevated script copies them into the service folder). */
function prepareFiles({ config, exe, hubSource, version, opts, port = 4860, userId = currentUser(), stageDir, service = serviceDir() }) {
  if (!stageDir) throw new Error('Missing the staging folder.');
  const files = planFiles({ service, stageDir });
  files.manifest = writeServiceFiles(stageDir, { config, exe, hubSource, version, opts, port, userId, files });
  return files;
}
/** Removes the copies an install moved aside in the service folder (un-elevated: the owner may change files there). */
function cleanOldCopies(service = serviceDir()) {
  try { for (const n of fs.readdirSync(service)) if (/^\.old-[0-9a-f]{32}$/.test(n)) fs.rmSync(path.join(service, n), { recursive: true, force: true }); } catch {}
}
/**
 * Updates the installed service files in place (after KeaS was updated, or its settings changed), only if the service
 * folder's permissions are still the locked-down ones. Returns 'updated', 'current', 'missing' or 'repair' (the
 * permissions changed: run "Start before sign-in" again, which asks Windows for permission and fixes them).
 */
async function refreshService({ config, exe, hubSource, version, opts, port, userId = currentUser(), service = serviceDir(), sid, force = false, report = aclReport }) {
  if (!fs.existsSync(path.join(service, 'start-hub.cmd'))) return 'missing';
  const vf = path.join(service, 'version.txt');
  const had = fs.existsSync(vf) ? fs.readFileSync(vf, 'utf8') : '';
  if (!force && had === String(version)) return 'current';
  if (process.platform === 'win32') {
    sid = sid || (await currentUserSid());
    if (aclProblems(await report(service), sid, { writeOnly: true, owners: [SID.ADMINS, SID.SYSTEM] }).length) return 'repair';
  }
  writeServiceFiles(service, { config, exe, hubSource, version, opts, port, userId, files: planFiles({ service }) });
  cleanOldCopies(service);
  return 'updated';
}

const currentUser = () => `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;

/**
 * Runs a script elevated (one permission prompt) and returns what it reported. The script reads `settings` from the
 * JSON file written next to it. dryRun: returns the script and the settings only.
 */
async function runElevated(script, { dir, name, settings, dryRun = false }) {
  const scriptFile = path.join(dir, `${name}.ps1`);
  const settingsFile = path.join(dir, `${name}.json`);
  // A result file name only this run knows (the elevated script won't write through a link, or over a file).
  const resultFile = path.join(dir, `${name}.result-${crypto.randomBytes(12).toString('hex')}.json`);
  const full = { ...settings, resultFile };
  const json = JSON.stringify(full, null, 1);
  if (dryRun) return { dryRun: true, script: `${script}\n# ${name}.json (the names this script uses, base64 inside it):\n${json.split('\n').map((l) => `# ${l}`).join('\n')}\n`, settings: full, scriptFile };
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) if (n.startsWith(`${name}.result`)) fs.rmSync(path.join(dir, n), { force: true });
  // UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads non-English folder names right. The elevated side
  // runs it only if it still has this hash (elevateBootstrap); the .json copy is for people to read.
  const bytes = Buffer.from('\ufeff' + composeScript(script, full), 'utf8');
  fs.writeFileSync(scriptFile, bytes);
  fs.writeFileSync(settingsFile, json);
  const r = await run(powershell(), elevateArgs(), { timeout: 5 * 60_000, env: { KEAS_ELEVATE_CMD: encodedCommand(elevateBootstrap(scriptFile, sha256Hex(bytes))) } });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\ufeff/, '')); } catch {}
  if (!result) {
    if (r.code === 97) throw new Error('The script KeaS wrote was changed before Windows ran it, so nothing was done. Something else on this PC may be tampering with KeaS’s files; run a malware scan, then try again.');
    if (/cancel/i.test(r.err + r.out)) throw new Error('Windows asked for permission and it was declined. Nothing was changed.');
    throw new Error(`The change didn’t run (${(r.err || r.out || `code ${r.code}`).trim().slice(0, 300)}).`);
  }
  const steps = Array.isArray(result.steps) ? result.steps : [result.steps].filter(Boolean);
  return { ok: !!result.ok, steps };
}

/**
 * Turns it on: stages the files, saves the current power values (unless already saved from an earlier install, so
 * undo always goes back to how the PC was before KeaS), then one elevated script.
 */
async function install({ config, exe, hubSource, version, opts, port = 4860, previous = null, wasInstalled = false, powerWasApplied = false, stopHub = false, dryRun = false, stageDir, service = serviceDir(), ownerSid = null }) {
  if (!config?.dataDir) throw new Error('Set up the Hub’s data folder first.');
  if (!stageDir) throw new Error('Missing the staging folder.');
  validateDataDir(config.dataDir);
  const o = options(opts);
  const files = dryRun || !o.bootStart ? planFiles({ service, stageDir }) : prepareFiles({ config, exe, hubSource, version, opts: o, port, stageDir, service });
  const sid = ownerSid || (await currentUserSid().catch((e) => { if (dryRun) return 'S-1-5-21-0-0-0-1000'; throw e; }));
  const before = previous || (await readPower());
  const power = powerPlan(o, before, powerWasApplied);
  const script = installScript({ power, scheme: before.scheme || 'SCHEME_CURRENT', bootStart: o.bootStart, removeTask: wasInstalled, stop: stopHub });
  const settings = scriptSettings({ config, files, ownerSid: sid, manifest: files.manifest || [] });
  const r = await runElevated(script, { dir: stageDir, name: 'install', settings, dryRun });
  if (!dryRun) cleanOldCopies(service);
  return { ...r, previous: before, files, options: o, power, layout: LAYOUT };
}
async function uninstall({ config, previous = null, stopHub = false, removeTask = true, dryRun = false, stageDir, service = serviceDir() }) {
  if (!stageDir) throw new Error('Missing the staging folder.');
  const script = uninstallScript({ previous, removeTask, stop: stopHub });
  const settings = scriptSettings({ config: config?.dataDir ? config : null, files: planFiles({ service, stageDir }), ownerSid: null });
  return runElevated(script, { dir: stageDir, name: 'uninstall', settings, dryRun });
}

/**
 * Is OUR Kea Hub already answering on this port (started before sign-in by the task)? Answering as a Kea Hub isn't
 * enough: it must also prove it holds the signing key in `dataDir` (desktop/hubid.cjs), so a program another Windows
 * account started on the port is never taken for it.
 */
async function hubAnswering(port, { dataDir = null, timeoutMs = 1500, fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = await r.json();
    if (j?.service !== 'kea-hub') return false;
  } catch { return false; }
  return require('./hubid.cjs').verifyHubIdentity(port, dataDir, { timeoutMs: Math.max(timeoutMs, 1500), fetchFn });
}

const POWER_LOSS_NOTE = 'To have this PC turn itself back on after a power cut, turn on "Restore on AC power loss" (some PCs call it "AC Power Recovery" or "After Power Failure: Power On") in its BIOS/UEFI settings. Windows can’t change that setting: restart the PC, press the key it shows for Setup (often Del, F2 or F10), and look under Power or Advanced. With that on, the Kea Hub comes back by itself, before anyone signs in.';

module.exports = {
  TASK_NAME, DEFAULTS, POWER, POWER_LOSS_NOTE, SID, LAYOUT, SECRET_FILES, CLEARED_PREFIXES, CLEARED_VARS,
  options, hubEnv, launcherCmd, taskXml, powerTargets, powerPlan, parsePowerQuery, installScript, uninstallScript, scriptSettings, elevateArgs, parseTaskQuery,
  readPower, taskStatus, prepareFiles, refreshService, planFiles, serviceDir, install, uninstall, hubAnswering, currentUser, currentUserSid, parseWhoami, copyHub, cmdSetValue, psq,
  validateDataDir, checkUserSid, dataAclArgs, aclProblems, aclReport, secureDataFolder, walkFolder, ownersOf, rotateHubSecrets, folderInside,
  composeScript, elevateBootstrap, encodedCommand, writeServiceFiles, cleanOldCopies,
  // For tests: the pieces the scripts are made of.
  scriptParts: { head: SCRIPT_HEAD, tail: SCRIPT_TAIL, serviceLines, serviceOwnerLines, dataAclLines, legacyLines },
};
