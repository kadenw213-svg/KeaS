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

// ---------- never silently stale: what the window shows ----------
// An updater that quietly stops working looks just like one with nothing new, so KeaS keeps the times of the last
// successful check and of the last try, the failures in a row, and when a download became ready (kept in the app's
// config, so a restart doesn't hide how long it has waited), and says plainly when it's stuck.

/** When to say it's stuck: after this many failed checks in a row, or a failed check this many days after the last
 * good one; and when a downloaded update has waited this many days without installing. */
const WARN = { failures: 3, staleDays: 2, waitDays: 3 };
function warnOf(w) {
  const num = (v, d, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : d);
  return { failures: num(w?.failures, WARN.failures, 50), staleDays: num(w?.staleDays, WARN.staleDays, 60), waitDays: num(w?.waitDays, WARN.waitDays, 60) };
}
const DAY = 24 * 3600e3;
/** a is a newer version than b ("0.9.0" > "0.8.1"; a prerelease is older than its release). Anything unreadable: false. */
function newer(a, b) {
  const p = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(v ?? '').trim()); return m ? [+m[1], +m[2], +m[3], m[4] || null] : null; };
  const x = p(a), y = p(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (x[3] === y[3]) return false;
  return !x[3] ? true : !y[3] ? false : x[3] > y[3];
}
/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", "never". */
function ago(t, now) {
  if (!t) return 'never';
  const m = Math.floor(Math.max(0, now - t) / 60e3);
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'} ago`;
  return m < 1 ? 'just now' : m < 60 ? n(m, 'minute') : m < 24 * 60 ? n(Math.floor(m / 60), 'hour') : n(Math.floor(m / (24 * 60)), 'day');
}

/**
 * What to show, from the updater's state and its history (pure; the clock is passed in). state: { status, version,
 * percent, message, nightly, waitWhy }. history: { lastOk, lastTry, failures, downloadAt, readyAt } (ms). current: this KeaS's
 * version. advertised: the newest KeaS this PC's server knows of (GET /v1/health latest.keas), or null. Returns
 * { status, version, current, percent, lastOk, lastTry, failures, downloadAt, readyAt, from, action, tone, line, problem }:
 * status adds 'available' (the server knows a newer KeaS than the app could get); action 'install' | 'check' | null;
 * tone 'ok' | 'busy' | 'new' | 'bad' | 'off'; line: one short sentence for the home screen; problem: null or
 * { kind: 'failing' | 'stalled' | 'waiting', text } when it's stuck.
 */
function updateInfo({ state = {}, history = {}, current = null, advertised = null, now, warn } = {}) {
  const w = warnOf(warn);
  const h = { lastOk: history.lastOk || null, lastTry: history.lastTry || null, failures: history.failures || 0, downloadAt: history.downloadAt || null, readyAt: history.readyAt || null };
  let { status = 'idle', version = null } = state;
  let from = status === 'ready' || status === 'downloading' ? 'feed' : null;
  // The fallback: the app's own check failed (or found nothing), but the server it runs knows of a newer KeaS.
  if (!['dev', 'checking', 'downloading', 'ready'].includes(status) && newer(advertised, current)) { status = 'available'; version = advertised; from = 'server'; }
  const checked = h.lastOk ? `checked ${ago(h.lastOk, now)}` : 'not checked yet';
  const nightlyOn = state.nightly?.on;
  const line = {
    dev: 'Updates work in the installed KeaS.',
    idle: `KeaS ${current || ''} · ${checked}.`,
    checking: 'Checking for updates…',
    latest: `KeaS ${current || ''} is up to date (${checked}).`,
    available: `KeaS ${version} is out; this KeaS (${current}) couldn’t download it yet.`,
    downloading: `Downloading KeaS ${version || ''}… ${state.percent || 0}%`,
    ready: `KeaS ${version} is ready to install${nightlyOn && state.nightly?.hours ? ` (tonight between ${state.nightly.hours})` : ''}.`,
    error: `The last update check didn’t work (${checked}).`,
  }[status] || '';
  const tone = { dev: 'off', idle: 'off', checking: 'busy', downloading: 'busy', latest: 'ok', available: 'new', ready: 'new', error: 'bad' }[status] || 'off';
  let problem = null;
  const since = h.lastOk ? `The last successful check was ${ago(h.lastOk, now)}.` : 'It hasn’t checked successfully since it was installed.';
  if (status !== 'dev' && h.failures > 0 && (h.failures >= w.failures || (h.lastOk && now - h.lastOk > w.staleDays * DAY))) {
    problem = { kind: 'failing', text: `KeaS can’t check for updates: ${h.failures} failed check${h.failures === 1 ? '' : 's'} in a row. ${since}${state.message ? ` Last error: ${state.message}` : ''}` };
  } else if (state.status === 'downloading' && h.downloadAt && now - h.downloadAt > w.staleDays * DAY) {
    problem = { kind: 'stalled', text: `The download of KeaS ${version || ''} started ${ago(h.downloadAt, now)} and hasn’t finished. ${since}` };
  } else if (state.status === 'ready' && h.readyAt && now - h.readyAt > w.waitDays * DAY) {
    const why = !nightlyOn ? 'Installing at night is off.' : state.waitWhy ? `The nightly install didn’t happen (last time: ${state.waitWhy}).` : 'The nightly install didn’t happen (the PC may be asleep or off at night).';
    problem = { kind: 'waiting', text: `KeaS ${version} was downloaded ${ago(h.readyAt, now)} and still isn’t installed. ${why} Install it now.` };
  }
  const action = status === 'ready' ? 'install' : status === 'dev' || status === 'checking' || (status === 'downloading' && !problem) ? null : 'check';
  return { status, version, current, percent: state.percent ?? null, ...h, from, action, tone: problem ? 'bad' : tone, line, problem };
}

/**
 * enabled: only the installed app updates (a copy run from source says so instead). send(state): every change, for the
 * window and the tray. beforeInstall({ nightly }): just before KeaS quits to install. nightly(): the setting
 * ({ on, from, to }). busy(): why it mustn't install by itself right now, or null. now(): the clock. loadUpdater: for
 * tests. current: this KeaS's version. warn(): when to say it's stuck (see WARN). memory: { load(), save(history) }
 * keeps the times across restarts. askServer(): the newest KeaS this PC's server advertises, or null; asked after each
 * check, so a feed KeaS can't reach still leaves a sign that there's something newer (noteAdvertised takes it too).
 */
function createUpdates({ enabled, log = () => {}, send = () => {}, beforeInstall = () => {}, nightly = () => NIGHTLY, busy = () => null, now = () => new Date(), loadUpdater = () => require('electron-updater').autoUpdater, current = null, warn = () => WARN, memory = null, askServer = null }) {
  let updater = null;
  let state = { status: enabled ? 'idle' : 'dev' };
  let checking = null;
  let advertised = null;
  let waitWhy = null; // why the nightly install last waited inside its hours (Payroll open...), for the "stuck" text
  let lastProgress = 0;
  const ms = () => +now();
  // The history: { lastOk, lastTry, failures, pending (the version downloading or ready), downloadAt, readyAt }.
  let history = {};
  try { history = { ...(memory?.load() || {}) }; } catch {}
  // An update that was waiting and is now installed (or isn't newer than this KeaS) is done with.
  if (history.pending && current && !newer(history.pending, current)) history = { ...history, pending: null, downloadAt: null, readyAt: null };
  const remember = (patch) => { history = { ...history, ...patch }; try { memory?.save(history); } catch (e) { log('update history', e.message); } };
  /** What the window sees: a ready update says when it installs by itself; info is what to show (updateInfo). */
  const view = () => {
    const base = state.status === 'ready' ? { ...state, nightly: { ...nightlyOf(nightly()), hours: hoursText(nightly()) } } : state;
    let w = WARN;
    try { w = warn(); } catch {}
    return { ...base, info: updateInfo({ state: { ...base, waitWhy }, history, current, advertised, now: ms(), warn: w }) };
  };
  // (Sent on every change, and from the nightly look when time alone made it stuck, so the tray hears of it too.)
  let toldProblem = null;
  const tell = () => { const v = view(); toldProblem = v.info.problem?.kind || null; send(v); };
  const set = (s) => { state = s; tell(); };
  // One failure per try, however many ways the updater reports it (an 'error' event and a rejected check).
  let tryFailed = false;
  const failed = () => { if (tryFailed) return; tryFailed = true; remember({ failures: (history.failures || 0) + 1 }); };
  const reached = () => remember({ lastOk: ms(), failures: 0 });
  function get() {
    if (updater) return updater;
    const u = loadUpdater();
    u.autoDownload = true;
    // (A quit from the tray, or Windows shutting down, stays just that: nothing installs then.)
    u.autoInstallOnAppQuit = false;
    u.allowPrerelease = false;
    u.on('checking-for-update', () => set({ status: 'checking' }));
    u.on('update-available', (info) => {
      reached();
      if (history.pending !== info.version || !history.downloadAt) remember({ pending: info.version, downloadAt: ms(), readyAt: null });
      lastProgress = ms();
      set({ status: 'downloading', version: info.version, percent: 0 });
    });
    u.on('update-not-available', () => { reached(); remember({ pending: null, downloadAt: null, readyAt: null }); set({ status: 'latest' }); });
    u.on('download-progress', (p) => { lastProgress = ms(); set({ status: 'downloading', version: state.version, percent: Math.round(p.percent) }); });
    u.on('update-downloaded', (info) => {
      log(`update ${info.version} downloaded`);
      // (Downloaded again after a restart: it has been waiting since the first time.)
      if (history.pending !== info.version || !history.readyAt) remember({ pending: info.version, readyAt: ms() });
      set({ status: 'ready', version: info.version });
    });
    u.on('error', (err) => { log('update error', String(err?.message || err).split('\n')[0]); failed(); set({ status: 'error', message: friendly(err) }); });
    return (updater = u);
  }
  /** The newest KeaS this PC's server advertises (GET /v1/health latest.keas): "available" when newer than this one. */
  function noteAdvertised(version) {
    // (A prerelease is never offered, as the updater itself never takes one.)
    const v = typeof version === 'string' && !version.includes('-') && newer(version.trim(), '0.0.0') ? version.trim().replace(/^v/, '') : null;
    if (v !== advertised) { advertised = v; tell(); }
    return view();
  }
  async function check() {
    if (!enabled) return view();
    // (A downloaded update stays ready; one being downloaded keeps going, unless it has had no progress for half an hour.)
    if (state.status === 'ready' || (state.status === 'downloading' && ms() - lastProgress < 30 * 60e3)) return view();
    if (checking) return checking;
    checking = (async () => {
      tryFailed = false;
      remember({ lastTry: ms() });
      set({ status: 'checking' });
      try { await get().checkForUpdates(); } catch (e) { failed(); set({ status: 'error', message: friendly(e) }); }
      if (askServer) { try { noteAdvertised(await askServer()); } catch {} }
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
    if (!d.install && state.status === 'ready' && !['not the hours', 'off'].includes(d.why)) waitWhy = d.why;
    lastWhy = d.install ? null : d.why;
    if (!d.install && (view().info.problem?.kind || null) !== toldProblem) tell();
    return d;
  }
  let timers = [];
  function start({ firstMs = 2 * 60e3, everyMs = 4 * 3600e3, tickMs = 5 * 60e3 } = {}) {
    if (!enabled || timers.length) return;
    timers = [setTimeout(check, firstMs), setInterval(check, everyMs), setInterval(tick, tickMs)];
  }
  const stop = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; };
  return { state: view, check, install, tick, start, stop, noteAdvertised, history: () => ({ ...history }) };
}

module.exports = { createUpdates, friendly, nightlyDecision, inNightly, nightlyOf, hoursText, NIGHTLY, updateInfo, warnOf, newer, ago, WARN };
