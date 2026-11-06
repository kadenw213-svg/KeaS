// Switching to KeaS mid-year: import people, year-to-date amounts and time-off balances from CSV exports
// (Gusto, ADP, Paychex, QuickBooks or any spreadsheet). Columns are matched by name and the match can be changed
// before anything is saved.
import { csvObjects } from '../lib/csv.mjs';
import { isValidRouting } from '../lib/nacha.mjs';
import { validSsn } from './paystructure.mjs';
import { balance } from './leave.mjs';
import { zonedToUtc } from '../lib/time.mjs';

export const SOURCES = ['gusto', 'adp', 'paychex', 'quickbooks', 'other'];
const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Field -> header names seen in common payroll exports (normalized: lower case, letters and digits only).
const MATCH = {
  employees: {
    name: ['name', 'employeename', 'fullname', 'employee', 'displayname', 'workername'],
    firstName: ['firstname', 'first', 'legalfirstname', 'employeefirstname', 'givenname'],
    lastName: ['lastname', 'last', 'legallastname', 'employeelastname', 'surname', 'familyname'],
    email: ['email', 'workemail', 'personalemail', 'emailaddress', 'employeeemail'],
    employeeNumber: ['employeeid', 'employeenumber', 'employeeno', 'empid', 'fileno', 'filenumber', 'associateid', 'positionid', 'id'],
    ssn: ['ssn', 'socialsecuritynumber', 'taxid', 'ssnitin', 'employeessn', 'socialsecurity'],
    birthdate: ['birthdate', 'dateofbirth', 'dob', 'birthday'],
    hireDate: ['hiredate', 'startdate', 'dateofhire', 'originalhiredate', 'employmentstartdate'],
    payRate: ['payrate', 'rate', 'hourlyrate', 'regularrate', 'basepayrate', 'rate1', 'regularpayrate', 'compensation', 'annualsalary', 'salary', 'payamount'],
    payType: ['paytype', 'compensationtype', 'paybasis', 'regularpaytype', 'payfrequencytype', 'salaryorhourly', 'flsastatus'],
    filingStatus: ['filingstatus', 'federalfilingstatus', 'w4filingstatus', 'fedfilingstatus', 'federalmaritalstatus'],
    address1: ['address', 'address1', 'street', 'streetaddress', 'homeaddress', 'addressline1', 'homeaddressline1', 'street1'],
    address2: ['address2', 'addressline2', 'street2', 'apt', 'suite'],
    city: ['city', 'homecity'],
    state: ['state', 'homestate', 'province', 'stateprovince', 'residentstate'],
    zip: ['zip', 'zipcode', 'postalcode', 'homezip', 'postcode'],
    phone: ['phone', 'phonenumber', 'mobilephone', 'cellphone', 'homephone'],
    routing: ['routingnumber', 'routing', 'aba', 'bankroutingnumber', 'transitnumber', 'routingno'],
    account: ['accountnumber', 'account', 'bankaccountnumber', 'accountno'],
    accountType: ['accounttype', 'bankaccounttype', 'depositaccounttype'],
    department: ['department', 'dept', 'homedepartment', 'departmentname', 'team'],
  },
  ytd: {
    name: ['name', 'employeename', 'fullname', 'employee'], firstName: ['firstname', 'first'], lastName: ['lastname', 'last'],
    email: ['email', 'workemail', 'emailaddress'], employeeNumber: ['employeeid', 'employeenumber', 'empid', 'fileno', 'filenumber', 'associateid', 'id'], ssn: ['ssn', 'socialsecuritynumber'],
    gross: ['grosspay', 'gross', 'ytdgross', 'totalgross', 'grosswages', 'grossearnings', 'grosspayytd', 'totalearnings'],
    federal_income: ['federalincometax', 'federalwithholding', 'fit', 'fedwh', 'federalincometaxwithheld', 'fitw', 'federaltax', 'fedincometax'],
    social_security: ['socialsecurity', 'socialsecuritytax', 'oasdi', 'socialsecurityemployee', 'ssemployee', 'ssee', 'fica'],
    medicare: ['medicare', 'medicaretax', 'medicareemployee', 'medee', 'medicareee'],
    state_income: ['stateincometax', 'statewithholding', 'sit', 'statewh', 'statetax', 'stateincometaxwithheld'],
    state_famli: ['famli', 'statefamli', 'paidfamilyleave', 'familyleave', 'pfml', 'fli'],
    net: ['netpay', 'net', 'ytdnet', 'netpayytd'],
  },
  hours: {
    name: ['name', 'employeename', 'fullname', 'employee'], firstName: ['firstname', 'first'], lastName: ['lastname', 'last'],
    email: ['email', 'workemail'], employeeNumber: ['employeeid', 'employeenumber', 'empid', 'fileno', 'id'],
    date: ['date', 'workdate', 'day', 'shiftdate', 'punchdate'],
    hours: ['hours', 'totalhours', 'hoursworked', 'regularhours', 'duration', 'total'],
    start: ['in', 'start', 'starttime', 'clockin', 'timein', 'punchin'],
    end: ['out', 'end', 'endtime', 'clockout', 'timeout', 'punchout'],
    position: ['position', 'job', 'role', 'jobtitle', 'jobcode'],
  },
  pto: {
    name: ['name', 'employeename', 'fullname', 'employee'], firstName: ['firstname', 'first'], lastName: ['lastname', 'last'],
    email: ['email', 'workemail'], employeeNumber: ['employeeid', 'employeenumber', 'empid', 'fileno', 'id'],
    policy: ['policy', 'policyname', 'timeofftype', 'ptotype', 'plan', 'accrualtype', 'timeoffpolicy', 'leavetype', 'type'],
    hours: ['balance', 'hours', 'available', 'remaining', 'balancehours', 'availablehours', 'currentbalance'],
  },
};
export const KINDS = Object.keys(MATCH);

export function guessMapping(kind, headers) {
  const m = {};
  const used = new Set();
  for (const [field, names] of Object.entries(MATCH[kind])) {
    for (const want of names) {
      const hdr = headers.find((x) => !used.has(x) && n(x) === want) || (want.length > 4 && headers.find((x) => !used.has(x) && n(x).includes(want)));
      if (hdr) { m[field] = hdr; used.add(hdr); break; }
    }
  }
  return m;
}

/** "$1,234.56" / "(12.00)" / "1234.5" -> cents (or null). */
export function parseMoney(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const x = Number(s.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(x) ? Math.round((neg ? -x : x) * 100) : NaN;
}
/** 2026-03-01, 3/1/2026, 03/01/26 -> YYYY-MM-DD (or null). */
/** "9:00", "17:30", "5:30 PM" -> "HH:MM" (or null). */
export function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  let hh = Number(m[1]);
  if (m[3]) { const pm = /p/i.test(m[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
  return hh < 24 && Number(m[2]) < 60 ? `${String(hh).padStart(2, '0')}:${m[2]}` : null;
}
export function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? (Number(m[3]) > 50 ? '19' : '20') + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return NaN;
}

function readRow(kind, row, mapping) {
  const get = (f) => (mapping[f] ? row[mapping[f]] ?? '' : '');
  let name = get('name');
  if (name && name.includes(',') && !get('firstName')) { const [last, first] = name.split(',').map((x) => x.trim()); name = `${first} ${last}`; }
  if (!name) name = [get('firstName'), get('lastName')].filter(Boolean).join(' ');
  const out = { name: name.trim(), email: get('email').toLowerCase() || null, employeeNumber: get('employeeNumber') || null, ssn: get('ssn').replace(/\D/g, '') || null };
  const problems = [];
  if (!out.name && !out.employeeNumber && !out.email) problems.push('no name, employee number or email');
  if (kind === 'employees') {
    Object.assign(out, { birthdate: parseDate(get('birthdate')), hireDate: parseDate(get('hireDate')), payRate: parseMoney(get('payRate')), payType: /sal|exempt|annual/i.test(get('payType')) ? 'salary' : get('payType') ? 'hourly' : null, filing: /married|joint/i.test(get('filingStatus')) ? 'married' : /head/i.test(get('filingStatus')) ? 'hoh' : get('filingStatus') ? 'single' : null, address: get('address1') ? { line1: get('address1'), line2: get('address2'), city: get('city'), state: get('state'), zip: get('zip') } : null, phone: get('phone') || null, routing: get('routing').replace(/\D/g, '') || null, account: get('account').replace(/\s/g, '') || null, accountType: /sav/i.test(get('accountType')) ? 'savings' : 'checking', department: get('department') || null });
    if (out.payType == null && out.payRate != null) out.payType = out.payRate > 1000000 ? 'salary' : 'hourly';
    for (const k of ['birthdate', 'hireDate']) if (Number.isNaN(out[k])) { problems.push(`${k} isn’t a date`); out[k] = null; }
    if (Number.isNaN(out.payRate)) { problems.push('pay rate isn’t a number'); out.payRate = null; }
    if (out.ssn && !validSsn(out.ssn)) { problems.push('SSN isn’t valid (skipped)'); out.ssn = null; }
    if (out.routing && !isValidRouting(out.routing)) { problems.push('routing number isn’t valid (bank skipped)'); out.routing = null; }
    if (!out.name) problems.push('no name');
  } else if (kind === 'ytd') {
    out.amounts = {};
    for (const f of ['gross', 'federal_income', 'social_security', 'medicare', 'state_income', 'state_famli', 'net']) {
      const v = parseMoney(get(f));
      if (Number.isNaN(v)) problems.push(`${f} isn’t a number`); else if (v != null) out.amounts[f] = v;
    }
    if (out.amounts.gross == null) problems.push('no gross amount');
  } else if (kind === 'hours') {
    out.date = parseDate(get('date'));
    if (!out.date || Number.isNaN(out.date)) { problems.push('no date'); out.date = null; }
    out.start = parseTime(get('start'));
    out.end = parseTime(get('end'));
    const hrs = get('hours') === '' ? null : Number(String(get('hours')).replace(/[^\d.]/g, ''));
    out.hours = hrs;
    if (out.start == null && out.hours == null) problems.push('give hours, or in and out times');
    if (out.hours != null && !(out.hours > 0 && out.hours <= 24)) problems.push('hours must be between 0 and 24');
    out.position = get('position') || null;
  } else if (kind === 'pto') {
    out.policy = get('policy');
    out.hours = Number(String(get('hours')).replace(/[^\d.-]/g, ''));
    if (!out.policy) problems.push('no policy name');
    if (!Number.isFinite(out.hours) || get('hours') === '') problems.push('hours isn’t a number');
  }
  return { ...out, problems };
}

export function registerImport(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, now, iso, today } = c;
  const prep = (body) => {
    const kind = V.enum(body.kind, 'kind', KINDS);
    const source = V.enum(body.source ?? 'other', 'source', SOURCES);
    let parsed;
    try { parsed = csvObjects(V.str(body.csv, 'csv', { min: 1, max: 20 * 1024 * 1024 })); } catch (e) { bad(`That CSV couldn’t be read: ${e.message}`); }
    if (!parsed.rows.length) bad('the CSV has no rows under the header line');
    const mapping = body.mapping && typeof body.mapping === 'object' ? Object.fromEntries(Object.entries(body.mapping).filter(([f, hdr]) => MATCH[kind][f] && parsed.headers.includes(hdr))) : guessMapping(kind, parsed.headers);
    return { kind, source, parsed, mapping, rows: parsed.rows.map((r) => readRow(kind, r, mapping)) };
  };
  const findPerson = (orgId, r) => {
    const all = h.all('SELECT * FROM people WHERE org_id = ?', orgId);
    return (r.employeeNumber && all.find((p) => p.employee_number === r.employeeNumber))
      || (r.email && all.find((p) => (p.email || '').toLowerCase() === r.email))
      || (r.ssn && all.find((p) => vault.openJson(p.pii_enc)?.ssn === r.ssn))
      || (r.name && all.find((p) => p.name.toLowerCase() === r.name.toLowerCase() || (p.legal_name || '').toLowerCase() === r.name.toLowerCase()))
      || null;
  };

  route('POST', '/v1/import/preview', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = prep(body);
    const rows = p.rows.map((r) => ({ ...r, ssn: r.ssn ? `***-**-${r.ssn.slice(5)}` : null, account: r.account ? `…${r.account.slice(-4)}` : null, match: findPerson(org.id, r)?.id ?? null }));
    return { kind: p.kind, source: p.source, headers: p.parsed.headers, mapping: p.mapping, fields: Object.keys(MATCH[p.kind]), count: rows.length, withProblems: rows.filter((r) => r.problems.length).length, matched: rows.filter((r) => r.match).length, rows: rows.slice(0, 50) };
  }, { maxBody: 21 * 1024 * 1024 });

  route('POST', '/v1/import/commit', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = prep(body);
    const result = { created: 0, updated: 0, skipped: 0, errors: [] };
    const year = Number(body.year ?? today(org).slice(0, 4));
    const asOf = V.date(body.asOf ?? today(org), 'asOf');
    h.tx(() => {
      p.rows.forEach((r, i) => {
        const blocking = r.problems.filter((x) => !/skipped/.test(x));
        if (blocking.length) { result.skipped++; result.errors.push({ row: i + 2, problems: r.problems }); return; }
        let person = findPerson(org.id, r);
        if (person && person.id === me.id && !me.roles.includes('owner') && p.kind !== 'hours') { result.skipped++; result.errors.push({ row: i + 2, problems: ['this row is you: your own pay, deposit and year-to-date amounts are changed by the owner'] }); return; }
        if (p.kind === 'employees') {
          let deptId = null;
          if (r.department) {
            deptId = h.get('SELECT id FROM departments WHERE org_id = ? AND lower(name) = lower(?)', org.id, r.department)?.id;
            if (!deptId) { deptId = uid('dp'); h.run('INSERT INTO departments (id,org_id,name) VALUES (?,?,?)', deptId, org.id, r.department); }
          }
          const fields = { name: r.name, email: r.email, employeeNumber: r.employeeNumber, birthdate: r.birthdate, hireDate: r.hireDate, ...(r.filing ? { w4: { filing: r.filing } } : {}), pii: { ...(r.ssn ? { ssn: r.ssn } : {}), ...(r.address ? { address: r.address } : {}), ...(r.phone ? { phone: r.phone } : {}) } };
          for (const k of Object.keys(fields)) if (fields[k] == null) delete fields[k];
          if (!person) {
            const np = c.createPerson(org, me, { ...fields, status: 'active', payRateCents: r.payRate, payKind: r.payType || 'hourly' });
            person = h.get('SELECT * FROM people WHERE id = ?', np.id);
            result.created++;
          } else {
            const cur = c.getPerson(person.id, org.id);
            c.writePersonSets(person.id, c.applyProfile(cur, { ...fields, w4: fields.w4 ? { ...cur.w4, ...fields.w4, filing: fields.w4.filing } : undefined }, me, org));
            if (r.payRate != null && !h.get('SELECT 1 FROM pay_rates WHERE person_id = ? AND position_id IS NULL', person.id)) h.run('INSERT INTO pay_rates (id,person_id,position_id,kind,rate_cents,effective_from,label,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid('rt'), person.id, null, r.payType || 'hourly', r.payRate, r.hireDate || asOf, 'Imported', me.id, iso(now()));
            result.updated++;
          }
          if (deptId) h.run('UPDATE people SET department_id = ? WHERE id = ?', deptId, person.id);
          if (r.routing && r.account) h.run('UPDATE people SET deposit = ? WHERE id = ?', vault.sealJson({ accounts: [{ routing: r.routing, account: r.account, accountType: r.accountType, remainder: true }] }), person.id);
          if (r.payRate != null && (r.payType || 'hourly') === 'hourly') h.run('UPDATE people SET pay_rate_cents = COALESCE(pay_rate_cents, ?) WHERE id = ?', r.payRate, person.id);
        } else if (!person) { result.skipped++; result.errors.push({ row: i + 2, problems: [`no match for ${r.name || r.employeeNumber || r.email}`] }); return; }
        else if (p.kind === 'ytd') {
          h.run('DELETE FROM ytd_imports WHERE person_id = ? AND year = ? AND source = ?', person.id, year, p.source);
          const st = org.state.toLowerCase();
          for (const [code, cents] of Object.entries(r.amounts)) h.run('INSERT INTO ytd_imports (person_id,year,as_of,code,cents,source,created_at) VALUES (?,?,?,?,?,?,?)', person.id, year, asOf, code === 'state_income' ? `${st}_income` : code === 'state_famli' ? `${st}_famli` : code, cents, p.source, iso(now()));
          h.run('UPDATE people SET ytd_wages_cents = ?, ytd_year = ? WHERE id = ?', r.amounts.gross, year, person.id);
          result.updated++;
        } else if (p.kind === 'hours') {
          // Hours worked become a shift and an in/out punch pair (source "import"), so they go through timecards,
          // overtime, differentials and approvals like clocked time.
          const pos = r.position ? h.get('SELECT id FROM positions WHERE org_id = ? AND (lower(name) = lower(?) OR id = ?)', org.id, r.position, r.position)?.id : null;
          let positionId = pos || (!r.position && (JSON.parse(person.positions || '[]')[0] || h.get('SELECT id FROM positions WHERE org_id = ? ORDER BY name LIMIT 1', org.id)?.id));
          if (!positionId) { positionId = uid('pos'); h.run(`INSERT INTO positions (id,org_id,name,tags) VALUES (?,?,?,'[]')`, positionId, org.id, r.position || 'Staff'); }
          const startMs = zonedToUtc(r.date, r.start || '09:00', org.tz);
          let endMs = r.end ? zonedToUtc(r.date, r.end, org.tz) : startMs + Math.round(r.hours * 60) * 60000;
          if (endMs <= startMs) endMs += 86400000;
          const key = `import:${person.id}:${new Date(startMs).toISOString()}`;
          if (h.get('SELECT 1 FROM punches WHERE source = ?', key)) { result.skipped++; return; }
          const sid = uid('s');
          h.run(`INSERT INTO shifts (id,org_id,position_id,person_id,start,"end",status,note) VALUES (?,?,?,?,?,?,'published',?)`, sid, org.id, positionId, person.id, new Date(startMs).toISOString(), new Date(endMs).toISOString(), `Hours imported from ${p.source}`);
          for (const [type, ms] of [['in', startMs], ['out', endMs]]) h.run('INSERT INTO punches (id,person_id,shift_id,type,at,source,rest_attested,created_at) VALUES (?,?,?,?,?,?,?,?)', uid('pu'), person.id, sid, type, new Date(ms).toISOString(), key, 1, iso(now()));
          result.updated++;
        } else if (p.kind === 'pto') {
          const pol = h.get('SELECT * FROM pto_policies WHERE org_id = ? AND lower(name) = lower(?)', org.id, r.policy);
          if (!pol) { result.skipped++; result.errors.push({ row: i + 2, problems: [`no time-off policy named “${r.policy}”`] }); return; }
          h.run('INSERT OR IGNORE INTO pto_enrollments (person_id, policy_id, start_date) VALUES (?,?,?)', person.id, pol.id, asOf);
          const delta = Math.round((r.hours - balance(h, person.id, pol.id)) * 100) / 100;
          if (delta) h.run(`INSERT INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,'import',NULL,?,?,?)`, person.id, pol.id, asOf, delta, `Balance imported from ${p.source} (${r.hours} h as of ${asOf})`, me.id, iso(now()));
          result.updated++;
        }
      });
    });
    audit(org.id, me.id, 'import', p.kind, { source: p.source, ...result, errors: result.errors.length });
    return result;
  }, { maxBody: 21 * 1024 * 1024 });
}
