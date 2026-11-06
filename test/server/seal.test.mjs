// Sealed columns (audit M3/M-AAD): pay amounts, medical text, hiring and review notes and the audit trail are sealed in
// the database file and its write-ahead log; each sealed value is bound to its table, column and row, so values moved
// between rows (or copied) are refused; and a plain value planted in a sealed column is refused, never sealed for it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';
import { isSealed, SealError } from '../../server/lib/vault.mjs';

let dir, app, base;
const file = () => join(dir, 'org.db');
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;
const start = async () => { app = createApp({ dbFile: file(), log: false, devKeyFile: true, demo: true }); base = `http://127.0.0.1:${await app.listen(0)}`; };
/** The database file and its write-ahead log as bytes. */
const fileBytes = () => Buffer.concat([file(), file() + '-wal'].filter(existsSync).map((f) => readFileSync(f)));

before(async () => { dir = mkdtempSync(join(tmpdir(), 'keas-seal-test-')); await start(); });
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

const NEEDLES = {
  rate: '777123', medical: 'CANCERDIAGNOSIS', reason: 'MEDREASONQX', usage: 'USAGENOTEQX', candidate: 'Zelda Qcandidate', candEmail: 'zelda.q@cand.example',
  phone: '555-0199-77', answer: 'ANSWERSECRETQX', feedback: 'FEEDBACKSECRETQX', review: 'REVIEWTEXTQX', privateNote: 'PRIVATENOTEQX', legal: 'Legalname Qzed',
  contractor: '4242421', aca: '919191', extra: '6060606', ytd: '5151515', totals: '8282828', timeOff: 'TIMEOFFNOTEQX',
};

test('M3: the PoC values (pay amounts, medical text, candidates, reviews, notes, audit details) aren’t in the database file or its log', async () => {
  const pay = await login('p03');
  const mgr = await login('p02');
  // A rate (its amount also goes into the audit trail) and a legal name.
  assert.equal((await call('POST', '/v1/people/p06/rates', await login('p01'), { positionId: 'pos-si', rateCents: Number(NEEDLES.rate), effectiveFrom: '2099-01-01' })).status, 201);
  assert.equal((await call('POST', '/v1/people/p07/rates', pay, { positionId: 'pos-hg', rateCents: Number(NEEDLES.rate), effectiveFrom: '2099-01-01' })).status, 202, 'a raise request (its amounts are sealed too)');
  assert.equal((await call('POST', '/v1/people/p06/profile', pay, { legalName: NEEDLES.legal })).status, 200);
  // Medical leave.
  const lc = await call('POST', '/v1/leave-cases', pay, { personId: 'p05', law: 'fmla', reason: NEEDLES.reason, startDate: '2030-01-05', notes: `${NEEDLES.medical} chemotherapy`, entitlementHours: 480 });
  assert.equal(lc.status, 201, JSON.stringify(lc.body));
  assert.equal((await call('POST', `/v1/leave-cases/${lc.body.case.id}/usage`, pay, { date: '2030-01-06', hours: 8, note: NEEDLES.usage })).status, 200);
  // Hiring and reviews.
  const job = (await call('POST', '/v1/jobs', mgr, { title: 'Lifeguard', description: 'x', questions: ['Why?'] })).body.job;
  const cand = await call('POST', `/v1/jobs/${job.id}/candidates`, mgr, { name: NEEDLES.candidate, email: NEEDLES.candEmail, phone: NEEDLES.phone, answers: { 'Why?': NEEDLES.answer } });
  assert.equal(cand.status, 201);
  assert.equal((await call('POST', '/v1/checkins', mgr, { personId: 'p04', notes: 'went fine', privateNotes: NEEDLES.privateNote })).status, 201);
  // Contractor pay and ACA codes.
  const ctr = await call('POST', '/v1/people', pay, { name: 'Casey Contractor', workerType: 'contractor', status: 'active' });
  assert.equal((await call('POST', '/v1/contractor-payments', pay, { personId: ctr.body.profile.id, date: '2030-02-01', cents: Number(NEEDLES.contractor) })).status, 201);
  assert.equal((await call('POST', '/v1/yearend/aca/months', pay, { personId: 'p04', year: 2030, months: [{ month: 1, offerCode: '1E', contributionCents: Number(NEEDLES.aca), safeHarbor: '2C' }] })).status, 200);
  // Rows other routes write (raises' retro pay, imports, pay runs, reviews, interviews), written the same way.
  const h = app.h;
  h.run(`INSERT INTO extra_earnings (id,org_id,person_id,code,label,cents,taxable,status,detail,created_at) VALUES ('ee-t','org-demo','p04','retro','Retro',?,1,'pending',?,'2030-01-01')`, Number(NEEDLES.extra), JSON.stringify([{ cents: Number(NEEDLES.extra) }]));
  h.run(`INSERT INTO ytd_imports (person_id,year,as_of,code,cents,created_at) VALUES ('p04',2030,'2030-01-01','gross',?,'2030-01-01')`, Number(NEEDLES.ytd));
  h.run(`INSERT INTO payruns (id,org_id,period_start,period_end,pay_date,status,totals,tables) VALUES ('run-t','org-demo','2001-01-01','2001-01-14','2001-01-20','draft',?,'[]')`, JSON.stringify({ gross: Number(NEEDLES.totals) }));
  h.run(`INSERT INTO interviews (id,candidate_id,at,feedback) VALUES ('iv-t',?,'2030-01-01T10:00:00Z',?)`, cand.body.candidate.id, JSON.stringify([{ by: 'p02', text: NEEDLES.feedback }]));
  h.run(`INSERT INTO review_cycles (id,org_id,name,period_start,period_end,questions,created_at) VALUES ('rc-t','org-demo','R','2030-01-01','2030-06-30','[]','2030-01-01')`);
  h.run(`INSERT INTO reviews (id,cycle_id,person_id,reviewer_id,self_answers,manager_answers) VALUES ('rv-t','rc-t','p04','p02',?,'{}')`, JSON.stringify({ q: NEEDLES.review }));
  h.run(`INSERT INTO time_off_requests (id,org_id,person_id,policy_id,start_date,end_date,hours,note,created_at) VALUES ('tor-t','org-demo','p04','x','2030-01-01','2030-01-01',8,?,'2030-01-01')`, NEEDLES.timeOff);

  // The app reads them back as usual.
  assert.equal((await call('GET', '/v1/leave-cases', pay)).body.cases.find((c) => c.id === lc.body.case.id).notes, `${NEEDLES.medical} chemotherapy`);
  assert.equal((await call('GET', `/v1/jobs/${job.id}/candidates`, mgr)).body.candidates[0].name, NEEDLES.candidate);
  assert.equal(h.get(`SELECT totals FROM payruns WHERE id = 'run-t'`).totals, JSON.stringify({ gross: Number(NEEDLES.totals) }));
  const raw = h.db.prepare(`SELECT detail FROM audit_log WHERE action = 'rate_add' ORDER BY id DESC`).get();
  assert.ok(isSealed(raw.detail), 'the audit detail is sealed');

  // While running (database and write-ahead log), and again after closing.
  for (const when of ['running', 'closed']) {
    if (when === 'closed') { await app.close(); app = null; }
    const bytes = fileBytes();
    for (const [what, needle] of Object.entries(NEEDLES)) assert.equal(bytes.indexOf(Buffer.from(needle)), -1, `${what} (${needle}) is in the file while ${when}`);
  }
  await start();
});

test('M-AAD: a sealed value moved to another row, copied, or replaced with plaintext is refused, never accepted or re-sealed', async () => {
  const pay = await login('p03');
  const h = app.h;
  const raw = (id) => h.db.prepare('SELECT deposit FROM people WHERE id = ?').get(id).deposit;
  const setRaw = (id, v) => h.rawWrites(() => h.db.prepare('UPDATE people SET deposit = ? WHERE id = ?').run(v, id));
  const a = raw('p04'), b = raw('p05');
  assert.ok(isSealed(a) && isSealed(b));
  assert.equal((await call('GET', '/v1/people/p04/profile', pay)).status, 200);

  // Swapped between two people: each refuses to open (so nobody's pay goes to the other's account).
  setRaw('p04', b); setRaw('p05', a);
  assert.throws(() => h.get('SELECT * FROM people WHERE id = ?', 'p04'), SealError);
  const r = await call('GET', '/v1/people/p04/profile', pay);
  assert.equal(r.status, 500);
  assert.equal(r.body.damaged, true);
  assert.match(r.body.error, /changed outside KeaS/);
  const nacha = await call('GET', '/v1/payrun/nacha', pay);
  assert.notEqual(nacha.status, 200, 'no bank file is made from swapped accounts');

  // Copied (both rows hold the same value): refused even when the row key isn't read with it.
  setRaw('p04', a); setRaw('p05', a);
  assert.throws(() => h.get('SELECT deposit FROM people WHERE id = ?', 'p05'), /more than one row|belong/);
  assert.throws(() => h.get('SELECT * FROM people WHERE id = ?', 'p05'), SealError);
  setRaw('p05', b);
  assert.equal((await call('GET', '/v1/people/p05/profile', pay)).status, 200, 'put back: opens again');

  // Moved to another column of the same row.
  const ytd = h.db.prepare(`SELECT ytd_wages_cents FROM people WHERE id = 'p04'`).get().ytd_wages_cents;
  h.rawWrites(() => h.db.prepare(`UPDATE people SET pay_rate_cents = ? WHERE id = 'p04'`).run(ytd));
  assert.throws(() => h.get(`SELECT pay_rate_cents FROM people WHERE id = 'p04'`), SealError);

  // A plain deposit planted in the file (the attacker's account) is refused when read...
  const planted = JSON.stringify({ accounts: [{ routing: '011000015', account: '99887766554433', accountType: 'checking', remainder: true }] });
  setRaw('p06', planted);
  assert.throws(() => h.get('SELECT * FROM people WHERE id = ?', 'p06'), /isn’t sealed/);
  // ...and still refused after the vault is locked and opened again: it is never sealed into a valid value.
  await app.close();
  await start();
  assert.equal(app.h.db.prepare('SELECT deposit FROM people WHERE id = ?').get('p06').deposit, planted);
  assert.throws(() => app.h.get('SELECT * FROM people WHERE id = ?', 'p06'), /isn’t sealed/);
});
