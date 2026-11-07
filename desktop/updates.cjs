// KeaS updates itself from its GitHub releases, the same way Kea does (electron-updater; the installer is checked
// against the sha512 in the release's latest.yml before it runs). It looks every few hours and downloads by itself.
// Installing restarts KeaS, and the Hub with it, so it happens when the owner says so ("Install now"), or by itself at
// night (between 3 and 5 a.m. unless set otherwise; a setting, on by default), and then only while Payroll isn't open
// or in use (a pay run being worked on happens only in an open Payroll). After installing, KeaS starts again and starts
// the Hub as it does at any start.
function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::ERR/i.test(msg)) return 'Couldn’t reach GitHub. Check the internet connection and try again.';
  if (/404|latest\.yml/i.test(msg)) return 'No KeaS release with updates was found yet.';
  return msg.split('\n')[0].slice(0, 200);
}

/** The nightly install's hours: on, from and to (local hours 0-23; from after to runs past midnight). */
const NIGHTLY = { on: true, from: 3, to: 5 };
function nightlyOf(n) {
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  const from = hour(n?.from, NIGHTLY.from);
  let to = hour(n?.to, NIGHTLY.to);
  if (to === from) to = (from + 2) % 24;
  return { on: n?.on !== false, from, to };
}
/** `date` (local time) is inside the nightly hours. */
function inNightly(date, n) {
  const { from, to } = nightlyOf(n);
  const h = date.getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}
/**
 * Whether the nightly install goes ahead now: { install: true } or { install: false, why }. busy: why it can't (Payroll
 * open or in use), or null.
 */
function nightlyDecision({ status, nightly, now, busy }) {
  const n = nightlyOf(nightly);
  if (!n.on) return { install: false, why: 'off' };
  if (status !== 'ready') return { install: false, why: 'nothing to install' };
  if (!inNightly(now, n)) return { install: false, why: 'not the hours' };
  if (busy) return { install: false, why: busy };
  return { install: true };
}
/** "3 and 5 a.m.", "11 p.m. and 1 a.m.": the hours, for the panel. */
function hoursText(n) {
  const { from, to } = nightlyOf(n);
  const half = (x) => (x < 12 ? 'a.m.' : 'p.m.');
  const num = (x) => String(x % 12 === 0 ? 12 : x % 12);
  return half(from) === half(to) && from < to ? `${num(from)} and ${num(to)} ${half(to)}` : `${num(from)} ${half(from)} and ${num(to)} ${half(to)}`;
}

/**
 * enabled: only the installed app updates (a copy run from source says so instead). send(state): every change, for the
 * window and the tray. beforeInstall({ nightly }): just before KeaS quits to install. nightly(): the setting
 * ({ on, from, to }). busy(): why it mustn't install by itself right now, or null. now(): the clock. loadUpdater: for
 * tests.
 */
function createUpdates({ enabled, log = () => {}, send = () => {}, beforeInstall = () => {}, nightly = () => NIGHTLY, busy = () => null, now = () => new Date(), loadUpdater = () => require('electron-updater').autoUpdater }) {
  let updater = null;
  let state = { status: enabled ? 'idle' : 'dev' };
  let checking = null;
  /** What the window sees: a ready update says when it installs by itself. */
  const view = () => (state.status === 'ready' ? { ...state, nightly: { ...nightlyOf(nightly()), hours: hoursText(nightly()) } } : state);
  const set = (s) => { state = s; send(view()); };
  function get() {
    if (updater) return updater;
    const u = loadUpdater();
    u.autoDownload = true;
    // (A quit from the tray, or Windows shutting down, stays just that: nothing installs then.)
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
    if (!enabled) return view();
    // (A downloaded update stays ready; one being downloaded keeps going.)
    if (state.status === 'ready' || state.status === 'downloading') return view();
    if (checking) return checking;
    checking = (async () => {
      set({ status: 'checking' });
      try { await get().checkForUpdates(); } catch (e) { set({ status: 'error', message: friendly(e) }); }
      return view();
    })().finally(() => { checking = null; });
    return checking;
  }
  let installing = false;
  function install({ auto = false } = {}) {
    if (state.status !== 'ready') throw new Error('No update is ready to install yet.');
    if (installing) return true;
    installing = true;
    log(`installing update ${state.version}${auto ? ' (at night, by itself)' : ''}`);
    beforeInstall({ nightly: auto });
    // Silent install, then KeaS starts again: no installer window to get stuck behind.
    setImmediate(() => get().quitAndInstall(true, true));
    return true;
  }
  /** The nightly look: installs a ready update inside the hours when nothing is in the way. Returns the decision. */
  let lastWhy = null;
  function tick() {
    let why = null;
    try { why = busy(); } catch (e) { why = `couldn’t tell (${e.message})`; }
    const d = nightlyDecision({ status: state.status, nightly: nightly(), now: now(), busy: why });
    if (d.install) install({ auto: true });
    else if (d.why !== lastWhy && state.status === 'ready' && d.why !== 'not the hours') log('nightly update waits:', d.why);
    lastWhy = d.install ? null : d.why;
    return d;
  }
  let timers = [];
  function start({ firstMs = 2 * 60e3, everyMs = 4 * 3600e3, tickMs = 5 * 60e3 } = {}) {
    if (!enabled || timers.length) return;
    timers = [setTimeout(check, firstMs), setInterval(check, everyMs), setInterval(tick, tickMs)];
  }
  const stop = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; };
  return { state: view, check, install, tick, start, stop };
}

module.exports = { createUpdates, friendly, nightlyDecision, inNightly, nightlyOf, hoursText, NIGHTLY };
