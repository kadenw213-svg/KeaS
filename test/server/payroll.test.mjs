// Payroll and HR: finalizing (only on verified tables), retro pay, allocation, PTO, approvals, onboarding,
// offboarding, expenses, import, documents, reports and year-end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.mjs';

const SHARED = new URL('../../shared/', import.meta.url);
let dir, base, app, verifiedDir;

/** A copy of the tables marked verified for `year`: only ever in a temp folder, for testing the finalize path. */
function verifiedTables(year) {
  const d = join(dir, `tables-${year}`);
  cpSync(SHARED, d, { recursive: true });
  for (const code of ['US', 'CO']) {
    const t = JSON.parse(readFileSync(join(d, 'tax', `${code}-2026.json`), 'utf8'));
    writeFileSync(join(d, 'tax', `${code}-${year}.json`), JSON.stringify({ ...t, year, verified: true }));
    const l = JSON.parse(readFileSync(join(d, 'labor', `${code}.json`), 'utf8'));
    writeFileSync(join(d, 'labor', `${code}.json`), JSON.stringify({ ...l, verifiedFor: year }));
  }
  return d;
}

async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-payroll-test-'));
  // Which year is the last completed period paid in? Build verified tables for exactly that year.
  const probe = createApp({ dbFile: join(dir, 'probe.db'), log: false });
  const port0 = await probe.listen(0);
  base = `http://127.0.0.1:${port0}`;
  const t = await login('p03');
  const year = (await call('GET', '/v1/payrun/preview', t)).body.year;
  await probe.close();
  verifiedDir = verifiedTables(year);
  app = createApp({ dbFile: join(dir, 'payroll.db'), log: false, sharedDir: verifiedDir });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test('SSNs and bank details are sealed at rest', () => {
  const rows = app.h.all('SELECT deposit, pii_enc FROM people');
  assert.ok(rows.length > 5);
  for (const r of rows) {
    assert.match(r.deposit, /^v1\./);
    assert.match(r.pii_enc, /^v1\./);
    assert.ok(!r.pii_enc.includes('98765'));
  }
  assert.match(app.h.get('SELECT bank FROM orgs').bank, /^v1\./);
});

test('the real tables are unverified, so the real server refuses to finalize', async () => {
  const real = createApp({ dbFile: join(dir, 'real.db'), log: false });
  const port = await real.listen(0);
  const saved = base;
  base = `http://127.0.0.1:${port}`;
  try {
    const t = await login('p01');
    const pr = (await call('GET', '/v1/payrun/preview', t)).body;
    assert.equal(pr.tablesVerified, false);
    assert.equal(pr.canFinalize, false);
    for (const l of pr.lines) await call('POST', '/v1/timecards/approve', t, { personId: l.personId, periodStart: pr.period.start });
    const f = await call('POST', '/v1/payrun/finalize', t, { periodStart: pr.period.start });
    assert.equal(f.status, 409);
    assert.match(f.body.error, /aren’t verified/);
  } finally { base = saved; await real.close(); }
});

let finalizedPeriod;
test('finalize: blocked by unapproved timecards, then stored; can’t finalize twice', async () => {
  const owner = await login('p01');
  const pr = (await call('GET', '/v1/payrun/preview', owner)).body;
  assert.equal(pr.tablesVerified, true);
  assert.equal(pr.canFinalize, false);
  assert.ok(pr.blockers.some((b) => /timecard/.test(b)));
  assert.equal((await call('POST', '/v1/payrun/finalize', owner, { periodStart: pr.period.start })).status, 409);
  for (const l of pr.lines) await call('POST', '/v1/timecards/approve', owner, { personId: l.personId, periodStart: pr.period.start });
  const ready = (await call('GET', '/v1/payrun/preview', owner)).body;
  assert.equal(ready.canFinalize, true, ready.blockers.join(' '));
  // Earnings are itemized; overtime is a premium on the blended regular rate.
  const elena = ready.lines.find((l) => l.personId === 'p05');
  assert.ok(elena.earnings.some((e) => e.code === 'overtime'));
  assert.equal(elena.earnings.filter((e) => e.taxable !== false).reduce((a, e) => a + e.cents, 0), elena.gross);
  // The overnight shift earns the overnight differential.
  const jordan = ready.lines.find((l) => l.personId === 'p07');
  assert.ok(jordan.earnings.some((e) => e.code === 'differential' && e.cents > 0));
  // Allocation: the distribution adds up to gross, split 60/40 for Jordan by default.
  for (const l of ready.lines) assert.equal(l.distribution.reduce((a, d) => a + d.cents, 0), l.gross);
  assert.equal(new Set(jordan.distribution.map((d) => d.departmentId)).size, 2);
  const f = await call('POST', '/v1/payrun/finalize', owner, { periodStart: pr.period.start });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.equal((await call('POST', '/v1/payrun/finalize', owner, { periodStart: pr.period.start })).status, 409);
  finalizedPeriod = pr.period;
  // Accruals posted for the period (sick leave 1 h per 30 worked).
  const bal = (await call('GET', '/v1/pto/balances?personId=p05', owner)).body.people[0].balances.find((b) => b.name === 'Paid sick leave');
  assert.ok(bal.hours > 12);
  // GL journal balances, NACHA has 94-char records, stubs and the register come from the stored run.
  const gl = (await call('GET', `/v1/payrun/gl?periodStart=${pr.period.start}`, owner)).body;
  assert.equal(gl.totals.balanced, true);
  const nacha = (await call('GET', `/v1/payrun/nacha?periodStart=${pr.period.start}`, owner)).body;
  assert.equal(nacha.finalized, true);
  assert.ok(nacha.text.trimEnd().split('\n').every((x) => x.length === 94));
  const stub = await call('GET', `/v1/payrun/stub?periodStart=${pr.period.start}&personId=p05`, owner);
  assert.equal(stub.body.stub.finalized, true);
  assert.ok(stub.body.stub.ytd.gross >= elena.gross);
  const pdf = await call('GET', `/v1/payrun/stub?periodStart=${pr.period.start}&personId=p05&format=pdf`, owner);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  const own = await call('GET', `/v1/payrun/stub?periodStart=${pr.period.start}`, await login('p05'));
  assert.equal(own.status, 200);
  assert.equal((await call('GET', `/v1/payrun/stub?periodStart=${pr.period.start}&personId=p04`, await login('p05'))).status, 403);
  const reg = (await call('GET', `/v1/reports/register?periodStart=${pr.period.start}`, owner)).body;
  assert.equal(reg.finalized, true);
  assert.equal(reg.totals.gross, ready.totals.gross);
  const csv = await call('GET', `/v1/reports/register?periodStart=${pr.period.start}&format=csv`, owner);
  assert.match(csv.body.toString(), /^payDate,/);
});

test('a back-dated raise goes through its approval chain and owes retro pay', async () => {
  const payroll = await login('p03'), manager = await login('p02'), owner = await login('p01');
  const r = await call('POST', '/v1/raises', payroll, { personId: 'p04', newRateCents: 2100, effectiveDate: finalizedPeriod.start, reason: 'Annual review' });
  assert.equal(r.status, 201);
  const ap = r.body.approval;
  assert.deepEqual(ap.steps.map((s) => s.type), ['manager_of', 'role']);
  assert.equal((await call('POST', `/v1/approvals/${ap.id}/decide`, payroll, { approve: true })).status, 403, 'the requester can’t approve');
  assert.equal((await call('POST', `/v1/approvals/${ap.id}/decide`, await login('p04'), { approve: true })).status, 403, 'the subject can’t approve');
  assert.equal((await call('POST', `/v1/approvals/${ap.id}/decide`, manager, { approve: true })).body.approval.status, 'pending');
  assert.equal((await call('POST', `/v1/approvals/${ap.id}/decide`, owner, { approve: true })).body.approval.status, 'approved');
  const run = app.h.get(`SELECT l.detail FROM payrun_lines l JOIN payruns r ON r.id = l.run_id WHERE l.person_id = 'p04'`);
  const segs = JSON.parse(run.detail).segments;
  const expect = Math.round(segs.reduce((a, s) => a + (2100 - s.rateCents) * (s.minutes + s.otMin * 0.5) / 60, 0));
  const ee = app.h.get(`SELECT * FROM extra_earnings WHERE person_id = 'p04' AND code = 'retro'`);
  assert.equal(ee.cents, expect);
  const cur = (await call('GET', `/v1/payrun/preview?periodStart=${(await call('GET', '/v1/me', owner)).body.period.current.start}`, owner)).body;
  assert.ok(cur.lines.find((l) => l.personId === 'p04').earnings.some((e) => e.code === 'retro' && e.cents === expect));
  assert.equal((await call('GET', '/v1/people/p04/rates', owner)).body.rates[0].rateCents, 2100);
});

test('configurable approval chains: two steps for time off, and balances', async () => {
  const owner = await login('p01'), manager = await login('p02'), tyler = await login('p06');
  const ch = await call('POST', '/v1/approval-chains', owner, { kind: 'time_off', name: 'Guards', steps: [{ type: 'manager_of' }, { type: 'person', personId: 'p03' }] });
  assert.equal(ch.status, 200);
  assert.equal((await call('POST', '/v1/time-off', tyler, { policyId: 'pol-vac', startDate: '2030-01-07', endDate: '2030-01-07', hours: 500 })).status, 409, 'not enough balance');
  const req = await call('POST', '/v1/time-off', tyler, { policyId: 'pol-vac', startDate: '2030-01-07', endDate: '2030-01-08', hours: 16 });
  assert.equal(req.status, 201);
  const id = req.body.approval.id;
  const mine = (await call('GET', '/v1/approvals', manager)).body.approvals;
  assert.ok(mine.some((a) => a.id === id));
  await call('POST', `/v1/approvals/${id}/decide`, manager, { approve: true });
  assert.equal((await call('POST', `/v1/approvals/${id}/decide`, manager, { approve: true })).status, 403, 'step 2 is Priya’s');
  const done = await call('POST', `/v1/approvals/${id}/decide`, await login('p03'), { approve: true });
  assert.equal(done.body.approval.status, 'approved');
  const ledger = (await call('GET', '/v1/pto/ledger?personId=p06', owner)).body.entries;
  assert.ok(ledger.some((e) => e.kind === 'taken' && e.hours === -16));
  await call('POST', `/v1/approval-chains/${ch.body.chain.id}/delete`, owner);
});

test('org structure: tree, no cycles, splits must add to 100, shift splits by minutes', async () => {
  const owner = await login('p01');
  const s = (await call('GET', '/v1/org-structure', owner)).body;
  assert.equal(s.tree.find((d) => d.id === 'dp-aq').children.length, 2);
  assert.equal(s.tree.find((d) => d.id === 'dp-aq').children[0].path.startsWith('Aquatics / '), true);
  assert.equal((await call('POST', '/v1/departments', owner, { id: 'dp-aq', name: 'Aquatics', parentId: 'dp-guard' })).status, 400);
  assert.equal((await call('POST', '/v1/people/p04/job', owner, { defaultAllocations: [{ departmentId: 'dp-guard', pct: 50 }, { departmentId: 'dp-lessons', pct: 40 }] })).status, 400);
  assert.equal((await call('POST', '/v1/entities', owner, { name: 'Second Co', ein: '12-345' })).status, 400);
  const ent = await call('POST', '/v1/entities', owner, { name: 'Camp Co LLC', ein: '98-7654321', state: 'TX', bank: { originRouting: '990000013', companyId: '1987654321', name: 'CAMP CO' } });
  assert.equal(ent.status, 200);
  assert.equal(ent.body.entity.bankSet, true);
  const shift = app.h.get(`SELECT id FROM shifts WHERE person_id = 'p04' AND status = 'published' LIMIT 1`).id;
  const sp = await call('POST', `/v1/shifts/${shift}/allocations`, owner, { splits: [{ departmentId: 'dp-lessons', minutes: 60 }] });
  assert.equal(sp.status, 200);
  const eff = (await call('GET', `/v1/shifts/${shift}/allocations`, owner)).body.effective;
  assert.ok(Math.abs(eff.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
  assert.ok(eff.some((x) => x.departmentId === 'dp-lessons'));
  const ld = (await call('GET', `/v1/reports/labor-distribution?periodStart=${finalizedPeriod.start}`, owner)).body;
  assert.ok(ld.rows.length >= 2);
  const b = await call('POST', '/v1/budgets', await login('p02'), { departmentId: 'dp-guard', periodStart: finalizedPeriod.start, periodEnd: finalizedPeriod.end, amountCents: 500000 });
  assert.equal(b.status, 201);
  await call('POST', `/v1/approvals/${b.body.approval.id}/decide`, owner, { approve: true });
  const ld2 = (await call('GET', `/v1/reports/labor-distribution?periodStart=${finalizedPeriod.start}`, owner)).body;
  assert.ok(ld2.rows.some((r) => r.departmentId === 'dp-guard' && r.budget === 500000 && typeof r.variance === 'number'));
});

test('onboarding: offer, e-signed W-4 and state form, I-9, policies, deposit, new-hire report', async () => {
  const pay = await login('p03');
  const offer = await call('POST', '/v1/offers', pay, { name: 'Riley Stone', email: 'riley@example.org', title: 'Lifeguard', positionId: 'pos-lg', rateCents: 1800, startDate: '2030-06-01' });
  assert.equal(offer.status, 201);
  const pid = offer.body.offer.personId;
  assert.match(offer.body.offer.body, /Riley Stone/);
  await call('POST', `/v1/offers/${offer.body.offer.id}/send`, pay);
  assert.equal((await call('POST', `/v1/offers/${offer.body.offer.id}/sign`, pay, { typedName: 'Someone Else', consent: true })).status, 400);
  const signed = await call('POST', `/v1/offers/${offer.body.offer.id}/sign`, pay, { typedName: '  riley  stone ', consent: true });
  assert.equal(signed.body.offer.status, 'accepted');
  assert.match(signed.body.offer.signature.hash, /^[0-9a-f]{64}$/);
  assert.equal((await call('GET', `/v1/signatures/${signed.body.offer.signature.id}/verify`, pay)).body.valid, true);
  const ob = await call('POST', '/v1/onboarding/start', pay, { personId: pid, startDate: '2030-06-01' });
  assert.equal(ob.status, 201);
  assert.ok(ob.body.tasks.find((t) => t.kind === 'offer').status === 'done');
  assert.equal(ob.body.tasks.find((t) => t.kind === 'i9_section2').due, '2030-06-05', 'a Saturday start: Mon, Tue, Wed');
  assert.equal((await call('POST', `/v1/onboarding/${pid}/complete`, pay, {})).status, 409);
  const w4 = await call('POST', '/v1/forms/w4', pay, { personId: pid, typedName: 'Riley Stone', consent: true, data: { filing: 'married', step2: false, dependentsCredit: 2000, ssn: '123-45-6789', address: { line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' } } });
  assert.equal(w4.status, 201);
  assert.equal((await call('GET', `/v1/people/${pid}/profile`, pay)).body.profile.w4.filing, 'married');
  assert.equal((await call('GET', `/v1/people/${pid}/profile`, pay)).body.profile.ssnMasked, '***-**-6789');
  assert.equal((await call('POST', `/v1/people/${pid}/reveal-ssn`, pay)).body.ssn, '123-45-6789');
  assert.equal((await call('POST', '/v1/forms/state', pay, { personId: pid, typedName: 'Riley Stone', consent: true, data: { annualAllowance: 4000 } })).status, 201);
  assert.equal((await call('POST', `/v1/i9/${pid}/section2`, pay, { examinedOriginals: true, documents: [{ list: 'A', title: 'US Passport' }], typedName: 'Priya Raman', consent: true })).status, 409);
  assert.equal((await call('POST', `/v1/i9/${pid}/section1`, pay, { attestation: 'citizen', typedName: 'Riley Stone', consent: true })).status, 200);
  assert.equal((await call('POST', `/v1/i9/${pid}/section2`, pay, { examinedOriginals: true, documents: [{ list: 'B', title: 'Driver’s license' }], typedName: 'Priya Raman', consent: true })).status, 400);
  const i9 = await call('POST', `/v1/i9/${pid}/section2`, pay, { examinedOriginals: true, documents: [{ list: 'B', title: 'Driver’s license' }, { list: 'C', title: 'Social Security card' }], typedName: 'Priya Raman', consent: true });
  assert.equal(i9.body.i9.status, 'complete');
  assert.equal((await call('POST', `/v1/people/${pid}/deposit`, pay, { routing: '123456789', account: '12345678' })).status, 400);
  assert.equal((await call('POST', `/v1/people/${pid}/deposit`, pay, { accounts: [{ routing: '990000013', account: '55554444', amountCents: 10000 }, { routing: '990000013', account: '55553333', accountType: 'savings' }] })).status, 200);
  assert.equal((await call('POST', '/v1/policies/po-handbook/ack', pay, { personId: pid, typedName: 'Riley Stone', consent: true })).status, 200);
  const status = (await call('GET', `/v1/onboarding/${pid}`, pay)).body;
  assert.deepEqual(status.tasks.filter((t) => t.status === 'open').map((t) => t.kind), ['new_hire_report']);
  const nh = await call('GET', '/v1/new-hire-report?from=2030-05-01&to=2030-06-30&format=csv&mark=1', pay);
  assert.match(nh.body.toString(), /123456789/);
  assert.equal((await call('POST', `/v1/onboarding/${pid}/complete`, pay, {})).body.person.status, 'active');
});

test('offboarding: Colorado final pay is due at once when the employer ends it; vacation is paid out, sick leave isn’t', async () => {
  const pay = await login('p03');
  const o = await call('POST', '/v1/offboarding', pay, { personId: 'p10', kind: 'involuntary', lastDay: '2030-03-10', equipment: ['Whistle', 'Radio'] });
  assert.equal(o.status, 201);
  assert.equal(o.body.case.finalPayDue, '2030-03-10');
  const vac = o.body.case.ptoPayout.find((x) => x.name === 'Vacation'), sick = o.body.case.ptoPayout.find((x) => x.name === 'Paid sick leave');
  assert.equal(vac.pay, true);
  assert.equal(sick.pay, false);
  assert.ok(o.body.case.checklist.some((x) => x.label.includes('Whistle')));
  const paid = await call('POST', `/v1/offboarding/${o.body.case.id}/payout`, pay);
  assert.equal(paid.status, 200);
  assert.ok(app.h.get(`SELECT cents FROM extra_earnings WHERE person_id = 'p10' AND code = 'pto_payout'`).cents > 0);
  assert.equal((await call('POST', `/v1/offboarding/${o.body.case.id}/complete`, pay, {})).status, 409);
  const done = await call('POST', `/v1/offboarding/${o.body.case.id}/complete`, pay, { force: true, reason: 'Checklist done on paper' });
  assert.equal(done.body.case.status, 'complete');
  const vol = await call('POST', '/v1/offboarding', pay, { personId: 'p09', kind: 'voluntary', lastDay: '2030-03-10' });
  assert.ok(vol.body.case.finalPayDue > '2030-03-10', 'quitting: next regular payday');
});

test('expenses: mileage needs a rate; an approved expense is reimbursed untaxed through payroll', async () => {
  const owner = await login('p01'), marcus = await login('p04');
  assert.equal((await call('POST', '/v1/expenses', marcus, { kind: 'mileage', miles: 10, date: '2030-01-05' })).status, 400);
  await call('POST', '/v1/org/settings', owner, { mileageRateCents: 70 });
  const e = await call('POST', '/v1/expenses', marcus, { kind: 'mileage', miles: 12.5, date: '2030-01-05', description: 'Supply run' });
  assert.equal(e.body.expense.amountCents, 875);
  const r = await call('POST', '/v1/expenses', marcus, { kind: 'receipt', amountCents: 2599, category: 'Supplies', date: '2030-01-05', receipt: { filename: 'r.txt', mime: 'text/plain', contentBase64: Buffer.from('receipt').toString('base64') } });
  assert.ok(r.body.expense.receiptId);
  const sub = await call('POST', `/v1/expenses/${e.body.expense.id}/submit`, marcus);
  await call('POST', `/v1/approvals/${sub.body.approval.id}/decide`, await login('p02'), { approve: true });
  const cur = (await call('GET', `/v1/payrun/preview?periodStart=${(await call('GET', '/v1/me', owner)).body.period.current.start}`, owner)).body;
  const line = cur.lines.find((l) => l.personId === 'p04');
  const re = line.earnings.find((x) => x.code === 'reimbursement');
  assert.equal(re.cents, 875);
  assert.equal(re.taxable, false);
  assert.equal(line.net, line.gross - line.withheld + 875);
});

test('import: Gusto-style employees, then YTD and time-off balances mid-year', async () => {
  const pay = await login('p03');
  const csv = 'First Name,Last Name,Email,Employee ID,SSN,Hire Date,Pay Rate,Pay Type,Federal Filing Status,Street Address,City,State,Zip,Routing Number,Account Number,Department\r\n'
    + 'Ana,Lopez,ana@example.org,E-77,123-45-6780,03/15/2030,$19.50,Hourly,Married filing jointly,"5 Oak St, Apt 2",Denver,CO,80203,990000013,9988776655,Front desk\r\n'
    + 'Ben,Ito,ben@example.org,E-78,000-00-0000,2030-04-01,"$52,000.00",Salary,Single,,,,,,,Front desk\r\n';
  const pv = await call('POST', '/v1/import/preview', pay, { kind: 'employees', source: 'gusto', csv });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.mapping.firstName, 'First Name');
  assert.equal(pv.body.mapping.payRate, 'Pay Rate');
  assert.equal(pv.body.rows[0].payRate, 1950);
  assert.ok(pv.body.rows[1].problems.some((p) => /SSN/.test(p)));
  const cm = await call('POST', '/v1/import/commit', pay, { kind: 'employees', source: 'gusto', csv });
  assert.equal(cm.body.created, 2);
  const ana = app.h.get(`SELECT id FROM people WHERE email = 'ana@example.org'`).id;
  const prof = (await call('GET', `/v1/people/${ana}/profile`, pay)).body.profile;
  assert.equal(prof.ssnMasked, '***-**-6780');
  assert.equal(prof.address.line1, '5 Oak St, Apt 2');
  assert.equal(prof.deposit[0].accountLast4, '6655');
  assert.equal(prof.w4.filing, 'married');
  const ben = app.h.get(`SELECT id FROM people WHERE email = 'ben@example.org'`).id;
  assert.equal((await call('GET', `/v1/people/${ben}/rates`, pay)).body.rates[0].kind, 'salary');
  const ytd = 'Employee ID,Gross Pay,Federal Income Tax,Social Security,Medicare,State Income Tax,Net Pay\r\nE-77,"$12,000.00",900.00,744.00,174.00,480.00,"9,702.00"\r\n';
  const yc = await call('POST', '/v1/import/commit', pay, { kind: 'ytd', source: 'adp', csv: ytd, year: 2030, asOf: '2030-06-30' });
  assert.equal(yc.body.updated, 1);
  assert.equal(app.h.get('SELECT ytd_wages_cents FROM people WHERE id = ?', ana).ytd_wages_cents, 1200000);
  assert.equal(app.h.get(`SELECT cents FROM ytd_imports WHERE person_id = ? AND code = 'co_income'`, ana).cents, 48000);
  const pto = await call('POST', '/v1/import/commit', pay, { kind: 'pto', source: 'paychex', csv: 'Employee ID,Time Off Type,Balance\r\nE-77,Vacation,17.5\r\nE-77,Nope,3\r\n' });
  assert.equal(pto.body.updated, 1);
  assert.equal(pto.body.skipped, 1);
  const bal = (await call('GET', `/v1/pto/balances?personId=${ana}`, pay)).body.people[0].balances.find((b) => b.name === 'Vacation');
  assert.equal(bal.hours, 17.5);
  const w2 = (await call('GET', '/v1/yearend/w2?year=2030', pay)).body;
  const row = w2.rows.find((r) => r.personId === ana);
  assert.equal(row.box1, 1200000);
  assert.equal(row.box17, 48000);
  assert.equal(row.ssn, '***-**-6780');
  const w2csv = await call('GET', '/v1/yearend/w2?year=2030&format=csv', pay);
  assert.match(w2csv.body.toString(), /123456780/);
  const w2pdf = await call('GET', '/v1/yearend/w2?year=2030&format=pdf', pay);
  assert.equal(w2pdf.body.subarray(0, 5).toString(), '%PDF-');
});

test('documents: sealed file cabinet, e-sign, retention and legal hold', async () => {
  const pay = await login('p03');
  const content = Buffer.from('%PDF-1.4 signed handbook page');
  const up = await call('POST', '/v1/documents', pay, { personId: 'p05', category: 'tax_form', title: 'Old W-4', filename: 'w4.pdf', mime: 'application/pdf', contentBase64: content.toString('base64'), needsSignature: true });
  assert.equal(up.status, 201);
  const raw = app.h.get('SELECT content_enc FROM documents WHERE id = ?', up.body.document.id).content_enc;
  assert.match(raw, /^v1\./);
  const dl = await call('GET', `/v1/documents/${up.body.document.id}/download`, pay);
  assert.deepEqual(dl.body, content);
  assert.equal((await call('GET', `/v1/documents/${up.body.document.id}/download`, await login('p04'))).status, 403);
  const sg = await call('POST', `/v1/documents/${up.body.document.id}/sign`, await login('p05'), { typedName: 'Elena Vasquez', consent: true });
  assert.ok(sg.body.document.signature);
  await call('POST', '/v1/retention-rules/defaults', pay);
  const rules = (await call('GET', '/v1/retention-rules', pay)).body.rules;
  assert.equal(rules.find((r) => r.category === 'i9').yearsAfterTermination, 1);
  app.h.run(`UPDATE documents SET created_at = '2015-01-01T00:00:00.000Z' WHERE id = ?`, up.body.document.id);
  let due = (await call('GET', '/v1/documents/purge-due', pay)).body.documents;
  assert.ok(due.some((d) => d.id === up.body.document.id));
  await call('POST', `/v1/documents/${up.body.document.id}/hold`, pay, { hold: true, reason: 'audit' });
  assert.equal((await call('POST', '/v1/documents/purge', pay, { ids: [up.body.document.id] })).body.purged, 0);
  await call('POST', `/v1/documents/${up.body.document.id}/hold`, pay, { hold: false });
  assert.equal((await call('POST', '/v1/documents/purge', pay, { ids: [up.body.document.id] })).body.purged, 1);
});

test('custom report builder: filter, group and CSV', async () => {
  const pay = await login('p03');
  const r = await call('POST', '/v1/reports/run', pay, { dataset: 'pay', fields: ['department', 'gross', 'net'], groupBy: ['department'], filters: [{ field: 'gross', op: 'gt', value: '1' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.columns, ['department', 'count', 'gross', 'net']);
  assert.ok(r.body.rows.length >= 1);
  assert.equal((await call('POST', '/v1/reports/run', pay, { dataset: 'people', fields: ['ssn'] })).status, 400, 'no SSN field');
  const csv = await call('POST', '/v1/reports/run', pay, { dataset: 'people', fields: ['name', 'department'], filters: [{ field: 'department', op: 'eq', value: 'Lifeguarding' }], format: 'csv' });
  assert.match(csv.body.toString(), /^name,department/);
  assert.equal((await call('POST', '/v1/reports/saved', pay, { name: 'Guards', spec: { dataset: 'people', fields: ['name'] } })).status, 200);
  const tl = (await call('GET', `/v1/reports/tax-liability?periodStart=${finalizedPeriod.start}`, pay)).body;
  assert.ok(tl.rows.some((x) => x.code === 'social_security' && x.employee === x.employer));
});

test('hiring and performance', async () => {
  const pay = await login('p03'), mgr = await login('p02');
  const job = (await call('POST', '/v1/jobs', mgr, { title: 'Swim instructor', positionId: 'pos-si', description: 'Teach lessons', questions: ['Certifications?'] })).body.job;
  const cand = (await call('POST', `/v1/jobs/${job.id}/candidates`, mgr, { name: 'Casey Park', email: 'casey@example.org', answers: { 'Certifications?': 'WSI' } })).body.candidate;
  assert.equal((await call('POST', `/v1/candidates/${cand.id}/interviews`, mgr, { at: '2030-02-01T15:00:00Z', minutes: 30 })).status, 201);
  const hired = await call('POST', `/v1/candidates/${cand.id}/hire`, pay);
  assert.ok(hired.body.personId);
  assert.equal(app.h.get('SELECT status FROM people WHERE id = ?', hired.body.personId).status, 'applicant');
  const cy = await call('POST', '/v1/review-cycles', pay, { name: 'Spring', periodStart: '2030-01-01', periodEnd: '2030-06-30', questions: [{ text: 'What went well?' }, { text: 'Overall', rating: true }], personIds: ['p04'] });
  assert.equal(cy.status, 201);
  const rv = (await call('GET', '/v1/review-cycles', mgr)).body.cycles.find((x) => x.id === cy.body.id).reviews[0];
  assert.equal(rv.reviewerId, 'p02');
  await call('POST', `/v1/reviews/${rv.id}/self`, await login('p04'), { answers: { a: 'Opened every day' } });
  await call('POST', `/v1/reviews/${rv.id}/manager`, mgr, { answers: { a: 'Reliable', b: 4 } });
  assert.equal((await call('POST', `/v1/reviews/${rv.id}/share`, mgr)).body.review.status, 'shared');
  assert.equal((await call('POST', `/v1/reviews/${rv.id}/acknowledge`, await login('p04'), { typedName: 'Marcus Bell', consent: true })).body.review.status, 'acknowledged');
  assert.equal((await call('POST', '/v1/goals', await login('p04'), { title: 'WSI certification', progress: 20 })).status, 200);
});
