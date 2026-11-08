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
| Org engine tests only | `npm run test:org` |
| Workforce server with sample data | `node server/seed.mjs --reset`, then `npm run dev` and open http://127.0.0.1:5173 |
| Type-check the web app | `npm run typecheck` |

## The Hub

- **Running the Hub from the KeaS app (the owner only):** start KeaS with `--host-hub` (for example
  `KeaS.exe --host-hub`, or `npm run desktop -- --host-hub`). That opens the Hub setup wizard; nothing else in KeaS
  leads there. Once a PC runs a Hub (setup finished), KeaS shows the Hub's status page without the switch. Everyone
  else gets "Sign in to Kea" / "Create an account" (the Hub address is under Advanced; `desktop/account.cjs`).
  Setup remembers its step (`setupStep` in `keas-config.json`), so it picks up where it stopped.
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
- **Bringing in an org server's people and time clock:** `node hub/import-org-server.mjs --server <org.db> --org <orgId> --dry-run` shows what would come in (people are matched to Kea accounts by the account their payroll sign-in is linked to, then by email); without `--dry-run` it imports. `KEAS_VAULT_PASSPHRASE` is that server's vault passphrase. Running it again only adds what's missing.

## The org engine (`org/`)

One module for organizations that any KeaS server mounts: `mountOrg({ R, h, now, audit, notify, identity })` (`org/index.mjs`). The Hub mounts it with its accounts as the identity (`hub/orgIdentity.mjs`).

- **Roles** (`org/roles.mjs`): a role is a name and a list of abilities. Owner, Admin, Manager and Member are templates every org gets, with what the fixed roles of KeaS 0.5 could do. A role is given for the whole org or for chosen departments (and every team under them). Every check is `can(ability, department)`; to give a role, make a code for it, or change or remove someone, you must outrank them. Owners have every ability and the last owner can't go. `GET /v1/orgs/:id` tells each person their `me.abilities` and `me.scopes`; `role` is still there for older Kea (the highest template they have org-wide).
- **Roles API:** `GET/POST /v1/orgs/:id/roles`, `POST /v1/orgs/:id/roles/:rid` (change), `POST /v1/orgs/:id/roles/:rid/delete`, `GET/POST /v1/orgs/:id/members/:aid/roles` (`{ roleId, scope: 'org' | [departmentIds] }`), `POST /v1/orgs/:id/members/:aid/roles/:rid/delete`.
- **Time clock** (`org/clock.mjs`): `POST /v1/orgs/:id/clock` (`{ type: 'in' | 'out' }`), `GET .../clock`, `.../clock/today`, `.../clock/alerts`, `.../punch-requests` (and `/:rid/decide`), `.../timecards`, `.../timecards/period`, `.../timecards/approve`, `approve-many`, `unapprove`, `.../time-off` (and `/:tid/cancel`, `/:tid/decide`). Punches are append-only. Pay periods are the org's `settings.clock` (7 or 14 days from an anchor date).
- **Pay codes** (`org/paycodes.mjs`): a code is a job's pay rate (Lifeguard $15, Swim instructor $18). `paycodes.manage`
  makes and changes codes (org-wide only), `paycodes.assign` gives them to people and sets each person's default (never to
  yourself unless you're an owner), `rates.view` sees other people's rates; Admin and Owner have all three. Everyone
  always sees their own codes, rates and hours by code (`GET /v1/orgs/:id/me/pay`) and never a code they weren't given.
  - Routes: `GET/POST /v1/orgs/:id/pay-codes`, `POST /v1/orgs/:id/pay-codes/:cid` (name, rate, color, active,
    departmentId, positionId), `.../pay-codes/:cid/delete` (only a code never used; otherwise turn it off),
    `GET/POST /v1/orgs/:id/members/:aid/pay-codes` (`{ codeId, default }`), `.../pay-codes/:cid/default`,
    `.../pay-codes/:cid/delete`, `POST /v1/orgs/:id/shifts/:shid/pay-code` and `POST /v1/orgs/:id/punches/:pid/pay-code`
    (`{ payCodeId }`), `GET /v1/orgs/:id/pay-feed?from=&to=` (what payroll pays from; `rates.view` and `timecards.view`
    for the whole organization).
  - Shifts and punches carry `pay_code_id`. A shift given to someone gets their default code (schema triggers); one that
    changes hands keeps its code only if the new person has it. Clocking in takes `payCodeId` (one of yours), else the
    shift's code, else your default; a clock-out carries its clock-in's. Switching a punch's code is recorded in
    `org_punch_codes` (punches never change) and stops once that timecard is approved. Shifts and punches from before pay
    codes have none and are paid at the person's default.
  - **Rates are sealed**, AES-256-GCM with the server's org data key (`server/lib/vault.mjs` seal), bound to the code's id.
    The host passes the key to `mountOrg({ dataKey })`. The Kea Hub keeps it in its data folder as `org-data.key` (64 hex
    characters, made on first start, readable by the Hub's Windows account only, locked down with the folder, listed in
    `SECRET_FILES` and carried in backups). It's the server's key, not payroll's: the Hub opens rates while it runs, with no
    payroll passphrase. It's never rotated with the Hub's other keys (rates sealed with it open only with it). A host with
    no key runs everything but pay codes.
  - **The payroll guard** (`org/payroll.mjs`): every org route refuses SSNs, bank details, tax ids, W-4s, direct deposits,
    paychecks and pay runs anywhere in a body, and pay rates too. The pay code routes are mounted with `{ rates: true }`:
    rate words pass, everything else is still refused.
- **Upgrades:** `org/schema.mjs migrateOrg` upgrades a 0.5 database in place (each fixed role becomes its template), and
  a version 2 database to 3 (pay code columns on shifts and punches; the Admin template gains the pay code abilities). `test/fixtures/hub-0.5.0-orgs.sql` is a Hub database made by 0.5.0's code, for the upgrade test.

## Project layout

```
hub/            the Kea Hub: accounts, terms, classes, study, storage, shared-Claude queue and relay
hub/lib/        passwords, TOTP, tokens, limits, study scoring, Claude budget, Google sign-in
org/            the org engine: members, roles and abilities, structure, forms, schedules, swaps, the time clock, pay codes
desktop/        the KeaS Windows app: setup wizard, Tailscale setup, tray
server/         the workforce server: schedules, punches, timecards, certifications, pay runs
shared/         labor-rule and tax tables (each records whether it's verified for the year)
web/            the workforce web app (Vite + React), served by the workforce server
test/           node:test suites for the Hub, the org engine and the workforce server
```

## The payroll vault

- **Hours come from the org engine.** The KeaS app starts the vault with `engineFeed` (`desktop/payroll.cjs`): before
  each pay run, stub, bank file, GL journal or report for a period, the vault asks the organization's pay feed through the
  signed-in Kea account (`GET /v1/orgs/:id/pay-feed`, `server/payroll/engine.mjs`). Members are matched to vault people by
  Kea account id (`people.kea_account_id`; then a payroll sign-in linked to that account, then email), and added when
  new. Their timecards are worked out from the engine's punches under the vault's labor rules, approved when the engine
  approved every timecard period the pay period touches, and paid at each stretch's pay code rate. The vault keeps only
  what's sensitive (SSNs, bank details, W-4s, tax settings, pay runs, stubs, time-off balances). Without `engineFeed`
  (`npm run dev` and the tests) it pays its own sample people, shifts and punches.
- **Pay types** (`server/payroll/run.mjs lineFor`), each its own line with hours and rate: regular (one line per pay
  code), overtime and double time (straight time at each code's rate plus the premium on the weighted-average regular
  rate, with the working: "Regular rate $16.20 = $810.00 ÷ 50 h", "Overtime 10 h x 0.5 x $16.20 premium = $81.00", and why
  it's overtime under which rules), shift differentials, missed rest-break pay, holiday, worked-holiday premium, paid
  time off, sick pay (a policy of kind `sick`), bonus (`POST /v1/earnings/bonus`; non-discretionary bonuses count in the
  regular rate), and the other extra earnings (retro, payouts, reimbursements). The stub PDF shows the working and the
  hours by pay code.
- **The organization server mode is retired.** KeaS 0.5 could run `server/` on a PC as an organization server (`role:
  'org'`, its own people and punches). The app no longer starts it: organizations live in the org engine, and a PC set up
  that way says so. `server/` without `vault` stays as the development workforce server (`npm run dev`) and for tests.

- **Run it:** in the KeaS app, **Payroll** (tray menu or the status page) starts `server/index.mjs` in vault mode on
  127.0.0.1 (a free port) and opens it in a KeaS window. Data: `%APPDATA%\KeaS\Payroll\payroll-vault.db` (or
  `payrollDir` in `keas-config.json`). Without the app: `KEAS_VAULT=1 KEAS_HUB_URL=http://127.0.0.1:4860 KEA_DB=<file> npm run server:dev`.
- **Encryption:** AES-256-GCM with a key derived from the vault passphrase by scrypt (`server/lib/vault.mjs`). SSNs
  and addresses (`people.pii_enc`), bank details (`people.deposit`, `orgs.bank`, `legal_entities.bank_enc`), signed
  forms, I-9 Section 2 and documents are sealed by the code. Pay amounts, birthdates and emails (`SEALED_VALUES` in
  `server/payroll/schema.mjs`) are sealed by triggers as they're written and opened by `server/db.mjs` as they're
  read, so nothing may filter or sum them in SQL. The key is only in memory while the vault is open; closing the
  Payroll window stops the server. Changing the passphrase re-encrypts every sealed column.
- **Sign-in:** the Kea Hub account (the vault relays the password to the Hub the KeaS app names, never one a
  request names, gets an Ed25519 token for the audience `keas-payroll` and checks it against the Hub key pinned at
  setup) plus the passphrase. A local password (16+ characters, scrypt) works only while the Hub can't be reached,
  and only if the owner turned it on in the KeaS app. Wrong tries are limited per account and address.
- **The workforce server** (`npm run dev`) runs the same payroll and HR code on its sample data with its vault opened
  by a passphrase kept next to the database (`<db>.vaultkey`, development only: `devKeyFile`), so every screen can be
  tried there. The KeaS app passes an organization server's passphrase in memory, kept with Windows DPAPI.
- **Code:** `server/payroll/` (one module per area: vault sign-in, approvals, org structure, pay structure, leave,
  pay run, onboarding, documents and expenses, reports, import, year-end, hiring and performance), screens in
  `web/src/screens/`, tests in `test/server/payroll.test.mjs` and `test/server/vault.test.mjs`.

## Payroll rule

A pay run can be finalized only with tax and labor tables verified for that year (`verified` / `verifiedFor` in `shared/`).

## Labor files (`shared/labor`)

- `US.json` (federal default), the states with daily overtime or double time (`CA`, `AK`, `NV`, `CO`), and the states
  with paid sick leave laws (`CA`, `WA`, `OR`, `AZ`, `NJ`, `NY`, `MA`, `CT`, `MD`, `MI`, `MN`, `IL`, `NM`, `VT`, `RI`,
  `CO`, and `NV`'s paid leave). Every one is `verifiedFor: null` with `status: "unverified"`, its official sources, and a
  note on what isn't certain. Nothing in the code ever marks one verified; the setup checklist shows them as unverified.
  State minimum wages aren't filled in (only the federal one is checked until they are).
- Overtime rule shape: `weeklyHours`, `dailyHours`, `consecutiveHours`, `multiplier`, `combine` (`greater`: whichever of
  daily or weekly gives more, the default; `union`: daily first, then weekly on the hours left regular, as California),
  `seventhDay: { otFirstHours }`, `doubleTime: { dailyHours, seventhDayAfterHours, multiplier }` (`server/lib/rules.mjs`).
- Sick leave shape: `law`, `accrueHoursPer`, `cap` (with `capKind`), `balanceCap`, `carryoverCap`, `frontloadHours`,
  `waitingDays`, `employerSize`, `note`. `suggestSickPolicy` (`server/payroll/leave.mjs`) turns it into a suggested
  policy (`GET /v1/pto/suggestions`, `suggested` on `GET /v1/pto/policies`, and the checklist's "Paid sick leave policy"
  step); the owner checks and edits it before saving.
