// The version contract (protocol 1) on the CURRENT KeaC and KeaS, with the current Kea PC and phone clients:
// - GET /v1/health: protocol 1, minClients { kea, keaPhone, keas }, latest { kea, keas }, updateUrls { kea, keaPhone, keas };
// - a client below minClients[app] gets 426 { error, upgradeRequired, app, minVersion, updateUrl } (never /v1/health);
// - no x-kea-client, or one without a version ("Kea for Android"), is served as before;
// - KeaS says KeaS/<version> to KeaC; the phone says Kea-Phone/<version>.
// Older servers without these fields are covered by test/compat/compat.test.mjs (current clients x previous servers).
// The same file is in Kea, KeaS and KeaC: keep them the same.
//   node --test test/compat/protocol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocolCell, runSpec } from './harness.mjs';

const cell = protocolCell();
const run = cell.spec ? runSpec(cell.spec) : null;
// The checks the cell makes (cell.mjs protocolChecks), each its own test.
const CHECKS = [
  'keac health contract',
  'keas health contract',
  'keas sends KeaS/<version> to keac',
  'equal or newer client works (default minimums)',
  'keac 426: Kea PC too old (raw)',
  'keac 426: Kea phone too old (raw)',
  'keac 426: KeaS too old (raw)',
  'keac /v1/health never 426',
  'keac: no header works (account made, signed in, /v1/me)',
  'keac: unversioned "Kea for Android" works',
  'keac 426: current Kea PC client (hub.cjs) sees upgradeRequired',
  'keac: current phone client vs raised keaPhone minimum',
  'phone sends Kea-Phone/<version>',
  'keac: client at exactly minClients works',
  'keas 426: Kea PC too old (raw)',
  'keas 426: Kea phone too old (raw)',
  'keas /v1/health never 426',
  'keas: no header and unversioned work (identity, pass sign-in)',
  'keas: current Kea PC client (serversCore) vs raised kea minimum',
];
for (const name of CHECKS) {
  test(`protocol: ${name}`, { skip: cell.skip || false, timeout: 180_000 }, async (t) => {
    const res = await run;
    const s = res.steps.find((x) => x.name === name);
    assert.ok(s, `not reached${res.fatal ? `: ${res.fatal}` : ''}`);
    if (s.detail !== undefined) t.diagnostic(JSON.stringify(s.detail));
    assert.ok(s.ok, `${s.error}${s.data ? `\n  data: ${JSON.stringify(s.data)}` : ''}`);
  });
}
