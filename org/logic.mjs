// Org logic with no database: availability periods and blocks, prefill, hours, coverage, auto-fill, CSV, countdowns.
// Times of day are "HH:MM" wall-clock in the org's time zone; dates are "YYYY-MM-DD".
import { addDays, dayNum, weekday, weekStartOf, zonedToUtc } from '../server/lib/time.mjs';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const STATES = ['A', 'I', 'N']; // Available, If needed, Not available
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const isTime = (s) => typeof s === 'string' && TIME_RE.test(s);
export const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Minutes a block lasts; an end at or before the start runs past midnight. */
export const blockMinutes = (b) => { const s = toMin(b.start), e = toMin(b.end); return e > s ? e - s : e + 1440 - s; };

/** "04:45" -> "4:45am", "13:00" -> "1pm" */
export function fmtTime(t) {
  const m = toMin(t), h = Math.floor(m / 60), mm = m % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
export const fmtRange = (b) => `${fmtTime(b.start)}-${fmtTime(b.end)}`;
/** "2026-12-01" -> "12/1" */
export const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** The month after the one `today` is in: { start, end }. */
export function nextMonth(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const start = `${ny}-${String(nm).padStart(2, '0')}-01`;
  const end = addDays(nm === 12 ? `${ny + 1}-01-01` : `${ny}-${String(nm + 1).padStart(2, '0')}-01`, -1);
  return { start, end };
}
export const datesIn = (start, end) => { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; };

/**
 * Every (date, block) of a form's period. Blocks repeat by weekday; exceptions close a date, replace its hours, or add
 * extra blocks (events, meets). Each slot: { key: "date|blockId", date, weekday, blockId, label, start, end, startAt,
 * endAt, minutes, need: [{positionId, count}], tags, special, note }.
 */
export function expandSlots(form, tz) {
  const ex = new Map();
  for (const e of form.exceptions || []) { if (!ex.has(e.date)) ex.set(e.date, []); ex.get(e.date).push(e); }
  const out = [];
  for (const date of datesIn(form.periodStart, form.periodEnd)) {
    const wd = weekday(date);
    const list = ex.get(date) || [];
    if (list.some((e) => e.kind === 'closed')) continue;
    const replace = list.find((e) => e.kind === 'hours');
    let blocks = replace ? (replace.blocks || []).map((b) => ({ ...b, special: 'hours' })) : (form.blocks || []).filter((b) => b.weekday === wd);
    for (const e of list.filter((x) => x.kind === 'extra')) blocks = blocks.concat((e.blocks || []).map((b) => ({ ...b, special: 'extra' })));
    const note = list.map((e) => e.note).filter(Boolean).join(' ') || null;
    for (const b of blocks) {
      const startAt = zonedToUtc(date, b.start, tz);
      const endDate = toMin(b.end) > toMin(b.start) ? date : addDays(date, 1);
      out.push({
        key: `${date}|${b.id}`, date, weekday: wd, blockId: b.id, label: b.label || null, start: b.start, end: b.end,
        startAt, endAt: zonedToUtc(endDate, b.end, tz), minutes: blockMinutes(b),
        need: b.need || [], tags: b.tags || [], special: b.special || null, note,
      });
    }
  }
  return out.sort((a, b) => a.startAt - b.startAt || (a.blockId < b.blockId ? -1 : 1));
}

/** The weekday + time key that carries an answer from one period to the next ("1|04:45-09:00"). */
export const usualKey = (s) => `${s.weekday}|${s.start}-${s.end}`;

/** Answers from a standing "usual week" ({ "1|04:45-09:00": "A" }). */
export function prefillUsual(slots, usual = {}) {
  const out = {};
  for (const s of slots) { const v = usual[usualKey(s)]; if (v === 'A' || v === 'I') out[s.key] = v; }
  return out;
}

/** Answers carried from an earlier form: for each weekday + block time, what was marked most often (ties: A, I, N). */
export function prefillFrom(prevSlots, prevAnswers = {}, slots) {
  const tally = new Map();
  for (const s of prevSlots) {
    const k = usualKey(s);
    const t = tally.get(k) || { A: 0, I: 0, N: 0 };
    t[prevAnswers[s.key] === 'A' ? 'A' : prevAnswers[s.key] === 'I' ? 'I' : 'N']++;
    tally.set(k, t);
  }
  const out = {};
  for (const s of slots) {
    const t = tally.get(usualKey(s));
    if (!t) continue;
    const best = STATES.reduce((a, b) => (t[b] > t[a] ? b : a), 'A');
    if (best !== 'N') out[s.key] = best;
  }
  return out;
}

/** The usual week implied by a set of answers (what most weeks said), for "save as my usual week". */
export function usualFromAnswers(slots, answers) {
  const p = prefillFrom(slots, answers, slots);
  const out = {};
  for (const s of slots) if (p[s.key]) out[usualKey(s)] = p[s.key];
  return out;
}

/** Keep only answers for real slots, with a valid state. */
export function cleanAnswers(slots, answers) {
  const keys = new Set(slots.map((s) => s.key));
  const out = {};
  for (const [k, v] of Object.entries(answers || {})) if (keys.has(k) && (v === 'A' || v === 'I')) out[k] = v;
  return out;
}

/** Hours marked: { available, ifNeeded, perWeekAvailable, perWeekIfNeeded } over the period. */
export function hoursMarked(slots, answers, periodDays) {
  let a = 0, i = 0;
  for (const s of slots) { if (answers[s.key] === 'A') a += s.minutes; else if (answers[s.key] === 'I') i += s.minutes; }
  const weeks = Math.max(1, periodDays) / 7;
  const r = (m) => Math.round((m / 60) * 10) / 10;
  return { available: r(a), ifNeeded: r(i), perWeekAvailable: r(a / weeks), perWeekIfNeeded: r(i / weeks) };
}

/** Total people needed in a slot (all positions), after per-date overrides. */
export const needOf = (slot, overrides = {}) => overrides[slot.key] ?? slot.need ?? [];
export const needTotal = (need) => need.reduce((s, n) => s + (n.count || 0), 0);

// ---------- auto-fill ----------
/**
 * Fill open places from availability, deterministically (the same input gives the same schedule).
 *   slots:   expanded slots with need [{positionId, count}]
 *   people:  [{ id, name, positions: [ids], desiredMin, desiredMax, prefs: [tags] }]
 *   answers: Map(accountId -> { slotKey: 'A'|'I' })
 *   shifts:  shifts already in the schedule [{ accountId, positionId, slotKey, startAt, endAt }]
 *   check(person, shift, personShifts) -> problems (checkAssignment's shape: { code, blocking })
 *   options: { useIfNeeded = true, hardMaxHours = false, allowOvertime = false, workweekStart = 0, onlySlots }
 * Hard limits: anything blocking (certs, minors, overlap), weekly overtime unless allowed, and desired max when hard.
 * Preference order: staying within their desired max (someone who capped their hours isn't pushed past it while
 * another person could go); Available before If needed; a matching preference tag; furthest below their
 * desired hours this week; fewest hours in the period; then name and id.
 */
export function autofill({ slots, people, answers, shifts, check, options = {} }) {
  const { useIfNeeded = true, hardMaxHours = false, allowOvertime = false, workweekStart = 0, onlySlots = null } = options;
  const mine = new Map(people.map((p) => [p.id, shifts.filter((s) => s.accountId === p.id).map((s) => ({ ...s }))]));
  const weekOf = (s) => weekStartOf(s.date, workweekStart);
  const minutesInWeek = (pid, wk) => (mine.get(pid) || []).filter((s) => weekStartOf(s.date, workweekStart) === wk).reduce((t, s) => t + (s.endAt - s.startAt) / 60000, 0);
  const minutesTotal = (pid) => (mine.get(pid) || []).reduce((t, s) => t + (s.endAt - s.startAt) / 60000, 0);
  const stateOf = (pid, key) => answers.get(pid)?.[key] || 'N';

  // Every open place, hardest first (fewest people who could take it), then in time order.
  const open = [];
  for (const slot of slots) {
    if (onlySlots && !onlySlots.has(slot.key)) continue;
    for (const n of slot.need || []) {
      const have = shifts.filter((s) => s.slotKey === slot.key && s.positionId === n.positionId).length;
      const missing = (n.count || 0) - have;
      if (missing <= 0) continue;
      const pool = people.filter((p) => p.positions.includes(n.positionId) && ['A', ...(useIfNeeded ? ['I'] : [])].includes(stateOf(p.id, slot.key))).length;
      open.push({ slot, positionId: n.positionId, missing, pool });
    }
  }
  open.sort((a, b) => a.pool / a.missing - b.pool / b.missing || a.slot.startAt - b.slot.startAt || (a.positionId < b.positionId ? -1 : 1));

  const add = [], unfilled = [];
  for (const o of open) {
    const { slot, positionId } = o;
    let left = o.missing;
    const reasons = new Map();
    while (left > 0) {
      const wk = weekOf(slot);
      const cands = [];
      for (const p of people) {
        if (!p.positions.includes(positionId)) continue;
        const st = stateOf(p.id, slot.key);
        if (st === 'N' || (st === 'I' && !useIfNeeded)) continue;
        if ((mine.get(p.id) || []).some((s) => s.slotKey === slot.key)) continue;
        const shift = { positionId, start: new Date(slot.startAt).toISOString(), end: new Date(slot.endAt).toISOString() };
        const theirs = (mine.get(p.id) || []).map((s, i) => ({ id: `x${i}`, start: new Date(s.startAt).toISOString(), end: new Date(s.endAt).toISOString() }));
        const problems = check(p, shift, theirs);
        const block = problems.find((x) => x.blocking || (!allowOvertime && x.code === 'overtime_weekly'));
        if (block) { reasons.set(block.code, (reasons.get(block.code) || 0) + 1); continue; }
        const weekH = (minutesInWeek(p.id, wk) + slot.minutes) / 60;
        const max = p.desiredMax ?? null, target = p.desiredMax ?? p.desiredMin ?? null;
        if (max != null && weekH > max && hardMaxHours) { reasons.set('desired_max', (reasons.get('desired_max') || 0) + 1); continue; }
        cands.push({
          p,
          k: [
            max != null && weekH > max ? 1 : 0,
            st === 'A' ? 0 : 1,
            (p.prefs || []).length && (slot.tags || []).length ? ((slot.tags || []).some((t) => p.prefs.includes(t)) ? 0 : 1) : 1,
            target ? minutesInWeek(p.id, wk) / 60 / target : minutesInWeek(p.id, wk) / 60 / 40,
            minutesTotal(p.id),
            `${p.name}\u0000${p.id}`,
          ],
        });
      }
      if (!cands.length) break;
      cands.sort((a, b) => { for (let i = 0; i < a.k.length; i++) { if (a.k[i] < b.k[i]) return -1; if (a.k[i] > b.k[i]) return 1; } return 0; });
      const pick = cands[0].p;
      const s = { accountId: pick.id, positionId, slotKey: slot.key, date: slot.date, startAt: slot.startAt, endAt: slot.endAt };
      mine.get(pick.id).push(s);
      add.push({ ...s, blockId: slot.blockId, state: stateOf(pick.id, slot.key) });
      left--;
    }
    if (left > 0) unfilled.push({ slotKey: slot.key, date: slot.date, blockId: slot.blockId, positionId, missing: left, reasons: Object.fromEntries(reasons) });
  }
  return { add, unfilled };
}

// ---------- CSV ----------
// A cell a spreadsheet could take for a formula (starting with = + - @, a tab or a carriage return, or their full-width
// forms ＝ ＋ － ＠, which some spreadsheet apps read as the plain ones) gets a ' in front, and is quoted.
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;
export const cell = (v) => { const s = v == null ? '' : String(v); const f = FORMULA_START.test(s); return f || /[",\r\n]/.test(s) ? `"${(f ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

/** "12/1/2026 14:05:33" in the org's time zone, the way Google Sheets writes a form's Timestamp. */
export function sheetsTimestamp(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year} ${Number(p.hour)}:${p.minute}:${p.second}`;
}

/**
 * The Google-Sheets shape of a form's responses: one row per person, one column per weekday block ("Monday
 * 4:45am-9am") listing the dates they marked ("12/1, 12/8, 12/15 (if needed)"), then extra blocks, hours, days off,
 * the org's own questions and notes.
 */
export function sheetsExport({ form, slots, rows, tz, questions = {} }) {
  const cols = [];
  const seen = new Set();
  for (const b of [...(form.blocks || [])].sort((a, c) => ((a.weekday + 6) % 7) - ((c.weekday + 6) % 7) || toMin(a.start) - toMin(c.start))) {
    const name = `${DAY_NAMES[b.weekday]} ${b.label ? `${b.label} ` : ''}${fmtRange(b)}`;
    cols.push({ name, match: (s) => !s.special && s.blockId === b.id });
    seen.add(b.id);
  }
  for (const s of slots) {
    if (!s.special || seen.has(`${s.date}|${s.blockId}`)) continue;
    seen.add(`${s.date}|${s.blockId}`);
    cols.push({ name: `${shortDate(s.date)} ${s.label ? `${s.label} ` : ''}${fmtRange(s)}`, match: (x) => x.key === s.key });
  }
  const custom = (questions.custom || []).filter((q) => q.on !== false);
  const header = ['Timestamp', 'Email Address', 'Name', ...cols.map((c) => c.name)];
  if (questions.desiredHours?.on !== false) header.push('Desired hours per week');
  if (questions.daysOff?.on !== false) header.push('Days off needed');
  for (const q of custom) header.push(q.label);
  header.push('Notes by date');
  if (questions.notes?.on !== false) header.push('Notes');
  // (Whether the person proved their email with Google or the Hub's owner did: an unverified one may not be theirs.)
  header.push('Email verified');
  const out = [header];
  for (const r of rows) {
    const line = [r.submittedAt ? sheetsTimestamp(r.submittedAt, tz) : '', r.email, r.name];
    for (const c of cols) {
      const marks = slots.filter(c.match).filter((s) => r.answers[s.key]).map((s) => `${shortDate(s.date)}${r.answers[s.key] === 'I' ? ' (if needed)' : ''}`);
      line.push(marks.join(', '));
    }
    if (questions.desiredHours?.on !== false) line.push(r.desiredMin != null || r.desiredMax != null ? (r.desiredMin === r.desiredMax || r.desiredMax == null ? `${r.desiredMin ?? r.desiredMax}` : r.desiredMin == null ? `up to ${r.desiredMax}` : `${r.desiredMin}-${r.desiredMax}`) : '');
    if (questions.daysOff?.on !== false) line.push(r.daysOff || '');
    for (const q of custom) { const v = r.extra?.[q.id]; line.push(Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v === false ? 'No' : v ?? ''); }
    line.push(Object.entries(r.dateNotes || {}).sort().map(([d, n]) => `${shortDate(d)}: ${n}`).join('; '));
    if (questions.notes?.on !== false) line.push(r.note || '');
    line.push(r.emailVerified ? 'Yes' : 'No');
    out.push(line);
  }
  return toCsv(out);
}

/** One row per person, date and block (for spreadsheets and other tools). */
export function longExport({ slots, rows }) {
  const out = [['Name', 'Email', 'Date', 'Weekday', 'Block', 'Start', 'End', 'Answer', 'Note for the date', 'Email verified']];
  for (const r of rows) for (const s of slots) {
    const a = r.answers[s.key];
    out.push([r.name, r.email, s.date, DAY_NAMES[s.weekday], s.label || fmtRange(s), s.start, s.end, a === 'A' ? 'Available' : a === 'I' ? 'If needed' : 'Not available', r.dateNotes?.[s.date] || '', r.emailVerified ? 'Yes' : 'No']);
  }
  return toCsv(out);
}

// ---------- countdowns ----------
/** Days from `today` to `date` (negative when past). */
export const daysUntil = (date, today) => dayNum(date) - dayNum(today);
/** The colour stage for a cert expiring on `expires`: expired, 7, 30, 60 or ok (with the org's own stages). */
export function certStage(expires, today, warn = [60, 30, 7]) {
  if (!expires) return { stage: 'ok', daysLeft: null };
  const d = daysUntil(expires, today);
  if (d < 0) return { stage: 'expired', daysLeft: d };
  const stages = [...warn].sort((a, b) => a - b);
  for (const s of stages) if (d <= s) return { stage: String(s), daysLeft: d };
  return { stage: 'ok', daysLeft: d };
}
/** Add whole months to a date (Jan 31 + 1 month = Feb 28). */
export function addMonths(date, n) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1 + n, d = Number(date.slice(8, 10));
  const ny = y + Math.floor(m / 12), nm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** To-do order: overdue first, then soonest due, then undated; urgency breaks ties. */
export function sortTodo(items) {
  return items.sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || (b.urgency || 0) - (a.urgency || 0) || (a.key < b.key ? -1 : 1));
}
