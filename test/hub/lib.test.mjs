import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, verifyPassword, needsRehash, passwordProblem } from '../../hub/lib/passwords.mjs';
import { codeAt, checkCode, base32, unbase32, stepOf } from '../../hub/lib/totp.mjs';
import { loadOrCreateKey, signToken, verifyToken } from '../../hub/lib/tokens.mjs';
import { Windows, lockFor, FREE, MAX_LOCK_MS } from '../../hub/lib/limiter.mjs';
import { scoreAnswer, POINTS, INTERVAL_DAYS, levelOf, xpForLevel, streak, weekStart, capped, DAILY_CAP } from '../../hub/lib/study.mjs';
import { seal, open } from '../../hub/backup.mjs';

const DAY = 86400_000;

test('passwords: argon2id hash verifies, wrong and missing fail, hash format', async () => {
  const hsh = await hashPassword('correct horse battery');
  assert.match(hsh, /^argon2id\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword('correct horse battery', hsh), true);
  assert.equal(await verifyPassword('correct horse batterz', hsh), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
  assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  assert.equal(needsRehash(hsh), false);
  assert.equal(needsRehash('argon2id$m=4096,t=1,p=1$AAAA$BBBB'), true);
});

test('passwords: scrypt (used inside the desktop app, where Electron has no Argon2) verifies too', async () => {
  const s = await hashPassword('correct horse battery', { algorithm: 'scrypt' });
  assert.match(s, /^scrypt\$n=17,r=8,p=1\$/);
  assert.equal(await verifyPassword('correct horse battery', s), true);
  assert.equal(await verifyPassword('correct horse batterz', s), false);
  assert.equal(await verifyPassword('x', 'scrypt$n=40,r=8,p=1$AAAA$BBBB'), false, 'absurd cost is refused, not run');
  assert.equal(needsRehash('scrypt$n=14,r=8,p=1$AAAA$BBBB'), true);
});

test('password rules: length, common list, own email/name', () => {
  assert.match(passwordProblem('short'), /10 characters/);
  assert.match(passwordProblem('password123'), /common/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /repeated|common/);
  assert.match(passwordProblem('kadenw213-is-me', { email: 'kadenw213@gmail.com' }), /email/);
  assert.match(passwordProblem('Kaden Walsh 2026', { name: 'Kaden Walsh' }), /name/);
  assert.equal(passwordProblem('lantern velvet orbit'), null);
});

test('TOTP matches the RFC 6238 SHA-1 test vector and refuses replays', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  // RFC 6238 Appendix B: T=59s -> 94287082 (8 digits), so the 6-digit code is 287082.
  assert.equal(codeAt(secret, stepOf(59_000)), '287082');
  const t = 1_111_111_109_000; // RFC: 07081804
  assert.equal(codeAt(secret, stepOf(t)), '081804');
  const s = checkCode(secret, '081804', t);
  assert.equal(s, stepOf(t));
  assert.equal(checkCode(secret, '081804', t, s), null, 'same code twice is refused');
  assert.equal(checkCode(secret, '081804', t + 30_000), stepOf(t), 'one step of drift allowed');
  assert.equal(checkCode(secret, '081804', t + 90_000), null);
  assert.equal(checkCode(secret, 'abc', t), null);
});

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

test('study scoring: new, not-due, review, miss then right, spaced intervals', () => {
  let t = 0;
  let r = scoreAnswer(null, true, t);
  assert.deepEqual([r.points, r.state.box, r.state.dueAt], [POINTS.newFirstTry, 1, INTERVAL_DAYS[0] * DAY]);
  // Again straight away: practice only.
  const again = scoreAnswer(r.state, true, t + 1000);
  assert.deepEqual([again.points, again.due], [0, false]);
  // Due tomorrow: review points, box 2, next in 3 days.
  t = DAY;
  r = scoreAnswer(r.state, true, t);
  assert.deepEqual([r.points, r.state.box, r.state.dueAt - t], [POINTS.reviewFirstTry + POINTS.reviewBoxBonus, 2, INTERVAL_DAYS[1] * DAY]);
  // Due again: miss, miss, then right -> small points, back to box 0, tomorrow.
  t += 3 * DAY;
  r = scoreAnswer(r.state, false, t); assert.equal(r.points, 0);
  r = scoreAnswer(r.state, false, t); assert.equal(r.points, 0);
  r = scoreAnswer(r.state, true, t);
  assert.deepEqual([r.points, r.state.box, r.state.dueAt - t], [POINTS.afterMiss, 0, DAY]);
  // Wrong on a brand-new question then right: after-miss points.
  const n = scoreAnswer(scoreAnswer(null, false, 0).state, true, 0);
  assert.equal(n.points, POINTS.afterMiss);
  assert.equal(capped(50, DAILY_CAP - 20), 20);
  assert.equal(capped(50, DAILY_CAP + 5), 0);
});

test('levels, streaks, week start', () => {
  assert.deepEqual([0, 99, 100, 299, 300, 600].map((x) => levelOf(x).level), [1, 1, 2, 2, 3, 4]);
  assert.equal(xpForLevel(2), 100);
  const now = Date.UTC(2026, 10, 5, 15); // Thursday
  assert.equal(new Date(weekStart(now)).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(streak(['2026-11-05', '2026-11-04', '2026-11-03', '2026-11-01'], now), 3);
  assert.equal(streak(['2026-11-04', '2026-11-03'], now), 2, 'not studied yet today still counts the run');
  assert.equal(streak(['2026-11-02'], now), 0);
});

test('backup sealing: round trip, wrong passphrase refused', () => {
  const b = seal(Buffer.from('hello hub'), 'a long recovery phrase');
  assert.equal(open(b, 'a long recovery phrase').toString(), 'hello hub');
  assert.throws(() => open(b, 'the wrong phrase here'), /passphrase/);
});
