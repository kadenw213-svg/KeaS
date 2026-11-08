// Pure pieces of the KeaS server: signed tokens, limits, backup sealing, client addresses, the payroll guard, CSV cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKey, signToken, verifyToken } from '../../hub/lib/tokens.mjs';
import { Windows, lockFor, FREE, MAX_LOCK_MS, failures, globalLockFor, GLOBAL_FREE, GLOBAL_IPS, GLOBAL_MAX_LOCK_MS } from '../../hub/lib/limiter.mjs';
import { seal, open } from '../../hub/backup.mjs';
import { clientAddress, cleanIp, ipBucket } from '../../hub/lib/clientip.mjs';
import { payrollKey, payrollValue, checkNoPayroll, MAX_NODES } from '../../org/payroll.mjs';

import { cell } from '../../org/logic.mjs';

test('signed tokens: verify, tamper, expiry, audience, wrong key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kea-hub-key-'));
  try {
    const key = loadOrCreateKey(join(dir, 'k.pem'));
    const again = loadOrCreateKey(join(dir, 'k.pem'));
    assert.equal(key.kid, again.kid, 'key persists');
    const now = 1_800_000_000_000;
    const tok = signToken(key, { iss: 'kea-hub', sub: 'u1', aud: 'org-a', exp: now / 1000 + 60 });
    assert.equal(verifyToken(key.publicKey, tok, { aud: 'org-a', nowMs: now }).sub, 'u1');
    assert.equal(verifyToken(key.publicKey, tok, { aud: 'org-b', nowMs: now }), null);
    assert.equal(verifyToken(key.publicKey, tok, { nowMs: now + 61_000 }), null);
    const [hd, , sig] = tok.split('.');
    const forged = `${hd}.${Buffer.from(JSON.stringify({ iss: 'kea-hub', sub: 'owner', exp: 9e9 })).toString('base64url')}.${sig}`;
    assert.equal(verifyToken(key.publicKey, forged, { nowMs: now }), null);
    assert.equal(verifyToken(generateKeyPairSync('ed25519').publicKey, tok, { nowMs: now }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('limiter: windows and doubling lockout', () => {
  const w = new Windows();
  for (let i = 0; i < 3; i++) assert.equal(w.hit('k', 3, 1000, 0), 0);
  assert.equal(w.hit('k', 3, 1000, 10), 990);
  assert.equal(w.hit('k', 3, 1000, 1001), 0);
  assert.equal(lockFor(FREE - 1), 0);
  assert.equal(lockFor(FREE), 1000);
  assert.equal(lockFor(FREE + 3), 8000);
  assert.equal(lockFor(FREE + 40), MAX_LOCK_MS);
});

test('backup sealing: round trip, wrong passphrase refused', () => {
  const b = seal(Buffer.from('hello hub'), 'a long recovery phrase');
  assert.equal(open(b, 'a long recovery phrase').toString(), 'hello hub');
  assert.throws(() => open(b, 'the wrong phrase here'), /passphrase/);
});

test('a record id is never taken for an SSN (the org tests that failed now and then: about 1% of random ids did)', () => {
  assert.equal(payrollValue('0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc'), false);
  assert.equal(payrollValue('see 0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc'), false);
  // A real one next to an id still counts.
  assert.equal(payrollValue('0f3a2b1c-9d8e-4f7a-8b6c-a123456789bc 123-45-6789'), true);
  assert.equal(payrollValue('123456789'), true);
});

test('client address: only the last X-Forwarded-For entry, only when configured, malformed values ignored', () => {
  // (X-Forwarded-For counts only on requests Tailscale Funnel marked as its own.)
  const h = (v) => ({ 'x-forwarded-for': v, 'tailscale-funnel-request': '?1' });
  const local = clientAddress({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', 'x-forwarded-for');
  assert.deepEqual(local, { ip: '127.0.0.1', shared: true, forwardedUntrusted: false }, 'a local program can’t pick its own address');
  assert.equal(clientAddress({ 'x-forwarded-for': '1.2.3.4', 'tailscale-funnel-request': '?0' }, '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1');
  // Another proxy's header, configured on purpose, is trusted as configured.
  assert.equal(clientAddress({ 'cf-connecting-ip': '9.9.9.9' }, '127.0.0.1', 'cf-connecting-ip').ip, '9.9.9.9');
  assert.deepEqual(clientAddress(h('1.2.3.4'), '127.0.0.1', 'x-forwarded-for'), { ip: '1.2.3.4', shared: false, forwardedUntrusted: false });
  assert.equal(clientAddress(h('6.6.6.6, 203.0.113.9'), '127.0.0.1', 'x-forwarded-for').ip, '203.0.113.9', 'earlier entries can be faked');
  assert.equal(clientAddress(h('203.0.113.9, garbage'), '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1', 'a malformed last entry is not used');
  assert.equal(clientAddress(h('203.0.113.9, garbage'), '127.0.0.1', 'x-forwarded-for').shared, true);
  assert.equal(clientAddress(h('1.2.3.4:5678'), '127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1', 'ports are not part of an address');
  assert.equal(clientAddress(h('[2001:db8::1]'), '127.0.0.1', 'x-forwarded-for').ip, '2001:db8::1');
  assert.equal(clientAddress(h('::ffff:198.51.100.2'), '127.0.0.1', 'x-forwarded-for').ip, '198.51.100.2');
  assert.equal(clientAddress({}, '::ffff:127.0.0.1', 'x-forwarded-for').ip, '127.0.0.1');
  // Not configured: the header is never trusted, and its presence is a setup warning.
  const u = clientAddress({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', null);
  assert.deepEqual(u, { ip: '127.0.0.1', shared: true, forwardedUntrusted: true });
  assert.deepEqual(clientAddress({}, '127.0.0.1', null), { ip: '127.0.0.1', shared: false, forwardedUntrusted: false });
  assert.equal(clientAddress({ 'tailscale-funnel-request': '?1' }, '127.0.0.1', null).forwardedUntrusted, true);
  assert.equal(cleanIp('fe80::1%eth0'), null);
  assert.equal(cleanIp('x'.repeat(100)), null);
  // IPv6 addresses count by their /64.
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), ipBucket('2001:db8:1:2:bbbb::2'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
});

test('payroll guard: disguised keys, SSN- and bank-shaped values, no depth limit, oversize refused', () => {
  for (const k of ['ssn', 'SSN', 'ѕѕn', 'ｓｓｎ', 's.s.n', 'S_S_N', 'socialSecurityNumber', 'bank_account', 'ΒankΑccount', 'routingNo', 'w4', 'directDeposit', 'payRuns', 'acct_no',
    'wage', 'hourlyWages', 'salary', 'annual_salary', 'payRate', 'pay_rates', 'PAYRATE', 'payRateCents', 'hourlyRate'])
    assert.equal(payrollKey(k), true, k);
  for (const k of ['className', 'assigned', 'waiting', 'notes', 'account', 'bank', 'route', 'session', 'costRate', 'rate', 'pay', 'payDay', 'hourly'])
    assert.equal(payrollKey(k), false, k);
  for (const v of ['123-45-6789', '123456789', 'SSN: 123-45-6789', '123 45 6789', '１２３-４５-６７８９', 'routing 102000021, account 000123456789'])
    assert.equal(payrollValue(v), true, v);
  for (const v of ['719-555-0134', '2026-12-01', '80202-1234', '1234567890', 'shift 9-5', '12345678'])
    assert.equal(payrollValue(v), false, v);
  const refuse = () => { throw new Error('refused'); };
  const tooBig = () => { throw new Error('too big'); };
  let deep = { bankAccount: 1 };
  for (let i = 0; i < 1000; i++) deep = [deep];
  assert.throws(() => checkNoPayroll({ x: deep }, refuse, tooBig), /refused/);
  assert.throws(() => checkNoPayroll({ list: Array.from({ length: MAX_NODES + 1 }, () => 1) }, refuse, tooBig), /too big/);
  checkNoPayroll({ a: [{ b: 'fine' }] }, refuse, tooBig);
});

test('design: CSV cells that a spreadsheet could run as a formula are escaped (tab, CR, full-width too)', () => {
  for (const v of ['=1+1', '+1', '-1', '@x', '\t=1', '\r=1', '＝1+1', '＋1', '－1', '＠x']) assert.ok(cell(v).startsWith(`"'`), JSON.stringify(v));
  assert.equal(cell('Ana'), 'Ana');
  assert.equal(cell('a,b'), '"a,b"');
});
