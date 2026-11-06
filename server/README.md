# KeaS workforce server

The organization server: schedules, punches, timecards, certifications and pay-run preparation. It listens on 127.0.0.1.

- **Development data:** `node server/seed.mjs` loads a sample workplace, and `demo-login` signs in as one of its people.
- **Payroll safety:** a pay run is finalized only with tax and labor tables verified for that year (`verified` / `verifiedFor`). Until then every pay-run response has `canFinalize:false`.

## Run

```
npm run server:dev                 # http://127.0.0.1:4850  (KEA_PORT overrides, KEA_DB overrides the db file)
node server/seed.mjs --reset       # wipe server/data/demo.db and reseed around today
npm run test:server                # node --test "test/server/*.test.mjs"
```

The db (`server/data/demo.db`, git-ignored) is seeded automatically when empty. Seed dates are relative to the day it runs: the last *completed* biweekly pay period is the two weeks before the current week, the current period is this week + next week.

No dependencies: `node:http`, `node:sqlite`, `node:test` (Node 24).

## Auth

`POST /v1/auth/demo-login {personId}` → `{token, expiresAt, person}`. Send `Authorization: Bearer <token>` on every other call. Tokens are 32 random bytes (hex), stored as sha256, valid 12 h. Roles: `member`, `manager`, `payroll`, `owner` (owner passes every role check). Errors are `{error, ...}` with 400/401/403/404/409/413.

**Web app (cookie session).** `demo-login` also sets `keas_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (plus `Secure` over https / `X-Forwarded-Proto: https`). Auth accepts the bearer header *or* that cookie. `POST /v1/auth/logout` deletes the session and clears the cookie (works even after expiry). CSRF: a cookie-authenticated POST must send `X-KeaS: 1`; any non-bearer POST (including demo-login) with a cross-site `Origin` or `Sec-Fetch-Site` is refused with 403. Bearer clients are unaffected.

**Static files.** Everything outside `/v1` is the built web app from `web/dist` (`KEAS_WEB_DIR` overrides): index.html fallback for extension-less client routes, strict CSP on HTML/SVG, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, `/assets/*` cached immutable, index.html / sw.js / manifest `no-cache`. Paths with `..`, `\`, NUL or anything resolving outside the folder are 404. If the app isn't built, pages return 503 with a hint to run `npm run web:build`.


## Endpoints (all JSON, under /v1)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | /health | public | `{ok, version, minClient}` |
| GET | /auth/demo-users | public | `[{id,name,roles,positions,status}]` |
| POST | /auth/demo-login | public | `{personId}` |
| POST | /auth/logout | any | |
| GET | /me | any | `{person, certs, org, period:{current,lastCompleted}}` |
| GET | /org | any | `{org, positions, certTypes, people, period, rules}`; birthdate/pay/age/minor/certs only for manager/payroll/owner |
| GET | /shifts?from&to | any | members: published + own; managers: all incl. draft |
| POST | /shifts[?force=1&reason=] | manager | create/update; 409 `{problems}` if blocked |
| POST | /shifts/check | manager | live check of an unsaved shift, always 200 `{problems}` |
| POST | /shifts/publish | manager | `{from,to}` dates |
| POST | /shifts/:id/check | manager | `{personId}` → `{problems}` |
| GET/POST | /swaps | any | offer `{shiftId}` (own shift) |
| POST | /swaps/:id/claim | any member | eligibility checked |
| POST | /swaps/:id/decide | manager | `{approve}` |
| POST | /punches | any | `{type:'in'|'out', restAttested?}`, server time |
| GET | /status/today | any | managers: everyone; members: own |
| GET | /alerts | manager | late / no-show at start + threshold |
| GET/POST | /punch-requests | any | reasonCode `forgot|device|early_late_fix|other` |
| POST | /punch-requests/:id/decide | manager | approve appends a punch `source:'request:<id>'` |
| GET | /timecards?personId&periodStart | own / manager / payroll | default = current period |
| POST | /timecards/approve | manager | `{personId, periodStart}` |
| GET | /payrun/preview?periodStart | payroll | default = last completed period; money in integer cents |
| GET | /payrun/nacha?periodStart | payroll | `{text, note}`: the direct-deposit file for review (KeaS never sends it) |

## Rules engine

- `server/lib/rules.mjs` — `mergeRules` (strictest wins), `timecard` (CO weekly-40 vs daily-12/12-consecutive, whichever gives more OT, minute-level so nothing is counted twice; rest-break premium; late/no-show/missed-punch flags), `checkAssignment` (overlap, certs, minimum/position ages, minor hours and times, OT look-ahead).
- `server/lib/pay.mjs` — gross, FICA, federal Worksheet 1A, Colorado DR 1098, FAMLI, FUTA, SUTA; every amount carries an `explain` list.
- `server/lib/nacha.mjs` — sample PPD file builder.

Punches are append-only (SQLite triggers reject UPDATE/DELETE); corrections are new punches from approved requests.

## Payroll and HR (`server/payroll/`)

Each module registers its routes on the shared context: `vaultauth` (vault setup and sign-in), `approvals` (chains and requests), `orgstructure` (entities, departments, cost centers, allocations, budgets), `paystructure` (profiles, rates, differentials, grades, raises and retro pay), `leave` (policies, ledger, requests, holidays, FMLA and state leave), `run` (pay run, finalize, NACHA, stubs, GL), `onboarding` (offers, e-signed forms, I-9, policies, new-hire report, offboarding), `documents` (file cabinet, retention, expenses), `reports`, `importer`, `yearend` (W-2, 1099-NEC, 1095-C) and `talent` (hiring, performance).

- `createApp({ vault: true, hubUrl, localSignIn })` runs the payroll vault (the Hub address and the local-password switch come from the KeaS app, never from a request; it answers only to its own 127.0.0.1 address): no sample data, no development sign-in, and every route except `/v1/health`, `/v1/vault/status|setup|signin` and logout answers 423 until the vault is unlocked.
- `POST /v1/payrun/finalize {periodStart}` answers 409 unless that year's tax and labor tables are verified (`verified` + `year`, `verifiedFor`), every timecard with hours is approved, and a configured pay-run approval chain has finished.
- Files (CSV, PDF, NACHA, documents) come back with `content-disposition: attachment`.
