// The Claude budget: what the owner's Claude plan does for other people, and the limits that keep it usable.
// (The rules in words are in docs/claude-usage-guidelines.md. Every number here is an owner setting.)
//
// Kinds of Claude work someone can ask for:
//   initial_scan   the first full scan of one of their classes. Once per class per person. If anyone in the same
//                  course section was already scanned, they share it and no Claude runs at all.
//   update_scan    pick up what's new (announcements, assignments). One per course section per cooldown, shared by
//                  everyone in it.
//   more_questions exactly one batch of 25 new practice questions for one chapter. Capped per chapter and per day.
//                  The new questions join the course's shared pool.
//   regenerate     never. Nothing is rewritten from scratch on the owner's plan.

export const DEFAULTS = {
  perAccountDaily: 3, // Claude jobs a person can start per day (owner: unlimited)
  perAccountWeekly: 10,
  maxQueuedPerAccount: 3,
  updateCooldownHours: 20,
  questionBatchSize: 25,
  questionBatchesPerChapter: 4, // per person per chapter: 100 extra questions
  questionBatchesPerDay: 2,
  globalDaily: 40, // jobs per day for everyone but the owner, together
  requireVerifiedEmail: true,
  refusalsBeforeFlag: 15, // refused requests in a day before the account is flagged for review
  requestsBeforeSuspend: 200, // requests in a day before it's suspended automatically (a script, not a person)
  defaultJobMinutes: 12, // for wait estimates until there's history
  // The owner's home internet: big downloads from the Hub, all together, never go faster than this (megabits per
  // second), so they can't fill the upload. Small files (sync data) skip the limit and go first.
  maxSendMbps: 10,
};
export const KINDS = ['initial_scan', 'update_scan', 'more_questions'];

/** "UCCS|BIO 1010|Spring 2027|002" style key: the same course section, however it was typed. */
export function courseKey({ school, code, term, section } = {}) {
  const n = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const c = n(code).replace(/[\s-]+/g, '');
  if (!n(school) || !c || !n(term)) return null;
  return `${n(school)}|${c}|${n(term)}|${n(section)}`;
}

/**
 * Decides one request. `facts` are counts from the database; returns
 *   { action: 'queue' } | { action: 'share', reason } | { action: 'join', jobId, reason } | { action: 'refuse', reason, code }
 */
export function decide(kind, limits, facts) {
  const L = { ...DEFAULTS, ...limits };
  const no = (code, reason) => ({ action: 'refuse', code, reason });
  if (kind === 'regenerate') return no('no_regenerate', 'Kea doesn’t regenerate classes on the shared Claude. Ask for 25 more questions on a chapter instead, or connect your own Claude to rewrite anything.');
  if (!KINDS.includes(kind)) return no('bad_kind', 'Unknown request.');
  if (facts.owner) return facts.joinJobId ? { action: 'join', jobId: facts.joinJobId, reason: 'Already waiting in the queue.' } : { action: 'queue' };
  if (L.requireVerifiedEmail && !facts.verified) return no('verify', 'Verify your email (Verify with Google) to use Kea’s shared Claude.');

  if (kind === 'initial_scan') {
    if (facts.alreadyScannedByMe) return no('already_scanned', 'This class was already scanned for you. Updates come automatically; for practice, ask for 25 more questions on a chapter.');
    if (facts.courseHasMaterials) return { action: 'share', reason: 'Someone in your course section already has this class scanned, so you get it right away.' };
    if (facts.joinJobId) return { action: 'join', jobId: facts.joinJobId, reason: 'A classmate’s scan of this course is already in the queue. You’ll get it too.' };
  }
  if (kind === 'update_scan') {
    if (facts.joinJobId) return { action: 'join', jobId: facts.joinJobId, reason: 'An update for this course is already in the queue.' };
    if (facts.hoursSinceCourseUpdate != null && facts.hoursSinceCourseUpdate < L.updateCooldownHours)
      return no('cooldown', `This course was updated ${Math.floor(facts.hoursSinceCourseUpdate)} hours ago. Updates run at most once every ${L.updateCooldownHours} hours.`);
  }
  if (kind === 'more_questions') {
    if (!facts.chapter) return no('chapter', 'Pick the chapter you want more questions on.');
    if (facts.joinJobId) return { action: 'join', jobId: facts.joinJobId, reason: 'More questions for this chapter are already being made. You’ll get them too.' };
    if (facts.myBatchesThisChapter >= L.questionBatchesPerChapter) return no('chapter_cap', `You’ve had ${L.questionBatchesPerChapter} extra batches of ${L.questionBatchSize} for this chapter, the most Kea’s shared Claude makes. Use your own Claude for more.`);
    if (facts.myBatchesToday >= L.questionBatchesPerDay) return no('batch_day', `That’s ${L.questionBatchesPerDay} batches of new questions today. Come back tomorrow.`);
  }
  if (facts.myQueued >= L.maxQueuedPerAccount) return no('queue_full', `You already have ${L.maxQueuedPerAccount} requests waiting. They run one at a time.`);
  if (facts.myJobsToday >= L.perAccountDaily) return no('day_cap', `That’s your ${L.perAccountDaily} for today on Kea’s shared Claude. Come back tomorrow, or connect your own Claude.`);
  if (facts.myJobsThisWeek >= L.perAccountWeekly) return no('week_cap', `That’s your ${L.perAccountWeekly} for this week on Kea’s shared Claude.`);
  return { action: 'queue' };
}

/**
 * Which queued job runs next. Owner's first; then whoever has had the fewest jobs today (so one person can't hog
 * it), then oldest. When paused or over the daily total, only the owner's jobs run.
 */
export function pickNext(queued, { doneTodayByAccount, ownerIds, globalUsedToday, limits, paused }) {
  const L = { ...DEFAULTS, ...limits };
  const owners = queued.filter((j) => ownerIds.has(j.account_id)).sort((a, b) => a.created_at - b.created_at);
  if (owners.length) return owners[0];
  if (paused || globalUsedToday >= L.globalDaily) return null;
  return [...queued].sort((a, b) => (doneTodayByAccount.get(a.account_id) || 0) - (doneTodayByAccount.get(b.account_id) || 0) || a.created_at - b.created_at)[0] ?? null;
}
