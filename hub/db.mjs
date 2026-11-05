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
`;

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
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
