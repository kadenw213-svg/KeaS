// Password hashing for the Kea Hub. Passwords are never stored or logged: only an Argon2id hash (Node's built-in
// crypto.argon2), with a random salt per account. Not even the owner can read a password back; recovery is a reset.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { COMMON } from './common-passwords.mjs';

// OWASP's Argon2id baseline (19 MiB, 2 passes, 1 lane). Stored in the hash string, so it can be raised later and old
// hashes are upgraded on the next successful sign-in (needsRehash).
export const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

const b64 = (b) => Buffer.from(b).toString('base64url');
const derive = (password, salt, p) =>
  new Promise((resolve, reject) =>
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.parallelism, tagLength: p.tagLength, memory: p.memory, passes: p.passes }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/** `argon2id$m=19456,t=2,p=1$<salt>$<hash>` */
export async function hashPassword(password, p = PARAMS) {
  const salt = randomBytes(16);
  const out = await derive(password, salt, p);
  return `argon2id$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(out)}`;
}

function parse(stored) {
  const m = /^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored || ''));
  if (!m) return null;
  const hash = Buffer.from(m[5], 'base64url');
  return { memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: hash.length, salt: Buffer.from(m[4], 'base64url'), hash };
}

// A real hash of a random password: checking an unknown email costs the same time as checking a real one.
let dummy = null;
const dummyHash = async () => (dummy ??= await hashPassword(randomBytes(18).toString('base64url')));

/** Constant-time check. A missing or malformed hash still does the full work and returns false. */
export async function verifyPassword(password, stored) {
  const p = parse(stored) ?? parse(await dummyHash());
  const out = await derive(String(password ?? ''), p.salt, p);
  return stored != null && parse(stored) !== null && timingSafeEqual(out, p.hash);
}

export const needsRehash = (stored) => {
  const p = parse(stored);
  return !p || p.memory < PARAMS.memory || p.passes < PARAMS.passes || p.tagLength !== PARAMS.tagLength;
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
