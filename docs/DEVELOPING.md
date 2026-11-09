# Developing KeaS

## Run and build

Needs Node 24.

| What | Command |
|---|---|
| Install dependencies (first time) | `npm install` (if Electron's download is skipped: `node node_modules/electron/install.js`) |
| Run the KeaS server | `npm run hub`: API on 127.0.0.1:4860, owner console on 127.0.0.1:4861 |
| Run the KeaS app | `npm run desktop` |
| Build the Windows installer | `npm run desktop:build` → `%LOCALAPPDATA%\KeaBuild\KeaS\release\KeaS Setup <version>.exe` |
| All tests | `npm test` |
| Server tests only | `npm run test:hub` (and `npm run test:legacy` for the Kea Hub of KeaS 0.5) |
| Org engine tests only | `npm run test:org` |
| Workforce server with sample data | `node server/seed.mjs --reset`, then `npm run dev` and open http://127.0.0.1:5173 |
| Type-check the web app | `npm run typecheck` |

## The KeaS server (`hub/`)

Every KeaS PC runs its organization's server (`hub/index.mjs`; the folder keeps its old name). People sign in with
their Kea accounts on KeaC (the Kea account server) through passes: `docs/protocol.md` sections 2 and 7. KeaS has no
passwords, two-step codes, sign-up, terms or personal storage of its own.

- **Run it:** `npm run hub` (API on 127.0.0.1:4860, which Tailscale Funnel forwards; owner console on 127.0.0.1:4861,
  never tunneled). Data: `hub/data/` (or `KEA_HUB_DATA`): `keas.db`, `server-identity.pem` (its Ed25519 key; the
  server id is base64url(SHA-256(raw public key)) cut to 22), `owner.key` (the owner console's HMAC key),
  `org-data.key` (seals pay code rates and stubs), `member-files/`, and `setup.secret` until someone sets it up.
- **KeaC:** its address is `KEAC_URL` (or the KeaS app's settings, or the address confirmed at setup; `KEAC_URL` in
  `hub/lib/keac.mjs` is the built-in one, not known yet). Its key: built in (`KEAC_KEYS`, empty until KeaC's key is
  published), `KEAC_KEY` (a JWK as JSON), or the one the owner confirmed by fingerprint (`/owner/keac/offer`,
  `/owner/keac/pin`: trust on first use, compared with KeaC's Keys screen). The key list (`<KeaC>/v1/keys`) is fetched
  at start and every 6 hours and taken only when it still has a trusted key, so rotations (KeaC's `next` keys) are
  followed and a look-alike at the address isn't. The last good list is kept, so passes keep checking out while KeaC
  is down. Revocation: hourly `?since=` (a minute of overlap) and a daily full list; revoked accounts' sessions end.
- **Passes** (`hub/lib/keac.mjs checkPass`): EdDSA, a known `kid`, the signature, `iss: 'kea'`, `aud: 'keas:<serverId>'`,
  `exp` in the future, `iat` no more than 2 minutes ahead, at most 8 days long, `sub` and `ev: true`, not revoked. Then a
  KeaS session (hashed, 30 days; a newer pass sent with it renews it) and the member row (`keas_members`: name and email
  from the newest pass). `org/identity.mjs passIdentity` is the org engine's adapter over it.
- **Setting up a fresh server** happens only at the owner console (loopback, HMAC with `owner.key`): `POST /owner/claim
  { pass, secret }` with the one-time setup code (`setup.secret`, shown in the KeaS app on this PC, or
  `node hub/owner.mjs setup-code`). Whoever claims it is its operator: they make organizations (others only when the
  operator allows: `POST /owner/settings { orgs: { anyoneCreates, autoApprove } }`).
- **Owner console** (what the KeaS app needs): `/owner/stats`, `/owner/claim`, `/owner/settings`, `/owner/keac`,
  `/owner/keac/offer`, `/owner/keac/pin`, `/owner/keac/refresh`, `/owner/payroll-token`, `/owner/members` (and
  `/:id/sign-out`, `/:id/forget`), `/owner/audit`, and the org engine's `/owner/orgs/*`.
- **Members' files:** `/v1/files/*` as the Kea Hub had it (If-Match versions, paths checked), for members of an active
  organization; each organization's `settings.filesQuotaGb` (1 by default; the biggest of a member's organizations).
- **Owner tools:** `node hub/owner.mjs console GET owner/stats | setup-code | rotate-key | server-id | where`.
- **Backups:** `node hub/backup.mjs create <folder>` with `KEA_BACKUP_PASSPHRASE` (keas.db, a Kea Hub's hub.db if it's
  still there, and the keys). **Never tunnel port 4861.**
- **Bringing in an org server's people and time clock:** `node hub/import-org-server.mjs --server <org.db> --org <orgId> --dry-run` (people are matched to members who signed in here, by linked Kea account, then email).

### A PC that was the Kea Hub (KeaS 0.5)

- While its data folder still holds the Kea accounts (`hub.db` with an accounts table, no `moved-to-keac.json`), KeaS
  0.6 runs the Kea Hub exactly as 0.5 did (`hub/legacy/`, chosen by `hub/index.mjs openServer`; its tests are
  `test/legacy/`), and says "Your Kea accounts are still here. Move them to your Kea account server, then this PC
  becomes your organization's server." Updating KeaS (by hand or at night) over such a PC is safe for that reason.
- **The marker:** `moved-to-keac.json` in the data folder, `{ "at": <ms>, "keacUrl": <string or null>, "keacKeyKid":
  <string or null> }`, written by KeaC's migration or by "My Kea accounts have moved" in the KeaS app.
- Then `hub/upgrade.mjs` makes `keas.db` from a copy of `hub.db` (the organization side; references to accounts taken
  out of those tables' definitions; members' names from the accounts; the Hub's owner becomes the operator), copies
  `hub.db` to `keas-0.5-archive/hub.db`, and writes `keas-upgrade-report.json`. `hub.db`, `hub-signing-key.pem` and
  `storage/` are never changed, moved or deleted (clean them up by hand later). When `keacKeyKid` is the kid of this
  folder's own `hub-signing-key.pem` (KeaC took that key over to sign passes), it's trusted as KeaC's key at once.
- After the move the old account routes answer 410 `{ error: 'Kea accounts moved', movedTo, keacKeyKid }` and
  `/v1/health` carries `movedTo` and `keacKeyKid`, so Kea apps still pointed here can follow.
- Organization members keep their ids (KeaC's migration keeps the Hub's account ids) and sign in again once with a pass.
- The payroll vault set up with the Hub's key moves to the server's own key by itself (it reads it from the data folder).

## The org engine (`org/`)

One module for organizations that any KeaS server mounts: `mountOrg({ R, h, now, audit, notify, identity })` (`org/index.mjs`). The KeaS server mounts it with members from passes as the identity (`org/identity.mjs passIdentity`); the Kea Hub of KeaS 0.5 (`hub/legacy/`) with its accounts.

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
  - **Rate history:** `POST /v1/orgs/:id/pay-codes/:cid { rate, effectiveFrom }` (today when no date; on or before the
    day the code was made it's the first rate). Hours are paid at the rate in effect on the day worked; the pay feed
    sends each code's `rates: [{ from, rateCents }]` and the vault pays each day by it. A change not started yet can be
    taken back: `POST .../pay-codes/:cid/rates/:from/delete`. Each change is sealed for its code and date.
  - Shifts and punches carry `pay_code_id`. A shift given to someone gets their default code (schema triggers); one that
    changes hands keeps its code only if the new person has it. Clocking in takes `payCodeId` (one of yours), else the
    shift's code, else your default; a clock-out carries its clock-in's. Switching a punch's code is recorded in
    `org_punch_codes` (punches never change) and stops once that timecard is approved. Shifts and punches from before pay
    codes have none and are paid at the person's default.
  - **Rates are sealed**, AES-256-GCM with the server's org data key (`server/lib/vault.mjs` seal), bound to the code's id.
    The host passes the key to `mountOrg({ dataKey })`. The KeaS server keeps it in its data folder as `org-data.key` (64 hex
    characters, made on first start, readable by the server's Windows account only, locked down with the folder, listed in
    `SECRET_FILES` and carried in backups). It's the server's key, not payroll's: the server opens rates while it runs, with
    no payroll passphrase. It's never rotated with the server's other keys (rates sealed with it open only with it). A host with
    no key runs everything but pay codes.
  - **The payroll guard** (`org/payroll.mjs`): every org route refuses SSNs, bank details, tax ids, W-4s, direct deposits,
    paychecks and pay runs anywhere in a body, and pay rates too. The pay code routes are mounted with `{ rates: true }`:
    rate words pass, everything else is still refused.
- **Upgrades:** `org/schema.mjs migrateOrg` upgrades a 0.5 database in place (each fixed role becomes its template), and
  a version 2 database to 3 (pay code columns on shifts and punches; the Admin template gains the pay code abilities). `test/fixtures/hub-0.5.0-orgs.sql` is a Hub database made by 0.5.0's code, for the upgrade test.

## Project layout

```
hub/            the KeaS server: passes from Kea accounts, sessions, files, the org engine mounted, the owner console
hub/lib/        Kea account keys and revocations, tokens, limits, names, the server's log
hub/legacy/     a KeaS 0.5 Kea Hub, run only for a data folder whose accounts haven't moved yet
org/            the org engine: members, roles and abilities, structure, forms, schedules, swaps, the time clock, pay codes
desktop/        the KeaS Windows app: setup wizard, Tailscale setup, tray
server/         the payroll vault (pay runs, HR), and the workforce server for development
shared/         labor-rule and tax tables (each records whether it's verified for the year)
web/            the payroll and workforce web app (Vite + React)
test/           node:test suites for the server, the legacy Hub, the org engine, the vault and the app
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
- **Sign-in:** the Kea account plus the passphrase. The KeaS app signs in to the KeaS server on this PC with a pass
  (`desktop/keas.cjs`) and gets a 15-minute token for the audience `keas-payroll` from the server's owner console
  (`/owner/payroll-token`, for that session), signed with the server's identity key and issued as `keas:<serverId>`;
  the vault checks it against that key, read from the data folder on this PC (`serverIssuer`, `hubTrustKeys`). This is
  safer than handing the vault a KeaC pass: the token lasts 15 minutes instead of 7 days, can't be used as a pass, is
  only made on this PC with the owner key for a live (not revoked) session, and adds no new key the vault must trust.
  "Ask for my sign-in every time" gets a fresh Google or Microsoft sign-in at KeaC (in the system browser, loopback +
  PKCE, `desktop/oauth.cjs`; the KeaC owner's account also gives its two-step code), a pass, a session just for that token,
  then ends it. No password goes through the vault (`/v1/vault/setup` and `/v1/vault/signin` with `mode: 'hub'` answer
  410 when `serverIssuer` is set). A local password still works only while the server can't be reached, if the owner
  turned it on. While the PC is still a Kea Hub, payroll signs in at that Hub as before (`desktop/legacy-account.cjs`).
- **Stubs to members:** finalizing a pay run publishes each linked person's stub to the org engine
  (`POST /v1/orgs/:id/stubs`, `org/stubs.mjs`: sealed for that member with a key derived from the org data key and
  their account id; they see their own in `GET /v1/orgs/:id/me/pay` `stubs` and `/me/stubs/:id`, nobody else ever does;
  SSN- and bank-shaped values refused). `POST /v1/payrun/publish-stubs` sends them again.
- **The workforce server** (`npm run dev`) runs the same payroll and HR code on its sample data with its vault opened
  by a passphrase kept next to the database (`<db>.vaultkey`, development only: `devKeyFile`), so every screen can be
  tried there.
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
