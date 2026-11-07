// KeaS's updater (desktop/updates.cjs): downloads by itself, installs when asked or by itself at night (the clock is the test's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdates, friendly, nightlyDecision, inNightly, nightlyOf, hoursText } = require('../../desktop/updates.cjs');
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
  assert.deepEqual(up.state(), { status: 'ready', version: '9.9.9', nightly: { on: true, from: 3, to: 5, hours: '3 and 5 a.m.' } });
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
