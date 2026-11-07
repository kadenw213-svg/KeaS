// KeaS's updater (desktop/updates.cjs): downloads by itself, installs only when asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdates, friendly } = require('../../desktop/updates.cjs');

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
  assert.deepEqual(up.state(), { status: 'ready', version: '9.9.9' });
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
