// Limits on slow and heavy traffic, and writing long JSON answers a piece at a time. Every number can be changed with
// createHub({ flow: { ... } }).
export const FLOW_DEFAULTS = {
  // A connection that sends nothing at all is closed after this long.
  noBytesMs: 10_000,
  // Requests in flight per client address (times the shared-address factor when many people may be behind one address).
  clientInflight: 32,
  // A body that stops arriving is dropped after this long.
  bodyIdleMs: 15_000,
  // Slower than this, measured over the window, is dropped: downloads (time spent waiting for the client) and uploads.
  minRateBytes: 32 * 1024,
  minRateWindowMs: 20_000,
  // A PUT smaller than this doesn't take an upload slot.
  uploadSlotMinBytes: 64 * 1024,
  // Signed-in JSON bodies over 16 KB being read at once: per account, per address, in all (each can hold 2 MB in memory).
  bodiesPerAccount: 8,
  bodiesPerClient: 8,
  bodiesGlobal: 64,
  // Long lists and exports running at once: per account and in all.
  heavyPerAccount: 3,
  heavyGlobal: 16,
  // A list longer than this is streamed, this many rows at a time.
  listBatch: 1000,
  // Small answers an account can get at once before they start to wait for its share of the egress limit.
  smallEgressBurstBytes: 4 * 1024 * 1024,
  // The Hub answers "busy" while its event loop is this far behind. (Under `node --test`, where many Hubs and password
  // hashes share one PC, stalls are normal and say nothing: tests that need shedding set this themselves.)
  shedLagMs: process.env.NODE_TEST_CONTEXT ? 60_000 : 500,
};

/**
 * A JSON object as a series of Buffers of about `chunk` bytes. `entries`: [key, value] pairs. A value is plain JSON, a
 * function returning it (called when its turn comes), or a generator of array items (written as an array, one at a time).
 * An undefined value leaves the key out, as JSON.stringify does.
 */
export function* jsonParts(entries, chunk = 64 * 1024) {
  let text = '{', first = true;
  const full = () => text.length >= chunk;
  const out = function* () { yield Buffer.from(text); text = ''; };
  for (const [k, v0] of entries) {
    const v = typeof v0 === 'function' ? v0() : v0;
    if (v && typeof v === 'object' && typeof v.next === 'function') {
      text += `${first ? '' : ','}${JSON.stringify(k)}:[`;
      first = false;
      let one = true;
      for (const item of v) {
        text += (one ? '' : ',') + JSON.stringify(item);
        one = false;
        if (full()) yield* out();
      }
      text += ']';
    } else {
      const j = JSON.stringify(v);
      if (j === undefined) continue;
      text += `${first ? '' : ','}${JSON.stringify(k)}:`;
      first = false;
      // (One long section: cut into pieces, never between the two halves of a character.)
      for (let i = 0; i < j.length;) {
        let end = Math.min(j.length, i + chunk);
        const c = j.charCodeAt(end - 1);
        if (end < j.length && c >= 0xd800 && c <= 0xdbff) end++;
        text += j.slice(i, end);
        i = end;
        if (full()) yield* out();
      }
    }
    if (full()) yield* out();
  }
  text += '}';
  yield* out();
}
