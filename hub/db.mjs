// The KeaS server's own tables (node:sqlite, prepared statements only). One file, hub.db in the data folder; back it up
// with `node hub/backup.mjs`. The org engine (org/schema.mjs) adds its tables to the same file.
//
// KeaS keeps no accounts: people are Kea accounts (KeaC), and keas_members only remembers the name and email the
// newest pass carried. A KeaS 0.5 Kea Hub database is upgraded first (hub/upgrade.mjs).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.KEA_HUB_DATA || join(dirname(fileURLToPath(import.meta.url)), 'data');

export const SCHEMA = `
-- One row per Kea account that signed in here with a pass (id = the pass's sub, the Kea account id).
CREATE TABLE IF NOT EXISTS keas_members (
  id TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL, last_pass_at INTEGER NOT NULL, pass_iat INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS keas_members_email ON keas_members(email);
-- KeaS's own sessions, made from passes. Only a hash of each token is kept.
CREATE TABLE IF NOT EXISTS keas_sessions (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  pass_iat INTEGER NOT NULL, client TEXT
);
CREATE INDEX IF NOT EXISTS keas_sessions_account ON keas_sessions(account_id);
-- Kea accounts KeaC listed as suspended or deleted (GET <KeaC>/v1/revoked): no passes, no sessions.
CREATE TABLE IF NOT EXISTS keac_revoked (account_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Notices for one person (the org engine's: a shift, a swap, a code given, a stub published).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', note TEXT, data TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_account ON notifications(account_id, id);
-- Org classes (org/routes.mjs, mountOrg's classes option): classes that belong to an organization.
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class','general')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  meeting_url TEXT, created_at INTEGER NOT NULL, org_id TEXT
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
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
-- Each member's files area (documents and classes Kea syncs to this server; the Kea Hub's /v1/files API). Files are
-- on disk under random names in <data>/member-files/<account id>/.
CREATE TABLE IF NOT EXISTS member_files (
  account_id TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL,
  sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, path)
);
`;
// The tables above (the 0.5 upgrade keeps these names apart from the ones it archives).
export const KEAS_TABLES = ['keas_members', 'keas_sessions', 'keac_revoked', 'audit', 'settings', 'notifications', 'classes', 'class_members', 'invites', 'class_sessions', 'member_files'];

/** Is this a KeaS 0.5 Kea Hub database (it has the accounts table)? */
export const isHub05 = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get();

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (isHub05(db)) { db.close(); throw Object.assign(new Error(`${file} is a KeaS 0.5 Kea Hub database. Start the KeaS server (it upgrades it) or run node hub/upgrade.mjs first.`), { code: 'HUB05' }); }
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
