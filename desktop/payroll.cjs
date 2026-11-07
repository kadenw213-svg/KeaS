// Payroll in the KeaS app: starts the payroll vault (server/index.mjs in vault mode) on 127.0.0.1 only, on a free port,
// and opens it in its own KeaS window. Its data (SSNs, bank details, pay runs) stays on this computer, encrypted with
// the vault passphrase, and never goes to the Hub. Closing the window stops the vault server, so the key leaves the
// vault's memory.
//
// Signing in: KeaS is already signed in to the payroll admin's Kea account (account.cjs), so payroll never asks for the
// email and password again. KeaS gets a short-lived "keas-payroll" token from that Hub and hands it to the vault in
// this process (never over HTTP) with the passphrase. The passphrase is asked once per run of KeaS and kept in memory
// only (passkeeper.cjs). With "Ask for my sign-in every time I open Payroll" on, every open asks for the password, the
// passphrase and then the two-step code (the code last, so it doesn't run out while the passphrase is typed).
//
// Only this app decides which Kea Hub payroll trusts (this PC's own Hub, or the one KeaS is signed in to), whether a
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
const { createPassKeeper } = require('./passkeeper.cjs');

// The payroll window's own browser session, kept in memory only (nothing of it is saved when KeaS quits).
const PARTITION = 'keas-payroll';
const COOKIE = 'keas_session';
/** A file name for a saved export: no folders, nothing Windows can't save; a number added if it's taken. */
function exportPath(dir, name) {
  const clean = String(name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120) || 'export';
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  let f = path.join(dir, clean);
  for (let i = 2; fs.existsSync(f) && i < 1000; i++) f = path.join(dir, `${base} (${i})${ext}`);
  return f;
}
class PayrollError extends Error { constructor(m, data) { super(m); this.data = data || null; } }

/**
 * getConfig() -> the KeaS config; userData: the app's data folder; root: the app folder; hubPort: the local Hub's
 * port; account: the signed-in Kea account (account.cjs); onLocked(why): payroll locked itself and its window closed.
 */
function createPayroll({ getConfig, setConfig, userData, root, hubPort, account, icon, onLocked = () => {}, onSaved = (file) => shell.showItemInFolder(file), log = () => {} }) {
  let server = null, port = null, win = null, downloads = false, folderProblem = null, idleMs = 15 * 60_000;
  const keeper = createPassKeeper();
  const dir = () => getConfig().payrollDir || path.join(userData, 'Payroll');
  const exportsDir = () => path.join(dir(), 'Exports');
  const hubUrl = () => { const c = getConfig(); return c.role === 'hub' ? `http://127.0.0.1:${hubPort}` : (account?.signedIn() ? account.url() : c.hubUrl || null); };
  const localSignIn = () => !!getConfig().payrollLocalSignIn;
  const askEveryTime = () => !!getConfig().payrollAskEveryTime;
  /** The states KeaS has tax tables for (shared/tax/<ST>-<year>.json). */
  const taxStates = () => { try { return [...new Set(fs.readdirSync(path.join(root, 'shared', 'tax')).map((f) => /^([A-Z]{2})-\d{4}\.json$/.exec(f)?.[1]).filter((s) => s && s !== 'US'))]; } catch { return []; } };

  async function start() {
    if (server) return port;
    const { createApp } = await import(pathToFileURL(path.join(root, 'server', 'index.mjs')).href);
    // Only this Windows account (and SYSTEM and Administrators) can open the vault file and the exports.
    // A folder it can't vouch for is refused: the vault doesn't start until it's clean.
    try { await bootstart.secureDataFolder(dir(), { onWasOpen: () => log('the payroll folder was open to other accounts and is locked down now') }); folderProblem = null; }
    catch (e) { folderProblem = e.message; log('payroll folder permissions', e.message); throw e; }
    fs.mkdirSync(dir(), { recursive: true });
    // When this PC is the Hub, payroll checks whatever answers on the Hub's port against the key in the Hub's data
    // folder (desktop/hubid.cjs) before trusting it.
    const hubTrustKeys = () => {
      const c = getConfig();
      if (c.role !== 'hub' || !c.dataDir) return null;
      const pub = hubPublicKey(c.dataDir);
      return pub ? [{ kty: 'OKP', crv: 'Ed25519', x: pub.export({ format: 'jwk' }).x }] : null;
    };
    // setupToken: only this app's payroll window gets it (in the address's fragment, which never reaches a server or a
    // log), so nothing else on this PC can claim an empty vault by reaching the port first.
    server = createApp({ dbFile: path.join(dir(), 'payroll-vault.db'), vault: true, hubUrl: hubUrl(), localSignIn, hubTrustKeys, log: false, setupToken: crypto.randomBytes(32).toString('base64url'), onVaultLock: (why) => setImmediate(() => locked(why)) });
    port = await server.listen(0);
    log('payroll vault started', dir());
    return port;
  }
  async function stop() {
    const s = server;
    server = null; port = null;
    if (s) { try { idleMs = s.keas.status().idleMinutes * 60_000; noteSummary(s); } catch {} await s.close().catch(() => {}); }
  }
  // What Payroll's own "Get set up" said the last time the vault was open: step titles and done or not only (no
  // names or pay), in memory only, for the KeaS window's checklist.
  let summary = null;
  const noteSummary = (s = server) => { try { const v = s?.keas.checklist?.(); if (v) summary = v; } catch {} };
  /** The vault locked itself (a quiet spell) or Lock was chosen: the passphrase is forgotten and the window closes. */
  function locked(why) {
    keeper.forget();
    log('payroll locked', why);
    if (win) { const w = win; win = null; w.destroy(); stop(); onLocked(why); }
  }

  /** What the KeaS window needs to show for Payroll. */
  async function status() {
    const signedIn = !!account?.signedIn();
    const base = { signedIn, askEveryTime: askEveryTime(), remembered: keeper.has() && !askEveryTime(), open: !!win, hubUrl: hubUrl(), folderProblem, taxStates: taxStates() };
    if (!signedIn) return { ...base, initialized: null };
    try {
      await start();
      const st = server.keas.status();
      noteSummary();
      const out = { ...base, initialized: st.initialized, org: st.org, ownHub: st.ownHub, summary: st.initialized ? summary : null };
      if (!win) await stop();
      return out;
    } catch (e) { return { ...base, initialized: null, error: e.message }; }
  }

  /**
   * Opens Payroll. Remembered passphrase (and not "ask every time"): opens at once. Otherwise says what to ask for:
   * { need: 'setup' | 'unlock' }; the KeaS window asks, then calls setup() or unlock().
   */
  async function open() {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return { opened: true }; }
    if (!account?.signedIn()) throw new PayrollError('Sign in to your Kea account first.', { need: 'signin' });
    await start();
    const st = server.keas.status();
    if (!st.initialized) return { need: 'setup', ...(await server.keas.setupKey().catch((e) => ({ keyError: e.message }))) };
    if (askEveryTime() || !keeper.has()) return { need: 'unlock', askEveryTime: askEveryTime(), org: st.org };
    try { return await show(server.keas.signIn({ hubToken: await account.payrollToken(), passphrase: keeper.get() })); }
    catch (e) {
      // (A changed passphrase, or another account: ask again.)
      if (e.extra?.passphrase) { keeper.forget(); return { need: 'unlock', askEveryTime: false, org: st.org }; }
      throw asPayrollError(e);
    }
  }
  /** Sets up an empty vault for the signed-in account, then opens it. */
  async function setup({ org, passphrase, hubKeyFingerprint }) {
    if (!account?.signedIn()) throw new PayrollError('Sign in to your Kea account first.', { need: 'signin' });
    await start();
    let s;
    try { s = await server.keas.setup({ hubToken: await account.payrollToken(), passphrase, org, hubKeyFingerprint }); }
    catch (e) { throw asPayrollError(e); }
    if (!askEveryTime()) keeper.remember(passphrase);
    log('payroll vault set up');
    return show(s);
  }
  /**
   * Opens a vault that's set up: the passphrase (from the remembered sign-in), or with "ask every time" the password
   * and passphrase first, then { need: 'code' } when the Hub wants a two-step code, then all three.
   */
  async function unlock({ passphrase, password, code }) {
    if (!account?.signedIn()) throw new PayrollError('Sign in to your Kea account first.', { need: 'signin' });
    await start();
    let token;
    try {
      if (askEveryTime()) {
        try { token = await account.freshPayrollToken({ password, code }); }
        catch (e) {
          if (e.data?.totpRequired && !code) {
            // The password was right. Check the passphrase now, so the code is asked for last.
            server.keas.checkPassphrase({ email: account.cached()?.email, passphrase });
            return { need: 'code' };
          }
          if (e.data?.totpRequired) throw new PayrollError('That two-step code didn’t work. It may be used up or expired: wait for the next one.', { need: 'code' });
          throw e;
        }
      } else token = await account.payrollToken();
      const s = server.keas.signIn({ hubToken: token, passphrase });
      if (!askEveryTime()) keeper.remember(passphrase);
      return await show(s);
    } catch (e) { throw asPayrollError(e); }
  }
  const asPayrollError = (e) => (e instanceof PayrollError ? e : new PayrollError(e.message, e.extra || e.data || null));

  /** The payroll window, already signed in with the session the vault just made. */
  async function show(s) {
    const origin = `http://127.0.0.1:${port}`;
    const ses = session.fromPartition(PARTITION);
    if (!downloads) {
      downloads = true;
      // Exports (full SSNs if asked for, bank files) are saved in the locked-down payroll folder, then shown there.
      ses.on('will-download', (_e, item) => {
        fs.mkdirSync(exportsDir(), { recursive: true });
        const target = exportPath(exportsDir(), item.getFilename());
        item.setSavePath(target);
        item.once('done', (_e2, state) => { if (state === 'completed') { log('payroll export saved', target); onSaved(target); } });
      });
    }
    await ses.cookies.set({ url: origin, name: COOKIE, value: s.token, httpOnly: true, sameSite: 'strict' });
    keeper.active();
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 420, minHeight: 560, title: 'KeaS Payroll', backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f6f7f9',
      autoHideMenuBar: true, ...(icon ? { icon } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION },
    });
    const w = win;
    w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });
    w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault(); });
    w.on('closed', () => {
      if (win === w) win = null;
      // Closed: the vault stops; the passphrase is forgotten after the same quiet spell that would have locked it.
      stop().then(() => keeper.idle(idleMs));
    });
    await w.loadURL(`${origin}/payroll`);
    return { opened: true };
  }
  /** Forget the passphrase and close Payroll (signing out, another Hub, the setting turned on). */
  async function forget() {
    keeper.forget();
    summary = null;
    if (win) { const w = win; win = null; w.destroy(); }
    await stop();
  }
  function setAskEveryTime(on) {
    setConfig({ payrollAskEveryTime: !!on });
    if (on) keeper.forget();
    log('payroll ask every time', on ? 'on' : 'off');
    return settings();
  }

  /** The payroll settings only this app can change. */
  const settings = async () => ({ localSignIn: localSignIn(), askEveryTime: askEveryTime(), hubUrl: hubUrl(), exportsDir: exportsDir(), folderProblem, ownHubFingerprint: await localHubFingerprint() });
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
  return { open, setup, unlock, status, stop, forget, running: () => !!server, isOpen: () => !!win, settings, setLocalSignIn, setAskEveryTime, hubKey, repinHub, openExports: () => { fs.mkdirSync(exportsDir(), { recursive: true }); return shell.openPath(exportsDir()); } };
}

module.exports = { createPayroll, exportPath };
