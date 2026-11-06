// Organizations hosted on the Kea Hub: tables. Applied by mountOrgs() on the Hub's own database.
//
// Never here: payroll data. No SSNs, bank details, tax forms or pay runs. Those stay in the payroll vault on the
// payroll admin's own PC. Cost rates are kept only to estimate labor cost against budgets.
export const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'private',
  tz TEXT NOT NULL DEFAULT 'America/Denver', state TEXT, workweek_start INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  settings TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  department_id TEXT, title TEXT, birthdate TEXT, cost_rate INTEGER,
  desired_min REAL, desired_max REAL, usual_week TEXT NOT NULL DEFAULT '{}', prefs TEXT NOT NULL DEFAULT '[]',
  joined_at INTEGER NOT NULL, via_code TEXT,
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX IF NOT EXISTS org_members_account ON org_members(account_id);
CREATE TABLE IF NOT EXISTS org_member_positions (
  org_id TEXT NOT NULL, account_id TEXT NOT NULL, position_id TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id, position_id),
  FOREIGN KEY (org_id, account_id) REFERENCES org_members(org_id, account_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS org_codes (
  code TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','member')), label TEXT,
  department_id TEXT, position_id TEXT, needs_approval INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_codes_org ON org_codes(org_id);
CREATE TABLE IF NOT EXISTS org_departments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  parent_id TEXT, name TEXT NOT NULL, cost_center_id TEXT, location_id TEXT, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS org_positions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, department_id TEXT, tags TEXT NOT NULL DEFAULT '[]', cost_rate INTEGER, color TEXT
);
CREATE TABLE IF NOT EXISTS org_locations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, address TEXT
);
CREATE TABLE IF NOT EXISTS org_cost_centers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_budgets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount INTEGER NOT NULL, label TEXT NOT NULL DEFAULT 'Original', note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_cert_types (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, valid_months INTEGER, positions TEXT NOT NULL DEFAULT '[]', warn_days TEXT NOT NULL DEFAULT '[60,30,7]'
);
CREATE TABLE IF NOT EXISTS org_certs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, type_id TEXT NOT NULL, issued_on TEXT NOT NULL, expires_on TEXT,
  source TEXT NOT NULL DEFAULT 'manual', class_id TEXT, note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_certs_person ON org_certs(org_id, account_id);
-- An org class is a Hub class (classes table) that belongs to the org; finishing it can issue an org cert.
CREATE TABLE IF NOT EXISTS org_classes (
  class_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, cert_type_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_class_assignments (
  class_id TEXT NOT NULL, account_id TEXT NOT NULL, org_id TEXT NOT NULL, due_on TEXT, assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL, completed_on TEXT, cert_id TEXT,
  PRIMARY KEY (class_id, account_id)
);
CREATE TABLE IF NOT EXISTS org_block_sets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position_id TEXT, blocks TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_forms (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  deadline_at INTEGER, blocks TEXT NOT NULL DEFAULT '[]', exceptions TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '{}', audience TEXT NOT NULL DEFAULT '{}', minor_note TEXT,
  reminders TEXT NOT NULL DEFAULT '[72,24,0]', allow_changes INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE INDEX IF NOT EXISTS org_forms_org ON org_forms(org_id, period_start);
CREATE TABLE IF NOT EXISTS org_responses (
  form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}', date_notes TEXT NOT NULL DEFAULT '{}', note TEXT,
  desired_min REAL, desired_max REAL, days_off TEXT, extra TEXT NOT NULL DEFAULT '{}',
  submitted_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, account_id)
);
CREATE TABLE IF NOT EXISTS org_response_changes (
  id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  proposal TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_nudges (
  form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (form_id, account_id)
);
CREATE TABLE IF NOT EXISTS org_schedules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  form_id TEXT, title TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  need_overrides TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_shifts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, schedule_id TEXT,
  account_id TEXT, position_id TEXT NOT NULL, department_id TEXT, location_id TEXT,
  date TEXT NOT NULL, block_id TEXT, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  source TEXT NOT NULL DEFAULT 'manual', note TEXT, forced INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_shifts_sched ON org_shifts(schedule_id);
CREATE INDEX IF NOT EXISTS org_shifts_person ON org_shifts(org_id, account_id, start_at);
CREATE TABLE IF NOT EXISTS org_drafts (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES org_schedules(id) ON DELETE CASCADE,
  source TEXT NOT NULL, summary TEXT, shifts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','applied','discarded')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_swaps (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, shift_id TEXT NOT NULL,
  from_account TEXT NOT NULL, to_account TEXT, claimant TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','claimed','approved','denied','cancelled')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_policies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, url TEXT, due_on TEXT, audience TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_policy_acks (
  policy_id TEXT NOT NULL REFERENCES org_policies(id) ON DELETE CASCADE, account_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (policy_id, account_id)
);
CREATE TABLE IF NOT EXISTS org_todo_snoozes (
  account_id TEXT NOT NULL, item_key TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (account_id, item_key)
);
`;
