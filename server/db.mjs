// SQLite storage for the org server and the payroll vault (node:sqlite, prepared statements only).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migratePayroll, sealTriggersSql, SEALED_VALUE_NAMES } from './payroll/schema.mjs';
import { isSealed } from './lib/vault.mjs';
import { VaultLocked } from './payroll/vaultstate.mjs';

export const DEFAULT_DB = join(dirname(fileURLToPath(import.meta.url)), 'data', 'demo.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, tz TEXT NOT NULL,
  late_threshold_min INTEGER NOT NULL DEFAULT 5, workweek_start INTEGER NOT NULL DEFAULT 0,
  pay_frequency TEXT NOT NULL DEFAULT 'biweekly', pay_period_anchor TEXT NOT NULL,
  futa_exempt INTEGER NOT NULL DEFAULT 0, suta_rate REAL NOT NULL DEFAULT 0.0305,
  rule_overrides TEXT NOT NULL DEFAULT '{}', bank TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, email TEXT,
  roles TEXT NOT NULL DEFAULT '["member"]', positions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
  birthdate TEXT, pay_rate_cents INTEGER, w4 TEXT NOT NULL DEFAULT '{}', co_allowance REAL,
  ytd_wages_cents INTEGER NOT NULL DEFAULT 0, deposit TEXT
);
CREATE TABLE IF NOT EXISTS cert_types (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, issuer TEXT,
  validity_months INTEGER, required_for_positions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL REFERENCES people(id),
  type_id TEXT NOT NULL REFERENCES cert_types(id), expires TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), position_id TEXT NOT NULL REFERENCES positions(id),
  person_id TEXT REFERENCES people(id), start TEXT NOT NULL, "end" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')), note TEXT
);
CREATE INDEX IF NOT EXISTS shifts_start ON shifts(org_id, start);
CREATE TABLE IF NOT EXISTS swaps (
  id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), from_person TEXT NOT NULL REFERENCES people(id),
  claimant TEXT REFERENCES people(id), status TEXT NOT NULL CHECK (status IN ('offered','claimed','approved','denied')),
  created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS punches (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), shift_id TEXT REFERENCES shifts(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')), at TEXT NOT NULL, source TEXT NOT NULL,
  rest_attested INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS punches_person ON punches(person_id, at);
CREATE TRIGGER IF NOT EXISTS punches_no_update BEFORE UPDATE ON punches BEGIN SELECT RAISE(ABORT, 'punches are append-only'); END;
CREATE TRIGGER IF NOT EXISTS punches_no_delete BEFORE DELETE ON punches BEGIN SELECT RAISE(ABORT, 'punches are append-only'); END;
CREATE TABLE IF NOT EXISTS punch_requests (
  id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), shift_id TEXT REFERENCES shifts(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')), at TEXT NOT NULL, reason_code TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS timecard_approvals (
  person_id TEXT NOT NULL REFERENCES people(id), period_start TEXT NOT NULL, approved_by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (person_id, period_start)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL
);
`;

export function openDb(file = DEFAULT_DB) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // secure_delete: overwritten and deleted values are zeroed in the file, so a sealed value leaves no plaintext behind.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA secure_delete = ON;');
  // Pay amounts, birthdates and emails are sealed as they're written (triggers call keas_seal) and opened as they're
  // read (openRow), with the vault's key, which the vault hands over when it's unlocked (setSealer).
  let sealer = null;
  const needSealer = () => { if (!sealer) throw new VaultLocked(); return sealer; };
  db.function('keas_seal', { deterministic: false }, (v) => (v == null ? null : needSealer().seal(v)));
  db.exec(SCHEMA);
  migratePayroll(db);
  db.exec(sealTriggersSql());
  const openRow = (r) => {
    if (!r) return r;
    for (const k of SEALED_VALUE_NAMES) if (isSealed(r[k])) r[k] = needSealer().open(r[k]);
    return r;
  };
  const cache = new Map();
  let depth = 0;
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    db,
    all: (sql, ...p) => st(sql).all(...p).map(openRow),
    get: (sql, ...p) => openRow(st(sql).get(...p)),
    run: (sql, ...p) => st(sql).run(...p),
    /** { seal(value) -> sealed text, open(sealed) -> value } while the vault is open; null when it's locked. */
    setSealer(s) { sealer = s; },
    tx(fn) {
      // Nested calls join the outer transaction.
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      db.exec('BEGIN IMMEDIATE');
      depth = 1;
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth = 0; }
    },
    isEmpty() { return st('SELECT COUNT(*) AS n FROM orgs').get().n === 0; },
    close() { db.close(); },
  };
}

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function rowToPerson(r) {
  if (!r) return null;
  return {
    id: r.id, orgId: r.org_id, name: r.name, email: r.email, roles: J(r.roles, []), positions: J(r.positions, []),
    status: r.status, birthdate: r.birthdate, payRateCents: r.pay_rate_cents, w4: J(r.w4, {}),
    coAllowance: r.co_allowance, ytdWagesCents: r.ytd_wages_cents, depositRaw: r.deposit ?? null, piiRaw: r.pii_enc ?? null,
    hireDate: r.hire_date ?? null, termDate: r.term_date ?? null, departmentId: r.department_id ?? null, entityId: r.entity_id ?? null,
    managerId: r.manager_id ?? null, gradeId: r.grade_id ?? null, workerType: r.worker_type || 'employee', employeeNumber: r.employee_number ?? null,
    defaultAllocations: J(r.default_allocations, []), holidayCalendarId: r.holiday_calendar_id ?? null, ytdYear: r.ytd_year ?? null, legalName: r.legal_name ?? null,
  };
}
export function rowToOrg(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, state: r.state, tz: r.tz, lateThresholdMin: r.late_threshold_min, workweekStart: r.workweek_start,
    payFrequency: r.pay_frequency, payPeriodAnchor: r.pay_period_anchor, futaExempt: !!r.futa_exempt, sutaRate: r.suta_rate,
    ruleOverrides: J(r.rule_overrides, {}), bankRaw: r.bank ?? null, settings: J(r.settings, {}),
  };
}
export const rowToShift = (r) => r && ({ id: r.id, positionId: r.position_id, personId: r.person_id, start: r.start, end: r.end, status: r.status, note: r.note ?? null });
export const rowToPosition = (r) => ({ id: r.id, name: r.name, tags: J(r.tags, []) });
export const rowToCertType = (r) => ({ id: r.id, name: r.name, issuer: r.issuer, validityMonths: r.validity_months, requiredForPositions: J(r.required_for_positions, []) });
export const rowToPunch = (r) => ({ id: r.id, personId: r.person_id, shiftId: r.shift_id, type: r.type, at: r.at, source: r.source, restAttested: r.rest_attested == null ? null : !!r.rest_attested, createdAt: r.created_at });
export const rowToRequest = (r) => ({ id: r.id, personId: r.person_id, shiftId: r.shift_id, type: r.type, at: r.at, reasonCode: r.reason_code, note: r.note, status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at });
export const rowToSwap = (r) => ({ id: r.id, shiftId: r.shift_id, fromPerson: r.from_person, claimant: r.claimant, status: r.status, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at });
