import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { payLine, federalWithholding, grossPay, coloradoWithholding } from '../../server/lib/pay.mjs';

const load = (p) => JSON.parse(readFileSync(new URL(`../../shared/${p}`, import.meta.url), 'utf8'));
const us = load('tax/US-2026.json'), co = load('tax/CO-2026.json');
const org = { employeeCount: 12, futaExempt: true, sutaRate: 0.0305 };
const W4 = { filing: 'single', step2: false, dependentsCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 };
const line = (rateCents, ytdWagesCents = 0, o = org) => payLine({ person: { id: 'x', name: 'X', w4: W4 }, totals: { regularMin: 4800, overtimeMin: 0, restPremiumMin: 0 }, rateCents, periodsPerYear: 26, ytdWagesCents, org: o, tables: { us, co } });
const byCode = (list) => Object.fromEntries(list.map((x) => [x.code, x.cents]));

test('hand-worked example: $20/h, 80 regular hours, single, biweekly', () => {
  assert.equal(co.incomeTax.annualAllowance.single, 5000, 'example assumes the $5,000 single allowance in CO-2026.json');
  const l = line(2000);
  const t = byCode(l.taxes);
  assert.equal(l.gross, 160000);                  // 80 x $20
  assert.equal(t.social_security, 9920);           // 6.2%
  assert.equal(t.medicare, 2320);                  // 1.45%
  assert.equal(t.co_income, 6194);                 // (1600 x 26 - 5000) x 4.4% / 26 = 61.9385
  assert.equal(t.co_famli, 704);                   // 0.44%
  // Federal (unverified, derived table): 41,600 - 8,600 = 33,000 -> 1,240 + 12% x (33,000 - 19,900) = 2,812 / 26
  assert.equal(t.federal_income, 10815);
  assert.equal(l.net, 160000 - 9920 - 2320 - 6194 - 704 - 10815);
  const e = byCode(l.employer);
  assert.equal(e.co_famli, 704, '12 employees -> employer share applies');
  assert.equal(e.futa, 0, 'FUTA-exempt org');
  assert.equal(e.co_suta, 4880);                   // 3.05%
  assert.equal(l.unverified, true);
  assert.equal(l.canFinalize, false);
  for (const x of [...l.taxes, ...l.employer]) assert.ok(x.explain.length > 0);
  assert.ok(l.explain.length > 4);
});

test('gross includes overtime x1.5 and rest premium', () => {
  const g = grossPay({ rateCents: 2000, regularMin: 2400, overtimeMin: 300, restPremiumMin: 10 });
  assert.equal(g.regularCents, 80000);
  assert.equal(g.overtimeCents, 15000);
  assert.equal(g.restPremiumCents, 333);
  assert.equal(g.cents, 95333);
});

test('Social Security stops at the wage base; additional Medicare over $200k', () => {
  assert.equal(byCode(line(10000, 18400000).taxes).social_security, Math.round(50000 * 0.062)); // only $500 left under 184,500
  assert.equal(byCode(line(10000, 20000000).taxes).medicare, Math.round(800000 * 0.0145) + Math.round(800000 * 0.009));
});

test('small employer pays no FAMLI share; non-exempt org pays FUTA', () => {
  const e = byCode(line(2000, 0, { employeeCount: 5, futaExempt: false, sutaRate: 0.0305 }).employer);
  assert.equal(e.co_famli, 0);
  assert.equal(e.futa, 960);
});

test('federal withholding: structure and sanity', () => {
  let prev = -1;
  for (const cents of [0, 50000, 100000, 200000, 400000, 800000, 2000000]) {
    const w = federalWithholding({ grossCents: cents, periodsPerYear: 26, w4: W4, table: us });
    assert.ok(w.cents >= 0);
    assert.ok(w.cents >= prev, 'monotonic in wages');
    assert.ok(w.explain.length >= 6);
    prev = w.cents;
  }
  for (const filing of ['single', 'married', 'hoh']) {
    const base = federalWithholding({ grossCents: 250000, periodsPerYear: 26, w4: { ...W4, filing }, table: us }).cents;
    const s2 = federalWithholding({ grossCents: 250000, periodsPerYear: 26, w4: { ...W4, filing, step2: true }, table: us }).cents;
    assert.ok(s2 > base, `step 2 increases withholding (${filing})`);
  }
  const none = federalWithholding({ grossCents: 250000, periodsPerYear: 26, w4: W4, table: us }).cents;
  const cred = federalWithholding({ grossCents: 250000, periodsPerYear: 26, w4: { ...W4, dependentsCredit: 2000 }, table: us }).cents;
  assert.ok(Math.abs(none - cred - Math.round((2000 / 26) * 100)) <= 1);
  const extra = federalWithholding({ grossCents: 250000, periodsPerYear: 26, w4: { ...W4, extraWithholding: 25 }, table: us }).cents;
  assert.equal(extra - none, 2500);
  assert.equal(us.verified, false);
});

test('Colorado DR 0004 allowance overrides the W-4 default', () => {
  const a = coloradoWithholding({ grossCents: 160000, periodsPerYear: 26, w4: W4, coAllowance: 0, table: co });
  assert.equal(a.cents, Math.round((41600 * 0.044 / 26) * 100));
});
