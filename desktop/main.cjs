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

const ROOT = path.join(__dirname, '..');
const HUB_PORT = 4860;
const ORG_PORT = 4850;
const configFile = () => path.join(app.getPath('userData'), 'keas-config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(c, null, 1)); return c; };
let config = {};
let win = null, tray = null;
let hub = null, org = null;
let payroll = null, payrollPort = null, payrollWin = null;
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'keas.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };

// Developer aids: KEAS_USERDATA runs a separate profile (and never touches Kea's settings or Windows startup);
// KEAS_CAPTURE=file.png with KEAS_EVAL=script.js runs the script in the setup page, saves a screenshot, and quits.
const DEV = !!process.env.KEAS_USERDATA;
if (DEV) app.setPath('userData', process.env.KEAS_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- the servers, run inside this app (Electron includes Node 24: SQLite and Argon2 built in) ----------
async function startServices() {
  if (config.role === 'hub' && !hub) {
    const { createHub } = await import(pathToFileURL(path.join(ROOT, 'hub', 'index.mjs')).href);
    hub = createHub({
      dataDir: config.dataDir, storageDir: config.storageDir, log: false,
      defaultQuotaBytes: (config.quotaGb || 25) * 1024 ** 3,
      ipHeader: config.tailscale ? 'x-forwarded-for' : null,
      googleClientIds: config.googleClientIds || [],
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

// ---------- Payroll: the payroll vault, run on this PC only (127.0.0.1), opened in its own KeaS window ----------
// Its data (SSNs, bank details, pay runs) stays on this computer, encrypted with the vault passphrase, and never goes
// to the Hub. Payroll admins sign in with their Kea Hub account plus the passphrase (or a local account when the Hub
// can't be reached).
const payrollDir = () => config.payrollDir || path.join(app.getPath('userData'), 'Payroll');
const payrollHubUrl = () => (config.role === 'hub' ? `http://127.0.0.1:${HUB_PORT}` : config.hubUrl || config.publicUrl || null);
async function startPayroll() {
  if (payroll) return payrollPort;
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'server', 'index.mjs')).href);
  fs.mkdirSync(payrollDir(), { recursive: true });
  payroll = createApp({ dbFile: path.join(payrollDir(), 'payroll-vault.db'), vault: true, hubUrl: payrollHubUrl(), log: false });
  payrollPort = await payroll.listen(0);
  log('payroll vault started', payrollDir());
  return payrollPort;
}
async function openPayroll() {
  const port = await startPayroll();
  if (payrollWin) { if (payrollWin.isMinimized()) payrollWin.restore(); payrollWin.show(); payrollWin.focus(); return true; }
  const origin = `http://127.0.0.1:${port}`;
  payrollWin = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 560, title: 'KeaS Payroll', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  payrollWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });
  payrollWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault(); });
  // Closing the window stops the vault server: the key leaves memory and the next open asks for the passphrase again.
  payrollWin.on('closed', () => { payrollWin = null; const p = payroll; payroll = null; payrollPort = null; p?.close().catch(() => {}); });
  await payrollWin.loadURL(`${origin}/payroll`);
  return true;
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
      try { await hub?.close(); await org?.close(); await payroll?.close(); } catch {}
      app.exit(0);
    }, Number(process.env.KEAS_CAPTURE_DELAY || 1500)));
  }
}
function makeTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(config.role === 'hub' ? 'KeaS · Kea Hub running' : 'KeaS · server running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open KeaS', click: showWindow },
    { label: 'Payroll', click: () => openPayroll().catch((e) => log('payroll', e.message)) },
    { type: 'separator' },
    { label: 'Quit KeaS (stops the server)', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
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
  handle('state', async () => ({ config: { ...config, googleClientSecret: undefined }, running: { hub: !!hub, org: !!org }, port: servicePort(), defaults: { hubData: defaultFolder('Kea Hub'), orgData: defaultFolder('KeaS Server') }, version: app.getVersion() }));
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
    config = writeConfig({ ...config, role, dataDir, storageDir: storageDir || path.join(dataDir, 'storage'), quotaGb: Number(quotaGb) || 25, tailscale: reach === 'tailscale' });
    return config;
  });
  handle('start', async () => { await startServices(); return { hub: !!hub, org: !!org, port: servicePort() }; });

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
    if (!hub) throw new Error('Start the Hub first.');
    let token;
    const existing = hub.h.get('SELECT id FROM accounts WHERE email = ?', String(email).trim().toLowerCase());
    if (existing) token = (await local('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).token;
    else token = (await local('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName: name, age13: true, termsVersion, termsSections }) })).token;
    const a = hub.h.get('SELECT * FROM accounts WHERE email = ?', String(email).trim().toLowerCase());
    hub.h.run("UPDATE accounts SET role = 'owner', can_host = 1, email_verified = 1, verified_by = 'owner', identity_verified = 1, updated_at = ? WHERE id = ?", Date.now(), a.id);
    hub.h.run('INSERT INTO audit (at,actor,action,target,ip) VALUES (?,?,?,?,?)', Date.now(), 'keas-setup', 'owner.make_owner', a.id, 'local');
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
  nativeTheme.themeSource = config.theme === 'light' || config.theme === 'dark' ? config.theme : 'system';
  registerIpc();
  if (config.setupDone) {
    try { await startServices(); } catch (e) { log('start failed', e.message); }
    makeTray();
  }
  if (!process.argv.includes('--hidden') || !config.setupDone) showWindow();
});
app.on('window-all-closed', () => { if (!config.setupDone) app.quit(); });
app.on('before-quit', async () => { app.isQuitting = true; try { await hub?.close(); await org?.close(); await payroll?.close(); } catch {} });
