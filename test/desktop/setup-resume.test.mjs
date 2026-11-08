// Setup remembers where it stopped (desktop/flow.cjs): a restart, a crash or closing KeaS never sends it back to the
// start or quietly sets up a second server; a PC that is still a Kea Hub opens on its status screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flow = require('../../desktop/flow.cjs');

test('the wizard: data folder, Kea account server, Kea account, this server, organization, place, reach, done', () => {
  assert.deepEqual(flow.WIZARD, ['welcome', 'keac', 'account', 'claim', 'org', 'place', 'reach', 'done']);
  assert.equal(flow.stepNext('claim'), 'org');
  assert.equal(flow.stepBack('welcome'), 'welcome');
  assert.equal(flow.stepNext('done'), 'done');
});

test('setup resumes at the saved step, with the folder and reachability already chosen', () => {
  assert.equal(flow.resumeStep({}), 'welcome');
  assert.equal(flow.resumeStep({ setupStep: 'org' }), 'welcome', 'nothing without the data folder');
  assert.equal(flow.resumeStep({ setupStep: 'org', dataDir: 'D:\\KeaS' }), 'org');
  assert.equal(flow.resumeStep({ setupStep: 'owner', dataDir: 'D:\\KeaS' }), 'welcome', 'a step from an older KeaS starts over');
  const r = flow.resumeChoices({ setupStep: 'reach', dataDir: 'D:\\KeaS', tailscale: false }, { serverData: 'E:\\KeaS' });
  assert.deepEqual(r, { step: 'reach', dataDir: 'D:\\KeaS', reach: 'local', needsServer: true });
  assert.equal(flow.resumeChoices({}, { serverData: 'E:\\KeaS' }).dataDir, 'E:\\KeaS');
});

test('the first screen: a Kea Hub’s status while its accounts haven’t moved, else home or setup; starting with Windows', () => {
  assert.equal(flow.firstView({ legacy: true, config: { dataDir: 'D:\\Kea Hub', role: 'hub', setupDone: true } }), 'legacy');
  assert.equal(flow.firstView({ config: { setupDone: true, dataDir: 'D:\\KeaS' } }), 'home');
  assert.equal(flow.firstView({ config: { setupStep: 'claim', dataDir: 'D:\\KeaS' } }), 'claim');
  assert.equal(flow.startWithWindows({ setupDone: true }), true);
  assert.equal(flow.startWithWindows({ setupDone: true, startWithWindows: false }), false);
  assert.equal(flow.startWithWindows({}), false);
});
