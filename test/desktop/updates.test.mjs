// KeaS's updater (desktop/updates.cjs): downloads by itself, installs when asked or by itself at night (the clock is the test's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdates, friendly, nightlyDecision, inNightly, nightlyOf, hoursText, updateInfo, warnOf, newer, ago } = require('../../desktop/updates.cjs');
// Local times (the nightly hours are this computer's clock).
const at = (h, m = 0, day = 8) => new Date(2026, 10, day, h, m);

function fakeUpdater(script) {
  const u = new EventEmitter();
  u.installs = [];
  u.checkForUpdates = async () => { await script(u); return {}; };
  u.quitAndInstall = (...a) => u.installs.push(a);
  return u;
}

test('a copy run from source never checks', async () => {
  let loaded = false;
  const up = createUpdates({ enabled: false, loadUpdater: () => { loaded = true; } });
  assert.equal((await up.check()).status, 'dev');
  assert.equal(loaded, false);
});

test('finds, downloads and holds an update until the owner installs it', async () => {
  const seen = [];
  let before = 0;
  const u = fakeUpdater(async (x) => {
    x.emit('checking-for-update');
    x.emit('update-available', { version: '9.9.9' });
    x.emit('download-progress', { percent: 41.6 });
    x.emit('update-downloaded', { version: '9.9.9' });
  });
  const up = createUpdates({ enabled: true, send: (s) => seen.push(s.status), beforeInstall: () => before++, loadUpdater: () => u });
  await up.check();
  const { info, ...rest } = up.state();
  assert.deepEqual(rest, { status: 'ready', version: '9.9.9', nightly: { on: true, from: 3, to: 5, hours: '3 and 5 a.m.' } });
  assert.equal(info.action, 'install');
  assert.ok(seen.includes('downloading'));
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, false, 'quitting KeaS never installs by itself');
  assert.equal(u.installs.length, 0, 'nothing installs until asked');
  assert.equal((await up.check()).status, 'ready', 'a ready update stays ready');
  up.install();
  await new Promise((r) => setImmediate(r));
  assert.equal(before, 1);
  assert.deepEqual(u.installs, [[true, true]], 'silent install, then KeaS starts again');
});

test('installing with nothing ready is refused; errors read plainly', async () => {
  const u = fakeUpdater(async (x) => x.emit('update-not-available'));
  const up = createUpdates({ enabled: true, loadUpdater: () => u });
  await up.check();
  assert.equal(up.state().status, 'latest');
  assert.throws(() => up.install(), /No update is ready/);
  const bad = createUpdates({ enabled: true, loadUpdater: () => fakeUpdater(async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }) });
  assert.match((await bad.check()).message, /Couldn’t reach GitHub/);
  assert.match(friendly(new Error('HttpError: 404 latest.yml')), /No KeaS release/);
});

// ---------- the nightly install ----------
const ready = (opts) => {
  const u = fakeUpdater(async (x) => x.emit('update-downloaded', { version: '9.9.9' }));
  const seen = { before: [] };
  const up = createUpdates({ enabled: true, loadUpdater: () => u, beforeInstall: (a) => seen.before.push(a), ...opts });
  return { u, up, seen };
};
const settle = () => new Promise((r) => setImmediate(r));

test('nightly hours: 3 to 5 a.m. by default, other hours, past midnight, and nonsense falls back', () => {
  assert.deepEqual(nightlyOf(undefined), { on: true, from: 3, to: 5 });
  assert.deepEqual(nightlyOf({ on: false }), { on: false, from: 3, to: 5 });
  assert.deepEqual(nightlyOf({ from: 'x', to: 99 }), { on: true, from: 3, to: 5 });
  assert.deepEqual(nightlyOf({ from: 4, to: 4 }), { on: true, from: 4, to: 6 }, 'no empty window');
  assert.equal(inNightly(at(2, 59), {}), false);
  assert.equal(inNightly(at(3, 0), {}), true);
  assert.equal(inNightly(at(4, 59), {}), true);
  assert.equal(inNightly(at(5, 0), {}), false);
  assert.equal(inNightly(at(15, 0), {}), false);
  // 11 p.m. to 1 a.m.
  const late = { from: 23, to: 1 };
  assert.deepEqual([at(22, 59), at(23, 0), at(0, 30), at(1, 0)].map((d) => inNightly(d, late)), [false, true, true, false]);
  assert.equal(hoursText({}), '3 and 5 a.m.');
  assert.equal(hoursText(late), '11 p.m. and 1 a.m.');
  assert.equal(hoursText({ from: 11, to: 13 }), '11 a.m. and 1 p.m.');
  assert.equal(hoursText({ from: 0, to: 2 }), '12 and 2 a.m.');
});

test('nightly decision: only a ready update, inside the hours, with the setting on, and Payroll not open or in use', () => {
  const base = { status: 'ready', nightly: { on: true }, now: at(3, 30), busy: null };
  assert.deepEqual(nightlyDecision(base), { install: true });
  assert.deepEqual(nightlyDecision({ ...base, nightly: { on: false } }), { install: false, why: 'off' });
  assert.deepEqual(nightlyDecision({ ...base, status: 'downloading' }), { install: false, why: 'nothing to install' });
  assert.deepEqual(nightlyDecision({ ...base, now: at(14) }), { install: false, why: 'not the hours' });
  assert.deepEqual(nightlyDecision({ ...base, busy: 'Payroll is open' }), { install: false, why: 'Payroll is open' });
  assert.deepEqual(nightlyDecision({ ...base, nightly: undefined }), { install: true }, 'on unless turned off');
});

test('the nightly look installs a downloaded update by itself at night (and KeaS comes back in the tray), never in the day or while Payroll is busy', async () => {
  let clock = at(14, 0);
  let payroll = 'Payroll is open';
  let setting = { on: true, from: 3, to: 5 };
  const { u, up, seen } = ready({ now: () => clock, busy: () => payroll, nightly: () => setting });
  await up.check();
  assert.equal(up.state().status, 'ready');
  // The afternoon: waits.
  assert.equal(up.tick().why, 'not the hours');
  // 3:05 a.m. but Payroll is open (a pay run is worked on only there): waits.
  clock = at(3, 5, 9);
  assert.equal(up.tick().why, 'Payroll is open');
  payroll = 'Payroll is in use';
  assert.equal(up.tick().why, 'Payroll is in use');
  await settle();
  assert.equal(u.installs.length, 0);
  // Payroll closed at 3:40: it installs, silently, and KeaS starts again (beforeInstall says it was the nightly one).
  payroll = null;
  clock = at(3, 40, 9);
  assert.deepEqual(up.tick(), { install: true });
  await settle();
  assert.deepEqual(u.installs, [[true, true]]);
  assert.deepEqual(seen.before, [{ nightly: true }]);
  // Only once, however many looks come after.
  up.tick();
  await settle();
  assert.equal(u.installs.length, 1);
});

test('the nightly install: off means never by itself; Install now still works; a busy check that throws counts as busy', async () => {
  let clock = at(4, 0);
  const off = ready({ now: () => clock, nightly: () => ({ on: false }) });
  await off.up.check();
  assert.equal(off.up.state().nightly.on, false);
  assert.equal(off.up.tick().why, 'off');
  await settle();
  assert.equal(off.u.installs.length, 0);
  off.up.install();
  await settle();
  assert.deepEqual([off.u.installs.length, off.seen.before[0].nightly], [1, false], 'Install now is not the nightly one');
  const broken = ready({ now: () => clock, busy: () => { throw new Error('vault busy'); } });
  await broken.up.check();
  assert.match(broken.up.tick().why, /couldn’t tell/);
  await settle();
  assert.equal(broken.u.installs.length, 0);
  // Nothing downloaded: nothing to install, at any hour.
  const none = createUpdates({ enabled: true, now: () => clock, loadUpdater: () => fakeUpdater(async (x) => x.emit('update-not-available')) });
  await none.check();
  assert.equal(none.tick().why, 'nothing to install');
});

test('start() looks every few minutes (the clock and the timers are the test’s)', async () => {
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
  const intervals = [];
  globalThis.setTimeout = (fn, ms) => ({ fn, ms, unref() {} });
  globalThis.setInterval = (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; };
  let up;
  try {
    ({ up } = ready({ now: () => at(3, 10) }));
    up.start({ tickMs: 5 * 60e3 });
  } finally { Object.assign(globalThis, real); up?.stop(); }
  const look = intervals.find((t) => t.ms === 5 * 60e3);
  assert.ok(look, 'a 5-minute look');
  await up.check();
  assert.deepEqual(look.fn(), { install: true });
});

// ---------- never silently stale: what the window shows (updateInfo), with the test's clock ----------
const H = 3600e3, D = 24 * H;
const T0 = at(12, 0).getTime();
const info = (state, history = {}, more = {}) => updateInfo({ state, history, current: '0.8.1', now: T0, ...more });

test('versions, "how long ago", and the stuck settings', () => {
  assert.equal(newer('0.9.0', '0.8.1'), true);
  assert.equal(newer('0.8.10', '0.8.9'), true, 'numbers, not text');
  assert.equal(newer('v1.0.0', '0.8.1'), true);
  assert.equal(newer('0.8.1', '0.8.1'), false);
  assert.equal(newer('0.8.0', '0.8.1'), false);
  assert.equal(newer('0.9.0-beta.1', '0.9.0'), false, 'a prerelease is older than its release');
  assert.equal(newer('0.9.0', '0.9.0-beta.1'), true);
  assert.equal(newer(null, '0.8.1'), false);
  assert.equal(newer('nonsense', '0.8.1'), false);
  assert.equal(ago(null, T0), 'never');
  assert.equal(ago(T0 - 20e3, T0), 'just now');
  assert.equal(ago(T0 - 60e3, T0), '1 minute ago');
  assert.equal(ago(T0 - 5 * H, T0), '5 hours ago');
  assert.equal(ago(T0 - 3 * D - H, T0), '3 days ago');
  assert.deepEqual(warnOf(undefined), { failures: 3, staleDays: 2, waitDays: 3 });
  assert.deepEqual(warnOf({ failures: 5, staleDays: 0, waitDays: 'x' }), { failures: 5, staleDays: 2, waitDays: 3 }, 'nonsense falls back');
});

test('each state reads plainly, with the button that fits', () => {
  const ok = { lastOk: T0 - 5 * 60e3, lastTry: T0 - 5 * 60e3 };
  assert.deepEqual([info({ status: 'dev' }).line, info({ status: 'dev' }).action], ['Updates work in the installed KeaS.', null]);
  assert.equal(info({ status: 'idle' }).line, 'KeaS 0.8.1 · not checked yet.');
  assert.deepEqual([info({ status: 'checking' }).line, info({ status: 'checking' }).action], ['Checking for updates…', null]);
  const latest = info({ status: 'latest' }, ok);
  assert.deepEqual([latest.line, latest.tone, latest.action, latest.problem], ['KeaS 0.8.1 is up to date (checked 5 minutes ago).', 'ok', 'check', null]);
  const dl = info({ status: 'downloading', version: '0.9.0', percent: 41 }, ok);
  assert.deepEqual([dl.line, dl.action, dl.from], ['Downloading KeaS 0.9.0… 41%', null, 'feed']);
  const ready = info({ status: 'ready', version: '0.9.0', nightly: { on: true, hours: '3 and 5 a.m.' } }, { ...ok, readyAt: T0 - H });
  assert.deepEqual([ready.line, ready.action, ready.tone, ready.problem], ['KeaS 0.9.0 is ready to install (tonight between 3 and 5 a.m.).', 'install', 'new', null]);
  const err = info({ status: 'error', message: 'Couldn’t reach GitHub.' }, { ...ok, failures: 1 });
  assert.deepEqual([err.line, err.tone, err.action, err.problem], ['The last update check didn’t work (checked 5 minutes ago).', 'bad', 'check', null], 'one failure soon after a good check is not "stuck" yet');
});

test('stuck: failed checks in a row, or a failure long after the last good check, say so with the last good time', () => {
  const s = { status: 'error', message: 'Couldn’t reach GitHub.' };
  const two = info(s, { lastOk: T0 - 10 * H, failures: 2 });
  assert.equal(two.problem, null);
  const three = info(s, { lastOk: T0 - 10 * H, failures: 3 });
  assert.equal(three.problem.kind, 'failing');
  assert.equal(three.problem.text, 'KeaS can’t check for updates: 3 failed checks in a row. The last successful check was 10 hours ago. Last error: Couldn’t reach GitHub.');
  assert.equal(three.tone, 'bad');
  assert.equal(three.action, 'check');
  // One failure, but the last good check was 3 days ago (the PC was off, or checks stopped): stuck.
  assert.equal(info(s, { lastOk: T0 - 3 * D, failures: 1 }).problem.kind, 'failing');
  // Never checked successfully at all.
  assert.match(info(s, { failures: 3 }).problem.text, /hasn’t checked successfully since it was installed/);
  // Off for days, not one try yet since: no alarm before it has even tried.
  assert.equal(info({ status: 'idle' }, { lastOk: T0 - 5 * D, failures: 0 }).problem, null);
  // The Advanced settings move the line.
  assert.equal(info(s, { lastOk: T0 - 10 * H, failures: 3 }, { warn: { failures: 5 } }).problem, null);
  assert.equal(info(s, { lastOk: T0 - 10 * H, failures: 2 }, { warn: { failures: 2 } }).problem.kind, 'failing');
  // A copy run from source never says it's stuck.
  assert.equal(info({ status: 'dev' }, { failures: 9 }).problem, null);
});

test('stuck: a downloaded update waiting too long (the nightly install never happened), and a download that never finishes', () => {
  const ready = { status: 'ready', version: '0.9.0', nightly: { on: true, hours: '3 and 5 a.m.' } };
  assert.equal(info(ready, { lastOk: T0 - H, readyAt: T0 - 2 * D }).problem, null, '2 days: not yet');
  const late = info(ready, { lastOk: T0 - H, readyAt: T0 - 4 * D });
  assert.equal(late.problem.kind, 'waiting');
  assert.equal(late.problem.text, 'KeaS 0.9.0 was downloaded 4 days ago and still isn’t installed. The nightly install didn’t happen (the PC may be asleep or off at night). Install it now.');
  assert.equal(late.action, 'install');
  assert.match(info({ ...ready, waitWhy: 'Payroll is open' }, { readyAt: T0 - 4 * D }).problem.text, /last time: Payroll is open/);
  assert.match(info({ ...ready, nightly: { on: false } }, { readyAt: T0 - 4 * D }).problem.text, /Installing at night is off/);
  assert.equal(info(ready, { readyAt: T0 - 2 * D }, { warn: { waitDays: 1 } }).problem.kind, 'waiting');
  const stalled = info({ status: 'downloading', version: '0.9.0', percent: 12 }, { lastOk: T0 - 3 * D, downloadAt: T0 - 3 * D });
  assert.equal(stalled.problem.kind, 'stalled');
  assert.equal(stalled.action, 'check', 'a stalled download can be tried again');
});

test('the fallback: the server advertises a newer KeaS than this one, even when the app’s own check failed', () => {
  const failing = info({ status: 'error', message: 'x' }, { lastOk: T0 - 3 * D, failures: 4 }, { advertised: '0.9.0' });
  assert.deepEqual([failing.status, failing.version, failing.from, failing.action], ['available', '0.9.0', 'server', 'check']);
  assert.equal(failing.line, 'KeaS 0.9.0 is out; this KeaS (0.8.1) couldn’t download it yet.');
  assert.equal(failing.problem.kind, 'failing', 'and still says the checks are failing');
  assert.equal(info({ status: 'latest' }, { lastOk: T0 }, { advertised: '0.9.0' }).status, 'available', 'the feed may lag the server');
  assert.equal(info({ status: 'latest' }, { lastOk: T0 }, { advertised: '0.8.1' }).status, 'latest', 'not newer: nothing to say');
  assert.equal(info({ status: 'latest' }, { lastOk: T0 }, { advertised: null }).status, 'latest');
  assert.equal(info({ status: 'ready', version: '0.9.0' }, {}, { advertised: '0.9.1' }).status, 'ready', 'a ready download comes first');
  assert.equal(info({ status: 'dev' }, {}, { advertised: '0.9.0' }).status, 'dev');
});

test('the updater keeps the times: tries, good checks, failures in a row (once per try), kept across a restart', async () => {
  let clock = at(9, 0);
  let saved = {};
  const memory = { load: () => saved, save: (h) => { saved = JSON.parse(JSON.stringify(h)); } };
  let mode = 'down';
  const u = fakeUpdater(async (x) => {
    if (mode === 'down') { const e = new Error('getaddrinfo ENOTFOUND github.com'); x.emit('error', e); throw e; }
    x.emit('update-not-available');
  });
  const make = () => createUpdates({ enabled: true, current: '0.8.1', now: () => clock, memory, loadUpdater: () => u });
  let up = make();
  for (let i = 0; i < 3; i++) { clock = new Date(clock.getTime() + 4 * H); await up.check(); }
  assert.equal(saved.failures, 3, 'an error event and a rejected check count once');
  assert.equal(saved.lastOk, undefined);
  assert.equal(saved.lastTry, clock.getTime());
  const s = up.state();
  assert.equal(s.info.problem.kind, 'failing');
  assert.match(s.info.problem.text, /Couldn’t reach GitHub/);
  // A restart remembers.
  up = make();
  assert.equal(up.state().info.problem.kind, 'failing');
  // The feed comes back: good check, failures cleared.
  mode = 'up';
  clock = new Date(clock.getTime() + H);
  await up.check();
  assert.deepEqual([saved.failures, saved.lastOk, up.state().info.problem, up.state().info.status], [0, clock.getTime(), null, 'latest']);
});

test('a downloaded update remembers when it became ready, across restarts, until it is installed', async () => {
  let clock = at(14, 0, 1);
  let saved = {};
  const memory = { load: () => saved, save: (h) => { saved = JSON.parse(JSON.stringify(h)); } };
  const u = fakeUpdater(async (x) => { x.emit('update-available', { version: '0.9.0' }); x.emit('update-downloaded', { version: '0.9.0' }); });
  const told = [];
  const make = (current = '0.8.1') => createUpdates({ enabled: true, current, now: () => clock, memory, busy: () => 'Payroll is open', loadUpdater: () => u, send: (v) => told.push(v.info.problem?.kind || null) });
  let up = make();
  await up.check();
  const first = clock.getTime();
  assert.equal(saved.readyAt, first);
  assert.equal(up.state().info.problem, null);
  // Restarted the next days: downloaded again (from the cache), still waiting since the first day.
  clock = at(14, 0, 3);
  up = make();
  await up.check();
  assert.equal(saved.readyAt, first);
  assert.equal(up.state().info.problem, null, '2 days: not stuck yet');
  // The nightly look, 3.5 days on, waited for Payroll: the warning says why.
  clock = at(3, 30, 5);
  told.length = 0;
  up.tick();
  assert.deepEqual(told, ['waiting'], 'time alone made it stuck: the window and the tray are told, once');
  up.tick();
  assert.equal(told.length, 1);
  const st = up.state();
  assert.equal(st.info.problem.kind, 'waiting');
  assert.match(st.info.problem.text, /downloaded 3 days ago.*last time: Payroll is open/);
  // Installed: the new KeaS starts with nothing waiting.
  up = make('0.9.0');
  assert.deepEqual([up.history().pending, up.history().readyAt, up.state().info.problem], [null, null, null]);
});

test('the server’s advertised version: asked after each check (a failed one too), and noteAdvertised takes it directly', async () => {
  const seen = [];
  const u = fakeUpdater(async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); });
  let advert = '0.9.0';
  const up = createUpdates({ enabled: true, current: '0.8.1', now: () => at(12), loadUpdater: () => u, askServer: async () => advert, send: (s) => seen.push(s.info.status) });
  const s = await up.check();
  assert.deepEqual([s.status, s.info.status, s.info.version, s.info.from], ['error', 'available', '0.9.0', 'server']);
  assert.ok(seen.includes('available'), 'the window is told');
  advert = null;
  assert.equal((await up.check()).info.status, 'error', 'gone when the server stops saying so');
  assert.equal(up.noteAdvertised('1.0.0').info.version, '1.0.0');
  assert.equal(up.noteAdvertised('1.1.0-beta.1').info.status, 'error', 'never a prerelease');
  assert.equal(up.noteAdvertised({ evil: true }).info.status, 'error');
  // A server that can't be asked changes nothing.
  const quiet = createUpdates({ enabled: true, current: '0.8.1', loadUpdater: () => fakeUpdater(async (x) => x.emit('update-not-available')), askServer: async () => { throw new Error('down'); } });
  assert.equal((await quiet.check()).info.status, 'latest');
});
