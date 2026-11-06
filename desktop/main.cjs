// KeaS desktop: the app you download. On first run it walks you through setting up this PC as a server:
//   - the Kea Hub (Kea's creator only: accounts, classes, study, storage for everyone), or
//   - an organization's KeaS server (schedules, time clock, payroll prep for one org),
// picking which drive holds the data, setting up Tailscale so it's reachable from anywhere, and (for the Hub) making
// the owner account. After that it runs the server in the background, starts with Windows, and sits in the tray.
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const tailscale = require('./tailscale.cjs');
const bootstart = require('./bootstart.cjs');

const ROOT = path.join(__dirname, '..');
const HUB_PORT = 4860;
const ORG_PORT = 4850;
const configFile = () => path.join(app.getPath('userData'), 'keas-config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 1)); return c; };
let config = {};
let win = null, tray = null;
let hub = null, org = null;
// The Hub started before sign-in by the Scheduled Task (bootstart.cjs) is a separate process: KeaS then uses it instead
// of starting its own, and starts its own only if that one stops answering.
let hubExternal = false, hubWatch = null, extDb = null;
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'keas.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };

// Developer aids: KEAS_USERDATA runs a separate profile (and never touches Kea's settings or Windows startup);
// KEAS_CAPTURE=file.png with KEAS_EVAL=script.js runs the script in the setup page, saves a screenshot, and quits.
const DEV = !!process.env.KEAS_USERDATA;
if (DEV) app.setPath('userData', process.env.KEAS_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- the servers, run inside this app (Electron includes Node 24: SQLite and Argon2 built in) ----------
async function startServices() {
  if (config.role === 'hub' && !hub && await bootstart.hubAnswering(HUB_PORT)) {
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
    org = createApp({ dbFile: path.join(config.dataDir, 'org.db'), log: false });
    await org.listen(ORG_PORT);
    log('org server started', config.dataDir);
  }
}
const servicePort = () => (config.role === 'hub' ? HUB_PORT : ORG_PORT);
function watchExternalHub() {
  if (hubWatch) return;
  hubWatch = setInterval(async () => {
    if (!hubExternal || await bootstart.hubAnswering(HUB_PORT)) return;
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
const bootArgs = () => ({ config, exe: process.execPath, hubSource: path.join(ROOT, 'hub'), version: app.getVersion(), port: HUB_PORT });
async function bootStatus() {
  const task = await bootstart.taskStatus();
  let power = null;
  try { power = await bootstart.readPower(); } catch {}
  return {
    task, power, external: hubExternal, saved: config.boot || null, options: bootstart.options(config.boot?.options),
    defaults: bootstart.DEFAULTS, note: bootstart.POWER_LOSS_NOTE, taskName: bootstart.TASK_NAME, testProfile: DEV,
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
  config = writeConfig({ ...config, boot: { options: o, installed, powerApplied, previous: powerApplied ? r.previous : null, at: Date.now(), steps: r.steps } });
  if (!o.bootStart && was.installed && hubExternal && !installed) { hubExternal = false; if (extDb) { try { extDb.close(); } catch {} extDb = null; } await startServices().catch((e) => log('start failed', e.message)); }
  refreshTray();
  return { ok: r.ok, steps: r.steps, status: await bootStatus() };
}
async function bootRemove(dryRun = false) {
  if (DEV && !dryRun) throw new Error(TEST_PROFILE);
  const r = await bootstart.uninstall({ config, previous: config.boot?.powerApplied ? config.boot.previous : null, stopHub: hubExternal, dryRun });
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
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'setup', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // Closing the window keeps the server running in the tray once it's set up.
    if (config.setupDone && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => (win = null));
  if (process.env.KEAS_CAPTURE) {
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
function makeTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(config.role === 'hub' ? 'KeaS · Kea Hub running' : 'KeaS · server running');
  tray.on('click', showWindow);
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  const isHub = config.role === 'hub';
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
    { label: 'Payroll', click: () => openPayroll().catch(() => {}) },
    ...(isHub ? [
      { type: 'separator' },
      { label: 'Start the Hub before sign-in', type: 'checkbox', checked: installed, click: toggle },
      { label: 'Power settings…', click: () => { showWindow(); setTimeout(() => send('navigate', 'settings'), win?.webContents.isLoading() ? 800 : 0); } },
    ] : []),
    { type: 'separator' },
    { label: hubExternal ? 'Quit KeaS (the Hub keeps running)' : 'Quit KeaS (stops the server)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------- Payroll (the payroll vault, on this PC only; see payroll.cjs) ----------
let payrollApi = null;
const payroll = () => (payrollApi ||= require('./payroll.cjs').createPayroll({ getConfig: () => config, userData: app.getPath('userData'), root: ROOT, hubPort: HUB_PORT, log }));
const openPayroll = () => payroll().open().catch((e) => { log('payroll', e.message); throw e; });
app.on('before-quit', () => { payrollApi?.stop(); });

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
function checkFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.keas-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  const s = fs.statfsSync(dir);
  return { ok: true, free: s.bavail * s.bsize };
}

// ---------- IPC for the setup screens ----------
const send = (ch, v) => win?.webContents.send(ch, v);
const handle = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  try { return { ok: true, value: await fn(arg || {}) }; } catch (e) { log('error', name, e.message); return { ok: false, error: String(e.message || e) }; }
});

let ownerToken = null;
function registerIpc() {
  handle('state', async () => ({ config: { ...config, googleClientSecret: undefined }, running: { hub: hubRunning(), org: !!org, hubExternal }, port: servicePort(), defaults: { hubData: defaultFolder('Kea Hub'), orgData: defaultFolder('KeaS Server') }, version: app.getVersion() }));
  handle('drives', () => drives());
  handle('pickFolder', async ({ start }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should KeaS keep its data?', defaultPath: start, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('checkFolder', ({ dir }) => checkFolder(dir));
  handle('saveSetup', ({ role, dataDir, storageDir, quotaGb, reach }) => {
    if (!['hub', 'org'].includes(role)) throw new Error('Pick what this PC is for.');
    checkFolder(dataDir);
    if (storageDir) checkFolder(storageDir);
    config = writeConfig({ ...config, role, dataDir, storageDir: storageDir || path.join(dataDir, 'storage'), quotaGb: Number(quotaGb) || 5, tailscale: reach === 'tailscale' });
    // The before-sign-in launcher reads these settings at each start: keep it in step (no permission needed).
    if (config.boot?.installed && !DEV) { try { bootstart.prepareFiles({ ...bootArgs(), opts: config.boot.options }); } catch (e) { log('boot files', e.message); } }
    return config;
  });
  handle('start', async () => { await startServices(); return { hub: hubRunning(), org: !!org, port: servicePort() }; });
  handle('boot:status', () => bootStatus());
  handle('boot:apply', ({ options, dryRun }) => bootApply(options, !!dryRun));
  handle('boot:remove', ({ dryRun }) => bootRemove(!!dryRun));

  handle('ts:status', () => tailscale.status(servicePort()));
  handle('ts:install', () => tailscale.install((l) => send('progress', l)));
  handle('ts:login', () => tailscale.login((u) => shell.openExternal(u), (l) => send('progress', l)));
  handle('ts:funnel', async () => {
    const s = await tailscale.funnel(servicePort(), (u) => shell.openExternal(u), (l) => send('progress', l));
    config = writeConfig({ ...config, publicUrl: s.url });
    pointKeaHere();
    return s;
  });

  // The Hub owner: the account is made through the Hub like anyone's (with the terms), then made owner right here,
  // on this PC, which is the only place that can happen.
  const local = (p, init = {}, token) => fetch(`http://127.0.0.1:${HUB_PORT}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Hub said ${r.status}`); return j; });
  handle('terms', () => local('/v1/terms'));
  handle('owner:create', async ({ name, email, password, termsVersion, termsSections }) => {
    const db = await hubDb();
    let token;
    const existing = db.get('SELECT id FROM accounts WHERE email = ?', String(email).trim().toLowerCase());
    if (existing) token = (await local('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).token;
    else token = (await local('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName: name, age13: true, termsVersion, termsSections }) })).token;
    const a = db.get('SELECT * FROM accounts WHERE email = ?', String(email).trim().toLowerCase());
    db.run("UPDATE accounts SET role = 'owner', can_host = 1, email_verified = 1, verified_by = 'owner', identity_verified = 1, updated_at = ? WHERE id = ?", Date.now(), a.id);
    db.run('INSERT INTO audit (at,actor,action,target,ip) VALUES (?,?,?,?,?)', Date.now(), 'keas-setup', 'owner.make_owner', a.id, 'local');
    config = writeConfig({ ...config, ownerEmail: a.email });
    ownerToken = token;
    // The owner must use two-step sign-in. (Already on: nothing to set up.)
    const totp = a.totp_enabled ? null : await local('/v1/me/totp/setup', { method: 'POST', body: '{}' }, token);
    return { email: a.email, totp };
  });
  handle('owner:totp', async ({ code }) => {
    await local('/v1/me/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }, ownerToken);
    return true;
  });
  handle('finish', ({ startWithWindows = true, theme }) => {
    config = writeConfig({ ...config, setupDone: true, startWithWindows, theme: theme || config.theme || 'system' });
    if (!DEV) app.setLoginItemSettings({ openAtLogin: !!startWithWindows, args: ['--hidden'] });
    makeTray();
    pointKeaHere();
    return config;
  });
  handle('setTheme', ({ theme }) => { config = writeConfig({ ...config, theme }); nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system'; return theme; });
  handle('openExternal', ({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  handle('openFolder', ({ dir }) => shell.openPath(dir));
  handle('payroll:open', () => openPayroll());
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
  registerIpc();
  if (config.setupDone) {
    try { await startServices(); } catch (e) { log('start failed', e.message); }
    // KeaS was updated: the before-sign-in Hub uses the new Hub files from its next start.
    if (config.role === 'hub' && config.boot?.installed && !DEV) bootstart.refreshIfOutdated({ ...bootArgs(), opts: config.boot.options });
    makeTray();
  }
  if (!process.argv.includes('--hidden') || !config.setupDone) showWindow();
});
app.on('window-all-closed', () => { if (!config.setupDone) app.quit(); });
app.on('before-quit', async () => { app.isQuitting = true; clearInterval(hubWatch); try { await hub?.close(); await org?.close(); extDb?.close(); } catch {} });
