// Account details that aren't sign-in: the optional phone number and who may see it, supporter months, and how
// storage sizes are written in notices. Pure helpers (tested in test/hub/lib.test.mjs).

export const PHONE_VISIBILITY = ['nobody', 'classes', 'orgs', 'both'];

const err = (m) => { throw Object.assign(new Error(m), { status: 400 }); };

/**
 * A phone number, loosely checked (E.164-ish): an optional leading +, then 7 to 15 digits. Spaces, dashes, dots,
 * slashes and brackets are allowed while typing and dropped. No country is assumed: what was typed is kept, as digits.
 */
export function normalizePhone(v) {
  if (typeof v !== 'string') err('Phone number must be text.');
  const s = v.trim();
  if (!s || s.length > 40) err('Enter a phone number, like +1 719 555 0100.');
  if (!/^\+?[\d\s().\-/]+$/.test(s)) err('A phone number can only have digits, spaces, dashes, dots and brackets, with an optional + at the start.');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) err('A phone number has 7 to 15 digits, like +1 719 555 0100.');
  if (s.startsWith('+') && digits[0] === '0') err('After the +, a phone number starts with its country code (not 0).');
  return (s.startsWith('+') ? '+' : '') + digits;
}

/** Whether a phone number with this visibility shows in a list of this kind ('classes' or 'orgs'). */
export const phoneShownIn = (visibility, where) => visibility === 'both' || visibility === where;

/** 5368709120 -> "5 GB"; 5000 GB -> "5,000 GB"; smaller sizes in MB, KB or bytes. */
export function fmtBytes(b) {
  const n = Math.max(0, Number(b) || 0);
  const at = (unit, size) => `${(Math.round((n / size) * 10) / 10).toLocaleString('en-US')} ${unit}`;
  if (n >= 1024 ** 3) return at('GB', 1024 ** 3);
  if (n >= 1024 ** 2) return at('MB', 1024 ** 2);
  if (n >= 1024) return at('KB', 1024);
  return `${n.toLocaleString('en-US')} bytes`;
}

/** "December 5, 2026" (UTC, so the same everywhere). */
export const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Adds calendar months in UTC (31 January + 1 month = 28 or 29 February). */
export function addMonthsUtc(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * The new end of someone's supporter time. Renewing extends from the current end if it hasn't passed yet, otherwise
 * from now. `until` (a time) sets the end directly.
 */
export function supporterUntil(currentUntil, nowMs, { months = null, until = null } = {}) {
  if (until != null) return until;
  const from = currentUntil != null && currentUntil > nowMs ? currentUntil : nowMs;
  return addMonthsUtc(from, months ?? 1);
}
