-- A Kea Hub database made by KeaS 0.5.0 (main de75286): one org with an owner, a second owner, an admin, a manager,
-- a member and a pending member; departments, a position, codes, a cert, a published shift and a budget.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE accounts (
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
, quota_bytes INTEGER, google_sub TEXT, birth_year INTEGER, board_default TEXT NOT NULL DEFAULT 'name', nickname TEXT, claude_override TEXT, supporter_until INTEGER, supporter_since INTEGER, supporter_lapse_noted INTEGER NOT NULL DEFAULT 0, phone TEXT, phone_visibility TEXT NOT NULL DEFAULT 'nobody', used_bytes INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  client TEXT
, reauth_at INTEGER, mfa INTEGER NOT NULL DEFAULT 0);
CREATE TABLE login_failures (
  name_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, last_at INTEGER NOT NULL, locked_until INTEGER NOT NULL
);
CREATE TABLE totp_failures (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  count INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0, last_lock_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT
);
CREATE TABLE host_applications (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
CREATE TABLE classes (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class','general')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  meeting_url TEXT, created_at INTEGER NOT NULL
, org_id TEXT);
CREATE TABLE class_members (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('instructor','ta','student')),
  board TEXT NOT NULL DEFAULT 'name' CHECK (board IN ('name','nickname','hidden')),
  nickname TEXT, joined_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, account_id)
);
CREATE TABLE invites (
  code TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ta','student')), created_by TEXT NOT NULL,
  max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE class_sessions (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  location TEXT, meeting_url TEXT, notes TEXT
);
CREATE TABLE sets (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, leaderboard INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE questions (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  q TEXT NOT NULL, choices TEXT NOT NULL, answer INTEGER NOT NULL, why TEXT
);
CREATE TABLE review_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  box INTEGER NOT NULL, due_at INTEGER NOT NULL, missed INTEGER NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (account_id, question_id)
);
CREATE TABLE xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL, question_id TEXT NOT NULL, points INTEGER NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL
);
CREATE TABLE terms_versions (
  n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  sections TEXT NOT NULL, published_at INTEGER NOT NULL
);
CREATE TABLE terms_acceptances (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, version INTEGER NOT NULL REFERENCES terms_versions(n),
  sections TEXT NOT NULL, at INTEGER NOT NULL, ip TEXT, client TEXT,
  PRIMARY KEY (account_id, version)
);
CREATE TABLE files (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, path TEXT NOT NULL,
  blob TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, path)
);
CREATE TABLE google_tokens_used (token_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE scan_jobs (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initial_scan','update_scan','more_questions')),
  course_key TEXT NOT NULL, chapter TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, note TEXT
, ready INTEGER NOT NULL DEFAULT 1, target TEXT, delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE scan_job_members (
  job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL, target TEXT, PRIMARY KEY (job_id, account_id)
);
CREATE TABLE course_materials (
  course_key TEXT PRIMARY KEY, first_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE course_files (
  course_key TEXT NOT NULL, path TEXT NOT NULL,
  blob TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (course_key, path)
);
CREATE TABLE course_members (
  course_key TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, joined_at INTEGER NOT NULL, target TEXT,
  PRIMARY KEY (course_key, account_id)
);
CREATE TABLE scan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL
);
CREATE TABLE parent_consents (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','revoked')),
  method TEXT, parent_google_sub TEXT, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, detail TEXT, auto_suspended INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), at INTEGER NOT NULL, resolved_at INTEGER, note TEXT
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', note TEXT, data TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE TABLE course_join_requests (
  id TEXT PRIMARY KEY, course_key TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target TEXT, label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE totp_backup_codes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, used_at INTEGER,
  PRIMARY KEY (account_id, hash)
);
CREATE TABLE course_codes (
  course_key TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE login_fail_pairs (
  name_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL, locked_until INTEGER NOT NULL,
  PRIMARY KEY (name_hash, ip_hash)
);
CREATE TABLE orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'private',
  tz TEXT NOT NULL DEFAULT 'America/Denver', state TEXT, workweek_start INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  settings TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  department_id TEXT, title TEXT, birthdate TEXT, cost_rate INTEGER,
  desired_min REAL, desired_max REAL, usual_week TEXT NOT NULL DEFAULT '{}', prefs TEXT NOT NULL DEFAULT '[]',
  joined_at INTEGER NOT NULL, via_code TEXT,
  PRIMARY KEY (org_id, account_id)
);
CREATE TABLE org_member_positions (
  org_id TEXT NOT NULL, account_id TEXT NOT NULL, position_id TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id, position_id),
  FOREIGN KEY (org_id, account_id) REFERENCES org_members(org_id, account_id) ON DELETE CASCADE
);
CREATE TABLE org_codes (
  code TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','member')), label TEXT,
  department_id TEXT, position_id TEXT, needs_approval INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE org_departments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  parent_id TEXT, name TEXT NOT NULL, cost_center_id TEXT, location_id TEXT, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE org_positions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, department_id TEXT, tags TEXT NOT NULL DEFAULT '[]', cost_rate INTEGER, color TEXT
);
CREATE TABLE org_locations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, address TEXT
);
CREATE TABLE org_cost_centers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL
);
CREATE TABLE org_budgets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount INTEGER NOT NULL, label TEXT NOT NULL DEFAULT 'Original', note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE org_cert_types (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, valid_months INTEGER, positions TEXT NOT NULL DEFAULT '[]', warn_days TEXT NOT NULL DEFAULT '[60,30,7]'
);
CREATE TABLE org_certs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, type_id TEXT NOT NULL, issued_on TEXT NOT NULL, expires_on TEXT,
  source TEXT NOT NULL DEFAULT 'manual', class_id TEXT, note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE org_classes (
  class_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, cert_type_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE org_class_assignments (
  class_id TEXT NOT NULL, account_id TEXT NOT NULL, org_id TEXT NOT NULL, due_on TEXT, assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL, completed_on TEXT, cert_id TEXT,
  PRIMARY KEY (class_id, account_id)
);
CREATE TABLE org_block_sets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position_id TEXT, blocks TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE org_forms (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  deadline_at INTEGER, blocks TEXT NOT NULL DEFAULT '[]', exceptions TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '{}', audience TEXT NOT NULL DEFAULT '{}', minor_note TEXT,
  reminders TEXT NOT NULL DEFAULT '[72,24,0]', allow_changes INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE TABLE org_responses (
  form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}', date_notes TEXT NOT NULL DEFAULT '{}', note TEXT,
  desired_min REAL, desired_max REAL, days_off TEXT, extra TEXT NOT NULL DEFAULT '{}',
  submitted_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, account_id)
);
CREATE TABLE org_response_changes (
  id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  proposal TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE org_nudges (
  form_id TEXT NOT NULL REFERENCES org_forms(id) ON DELETE CASCADE, account_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (form_id, account_id)
);
CREATE TABLE org_schedules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  form_id TEXT, title TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  need_overrides TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE TABLE org_shifts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, schedule_id TEXT,
  account_id TEXT, position_id TEXT NOT NULL, department_id TEXT, location_id TEXT,
  date TEXT NOT NULL, block_id TEXT, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  source TEXT NOT NULL DEFAULT 'manual', note TEXT, forced INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE org_drafts (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES org_schedules(id) ON DELETE CASCADE,
  source TEXT NOT NULL, summary TEXT, shifts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','applied','discarded')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE org_swaps (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, shift_id TEXT NOT NULL,
  from_account TEXT NOT NULL, to_account TEXT, claimant TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','claimed','approved','denied','cancelled')),
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE org_policies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, url TEXT, due_on TEXT, audience TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE org_policy_acks (
  policy_id TEXT NOT NULL REFERENCES org_policies(id) ON DELETE CASCADE, account_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (policy_id, account_id)
);
CREATE TABLE org_todo_snoozes (
  account_id TEXT NOT NULL, item_key TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (account_id, item_key)
);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('8999b019-4c41-45df-b1ec-f913d5da4346','boss@old.org','Olive Owner','argon2id$m=19456,t=2,p=1$V4ISzIw0irGtUh8tRhdgNg$uj_W_ArMUn3YQM7JPYqzLzgYA0B8JVbZH-2lDt4uoOw','user','active',1,'Owner',0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('c8dd3a15-7382-418a-8514-25c06198bbe3','co@old.org','Cole Owner','argon2id$m=19456,t=2,p=1$Ha9X-IE0CMJrRy-7uPilxQ$c07626ggLh6UDYFjMTp7QjFz1z90BjuQ3XYr_QY2UaE','user','active',1,'Owner',0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('0ef79899-1418-45f6-b401-989474fcbe16','adm@old.org','Ada Admin','argon2id$m=19456,t=2,p=1$XqKB_70dK_b9Llx5bdCicg$SPqiUAOS-AO1JhVWZfWnwQBn7Kuk-tIX12Wr8dkohCg','user','active',1,'Owner',0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('ad32f673-1da7-4eb4-8dd3-7bcc8c9486f5','mgr@old.org','Max Manager','argon2id$m=19456,t=2,p=1$YjEah8Hz2tvIBFBfzxXaPQ$E2pwHM0adW-cCqwNADrCKoD4bvgKcT_2n9pAI-_nK-Y','user','active',1,'Owner',0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('f2d4e00d-4c65-4611-a6d2-bba3f54af240','ana@old.org','Ana Member','argon2id$m=19456,t=2,p=1$BD9N7x_MwvO3yJ6Nf6zBzQ$XO9P6Kmq2JDC1C8QjKjqEabeOspXFzjjmxZYQv5xtwY','user','active',1,'Owner',0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "accounts" ("id","email","display_name","pw_hash","role","status","email_verified","verified_by","identity_verified","can_host","totp_secret","totp_enabled","totp_last_step","created_at","updated_at","quota_bytes","google_sub","birth_year","board_default","nickname","claude_override","supporter_until","supporter_since","supporter_lapse_noted","phone","phone_visibility","used_bytes","file_count") VALUES ('4005b42b-c6da-4f5c-9873-f0bd68254b6d','pend@old.org','Pia Pending','argon2id$m=19456,t=2,p=1$iuye3zua3lU4oRKv8gvNDw$_lWOfC123ew-PCYLIa5jh3Uw9qBy3ekfH2TgjcUsn0k','user','active',0,NULL,0,0,NULL,0,-1,1793890800000,1793890800000,NULL,NULL,NULL,'name',NULL,NULL,NULL,NULL,0,NULL,'nobody',0,0);
INSERT INTO "terms_versions" ("n","label","title","summary","sections","published_at") VALUES (1,'2026-11-05.3','Kea Terms of Use','Three new sections: your optional phone number and who sees it, notifications, and supporters.','[{"id":"about","title":"1. What Kea and KeaS are","body":"Kea is a free app for school, study and documents. KeaS is a free app for workplaces: scheduling, availability, time clock, certifications, classes and payroll preparation. Both use one Kea account.\nThe Kea Hub is the server that keeps Kea accounts, classes, study progress, leaderboards and the files you choose to store there. It is run by Kaden Walsh (\"the developer\", \"I\"), the creator of Kea, on his own computer.\nThese terms cover your Kea account, the Kea Hub, and the official Kea and KeaS apps. You must agree to all of them to use a Kea account."},{"id":"accounts","title":"2. Your account","body":"- You must be 13 or older to have a Kea account.\n- One account per person. Use your real email address. Don''t share your account or sign in as someone else.\n- Your password is never stored. The Hub keeps only a one-way scrambled form of it (a slow, memory-hard hash: Argon2id or scrypt), so nobody, including the developer, can read it. If you forget it, you reset it; it can''t be looked up.\n- Repeated wrong sign-ins lock the account for a growing amount of time. This protects you from people guessing your password.\n- You can turn on two-step sign-in with an authenticator app. Owners of organizations, payroll admins and verified instructors must use it.\n- \"Verify with Google\" proves you own your email: Google tells the Hub your email address and nothing else. Kea never sees your Google password.\n- You are responsible for what happens under your account. Tell the developer right away if you think someone else got into it."},{"id":"official-software","title":"3. Use the official software only","body":"- You may only connect to the Kea Hub and Kea services with the official Kea and KeaS apps, downloaded from the developer''s official releases, and only while you have agreed to the current version of these terms.\n- Kea''s code is open source, so other people can copy and change it. A copied or modified version is not Kea. It is not made, checked or supported by the developer, even if it uses the Kea name or looks the same.\n- The developer is not responsible or liable for anything a modified, unofficial or tampered version does, including one changed to skip these terms, skip safety checks (such as payroll''s \"verified tables\" check), cheat on scores, or take your data. If you use one, you do so entirely at your own risk.\n- Using a modified version to connect to the Kea Hub, or any tool that gets around the Hub''s sign-in, limits or checks, breaks these terms, and the account can be suspended."},{"id":"hub","title":"4. The Kea Hub runs on a personal computer","body":"- The Hub runs on the developer''s own computer and home internet, reached through a secure tunnel. It is not a data center.\n- It can be offline: for updates, power or internet outages, or repairs. There is no guaranteed uptime. The apps keep working offline where they can, and catch up when the Hub is back.\n- Live class video is not sent through the Hub. Classes use meeting links (for example Jitsi Meet, Google Meet or Zoom), which follow those services'' own terms.\n- Organizations that need guaranteed uptime can run their own KeaS server."},{"id":"data","title":"5. What the Hub stores, and why","body":"The Hub stores:\n- your account: email, display name, the scrambled password, two-step sign-in settings, verification status, and which version of these terms you agreed to and when;\n- the classes you make or join, your role in them, and your leaderboard name choice;\n- your study answers and scores (to grade questions, schedule reviews and run leaderboards);\n- files you choose to save to your Kea storage;\n- security records: sign-ins, failed sign-ins and the network address they came from, kept to stop break-in attempts.\nThe Hub does not store payroll data such as Social Security numbers, bank account numbers or tax forms. Those stay encrypted on the payroll admin''s own computer.\nYour data is never sold, never used for ads, and never shared except as these terms describe (for example, with the classes and organizations you join) or when the law requires it.\nBackups of the Hub are encrypted before they leave the Hub''s computer."},{"id":"phone-number","title":"5b. Your phone number (optional)","body":"- You can add a phone number to your Kea account. You don''t have to.\n- You choose who sees it: nobody (the default), classmates in the Kea classes you''re in, coworkers in the organizations you belong to, or both. You can change that or remove the number at any time.\n- It is never shown on leaderboards, never shown to the public, and never shown to anyone your choice doesn''t include. The developer can see it when running the Hub, as with the rest of your account.\n- The Hub keeps it with your account, includes it when you download your data, and deletes it when you remove it or close your account. It is never sold or used for ads, and Kea doesn''t call or text it.\n- Only add a number that''s yours. People who can see it may contact you there, so share it only where you''re comfortable with that."},{"id":"notifications","title":"5c. Notifications","body":"- The Hub keeps a list of notices for your account, and the Kea apps show them: for example when the developer changes your storage or your limits on Kea''s shared Claude, when an organization or a request to join one is decided, when a parent or guardian signs off, when a shared-Claude request finishes, or when course material arrives in your Kea storage.\n- Kea on your computer can also show them as system notifications. You can turn that off in Kea''s settings; the list stays in your account.\n- Notices are kept with your account. Read ones are deleted after about six months, and you can delete them sooner. They are included when you download your data.\n- Notices are only about your Kea account. They are never ads."},{"id":"storage","title":"6. Your Kea storage","body":"- Your account comes with storage space on the Hub for your Kea data (documents, notes, study sets, settings), so your devices can stay in step without another cloud drive.\n- Each account has a storage limit. The developer can change limits, and will tell you before lowering one below what you''re already using.\n- Your files are stored on the Hub''s drives. They are protected by your sign-in and the Hub''s security, but they are not end-to-end encrypted, so the Hub''s operator could technically open them. The developer doesn''t look at your files except when needed for security, a legal requirement, or a report of abuse.\n- Keep your own copies of anything important. The Hub is backed up, but it is not a guaranteed archive.\n- Don''t store illegal content or other people''s private information without permission. Content like that can be removed and the account suspended."},{"id":"classes","title":"7. Classes, instructors and hosting","body":"- Anyone can join a class with an invite code from its instructor.\n- Hosting a class on the Kea Hub needs the developer''s approval. Instructors can also host classes on their own organization''s server without that approval.\n- Publishing a general curriculum (a public class anyone can find) needs an identity-verified account, and each one is reviewed before it is listed.\n- Instructors are responsible for their class content: that it''s accurate, that they have the right to share it, and that it''s appropriate for their students. Don''t upload publishers'' test banks, scanned textbooks or other material you don''t have rights to.\n- Classes in Kea don''t replace official certification. A certificate from an organization (for example a lifeguarding or CPR card) comes from that organization or the certifying agency, not from Kea.\n- The developer can remove a class or take away hosting at any time, especially to protect students."},{"id":"study","title":"8. Study tools, scores and leaderboards","body":"How scoring works:\n- A question earns points only when it is due: new, or back for review.\n- Right on the first try earns the most. Right after a wrong answer still earns a little, so practicing until you get it counts. Wrong answers never cost points.\n- Answering a question again before it is due is free practice and earns nothing.\n- Questions come back on a spaced schedule (1 day, then 3, 7, 14 days and longer) so you remember them.\n- There is a daily point limit.\n- Answers are checked by the Hub, so scores can''t be changed by editing the app.\nLeaderboards:\n- In each class you choose how you appear: your name, a nickname, or hidden. Hidden people still see their own rank.\n- Scores and levels are for motivation. They are not grades and not an official academic record.\n- Using bots, scripts, shared answer keys or extra accounts to raise scores breaks these terms; the scores can be removed and the account suspended."},{"id":"orgs","title":"9. Organizations and workplaces","body":"- An organization (for example an employer, club or school) can use KeaS for schedules, availability forms, time clock, certifications, classes and payroll preparation. You join one with its code.\n- The organization decides what it collects about its members and is responsible for that data (it is the \"data controller\"). Questions or deletion requests about an organization''s records go to that organization.\n- Org admins can see what their organization needs to run: for example your availability, schedule, hours and the certifications you choose to share with them.\n- Schedules drafted automatically (with or without AI) are suggestions until a manager publishes them.\n- KeaS is a tool. The organization is responsible for following labor law, paying people correctly, and keeping its official records."},{"id":"payroll","title":"10. Payroll","body":"- KeaS calculates pay, withholding and employer taxes, makes pay stubs, direct-deposit files and pre-filled forms. The employer reviews them, submits filings and pays taxes. The employer is always the employer of record and stays legally responsible for payroll, whatever software it uses.\n- KeaS never holds, moves or receives money, and never files taxes for anyone. If an organization connects its own bank, payments go straight from the organization''s own account.\n- Tax and labor tables are only marked \"verified for <year>\" after they are checked against official sources. KeaS won''t finalize a pay run on unverified tables, and you must not use a version of KeaS that skips this check.\n- Check every pay run. Run the first ones alongside another calculator, and consider having an accountant review your first year.\n- Nothing in Kea or KeaS is tax, legal or financial advice."},{"id":"ai","title":"11. Claude and other AI features","body":"- AI features are optional, except researching or updating tax and labor tables in KeaS, which needs Claude. Everything else can be done by hand.\n- AI features use your own Claude account, under Anthropic''s terms, unless you use Kea''s shared Claude (section 11b). Kea sends Claude only what the feature needs.\n- AI output can be wrong. It is a draft (a schedule, a lesson, a table change, an explanation) until a person reviews it. Nothing an AI makes is published, sent or used for pay on its own."},{"id":"shared-claude","title":"11b. Kea''s shared Claude","body":"If you don''t have your own Claude, the developer''s Claude can do a limited amount of work for you, for free, in a queue. To keep it working for everyone:\n- You need a verified email.\n- Each of your classes gets one first scan, and updates when something new is posted. If someone in your course section was already scanned, you share theirs right away.\n- When you run out of practice questions, you can ask for 25 more for a chapter, a few times per chapter. Classes are never regenerated from scratch on the shared Claude.\n- There are daily and weekly limits, and requests wait in line and run one at a time. Wait times can be long, and the queue can be paused.\n- Material made from a shared scan is shared with others in the same course section. Your grades, your own assignments and your private work are never shared.\n- Sending requests automatically, using several accounts to get around the limits, or overloading the queue gets the account suspended for review.\n- The shared Claude is a free extra, not a guaranteed service. It can change or stop at any time. For more, connect your own Claude."},{"id":"acceptable-use","title":"12. What you must not do","body":"- Try to break into the Hub or anyone''s account, guess passwords, get around limits, or test security without the developer''s written permission.\n- Overload the Hub, scrape it, or use automated tools against it.\n- Harass, threaten or bully anyone, or share someone''s private information.\n- Pretend to be someone else, or to be verified when you''re not.\n- Upload illegal content, malware, or material you don''t have the rights to.\n- Use Kea to put minors at risk in any way. This is reported to the authorities."},{"id":"minors","title":"13. Members under 18","body":"- Members aged 13 to 17 can use Kea. Their leaderboard and profile settings start private.\n- Organizations employing minors are responsible for minor-labor rules and any parent notices.\n- A parent or guardian can ask the developer to delete a minor''s account."},{"id":"parent-sign-off","title":"13b. Parent or guardian sign-off for Kea''s shared Claude","body":"- Kea asks for the year you were born. If you are under 18, a parent or guardian has to sign off before Kea''s shared Claude does anything for you. Everything else in Kea works without it.\n- You give Kea your parent''s or guardian''s email. They sign off by signing in to Google with that email: on your computer in Kea, or on a page they open from a link you send them. Google tells Kea only their email address.\n- Kea keeps the sign-off, the parent''s email and when it happened, for as long as your account exists.\n- A parent or guardian can withdraw the sign-off at any time by contacting Kea support. The developer can also review, approve or withdraw a sign-off by hand.\n- Giving a false birth year, or signing off as someone''s parent when you aren''t, breaks these terms and the account can be suspended."},{"id":"third-party","title":"14. Other services","body":"Kea can connect to services run by others: Google, Microsoft, Anthropic (Claude), meeting services, school sites, banks, and the tunnel service that carries Hub traffic (Tailscale or Cloudflare). Those services have their own terms and privacy policies, and the developer isn''t responsible for them."},{"id":"donations","title":"14b. Donations","body":"- Kea is free. You can chip in through the \"Support Kea\" link if you want to, and Kea never asks you again or locks anything behind it.\n- Donations are gifts that help pay for running Kea. They don''t buy extra shared-Claude use, priority, features or any promise of service, and they aren''t refundable unless the law requires it."},{"id":"supporters","title":"14c. Supporters","body":"- The developer can mark an account as a supporter, by hand, as a thank-you (for example after a donation). It lasts for the time the developer sets, usually a month, and can be renewed.\n- While it lasts, a supporter gets more Kea storage (25 GB unless the developer sets another size) and a small supporter badge next to their name in class leaderboards, class member lists and organization member lists. That''s all it does.\n- It is a thank-you, not a purchase. It doesn''t buy a service, extra shared-Claude use, priority, features or any promise, and nothing is owed if it ends or changes. The developer can change what supporters get, or end it, at any time.\n- When it ends, the badge goes away and your storage goes back to the standard size. Nothing is deleted: if you''re over the standard size, your files stay, and new files wait until you''re under it again."},{"id":"warranty","title":"15. No warranty","body":"Kea, KeaS and the Kea Hub are provided free and \"as is\", without warranties of any kind, including that they will be accurate, available, secure or fit for a particular purpose, to the fullest extent the law allows."},{"id":"liability","title":"16. Limits on liability","body":"- To the fullest extent the law allows, the developer is not liable for indirect, incidental or consequential losses, lost data, lost profits, penalties or fines, including tax penalties from payroll errors.\n- The developer''s total liability for any claim about Kea is limited to the greater of what you paid for Kea in the 12 months before the claim (Kea is free, so usually nothing) or 50 US dollars.\n- The developer is never liable for unofficial or modified versions (section 3), for organizations'' decisions, or for content made by instructors or other members."},{"id":"ending","title":"17. Suspension and closing your account","body":"- You can stop using Kea and ask to delete your account at any time. You can also download your data.\n- The developer can suspend or close an account that breaks these terms or puts others at risk, and will explain why when it''s safe to.\n- Sections 3, 15, 16 and 19 still apply after an account is closed."},{"id":"changes","title":"18. When these terms change","body":"- Each version of these terms is numbered and dated, and old versions stay readable.\n- When the terms change, the apps show you exactly which sections were added, changed or removed.\n- You must agree to the new version before your account can use the Kea Hub again. Until then you can still read the terms, download your data, and sign out.\n- If you don''t agree, don''t keep using Kea. You can ask for your account to be deleted."},{"id":"law","title":"19. Law and contact","body":"- These terms are governed by the laws of the State of Colorado, USA, and disputes go to the courts there, unless the law where you live says otherwise.\n- If part of these terms can''t be enforced, the rest still applies.\n- Contact: use \"Contact Kea\" in the app."}]',1793890800000);
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('8999b019-4c41-45df-b1ec-f913d5da4346',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.1','node');
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('c8dd3a15-7382-418a-8514-25c06198bbe3',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.3','node');
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('0ef79899-1418-45f6-b401-989474fcbe16',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.5','node');
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('ad32f673-1da7-4eb4-8dd3-7bcc8c9486f5',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.7','node');
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('f2d4e00d-4c65-4611-a6d2-bba3f54af240',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.9','node');
INSERT INTO "terms_acceptances" ("account_id","version","sections","at","ip","client") VALUES ('4005b42b-c6da-4f5c-9873-f0bd68254b6d',1,'["about","accounts","official-software","hub","data","phone-number","notifications","storage","classes","study","orgs","payroll","ai","shared-claude","acceptable-use","minors","parent-sign-off","third-party","donations","supporters","warranty","liability","ending","changes","law"]',1793890800000,'10.7.0.11','node');
INSERT INTO "orgs" ("id","name","kind","tz","state","workweek_start","status","settings","created_by","created_at","decided_at","note") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','Old Pool','nonprofit','America/Denver','CO',0,'active','{}','8999b019-4c41-45df-b1ec-f913d5da4346',1793890800000,1793890800000,NULL);
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','8999b019-4c41-45df-b1ec-f913d5da4346','owner','active',NULL,NULL,NULL,NULL,NULL,NULL,'{}','[]',1793890800000,NULL);
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','c8dd3a15-7382-418a-8514-25c06198bbe3','owner','active',NULL,NULL,NULL,NULL,NULL,NULL,'{}','[]',1793890800000,'NRBSTVQGNA3V');
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','0ef79899-1418-45f6-b401-989474fcbe16','admin','active',NULL,NULL,NULL,NULL,NULL,NULL,'{}','[]',1793890800000,'NRBSTVQGNA3V');
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','ad32f673-1da7-4eb4-8dd3-7bcc8c9486f5','manager','active',NULL,NULL,NULL,NULL,NULL,NULL,'{}','[]',1793890800000,'UJBEZ72YHZA5');
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','f2d4e00d-4c65-4611-a6d2-bba3f54af240','member','active','b24f3ec1-f678-46d9-a070-ee06e1728e8b','Guard',NULL,1500,NULL,NULL,'{}','[]',1793890800000,'4GGDJKJS5M9N');
INSERT INTO "org_members" ("org_id","account_id","role","status","department_id","title","birthdate","cost_rate","desired_min","desired_max","usual_week","prefs","joined_at","via_code") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','4005b42b-c6da-4f5c-9873-f0bd68254b6d','member','pending','b24f3ec1-f678-46d9-a070-ee06e1728e8b',NULL,NULL,NULL,NULL,NULL,'{}','[]',1793890800000,'4GGDJKJS5M9N');
INSERT INTO "org_member_positions" ("org_id","account_id","position_id") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','f2d4e00d-4c65-4611-a6d2-bba3f54af240','f3bd4506-5eea-4a4f-ba73-5bc9d3c75202');
INSERT INTO "org_member_positions" ("org_id","account_id","position_id") VALUES ('4c7bf4bc-c90a-4b73-9e02-29b451f29508','4005b42b-c6da-4f5c-9873-f0bd68254b6d','f3bd4506-5eea-4a4f-ba73-5bc9d3c75202');
INSERT INTO "org_codes" ("code","org_id","role","label","department_id","position_id","needs_approval","max_uses","uses","expires_at","revoked","created_by","created_at") VALUES ('NRBSTVQGNA3V','4c7bf4bc-c90a-4b73-9e02-29b451f29508','admin','admin',NULL,NULL,1,NULL,2,NULL,0,'8999b019-4c41-45df-b1ec-f913d5da4346',1793890800000);
INSERT INTO "org_codes" ("code","org_id","role","label","department_id","position_id","needs_approval","max_uses","uses","expires_at","revoked","created_by","created_at") VALUES ('UJBEZ72YHZA5','4c7bf4bc-c90a-4b73-9e02-29b451f29508','manager','manager',NULL,NULL,1,NULL,1,NULL,0,'8999b019-4c41-45df-b1ec-f913d5da4346',1793890800000);
INSERT INTO "org_codes" ("code","org_id","role","label","department_id","position_id","needs_approval","max_uses","uses","expires_at","revoked","created_by","created_at") VALUES ('4GGDJKJS5M9N','4c7bf4bc-c90a-4b73-9e02-29b451f29508','member','member','b24f3ec1-f678-46d9-a070-ee06e1728e8b','f3bd4506-5eea-4a4f-ba73-5bc9d3c75202',0,NULL,2,NULL,0,'8999b019-4c41-45df-b1ec-f913d5da4346',1793890800000);
INSERT INTO "org_departments" ("id","org_id","parent_id","name","cost_center_id","location_id","sort") VALUES ('4c82aea9-674c-47d0-8e96-dff9658025ca','4c7bf4bc-c90a-4b73-9e02-29b451f29508',NULL,'Aquatics',NULL,NULL,0);
INSERT INTO "org_departments" ("id","org_id","parent_id","name","cost_center_id","location_id","sort") VALUES ('b24f3ec1-f678-46d9-a070-ee06e1728e8b','4c7bf4bc-c90a-4b73-9e02-29b451f29508','4c82aea9-674c-47d0-8e96-dff9658025ca','Lessons',NULL,NULL,0);
INSERT INTO "org_departments" ("id","org_id","parent_id","name","cost_center_id","location_id","sort") VALUES ('4fe2a851-2b05-44d1-8970-e30279f8287a','4c7bf4bc-c90a-4b73-9e02-29b451f29508',NULL,'Front desk',NULL,NULL,0);
INSERT INTO "org_positions" ("id","org_id","name","department_id","tags","cost_rate","color") VALUES ('f3bd4506-5eea-4a4f-ba73-5bc9d3c75202','4c7bf4bc-c90a-4b73-9e02-29b451f29508','Lifeguard','4c82aea9-674c-47d0-8e96-dff9658025ca','[]',1650,NULL);
INSERT INTO "org_budgets" ("id","org_id","department_id","period_start","period_end","amount","label","note","created_by","created_at") VALUES ('533befb7-ae0b-4c75-a523-13de1310dd06','4c7bf4bc-c90a-4b73-9e02-29b451f29508','4c82aea9-674c-47d0-8e96-dff9658025ca','2026-12-01','2026-12-31',500000,'Original',NULL,'0ef79899-1418-45f6-b401-989474fcbe16',1793890800000);
INSERT INTO "org_cert_types" ("id","org_id","name","valid_months","positions","warn_days") VALUES ('e915d6d8-77ff-4699-8472-4c8042624973','4c7bf4bc-c90a-4b73-9e02-29b451f29508','Lifeguard cert',24,'["f3bd4506-5eea-4a4f-ba73-5bc9d3c75202"]','[60,30,7]');
INSERT INTO "org_certs" ("id","org_id","account_id","type_id","issued_on","expires_on","source","class_id","note","created_by","created_at") VALUES ('adf22c25-fdd8-4151-9b68-d0cfa13c7790','4c7bf4bc-c90a-4b73-9e02-29b451f29508','f2d4e00d-4c65-4611-a6d2-bba3f54af240','e915d6d8-77ff-4699-8472-4c8042624973','2026-01-10','2028-01-09','manual',NULL,NULL,'ad32f673-1da7-4eb4-8dd3-7bcc8c9486f5',1793890800000);
INSERT INTO "org_schedules" ("id","org_id","form_id","title","period_start","period_end","status","need_overrides","created_by","created_at","published_at") VALUES ('760bd0de-9ec2-44cd-a7f9-c9c98133e4d6','4c7bf4bc-c90a-4b73-9e02-29b451f29508',NULL,'Schedule 2026-12-01','2026-12-01','2026-12-31','published','{}','ad32f673-1da7-4eb4-8dd3-7bcc8c9486f5',1793890800000,1793890800000);
INSERT INTO "org_shifts" ("id","org_id","schedule_id","account_id","position_id","department_id","location_id","date","block_id","start_at","end_at","status","source","note","forced","created_at") VALUES ('bc537b5c-a237-4267-b659-e995c6e4daa7','4c7bf4bc-c90a-4b73-9e02-29b451f29508','760bd0de-9ec2-44cd-a7f9-c9c98133e4d6','f2d4e00d-4c65-4611-a6d2-bba3f54af240','f3bd4506-5eea-4a4f-ba73-5bc9d3c75202','4c82aea9-674c-47d0-8e96-dff9658025ca',NULL,'2026-12-02',NULL,1796227200000,1796241600000,'published','manual',NULL,0,1793890800000);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX members_account ON class_members(account_id);
CREATE INDEX class_sessions_start ON class_sessions(class_id, start_at);
CREATE INDEX questions_set ON questions(set_id, idx);
CREATE INDEX xp_class ON xp_events(class_id, at);
CREATE INDEX xp_account ON xp_events(account_id, day);
CREATE TRIGGER terms_no_update BEFORE UPDATE ON terms_versions BEGIN SELECT RAISE(ABORT, 'published terms never change'); END;
CREATE INDEX scan_jobs_status ON scan_jobs(status, created_at);
CREATE INDEX scan_jobs_account ON scan_jobs(account_id, created_at);
CREATE INDEX scan_requests_day ON scan_requests(account_id, day);
CREATE INDEX parent_consents_account ON parent_consents(account_id, created_at);
CREATE INDEX notifications_account ON notifications(account_id, id);
CREATE INDEX course_join_requests_course ON course_join_requests(course_key, status);
CREATE TRIGGER files_usage_ins AFTER INSERT ON files BEGIN UPDATE accounts SET used_bytes = used_bytes + NEW.size, file_count = file_count + 1 WHERE id = NEW.account_id; END;
CREATE TRIGGER files_usage_del AFTER DELETE ON files BEGIN UPDATE accounts SET used_bytes = used_bytes - OLD.size, file_count = file_count - 1 WHERE id = OLD.account_id; END;
CREATE TRIGGER files_usage_upd AFTER UPDATE OF size ON files BEGIN UPDATE accounts SET used_bytes = used_bytes - OLD.size + NEW.size WHERE id = NEW.account_id; END;
CREATE INDEX login_fail_pairs_at ON login_fail_pairs(last_at);
CREATE INDEX org_members_account ON org_members(account_id);
CREATE INDEX org_codes_org ON org_codes(org_id);
CREATE INDEX org_certs_person ON org_certs(org_id, account_id);
CREATE INDEX org_forms_org ON org_forms(org_id, period_start);
CREATE INDEX org_shifts_sched ON org_shifts(schedule_id);
CREATE INDEX org_shifts_person ON org_shifts(org_id, account_id, start_at);
COMMIT;
