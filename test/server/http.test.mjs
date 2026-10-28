import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

let app, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kea-server-test-'));
  app = createApp({ dbFile: join(dir, 'test.db'), log: false });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const login = async (personId) => { const r = await call('POST', '/v1/auth/demo-login', null, { personId }); assert.equal(r.status, 200); return r.body.token; };
const future = (days, h) => new Date(Date.now() + days * 86400000 + h * 3600000).toISOString();

test('health and demo users are public; everything else needs a token', async () => {
  const h = await call('GET', '/v1/health');
  assert.deepEqual([h.status, h.body.version, h.body.minClient], [200, '0.1.0-prototype', '0.58.0']);
  const u = await call('GET', '/v1/auth/demo-users');
  assert.equal(u.body.length, 12);
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', 'f'.repeat(64))).status, 401);
  assert.equal((await call('POST', '/v1/auth/demo-login', null, '{not json')).status, 400);
  assert.equal((await call('POST', '/v1/auth/demo-login', null, { personId: 5 })).status, 400);
});

test('role enforcement', async () => {
  const member = await login('p04'), manager = await login('p02'), payroll = await login('p03');
  assert.equal((await call('GET', '/v1/payrun/preview', member)).status, 403);
  assert.equal((await call('GET', '/v1/payrun/preview', manager)).status, 403);
  assert.equal((await call('GET', '/v1/alerts', member)).status, 403);
  assert.equal((await call('GET', '/v1/timecards?personId=p05', member)).status, 403);
  assert.equal((await call('POST', '/v1/shifts', member, { positionId: 'pos-lg', personId: null, start: future(3, 0), end: future(3, 4) })).status, 403);
  const org = await call('GET', '/v1/org', member);
  assert.equal(org.body.people.find((p) => p.id === 'p05').payRateCents, undefined, 'members do not see others\' pay rates');
  const owen = (await call('GET', '/v1/org', manager)).body.people.find((p) => p.id === 'p09');
  assert.equal(owen.minor, true);
  assert.equal(owen.age, 15);
  const pr = await call('GET', '/v1/payrun/preview', payroll);
  assert.equal(pr.status, 200);
  assert.equal(pr.body.unverified, true);
  assert.equal(pr.body.canFinalize, false);
  assert.ok(pr.body.lines.length > 5);
  assert.ok(pr.body.lines.every((l) => Number.isInteger(l.gross) && Number.isInteger(l.net) && l.explain.length));
  assert.ok(pr.body.lines.some((l) => l.hours.overtime > 0));
  const n = await call('GET', '/v1/payrun/nacha', payroll);
  assert.equal(n.status, 200);
  assert.ok(n.body.text.trimEnd().split('\n').every((l) => l.length === 94));
  const shifts = await call('GET', '/v1/shifts', member);
  assert.ok(shifts.body.shifts.every((s) => s.status === 'published' || s.personId === 'p04'));
  const all = await call('GET', '/v1/shifts', manager);
  assert.ok(all.body.shifts.some((s) => s.status === 'draft'));
});

test('cert-blocked shift returns 409 and cannot be forced', async () => {
  const manager = await login('p02');
  const body = { positionId: 'pos-lg', personId: 'p06', start: future(4, 0), end: future(4, 5) };
  const r = await call('POST', '/v1/shifts', manager, body);
  assert.equal(r.status, 409);
  assert.ok(r.body.problems.some((p) => p.code === 'cert_expired'));
  const f = await call('POST', '/v1/shifts?force=1&reason=short%20staffed', manager, body);
  assert.equal(f.status, 409);
  const live = await call('POST', '/v1/shifts/check', manager, { personId: 'p12', positionId: 'pos-lg', start: future(5, 0), end: future(5, 3) });
  assert.equal(live.status, 200);
  assert.ok(live.body.problems.some((p) => p.code === 'position_min_age' && p.blocking));
  const ok = await call('POST', '/v1/shifts', manager, { ...body, personId: 'p04', start: future(20, 0), end: future(20, 4) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.shift.personId, 'p04');
});

test('approving a punch request appends a punch', async () => {
  const hannah = await login('p08'), manager = await login('p02');
  const req = (await call('GET', '/v1/punch-requests', hannah)).body.requests.find((r) => r.id === 'pr-demo-1');
  assert.equal(req.status, 'pending');
  const ps = (await call('GET', '/v1/me', hannah)).body.period.lastCompleted.start;
  const before = await call('GET', `/v1/timecards?periodStart=${ps}`, hannah);
  assert.ok(before.body.flags.some((f) => f.code === 'missed_punch'));
  assert.equal((await call('POST', '/v1/punch-requests/pr-demo-1/decide', hannah, { approve: true })).status, 403);
  const d = await call('POST', '/v1/punch-requests/pr-demo-1/decide', manager, { approve: true });
  assert.equal(d.status, 200);
  assert.equal(d.body.punch.source, 'request:pr-demo-1');
  const after = await call('GET', `/v1/timecards?periodStart=${ps}`, hannah);
  assert.ok(!after.body.flags.some((f) => f.code === 'missed_punch'));
  assert.equal(after.body.editCount, 1);
  assert.ok(after.body.totals.workedMin > before.body.totals.workedMin);
  assert.equal((await call('POST', '/v1/punch-requests/pr-demo-1/decide', manager, { approve: true })).status, 409);
  assert.equal((await call('POST', '/v1/timecards/approve', manager, { personId: 'p08', periodStart: ps })).status, 200);
  assert.equal((await call('GET', `/v1/timecards?periodStart=${ps}`, hannah)).body.approved.by, 'p02');
});

test('clock in/out, status, alerts and swaps', async () => {
  const caleb = await login('p11'), sofia = await login('p10'), manager = await login('p02');
  assert.equal((await call('POST', '/v1/punches', caleb, { type: 'out' })).status, 409);
  assert.equal((await call('POST', '/v1/punches', caleb, { type: 'in' })).status, 201);
  assert.equal((await call('POST', '/v1/punches', caleb, { type: 'in' })).status, 409);
  assert.equal((await call('POST', '/v1/punches', caleb, { type: 'out', restAttested: true })).status, 201);
  assert.equal((await call('POST', '/v1/punches', caleb, { type: 'sideways' })).status, 400);
  const st = await call('GET', '/v1/status/today', manager);
  assert.ok(st.body.shifts.every((s) => ['on_time', 'late', 'no_show', 'clocked_in', 'clocked_out', 'upcoming'].includes(s.state) && s.personName && s.positionId));
  const al = await call('GET', '/v1/alerts', manager);
  assert.ok(al.body.alerts.some((a) => a.type === 'late' && !a.resolved));
  const sw = (await call('GET', '/v1/swaps', sofia)).body.swaps.find((s) => s.id === 'sw-demo-1');
  assert.equal(sw.status, 'offered');
  assert.equal((await call('POST', '/v1/swaps/sw-demo-1/claim', sofia)).status, 409, 'Sofia has no Water Safety Instructor cert');
  const jordan = await login('p07');
  assert.equal((await call('POST', '/v1/swaps/sw-demo-1/claim', jordan)).status, 200);
  const dec = await call('POST', '/v1/swaps/sw-demo-1/decide', manager, { approve: true });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.swap.shift.personId, 'p07');
});
