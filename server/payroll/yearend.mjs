// Year-end: W-2 and 1099-NEC data (CSV for filing software, PDF summaries for people), and ACA 1095-C monthly codes.
// Built from finalized pay runs plus amounts imported for the part of the year before KeaS.
import { toCsv } from '../lib/csv.mjs';
import { simplePdf } from '../lib/pdf.mjs';
import { pairPunches } from '../lib/rules.mjs';
import { localDate } from '../lib/time.mjs';

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const dollars = (c) => (c / 100).toFixed(2);
/** SSN/TIN for an export: the last 4 only, unless full numbers were asked for explicitly (fullSsn=1). */
const ssnFor = (ssn, full) => (!ssn ? '' : full ? ssn : `***-**-${String(ssn).slice(-4)}`);
const FULL_SSN_WARNING = 'This file has full Social Security numbers. Keep it in the KeaS payroll folder or your filing software, never email it, and delete it once it’s filed.';
const m$ = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function registerYearEnd(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, now, iso, today } = c;
  const yearOf = (org, q) => { const y = Number(q.year ?? Number(today(org).slice(0, 4)) - (today(org).slice(5, 7) < '07' ? 1 : 0)); if (!(y >= 2000 && y <= 2100)) bad('year must be a year'); return y; };

  function w2Data(org, year, entityId = null) {
    const T = c.tablesFor(org.state, year);
    const st = org.state.toLowerCase();
    const ssBase = Math.round((T.us?.fica?.socialSecurityWageBase ?? 0) * 100);
    const ents = new Map(h.all('SELECT * FROM legal_entities WHERE org_id = ?', org.id).map((e) => [e.id, e]));
    const defEnt = h.get('SELECT id FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC LIMIT 1', org.id)?.id ?? null;
    const acc = new Map(); // personId|entityId -> sums
    const get = (pid, eid) => { const k = `${pid}|${eid}`; if (!acc.has(k)) acc.set(k, { personId: pid, entityId: eid, gross: 0, codes: {}, stateWages: 0, imported: false }); return acc.get(k); };
    for (const r of h.all(`SELECT l.person_id, l.entity_id, l.detail FROM payrun_lines l JOIN payruns r ON r.id = l.run_id WHERE r.org_id = ? AND r.status = 'finalized' AND substr(r.pay_date,1,4) = ?`, org.id, String(year))) {
      const d = J(r.detail, {});
      const a = get(r.person_id, r.entity_id || defEnt);
      a.gross += d.gross;
      for (const t of d.taxes || []) a.codes[t.code] = (a.codes[t.code] || 0) + t.cents;
      if ((d.taxes || []).some((t) => t.code === `${st}_income`)) a.stateWages += d.gross;
    }
    for (const r of h.all('SELECT y.*, p.entity_id FROM ytd_imports y JOIN people p ON p.id = y.person_id WHERE p.org_id = ? AND y.year = ?', org.id, year)) {
      const a = get(r.person_id, r.entity_id || defEnt);
      a.imported = true;
      if (r.code === 'gross') { a.gross += r.cents; a.stateWages += r.cents; } else if (r.code !== 'net') a.codes[r.code] = (a.codes[r.code] || 0) + r.cents;
    }
    const out = [];
    for (const a of acc.values()) {
      if (entityId && a.entityId !== entityId) continue;
      const p = c.getPerson(a.personId, org.id), e = ents.get(a.entityId);
      const pii = vault.openJson(p.piiRaw) || {};
      out.push({
        personId: p.id, name: p.legalName || p.name, ssn: pii.ssn || null, address: pii.address || null,
        employer: { entityId: e?.id ?? null, name: e?.name || org.name, ein: e?.ein || null, address: J(e?.address, {}), stateId: J(e?.state_ids, {})[org.state] || null },
        box1: a.gross, box2: a.codes.federal_income || 0, box3: Math.min(a.gross, ssBase || a.gross), box4: a.codes.social_security || 0, box5: a.gross, box6: a.codes.medicare || 0,
        box14: a.codes[`${st}_famli`] ? [{ label: `${org.state} FAMLI`, cents: a.codes[`${st}_famli`] }] : [],
        state: org.state, box16: a.codes[`${st}_income`] != null ? a.stateWages : 0, box17: a.codes[`${st}_income`] || 0,
        imported: a.imported,
        problems: [!pii.ssn && 'no SSN', !pii.address?.line1 && 'no address', !e?.ein && 'employer has no EIN'].filter(Boolean),
      });
    }
    return { year, rows: out.sort((x, y) => x.name.localeCompare(y.name)), tablesVerified: T.verified, note: 'Box 1 equals gross pay: KeaS has no pre-tax deductions yet. Check every row before filing.' };
  }

  route('GET', '/v1/yearend/w2', ({ me, org, query }) => {
    need(me, 'payroll');
    const year = yearOf(org, query);
    const d = w2Data(org, year, query.entityId || null);
    const rows = query.personId ? d.rows.filter((r) => r.personId === query.personId) : d.rows;
    if (query.format === 'csv') {
      // Full SSNs only when asked for explicitly (filing software needs them); otherwise the last 4.
      const full = query.fullSsn === '1';
      audit(org.id, me.id, 'w2_export', String(year), { rows: rows.length, fullSsn: full });
      const headers = ['employerEin', 'employerName', 'employeeSsn', 'employeeName', 'address1', 'city', 'state', 'zip', 'box1Wages', 'box2FederalTax', 'box3SsWages', 'box4SsTax', 'box5MedicareWages', 'box6MedicareTax', 'box14', 'box15State', 'box15StateId', 'box16StateWages', 'box17StateTax'];
      return { raw: { type: 'text/csv; charset=utf-8', filename: `w2-${year}${full ? '-FULL-SSN' : ''}.csv`, warning: full ? FULL_SSN_WARNING : null, body: toCsv(headers, rows.map((r) => ({ employerEin: r.employer.ein || '', employerName: r.employer.name, employeeSsn: ssnFor(r.ssn, full), employeeName: r.name, address1: r.address?.line1 || '', city: r.address?.city || '', state: r.address?.state || '', zip: r.address?.zip || '', box1Wages: dollars(r.box1), box2FederalTax: dollars(r.box2), box3SsWages: dollars(r.box3), box4SsTax: dollars(r.box4), box5MedicareWages: dollars(r.box5), box6MedicareTax: dollars(r.box6), box14: r.box14.map((x) => `${x.label} ${dollars(x.cents)}`).join('; '), box15State: r.state, box15StateId: r.employer.stateId || '', box16StateWages: dollars(r.box16), box17StateTax: dollars(r.box17) }))) } };
    }
    if (query.format === 'pdf') {
      const L = [];
      rows.forEach((r, i) => {
        L.push({ text: `W-2 wage and tax summary ${year}`, size: 15, bold: true, gap: i ? 30 : 0 });
        L.push({ text: `${r.employer.name}${r.employer.ein ? ` - EIN ${r.employer.ein}` : ''}`, size: 10 });
        L.push({ text: `${r.name} - SSN ${r.ssn ? `***-**-${r.ssn.slice(5)}` : 'missing'}`, size: 11, bold: true, gap: 4 });
        if (r.address) L.push({ text: [r.address.line1, r.address.city, r.address.state, r.address.zip].filter(Boolean).join(', '), size: 9 });
        for (const [label, v] of [['1 Wages, tips, other compensation', r.box1], ['2 Federal income tax withheld', r.box2], ['3 Social Security wages', r.box3], ['4 Social Security tax withheld', r.box4], ['5 Medicare wages and tips', r.box5], ['6 Medicare tax withheld', r.box6], [`16 ${r.state} wages`, r.box16], [`17 ${r.state} income tax`, r.box17], ...r.box14.map((x) => [`14 ${x.label}`, x.cents])]) L.push({ text: label, right: m$(v) });
        L.push({ text: 'This summary lists the amounts for the W-2. The official form is filed with the SSA.', size: 8, gap: 4 });
      });
      return { raw: { type: 'application/pdf', filename: `w2-${year}.pdf`, body: simplePdf({ title: `W-2 ${year}`, lines: L.length ? L : [{ text: 'No wages for this year.' }] }) } };
    }
    return { ...d, rows: rows.map((r) => ({ ...r, ssn: r.ssn ? `***-**-${r.ssn.slice(5)}` : null })) };
  });

  // ---------- contractors and 1099-NEC ----------
  route('GET', '/v1/contractor-payments', ({ me, org, query }) => {
    need(me, 'payroll');
    const nm = new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', org.id).map((r) => [r.id, r.name]));
    const y = query.year ? String(query.year) : null;
    return { payments: h.all('SELECT * FROM contractor_payments WHERE org_id = ? ORDER BY date DESC', org.id).filter((r) => !y || r.date.startsWith(y)).map((r) => ({ id: r.id, personId: r.person_id, name: nm.get(r.person_id), date: r.date, cents: r.cents, memo: r.memo })) };
  });
  route('POST', '/v1/contractor-payments', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    c.notSelf(me, p.id);
    if (p.workerType !== 'contractor') bad(`${p.name} isn’t set up as a contractor`);
    const cents = Math.round(Number(body.cents));
    if (!(cents > 0)) bad('cents must be more than 0');
    const id = uid('cp');
    h.run('INSERT INTO contractor_payments (id,org_id,person_id,date,cents,memo,created_at) VALUES (?,?,?,?,?,?,?)', id, org.id, p.id, V.date(body.date, 'date'), cents, V.str(body.memo, 'memo', { optional: true, max: 200 }), iso(now()));
    audit(org.id, me.id, 'contractor_payment', id, { personId: p.id, cents });
    return { status: 201, body: { id } };
  });
  route('GET', '/v1/yearend/1099', ({ me, org, query }) => {
    need(me, 'payroll');
    const year = yearOf(org, query);
    const T = c.tablesFor(org.state, year);
    const threshold = T.us?.form1099?.necThresholdCents ?? null;
    const defEnt = h.get('SELECT * FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC LIMIT 1', org.id);
    // (Amounts are sealed, so they're added up here rather than in SQL.)
    const sums = new Map();
    for (const r of h.all('SELECT id, person_id, cents FROM contractor_payments WHERE org_id = ? AND substr(date,1,4) = ?', org.id, String(year))) {
      const t = sums.get(r.person_id) || { person_id: r.person_id, total: 0, n: 0 };
      t.total += Number(r.cents) || 0; t.n++; sums.set(r.person_id, t);
    }
    const rows = [...sums.values()].map((r) => {
      const p = c.getPerson(r.person_id, org.id), pii = vault.openJson(p.piiRaw) || {};
      return { personId: p.id, name: p.legalName || p.name, tin: pii.ssn || null, address: pii.address || null, box1: r.total, payments: r.n, meetsThreshold: threshold == null ? null : r.total >= threshold };
    });
    if (query.format === 'csv') {
      const full = query.fullSsn === '1';
      audit(org.id, me.id, '1099_export', String(year), { rows: rows.length, fullSsn: full });
      return { raw: { type: 'text/csv; charset=utf-8', filename: `1099-nec-${year}${full ? '-FULL-TIN' : ''}.csv`, warning: full ? FULL_SSN_WARNING : null, body: toCsv(['payerTin', 'payerName', 'recipientTin', 'recipientName', 'address1', 'city', 'state', 'zip', 'box1NonemployeeComp', 'meetsThreshold'], rows.map((r) => ({ payerTin: defEnt?.ein || '', payerName: defEnt?.name || org.name, recipientTin: ssnFor(r.tin, full), recipientName: r.name, address1: r.address?.line1 || '', city: r.address?.city || '', state: r.address?.state || '', zip: r.address?.zip || '', box1NonemployeeComp: dollars(r.box1), meetsThreshold: r.meetsThreshold == null ? '' : r.meetsThreshold ? 'yes' : 'no' }))) } };
    }
    if (query.format === 'pdf') {
      const L = [];
      rows.forEach((r, i) => { L.push({ text: `1099-NEC summary ${year}`, size: 15, bold: true, gap: i ? 30 : 0 }, { text: `Payer: ${defEnt?.name || org.name}${defEnt?.ein ? ` - TIN ${defEnt.ein}` : ''}` }, { text: `Recipient: ${r.name} - TIN ${r.tin ? `***-**-${r.tin.slice(5)}` : 'missing'}`, bold: true }, { text: '1 Nonemployee compensation', right: m$(r.box1) }); });
      return { raw: { type: 'application/pdf', filename: `1099-nec-${year}.pdf`, body: simplePdf({ title: `1099-NEC ${year}`, lines: L.length ? L : [{ text: 'No contractor payments this year.' }] }) } };
    }
    return { year, threshold, rows: rows.map((r) => ({ ...r, tin: r.tin ? `***-**-${r.tin.slice(5)}` : null })), note: threshold == null ? 'The 1099 threshold isn’t in the tax tables for this year; every contractor is listed.' : null };
  });

  // ---------- ACA 1095-C ----------
  function acaData(org, year) {
    const rule = c.rulesFor(org).aca || {};
    const ftHours = rule.fullTimeMonthlyHours ?? null;
    const people = h.all(`SELECT id FROM people WHERE org_id = ? AND worker_type = 'employee' AND (hire_date IS NULL OR hire_date <= ?) AND (term_date IS NULL OR term_date >= ?)`, org.id, `${year}-12-31`, `${year}-01-01`).map((r) => c.getPerson(r.id, org.id));
    return people.map((p) => {
      const ps = h.all('SELECT id, type, at FROM punches WHERE person_id = ? AND at >= ? AND at < ? ORDER BY at', p.id, `${year - 1}-12-31T00:00:00Z`, `${year + 1}-01-02T00:00:00Z`);
      const { pairs } = pairPunches(ps, { now: now() });
      const hours = Array(12).fill(0);
      for (const x of pairs) { const d = localDate(x.start, org.tz); if (d.startsWith(String(year))) hours[Number(d.slice(5, 7)) - 1] += (x.end - x.start) / 3600000; }
      const saved = new Map(h.all('SELECT * FROM aca_months WHERE person_id = ? AND year = ?', p.id, year).map((r) => [r.month, r]));
      const months = hours.map((hh, i) => {
        const m = i + 1, first = `${year}-${String(m).padStart(2, '0')}-01`, last = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
        const employed = (!p.hireDate || p.hireDate <= last) && (!p.termDate || p.termDate >= first);
        const ft = ftHours != null ? hh >= ftHours : null;
        const s = saved.get(m);
        return { month: m, hours: Math.round(hh * 10) / 10, employed, fullTime: ft, line14: s?.offer_code || (employed ? '1H' : '1H'), line15: s?.contribution_cents ?? null, line16: s?.safe_harbor || (!employed ? '2A' : ft === false ? '2B' : '') };
      });
      return { personId: p.id, name: p.legalName || p.name, months, fullTimeMonths: months.filter((x) => x.fullTime).length };
    });
  }
  route('GET', '/v1/yearend/aca', ({ me, org, query }) => {
    need(me, 'payroll');
    const year = yearOf(org, query);
    const rows = acaData(org, year);
    const rule = c.rulesFor(org).aca || {};
    if (query.format === 'csv') {
      const headers = ['name', ...Array.from({ length: 12 }, (_, i) => [`m${i + 1}_line14`, `m${i + 1}_line15`, `m${i + 1}_line16`]).flat()];
      return { raw: { type: 'text/csv; charset=utf-8', filename: `1095c-${year}.csv`, body: toCsv(headers, rows.map((r) => ({ name: r.name, ...Object.fromEntries(r.months.flatMap((m) => [[`m${m.month}_line14`, m.line14], [`m${m.month}_line15`, m.line15 == null ? '' : dollars(m.line15)], [`m${m.month}_line16`, m.line16]])) }))) } };
    }
    return { year, ale: org.settings.aca?.ale ?? null, fullTimeMonthlyHours: rule.fullTimeMonthlyHours ?? null, rows, note: 'Line 14 defaults to 1H (no offer) until you enter the offer codes. Line 16 fills 2A (not employed) and 2B (not full-time) from the hours KeaS has.' };
  });
  route('POST', '/v1/yearend/aca/months', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const year = Number(body.year);
    if (!(year >= 2015 && year <= 2100)) bad('year must be a year');
    if (!Array.isArray(body.months)) bad('months must be a list');
    for (const m of body.months) {
      const month = Number(m.month);
      if (!(month >= 1 && month <= 12)) bad('month must be 1-12');
      const code = m.offerCode ? String(m.offerCode).toUpperCase() : null;
      if (code && !/^1[A-Z]$/.test(code)) bad('offer codes look like 1A, 1E, 1H…');
      const sh = m.safeHarbor ? String(m.safeHarbor).toUpperCase() : null;
      if (sh && !/^2[A-Z]$/.test(sh)) bad('safe harbor codes look like 2A, 2C, 2H…');
      h.run('INSERT INTO aca_months (person_id,year,month,offer_code,contribution_cents,safe_harbor) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET offer_code = excluded.offer_code, contribution_cents = excluded.contribution_cents, safe_harbor = excluded.safe_harbor', p.id, year, month, code, m.contributionCents == null || m.contributionCents === '' ? null : Math.round(Number(m.contributionCents)), sh);
    }
    audit(org.id, me.id, 'aca_months', p.id, { year });
    return { ok: true };
  });
}
