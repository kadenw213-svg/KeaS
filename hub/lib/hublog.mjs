// The Hub's request log: its own file, limited in size, and quiet under a flood.
//   - Written by the Hub itself into <data folder>/logs/hub.log, rotated at `maxBytes` (hub.log.1 ... hub.log.<keep>),
//     so it can never fill a drive (before, every request went to an ever-growing file).
//   - Routine lines are counted, not written one by one: successful GETs and repeated 401/404/429 answers become one
//     summary line a minute ("GET 200 x 5231"). Writes (POST/PUT/DELETE) and server errors are written as they happen.
//   - Writes are buffered and flushed about once a second, off the request path.
import { appendFile, appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const COUNTED = new Set([401, 403, 404, 405, 413, 421, 428, 429, 503]);

export function createHubLog({ file = null, toConsole = false, maxBytes = 10 * 1024 ** 2, keep = 5, flushMs = 1000, summaryMs = 60_000 } = {}) {
  let buf = [], size = 0, writing = false, closed = false;
  const counts = new Map();
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    try { size = statSync(file).size; } catch { size = 0; }
  }
  function rotate() {
    for (let i = keep - 1; i >= 1; i--) { try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
    try { renameSync(file, `${file}.1`); } catch {}
    rmSync(`${file}.${keep + 1}`, { force: true });
    size = 0;
  }
  function flush() {
    if (!file || writing || !buf.length) return;
    const text = buf.join('');
    buf = [];
    if (size + Buffer.byteLength(text) > maxBytes) rotate();
    writing = true;
    appendFile(file, text, () => { writing = false; });
    size += Buffer.byteLength(text);
  }
  function summarize() {
    if (!counts.size) return;
    const parts = [...counts].map(([k, n]) => `${k} x${n}`).join(', ');
    counts.clear();
    line(`${new Date().toISOString()} (last minute) ${parts}`);
  }
  function line(text) {
    if (closed) return;
    if (toConsole) console.log(text);
    if (file) buf.push(`${text}\n`);
  }
  const flushTimer = setInterval(flush, flushMs);
  const sumTimer = setInterval(summarize, summaryMs);
  flushTimer.unref?.();
  sumTimer.unref?.();
  return {
    /** One request: written, or counted toward the minute's summary. */
    request(method, path, status, ms) {
      if ((method === 'GET' && status < 400) || COUNTED.has(status)) {
        const k = `${method} ${status}`;
        counts.set(k, (counts.get(k) || 0) + 1);
        return;
      }
      line(`${new Date().toISOString()} ${method} ${path} ${status} ${ms}ms`);
    },
    line,
    /** Writes what's waiting now (tests, shutting down). */
    flushNow() { summarize(); flush(); },
    /** The last lines are on disk when this returns (the Hub may be about to exit). */
    close() {
      summarize();
      if (file && buf.length) { try { appendFileSync(file, buf.join('')); } catch {} buf = []; }
      closed = true; clearInterval(flushTimer); clearInterval(sumTimer);
    },
    stats: () => ({ file, bytes: size, pendingLines: buf.length, counted: Object.fromEntries(counts) }),
  };
}
