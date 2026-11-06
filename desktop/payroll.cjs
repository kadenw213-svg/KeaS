// Payroll in the KeaS app: starts the payroll vault (server/index.mjs in vault mode) on 127.0.0.1 only, on a free port,
// and opens it in its own KeaS window. Its data (SSNs, bank details, pay runs) stays on this computer, encrypted with
// the vault passphrase, and never goes to the Hub. Payroll admins sign in with their Kea Hub account plus the
// passphrase. Closing the window stops the vault server, so the key leaves memory and the next open asks for the
// passphrase again.
//
// Only this app decides which Kea Hub payroll trusts (this PC's own Hub, or the one in KeaS's settings), whether a
// local password may be used while that Hub can't be reached (off unless the owner turns it on here), and whether to
// accept a Hub's new signing key (only after the owner has seen and confirmed its fingerprint). None of these can be
// changed from the payroll page or any other web page.
//
// The payroll folder is locked down like the data folder (this Windows account, SYSTEM and Administrators only), and
// files the payroll page saves (W-2 and 1099 data, bank files, reports) go into its Exports folder, not Downloads.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, shell, nativeTheme, session } = require('electron');
const bootstart = require('./bootstart.cjs');
const { hubPublicKey } = require('./hubid.cjs');

// The payroll window's own browser session, kept in memory only (nothing of it is saved when KeaS quits).
const PARTITION = 'keas-payroll';
/** A file name for a saved export: no folders, nothing Windows can't save; a number added if it's taken. */
function exportPath(dir, name) {
  const clean = String(name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120) || 'export';
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  let f = path.join(dir, clean);
  for (let i = 2; fs.existsSync(f) && i < 1000; i++) f = path.join(dir, `${base} (${i})${ext}`);
  return f;
}

/** getConfig() -> the KeaS config; userData: the app's data folder; root: the app folder; hubPort: the local Hub's port. */
function createPayroll({ getConfig, setConfig, userData, root, hubPort, log = () => {} }) {
  let server = null, port = null, win = null, downloads = false, folderProblem = null;
  const dir = () => getConfig().payrollDir || path.join(userData, 'Payroll');
  const exportsDir = () => path.join(dir(), 'Exports');
  const hubUrl = () => { const c = getConfig(); return c.role === 'hub' ? `http://127.0.0.1:${hubPort}` : c.hubUrl || null; };
  const localSignIn = () => !!getConfig().payrollLocalSignIn;

  async function start() {
    if (server) return port;
    const { createApp } = await import(pathToFileURL(path.join(root, 'server', 'index.mjs')).href);
    // Only this Windows account (and SYSTEM and Administrators) can open the vault file and the exports.
    try { await bootstart.secureDataFolder(dir()); folderProblem = null; } catch (e) { folderProblem = e.message; log('payroll folder permissions', e.message); }
    fs.mkdirSync(dir(), { recursive: true });
    // When this PC is the Hub, payroll checks whatever answers on the Hub's port against the key in the Hub's data
    // folder (desktop/hubid.cjs) before sending it a password: it must sign a fresh nonce with that key.
    const hubTrustKeys = () => {
      const c = getConfig();
      if (c.role !== 'hub' || !c.dataDir) return null;
      const pub = hubPublicKey(c.dataDir);
      return pub ? [{ kty: 'OKP', crv: 'Ed25519', x: pub.export({ format: 'jwk' }).x }] : null;
    };
    // setupToken: only this app's payroll window gets it (in the address's fragment, which never reaches a server or a
    // log), so nothing else on this PC can claim an empty vault by reaching the port first.
    server = createApp({ dbFile: path.join(dir(), 'payroll-vault.db'), vault: true, hubUrl: hubUrl(), localSignIn, hubTrustKeys, log: false, setupToken: crypto.randomBytes(32).toString('base64url') });
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
    const ses = session.fromPartition(PARTITION);
    if (!downloads) {
      downloads = true;
      // Exports (full SSNs if asked for, bank files) are saved in the locked-down payroll folder, then shown there.
      ses.on('will-download', (_e, item) => {
        fs.mkdirSync(exportsDir(), { recursive: true });
        const target = exportPath(exportsDir(), item.getFilename());
        item.setSavePath(target);
        item.once('done', (_e2, state) => { if (state === 'completed') { log('payroll export saved', target); shell.showItemInFolder(target); } });
      });
    }
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 420, minHeight: 560, title: 'KeaS Payroll', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f6f7f9',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION },
    });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault(); });
    win.on('closed', () => { win = null; stop(); });
    await win.loadURL(`${origin}/payroll${server.vault.initialized() ? '' : `#setup=${server.setupToken}`}`);
    return true;
  }
  /** The payroll settings only this app can change. */
  const settings = () => ({ localSignIn: localSignIn(), hubUrl: hubUrl(), exportsDir: exportsDir(), folderProblem });
  function setLocalSignIn(on) { setConfig({ payrollLocalSignIn: !!on }); log('payroll local sign-in', on ? 'on' : 'off'); return settings(); }
  /** This PC's own Hub key (when this PC is the Hub): its fingerprint, to check the key the Hub offers against. */
  async function localHubFingerprint() {
    const c = getConfig();
    if (c.role !== 'hub' || !c.dataDir) return null;
    try {
      const x = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(path.join(c.dataDir, 'hub-signing-key.pem')))).export({ format: 'jwk' }).x;
      const { keyFingerprint } = await import(pathToFileURL(path.join(root, 'server', 'payroll', 'hub.mjs')).href);
      return keyFingerprint([{ x }]);
    } catch { return null; }
  }
  /** The Hub's current key next to the trusted one (fingerprints, and why a key changes), before accepting it. */
  async function hubKey() {
    await start();
    const s = await server.hubKeyStatus();
    const local = await localHubFingerprint();
    return { ...s, localHub: local ? { fingerprint: local, matches: local === s.current.fingerprint } : null };
  }
  /** Accepts the Kea Hub's current signing key: only the one whose fingerprint the owner confirmed. */
  async function repinHub({ fingerprint } = {}) {
    await start();
    const kids = await server.repinHub({ fingerprint });
    log('payroll: accepted the Kea Hub signing key', kids.join(','), fingerprint);
    return { kids, fingerprint };
  }
  return { open, stop, running: () => !!server, settings, setLocalSignIn, hubKey, repinHub };
}

module.exports = { createPayroll, exportPath };
