// KeaS desktop: the app you download. On first run it walks you through setting up this PC as a server:
//   - the Kea Hub (Kea's creator only: accounts, classes, study, storage for everyone), or
//   - an organization's KeaS server (schedules, time clock, payroll prep for one org),
// picking which drive holds the data, setting up Tailscale so it's reachable from anywhere, and (for the Hub) making
// the owner account. After that it runs the server in the background, starts with Windows, and sits in the tray.
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const tailscale = require('./tailscale.cjs');
const { verifyHubIdentity } = require('./hubid.cjs');
const bootstart = require('./bootstart.cjs');
const { createUpdates } = require('./updates.cjs');
const ownerLib = require('./owner.cjs');
const flow = require('./flow.cjs');
const { createAccount } = require('./account.cjs');

// Only the Hub's owner runs the Hub: its setup is there only with this switch, or on a PC that already runs a Hub.
const HOST_HUB = process.argv.includes(flow.HOST_HUB);

const ROOT = path.join(__dirname, '..');
const HUB_PORT = 4860;
const ORG_PORT = 4850;
const configFile = () => path.join(app.getPath('userData'), 'keas-config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
/** The config the setup page may see (no secrets, not even DPAPI-protected ones). */
const publicConfig = () => ({ ...config, googleClientSecret: undefined, orgVaultKey: undefined });
const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 1)); return c; };
let config = {};
let win = null, tray = null;
const hubMode = () => flow.hubMode({ argv: process.argv, config });
// The Kea account this KeaS is signed in to (account.cjs): the session is kept encrypted by Windows.
let accountApi = null;
const account = () => (accountApi ||= createAccount({
  dir: app.getPath('userData'),
  protect: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) },
  getUrl: () => config.accountHubUrl || null,
  setUrl: (u) => { config = writeConfig({ ...config, accountHubUrl: u || null }); },
  client: `KeaS/${app.getVersion()}`,
}));
let hub = null, org = null;
// The Hub started before sign-in by the Scheduled Task (bootstart.cjs) is a separate process: KeaS then uses it instead
// of starting its own, and starts its own only if that one stops answering.
let hubExternal = false, hubWatch = null, extDb = null;
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'keas.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };

// Developer aids: KEAS_USERDATA runs a separate profile (and never touches Kea's settings or Windows startup);
// KEAS_CAPTURE=file.png with KEAS_EVAL=script.js runs the script in the setup page, saves a screenshot, and quits.
// (KEAS_CAPTURE and KEAS_EVAL work only when running from source, never in the installed app.)
const DEV = !!process.env.KEAS_USERDATA;
if (DEV) app.setPath('userData', process.env.KEAS_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- the servers, run inside this app (Electron includes Node 24: SQLite and Argon2 built in) ----------
// The data folder is locked down (only this Windows account, SYSTEM and Administrators can open it) before anything
// is written there; an older setup's folder is fixed the next time KeaS starts. A problem is logged and shown. A drive
// that can't hold permissions is still used, with a warning.
let folderProblem = null;
let folderWarning = null;
// Why the Hub didn't start the last time KeaS tried (shown on the status screen, with Retry and Open log).
let lastStartError = null;
const FOLDER_WARNING = 'KeaS can’t limit who opens this folder, because of how the drive is formatted or who owns the folder. Anyone with another Windows account on this PC, or a program running under one, may be able to read or change the Hub’s keys and everyone’s files.';
async function secureFolders() {
  folderProblem = null;
  folderWarning = null;
  for (const [dir, label] of [[config.dataDir, 'The data folder'], [config.storageDir, 'The storage folder']]) {
    // (A storage folder inside the data folder already inherits its permissions.)
    if (!dir || (dir !== config.dataDir && dir.toLowerCase().startsWith(`${String(config.dataDir).toLowerCase()}\\`))) continue;
    try {
      // It was open to other accounts: the Hub's owner key and signing key may have been read, so the Hub makes new
      // ones as it starts (payroll then asks the owner to check and accept the new signing key). Once, even if the
      // folder had to be refused at first and only comes clean at a later start.
      const r = await bootstart.secureDataFolder(dir, { onWasOpen: () => { if (dir === config.dataDir && config.role === 'hub') log('replaced the Hub keys after locking down its folder:', bootstart.rotateHubSecrets(dir).join(', ') || 'none there'); } });
      if (r.changed) log('locked down', dir);
      if (r.unlocked) { folderWarning = FOLDER_WARNING; log('not locked down', dir, r.unlocked); }
    }
    catch (e) { folderProblem = `${label}: ${e.message}`; log('folder permissions', dir, e.message); }
  }
}
/**
 * The organization server's vault passphrase: random, kept only in KeaS's settings encrypted with Windows DPAPI
 * (safeStorage), so it never sits in a file next to the database. A key file left by an older KeaS is moved in and
 * then deleted.
 */
function orgVaultPassphrase() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows can’t protect the organization server’s key on this PC (DPAPI isn’t available).');
  if (config.orgVaultKey) return { pass: safeStorage.decryptString(Buffer.from(config.orgVaultKey, 'base64')), legacy: null };
  const legacy = path.join(config.dataDir, 'org.db.vaultkey');
  const had = fs.existsSync(legacy);
  const pass = had ? fs.readFileSync(legacy, 'utf8').trim() : crypto.randomBytes(32).toString('base64url');
  config = writeConfig({ ...config, orgVaultKey: safeStorage.encryptString(pass).toString('base64') });
  return { pass, legacy: had ? legacy : null };
}
function removeKeyFile(file) {
  try { const n = fs.statSync(file).size; fs.writeFileSync(file, Buffer.alloc(n)); fs.rmSync(file, { force: true }); log('moved the vault key into Windows-protected settings'); } catch (e) { log('key file', e.message); }
}
async function startServices() {
  if (config.dataDir && !hub && !org && !hubExternal) await secureFolders();
  // A folder that was refused isn't used at all, not even by a Hub that started before sign-in.
  if (folderProblem) {
    if (config.role === 'hub') {
      const stopped = await bootstart.stopRecordedHub(config.dataDir, HUB_PORT);
      if (stopped) log('stopped the Hub that started before sign-in, because its folder was refused', stopped);
    }
    throw new Error(folderProblem);
  }
  if (config.role === 'hub' && !hub && await bootstart.hubAnswering(HUB_PORT, { dataDir: config.dataDir })) {
    if (!hubExternal) log('hub already running (started before sign-in); using it');
    hubExternal = true;
    watchExternalHub();
  } else if (config.role === 'hub' && !hub) {
    hubExternal = false;
    const { createHub } = await import(pathToFileURL(path.join(ROOT, 'hub', 'index.mjs')).href);
    hub = createHub({
      dataDir: config.dataDir, storageDir: config.storageDir, log: false,
      defaultQuotaBytes: (config.quotaGb || 5) * 1024 ** 3,
      ipHeader: config.tailscale ? 'x-forwarded-for' : null,
      googleClientIds: config.googleClientIds || [],
      googleWebClientId: config.googleWebClientId || null,
      publicUrl: config.publicUrl || null,
    });
    await hub.listen({ port: HUB_PORT, ownerPort: HUB_PORT + 1 });
    log('hub started', config.dataDir);
  }
  if (config.role === 'org' && !org) {
    const { createApp } = await import(pathToFileURL(path.join(ROOT, 'server', 'index.mjs')).href);
    const { pass, legacy } = orgVaultPassphrase();
    // (Never the demo sign-in here; the Funnel address is the only other name it answers to.)
    org = createApp({ dbFile: path.join(config.dataDir, 'org.db'), log: false, passphrase: pass, devKeyFile: false, demo: false, publicHosts: config.publicUrl ? [config.publicUrl] : [] });
    if (legacy) removeKeyFile(legacy);
    await org.listen(ORG_PORT);
    log('org server started', config.dataDir);
  }
}
const servicePort = () => (config.role === 'hub' ? HUB_PORT : ORG_PORT);
function watchExternalHub() {
  if (hubWatch) return;
  hubWatch = setInterval(async () => {
    if (!hubExternal || await bootstart.hubAnswering(HUB_PORT, { dataDir: config.dataDir })) return;
    log('the Hub started before sign-in stopped answering; starting it here');
    hubExternal = false;
    try { await startServices(); } catch (e) { log('start failed', e.message); }
    refreshTray();
  }, 60_000);
}
/** The Hub's database: from the Hub running in KeaS, or opened directly when the before-sign-in Hub is running. */
async function hubDb() {
  if (hub) return hub.h;
  if (!hubExternal) throw new Error('Start the Hub first.');
  if (!extDb) {
    const { openDb } = await import(pathToFileURL(path.join(ROOT, 'hub', 'db.mjs')).href);
    extDb = openDb(path.join(config.dataDir, 'hub.db'));
  }
  return extDb;
}
const hubRunning = () => !!hub || hubExternal;

// ---------- start before sign-in, and power settings ----------
// The files the task uses are staged in KeaS's own folder, then copied into "<Program Files>\KeaS Hub Service" by the
// elevated script (see bootstart.cjs).
const bootArgs = () => ({ config, exe: process.execPath, hubSource: path.join(ROOT, 'hub'), version: app.getVersion(), port: HUB_PORT, stageDir: path.join(app.getPath('userData'), 'hub-service') });
async function bootStatus() {
  const task = await bootstart.taskStatus();
  let power = null;
  try { power = await bootstart.readPower(); } catch {}
  return {
    task, power, external: hubExternal, saved: config.boot || null, options: bootstart.options(config.boot?.options),
    defaults: bootstart.DEFAULTS, note: bootstart.POWER_LOSS_NOTE, taskName: bootstart.TASK_NAME, testProfile: DEV,
    // Set up by an older KeaS (the launcher in the data folder), or its folder's permissions changed: run it again.
    needsUpdate: !!config.boot?.installed && (config.boot.layout !== bootstart.LAYOUT || !!config.boot.repair),
    serviceDir: bootstart.serviceDir(), folderProblem,
  };
}
const TEST_PROFILE = 'A test profile (KEAS_USERDATA) never changes Windows settings. Use "Show what it runs" instead.';
async function bootApply(opts = {}, dryRun = false) {
  if (config.role !== 'hub') throw new Error('Starting before sign-in is for the Kea Hub.');
  if (DEV && !dryRun) throw new Error(TEST_PROFILE);
  const o = bootstart.options(opts);
  const was = config.boot || {};
  const r = await bootstart.install({
    ...bootArgs(), opts: o, dryRun,
    // The values from before KeaS first changed anything, so turning it off always goes back to those.
    previous: was.powerApplied ? was.previous : null, powerWasApplied: !!was.powerApplied,
    wasInstalled: !!was.installed, stopHub: hubExternal,
  });
  if (dryRun) return r;
  const ok = (name) => r.steps.some((s) => s.step === name && s.ok);
  const installed = o.bootStart ? ok('task') : (!!was.installed && !ok('task:delete'));
  const powerOn = Object.keys(bootstart.powerTargets(o)).length > 0;
  const powerApplied = powerOn ? (ok('power:apply') || !!was.powerApplied) : (!!was.powerApplied && !ok('power:apply'));
  config = writeConfig({ ...config, boot: { options: o, installed, layout: installed ? (ok('service:copy') ? bootstart.LAYOUT : was.layout || 1) : null, repair: false, powerApplied, previous: powerApplied ? r.previous : null, at: Date.now(), steps: r.steps } });
  if (!o.bootStart && was.installed && hubExternal && !installed) { hubExternal = false; if (extDb) { try { extDb.close(); } catch {} extDb = null; } await startServices().catch((e) => log('start failed', e.message)); }
  refreshTray();
  return { ok: r.ok, steps: r.steps, status: await bootStatus() };
}
async function bootRemove(dryRun = false) {
  if (DEV && !dryRun) throw new Error(TEST_PROFILE);
  const r = await bootstart.uninstall({ config, previous: config.boot?.powerApplied ? config.boot.previous : null, stopHub: hubExternal, dryRun, stageDir: bootArgs().stageDir });
  if (dryRun) return r;
  if (r.ok) {
    config = writeConfig({ ...config, boot: { options: bootstart.options(config.boot?.options), installed: false, powerApplied: false, previous: null, at: Date.now(), steps: r.steps } });
    hubExternal = false;
    if (extDb) { try { extDb.close(); } catch {} extDb = null; }
    await startServices().catch((e) => log('start failed', e.message));
  }
  refreshTray();
  return { ok: r.ok, steps: r.steps, status: await bootStatus() };
}

// ---------- windows and tray ----------
function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 420, minHeight: 560, title: 'KeaS', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f7f7f5',
    autoHideMenuBar: true, icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'setup', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // Closing the window keeps KeaS (and the Hub) running in the tray, when it has one.
    if (tray && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => (win = null));
  if (process.env.KEAS_CAPTURE && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.KEAS_EVAL) {
        try { console.log('[eval]', JSON.stringify(await win.webContents.executeJavaScript(fs.readFileSync(process.env.KEAS_EVAL, 'utf8')))); }
        catch (e) { console.log('[eval error]', e.message); }
      }
      for (let i = 0; i < 4; i++) {
        try { win.show(); win.focus(); await new Promise((r) => setTimeout(r, 400)); fs.writeFileSync(process.env.KEAS_CAPTURE, (await win.webContents.capturePage()).toPNG()); break; } catch (e) { console.log('[capture error]', e.message); }
      }
      app.isQuitting = true;
      try { await hub?.close(); await org?.close(); } catch {}
      app.exit(0);
    }, Number(process.env.KEAS_CAPTURE_DELAY || 1500)));
  }
}
/** KeaS's icon (the window, the tray and the installer use the same one). */
const ICON_FILE = path.join(__dirname, 'icon.png');
const appIcon = () => { const i = nativeImage.createFromPath(ICON_FILE); return i.isEmpty() ? undefined : i; };
function makeTray() {
  if (tray) return;
  const icon = appIcon();
  tray = new Tray(icon ? icon.resize({ width: 16, height: 16, quality: 'best' }) : nativeImage.createEmpty());
  tray.setToolTip(config.role === 'hub' ? 'KeaS · Kea Hub running' : 'KeaS · server running');
  tray.on('click', showWindow);
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  const isHub = config.role === 'hub' && hubMode();
  if (!isHub && config.role !== 'org') {
    // Not a Hub PC: KeaS only waits in the tray (it started with Windows). Nothing in it runs a server.
    tray.setToolTip('KeaS');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open KeaS', click: showWindow },
      { label: 'Payroll', click: () => trayPayroll() },
      ...(updates?.state().status === 'ready' ? [{ type: 'separator' }, { label: `Restart to update KeaS to ${updates.state().version}`, click: () => installUpdate() }] : []),
      { type: 'separator' },
      { label: 'Quit KeaS', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    return;
  }
  const installed = !!config.boot?.installed;
  tray.setToolTip(isHub ? (hubExternal ? 'KeaS · Kea Hub running (started before sign-in)' : 'KeaS · Kea Hub running') : 'KeaS · server running');
  const toggle = async () => {
    try {
      // (Only the task: the power settings stay as they are. "Power settings…" changes or undoes those.)
      const r = await bootApply({ ...(config.boot?.options || { power: false }), bootStart: !installed });
      if (!r.ok) dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: 'Part of it didn’t work.', detail: r.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.error}`).join('\n') });
    } catch (e) { dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: e.message }); }
    refreshTray();
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeaS', click: showWindow },
    { label: 'Payroll', click: () => trayPayroll() },
    ...(isHub ? [
      { type: 'separator' },
      { label: 'Start the Hub before sign-in', type: 'checkbox', checked: installed, click: toggle },
      { label: 'Startup and power…', click: () => navigate('settings') },
    ] : []),
    ...(updates?.state().status === 'ready' ? [{ type: 'separator' }, { label: `Restart to update KeaS to ${updates.state().version}`, click: () => installUpdate() }] : []),
    { type: 'separator' },
    { label: hubExternal ? 'Quit KeaS (the Hub keeps running)' : 'Quit KeaS (stops the server)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------- Payroll (the payroll vault, on this PC only; see payroll.cjs) ----------
let payrollApi = null;
const payroll = () => (payrollApi ||= require('./payroll.cjs').createPayroll({
  getConfig: () => config, setConfig: (patch) => { config = writeConfig({ ...config, ...patch }); }, userData: app.getPath('userData'), root: ROOT, hubPort: HUB_PORT, log,
  account: account(), icon: appIcon(),
  // Locked (a quiet spell, or Lock): the Payroll window closes and KeaS asks for the passphrase again when it's opened.
  onLocked: (why) => navigate('payroll', { locked: why }),
}));
const openPayroll = () => payroll().open().catch((e) => { log('payroll', e.message); throw e; });
app.on('before-quit', () => { payrollApi?.forget(); });
/** Shows the KeaS window on a screen ('payroll': its Payroll panel; 'settings': Startup and power). */
function navigate(view, extra) {
  const had = !!win;
  showWindow();
  setTimeout(() => send('navigate', { view, ...extra }), !had || win?.webContents.isLoading() ? 900 : 0);
}
/** The tray's Payroll: opens it, asks in the KeaS window what it needs, or says why it can't. */
async function trayPayroll() {
  try {
    const r = await openPayroll();
    if (r?.need) navigate('payroll', { open: r });
  } catch (e) {
    if (e.data?.need === 'signin') return navigate('signin');
    const r = await dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: 'Payroll didn’t open.', detail: e.message, buttons: ['Open KeaS', 'Close'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) showWindow();
  }
}
/** Restart and update (the tray's item; the page asks first itself). */
async function installUpdate() {
  try { updates.install(); } catch (e) { log('update', e.message); }
}

// ---------- drives ----------
function drives() {
  const out = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${L}:\\`;
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      if (total > 0) out.push({ letter: L, root, total, free });
    } catch {}
  }
  return out;
}
/** A folder KeaS may keep data in: checked (bootstart.validateDataDir), made if needed, locked down to this account if the drive allows it, and written to. */
async function checkFolder(dir, label) {
  dir = bootstart.validateDataDir(dir, label);
  const secured = await bootstart.secureDataFolder(dir);
  if (secured.unlocked) log('not locked down', dir, secured.unlocked);
  const probe = path.join(dir, `.keas-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  const s = fs.statfsSync(dir);
  return { ok: true, free: s.bavail * s.bsize, dir, warning: secured.unlocked ? FOLDER_WARNING : null };
}

// ---------- IPC for the setup screens ----------
const send = (ch, v) => win?.webContents.send(ch, v);
const handle = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  // (What the Hub said besides the message, like totpRequired, goes along so the page can show the right step.)
  try { return { ok: true, value: await fn(arg || {}) }; } catch (e) { log('error', name, e.message); return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null }; }
});
// Running and setting up the Kea Hub: only in hub mode (--host-hub, or a PC that already runs a Hub).
const hubHandle = (name, fn) => handle(name, (arg) => {
  if (!hubMode()) throw new Error('Setting up a Kea Hub isn’t part of KeaS here.');
  return fn(arg);
});

let ownerToken = null;
// ---------- updates (updates.cjs) ----------
let updates = null;
function startUpdates() {
  let told = null;
  updates = createUpdates({
    enabled: app.isPackaged,
    log,
    send: (s) => {
      send('update', s);
      refreshTray();
      // Once per version: the tray says it's ready.
      if (s.status === 'ready' && told !== s.version && tray) {
        told = s.version;
        try { tray.displayBalloon({ iconType: 'info', title: 'KeaS update ready', content: `KeaS ${s.version} is downloaded. Choose "Restart to update" when it suits you; the Hub is offline for a moment while KeaS restarts.` }); } catch {}
      }
    },
    beforeInstall: () => { app.isQuitting = true; },
  });
  updates.start();
}

function registerIpc() {
  handle('update:state', () => updates.state());
  handle('update:check', () => updates.check());
  handle('update:install', () => updates.install());
  handle('state', async () => {
    const defaults = { hubData: defaultFolder('Kea Hub'), orgData: defaultFolder('KeaS Server') };
    const hub = hubMode();
    return {
      config: publicConfig(), folderProblem, folderWarning, running: { hub: hubRunning(), org: !!org, hubExternal }, port: servicePort(),
      defaults, resume: hub ? flow.resumeChoices(config, defaults) : null, version: app.getVersion(),
      hub, view: flow.firstView({ hub, config, signedIn: account().signedIn() }), account: account().cached(), startWithWindows: flow.startWithWindows(config),
    };
  });

  // ---------- the Kea account (account.cjs) ----------
  // Signing in also points payroll at the same Hub (on a PC that isn't the Hub; there it's this PC's own Hub).
  const signedIn = (st) => {
    if (st.signedIn && config.role !== 'hub' && config.hubUrl !== account().url()) config = writeConfig({ ...config, hubUrl: account().url() });
    return st;
  };
  handle('account:status', () => account().status());
  handle('account:login', async (a) => signedIn(await account().login(a)));
  handle('account:register', async (a) => signedIn(await account().register(a)));
  handle('account:terms', () => account().terms());
  handle('account:acceptTerms', (a) => account().acceptTerms(a));
  handle('account:logout', async () => { payrollApi?.forget?.(); return account().logout(); });
  handle('account:setUrl', async ({ url }) => { payrollApi?.forget?.(); return account().changeUrl(url); });
  handle('settings:startWithWindows', ({ on }) => {
    config = writeConfig({ ...config, startWithWindows: !!on });
    if (!DEV) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    // Not a Hub PC: KeaS only sits in the tray when it starts with Windows.
    if (!hubMode()) { if (on) makeTray(); else if (tray) { tray.destroy(); tray = null; } }
    else refreshTray();
    return flow.startWithWindows(config);
  });
  hubHandle('drives', () => drives());
  hubHandle('pickFolder', async ({ start }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should KeaS keep its data?', defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const p = r.filePaths[0];
    // Never a whole drive: its permissions let every account on the PC change what's in it.
    if (path.parse(p).root.toLowerCase() === path.join(p, path.sep).toLowerCase()) throw new Error(`Pick or make a folder on that drive (for example ${path.join(p, 'Kea Hub')}), not the drive itself.`);
    return p;
  });
  hubHandle('checkFolder', ({ dir }) => checkFolder(dir));
  hubHandle('saveSetup', async ({ role, dataDir, storageDir, quotaGb, reach }) => {
    if (!['hub', 'org'].includes(role)) throw new Error('Pick what this PC is for.');
    // A different role serves a different port: the old one's Funnel goes, so nothing stays public by accident.
    if (config.role && config.role !== role && config.tailscale) {
      try { await tailscale.funnelOff(servicePort()); } catch (e) { log('funnel off', e.message); }
      config = writeConfig({ ...config, publicUrl: null });
    }
    dataDir = (await checkFolder(dataDir)).dir;
    if (storageDir) storageDir = (await checkFolder(storageDir, 'The storage folder')).dir;
    config = writeConfig({ ...config, role, dataDir, storageDir: storageDir || path.join(dataDir, 'storage'), quotaGb: Number(quotaGb) || 5, tailscale: reach === 'tailscale' });
    // The before-sign-in launcher reads these settings at each start: keep it in step (no permission needed, as long
    // as the service folder's permissions are still the locked-down ones).
    if (config.boot?.installed && config.boot.layout === bootstart.LAYOUT && !DEV) await refreshBoot(true);
    return publicConfig();
  });
  hubHandle('start', async () => { await startServices(); return { hub: hubRunning(), org: !!org, port: servicePort() }; });
  hubHandle('boot:status', () => bootStatus());
  hubHandle('boot:apply', ({ options, dryRun }) => bootApply(options, !!dryRun));
  hubHandle('boot:remove', ({ dryRun }) => bootRemove(!!dryRun));

  hubHandle('ts:status', () => tailscale.status(servicePort()));
  hubHandle('ts:install', () => tailscale.install((l) => send('progress', l)));
  hubHandle('ts:login', () => tailscale.login((u) => shell.openExternal(u), (l) => send('progress', l)));
  // Public access off: removes only KeaS's Funnel (https:443 to this server's port), nothing else in Tailscale.
  hubHandle('ts:funnelOff', async () => {
    const s = await tailscale.funnelOff(servicePort());
    config = writeConfig({ ...config, publicUrl: null });
    return s;
  });
  hubHandle('ts:funnel', async () => {
    const s = await tailscale.funnel(servicePort(), (u) => shell.openExternal(u), (l) => send('progress', l));
    config = writeConfig({ ...config, publicUrl: s.url });
    pointKeaHere();
    return s;
  });

  // The Hub owner (owner.cjs): the account is made through the Hub like anyone's (with the terms), then made owner
  // right here, on this PC, which is the only place that can happen.
  const local = ownerLib.localCaller(`http://127.0.0.1:${HUB_PORT}`);
  hubHandle('terms', () => local('/v1/terms'));
  // Setup remembers where it got to, so closing KeaS (or a crash or restart) never sends it back to the start.
  hubHandle('setupStep', ({ step }) => {
    if (config.setupDone || !flow.WIZARD.includes(step)) return false;
    if (config.setupStep !== step) config = writeConfig({ ...config, setupStep: step });
    return true;
  });
  hubHandle('owner:state', async () => {
    if (!config.ownerEmail || !hubRunning()) return null;
    return ownerLib.ownerState(await hubDb(), config.ownerEmail);
  });
  hubHandle('owner:create', async ({ name, email, password, code, termsVersion, termsSections }) => {
    const db = await hubDb();
    // The password goes only to OUR Hub: whatever answers on the port must prove it holds this Hub's signing key.
    if (!(await verifyHubIdentity(HUB_PORT, config.dataDir))) throw new Error('The Kea Hub on this PC didn’t prove it’s the one in your data folder, so the password wasn’t sent. Restart KeaS; if this keeps happening, another program may be using port 4860.');
    const r = await ownerLib.createOwner({ db, call: local, name, email, password, code, termsVersion, termsSections });
    config = writeConfig({ ...config, ownerEmail: r.email });
    ownerToken = r.token;
    // KeaS is now signed in to the owner's own Kea account (payroll uses it too).
    account().adopt(r.token, `http://127.0.0.1:${HUB_PORT}`);
    return { email: r.email, totp: r.totp };
  });
  hubHandle('owner:totp', async ({ code }) => {
    if (!ownerToken) throw new Error('Go back one step and sign in to the owner account again.');
    await local('/v1/me/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }, ownerToken);
    return true;
  });
  hubHandle('finish', ({ startWithWindows = true, theme }) => {
    config = writeConfig({ ...config, setupDone: true, startWithWindows, theme: theme || config.theme || 'system' });
    if (!DEV) app.setLoginItemSettings({ openAtLogin: !!startWithWindows, args: ['--hidden'] });
    makeTray();
    pointKeaHere();
    return publicConfig();
  });
  handle('setTheme', ({ theme }) => { config = writeConfig({ ...config, theme }); nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system'; return theme; });
  handle('openExternal', ({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  // Only KeaS's own data folder (or a folder in it) can be opened from the setup page.
  handle('openFolder', async ({ dir }) => {
    const real = bootstart.folderInside(config.dataDir, dir);
    if (!real) throw new Error('KeaS only opens its own data folder.');
    const err = await shell.openPath(real);
    if (err) throw new Error(err);
    return true;
  });
  handle('payroll:open', () => openPayroll());
  handle('payroll:status', () => payroll().status());
  handle('payroll:setup', (a) => payroll().setup(a));
  handle('payroll:unlock', (a) => payroll().unlock(a));
  handle('payroll:askEveryTime', ({ on }) => payroll().setAskEveryTime(!!on));
  handle('payroll:openExports', async () => { const err = await payroll().openExports(); if (err) throw new Error(err); return true; });
  handle('payroll:settings', () => payroll().settings());
  handle('payroll:localSignIn', ({ on }) => payroll().setLocalSignIn(!!on));
  handle('payroll:hubKey', () => payroll().hubKey());
  handle('payroll:repinHub', ({ fingerprint }) => payroll().repinHub({ fingerprint }));
}

/** Updates the installed service files (KeaS was updated, or its settings changed). 'repair': run it again from Settings. */
async function refreshBoot(force) {
  try {
    const r = await bootstart.refreshService({ ...bootArgs(), opts: config.boot.options, force });
    if (r === 'repair') { log('the Hub service folder’s permissions changed; not updating it'); config = writeConfig({ ...config, boot: { ...config.boot, repair: true } }); }
    else if (r === 'updated') log('updated the Hub service files');
  } catch (e) { log('boot files', e.message); }
}

function defaultFolder(name) {
  // The drive with the most free space (often the big data drive), not the system drive if another is bigger.
  const d = drives().sort((a, b) => b.free - a.free)[0];
  return d ? path.join(d.root, name) : path.join(os.homedir(), name);
}

/** Kea on this PC uses this Hub (the owner's own Kea, right away). */
function pointKeaHere() {
  if (config.role !== 'hub' || DEV) return;
  try {
    const f = path.join(app.getPath('appData'), 'Kea', 'settings.json');
    if (!fs.existsSync(f)) return;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const url = config.publicUrl || `http://127.0.0.1:${HUB_PORT}`;
    if (s['hub.url'] === url) return;
    s['hub.url'] = url;
    fs.writeFileSync(f, JSON.stringify(s, null, 1));
  } catch (e) { log('pointKeaHere', e.message); }
}

app.whenReady().then(async () => {
  config = readConfig();
  // The standard Kea storage per account went from 25 GB to 5 GB (supporters get 25 GB). A Hub set up with the old
  // standard moves to the new one once; any other size chosen at setup stays. The Hub tells each person it changes for.
  if (config.role === 'hub' && config.quotaGb === 25 && !config.quotaStandard5) config = writeConfig({ ...config, quotaGb: 5, quotaStandard5: true });
  nativeTheme.themeSource = config.theme === 'light' || config.theme === 'dark' ? config.theme : 'system';
  startUpdates();
  registerIpc();
  if (config.setupDone && hubMode()) {
    try { await startServices(); } catch (e) { lastStartError = e.message; log('start failed', e.message); }
    // KeaS was updated: the before-sign-in Hub uses the new Hub files from its next start.
    if (config.role === 'hub' && config.boot?.installed && config.boot.layout === bootstart.LAYOUT && !DEV) await refreshBoot(false);
    makeTray();
  } else if (!hubMode() && flow.startWithWindows(config)) makeTray();
  if (!process.argv.includes('--hidden') || !tray) showWindow();
});
// (With a tray, closing the window keeps KeaS running; without one, it quits.)
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', async () => { app.isQuitting = true; clearInterval(hubWatch); updates?.stop(); try { await hub?.close(); await org?.close(); extDb?.close(); } catch {} });
