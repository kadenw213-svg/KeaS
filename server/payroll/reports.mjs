// Reporting: the payroll register, tax liability, labor distribution (with budgets), and a custom report builder
// (pick a dataset, fields, filters, group-by; save it; download CSV). SSNs and bank details are never report fields.
import { toCsv } from '../lib/csv.mjs';
import { byName } from '../db.mjs';
import { dayNum, addDays } from '../lib/time.mjs';
import { policiesFor, balance } from './leave.mjs';
import { rateFor } from './paystructure.mjs';

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const dollars = (c) => (c / 100).toFixed(2);

export function registerReports(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, now, iso, today } = c;
  const names = (orgId) => ({
    person: new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', orgId).map((r) => [r.id, r.name])),
    dept: new Map(h.all('SELECT id, name FROM departments WHERE org_id = ?', orgId).map((r) => [r.id, r.name])),
    cc: new Map(h.all('SELECT id, code, name FROM cost_centers WHERE org_id = ?', orgId).map((r) => [r.id, `${r.code} ${r.name}`])),
    entity: new Map(h.all('SELECT id, name FROM legal_entities WHERE org_id = ?', orgId).map((r) => [r.id, r.name])),
    position: new Map(h.all('SELECT id, name FROM positions WHERE org_id = ?', orgId).map((r) => [r.id, r.name])),
  });
  /** Lines for the register: a period (finalized or preview), or every finalized run with a pay date in [from, to]. */
  function lines(org, { periodStart, from, to }) {
    if (periodStart) { const p = c.parsePeriod(org, periodStart, null); const r = c.runLines(org, p); return { finalized: r.finalized, lines: r.lines.map((l) => ({ ...l, payDate: r.payDate, periodStart: p.start })) }; }
    const rows = h.all(`SELECT l.detail, r.pay_date, r.period_start FROM payrun_lines l JOIN payruns r ON r.id = l.run_id WHERE r.org_id = ? AND r.status = 'finalized' AND r.pay_date >= ? AND r.pay_date <= ? ORDER BY r.pay_date`, org.id, from, to);
    return { finalized: true, lines: rows.map((r) => ({ ...J(r.detail, {}), payDate: r.pay_date, periodStart: r.period_start })) };
  }
  const rangeOf = (org, q) => {
    if (q.periodStart) return { periodStart: q.periodStart };
    const y = Number(q.year || today(org).slice(0, 4));
    if (q.quarter) { const qn = Number(q.quarter); if (!(qn >= 1 && qn <= 4)) bad('quarter must be 1-4'); const m = (qn - 1) * 3 + 1; return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: addDays(`${qn === 4 ? y + 1 : y}-${String(qn === 4 ? 1 : m + 3).padStart(2, '0')}-01`, -1) }; }
    return { from: V.date(q.from ?? `${y}-01-01`, 'from'), to: V.date(q.to ?? `${y}-12-31`, 'to') };
  };
  const csvOut = (name, headers, rows) => ({ raw: { type: 'text/csv; charset=utf-8', filename: `${name}.csv`, body: toCsv(headers, rows) } });

  route('GET', '/v1/reports/register', async ({ me, org, query }) => {
    need(me, 'payroll');
    if (query.periodStart) await c.loadEngine?.(org, c.parsePeriod(org, query.periodStart, null));
    const { finalized, lines: ls } = lines(org, rangeOf(org, query));
    const codes = [...new Set(ls.flatMap((l) => (l.taxes || []).map((t) => t.code)))];
    const ercodes = [...new Set(ls.flatMap((l) => (l.employer || []).map((t) => t.code)))];
    const n = names(org.id);
    const rows = ls.map((l) => ({
      payDate: l.payDate, periodStart: l.periodStart, personId: l.personId, name: l.name, entity: n.entity.get(l.entityId) || '', department: n.dept.get(l.departmentId) || '',
      regularHours: l.hours?.regular ?? 0, overtimeHours: l.hours?.overtime ?? 0, gross: l.gross,
      ...Object.fromEntries(codes.map((cd) => [`tax_${cd}`, (l.taxes || []).find((t) => t.code === cd)?.cents ?? 0])),
      withheld: l.withheld, reimbursements: l.nonTaxable || 0, net: l.net,
      ...Object.fromEntries(ercodes.map((cd) => [`employer_${cd}`, (l.employer || []).find((t) => t.code === cd)?.cents ?? 0])),
      employerTotal: l.employerTotal,
    }));
    const moneyCols = ['gross', 'withheld', 'reimbursements', 'net', 'employerTotal', ...codes.map((x) => `tax_${x}`), ...ercodes.map((x) => `employer_${x}`)];
    const totals = Object.fromEntries(moneyCols.map((k) => [k, rows.reduce((a, r) => a + (r[k] || 0), 0)]));
    if (query.format === 'csv') { const headers = Object.keys(rows[0] || { payDate: '' }); return csvOut('payroll-register', headers, rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, moneyCols.includes(k) ? dollars(v) : v])))); }
    return { finalized, rows, totals, taxCodes: codes, employerCodes: ercodes };
  });

  route('GET', '/v1/reports/tax-liability', async ({ me, org, query }) => {
    need(me, 'payroll');
    if (query.periodStart) await c.loadEngine?.(org, c.parsePeriod(org, query.periodStart, null));
    const range = rangeOf(org, query);
    const { finalized, lines: ls } = lines(org, range);
    const by = new Map();
    for (const l of ls) {
      for (const [side, list] of [['employee', l.taxes || []], ['employer', l.employer || []]]) for (const t of list) {
        const k = `${t.code}`;
        const r = by.get(k) || { code: t.code, label: t.label.replace(/^Employer /, '').replace(/ \((employee|employer)\)$/, ''), employee: 0, employer: 0 };
        r[side] += t.cents; by.set(k, r);
      }
    }
    const byDate = new Map();
    for (const l of ls) { const d = byDate.get(l.payDate) || { payDate: l.payDate, employee: 0, employer: 0 }; d.employee += l.withheld; d.employer += l.employerTotal; byDate.set(l.payDate, d); }
    const rows = [...by.values()].map((r) => ({ ...r, total: r.employee + r.employer }));
    if (query.format === 'csv') return csvOut('tax-liability', ['code', 'label', 'employee', 'employer', 'total'], rows.map((r) => ({ ...r, employee: dollars(r.employee), employer: dollars(r.employer), total: dollars(r.total) })));
    return { finalized, range, rows, byPayDate: [...byDate.values()], total: rows.reduce((a, r) => a + r.total, 0), note: 'Deposit schedules and due dates depend on your deposit schedule and state; KeaS shows the amounts.' };
  });

  route('GET', '/v1/reports/labor-distribution', async ({ me, org, query }) => {
    need(me, 'manager', 'payroll');
    if (query.periodStart) await c.loadEngine?.(org, c.parsePeriod(org, query.periodStart, null));
    const range = rangeOf(org, query);
    const { finalized, lines: ls } = lines(org, range);
    const n = names(org.id);
    const by = new Map();
    for (const l of ls) {
      const dist = l.distribution?.length ? l.distribution : [{ departmentId: l.departmentId, costCenterId: null, program: null, hours: (l.hours?.regular || 0) + (l.hours?.overtime || 0), cents: l.gross }];
      const total = dist.reduce((a, d) => a + d.cents, 0) || 1;
      for (const d of dist) {
        const k = `${d.departmentId}|${d.costCenterId}|${d.program}`;
        const r = by.get(k) || { departmentId: d.departmentId, department: n.dept.get(d.departmentId) || '(no department)', costCenterId: d.costCenterId, costCenter: n.cc.get(d.costCenterId) || '', program: d.program || '', hours: 0, wages: 0, employerTaxes: 0 };
        r.hours += d.hours; r.wages += d.cents; r.employerTaxes += Math.round((l.employerTotal * d.cents) / total); by.set(k, r);
      }
    }
    const rows = [...by.values()].map((r) => ({ ...r, hours: +r.hours.toFixed(2), cost: r.wages + r.employerTaxes }));
    // Approved budgets overlapping the range, prorated by days.
    const span = range.periodStart ? (() => { const p = c.parsePeriod(org, range.periodStart, null); return { from: p.start, to: p.end }; })() : { from: range.from, to: range.to };
    for (const r of rows) {
      const bs = h.all(`SELECT * FROM budgets WHERE org_id = ? AND status = 'approved' AND (department_id IS ? OR (cost_center_id IS NOT NULL AND cost_center_id IS ?)) AND period_start <= ? AND period_end >= ?`, org.id, r.departmentId, r.costCenterId, span.to, span.from);
      if (!bs.length) continue;
      r.budget = bs.reduce((a, b) => {
        const s = b.period_start > span.from ? b.period_start : span.from, e = b.period_end < span.to ? b.period_end : span.to;
        return a + Math.round((b.amount_cents * (dayNum(e) - dayNum(s) + 1)) / (dayNum(b.period_end) - dayNum(b.period_start) + 1));
      }, 0);
      r.variance = r.budget - r.cost;
    }
    if (query.format === 'csv') return csvOut('labor-distribution', ['department', 'costCenter', 'program', 'hours', 'wages', 'employerTaxes', 'cost', 'budget', 'variance'], rows.map((r) => ({ ...r, wages: dollars(r.wages), employerTaxes: dollars(r.employerTaxes), cost: dollars(r.cost), budget: r.budget != null ? dollars(r.budget) : '', variance: r.variance != null ? dollars(r.variance) : '' })));
    return { finalized, range, rows };
  });

  // ---------- custom report builder ----------
  const DATASETS = {
    people: {
      label: 'People', fields: { name: 'text', status: 'text', workerType: 'text', department: 'text', entity: 'text', manager: 'text', positions: 'text', hireDate: 'date', termDate: 'date', rate: 'money', rateKind: 'text', grade: 'text', employeeNumber: 'text' },
      rows(org) {
        const n = names(org.id), grades = new Map(h.all('SELECT id, code FROM pay_grades WHERE org_id = ?', org.id).map((r) => [r.id, r.code]));
        return byName(h.all('SELECT id, name FROM people WHERE org_id = ?', org.id)).map((r) => c.getPerson(r.id, org.id)).map((p) => {
          const rt = rateFor(h, p, null, today(org));
          return { name: p.name, status: p.status, workerType: p.workerType, department: n.dept.get(p.departmentId) || '', entity: n.entity.get(p.entityId) || '', manager: n.person.get(p.managerId) || '', positions: p.positions.map((x) => n.position.get(x) || x).join(', '), hireDate: p.hireDate || '', termDate: p.termDate || '', rate: rt?.cents ?? null, rateKind: rt?.kind || '', grade: grades.get(p.gradeId) || '', employeeNumber: p.employeeNumber || '' };
        });
      },
    },
    pay: {
      label: 'Pay (finalized runs)', fields: { payDate: 'date', periodStart: 'date', name: 'text', department: 'text', entity: 'text', regularHours: 'number', overtimeHours: 'number', gross: 'money', withheld: 'money', net: 'money', employerTotal: 'money', federalIncome: 'money', socialSecurity: 'money', medicare: 'money', stateIncome: 'money', reimbursements: 'money' },
      rows(org, spec) {
        const n = names(org.id);
        const { lines: ls } = lines(org, { from: spec.from || '0000-01-01', to: spec.to || '9999-12-31' });
        const tax = (l, f) => (l.taxes || []).filter(f).reduce((a, t) => a + t.cents, 0);
        return ls.map((l) => ({ payDate: l.payDate, periodStart: l.periodStart, name: l.name, department: n.dept.get(l.departmentId) || '', entity: n.entity.get(l.entityId) || '', regularHours: l.hours?.regular ?? 0, overtimeHours: l.hours?.overtime ?? 0, gross: l.gross, withheld: l.withheld, net: l.net, employerTotal: l.employerTotal, federalIncome: tax(l, (t) => t.code === 'federal_income'), socialSecurity: tax(l, (t) => t.code === 'social_security'), medicare: tax(l, (t) => t.code === 'medicare'), stateIncome: tax(l, (t) => /_income$/.test(t.code) && t.code !== 'federal_income'), reimbursements: l.nonTaxable || 0 }));
      },
    },
    time: {
      label: 'Hours worked (finalized runs)', fields: { date: 'date', name: 'text', position: 'text', hours: 'number', overtimeHours: 'number', rate: 'money', department: 'text' },
      rows(org, spec) {
        const n = names(org.id);
        const { lines: ls } = lines(org, { from: spec.from || '0000-01-01', to: spec.to || '9999-12-31' });
        return ls.flatMap((l) => (l.segments || []).map((s) => ({ date: s.date, name: l.name, position: n.position.get(s.positionId) || '', hours: +(s.minutes / 60).toFixed(2), overtimeHours: +((s.otMin || 0) / 60).toFixed(2), rate: s.rateCents, department: n.dept.get(l.departmentId) || '' })));
      },
    },
    timeoff: {
      label: 'Time-off balances', fields: { name: 'text', policy: 'text', kind: 'text', hours: 'number' },
      rows(org) { return byName(h.all(`SELECT id, name FROM people WHERE org_id = ? AND status != 'terminated'`, org.id)).map((r) => c.getPerson(r.id, org.id)).flatMap((p) => policiesFor(h, p).map((pol) => ({ name: p.name, policy: pol.name, kind: pol.kind, hours: balance(h, p.id, pol.id) }))); },
    },
    expenses: {
      label: 'Expenses', fields: { date: 'date', name: 'text', kind: 'text', category: 'text', status: 'text', amount: 'money', miles: 'number' },
      rows(org) { const n = names(org.id); return h.all('SELECT * FROM expenses WHERE org_id = ? ORDER BY date', org.id).map((e) => ({ date: e.date, name: n.person.get(e.person_id) || '', kind: e.kind, category: e.category, status: e.status, amount: e.amount_cents, miles: e.miles ?? null })); },
    },
  };
  const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'];
  // Pay amounts in reports: payroll and the owner, or managers when the owner has turned that on (org setting).
  const PAY_DATASETS = ['pay', 'time'], PAY_FIELDS = { people: ['rate', 'rateKind'] };
  /** The datasets and fields this person may report on. */
  function visible(me, org) {
    const pay = c.seesPay(me, org);
    return Object.fromEntries(Object.entries(DATASETS).filter(([k]) => pay || !PAY_DATASETS.includes(k)).map(([k, d]) => [k, { ...d, fields: Object.fromEntries(Object.entries(d.fields).filter(([f]) => pay || !(PAY_FIELDS[k] || []).includes(f))) }]));
  }
  function runSpec(org, spec, me) {
    const ds = visible(me, org)[spec.dataset];
    if (!ds) { if (DATASETS[spec.dataset]) throw new HttpError(403, 'Pay amounts in reports are for payroll (or managers the owner allows).'); bad(`dataset must be one of ${Object.keys(DATASETS).join(', ')}`); }
    const fields = Array.isArray(spec.fields) && spec.fields.length ? spec.fields : Object.keys(ds.fields);
    for (const f of fields) if (!ds.fields[f]) bad(`unknown field ${f}`);
    const filters = Array.isArray(spec.filters) ? spec.filters : [];
    for (const f of filters) { if (!ds.fields[f.field]) bad(`unknown filter field ${f.field}`); if (!OPS.includes(f.op)) bad(`op must be one of ${OPS.join(', ')}`); }
    const groupBy = Array.isArray(spec.groupBy) ? spec.groupBy : [];
    for (const g of groupBy) if (!ds.fields[g]) bad(`unknown group-by field ${g}`);
    const num = (t) => t === 'money' || t === 'number';
    const cmpVal = (field, v) => (ds.fields[field] === 'money' ? Math.round(Number(v) * 100) : num(ds.fields[field]) ? Number(v) : String(v ?? '').toLowerCase());
    let rows = DATASETS[spec.dataset].rows(org, spec).filter((r) => filters.every((f) => {
      const a = num(ds.fields[f.field]) ? Number(r[f.field] ?? 0) : String(r[f.field] ?? '').toLowerCase();
      if (f.op === 'in') return String(f.value).split(',').map((x) => cmpVal(f.field, x.trim())).includes(a);
      const b = cmpVal(f.field, f.value);
      return f.op === 'eq' ? a === b : f.op === 'ne' ? a !== b : f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : f.op === 'lte' ? a <= b : String(a).includes(String(b));
    }));
    let cols = fields;
    if (groupBy.length) {
      const sums = fields.filter((f) => num(ds.fields[f]) && !groupBy.includes(f));
      const map = new Map();
      for (const r of rows) {
        const k = JSON.stringify(groupBy.map((g) => r[g]));
        const g = map.get(k) || { ...Object.fromEntries(groupBy.map((x) => [x, r[x]])), count: 0, ...Object.fromEntries(sums.map((s) => [s, 0])) };
        g.count++; for (const s of sums) g[s] += Number(r[s] || 0); map.set(k, g);
      }
      rows = [...map.values()];
      cols = [...groupBy, 'count', ...sums];
    } else rows = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    if (spec.sort?.field && cols.includes(spec.sort.field)) { const k = spec.sort.field, d = spec.sort.desc ? -1 : 1; rows.sort((a, b) => (a[k] > b[k] ? d : a[k] < b[k] ? -d : 0)); }
    const types = Object.fromEntries(cols.map((k) => [k, k === 'count' ? 'number' : ds.fields[k]]));
    return { columns: cols, types, rows: rows.slice(0, 20000), truncated: rows.length > 20000 };
  }
  route('GET', '/v1/reports/fields', ({ me, org }) => { need(me, 'manager', 'payroll'); return { datasets: Object.fromEntries(Object.entries(visible(me, org)).map(([k, d]) => [k, { label: d.label, fields: d.fields }])), ops: OPS }; });
  route('POST', '/v1/reports/run', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const r = runSpec(org, body, me);
    if (body.format === 'csv') return csvOut(String(body.name || 'report').replace(/[^\w-]+/g, '-').slice(0, 60) || 'report', r.columns, r.rows.map((row) => Object.fromEntries(r.columns.map((k) => [k, r.types[k] === 'money' && row[k] != null ? dollars(row[k]) : row[k]]))));
    return r;
  });
  route('GET', '/v1/reports/saved', ({ me, org }) => { need(me, 'manager', 'payroll'); return { reports: h.all('SELECT * FROM saved_reports WHERE org_id = ? ORDER BY name', org.id).map((r) => ({ id: r.id, name: r.name, spec: J(r.spec, {}), createdAt: r.created_at })) }; });
  route('POST', '/v1/reports/saved', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const name = V.str(body.name, 'name', { min: 1, max: 80 });
    runSpec(org, { ...body.spec, from: '9999-01-01', to: '9999-01-01' }, me); // validates the spec cheaply
    const id = body.id ? V.id(body.id, 'id') : uid('rp');
    h.run('INSERT INTO saved_reports (id,org_id,name,spec,created_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec', id, org.id, name, JSON.stringify(body.spec), me.id, iso(now()));
    audit(org.id, me.id, 'report_save', id, { name });
    return { id };
  });
  route('POST', '/v1/reports/saved/:id/delete', ({ me, org, params }) => { need(me, 'manager', 'payroll'); h.run('DELETE FROM saved_reports WHERE id = ? AND org_id = ?', params.id, org.id); return { ok: true }; });
}
