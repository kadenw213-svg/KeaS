# KeaS

Scheduling, time clock, certifications and payroll prep for any workplace. Separate from Kea (the office/school app); Kea only keeps trainings and in-services in its LMS.

- **Plans and research** are kept privately in the owner's Kea workspace (`D:\Kea`, see the last line), not in this public repo.
- **Layout:** `org/` (the org engine: members, custom roles with abilities, schedules, the time clock, pay codes with sealed rates; mounted by the Hub with `mountOrg`, see `docs/DEVELOPING.md`), `server/` (plain Node 24, `node:http` + `node:sqlite`, no runtime deps), `shared/labor` and `shared/tax` (editable JSON tables), `web/` (Vite + React PWA the server serves), `test/server/` (`npm run test:server`).
- **Run:** `npm install`, `node server/seed.mjs --reset`, `npm run dev`, open http://127.0.0.1:5173.
- **Rules**
  - Work on `main`. Never push or release without asking. The GitHub repo is public: no private plans, personal details or secrets in it.
  - Payroll safety: tax tables stay `verified: false` and labor files `verifiedFor: null`, and a pay run can't be finalized until that year's tables are checked against official sources.
  - Nothing specific to one org, state or industry is hard-coded. It goes in packs and org settings.
  - Attendance is flags only; protected leave never counts, and a manager decides.
  - KeaS calculates and prepares; it never holds or moves money or files for the employer.
- **Kea Hub** (`hub/`): the central accounts/classes/study server that runs on the owner's PC. `npm run hub` (API on 127.0.0.1:4860, which gets tunneled; owner console on 127.0.0.1:4861, which is never tunneled). Data lives in `hub/data/` (git-ignored) or `KEA_HUB_DATA`. Owner tools: `node hub/owner.mjs make-owner <email> | console owner/stats`. Encrypted backups: `node hub/backup.mjs create <folder> [--payroll <payroll-vault.db>]` with `KEA_BACKUP_PASSPHRASE` (restore: `restore <file> <empty-folder> [--payroll-dir <folder>]`). Tests: `npm run test:hub`; `npm test` runs everything.
- **KeaS desktop** (`desktop/`): the downloadable app. `npm run desktop` (dev), `npm run desktop:build` (installer goes to `%LOCALAPPDATA%\KeaBuild\KeaS\release`). The first run is a setup wizard: Hub or org server, then the data drive or folder, then Tailscale Funnel (installed with winget, sign-in, Funnel turned on), then the owner account with two-step sign-in. After setup it runs the server in-process, sits in the tray, and starts with Windows. Electron has no Argon2 (BoringSSL), so passwords there use scrypt. Test hooks: `KEAS_USERDATA` (a separate profile; never touches Kea's settings or Windows startup), plus `KEAS_CAPTURE` and `KEAS_EVAL`.
- **Plans, decisions and memory for Kea + KeaS + the Kea Hub** live in the Kea workspace on the owner's thumb drive (`D:\Kea`, its `CLAUDE.md` and `context/status.md`). Start planning chats there; this repo holds the code.
