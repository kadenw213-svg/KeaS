// Brute-force protection.
// - Per IP: a sliding window per action (in memory; the tunnel's own limits sit in front of this).
// - Per sign-in name AND client address (login_fail_pairs): after FREE failures from one address, each further one
//   doubles the wait, up to MAX_LOCK. A correct password from that address during its lock is still refused, so
//   guessing from one place gains nothing. Someone else's failures never lock the owner of the account out from their
//   own address.
// - Per sign-in name, from everywhere (login_failures): a much higher ceiling for guessing spread over many addresses.
//   Only after GLOBAL_FREE failures from at least GLOBAL_IPS different addresses does the name lock for everyone, for
//   at most GLOBAL_MAX_LOCK at a time. While it's locked no password is even checked, so a distributed guesser gets at
//   most about one try per GLOBAL_MAX_LOCK. Sign-in with Google, and a correct password with a correct two-step code,
//   still work during this lock (hub/index.mjs).
// Failures are counted for ANY email, whether or not an account exists, so a lockout never reveals which emails have
// accounts.
import { createHash } from 'node:crypto';

export const FREE = 5;
export const MAX_LOCK_MS = 15 * 60_000;
export const GLOBAL_FREE = 50;
export const GLOBAL_IPS = 10;
export const GLOBAL_MAX_LOCK_MS = 5 * 60_000;
const FAILURE_MEMORY_MS = 24 * 3600_000;

export class Windows {
  constructor() { this.hits = new Map(); }
  /** Records a hit; returns 0 if allowed, else ms until the oldest hit leaves the window. */
  hit(key, limit, windowMs, nowMs) {
    const list = (this.hits.get(key) || []).filter((t) => t > nowMs - windowMs);
    if (list.length >= limit) { this.hits.set(key, list); return list[0] + windowMs - nowMs; }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.sweep(nowMs, windowMs);
    return 0;
  }
  sweep(nowMs, windowMs) { for (const [k, v] of this.hits) if (!v.some((t) => t > nowMs - windowMs)) this.hits.delete(k); }
}

export const lockFor = (failures) => (failures < FREE ? 0 : Math.min(MAX_LOCK_MS, 1000 * 2 ** (failures - FREE)));
/** The name-wide lock: none until GLOBAL_FREE failures from GLOBAL_IPS addresses, then doubling up to GLOBAL_MAX_LOCK. */
export const globalLockFor = (failures, ips) =>
  (failures < GLOBAL_FREE || ips < GLOBAL_IPS ? 0 : Math.min(GLOBAL_MAX_LOCK_MS, 1000 * 2 ** Math.min(30, failures - GLOBAL_FREE)));

const ipHash = (ip) => createHash('sha256').update(`ip:${ip}`).digest('hex').slice(0, 32);

export const FAILURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS login_fail_pairs (
  name_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL, locked_until INTEGER NOT NULL,
  PRIMARY KEY (name_hash, ip_hash)
);
CREATE INDEX IF NOT EXISTS login_fail_pairs_at ON login_fail_pairs(last_at);
`;

/**
 * Sign-in failure tracking: login_fail_pairs (name + address) and login_failures (name, from everywhere).
 * `ip` is the limiter bucket of the client address (hub/lib/clientip.mjs).
 */
export function failures(h, nowFn) {
  h.db.exec(FAILURE_SCHEMA);
  const pairRow = (nh, ip) => h.get('SELECT * FROM login_fail_pairs WHERE name_hash = ? AND ip_hash = ?', nh, ipHash(ip));
  return {
    /** ms the name+address pair is still locked, or 0. */
    pairLocked(nameHash, ip) { const p = pairRow(nameHash, ip); return p ? Math.max(0, p.locked_until - nowFn()) : 0; },
    /** ms the name is locked for everyone, or 0. */
    globalLocked(nameHash) { const g = h.get('SELECT * FROM login_failures WHERE name_hash = ?', nameHash); return g ? Math.max(0, g.locked_until - nowFn()) : 0; },
    fail(nameHash, ip) {
      const now = nowFn();
      const p = pairRow(nameHash, ip);
      const count = p && now - p.last_at < FAILURE_MEMORY_MS ? p.count + 1 : 1;
      const until = now + lockFor(count);
      h.run('INSERT INTO login_fail_pairs (name_hash,ip_hash,count,last_at,locked_until) VALUES (?,?,?,?,?) ON CONFLICT(name_hash,ip_hash) DO UPDATE SET count=excluded.count, last_at=excluded.last_at, locked_until=excluded.locked_until', nameHash, ipHash(ip), count, now, until);
      const g = h.get('SELECT * FROM login_failures WHERE name_hash = ?', nameHash);
      const gCount = g && now - g.last_at < FAILURE_MEMORY_MS ? g.count + 1 : 1;
      const ips = h.get('SELECT COUNT(*) AS n FROM login_fail_pairs WHERE name_hash = ? AND last_at > ?', nameHash, now - FAILURE_MEMORY_MS).n;
      const gUntil = Math.max(g && now - g.last_at < FAILURE_MEMORY_MS ? g.locked_until : 0, now + globalLockFor(gCount, ips));
      h.run('INSERT INTO login_failures (name_hash,count,last_at,locked_until) VALUES (?,?,?,?) ON CONFLICT(name_hash) DO UPDATE SET count=excluded.count, last_at=excluded.last_at, locked_until=excluded.locked_until', nameHash, gCount, now, gUntil);
      if (Math.random() < 0.01) h.run('DELETE FROM login_fail_pairs WHERE last_at < ?', now - FAILURE_MEMORY_MS);
      return { count, lockedMs: until - now, everywhere: { count: gCount, ips, lockedMs: gUntil - now } };
    },
    /** A successful sign-in from this address clears that address's count (the name-wide count runs out on its own). */
    clear(nameHash, ip) { h.run('DELETE FROM login_fail_pairs WHERE name_hash = ? AND ip_hash = ?', nameHash, ipHash(ip)); },
    /** Everything for a name (the owner's unlock, a password reset). */
    clearAll(nameHash) {
      h.run('DELETE FROM login_fail_pairs WHERE name_hash = ?', nameHash);
      h.run('DELETE FROM login_failures WHERE name_hash = ?', nameHash);
    },
  };
}

/**
 * Token buckets: `rate` tokens a second, up to `burst`. take() spends `cost` tokens and returns 0, or the ms until
 * there would be enough. Used for the cheap checks that run before anything else (requests per address and in all),
 * and for bytes (egress, uploads).
 */
export class Buckets {
  constructor(max = 100_000) { this.b = new Map(); this.max = max; }
  take(key, rate, burst, nowMs, cost = 1) {
    let x = this.b.get(key);
    if (!x) { x = { t: burst, at: nowMs }; this.b.set(key, x); if (this.b.size > this.max) this.sweep(nowMs); }
    x.t = Math.min(burst, x.t + ((nowMs - x.at) / 1000) * rate);
    x.at = nowMs;
    if (x.t >= cost) { x.t -= cost; return 0; }
    return Math.ceil(((cost - x.t) / rate) * 1000);
  }
  /** Spends anyway (may go negative): for bytes already sent, so later sends wait longer. */
  spend(key, rate, burst, nowMs, cost) {
    const wait = this.take(key, rate, burst, nowMs, 0);
    const x = this.b.get(key);
    x.t -= cost;
    return wait + (x.t < 0 ? Math.ceil((-x.t / rate) * 1000) : 0);
  }
  sweep(nowMs) { for (const [k, x] of this.b) if (nowMs - x.at > 600_000) this.b.delete(k); }
}
