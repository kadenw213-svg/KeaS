// Load check (not part of `npm test`: it takes a while): a flood of sign-ins must not freeze the Hub.
//   node test/load/login-flood.mjs [logins=300] [concurrency=100]
// Starts a throwaway Hub, sends many sign-ins at once (each costs a password hash, which runs in the worker pool, at
// most 2 at a time with 32 waiting: the rest get 503 at once), and meanwhile times GET /v1/health. Under Electron
// (ELECTRON_RUN_AS_NODE=1 path\to\electron.exe test/load/login-flood.mjs) it measures the case the audit found.
// Exits 1 if /v1/health's 95th percentile goes over 500 ms.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../../hub/index.mjs';

const total = Number(process.argv[2]) || 300;
const concurrency = Number(process.argv[3]) || 100;
const dir = mkdtempSync(join(tmpdir(), 'kea-load-'));
// (A proxy header so each "visitor" has its own address, like Funnel traffic; generous per-address limits so the
// flood actually reaches the hashing.)
const hub = createHub({ dataDir: dir, log: false, ipHeader: 'x-test-ip', minFreeBytes: 0, limits: { login: [1000, 60_000], authAll: [1000, 1000] } });
const { port } = await hub.listen({ port: 0, ownerPort: 0 });
const base = `http://127.0.0.1:${port}`;

const statuses = {};
let sent = 0;
async function worker(n) {
  while (sent < total) {
    const i = sent++;
    const r = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': `10.${n}.${i % 250}.${(i >> 8) % 250}` }, body: JSON.stringify({ email: `nobody${i}@example.com`, password: 'lantern velvet orbit' }) }).catch(() => ({ status: 'error' }));
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  }
}
const times = [];
let flooding = true;
const probe = (async () => {
  while (flooding) {
    const t = performance.now();
    await fetch(`${base}/v1/health`, { headers: { 'x-test-ip': '192.0.2.1' } }).then((r) => r.arrayBuffer());
    times.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 50));
  }
})();
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, n) => worker(n)));
flooding = false;
await probe;
const sorted = [...times].sort((a, b) => a - b);
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]?.toFixed(1);
console.log(`${total} sign-ins, ${concurrency} at a time, in ${((performance.now() - t0) / 1000).toFixed(1)} s; answers: ${JSON.stringify(statuses)}`);
console.log(`/v1/health while flooded: ${times.length} probes, p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`);
await hub.close();
rmSync(dir, { recursive: true, force: true });
process.exit(Number(pct(0.95)) > 500 ? 1 : 0);
