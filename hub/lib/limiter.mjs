// Brute-force protection.
// - Per IP: a sliding window per action (in memory; the tunnel's own limits sit in front of this).
// - Per sign-in name: failures are counted in the database for ANY email, whether or not an account exists, so a
//   lockout never reveals which emails have accounts. After FREE failures, each further one doubles the wait,
//   up to MAX_LOCK. A correct password during a lock is still refused, so guessing gains nothing.
export const FREE = 5;
export const MAX_LOCK_MS = 15 * 60_000;
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

/** Sign-in failure tracking on table login_failures(name_hash PK, count, last_at, locked_until). */
export function failures(h, nowFn) {
  return {
    /** ms still locked, or 0. */
    locked(nameHash) {
      const r = h.get('SELECT * FROM login_failures WHERE name_hash = ?', nameHash);
      if (!r) return 0;
      return Math.max(0, r.locked_until - nowFn());
    },
    fail(nameHash) {
      const now = nowFn();
      const r = h.get('SELECT * FROM login_failures WHERE name_hash = ?', nameHash);
      const count = r && now - r.last_at < FAILURE_MEMORY_MS ? r.count + 1 : 1;
      const until = now + lockFor(count);
      h.run('INSERT INTO login_failures (name_hash,count,last_at,locked_until) VALUES (?,?,?,?) ON CONFLICT(name_hash) DO UPDATE SET count=excluded.count, last_at=excluded.last_at, locked_until=excluded.locked_until', nameHash, count, now, until);
      return { count, lockedMs: until - now };
    },
    clear(nameHash) { h.run('DELETE FROM login_failures WHERE name_hash = ?', nameHash); },
  };
}
