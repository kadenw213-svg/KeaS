// Password hashing off the Hub's main thread. Inside KeaS (Electron), scrypt runs on the main thread and one hash
// stops the whole Hub for half a second or more, so a few dozen sign-ins at once froze it for everyone. Here hashes
// run in a small pool of worker threads (2 by default): at most `size` at a time, at most `maxQueue` waiting, and
// anything past that is refused at once with Busy (the Hub answers 503 with Retry-After) instead of piling up.
import { Worker } from 'node:worker_threads';
import { argon2, scrypt } from 'node:crypto';

const WORKER = `
const { parentPort } = require('node:worker_threads');
const c = require('node:crypto');
parentPort.on('message', ({ id, alg, password, salt, p }) => {
  try {
    const pw = Buffer.from(password, 'utf8'), nonce = Buffer.from(salt);
    const out = alg === 'argon2id'
      ? c.argon2Sync('argon2id', { message: pw, nonce, parallelism: p.parallelism, tagLength: p.tagLength, memory: p.memory, passes: p.passes })
      : c.scryptSync(pw, nonce, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 1024 * 1024 });
    parentPort.postMessage({ id, out });
  } catch (e) { parentPort.postMessage({ id, error: String(e && e.message || e) }); }
});`;

export class Busy extends Error {
  constructor(message = 'The Kea Hub is busy right now. Try again in a few seconds.', retryAfter = 5) {
    super(message);
    this.busy = true;
    this.retryAfter = retryAfter;
  }
}

/** The same work on this thread's own async crypto (where workers can't start). */
const inline = ({ alg, password, salt, p }) => new Promise((resolve, reject) => {
  const cb = (err, out) => (err ? reject(err) : resolve(Buffer.from(out)));
  if (alg === 'argon2id') argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.parallelism, tagLength: p.tagLength, memory: p.memory, passes: p.passes }, cb);
  else scrypt(Buffer.from(password, 'utf8'), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 1024 * 1024 }, cb);
});

export function createHashPool({ size = 2, maxQueue = 32 } = {}) {
  const workers = new Set();
  const idle = [];
  const queue = [];
  const stats = { done: 0, refused: 0, failed: 0, peakQueue: 0 };
  let nextId = 1, broken = false;

  function spawn() {
    const w = new Worker(WORKER, { eval: true });
    w.job = null;
    w.on('message', ({ id, out, error }) => {
      const job = w.job;
      w.job = null;
      if (job && job.id === id) {
        stats.done++;
        if (error) job.reject(new Error(error)); else job.resolve(Buffer.from(out));
      }
      w.unref(); // (an idle worker never keeps the process running)
      idle.push(w);
      pump();
    });
    w.on('error', (e) => {
      workers.delete(w);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
      stats.failed++;
      if (w.job) w.job.reject(e);
      w.job = null;
      pump();
    });
    w.unref();
    workers.add(w);
    return w;
  }
  function pump() {
    while (queue.length) {
      let w = idle.pop();
      if (!w && workers.size < size && !broken) {
        try { w = spawn(); } catch { broken = true; }
      }
      if (!w) {
        if (broken && !workers.size) { const job = queue.shift(); inline(job).then(job.resolve, job.reject); continue; }
        return;
      }
      const job = queue.shift();
      w.job = job;
      w.ref();
      w.postMessage({ id: job.id, alg: job.alg, password: job.password, salt: job.salt, p: job.p });
    }
  }
  const busyNow = () => [...workers].filter((w) => w.job).length;
  return {
    /** Derives one hash: { alg: 'argon2id' | 'scrypt', password, salt, p }. Rejects with Busy when the queue is full. */
    run(job) {
      if (queue.length >= maxQueue) { stats.refused++; return Promise.reject(new Busy()); }
      return new Promise((resolve, reject) => {
        queue.push({ ...job, id: nextId++, resolve, reject });
        stats.peakQueue = Math.max(stats.peakQueue, queue.length);
        pump();
      });
    },
    stats: () => ({ running: busyNow(), queued: queue.length, workers: workers.size, size, maxQueue, ...stats }),
    async close() { await Promise.all([...workers].map((w) => w.terminate())); workers.clear(); idle.length = 0; },
  };
}
