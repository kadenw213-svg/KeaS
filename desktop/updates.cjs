// KeaS updates itself from its GitHub releases, the same way Kea does (electron-updater; the installer is checked
// against the sha512 in the release's latest.yml before it runs). It looks every few hours and downloads by itself, but
// installs only when the owner says so: installing restarts KeaS, and the Hub with it, so it never happens on its own.
function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::ERR/i.test(msg)) return 'Couldn’t reach GitHub. Check the internet connection and try again.';
  if (/404|latest\.yml/i.test(msg)) return 'No KeaS release with updates was found yet.';
  return msg.split('\n')[0].slice(0, 200);
}

/**
 * enabled: only the installed app updates (a copy run from source says so instead). send(state): every change, for the
 * window and the tray. beforeInstall(): just before KeaS quits to install. loadUpdater: for tests.
 */
function createUpdates({ enabled, log = () => {}, send = () => {}, beforeInstall = () => {}, loadUpdater = () => require('electron-updater').autoUpdater }) {
  let updater = null;
  let state = { status: enabled ? 'idle' : 'dev' };
  let checking = null;
  const set = (s) => { state = s; send(s); };
  function get() {
    if (updater) return updater;
    const u = loadUpdater();
    u.autoDownload = true;
    // (A quit from the tray, or Windows shutting down, stays just that: nothing installs without the owner asking.)
    u.autoInstallOnAppQuit = false;
    u.allowPrerelease = false;
    u.on('checking-for-update', () => set({ status: 'checking' }));
    u.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    u.on('update-not-available', () => set({ status: 'latest' }));
    u.on('download-progress', (p) => set({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }));
    u.on('update-downloaded', (info) => { log(`update ${info.version} downloaded`); set({ status: 'ready', version: info.version }); });
    u.on('error', (err) => { log('update error', String(err?.message || err).split('\n')[0]); set({ status: 'error', message: friendly(err) }); });
    return (updater = u);
  }
  async function check() {
    if (!enabled) return state;
    // (A downloaded update stays ready; one being downloaded keeps going.)
    if (state.status === 'ready' || state.status === 'downloading') return state;
    if (checking) return checking;
    checking = (async () => {
      set({ status: 'checking' });
      try { await get().checkForUpdates(); } catch (e) { set({ status: 'error', message: friendly(e) }); }
      return state;
    })().finally(() => { checking = null; });
    return checking;
  }
  function install() {
    if (state.status !== 'ready') throw new Error('No update is ready to install yet.');
    log(`installing update ${state.version}`);
    beforeInstall();
    // Silent install, then KeaS starts again: no installer window to get stuck behind.
    setImmediate(() => get().quitAndInstall(true, true));
    return true;
  }
  let timers = [];
  function start({ firstMs = 2 * 60e3, everyMs = 4 * 3600e3 } = {}) {
    if (!enabled || timers.length) return;
    timers = [setTimeout(check, firstMs), setInterval(check, everyMs)];
  }
  const stop = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; };
  return { state: () => state, check, install, start, stop };
}

module.exports = { createUpdates, friendly };
