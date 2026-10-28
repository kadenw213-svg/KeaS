// Small timezone helpers (no deps). All stored times are UTC ISO strings;
// "local" means the org's IANA time zone (demo: America/Denver).
const DAY = 86400000;
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}
const offCache = new Map();
/** Offset of tz from UTC in minutes at instant ms (cached per UTC hour; DST changes on hour boundaries). */
export function tzOffsetMin(ms, tz) {
  const hour = Math.floor(ms / 3600000) * 3600000;
  const key = tz + '|' + hour;
  let o = offCache.get(key);
  if (o !== undefined) return o;
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(hour))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  o = Math.round((asUtc - hour) / 60000);
  if (offCache.size > 100000) offCache.clear();
  offCache.set(key, o);
  return o;
}
export const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
export const iso = (ms) => new Date(ms).toISOString();
export function localMs(ms, tz) { return ms + tzOffsetMin(ms, tz) * 60000; }
export function localDate(ms, tz) { return new Date(localMs(toMs(ms), tz)).toISOString().slice(0, 10); }
export function localTime(ms, tz) { return new Date(localMs(toMs(ms), tz)).toISOString().slice(11, 16); }
export function localMinuteOfDay(ms, tz) { const l = localMs(toMs(ms), tz); return Math.floor((((l % DAY) + DAY) % DAY) / 60000); }
/** UTC ms for a wall-clock date + "HH:MM" in tz. */
export function zonedToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = tzOffsetMin(guess, tz);
  let t = guess - o1 * 60000;
  const o2 = tzOffsetMin(t, tz);
  if (o2 !== o1) t = guess - o2 * 60000;
  return t;
}
export function dayNum(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); }
export function fromDayNum(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
export function addDays(dateStr, n) { return fromDayNum(dayNum(dateStr) + n); }
/** 0 = Sunday … 6 = Saturday */
export function weekday(dateStr) { return (((dayNum(dateStr) + 4) % 7) + 7) % 7; }
export function weekStartOf(dateStr, workweekStart = 0) { return addDays(dateStr, -((weekday(dateStr) - workweekStart + 7) % 7)); }
export function laborDay(year) { let d = `${year}-09-01`; while (weekday(d) !== 1) d = addDays(d, 1); return d; }
export function isSummer(dateStr) { const y = dateStr.slice(0, 4); return dateStr >= `${y}-06-01` && dateStr <= laborDay(+y); }
export function ageOn(birthdate, dateStr) {
  const [by, bm, bd] = birthdate.split('-').map(Number);
  const [y, m, d] = dateStr.split('-').map(Number);
  let a = y - by;
  if (m < bm || (m === bm && d < bd)) a--;
  return a;
}
export function hhmmToMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
