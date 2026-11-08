// Updating KeaS 0.5 to 0.6 on a PC that's still the Kea Hub: the owner's Hub sign-in (0.5 kept it in the profile
// folder) moves to where 0.6's Hub account client keeps it, so payroll doesn't ask for it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { adoptOldSession } = require('../../desktop/legacy-account.cjs');

test('the 0.5 Hub sign-in moves to hub-account once; KeaC’s files are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keas-legacy-'));
  try {
    const to = join(dir, 'hub-account');
    writeFileSync(join(dir, 'hub-session.bin'), 'sealed');
    writeFileSync(join(dir, 'account.json'), JSON.stringify({ id: 'a1', email: 'o@example.com', owner: true, hub: 'http://127.0.0.1:4860' }));
    assert.deepEqual(adoptOldSession(dir, to), ['hub-session.bin', 'account.json']);
    assert.equal(readFileSync(join(to, 'hub-session.bin'), 'utf8'), 'sealed');
    assert.equal(JSON.parse(readFileSync(join(to, 'account.json'), 'utf8')).email, 'o@example.com');
    assert.ok(!existsSync(join(dir, 'hub-session.bin')) && !existsSync(join(dir, 'account.json')));
    assert.deepEqual(adoptOldSession(dir, to), []);
    // KeaC's summary (0.6) stays where it is.
    writeFileSync(join(dir, 'account.json'), JSON.stringify({ id: 'a1', email: 'o@example.com', keac: 'https://keac.example.net' }));
    assert.deepEqual(adoptOldSession(dir, to), []);
    assert.ok(existsSync(join(dir, 'account.json')));
    // A newer Hub sign-in made in 0.6 isn't replaced by an old one.
    writeFileSync(join(dir, 'hub-session.bin'), 'older');
    writeFileSync(join(to, 'hub-session.bin'), 'newer');
    assert.deepEqual(adoptOldSession(dir, to), []);
    assert.equal(readFileSync(join(to, 'hub-session.bin'), 'utf8'), 'newer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
