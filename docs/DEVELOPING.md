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
- **One account** (`console GET owner/accounts/<email>` shows everything below). Each change is audited and sends the person a notification; add `"note"` for a line of your own.
  - Storage: `console POST owner/accounts/<email>/quota '{"gb":5000}'`; `{"gb":null}` goes back to the standard size.
  - Shared Claude: `console POST owner/accounts/<email>/claude '{"limits":{"perAccountWeekly":20}}'`. Any limit in `ACCOUNT_LIMITS` (`hub/lib/budget.mjs`) can be set; `null` goes back to the Hub-wide number. `{"trusted":true}` lifts their own caps, `{"blocked":true,"reason":"…"}` turns it off for them, and `{"reset":true}` clears everything.
  - Supporter: `console POST owner/accounts/<email>/supporter '{"months":1}'` (renewing adds to the end), `{"until":"2027-06-01"}`, or `{"end":true}`. It gives supporter storage and a badge only; it never changes shared-Claude limits.
  - A notice: `console POST owner/accounts/<email>/notify '{"title":"…","body":"…"}'`.
- **Storage sizes:** `console POST owner/settings '{"storage":{"defaultGb":5,"supporterGb":25}}'`. The standard size is 5 GB and a supporter's 25 GB unless set here. A smaller size never deletes anything: people over it can't add files until they're under it again.
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

## The payroll vault

- **Run it:** in the KeaS app, **Payroll** (tray menu or the status page) starts `server/index.mjs` in vault mode on
  127.0.0.1 (a free port) and opens it in a KeaS window. Data: `%APPDATA%\KeaS\Payroll\payroll-vault.db` (or
  `payrollDir` in `keas-config.json`). Without the app: `KEAS_VAULT=1 KEAS_HUB_URL=http://127.0.0.1:4860 KEA_DB=<file> npm run server:dev`.
- **Encryption:** AES-256-GCM with a key derived from the vault passphrase by scrypt (`server/lib/vault.mjs`). SSNs
  and addresses (`people.pii_enc`), bank details (`people.deposit`, `orgs.bank`, `legal_entities.bank_enc`), signed
  forms, I-9 Section 2 and documents are sealed. The key is only in memory while the vault is open; closing the
  Payroll window stops the server. Changing the passphrase re-encrypts every sealed column.
- **Sign-in:** the Kea Hub account (the vault relays the password to the Hub once, gets an Ed25519 token for the
  audience `keas-payroll` and checks it with the Hub's `/v1/keys`) plus the passphrase; a local account
  (scrypt) works when the Hub can't be reached.
- **The workforce server** (`npm run dev`) runs the same payroll and HR code on its sample data with its vault opened
  by a passphrase kept next to the database (`<db>.vaultkey`), so every screen can be tried there.
- **Code:** `server/payroll/` (one module per area: vault sign-in, approvals, org structure, pay structure, leave,
  pay run, onboarding, documents and expenses, reports, import, year-end, hiring and performance), screens in
  `web/src/screens/`, tests in `test/server/payroll.test.mjs` and `test/server/vault.test.mjs`.

## Payroll rule

A pay run can be finalized only with tax and labor tables verified for that year (`verified` / `verifiedFor` in `shared/`).
