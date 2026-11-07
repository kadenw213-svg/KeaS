// Audit 2, 6.6 and 7.4: a missing W-4 is a pay-run warning, the bank-file error names the real screen, and a manager
// sees the whole team's timecards for the pay run's period and approves several at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

let dir, app, base;
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-tc-team-'));
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('team timecards: the pay run’s period by default, and approving several at once (never your own)', async () => {
  const mgr = await login('p02'), pay = await login('p03');
  const run = (await call('GET', '/v1/payrun/preview', pay)).body;
  const team = await call('GET', '/v1/timecards/period', mgr);
  assert.equal(team.status, 200);
  assert.equal(team.body.period.start, run.period.start, 'the same period the pay run is on');
  const waiting = team.body.people.filter((p) => !p.approved && p.workedMin > 0 && !p.mine);
  assert.ok(waiting.length >= 2, 'the sample workplace has unapproved timecards');
  const ids = [...waiting.slice(0, 2).map((p) => p.personId), 'p02'];
  const r = await call('POST', '/v1/timecards/approve-many', mgr, { periodStart: team.body.period.start, personIds: ids });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.ok), [true, true, false]);
  assert.match(r.body.results[2].error, /your own/);
  const after2 = (await call('GET', '/v1/timecards/period', mgr)).body.people;
  for (const id of ids.slice(0, 2)) assert.equal(after2.find((p) => p.personId === id).approved, true);
  // Staff can't list everyone's.
  assert.equal((await call('GET', '/v1/timecards/period', await login('p04'))).status, 403);
});

test('pay run: a missing W-4 is a warning; the bank-file error names Org and pay setup', async () => {
  const pay = await login('p03');
  // Clear one person's W-4.
  app.h.run(`UPDATE people SET w4 = '{}' WHERE id = 'p04'`);
  const run = (await call('GET', '/v1/payrun/preview', pay)).body;
  const w = run.warnings.find((x) => x.code === 'no_w4');
  assert.ok(run.lines.find((l) => l.personId === 'p04')?.gross > 0);
  assert.ok(w && w.personId === 'p04');
  assert.match(w.message, /no W-4 on file, so federal tax is withheld as Single/);
  // No company bank details anywhere: the error says where to add them.
  app.h.run(`UPDATE legal_entities SET bank_enc = NULL`);
  app.h.run(`UPDATE orgs SET bank = '{}'`);
  const nacha = await call('GET', `/v1/payrun/nacha?periodStart=${run.period.start}`, pay);
  assert.equal(nacha.status, 409);
  assert.match(nacha.body.error, /Org and pay setup → Structure → Legal entities/);
});
