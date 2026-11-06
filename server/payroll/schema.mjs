// Payroll and HR tables. Columns ending in _enc hold sealed (AES-256-GCM) values; see server/lib/vault.mjs.
export const PAYROLL_SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vault_users (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), email TEXT NOT NULL UNIQUE, hub_sub TEXT,
  local_pw TEXT, created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS legal_entities (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, ein TEXT, state TEXT,
  address TEXT NOT NULL DEFAULT '{}', bank_enc TEXT, state_ids TEXT NOT NULL DEFAULT '{}', is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cost_centers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), code TEXT NOT NULL, name TEXT NOT NULL, gl_segment TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), parent_id TEXT REFERENCES departments(id), name TEXT NOT NULL,
  code TEXT, cost_center_id TEXT REFERENCES cost_centers(id), entity_id TEXT REFERENCES legal_entities(id), head_person_id TEXT, location TEXT
);
CREATE TABLE IF NOT EXISTS shift_allocations (shift_id TEXT PRIMARY KEY REFERENCES shifts(id), splits TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, department_id TEXT, cost_center_id TEXT, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, label TEXT, status TEXT NOT NULL DEFAULT 'draft',
  approval_id TEXT, created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_rates (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), position_id TEXT, kind TEXT NOT NULL DEFAULT 'hourly',
  rate_cents INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, label TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_rates_person ON pay_rates(person_id, effective_from);
CREATE TABLE IF NOT EXISTS differentials (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL,
  days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]', start_min INTEGER NOT NULL DEFAULT 0, end_min INTEGER NOT NULL DEFAULT 1440,
  position_ids TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pay_grades (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hourly',
  min_cents INTEGER NOT NULL, mid_cents INTEGER, max_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS raises (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, position_id TEXT, kind TEXT NOT NULL DEFAULT 'hourly',
  old_rate_cents INTEGER, new_rate_cents INTEGER NOT NULL, effective_date TEXT NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, approval_id TEXT, created_at TEXT NOT NULL, applied_at TEXT, retro_cents INTEGER
);
CREATE TABLE IF NOT EXISTS extra_earnings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL,
  cents INTEGER NOT NULL, hours REAL, taxable INTEGER NOT NULL DEFAULT 1, source TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending', paid_run_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payruns (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'finalized', finalized_by TEXT, finalized_at TEXT, totals TEXT NOT NULL, tables TEXT NOT NULL, approval_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payruns_period ON payruns(org_id, period_start) WHERE status = 'finalized';
CREATE TABLE IF NOT EXISTS payrun_lines (
  run_id TEXT NOT NULL REFERENCES payruns(id), person_id TEXT NOT NULL, entity_id TEXT, gross INTEGER NOT NULL, net INTEGER NOT NULL,
  withheld INTEGER NOT NULL, employer_total INTEGER NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (run_id, person_id)
);
CREATE TABLE IF NOT EXISTS ytd_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, year INTEGER NOT NULL, as_of TEXT NOT NULL, code TEXT NOT NULL,
  cents INTEGER NOT NULL, source TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pto_policies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pto', method TEXT NOT NULL DEFAULT 'per_hour_worked',
  accrue_hours REAL NOT NULL DEFAULT 0, per_hours REAL NOT NULL DEFAULT 0, per_period_hours REAL NOT NULL DEFAULT 0, annual_hours REAL NOT NULL DEFAULT 0,
  cap_hours REAL, annual_max_hours REAL, carryover_max REAL, waiting_days INTEGER NOT NULL DEFAULT 0, allow_negative INTEGER NOT NULL DEFAULT 0,
  payout_on_term TEXT NOT NULL DEFAULT 'state_rule', protected INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 1, auto_enroll INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pto_enrollments (person_id TEXT NOT NULL, policy_id TEXT NOT NULL, start_date TEXT NOT NULL, PRIMARY KEY (person_id, policy_id));
CREATE TABLE IF NOT EXISTS pto_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, policy_id TEXT NOT NULL, date TEXT NOT NULL, hours REAL NOT NULL,
  kind TEXT NOT NULL, ref TEXT, note TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pto_ledger_ref ON pto_ledger(person_id, policy_id, ref) WHERE ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS time_off_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, policy_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  hours REAL NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', approval_id TEXT, leave_case_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holiday_calendars (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS holidays (
  id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES holiday_calendars(id), date TEXT NOT NULL, name TEXT NOT NULL,
  paid_hours REAL NOT NULL DEFAULT 8, premium_multiplier REAL NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS leave_cases (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, law TEXT NOT NULL, reason TEXT NOT NULL, start_date TEXT NOT NULL,
  end_date TEXT, intermittent INTEGER NOT NULL DEFAULT 0, entitlement_hours REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  notes TEXT, eligibility TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leave_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES leave_cases(id), date TEXT NOT NULL, hours REAL NOT NULL, note TEXT);

CREATE TABLE IF NOT EXISTS approval_chains (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, steps TEXT NOT NULL,
  min_amount_cents INTEGER, department_id TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, requested_by TEXT NOT NULL, subject_person_id TEXT,
  title TEXT NOT NULL, detail TEXT, amount_cents INTEGER, chain_id TEXT, steps TEXT NOT NULL, step_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS approval_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES approval_requests(id), step_index INTEGER NOT NULL,
  actor TEXT NOT NULL, decision TEXT NOT NULL, comment TEXT, at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, doc_kind TEXT NOT NULL, doc_id TEXT NOT NULL, typed_name TEXT NOT NULL,
  signed_at TEXT NOT NULL, content_hash TEXT NOT NULL, witnessed_by TEXT, method TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, title TEXT NOT NULL, position_id TEXT, kind TEXT NOT NULL DEFAULT 'hourly',
  rate_cents INTEGER NOT NULL, start_date TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', signature_id TEXT,
  approval_id TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, kind TEXT NOT NULL, data_enc TEXT NOT NULL, signature_id TEXT,
  created_at TEXT NOT NULL, superseded_at TEXT
);
CREATE TABLE IF NOT EXISTS i9_records (
  person_id TEXT PRIMARY KEY, section1_signature_id TEXT, section1_at TEXT, section2_enc TEXT, section2_by TEXT, section2_at TEXT,
  reverify_date TEXT, status TEXT NOT NULL DEFAULT 'not_started'
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_acks (
  policy_id TEXT NOT NULL, version INTEGER NOT NULL, person_id TEXT NOT NULL, signature_id TEXT NOT NULL, PRIMARY KEY (policy_id, version, person_id)
);
CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, due TEXT,
  status TEXT NOT NULL DEFAULT 'open', done_by TEXT, done_at TEXT, ref TEXT
);
CREATE TABLE IF NOT EXISTS offboarding (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, kind TEXT NOT NULL, last_day TEXT NOT NULL, notice_date TEXT NOT NULL,
  final_pay_due TEXT, final_pay_rule TEXT, pto_payout TEXT, cobra TEXT, checklist TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT, created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT, category TEXT NOT NULL, title TEXT NOT NULL, filename TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, content_enc TEXT NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL,
  retain_until TEXT, legal_hold INTEGER NOT NULL DEFAULT 0, signature_id TEXT, needs_signature INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS retention_rules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, category TEXT NOT NULL, years_after_created REAL, years_after_termination REAL, note TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT, amount_cents INTEGER NOT NULL, miles REAL, rate_cents_per_mile INTEGER, receipt_id TEXT, status TEXT NOT NULL DEFAULT 'draft',
  approval_id TEXT, earning_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_reports (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS contractor_payments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, date TEXT NOT NULL, cents INTEGER NOT NULL, memo TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aca_months (
  person_id TEXT NOT NULL, year INTEGER NOT NULL, month INTEGER NOT NULL, offer_code TEXT, contribution_cents INTEGER, safe_harbor TEXT,
  PRIMARY KEY (person_id, year, month)
);

CREATE TABLE IF NOT EXISTS job_posts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, position_id TEXT, department_id TEXT, description TEXT NOT NULL,
  pay_min_cents INTEGER, pay_max_cents INTEGER, status TEXT NOT NULL DEFAULT 'open', questions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES job_posts(id), name TEXT NOT NULL, email TEXT, phone TEXT,
  answers TEXT NOT NULL DEFAULT '{}', stage TEXT NOT NULL DEFAULT 'applied', notes TEXT NOT NULL DEFAULT '[]', person_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), at TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 30,
  interviewers TEXT NOT NULL DEFAULT '[]', location TEXT, feedback TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS review_cycles (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, questions TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES review_cycles(id), person_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
  self_answers TEXT NOT NULL DEFAULT '{}', manager_answers TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open', shared_at TEXT, acknowledged_signature_id TEXT
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, due TEXT, progress INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, person_id TEXT NOT NULL, manager_id TEXT NOT NULL, date TEXT NOT NULL, notes TEXT NOT NULL,
  private_notes TEXT, created_at TEXT NOT NULL
);
`;

// Columns added to the original workforce tables.
const ADD_COLUMNS = {
  orgs: [['settings', "TEXT NOT NULL DEFAULT '{}'"]],
  people: [
    ['hire_date', 'TEXT'], ['term_date', 'TEXT'], ['department_id', 'TEXT'], ['entity_id', 'TEXT'], ['manager_id', 'TEXT'],
    ['grade_id', 'TEXT'], ['worker_type', "TEXT NOT NULL DEFAULT 'employee'"], ['employee_number', 'TEXT'],
    ['default_allocations', "TEXT NOT NULL DEFAULT '[]'"], ['pii_enc', 'TEXT'], ['holiday_calendar_id', 'TEXT'],
    ['ytd_year', 'INTEGER'], ['legal_name', 'TEXT'],
  ],
};

export function migratePayroll(db) {
  db.exec(PAYROLL_SCHEMA);
  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Values sealed as they're written: pay amounts, birthdates and personal emails. A trigger seals each one on insert or
 * update (keas_seal, with the vault's key), and the database layer opens them as they're read, so the code using them
 * sees plain numbers and text. Nothing filters or sums these in SQL. [table, columns]
 */
export const SEALED_VALUES = [
  ['people', ['pay_rate_cents', 'birthdate', 'email', 'ytd_wages_cents']],
  ['pay_rates', ['rate_cents']],
  ['raises', ['old_rate_cents', 'new_rate_cents', 'retro_cents']],
  ['offers', ['rate_cents']],
  ['payrun_lines', ['gross', 'net', 'withheld', 'employer_total', 'detail']],
];
/** Column names whose sealed values are opened when read (a plain value in a same-named column is left alone). */
export const SEALED_VALUE_NAMES = [...new Set(SEALED_VALUES.flatMap(([, cols]) => cols))];
const notSealed = (v) => `${v} IS NOT NULL AND NOT (typeof(${v}) = 'text' AND substr(${v}, 1, 3) = 'v1.')`;
/** The triggers that seal SEALED_VALUES as they're written. */
export function sealTriggersSql() {
  const out = [];
  for (const [table, cols] of SEALED_VALUES) for (const col of cols) {
    const body = `BEGIN UPDATE ${table} SET ${col} = keas_seal(NEW.${col}) WHERE rowid = NEW.rowid; END;`;
    out.push(`CREATE TRIGGER IF NOT EXISTS seal_${table}_${col}_ins AFTER INSERT ON ${table} WHEN ${notSealed(`NEW.${col}`)} ${body}`);
    out.push(`CREATE TRIGGER IF NOT EXISTS seal_${table}_${col}_upd AFTER UPDATE OF ${col} ON ${table} WHEN ${notSealed(`NEW.${col}`)} ${body}`);
  }
  return out.join('\n');
}

/** Columns the code seals itself (JSON or text blobs). [table, key column, sealed column] */
export const SEALED_TEXT_COLUMNS = [
  ['people', 'id', 'deposit'],
  ['people', 'id', 'pii_enc'],
  ['orgs', 'id', 'bank'],
  ['legal_entities', 'id', 'bank_enc'],
  ['form_submissions', 'id', 'data_enc'],
  ['i9_records', 'person_id', 'section2_enc'],
  ['documents', 'id', 'content_enc'],
];
/** Every sealed column, so changing the passphrase can re-encrypt all of them. [table, key column, sealed column] */
export const SEALED_COLUMNS = [...SEALED_TEXT_COLUMNS, ...SEALED_VALUES.flatMap(([table, cols]) => cols.map((col) => [table, 'rowid', col]))];
