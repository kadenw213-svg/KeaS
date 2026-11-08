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
- **KeaS server** (`hub/`): each organization's server, run by the KeaS app. People sign in with Kea accounts (KeaC) through passes (`docs/protocol.md`, `hub/lib/keac.mjs`); KeaS keeps no passwords. `npm run hub` (API 127.0.0.1:4860, tunneled; owner console 127.0.0.1:4861, never tunneled). A data folder that was a KeaS 0.5 Kea Hub keeps running the Hub (`hub/legacy/`) until `moved-to-keac.json` is there; then `hub/upgrade.mjs` makes `keas.db` from a copy and never touches the Hub's files. Tests: `npm run test:hub`, `npm run test:legacy`; `npm test` runs everything.
- **KeaS desktop** (`desktop/`): the downloadable app. `npm run desktop` (dev), `npm run desktop:build`. Setup: the data folder, the Kea account server (its key checked by fingerprint), sign in with the Kea account, set up this server with its setup code, the organization, where people work, Tailscale Funnel, then Get set up (one list with Payroll's own steps). The home screen has pay codes, roles and people. Test hooks: `KEAS_USERDATA`, `KEAS_CAPTURE`, `KEAS_EVAL`.
- **Plans, decisions and memory for Kea + KeaS + the Kea Hub** live in the Kea workspace on the owner's thumb drive (`D:\Kea`, its `CLAUDE.md` and `context/status.md`). Start planning chats there; this repo holds the code.
