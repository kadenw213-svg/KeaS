// Password hashing for the Kea Hub. Passwords are never stored or logged: only a slow, memory-hard one-way hash with
// a random salt per account. Not even the owner can read a password back; recovery is a reset.
//
// Argon2id where the runtime has it (Node 24.7+). Inside the KeaS desktop app, Electron's crypto library (BoringSSL)
// has no Argon2, so there it's scrypt at OWASP's recommended strength (N=2^17, r=8, p=1: 128 MiB per hash). Both
// formats verify wherever their algorithm exists, and a hash weaker than today's settings is upgraded on the next
// successful sign-in (needsRehash).
import { argon2, argon2Sync, scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { COMMON } from './common-passwords.mjs';

export const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
export const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };

export const HAS_ARGON2 = (() => {
  try { argon2Sync('argon2id', { message: 'x', nonce: Buffer.alloc(16), parallelism: 1, tagLength: 16, memory: 64, passes: 1 }); return true; } catch { return false; }
})();

const b64 = (b) => Buffer.from(b).toString('base64url');
const deriveArgon = (password, salt, p) =>
  new Promise((resolve, reject) =>
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.parallelism, tagLength: p.tagLength, memory: p.memory, passes: p.passes }, (err, out) => (err ? reject(err) : resolve(out))),
  );
const deriveScrypt = (password, salt, p) =>
  new Promise((resolve, reject) =>
    scrypt(Buffer.from(password, 'utf8'), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/** `argon2id$m=19456,t=2,p=1$<salt>$<hash>` or `scrypt$n=17,r=8,p=1$<salt>$<hash>` (n is log2 N). */
export async function hashPassword(password, { algorithm = HAS_ARGON2 ? 'argon2id' : 'scrypt' } = {}) {
  const salt = randomBytes(16);
  if (algorithm === 'argon2id') {
    const p = PARAMS;
    return `argon2id$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(await deriveArgon(password, salt, p))}`;
  }
  const s = SCRYPT;
  return `scrypt$n=${Math.log2(s.N)},r=${s.r},p=${s.p}$${b64(salt)}$${b64(await deriveScrypt(password, salt, s))}`;
}

function parse(stored) {
  const str = String(stored || '');
  let m = /^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(str);
  if (m) { const hash = Buffer.from(m[5], 'base64url'); return { alg: 'argon2id', memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: hash.length, salt: Buffer.from(m[4], 'base64url'), hash }; }
  m = /^scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(str);
  if (m && +m[1] >= 10 && +m[1] <= 22) { const hash = Buffer.from(m[5], 'base64url'); return { alg: 'scrypt', N: 2 ** +m[1], r: +m[2], p: +m[3], keylen: hash.length, salt: Buffer.from(m[4], 'base64url'), hash }; }
  return null;
}

// A real hash of a random password: checking an unknown email costs the same time as checking a real one.
let dummy = null;
const dummyHash = async () => (dummy ??= await hashPassword(randomBytes(18).toString('base64url')));

/** Constant-time check. A missing or malformed hash still does the full work and returns false. */
export async function verifyPassword(password, stored) {
  const real = parse(stored);
  const p = real && (real.alg === 'scrypt' || HAS_ARGON2) ? real : parse(await dummyHash());
  const pw = String(password ?? '');
  const out = p.alg === 'argon2id' ? await deriveArgon(pw, p.salt, p) : await deriveScrypt(pw, p.salt, p);
  return p === real && timingSafeEqual(out, p.hash);
}

export const needsRehash = (stored) => {
  const p = parse(stored);
  if (!p) return true;
  if (p.alg === 'argon2id') return p.memory < PARAMS.memory || p.passes < PARAMS.passes || p.tagLength !== PARAMS.tagLength;
  // scrypt: upgrade to Argon2id where it exists, or to today's scrypt strength.
  return HAS_ARGON2 || p.N < SCRYPT.N || p.r < SCRYPT.r || p.keylen !== SCRYPT.keylen;
};

/** Why a new password is refused, or null. Long passphrases are encouraged; composition rules are not used (NIST 800-63B). */
export function passwordProblem(password, { email = '', name = '' } = {}) {
  if (typeof password !== 'string') return 'Enter a password.';
  if ([...password].length < 10) return 'Use at least 10 characters. A few random words works well.';
  if (password.length > 256) return 'Use 256 characters or fewer.';
  const low = password.toLowerCase();
  if (COMMON.has(low)) return 'That password is one of the most common ones. Pick something less guessable.';
  if (/^(.)\1+$/.test(password)) return 'That password is one repeated character.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && low.includes(local)) return "Don't use your email in your password.";
  const n = String(name).toLowerCase().replace(/\s+/g, '');
  if (n.length >= 4 && low.replace(/\s+/g, '').includes(n)) return "Don't use your name in your password.";
  return null;
}
