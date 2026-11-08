// The org engine's tables, and the upgrade of databases made by earlier KeaS versions (migrateOrg).
//
// Never here: payroll details. No SSNs, bank details, tax forms or pay runs. Those stay in the payroll vault.
// Pay codes (a job's name and pay rate) are here, because people see and switch them on their own shifts and
// punches: each rate is sealed with the server's org data key (./paycodes.mjs), never stored in plain text.
// Cost rates are kept only to estimate labor cost against budgets. Time off keeps only its dates, kind and status
// (balances, reasons and pay stay in the vault).
//
// People are keyed by their Kea account id (account_id). Names and emails come from the sign-in system (the
// identity adapter), never from these tables, so the same engine works with the Kea Hub's accounts or with passes.
import { randomUUID } from 'node:crypto';
import { TEMPLATES, roleAbilities } from './roles.mjs';

export const ORG_SCHEMA_VERSION = 3;

export const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'private',
  tz TEXT NOT NULL DEFAULT 'America/Denver', state TEXT, workweek_start INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  settings TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
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
-- Roles: a name and a list of abilities (roles.mjs). Templates (Owner, Admin, Manager, Member) are made with every
-- organization; template_key says which one (owner/admin/manager/member, as KeaS 0.5 named the fixed roles).
CREATE TABLE IF NOT EXISTS org_roles (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, abilities TEXT NOT NULL DEFAULT '[]', template INTEGER NOT NULL DEFAULT 0, template_key TEXT,
  description TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_roles_org ON org_roles(org_id);
-- Who holds which role, and where: scope NULL is the whole organization, otherwise a JSON list of department ids
-- (each with every team under it).
CREATE TABLE IF NOT EXISTS org_role_assignments (
  org_id TEXT NOT NULL, account_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES org_roles(id) ON DELETE CASCADE,
  scope TEXT, assigned_by TEXT, assigned_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id, role_id),
  FOREIGN KEY (org_id, account_id) REFERENCES org_members(org_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS org_role_assignments_role ON org_role_assignments(role_id);
CREATE TABLE IF NOT EXISTS org_codes (
  code TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, role_scope TEXT, label TEXT,
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
-- An org class is a class of the host (the Kea Hub's classes table) that belongs to the org; finishing it can issue
-- an org cert. Only used when the host has classes (mountOrg's classes option).
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
  source TEXT NOT NULL DEFAULT 'manual', note TEXT, forced INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  pay_code_id TEXT
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
-- The time clock. Punches are append-only (a correction is a missed-punch request that, once approved, adds a punch);
-- the only way one goes is forgetting a whole account (forgetAccount), which lists it in org_erase first.
CREATE TABLE IF NOT EXISTS org_punches (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  shift_id TEXT, type TEXT NOT NULL CHECK (type IN ('in','out')), at INTEGER NOT NULL, source TEXT NOT NULL,
  rest_attested INTEGER, created_at INTEGER NOT NULL, pay_code_id TEXT
);
CREATE INDEX IF NOT EXISTS org_punches_person ON org_punches(org_id, account_id, at);
CREATE INDEX IF NOT EXISTS org_punches_shift ON org_punches(shift_id);
CREATE TABLE IF NOT EXISTS org_erase (account_id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS org_punches_no_update BEFORE UPDATE ON org_punches BEGIN SELECT RAISE(ABORT, 'punches are append-only'); END;
CREATE TRIGGER IF NOT EXISTS org_punches_no_delete BEFORE DELETE ON org_punches
  WHEN NOT EXISTS (SELECT 1 FROM org_erase WHERE account_id = OLD.account_id) AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id)
  BEGIN SELECT RAISE(ABORT, 'punches are append-only'); END;
CREATE TABLE IF NOT EXISTS org_punch_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  shift_id TEXT, type TEXT NOT NULL CHECK (type IN ('in','out')), at INTEGER NOT NULL, reason_code TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS org_punch_requests_org ON org_punch_requests(org_id, status);
CREATE TABLE IF NOT EXISTS org_timecard_approvals (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL, period_start TEXT NOT NULL,
  approved_by TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id, period_start)
);
-- Time off as the schedule needs it: who, which days (and hours, if part of a day), what kind, and whether it's
-- approved. Reasons, balances and pay stay in the payroll vault.
CREATE TABLE IF NOT EXISTS org_time_off (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  kind TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, hours REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS org_time_off_org ON org_time_off(org_id, start_date);
-- Pay codes: a job's pay rate (Lifeguard $15, Swim instructor $18). rate is sealed (AES-256-GCM with the server's
-- org data key, bound to the code's id), never plain text. department_id and position_id say where the code belongs
-- (optional). A code that was ever used is turned off (active = 0) rather than deleted.
CREATE TABLE IF NOT EXISTS org_pay_codes (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, rate TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hourly' CHECK (kind IN ('hourly')),
  color TEXT, active INTEGER NOT NULL DEFAULT 1, department_id TEXT, position_id TEXT,
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS org_pay_codes_org ON org_pay_codes(org_id);
-- A pay code's rate from a date on (org/paycodes.mjs): sealed with the org data key, bound to the code and the date.
CREATE TABLE IF NOT EXISTS org_pay_code_rates (
  code_id TEXT NOT NULL REFERENCES org_pay_codes(id) ON DELETE CASCADE, effective_from TEXT NOT NULL, rate TEXT NOT NULL,
  set_by TEXT, set_at INTEGER NOT NULL, PRIMARY KEY (code_id, effective_from)
);
-- Pay stubs published from the payroll vault when a pay run is finalized (org/stubs.mjs): one per member and run, the
-- whole stub sealed with a key only for that member (derived from the org data key and their account id).
CREATE TABLE IF NOT EXISTS org_stubs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL, body TEXT NOT NULL,
  published_by TEXT, published_at INTEGER NOT NULL, UNIQUE (org_id, run_id, account_id)
);
CREATE INDEX IF NOT EXISTS org_stubs_member ON org_stubs(org_id, account_id, pay_date);
-- Who was given which code; each person has at most one default.
CREATE TABLE IF NOT EXISTS org_member_pay_codes (
  org_id TEXT NOT NULL, account_id TEXT NOT NULL, code_id TEXT NOT NULL REFERENCES org_pay_codes(id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0, granted_by TEXT, granted_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id, code_id),
  FOREIGN KEY (org_id, account_id) REFERENCES org_members(org_id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS org_member_pay_codes_default ON org_member_pay_codes(org_id, account_id) WHERE is_default = 1;
-- A punch keeps the code it was made with (punches never change); switching it later is recorded here.
CREATE TABLE IF NOT EXISTS org_punch_codes (
  punch_id TEXT PRIMARY KEY REFERENCES org_punches(id) ON DELETE CASCADE, pay_code_id TEXT NOT NULL, set_by TEXT NOT NULL, set_at INTEGER NOT NULL
);
-- A shift given to someone gets their default code; a shift that changes hands keeps its code only when the new
-- person was given it too (otherwise their default). Shifts and punches from before pay codes have none: they're
-- paid at the person's default code (paycodes.mjs effective codes).
CREATE TRIGGER IF NOT EXISTS org_shifts_code_ins AFTER INSERT ON org_shifts WHEN NEW.account_id IS NOT NULL AND NEW.pay_code_id IS NULL
  BEGIN UPDATE org_shifts SET pay_code_id = (SELECT code_id FROM org_member_pay_codes WHERE org_id = NEW.org_id AND account_id = NEW.account_id AND is_default = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS org_shifts_code_acct AFTER UPDATE OF account_id ON org_shifts WHEN NEW.account_id IS NOT OLD.account_id
  BEGIN UPDATE org_shifts SET pay_code_id = CASE
    WHEN NEW.account_id IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM org_member_pay_codes WHERE org_id = NEW.org_id AND account_id = NEW.account_id AND code_id = NEW.pay_code_id) THEN NEW.pay_code_id
    ELSE (SELECT code_id FROM org_member_pay_codes WHERE org_id = NEW.org_id AND account_id = NEW.account_id AND is_default = 1) END
  WHERE id = NEW.id; END;
-- What a one-time import brought in (import.mjs), so running it again doesn't bring anything twice.
CREATE TABLE IF NOT EXISTS org_import_map (
  org_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, src_id TEXT NOT NULL, dst_id TEXT NOT NULL,
  PRIMARY KEY (org_id, source, kind, src_id)
);
`;

const cols = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** Adds the four template roles to an organization that doesn't have them yet. Returns key -> role id. */
export function seedTemplates(db, orgId, at) {
  const out = {};
  for (const t of TEMPLATES) {
    const have = db.prepare('SELECT id FROM org_roles WHERE org_id = ? AND template_key = ?').get(orgId, t.key);
    if (have) { out[t.key] = have.id; continue; }
    const id = randomUUID();
    db.prepare('INSERT INTO org_roles (id,org_id,name,abilities,template,template_key,created_at) VALUES (?,?,?,?,1,?,?)')
      .run(id, orgId, t.name, JSON.stringify(roleAbilities({ template: t.key, abilities: t.abilities })), t.key, at);
    out[t.key] = id;
  }
  return out;
}

/**
 * Brings the org tables of any earlier KeaS up to date, in place, and makes sure every organization has its template
 * roles. KeaS 0.5 (Kea Hub orgs) kept one fixed role per member (org_members.role) and per join code
 * (org_codes.role): each becomes the matching template, assigned to the whole organization. Returns what it did.
 */
export function migrateOrg(db, { now = Date.now() } = {}) {
  const report = { from: null, to: ORG_SCHEMA_VERSION, members: 0, codes: 0 };
  const legacy = hasTable(db, 'org_members') && cols(db, 'org_members').includes('role');
  const legacyCodes = hasTable(db, 'org_codes') && cols(db, 'org_codes').includes('role') && !cols(db, 'org_codes').includes('role_id');
  // Version 3: shifts and punches carry a pay code. (Added before the schema runs: its triggers name the column.)
  for (const t of ['org_shifts', 'org_punches']) if (hasTable(db, t) && !cols(db, t).includes('pay_code_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN pay_code_id TEXT`);
  const verBefore = hasTable(db, 'org_meta') ? Number(db.prepare("SELECT value FROM org_meta WHERE key = 'schema'").get()?.value || 0) : 0;
  db.exec(ORG_SCHEMA);
  const ver = Number(db.prepare("SELECT value FROM org_meta WHERE key = 'schema'").get()?.value || 0);
  report.from = legacy ? 1 : ver || ORG_SCHEMA_VERSION;
  if (legacy || legacyCodes) {
    // Rebuilding a table: foreign keys off for the copy (dropping the old org_members would otherwise delete every
    // row that points at it), checked once it's done.
    const fk = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      const roleIds = new Map();
      for (const o of db.prepare('SELECT id FROM orgs').all()) roleIds.set(o.id, seedTemplates(db, o.id, now));
      if (legacy) {
        const rows = db.prepare('SELECT * FROM org_members').all();
        db.exec(`CREATE TABLE org_members_v2 (
          org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
          department_id TEXT, title TEXT, birthdate TEXT, cost_rate INTEGER,
          desired_min REAL, desired_max REAL, usual_week TEXT NOT NULL DEFAULT '{}', prefs TEXT NOT NULL DEFAULT '[]',
          joined_at INTEGER NOT NULL, via_code TEXT, PRIMARY KEY (org_id, account_id))`);
        const ins = db.prepare('INSERT INTO org_members_v2 (org_id,account_id,status,department_id,title,birthdate,cost_rate,desired_min,desired_max,usual_week,prefs,joined_at,via_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const grant = db.prepare('INSERT OR IGNORE INTO org_role_assignments (org_id,account_id,role_id,scope,assigned_by,assigned_at) VALUES (?,?,?,NULL,?,?)');
        for (const r of rows) {
          ins.run(r.org_id, r.account_id, r.status, r.department_id, r.title, r.birthdate, r.cost_rate, r.desired_min, r.desired_max, r.usual_week ?? '{}', r.prefs ?? '[]', r.joined_at, r.via_code);
          const ids = roleIds.get(r.org_id);
          if (ids) grant.run(r.org_id, r.account_id, ids[r.role] ?? ids.member, 'upgrade', r.joined_at);
          report.members++;
        }
        db.exec('DROP TABLE org_members');
        db.exec('ALTER TABLE org_members_v2 RENAME TO org_members');
      }
      if (legacyCodes) {
        const rows = db.prepare('SELECT * FROM org_codes').all();
        db.exec(`CREATE TABLE org_codes_v2 (
          code TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL, role_scope TEXT, label TEXT, department_id TEXT, position_id TEXT, needs_approval INTEGER NOT NULL DEFAULT 0,
          max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
        const ins = db.prepare('INSERT INTO org_codes_v2 (code,org_id,role_id,role_scope,label,department_id,position_id,needs_approval,max_uses,uses,expires_at,revoked,created_by,created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)');
        for (const c of rows) {
          const ids = roleIds.get(c.org_id);
          if (!ids) continue;
          ins.run(c.code, c.org_id, ids[c.role] ?? ids.member, c.label, c.department_id, c.position_id, c.needs_approval, c.max_uses, c.uses, c.expires_at, c.revoked, c.created_by, c.created_at);
          report.codes++;
        }
        db.exec('DROP TABLE org_codes');
        db.exec('ALTER TABLE org_codes_v2 RENAME TO org_codes');
      }
      db.exec(ORG_SCHEMA); // the indexes on the rebuilt tables
      const broken = db.prepare('PRAGMA foreign_key_check').all().filter((r) => String(r.table).startsWith('org_'));
      if (broken.length) throw new Error(`The organization tables didn't upgrade cleanly (${broken.length} broken links in ${[...new Set(broken.map((b) => b.table))].join(', ')}). Nothing was changed.`);
      db.prepare("INSERT INTO org_meta (key,value) VALUES ('schema',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(ORG_SCHEMA_VERSION));
      db.prepare("INSERT INTO org_meta (key,value) VALUES ('upgraded',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ from: 1, at: now, members: report.members, codes: report.codes }));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      if (fk) db.exec('PRAGMA foreign_keys = ON');
    }
  } else {
    db.prepare("INSERT INTO org_meta (key,value) VALUES ('schema',?) ON CONFLICT(key) DO NOTHING").run(String(ORG_SCHEMA_VERSION));
  }
  // From version 2: the Admin template gains the pay code abilities (the Owner template has every ability anyway).
  if ((verBefore && verBefore < 3) || legacy) {
    const add = ['paycodes.manage', 'paycodes.assign'];
    for (const r of db.prepare("SELECT id, abilities FROM org_roles WHERE template_key = 'admin'").all()) {
      let have; try { have = JSON.parse(r.abilities); } catch { have = []; }
      if (!Array.isArray(have)) have = [];
      const next = [...new Set([...have, ...add])];
      if (next.length !== have.length) db.prepare('UPDATE org_roles SET abilities = ? WHERE id = ?').run(JSON.stringify(next), r.id);
    }
    db.prepare("UPDATE org_meta SET value = ? WHERE key = 'schema'").run(String(ORG_SCHEMA_VERSION));
  }
  // Organizations made before roles existed elsewhere (or added by hand) get their templates.
  for (const o of db.prepare('SELECT id FROM orgs WHERE id NOT IN (SELECT org_id FROM org_roles WHERE template_key = ?)').all('owner')) seedTemplates(db, o.id, now);
  return report;
}
