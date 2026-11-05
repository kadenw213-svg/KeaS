# Developing KeaS

## Run and build

Needs Node 24.

| What | Command |
|---|---|
| Install dependencies (first time) | `npm install` (if Electron's download is skipped: `node node_modules/electron/install.js`) |
| Run the Kea Hub | `npm run hub`: API on 127.0.0.1:4860, owner console on 127.0.0.1:4861 |
| Run the KeaS app | `npm run desktop` |
| Build the Windows installer | `npm run desktop:build` → `%LOCALAPPDATA%\KeaBuild\KeaS\release\KeaS Setup <version>.exe` |
| All tests | `npm test` |
| Hub tests only | `npm run test:hub` |
| Workforce server with sample data | `node server/seed.mjs --reset`, then `npm run dev` and open http://127.0.0.1:5173 |
| Type-check the web app | `npm run typecheck` |

## The Hub

- **Data:** `hub/data/` (or `KEA_HUB_DATA`); account files in `KEA_HUB_STORAGE`.
- **Owner tools** (run on the Hub's own computer):
  - `node hub/owner.mjs make-owner <email>`;
  - `node hub/owner.mjs publish-terms` publishes `hub/terms/terms.json`. Keep each section's id when you only reword it; new sections get new ids. Everyone agrees again and sees only what changed.
  - `node hub/owner.mjs console owner/stats`.
- **Backups:** `node hub/backup.mjs create <folder>`, with `KEA_BACKUP_PASSPHRASE` set (sealed with AES-256-GCM).
- **Never tunnel port 4861.** The owner console must only ever be reachable on the Hub's own computer.

## Project layout

```
hub/            the Kea Hub: accounts, terms, classes, study, storage, shared-Claude queue and relay
hub/lib/        passwords, TOTP, tokens, limits, study scoring, Claude budget, Google sign-in
desktop/        the KeaS Windows app: setup wizard, Tailscale setup, tray
server/         the workforce server: schedules, punches, timecards, certifications, pay runs
shared/         labor-rule and tax tables (each records whether it's verified for the year)
web/            the workforce web app (Vite + React), served by the workforce server
test/           node:test suites for the Hub and the workforce server
```

## Payroll rule

A pay run can be finalized only with tax and labor tables verified for that year (`verified` / `verifiedFor` in `shared/`).
