// Payroll in the KeaS app: starts the payroll vault (server/index.mjs in vault mode) on 127.0.0.1 only, on a free port,
// and opens it in its own KeaS window. Its data (SSNs, bank details, pay runs) stays on this computer, encrypted with
// the vault passphrase, and never goes to the Hub. Payroll admins sign in with their Kea Hub account plus the
// passphrase. Closing the window stops the vault server, so the key leaves memory and the next open asks for the
// passphrase again.
//
// Only this app decides which Kea Hub payroll trusts (this PC's own Hub, or the one in KeaS's settings), whether a
// local password may be used while that Hub can't be reached (off unless the owner turns it on here), and whether to
// accept a Hub's new signing key. None of these can be changed from the payroll page or any other web page.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, shell, nativeTheme } = require('electron');

/** getConfig() -> the KeaS config; userData: the app's data folder; root: the app folder; hubPort: the local Hub's port. */
function createPayroll({ getConfig, setConfig, userData, root, hubPort, log = () => {} }) {
  let server = null, port = null, win = null;
  const dir = () => getConfig().payrollDir || path.join(userData, 'Payroll');
  const hubUrl = () => { const c = getConfig(); return c.role === 'hub' ? `http://127.0.0.1:${hubPort}` : c.hubUrl || null; };
  const localSignIn = () => !!getConfig().payrollLocalSignIn;

  async function start() {
    if (server) return port;
    const { createApp } = await import(pathToFileURL(path.join(root, 'server', 'index.mjs')).href);
    fs.mkdirSync(dir(), { recursive: true });
    server = createApp({ dbFile: path.join(dir(), 'payroll-vault.db'), vault: true, hubUrl: hubUrl(), localSignIn, log: false });
    port = await server.listen(0);
    log('payroll vault started', dir());
    return port;
  }
  async function stop() {
    const s = server;
    server = null; port = null;
    if (s) await s.close().catch(() => {});
  }
  async function open() {
    const p = await start();
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true; }
    const origin = `http://127.0.0.1:${p}`;
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 420, minHeight: 560, title: 'KeaS Payroll', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f6f7f9',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault(); });
    win.on('closed', () => { win = null; stop(); });
    await win.loadURL(`${origin}/payroll`);
    return true;
  }
  /** The payroll settings only this app can change. */
  const settings = () => ({ localSignIn: localSignIn(), hubUrl: hubUrl() });
  function setLocalSignIn(on) { setConfig({ payrollLocalSignIn: !!on }); log('payroll local sign-in', on ? 'on' : 'off'); return settings(); }
  /** Accepts the Kea Hub's current signing key (after the Hub was moved or reinstalled). */
  async function repinHub() {
    await start();
    const kids = await server.repinHub();
    log('payroll: accepted the Kea Hub signing key', kids.join(','));
    return { kids };
  }
  return { open, stop, running: () => !!server, settings, setLocalSignIn, repinHub };
}

module.exports = { createPayroll };
