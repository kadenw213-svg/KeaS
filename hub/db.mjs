// Kea Hub storage (node:sqlite, prepared statements only). One file; back it up with `node hub/backup.mjs`.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.KEA_HUB_DATA || join(dirname(fileURLToPath(import.meta.url)), 'data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','owner')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  can_host INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  client TEXT
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS login_failures (
  name_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, last_at INTEGER NOT NULL, locked_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS host_applications (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class','general')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  meeting_url TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('instructor','ta','student')),
  board TEXT NOT NULL DEFAULT 'name' CHECK (board IN ('name','nickname','hidden')),
  nickname TEXT, joined_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, account_id)
);
CREATE INDEX IF NOT EXISTS members_account ON class_members(account_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ta','student')), created_by TEXT NOT NULL,
  max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  location TEXT, meeting_url TEXT, notes TEXT
);
CREATE INDEX IF NOT EXISTS class_sessions_start ON class_sessions(class_id, start_at);
CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, leaderboard INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  q TEXT NOT NULL, choices TEXT NOT NULL, answer INTEGER NOT NULL, why TEXT
);
CREATE INDEX IF NOT EXISTS questions_set ON questions(set_id, idx);
CREATE TABLE IF NOT EXISTS review_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  box INTEGER NOT NULL, due_at INTEGER NOT NULL, missed INTEGER NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (account_id, question_id)
);
CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL, question_id TEXT NOT NULL, points INTEGER NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS xp_class ON xp_events(class_id, at);
CREATE INDEX IF NOT EXISTS xp_account ON xp_events(account_id, day);
CREATE TABLE IF NOT EXISTS terms_versions (
  n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  sections TEXT NOT NULL, published_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS terms_no_update BEFORE UPDATE ON terms_versions BEGIN SELECT RAISE(ABORT, 'published terms never change'); END;
CREATE TABLE IF NOT EXISTS terms_acceptances (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, version INTEGER NOT NULL REFERENCES terms_versions(n),
  sections TEXT NOT NULL, at INTEGER NOT NULL, ip TEXT, client TEXT,
  PRIMARY KEY (account_id, version)
);
CREATE TABLE IF NOT EXISTS files (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, path TEXT NOT NULL,
  blob TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, path)
);
CREATE TABLE IF NOT EXISTS google_tokens_used (token_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The shared-Claude queue (hub/lib/budget.mjs). One row per Claude job; people who asked for the same thing join it.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initial_scan','update_scan','more_questions')),
  course_key TEXT NOT NULL, chapter TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS scan_jobs_status ON scan_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS scan_jobs_account ON scan_jobs(account_id, created_at);
CREATE TABLE IF NOT EXISTS scan_job_members (
  job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL, PRIMARY KEY (job_id, account_id)
);
-- A course section that has scanned materials everyone in it shares.
CREATE TABLE IF NOT EXISTS course_materials (
  course_key TEXT PRIMARY KEY, first_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- A course section's shared folder: what the shared Claude made for it (textbook chapters, question pools), read by
-- everyone in course_members. Same layout as files, keyed by course instead of account.
CREATE TABLE IF NOT EXISTS course_files (
  course_key TEXT NOT NULL, path TEXT NOT NULL,
  blob TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (course_key, path)
);
CREATE TABLE IF NOT EXISTS course_members (
  course_key TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, joined_at INTEGER NOT NULL,
  PRIMARY KEY (course_key, account_id)
);
CREATE TABLE IF NOT EXISTS scan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_requests_day ON scan_requests(account_id, day);
-- Parent or guardian sign-off for members under 18, before they can ask the shared Claude for anything. The parent
-- proves their email with Google (in the member's Kea, or on the Hub's /consent page from a link the member sends).
CREATE TABLE IF NOT EXISTS parent_consents (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','revoked')),
  method TEXT, parent_google_sub TEXT, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS parent_consents_account ON parent_consents(account_id, created_at);
-- Accounts flagged for the owner's review (overuse, scripts). Suspension can be automatic; lifting it is the owner's.
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, detail TEXT, auto_suspended INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), at INTEGER NOT NULL, resolved_at INTEGER, note TEXT
);
`;

// Columns added after the first release, applied to existing databases.
const COLUMNS = [
  ['accounts', 'quota_bytes', 'INTEGER'],
  ['accounts', 'google_sub', 'TEXT'],
  // A scan waits (ready = 0) until the person's Kea has uploaded what it collected from their class site.
  ['scan_jobs', 'ready', 'INTEGER NOT NULL DEFAULT 1'],
  // Birth year (asked at sign-up, or before the first shared-Claude request): under 18 needs a parent's sign-off.
  ['accounts', 'birth_year', 'INTEGER'],
  // Where course material for this person goes in their Kea storage: "kea/Kea/<profile>/" (their Kea says when it
  // asks or joins), so a shared scan's material lands in the folder their Kea syncs.
  ['scan_jobs', 'target', 'TEXT'],
  ['scan_job_members', 'target', 'TEXT'],
  ['course_members', 'target', 'TEXT'],
  // Material from a finished job already copied into each person's storage (so a retry never copies twice).
  ['scan_jobs', 'delivered', 'INTEGER NOT NULL DEFAULT 0'],
  // How the person shows on leaderboards unless a class says otherwise: 'name', 'nickname' or 'hidden'.
  ['accounts', 'board_default', "TEXT NOT NULL DEFAULT 'name'"],
  ['accounts', 'nickname', 'TEXT'],
];

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, col, type] of COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    db,
    get: (sql, ...a) => st(sql).get(...a),
    all: (sql, ...a) => st(sql).all(...a),
    run: (sql, ...a) => st(sql).run(...a),
    tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    close: () => db.close(),
  };
}
