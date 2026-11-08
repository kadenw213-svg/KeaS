// KeaS desktop: the app an organization downloads. It runs the organization's KeaS server on this PC (hub/index.mjs:
// schedules, the time clock, pay codes, roles, stubs; people sign in with their Kea accounts through passes from KeaC),
// sits in the tray, starts with Windows, and opens Payroll (the vault, on this PC only).
//
// First run: the data folder -> the Kea account server (KeaC), its key checked against the fingerprint in its Keys
// screen -> sign in with your Kea account -> set up this server with the setup code shown here (you become its
// operator) -> create the organization -> where people work and its local rules -> reachable from anywhere (Tailscale
// Funnel) -> the "Get set up" list. There is no remote way to set up a server: claiming happens on its owner console,
// on this PC only.
//
// A PC that ran the Kea Hub (KeaS 0.5) keeps running it, accounts and all, until its accounts have moved to KeaC
// (moved-to-keac.json in the data folder, written by KeaC's migration or by "My Kea accounts have moved" here); then
// it becomes this organization's KeaS server (hub/upgrade.mjs; the Hub's own files stay as they were).
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const tailscale = require('./tailscale.cjs');
const { serverIdentity } = require('./hubid.cjs');
const bootstart = require('./bootstart.cjs');
const { createUpdates } = require('./updates.cjs');
const flow = require('./flow.cjs');
const drivesLib = require('./drives.cjs');
const { createAccount } = require('./account.cjs');
const { createKeasLink } = require('./keas.cjs');

const ROOT = path.join(__dirname, '..');
const PORT = 4860;
const configFile = () => path.join(app.getPath('userData'), 'keas-config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
/** The config the setup page may see (no secrets, not even DPAPI-protected ones). */
const publicConfig = () => ({ ...config, googleClientSecret: undefined, orgVaultKey: undefined });
const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 1)); return c; };
let config = {};
let win = null, tray = null;
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'keas.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };
const protect = { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) };

// Developer aids: KEAS_USERDATA runs a separate profile (and never touches Windows startup); KEAS_CAPTURE=file.png with
// KEAS_EVAL=script.js runs the script in the setup page, saves a screenshot, and quits (from source only).
const DEV = !!process.env.KEAS_USERDATA;
if (DEV) app.setPath('userData', process.env.KEAS_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- the Kea account (KeaC) and the KeaS server's sign-in ----------
const keacUrl = () => config.keacUrl || null;
let accountApi = null;
// Google or Microsoft in the system browser (oauth.cjs): the client ids are KeaS's settings on this PC (googleClientId
// and googleClientSecret, microsoftClientId in keas-config.json).
const clientIdOf = (provider) => String((provider === 'microsoft' ? config.microsoftClientId : config.googleClientId) || '').trim();
const providers = () => ({ google: !!clientIdOf('google'), microsoft: !!clientIdOf('microsoft') });
const idTokenFor = (provider, loginHint) => require('./oauth.cjs').idToken({ provider, clientId: clientIdOf(provider), clientSecret: provider === 'google' ? config.googleClientSecret || null : null, loginHint, open: (u) => shell.openExternal(u) });
const account = () => (accountApi ||= createAccount({ dir: app.getPath('userData'), protect, getUrl: keacUrl, setUrl: (u) => { config = writeConfig({ ...config, keacUrl: u || null }); }, client: `KeaS/${app.getVersion()}`, idTokenFor: (p, hint) => (clientIdOf(p) ? idTokenFor(p, hint) : Promise.reject(Object.assign(new Error(NOT_SET_UP), { status: 503, data: { notSetUp: true } }))) }));
const NOT_SET_UP = 'Google and Microsoft sign-in aren’t set up in this KeaS yet. Add a client id in keas-config.json (googleClientId or microsoftClientId).';
const serverId = async () => { const me = config.dataDir && serverIdentity(config.dataDir); if (!me) throw new Error('Start the KeaS server first.'); return me.serverId; };
async function owner(method, p, body) {
  const { ownerFetch } = await import(pathToFileURL(path.join(ROOT, 'hub', 'lib', 'ownerauth.mjs')).href);
  const key = server ? server.ownerKey : fs.readFileSync(path.join(config.dataDir, 'owner.key'), 'utf8').trim();
  const r = await ownerFetch(`http://127.0.0.1:${PORT + 1}`, key, method, p, body);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let linkApi = null;
const link = () => (linkApi ||= createKeasLink({ dir: app.getPath('userData'), protect, base: () => `http://127.0.0.1:${PORT}`, owner, serverId, account: account(), client: `KeaS/${app.getVersion()}` }));
// A PC still running the Kea Hub: payroll signs in at that Hub as before (legacy-account.cjs).
let legacyApi = null;
const legacyAccount = () => (legacyApi ||= require('./legacy-account.cjs').createAccount({ dir: path.join(app.getPath('userData'), 'hub-account'), protect, getUrl: () => `http://127.0.0.1:${PORT}`, setUrl: () => {}, client: `KeaS/${app.getVersion()}` }));

// ---------- the server, run inside this app (or found running before sign-in) ----------
let server = null, serverExternal = false, watch = null;
let folderProblem = null, folderWarning = null, lastStartError = null;
const FOLDER_WARNING = 'KeaS can’t limit who opens this folder, because of how the drive is formatted or who owns the folder. Anyone with another Windows account on this PC, or a program running under one, may be able to read or change the server’s keys and data.';
/** 'keas' | 'legacy' (a Kea Hub whose accounts haven't moved) | 'moved' | 'fresh', from the data folder. */
async function folderState() {
  if (!config.dataDir) return 'fresh';
  const { folderState: fsOf } = await import(pathToFileURL(path.join(ROOT, 'hub', 'upgrade.mjs')).href);
  try { return fsOf(config.dataDir); } catch { return 'fresh'; }
}
let mode = null; // what the running server is: 'keas' or 'legacy'
async function secureFolders() {
  folderProblem = null; folderWarning = null;
  const dir = config.dataDir;
  if (!dir) return;
  try {
    const r = await bootstart.secureDataFolder(dir, { onWasOpen: () => log('replaced the server keys after locking down its folder:', bootstart.rotateHubSecrets(dir).join(', ') || 'none there') });
    if (r.changed) log('locked down', dir);
    if (r.unlocked) { folderWarning = FOLDER_WARNING; log('not locked down', dir, r.unlocked); }
  } catch (e) { folderProblem = `The data folder: ${e.message}`; log('folder permissions', dir, e.message); }
}
async function startServer() {
  if (config.dataDir && !server && !serverExternal) await secureFolders();
  if (folderProblem) {
    const stopped = await bootstart.stopRecordedHub(config.dataDir, PORT);
    if (stopped) log('stopped the server that started before sign-in, because its folder was refused', stopped);
    throw new Error(folderProblem);
  }
  if (!server && await bootstart.hubAnswering(PORT, { dataDir: config.dataDir })) {
    if (!serverExternal) log('server already running (started before sign-in); using it');
    serverExternal = true;
    mode = (await folderState()) === 'legacy' ? 'legacy' : 'keas';
    watchExternal();
    return;
  }
  if (server) return;
  serverExternal = false;
  const { openServer } = await import(pathToFileURL(path.join(ROOT, 'hub', 'index.mjs')).href);
  server = await openServer({
    dataDir: config.dataDir, log: false, ipHeader: config.tailscale ? 'x-forwarded-for' : null, keacUrl: config.keacUrl || null,
    legacy: { storageDir: config.storageDir || path.join(config.dataDir, 'storage'), defaultQuotaBytes: (config.quotaGb || 5) * 1024 ** 3, googleClientIds: config.googleClientIds || [], googleWebClientId: config.googleWebClientId || null, publicUrl: config.publicUrl || null },
  });
  try { await server.listen({ port: PORT, ownerPort: PORT + 1 }); }
  catch (e) { await server.close().catch(() => {}); server = null; throw e; }
  mode = server.mode;
  if (server.upgraded) log('upgraded from KeaS 0.5:', server.upgraded.file);
  config = writeConfig({ ...config, role: mode === 'legacy' ? 'hub' : 'keas' });
  log('server started', mode, config.dataDir);
}
async function restartServer() {
  if (server) { await server.close().catch(() => {}); server = null; }
  if (serverExternal) { const stopped = await bootstart.stopRecordedHub(config.dataDir, PORT); if (stopped) log('stopped the before-sign-in server to restart it', stopped); serverExternal = false; }
  linkApi = null;
  await startServer();
}
function watchExternal() {
  if (watch) return;
  watch = setInterval(async () => {
    if (!serverExternal || await bootstart.hubAnswering(PORT, { dataDir: config.dataDir })) return;
    log('the server started before sign-in stopped answering; starting it here');
    serverExternal = false;
    try { await startServer(); lastStartError = null; } catch (e) { lastStartError = e.message; log('start failed', e.message); }
    refreshTray();
  }, 60_000);
}
const running = () => !!server || serverExternal;
const setupSecret = () => { if (server) return server.mode === 'keas' ? server.setupSecret : null; try { return fs.readFileSync(path.join(config.dataDir, 'setup.secret'), 'utf8').trim(); } catch { return null; } };

// ---------- start before sign-in, and power settings ----------
const bootArgs = () => ({ config, exe: process.execPath, hubSource: path.join(ROOT, 'hub'), version: app.getVersion(), port: PORT, stageDir: path.join(app.getPath('userData'), 'hub-service') });
async function bootStatus() {
  const task = await bootstart.taskStatus();
  let power = null;
  try { power = await bootstart.readPower(); } catch {}
  return {
    task, power, external: serverExternal, saved: config.boot || null, options: bootstart.options(config.boot?.options),
    defaults: bootstart.DEFAULTS, note: bootstart.POWER_LOSS_NOTE, taskName: bootstart.TASK_NAME, testProfile: DEV,
    needsUpdate: !!config.boot?.installed && (config.boot.layout !== bootstart.LAYOUT || !!config.boot.repair),
    serviceDir: bootstart.serviceDir(), folderProblem,
  };
}
const TEST_PROFILE = 'A test profile (KEAS_USERDATA) never changes Windows settings. Use "Show what it runs" instead.';
async function bootApply(opts = {}, dryRun = false) {
  if (!config.dataDir) throw new Error('Pick the data folder first.');
  if (DEV && !dryRun) throw new Error(TEST_PROFILE);
  const o = bootstart.options(opts);
  const was = config.boot || {};
  const r = await bootstart.install({ ...bootArgs(), opts: o, dryRun, previous: was.powerApplied ? was.previous : null, powerWasApplied: !!was.powerApplied, wasInstalled: !!was.installed, stopHub: serverExternal });
  if (dryRun) return r;
  const ok = (name) => r.steps.some((s) => s.step === name && s.ok);
  const installed = o.bootStart ? ok('task') : (!!was.installed && !ok('task:delete'));
  const powerOn = Object.keys(bootstart.powerTargets(o)).length > 0;
  const powerApplied = powerOn ? (ok('power:apply') || !!was.powerApplied) : (!!was.powerApplied && !ok('power:apply'));
  config = writeConfig({ ...config, boot: { options: o, installed, layout: installed ? (ok('service:copy') ? bootstart.LAYOUT : was.layout || 1) : null, repair: false, powerApplied, previous: powerApplied ? r.previous : null, at: Date.now(), steps: r.steps } });
  if (!o.bootStart && was.installed && serverExternal && !installed) { serverExternal = false; await startServer().catch((e) => log('start failed', e.message)); }
  refreshTray();
  return { ok: r.ok, steps: r.steps, status: await bootStatus() };
}
async function bootRemove(dryRun = false) {
  if (DEV && !dryRun) throw new Error(TEST_PROFILE);
  const r = await bootstart.uninstall({ config, previous: config.boot?.powerApplied ? config.boot.previous : null, stopHub: serverExternal, dryRun, stageDir: bootArgs().stageDir });
  if (dryRun) return r;
  if (r.ok) {
    config = writeConfig({ ...config, boot: { options: bootstart.options(config.boot?.options), installed: false, powerApplied: false, previous: null, at: Date.now(), steps: r.steps } });
    serverExternal = false;
    await startServer().catch((e) => log('start failed', e.message));
  }
  refreshTray();
  return { ok: r.ok, steps: r.steps, status: await bootStatus() };
}
async function refreshBoot(force) {
  try {
    const r = await bootstart.refreshService({ ...bootArgs(), opts: config.boot.options, force });
    if (r === 'repair') { log('the service folder’s permissions changed; not updating it'); config = writeConfig({ ...config, boot: { ...config.boot, repair: true } }); }
    else if (r === 'updated') log('updated the service files');
  } catch (e) { log('boot files', e.message); }
}

// ---------- windows and tray ----------
function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1020, height: 780, minWidth: 420, minHeight: 560, title: 'KeaS', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f7f7f5',
    autoHideMenuBar: true, icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'setup', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => { if (tray && !app.isQuitting) { e.preventDefault(); win.hide(); } });
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
      try { await server?.close(); } catch {}
      app.exit(0);
    }, Number(process.env.KEAS_CAPTURE_DELAY || 1500)));
  }
}
const ICON_FILE = path.join(__dirname, 'icon.png');
const appIcon = () => { const i = nativeImage.createFromPath(ICON_FILE); return i.isEmpty() ? undefined : i; };
function makeTray() {
  if (tray) return;
  const icon = appIcon();
  tray = new Tray(icon ? icon.resize({ width: 16, height: 16, quality: 'best' }) : nativeImage.createEmpty());
  tray.on('click', showWindow);
  refreshTray();
}
const STEP_WORDS = { 'data:acl': 'Locking down the data folder', 'hub:stop': 'Stopping the server', 'legacy:remove': 'Removing the old launcher', 'power:apply': 'Changing the power settings', 'service:clear': 'Clearing the service folder', 'service:copy': 'Copying the server’s files', 'service:folder': 'Making the service folder', 'service:owner': 'Protecting the service folder', 'service:remove': 'Removing the service folder', task: 'Adding the start-up task', 'task:delete': 'Removing the start-up task', 'task:end': 'Ending the start-up task' };
function refreshTray() {
  if (!tray) return;
  const installed = !!config.boot?.installed;
  tray.setToolTip(mode === 'legacy' ? 'KeaS · Kea Hub running' : running() ? 'KeaS · server running' : 'KeaS');
  const toggle = async () => {
    const ask = await dialog.showMessageBox({ type: 'question', title: 'KeaS', message: installed ? 'Stop starting the server before sign-in?' : 'Start the server before anyone signs in?',
      detail: installed ? 'Windows asks for permission to remove the task that starts the server. It then runs while KeaS is open.' : 'Windows asks for permission so KeaS can add a task that starts the server when Windows starts, even before anyone signs in.',
      buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1 });
    if (ask.response !== 0) { refreshTray(); return; }
    try {
      const r = await bootApply({ ...(config.boot?.options || { power: false }), bootStart: !installed });
      if (!r.ok) dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: 'Part of it didn’t work.', detail: r.steps.filter((s) => !s.ok).map((s) => `${STEP_WORDS[s.step] || s.step}: ${s.error}`).join('\n') });
    } catch (e) { dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: e.message }); }
    refreshTray();
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeaS', click: showWindow },
    { label: 'Payroll', click: () => trayPayroll() },
    ...(config.setupDone || mode === 'legacy' ? [{ type: 'separator' }, { label: 'Start the server before sign-in', type: 'checkbox', checked: installed, click: toggle }, { label: 'Startup and power…', click: () => navigate('settings') }] : []),
    ...(updates?.state().status === 'ready' ? [{ type: 'separator' }, { label: `Restart to update KeaS to ${updates.state().version}`, click: () => installUpdate() }] : []),
    { type: 'separator' },
    { label: serverExternal ? 'Quit KeaS (the server keeps running)' : 'Quit KeaS (stops the server)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------- Payroll (the payroll vault, on this PC only; see payroll.cjs) ----------
let payrollApi = null;
/** Payroll's sign-in: the KeaS server's session (keas.cjs), or the Kea Hub's account while this PC is still the Hub. */
const payrollAuth = () => (mode === 'legacy' ? legacyAccount() : link());
const payroll = () => (payrollApi ||= require('./payroll.cjs').createPayroll({
  getConfig: () => config, setConfig: (patch) => { config = writeConfig({ ...config, ...patch }); }, userData: app.getPath('userData'), root: ROOT, hubPort: PORT, log,
  account: new Proxy({}, { get: (_t, k) => { const a = payrollAuth(); const v = a[k]; return typeof v === 'function' ? v.bind(a) : v; } }), icon: appIcon(),
  onLocked: (why) => navigate('payroll', { locked: why }),
  onClosed: () => setTimeout(() => send('navigate', { view: 'payrollClosed' }), 1500),
}));
const openPayroll = () => payroll().open().catch((e) => { log('payroll', e.message); throw e; });
app.on('before-quit', () => { payrollApi?.forget(); });
function navigate(view, extra) {
  const had = !!win;
  showWindow();
  setTimeout(() => send('navigate', { view, ...extra }), !had || win?.webContents.isLoading() ? 900 : 0);
}
async function trayPayroll() {
  try { const r = await openPayroll(); if (r?.need) navigate('payroll', { open: r }); }
  catch (e) {
    if (e.data?.need === 'signin') return navigate('account');
    const r = await dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: 'Payroll didn’t open.', detail: e.message, buttons: ['Open KeaS', 'Close'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) showWindow();
  }
}
async function installUpdate() {
  if (payrollApi?.isOpen()) {
    const r = await dialog.showMessageBox({ type: 'warning', title: 'KeaS', message: 'Payroll is open.', detail: 'Restarting KeaS locks Payroll, and anything not saved there is lost. Save your work first.', buttons: ['Restart and update', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (r.response !== 0) return;
  }
  try { updates.install(); } catch (e) { log('update', e.message); }
}

// ---------- drives ----------
async function drives() {
  const info = await drivesLib.logicalDisks();
  const out = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${L}:\\`;
    if (drivesLib.driveProblem(info[L])) continue;
    try { const s = fs.statfsSync(root); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; if (total > 0) out.push({ letter: L, root, total, free, label: info[L]?.label || null, fileSystem: info[L]?.fileSystem || null }); } catch {}
  }
  return out;
}
async function checkFolder(dir, label) {
  dir = bootstart.validateDataDir(dir, label);
  const letter = /^([a-z]):/i.exec(dir)?.[1]?.toUpperCase();
  const why = letter && drivesLib.driveProblem((await drivesLib.logicalDisks())[letter]);
  if (why) throw new Error(`The data can’t go on ${letter}: because ${why}. Pick a drive inside this PC.`);
  const secured = await bootstart.secureDataFolder(dir);
  if (secured.unlocked) log('not locked down', dir, secured.unlocked);
  const probe = path.join(dir, `.keas-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  const s = fs.statfsSync(dir);
  return { ok: true, free: s.bavail * s.bsize, dir, warning: secured.unlocked ? FOLDER_WARNING : null };
}
async function defaultFolder(name) {
  const d = (await drives()).sort((a, b) => b.free - a.free)[0];
  return d ? path.join(d.root, name) : path.join(os.homedir(), name);
}

// ---------- IPC for the KeaS window ----------
const send = (ch, v) => win?.webContents.send(ch, v);
const handle = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  try { return { ok: true, value: await fn(arg || {}) }; } catch (e) { log('error', name, e.message); return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null }; }
});
let updates = null;
const nightlySetting = () => require('./updates.cjs').nightlyOf(config?.nightlyUpdate);
function startUpdates() {
  let told = null;
  updates = createUpdates({
    enabled: app.isPackaged, log,
    send: (s) => {
      send('update', s);
      refreshTray();
      if (s.status === 'ready' && told !== s.version && tray) {
        told = s.version;
        const n = s.nightly;
        try { tray.displayBalloon({ iconType: 'info', title: 'KeaS update ready', content: n?.on ? `KeaS ${s.version} is downloaded. It installs tonight between ${n.hours} (or choose "Restart to update"); the server is offline for a moment while KeaS restarts.` : `KeaS ${s.version} is downloaded. Choose "Restart to update" when it suits you; the server is offline for a moment while KeaS restarts.` }); } catch {}
      }
    },
    // (Installing over a PC that is still a Kea Hub is safe: KeaS 0.6 keeps running the Hub, accounts and all, until
    // the accounts have moved to KeaC; see hub/upgrade.mjs.)
    nightly: () => nightlySetting(),
    busy: () => (payrollApi?.isOpen() ? 'Payroll is open' : payrollApi?.running() ? 'Payroll is in use' : null),
    beforeInstall: ({ nightly } = {}) => {
      app.isQuitting = true;
      if (nightly) { try { config = writeConfig({ ...config, startHiddenOnce: true }); } catch (e) { log('update', e.message); } }
    },
  });
  updates.start();
}
/** What the KeaS server says about KeaC, the setup, and whether this app is signed in to it. */
async function serverFacts() {
  if (!running() || mode !== 'keas') return null;
  try {
    const st = await owner('GET', '/owner/stats');
    if (st.status !== 200) return { error: st.body.error };
    const s = link().session();
    return { claimed: st.body.claimed, serverId: st.body.serverId, keac: st.body.keac, operator: st.body.operator, signedIn: !!s, me: s?.me ?? null, upgrade: st.body.upgrade ? { at: st.body.upgrade.at, notes: st.body.upgrade.notes } : null };
  } catch (e) { return { error: e.message }; }
}
// Only the org engine's own routes, from the window's pay code, role and people panels.
const ORG_API = /^\/v1\/orgs\/[\w-]{1,80}(\/(pay-codes|roles|members|departments|positions|codes|me)(\/[\w%.:-]{1,120}){0,4})?(\?[\w=&%.-]{0,300})?$/;

function registerIpc() {
  handle('update:state', () => updates.state());
  handle('update:check', () => updates.check());
  handle('update:install', () => updates.install());
  handle('update:nightly', ({ on, from, to } = {}) => {
    const cur = nightlySetting();
    const next = { on: on === undefined ? cur.on : on !== false, from: from === undefined ? cur.from : Number(from), to: to === undefined ? cur.to : Number(to) };
    config = writeConfig({ ...config, nightlyUpdate: next });
    const s = updates.state();
    send('update', s);
    return s;
  });
  handle('state', async () => {
    const legacy = mode === 'legacy' || (!running() && (await folderState()) === 'legacy');
    const defaults = !config.setupDone ? { serverData: await defaultFolder('KeaS') } : {};
    return {
      config: publicConfig(), folderProblem, folderWarning, lastStartError, payrollOpen: !!payrollApi?.isOpen(), running: running(), external: serverExternal, port: PORT,
      defaults, resume: flow.resumeChoices(config, defaults), version: app.getVersion(), legacy,
      legacyMessage: legacy ? 'Your Kea accounts are still here. Move them to your Kea account server, then this PC becomes your organization’s server.' : null,
      view: flow.firstView({ legacy, config }), account: account().cached(), startWithWindows: flow.startWithWindows(config),
      server: await serverFacts(), setupCode: mode === 'keas' ? setupSecret() : null, google: providers().google, providers: providers(),
    };
  });

  // ---------- the Kea account (KeaC) ----------
  handle('account:status', () => account().status());
  // Continue with Google or Microsoft (the system browser), and the owner's two-step code when KeaC asks for it.
  handle('account:oauth', ({ provider }) => account().oauth({ provider: provider === 'microsoft' ? 'microsoft' : 'google' }));
  handle('account:google', () => account().oauth({ provider: 'google' }));
  handle('account:continue', ({ code }) => account().continueSignIn({ code }));
  handle('account:logout', async () => { payrollApi?.forget?.(); await link().logout().catch(() => {}); return account().logout(); });
  handle('account:setUrl', async ({ url }) => { payrollApi?.forget?.(); link().forget(); return account().changeUrl(url); });
  // Trusting KeaC's key: what it lists, with fingerprints (and which one is this PC's own old Hub key), then pinning.
  handle('keac:offer', async ({ url }) => {
    const r = await owner('GET', `/owner/keac/offer${url ? `?url=${encodeURIComponent(url)}` : ''}`);
    if (r.status !== 200) throw new Error(r.body.error || 'The Kea account server’s keys didn’t come.');
    return r.body;
  });
  handle('keac:pin', async ({ url, kid, fingerprint }) => {
    const r = await owner('POST', '/owner/keac/pin', { url, kid, fingerprint });
    if (r.status !== 200) throw new Error(r.body.error || 'That key wasn’t trusted.');
    if (account().url() !== r.body.url) await account().changeUrl(r.body.url);
    config = writeConfig({ ...config, keacUrl: r.body.url });
    return r.body;
  });
  // ---------- this KeaS server: setting it up, and signing in to it ----------
  handle('server:claim', ({ secret }) => link().claim(secret || setupSecret()));
  handle('server:signIn', () => link().signIn());
  handle('org:create', (a) => link().createOrg(a));
  handle('org:join', (a) => link().joinOrg(a));
  handle('org:update', (a) => link().updateOrg(a));
  handle('org:people', () => link().orgPeople());
  handle('org:approve', (a) => link().orgApprove(a));
  handle('org:api', ({ method = 'GET', path: p, body }) => {
    if (!['GET', 'POST'].includes(method) || typeof p !== 'string' || !ORG_API.test(p)) throw new Error('KeaS doesn’t send that.');
    return link().api(method, p, method === 'POST' ? body ?? {} : undefined);
  });
  // ---------- a PC still running the Kea Hub ----------
  handle('legacy:login', (a) => legacyAccount().login(a));
  handle('legacy:status', () => legacyAccount().status());
  // The owner says the accounts moved to KeaC (KeaC's migration ran): the marker, then the server becomes KeaS.
  handle('legacy:moved', async ({ keacUrl: u }) => {
    if ((await folderState()) !== 'legacy') throw new Error('This PC isn’t a Kea Hub with accounts still here.');
    const url = u ? require('./account.cjs').checkUrl(u) : null;
    const { writeMarker, hubKeyOf } = await import(pathToFileURL(path.join(ROOT, 'hub', 'upgrade.mjs')).href);
    const kid = hubKeyOf(config.dataDir)?.kid ?? null;
    writeMarker(config.dataDir, { at: Date.now(), keacUrl: url, keacKeyKid: kid });
    log('the owner marked the Kea accounts as moved to KeaC', url || '(no address)', kid || '');
    payrollApi?.forget?.();
    config = writeConfig({ ...config, keacUrl: url || config.keacUrl || null, setupDone: false, setupStep: 'keac' });
    await restartServer();
    return { mode, upgraded: server?.upgraded ? { notes: server.upgraded.notes, file: server.upgraded.file } : null };
  });

  handle('checklist', async () => {
    const legacy = mode === 'legacy';
    const a = legacy ? null : await account().status().catch((e) => ({ signedIn: account().signedIn(), reachable: false, account: account().cached(), error: e.message }));
    const sv = legacy ? null : await serverFacts();
    let orgs = null, orgsError = null, payCodes = null;
    if (!legacy && a?.signedIn && sv?.signedIn) {
      try { orgs = await link().orgs(); } catch (e) { orgsError = e.message; }
      if (orgs) {
        payCodes = {};
        for (const o of orgs.filter((x) => ['owner', 'admin'].includes(x.role) && x.status === 'active')) { try { payCodes[o.id] = await link().orgPayCodes({ id: o.id }); } catch (e) { payCodes[o.id] = { error: e.message }; } }
      }
    }
    const p = !legacy && sv?.signedIn ? await payroll().status().catch(() => null) : null;
    return require('./checklist.cjs').keasSteps({
      config, folderProblem, running: running(), lastStartError, legacy, update: updates?.state(),
      keac: sv?.keac ? { url: sv.keac.url, trusted: sv.keac.trusted, keysError: sv.keac.keysError } : null,
      account: a, server: sv ? { claimed: sv.claimed, signedIn: sv.signedIn, operator: !!sv.me?.operator } : null, orgs, orgsError, payCodes, payroll: p,
    });
  });
  handle('settings:startWithWindows', ({ on }) => {
    config = writeConfig({ ...config, startWithWindows: !!on });
    if (!DEV) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    refreshTray();
    return flow.startWithWindows(config);
  });
  handle('drives', () => drives());
  handle('pickFolder', async ({ start }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should KeaS keep its data?', defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const p = r.filePaths[0];
    if (path.parse(p).root.toLowerCase() === path.join(p, path.sep).toLowerCase()) throw new Error(`Pick or make a folder on that drive (for example ${path.join(p, 'KeaS')}), not the drive itself.`);
    return p;
  });
  handle('checkFolder', ({ dir }) => checkFolder(dir));
  handle('saveSetup', async ({ dataDir, reach }) => {
    if (dataDir) dataDir = (await checkFolder(dataDir)).dir;
    config = writeConfig({ ...config, ...(dataDir ? { dataDir } : {}), ...(reach ? { tailscale: reach === 'tailscale' } : {}) });
    if (config.boot?.installed && config.boot.layout === bootstart.LAYOUT && !DEV) await refreshBoot(true);
    return publicConfig();
  });
  handle('start', async () => { try { await startServer(); lastStartError = null; } catch (e) { lastStartError = e.message; throw e; } return { running: running(), mode }; });
  handle('reach:set', async ({ reach }) => {
    const on = reach === 'tailscale';
    if (!!config.tailscale !== on) {
      config = writeConfig({ ...config, tailscale: on });
      if (config.boot?.installed && config.boot.layout === bootstart.LAYOUT && !DEV) await refreshBoot(true);
      try { await restartServer(); lastStartError = null; } catch (e) { lastStartError = e.message; throw e; }
    }
    return publicConfig();
  });
  handle('openLog', async () => {
    const f = path.join(app.getPath('userData'), 'keas.log');
    if (!fs.existsSync(f)) fs.writeFileSync(f, '');
    const err = await shell.openPath(f);
    if (err) throw new Error(err);
    return true;
  });
  handle('boot:status', () => bootStatus());
  handle('boot:apply', ({ options, dryRun }) => bootApply(options, !!dryRun));
  handle('boot:remove', ({ dryRun }) => bootRemove(!!dryRun));
  handle('ts:status', () => tailscale.status(PORT));
  handle('ts:install', () => tailscale.install((l) => send('progress', l)));
  handle('ts:login', () => tailscale.login((u) => shell.openExternal(u), (l) => send('progress', l)));
  handle('ts:funnelOff', async () => { const s = await tailscale.funnelOff(PORT); config = writeConfig({ ...config, publicUrl: null }); return s; });
  handle('ts:funnel', async () => { const s = await tailscale.funnel(PORT, (u) => shell.openExternal(u), (l) => send('progress', l)); config = writeConfig({ ...config, publicUrl: s.url }); return s; });
  handle('setupStep', ({ step }) => {
    if (config.setupDone || !flow.WIZARD.includes(step)) return false;
    if (config.setupStep !== step) config = writeConfig({ ...config, setupStep: step });
    return true;
  });
  handle('finish', ({ startWithWindows = true, theme }) => {
    config = writeConfig({ ...config, setupDone: true, startWithWindows, theme: theme || config.theme || 'system' });
    if (!DEV) app.setLoginItemSettings({ openAtLogin: !!startWithWindows, args: ['--hidden'] });
    makeTray();
    return publicConfig();
  });
  handle('setTheme', ({ theme }) => { config = writeConfig({ ...config, theme }); nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system'; return theme; });
  handle('openExternal', ({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
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

app.whenReady().then(async () => {
  config = readConfig();
  try { const moved = require('./legacy-account.cjs').adoptOldSession(app.getPath('userData'), path.join(app.getPath('userData'), 'hub-account')); if (moved.length) log('kept the Kea Hub sign-in from KeaS 0.5:', moved.join(', ')); } catch (e) { log('the Kea Hub sign-in from KeaS 0.5', e.message); }
  nativeTheme.themeSource = config.theme === 'light' || config.theme === 'dark' ? config.theme : 'system';
  startUpdates();
  registerIpc();
  if (config.dataDir && (config.setupDone || config.setupStep)) {
    try { await startServer(); } catch (e) { lastStartError = e.message; log('start failed', e.message); }
    if (config.boot?.installed && config.boot.layout === bootstart.LAYOUT && !DEV) await refreshBoot(false);
    // The KeaS session is renewed with a newer pass once a day while KeaC can be reached.
    const renew = () => { if (mode === 'keas' && link().session()) link().ensure().catch((e) => log('pass renewal', e.message)); };
    renew();
    setInterval(renew, 3 * 3600_000).unref?.();
  }
  if (flow.startWithWindows(config) || mode === 'legacy') makeTray();
  const hiddenOnce = !!config.startHiddenOnce;
  if (hiddenOnce) config = writeConfig({ ...config, startHiddenOnce: false });
  if (!(process.argv.includes('--hidden') || hiddenOnce) || !tray) showWindow();
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', async () => { app.isQuitting = true; clearInterval(watch); updates?.stop(); try { await server?.close(); } catch {} });
