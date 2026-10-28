// Pay-run math (pure). PROTOTYPE ESTIMATES ONLY - tax tables are unverified; nothing here may be used to pay anyone.
// Amounts are integer cents unless a name says otherwise.

const r2 = (x) => Math.round(x * 100) / 100;           // dollars -> dollars at cents precision
const c = (dollars) => Math.round(dollars * 100);       // dollars -> cents
const $ = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);
const d$ = (dollars) => '$' + Number(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Gross pay from timecard minutes. */
export function grossPay({ rateCents, regularMin, overtimeMin, restPremiumMin = 0, otMultiplier = 1.5 }) {
  const reg = Math.round((regularMin * rateCents) / 60);
  const ot = Math.round((overtimeMin * rateCents * otMultiplier) / 60);
  const rest = Math.round((restPremiumMin * rateCents) / 60);
  const explain = [
    `Regular: ${(regularMin / 60).toFixed(2)} h x ${$(rateCents)} = ${$(reg)}`,
    `Overtime: ${(overtimeMin / 60).toFixed(2)} h x ${$(rateCents)} x ${otMultiplier} = ${$(ot)}`,
    `Missed rest-break premium: ${restPremiumMin} min x ${$(rateCents)}/h = ${$(rest)}`,
    `Gross = ${$(reg)} + ${$(ot)} + ${$(rest)} = ${$(reg + ot + rest)}`,
  ];
  return { cents: reg + ot + rest, regularCents: reg, overtimeCents: ot, restPremiumCents: rest, explain };
}

/** Social Security + Medicare (employee and employer). */
export function fica({ grossCents, ytdWagesCents = 0, table }) {
  const f = table.fica;
  const baseC = c(f.socialSecurityWageBase);
  const ssTaxable = Math.max(0, Math.min(grossCents, baseC - ytdWagesCents));
  const ss = Math.round(ssTaxable * f.socialSecurityRate);
  const med = Math.round(grossCents * f.medicareRate);
  const thrC = c(f.additionalMedicareThreshold);
  const addlTaxable = Math.max(0, ytdWagesCents + grossCents - Math.max(thrC, ytdWagesCents));
  const addl = Math.round(addlTaxable * f.additionalMedicareRate);
  return {
    socialSecurity: { cents: ss, explain: [`Social Security: ${$(ssTaxable)} taxable (wage base ${d$(f.socialSecurityWageBase)}, YTD before this run ${$(ytdWagesCents)}) x ${(f.socialSecurityRate * 100).toFixed(2)}% = ${$(ss)}`] },
    medicare: { cents: med + addl, explain: [`Medicare: ${$(grossCents)} x ${(f.medicareRate * 100).toFixed(2)}% = ${$(med)}`, `Additional Medicare 0.9% on wages over ${d$(f.additionalMedicareThreshold)} YTD: ${$(addlTaxable)} x ${(f.additionalMedicareRate * 100).toFixed(1)}% = ${$(addl)}`] },
    employerSocialSecurity: { cents: ss, explain: [`Employer Social Security matches employee: ${$(ss)}`] },
    employerMedicare: { cents: med, explain: [`Employer Medicare ${(f.medicareRate * 100).toFixed(2)}% (no additional 0.9% for employer) = ${$(med)}`] },
  };
}

function lookup(rows, wage) {
  let row = rows[0];
  for (const r of rows) if (wage >= r.over) row = r;
  return row;
}

/** IRS Pub 15-T Worksheet 1A (percentage method, automated systems, 2020+ W-4). */
export function federalWithholding({ grossCents, periodsPerYear, w4 = {}, table }) {
  const filing = ['single', 'married', 'hoh'].includes(w4.filing) ? w4.filing : 'single';
  const step2 = !!w4.step2;
  const ex = [];
  const a = grossCents / 100;
  const line1c = a * periodsPerYear;
  ex.push(`1a-1c: ${d$(a)} per period x ${periodsPerYear} periods = ${d$(line1c)} annualized`);
  const line1d = +w4.otherIncome || 0;
  const line1e = line1c + line1d;
  ex.push(`1d-1e: + Step 4(a) other income ${d$(line1d)} = ${d$(line1e)}`);
  const line1f = +w4.deductions || 0;
  const line1g = step2 ? 0 : (table.worksheet1A.line1g[filing] ?? table.worksheet1A.line1g.single);
  const line1h = line1f + line1g;
  const line1i = Math.max(0, line1e - line1h);
  ex.push(`1f-1h: - Step 4(b) deductions ${d$(line1f)} - line 1g ${d$(line1g)}${step2 ? ' (Step 2 checked: 0)' : ''} = ${d$(line1h)}`);
  ex.push(`1i: Adjusted annual wage = ${d$(line1i)}`);
  const tblName = step2 ? 'step2Checked' : 'standard';
  const rows = table.annualPercentageMethod[tblName][filing];
  const row = lookup(rows, line1i);
  const annualTax = row.base + (line1i - row.over) * row.rate;
  ex.push(`2: ${tblName === 'standard' ? 'Standard' : 'Step 2 checkbox'} table, ${filing}: row over ${d$(row.over)} -> ${d$(row.base)} + ${(row.rate * 100).toFixed(0)}% of excess = ${d$(annualTax)} per year`);
  const line2h = annualTax / periodsPerYear;
  ex.push(`2h: / ${periodsPerYear} = ${d$(r2(line2h))} tentative per period`);
  const credits = (+w4.dependentsCredit || 0) / periodsPerYear;
  const line3c = Math.max(0, line2h - credits);
  ex.push(`3: - Step 3 credits ${d$(+w4.dependentsCredit || 0)} / ${periodsPerYear} = ${d$(r2(credits))} -> ${d$(r2(line3c))}`);
  const extra = +w4.extraWithholding || 0;
  const total = line3c + extra;
  ex.push(`4: + Step 4(c) extra withholding ${d$(extra)} = ${d$(r2(total))} federal income tax this period`);
  return { cents: c(total), explain: ex };
}

/** Colorado wage withholding, DR 1098 annualized flat-rate method. */
export function coloradoWithholding({ grossCents, periodsPerYear, w4 = {}, coAllowance = null, table }) {
  const filing = ['single', 'married', 'hoh'].includes(w4.filing) ? w4.filing : 'single';
  const t = table.incomeTax;
  const annual = (grossCents / 100) * periodsPerYear;
  const allowance = coAllowance != null ? +coAllowance : t.annualAllowance[filing];
  const taxable = Math.max(0, annual - allowance);
  const annualTax = taxable * t.rate;
  const per = annualTax / periodsPerYear;
  const cents = c(per);
  return {
    cents,
    explain: [
      `Annualize: ${$(grossCents)} x ${periodsPerYear} = ${d$(annual)}`,
      `Allowance: ${d$(allowance)} (${coAllowance != null ? 'DR 0004 amount' : `default for W-4 status "${filing}"`})`,
      `Taxable ${d$(taxable)} x ${(t.rate * 100).toFixed(2)}% = ${d$(r2(annualTax))} per year`,
      `/ ${periodsPerYear} = ${$(cents)} this period`,
    ],
  };
}

/** One employee's pay-run line. */
export function payLine({ person, totals, rateCents, otMultiplier = 1.5, periodsPerYear = 26, ytdWagesCents = 0, org, tables }) {
  const { us, co } = tables;
  const unverified = !us.verified || !co.verified;
  const gross = grossPay({ rateCents, regularMin: totals.regularMin, overtimeMin: totals.overtimeMin, restPremiumMin: totals.restPremiumMin, otMultiplier });
  const g = gross.cents;
  const f = fica({ grossCents: g, ytdWagesCents, table: us });
  const fed = federalWithholding({ grossCents: g, periodsPerYear, w4: person.w4 || {}, table: us });
  const st = coloradoWithholding({ grossCents: g, periodsPerYear, w4: person.w4 || {}, coAllowance: person.coAllowance ?? null, table: co });
  const famliCap = c(us.fica.socialSecurityWageBase);
  const famliWages = Math.max(0, Math.min(g, famliCap - ytdWagesCents));
  const famliEe = Math.round(famliWages * co.famli.employeeRate);
  const smallEmployer = (org.employeeCount ?? 0) < co.famli.smallEmployerThreshold;
  const famliEr = smallEmployer ? 0 : Math.round(famliWages * co.famli.employerRate);
  const futaBase = c(us.futa.wageBase);
  const futaWages = Math.max(0, Math.min(g, futaBase - ytdWagesCents));
  const futa = org.futaExempt ? 0 : Math.round(futaWages * us.futa.rate);
  const sutaBase = c(org.sutaWageBase ?? co.suta.wageBase);
  const sutaRate = org.sutaRate ?? co.suta.defaultRate;
  const sutaWages = Math.max(0, Math.min(g, sutaBase - ytdWagesCents));
  const suta = Math.round(sutaWages * sutaRate);

  const taxes = [
    { code: 'federal_income', label: 'Federal income tax (estimate)', cents: fed.cents, explain: fed.explain },
    { code: 'social_security', label: 'Social Security', cents: f.socialSecurity.cents, explain: f.socialSecurity.explain },
    { code: 'medicare', label: 'Medicare', cents: f.medicare.cents, explain: f.medicare.explain },
    { code: 'co_income', label: 'Colorado income tax (estimate)', cents: st.cents, explain: st.explain },
    { code: 'co_famli', label: 'Colorado FAMLI (employee)', cents: famliEe, explain: [`${$(famliWages)} x ${(co.famli.employeeRate * 100).toFixed(2)}% = ${$(famliEe)}`] },
  ];
  const employer = [
    { code: 'social_security', label: 'Employer Social Security', cents: f.employerSocialSecurity.cents, explain: f.employerSocialSecurity.explain },
    { code: 'medicare', label: 'Employer Medicare', cents: f.employerMedicare.cents, explain: f.employerMedicare.explain },
    { code: 'co_famli', label: 'Colorado FAMLI (employer)', cents: famliEr, explain: [smallEmployer ? `Fewer than ${co.famli.smallEmployerThreshold} employees (${org.employeeCount}): no employer share` : `${org.employeeCount} employees (>= ${co.famli.smallEmployerThreshold}): ${$(famliWages)} x ${(co.famli.employerRate * 100).toFixed(2)}% = ${$(famliEr)}`] },
    { code: 'futa', label: 'FUTA', cents: futa, explain: [org.futaExempt ? 'Org is marked FUTA-exempt (501(c)(3)): $0.00' : `${$(futaWages)} (first ${d$(us.futa.wageBase)}) x ${(us.futa.rate * 100).toFixed(1)}% = ${$(futa)}`] },
    { code: 'co_suta', label: 'Colorado unemployment (SUTA)', cents: suta, explain: [`${$(sutaWages)} (wage base ${$(sutaBase)}, YTD ${$(ytdWagesCents)}) x ${(sutaRate * 100).toFixed(2)}% = ${$(suta)}`] },
  ];
  const withheld = taxes.reduce((s, t) => s + t.cents, 0);
  const net = g - withheld;
  const employerTotal = employer.reduce((s, t) => s + t.cents, 0);
  const explain = [
    ...gross.explain,
    `Employee taxes withheld: ${taxes.map((t) => `${t.label} ${$(t.cents)}`).join(', ')} = ${$(withheld)}`,
    `Net = ${$(g)} - ${$(withheld)} = ${$(net)}`,
    `Employer cost on top of gross: ${$(employerTotal)}`,
    ...(unverified ? ['PROTOTYPE: tax tables are unverified estimates; this line cannot be finalized.'] : []),
  ];
  return {
    personId: person.id, name: person.name,
    hours: { regular: +(totals.regularMin / 60).toFixed(2), overtime: +(totals.overtimeMin / 60).toFixed(2), restPremium: +(totals.restPremiumMin / 60).toFixed(2) },
    rateCents,
    gross: g, grossDetail: { regular: gross.regularCents, overtime: gross.overtimeCents, restPremium: gross.restPremiumCents },
    taxes, withheld, net, employer, employerTotal, explain,
    unverified, canFinalize: false,
  };
}
