// Leaderboard scoring that rewards studying, not farming.
// Each (person, question) has a review state: a box (how well it's learned) and when it is next due.
// - A question earns points only when it is due (new, or its review date has come).
// - First try right while due: full points, the box goes up, and the question comes back later (spaced review).
// - Wrong: no points and no penalty; keep trying. Getting it right after a miss earns a little ("brute force" practice
//   still counts), the box drops to 0 and it comes back tomorrow.
// - Answering a question that isn't due yet is free practice: shows the answer, earns nothing.
// - A daily cap per person stops all-night farming.
export const INTERVAL_DAYS = [1, 3, 7, 14, 30, 60, 120];
export const POINTS = { newFirstTry: 10, reviewFirstTry: 6, reviewBoxBonus: 1, afterMiss: 2 };
export const DAILY_CAP = 600;
const DAY = 86400_000;

/**
 * state: { box, dueAt, missedThisWindow, seen } or null (never answered).
 * Returns { points, state, due } where `due` says whether the question was scoring.
 */
export function scoreAnswer(state, correct, nowMs) {
  const s = state ?? { box: 0, dueAt: 0, missedThisWindow: false, seen: false };
  const due = s.dueAt <= nowMs;
  if (!due) return { points: 0, state: s, due: false };
  if (!correct) return { points: 0, state: { ...s, missedThisWindow: true }, due: true };
  if (s.missedThisWindow) {
    return { points: POINTS.afterMiss, state: { box: 0, dueAt: nowMs + INTERVAL_DAYS[0] * DAY, missedThisWindow: false, seen: true }, due: true };
  }
  const points = !s.seen ? POINTS.newFirstTry : POINTS.reviewFirstTry + POINTS.reviewBoxBonus * s.box;
  // Box n waits INTERVAL_DAYS[n-1]: new → 1 day, then 3, 7, 14 ...
  const box = Math.min(s.box + 1, INTERVAL_DAYS.length);
  return { points, state: { box, dueAt: nowMs + INTERVAL_DAYS[box - 1] * DAY, missedThisWindow: false, seen: true }, due: true };
}

/** Points left today under the cap. */
export const capped = (points, earnedToday) => Math.max(0, Math.min(points, DAILY_CAP - earnedToday));

// Levels: level n needs 100 * n(n-1)/2 XP in total (0, 100, 300, 600, 1000, ...).
export const xpForLevel = (n) => (100 * n * (n - 1)) / 2;
export function levelOf(xp) {
  const n = Math.floor((1 + Math.sqrt(1 + (8 * Math.max(0, xp)) / 100)) / 2);
  return { level: n, xp, floor: xpForLevel(n), next: xpForLevel(n + 1) };
}

/** Monday 00:00 UTC of the week containing nowMs (weekly boards reset then). */
export function weekStart(nowMs) {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Current streak in days from a set of YYYY-MM-DD study days, counting today or (if not yet today) yesterday. */
export function streak(days, nowMs) {
  const set = new Set(days);
  let d = set.has(dayKey(nowMs)) ? nowMs : nowMs - DAY;
  let n = 0;
  while (set.has(dayKey(d))) { n++; d -= DAY; }
  return n;
}
