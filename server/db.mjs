// SQLite storage for the org server and the payroll vault (node:sqlite, prepared statements only).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migratePayroll, sealTriggersSql, SEALED_COLUMNS, SEALED_SOFT_TABLES } from './payroll/schema.mjs';
import { isSealed, sealContext, SealError } from './lib/vault.mjs';
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

const SEALED_BY_COLUMN = new Map(SEALED_COLUMNS.map(([table, keys, col]) => [`${table}.${col}`, { table, keys, col }]));

export function openDb(file = DEFAULT_DB) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // secure_delete: overwritten and deleted values are zeroed in the file, so a sealed value leaves no plaintext behind.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA secure_delete = ON;');
  // Sealed columns (schema.mjs SEALED) are sealed as they're written (triggers call keas_seal) and opened as they're
  // read (openRow), with the vault's key, which the vault hands over when it's unlocked (setSealer). Each value is
  // bound to its table, column and row. raw: the vault's own re-encryption writes values that are already sealed.
  let sealer = null, raw = false;
  const needSealer = () => { if (!sealer) throw new VaultLocked(); return sealer; };
  const soft = (table) => SEALED_SOFT_TABLES.includes(table);
  db.function('keas_needs_seal', { deterministic: false, varargs: true }, (table, col, v, ...keys) => {
    if (raw || v == null) return 0;
    if (!sealer) { if (soft(table)) return 1; throw new VaultLocked(); }
    if (!isSealed(v)) return 1;
    try { sealer.open(v, sealContext(table, col, keys)); return 0; } catch { return 1; }
  });
  db.function('keas_seal', { deterministic: false, varargs: true }, (table, col, v, ...keys) => {
    if (v == null) return null;
    if (!sealer && soft(table)) return null; // e.g. the audit entry for locking the vault: its detail isn't kept
    return needSealer().seal(v, sealContext(table, col, keys));
  });
  db.exec(SCHEMA);
  migratePayroll(db);
  db.exec(sealTriggersSql(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'seal%'").all().map((r) => r.name)));

  // How to open each statement's sealed columns: where each result column comes from (node:sqlite columns()), and
  // which result columns hold that row's key. Without the key in the result, the row is found by its sealed value.
  const plans = new Map();
  const planOf = (sql, stmt) => {
    let plan = plans.get(sql);
    if (plan) return plan;
    const byName = new Map();
    for (const c of stmt.columns()) byName.set(c.name, c); // a later column with the same name wins, as in the row
    plan = [];
    for (const [name, c] of byName) {
      if (!c.table) { plan.push({ name, expr: true }); continue; }
      const spec = SEALED_BY_COLUMN.get(`${c.table}.${c.column}`);
      if (!spec) continue;
      const keyNames = spec.keys.map((k) => [...byName].find(([, c2]) => c2.table === spec.table && c2.column === k)?.[0] ?? null);
      plan.push({ name, spec, keyNames: keyNames.every((n) => n != null) ? keyNames : null });
    }
    plans.set(sql, plan);
    return plan;
  };
  /** The row key of the only row holding this sealed value (a copied value is in two rows: refused). */
  const locate = (spec, v) => {
    const rows = db.prepare(`SELECT ${spec.keys.join(', ')} FROM ${spec.table} WHERE ${spec.col} = ? LIMIT 2`).all(v);
    if (rows.length !== 1) throw new SealError(`${spec.table}.${spec.col}`, rows.length ? 'appears in more than one row' : 'isn’t where it was read from');
    return spec.keys.map((k) => rows[0][k]);
  };
  const openRow = (plan, r) => {
    if (!r || !plan.length) return r;
    for (const p of plan) {
      const v = r[p.name];
      if (v == null) continue;
      if (p.expr) { if (isSealed(v)) throw new SealError(p.name, 'was read without its column'); continue; }
      const where = `${p.spec.table}.${p.spec.col}`;
      if (!isSealed(v)) throw new SealError(where, 'isn’t sealed');
      const keys = p.keyNames ? p.keyNames.map((n) => r[n]) : locate(p.spec, v);
      const s = needSealer();
      try { r[p.name] = s.open(v, sealContext(p.spec.table, p.spec.col, keys)); } catch (e) { if (e instanceof VaultLocked) throw e; throw new SealError(where, 'doesn’t belong to this row'); }
    }
    return r;
  };
  const cache = new Map();
  let depth = 0;
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    db,
    all: (sql, ...p) => { const s = st(sql), plan = planOf(sql, s); return s.all(...p).map((r) => openRow(plan, r)); },
    get: (sql, ...p) => { const s = st(sql); return openRow(planOf(sql, s), s.get(...p)); },
    run: (sql, ...p) => st(sql).run(...p),
    /** { seal(value, ctx) -> sealed text, open(sealed, ctx) -> value } while the vault is open; null when it's locked. */
    setSealer(s) { sealer = s; },
    /** Runs fn with the sealing triggers off: fn writes values that are already sealed (re-encryption, upgrades). */
    rawWrites(fn) { const was = raw; raw = true; try { return fn(); } finally { raw = was; } },
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

/** People's names are sealed, so SQL can't sort by them: rows with a name sorted in code (the same order every time). */
export const byName = (rows) => rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
