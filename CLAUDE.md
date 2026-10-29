# KeaS

Scheduling, time clock, certifications and payroll prep for any workplace. Separate from Kea (the office/school app); Kea only keeps trainings and in-services in its LMS.

- **Plan:** `docs/plan.md`. Research: `docs/research/`.
- **Layout:** `server/` (plain Node 24, `node:http` + `node:sqlite`, no runtime deps), `shared/labor` and `shared/tax` (editable JSON tables), `web/` (Vite + React PWA the server serves), `test/server/` (`npm run test:server`).
- **Run:** `npm install`, `node server/seed.mjs --reset`, `npm run dev`, open http://127.0.0.1:5173.
- **Rules**
  - Prototype branch `prototype/work-server`. Commit locally only; never push or release without asking. The GitHub repo is public.
  - Payroll safety: tax tables stay `verified: false` and a pay run can't be finalized until that year's tables are checked against official sources.
  - Nothing specific to one org, state or industry is hard-coded. It goes in packs and org settings.
  - Attendance is flags only; protected leave never counts, and a manager decides.
  - KeaS calculates and prepares; it never holds or moves money or files for the employer.
