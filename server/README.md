# Kea Work demo org server

> **PROTOTYPE — NOT FOR REAL USE.**
> - All people, banks and numbers are **fake demo data**.
> - Tax tables (`shared/tax/*.json`) and labor rules (`shared/labor/*.json`) are **unverified** (`verified:false` / `verifiedFor:null`). Pay-run amounts are estimates; every pay-run response has `unverified:true` and `canFinalize:false`.
> - The NACHA file is a **sample only** and is never sent anywhere.
> - Listens on **127.0.0.1 only** (never 0.0.0.0). Demo login has no password.

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

## Endpoints (all JSON, under /v1)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | /health | public | `{ok, version, minClient, prototype}` |
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
| GET | /payrun/nacha?periodStart | payroll | `{text, note:'Sample only — never sent'}` |

## Rules engine

- `server/lib/rules.mjs` — `mergeRules` (strictest wins), `timecard` (CO weekly-40 vs daily-12/12-consecutive, whichever gives more OT, minute-level so nothing is counted twice; rest-break premium; late/no-show/missed-punch flags), `checkAssignment` (overlap, certs, minimum/position ages, minor hours and times, OT look-ahead).
- `server/lib/pay.mjs` — gross, FICA, federal Worksheet 1A, Colorado DR 1098, FAMLI, FUTA, SUTA; every amount carries an `explain` list.
- `server/lib/nacha.mjs` — sample PPD file builder.

Punches are append-only (SQLite triggers reject UPDATE/DELETE); corrections are new punches from approved requests.
