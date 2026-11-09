# Kea protocol: Kea, KeaS and KeaC

Version 1. This document is the contract between the three apps (the public parts; KeaC's internals aren't here).

## Roles

| App | Who runs it | What it holds |
|---|---|---|
| **Kea** | everyone | the user's own data; works fully offline |
| **KeaS** | an organization (school, employer) on its own PC | that org's people, roles, classes, schedules, time clock, payroll |
| **KeaC** | the Kea owner only | every Kea account, Google/Microsoft verification, personal cloud, shared Claude, hosted orgs, approvals |

Users never see the name KeaC. In Kea and KeaS it is "your Kea account"; its address shows only under Advanced.

## 0. Versions: every app updates on its own (public)

Kea on the PC, Kea on the phone, KeaS and KeaC are released separately. Every release keeps working with the other
apps' versions still in use; a server tells an app plainly when it's too old; and an app that can't update says so
instead of staying old quietly.

**The client header.** Every request an app makes to a server says which app and version it is:

```
X-Kea-Client: <app>/<version>
```

| App | Value | Since |
|---|---|---|
| Kea on the PC | `Kea/0.85.0` | account requests already; KeaS requests in the release after 0.84.1 |
| Kea on the phone | `Kea-Phone/0.85.0` | the release after 0.84.1 (before: `Kea for Android`, no version) |
| KeaS (to KeaC) | `KeaS/0.9.0` | the release after KeaS 0.8.1 |

Servers also read `Kea-Client`. The name is case-insensitive and anything after the version and a space is ignored.
**A request without the header, or without a version, is served exactly as before**: only an app that says it is
older than the minimum can be turned away.

**Health.** `GET /v1/health` on KeaC and on KeaS keeps everything it had (`ok`, `service`, `version`, `features`, ...)
and adds:

```json
{
  "protocol": 1,
  "minClients": { "kea": "0.80.0", "keaPhone": "0.80.0", "keas": "0.6.0" },
  "latest": { "kea": "0.85.0", "keas": "0.9.0" },
  "updateUrls": { "kea": "https://github.com/kadenw213-svg/kea/releases/latest", "keaPhone": "…", "keas": "https://github.com/kadenw213-svg/KeaS/releases/latest" }
}
```

- `protocol`: one integer for the whole contract. It goes up only for a break no older app can follow (see each
  repo's DEVELOPING doc), never for an addition: additions are new optional fields and new `features`.
- `minClients`: the oldest version of each app this server serves. The defaults are in `clients.mjs` (KeaC
  `server/lib/`, KeaS `hub/lib/`; the two files are the same); the owner can change them under Advanced
  (`POST /owner/settings { clients: { minClients: { kea: "0.85.0" } } }`, `""` or `null` puts one back).
- `latest`: the newest released Kea and KeaS the server knows of, or `null`. Servers read electron-updater's
  `latest.yml` on each app's latest GitHub release every 6 hours (`KEAC_RELEASE_FEEDS=0` / `KEAS_RELEASE_FEEDS=0` turn
  that off); a feed that fails keeps the last version found. The owner can add a version by hand
  (`clients: { latest: { kea } }`), and a KeaS server counts its own version for `keas`. Apps use it to say
  "Update available" even when their own update feed can't be reached.
- An older server has none of these fields; apps then behave as before.

**Too old: 426.** Any request other than `/v1/health` from an app whose version is below `minClients[app]` gets

```json
426 { "error": "Update Kea to keep using your Kea account.", "upgradeRequired": true, "app": "kea", "version": "0.79.0", "minVersion": "0.80.0", "updateUrl": "https://github.com/kadenw213-svg/kea/releases/latest" }
```

The `error` is for people, in the app's own words: KeaC tells Kea "Update Kea to keep using your Kea account.", KeaS
tells Kea "Update Kea to keep using this organization’s server.", KeaC tells KeaS "Update KeaS to keep signing people in
with their Kea accounts." Nothing else about the request is looked at first.

**What apps do with it.**

- Kea (PC and phone) shows the `error` with an **Update** button (it checks for, downloads and installs the update;
  a copy that can't update itself opens `updateUrl`). Nothing on the device is lost, and the notice goes away by
  itself once the server answers normally again. An older Kea shows the `error` text as it shows any server error.
- Kea notes `latest.kea` from every health check, and the PC writes its own version into what it syncs to the phone
  (`kea-data.json` `keaVersion`), so the phone can say "Your PC has Kea 0.85.0; this phone has 0.84.1."
- KeaS keeps KeaC's 426 and shows it in the KeaS app; passes already checked keep working on the last key list.
- Every app says plainly when its own update checks keep failing or an update has waited days to install, with the
  last successful check.

## 1. Kea accounts (public)

There are no Kea passwords. Online, a Kea account signs in with **Google** or **Microsoft** only.

- **Offline account** (in Kea only): just an email, kept on the device. Typing the email opens Kea at once, with no
  connection; the same email opens that device's things again after signing out. No storage, no sync, no joining
  anything hosted. Never leaves the device. (Kea 0.80 kept a password verifier with it; Kea drops it on first read and
  keeps the account and its email.)
- **Online account** (on KeaC): made by the first Google or Microsoft sign-in for an email, with the terms agreed. The
  client sends the provider's ID token; KeaC checks it (signature against the provider's keys, issuer, audience =
  Kea's client id, expiry, `email_verified` for Google) and takes the account email from it. Microsoft: the `email`
  claim of a personal account, or of a work/school account only with `xms_edov: true`; never `preferred_username`.
  A display name is optional (else the token's name, else the email's first part).
- **Signing in**: the same, for an existing account with that email. It also marks the email verified, so an account
  moved from the old Hub (`ev` false, a password nobody types any more) is verified by its first Google or Microsoft
  sign-in with that email. After an online sign-in, Kea stays signed in on the device (offline too).
- **Linking**: an offline account becomes online when the same email signs in with Google/Microsoft. A different
  email never links; the offline account and its data stay as they are, and the client doesn't send the token.
- **Passwords and two-step codes are retired.** Stored password hashes (and old two-step secrets) stay in KeaC's
  database, unused. The one exception is **the KeaC owner's account**: it keeps its password and two-step code for the
  KeaC desktop app (which works before any Google client id exists), and its Google or Microsoft sign-in also asks for
  the two-step code.
- Sessions: opaque 32-byte tokens, stored hashed; 30 days from last use, at most 365 days. A session records whether
  it passed two-step (`mfa`); owner powers need `mfa`.

### Endpoints on KeaC (all under `https://<keac>/v1`, JSON)

| Method, path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, features[] }` (`oauthCreate`, `passwordRetired` among them) |
| `GET /terms` | | current terms |
| `POST /auth/oauth` | `{ provider: 'google'\|'microsoft', idToken, code? }` | `{ token, me }` (signed in) |
| | no account for that email, no terms in the body | 404 `{ needsAccount: true, email, name, termsVersion }`. The ID token is **not** used up: send the same one again with the terms |
| | `{ provider, idToken, termsVersion, termsSections, age13: true, name?, birthYear? }` | 201 `{ token, me, created: true }` (the account is made) |
| | the owner's account, two-step on, no or wrong `code` | 401 `{ totpRequired, backupCodes }` (the token is not used up: send it again with `code`) |
| `POST /auth/google` | `{ idToken, ... }` | the same as `/auth/oauth` with Google (Hub 0.5's path) |
| `POST /auth/register` | `{ provider, idToken, termsVersion, termsSections, age13, name? }` | 201 `{ token, me }`; 409 `{ exists }` when the email has an account. With a `password`: 410 |
| `POST /auth/login` | `{ email, password, code? }` | the owner's account only (the KeaC desktop app). Anyone else: 410 |
| `POST /auth/reset/oauth`, `/auth/reset/google` | | the owner's account only. Anyone else: 410 |
| `POST /me/password`, `/me/totp/setup`, `/me/totp/enable`, `/me/totp/backup-codes`, `/me/totp/disable` | | the owner's account only. Anyone else: 410 `{ passwordRetired }` or `{ twoStepRetired }` |
| `POST /me/sessions/sign-out-others` | `{ provider, idToken }` (a fresh sign-in with the account's own email) | `{ signedOut }`; without one 401 `{ signInRequired }` |
| `POST /me/delete` | `{ confirm: 'DELETE', provider, idToken, eraseNow? }` | `{ ok, deleted }` |
| `GET /me` | | `{ account, ..., name, phone: string\|null, phoneShare: { orgs, classmates } }` (also inside `account`) |
| `PATCH /me` | `{ name?, phone? (null clears it), phoneShare?: { orgs?, classmates? } }` | the same as `GET /me` |
| `POST /auth/logout`, sessions, export | as Hub 0.5 | |

**Phone number** (optional, never public). Stored normalised to E.164 (`+15551234567`). Accepted: any E.164 number
(`+`, a country code, 8 to 15 digits in all, like `+44 20 7946 0958`; spaces, dots, dashes and brackets are dropped;
a `+1` number has ten digits after the 1), and common US formats without the `+` (`(555) 123-4567`, `555-123-4567`,
`555.123.4567`, `5551234567`, `1 555 123 4567`), stored as `+1...`. Anything else is 400 `{ error }`.
`phoneShare.orgs` (default true) shares it with the organizations the account joins (KeaS servers through the pass,
section 2, and hosted orgs on KeaC), seen only by people with `people.view`; `phoneShare.classmates` (default false)
shares it in class rosters. The person always sees their own. Leaderboards, the public class list and anything
unauthenticated never show it.

**410 `{ passwordRetired: true }`** answers an older client's password sign-in or registration, with the sentence "Kea
accounts now sign in with Google or Microsoft only. Update Kea, then choose Continue with Google or Continue with
Microsoft with your account’s email." Clients show it as is. The password isn't looked at and the attempt doesn't
count as a failed sign-in.

## 2. Server passes (public)

How a Kea account signs in to a KeaS server without KeaS ever seeing a password.

1. **Server identity.** Each KeaS makes an Ed25519 key on first start. `serverId` = base64url(SHA-256(raw public
   key)) cut to 22 characters. `GET <keas>/v1/identity?nonce=<n>` returns
   `{ serverId, publicKey (JWK), name, sig }` where `sig` signs `kea-server-identity:<serverId>:<nonce>`.
   Kea checks the signature and that `serverId` matches the key. A KeaS is **never registered** with KeaC.
2. **Pass request.** Kea (signed in to KeaC) calls `POST <keac>/v1/pass { serverId }` with its session. Needs a
   verified email (and, for the KeaC owner's own account only, a session that passed its two-step code) (403 `{ needsVerify: true }` otherwise: only an
   account moved from the old Hub can lack one, until it signs in with Google or Microsoft). KeaC answers `{ pass, exp }`.
3. **Pass format.** JWT-shaped, `alg: EdDSA`, header `kid`. Payload:
   `{ iss: 'kea', aud: 'keas:<serverId>', sub: <account id>, email, name, ev: true, iat, exp, phone?, phoneOrgs?, phoneClassmates? }`.
   `phone` (E.164, like `+15551234567`) is there when the account has a phone number and either sharing switch is
   on, always with `phoneOrgs: true|false` (`phoneShare.orgs`) and `phoneClassmates: true|false`
   (`phoneShare.classmates`). With both off, or no number, none of the three is there.
   Lifetime **7 days**. Kea renews it silently once a day while online, so users never see expiry.
   Passes are only for KeaS servers. Organizations hosted on KeaC take no pass (section 5): KeaC is the account
   service, so their routes accept the Kea account's own KeaC session. No `keac-org:` audience is issued.
4. **Using it.** Kea sends `POST <keas>/v1/auth/pass { pass }`. KeaS checks: signature against KeaC's keys, `iss`,
   `aud` equals its own id, `exp` in the future, `iat` not in the future (2 minutes skew), `sub` not on the
   revocation list. Then it makes its own KeaS session for that `sub` (KeaS session rules are KeaS's own).
   A newer pass for the same `sub` renews the KeaS session. The name, email, `phone`, `phoneOrgs` and
   `phoneClassmates` of the newest pass are kept on the member; a pass without them clears them (each switch counts
   only when exactly `true`). In the org API a member's `phone` always shows to themselves; to people with
   `people.view` for their department only with `phoneOrgs` (the member lists of `GET /v1/orgs/:id/members`, `me` in
   `GET /v1/orgs/:id`, and member answers); and in an org class roster (`assigned` in `GET /v1/orgs/:id/classes`)
   only with `phoneClassmates`. A member without `people.view` never sees anyone else's in member lists. Hosted orgs
   and classes on KeaC follow the same rules.
   Answer: `{ token, exp }` (`exp` in ms); Kea then sends `Authorization: Bearer <token>`. A refused, expired or
   revoked pass answers 401 `{ error }`. Join links are `kea://join?s=<server url>&c=<join code>`.
5. **KeaC's keys.** `GET <keac>/v1/keys` → `{ keys: [JWK with kid, alg EdDSA, use sig, status: 'current'|'next'|'retired'] }`.
   KeaS ships with the current key built in, refreshes this list at start and every 6 hours, and keeps the last
   good list if KeaC can't be reached. Rotation: publish `next` at least 7 days before signing with it.
6. **Revocation.** `GET <keac>/v1/revoked?since=<ms>` → `{ now, ids: [account ids suspended or deleted], full }`.
   KeaS checks hourly when it can reach KeaC, keeps working if it can't, and ends sessions of listed ids. The list
   contains account ids only.
7. **When KeaC is down.** Existing passes and KeaS sessions keep working until their expiry; Kea keeps using its
   current pass and retries renewal in the background. Only new sign-ins, new passes and new online accounts wait.
8. **What KeaC learns.** Only "account X asked for a pass for server Y, at time T" (for the owner's Servers list and
   abuse handling). Never anything inside the server.

## 3. Personal cloud (public)

`/v1/files/*` on KeaC, same as Hub 0.5 (`kea/<path>`). Default quota 5 GB per account, changed per account by the
owner. Kea's sync chooser can instead use Google Drive, OneDrive, Dropbox or any synced folder, or a KeaS server's
`/v1/files` (same shape, KeaS session).

## 4. Shared Claude (public summary)

Every online Kea account can use Kea's shared Claude (the Kea owner's Claude plan, run on the owner's PC), always
within limits. Kea prefers the user's own Claude when it has one. Kea asks KeaC with `/v1/scan` (as Hub 0.5) and, for
Teach explainers, `/v1/teach`. KeaC enforces:

| What | Limit (owner-adjustable, per account too) |
|---|---|
| Full class scan | one per class per term; a whole-class rescan needs the user's own Claude |
| Light check for new work | at most once a day per class |
| Study questions | 25 at a time; the next 25 only after 20 of the last batch were answered |
| Assignment guide | one per assignment |
| Teach explainer (a lesson or a follow-up) | 20 a day, one at a time |
| Tokens | a daily cap per account (input, output and cache-write tokens; cache reads aren't counted), 4,000,000 by default |

Days are UTC. The owner can raise or lower any limit for one account, turn shared Claude off for it, or put it back
to the defaults.

**Models are fixed** and can't be chosen by the request: Opus for class scans, light checks, study questions and
guides; Sonnet for Teach explainers (effort medium, no tools). A `model` or `effort` sent with a request is ignored.

Refusals answer 429 `{ error, code, limit, retryAt?, retryAfter?, allowance }` with a plain sentence Kea shows as is.
`limit` names the limit (`fullScansPerTerm`, `updateCooldownHours`, `questionsAnsweredToUnlock`,
`guidesPerAssignment`, `explainersPerDay`, `dailyTokenCap`, ...); `retryAt` (ms) is when it opens again, when that's
known. `allowance` adds `lessonsToday`, `lessonsPerDay`, `tokensToday`, `tokensPerDay` and `resetsAt` (an older KeaC
has only the scan counts).

### Teach explainers (`features` has `sharedTeach`)

| Method, path | What |
|---|---|
| `POST /v1/teach` | `{ question, courseCode?, chapter?, answer?, right?, dunno?, focus?, again?, followup?: { ask, lesson, earlier[] } }`: 202 `{ job: { id, status: 'queued', model } }`, or 429 as above, or 503 `{ code: 'no_worker' \| 'paused' }` when no lesson can be written now |
| `GET /v1/teach/:id?since=<chars>&wait=<ms>` | `{ job: { id, status, text, length, error } }`: the text after `since` characters; with `wait` (at most 15 s) it answers when there's more, or when it's done |
| `POST /v1/teach/:id/cancel` | stops it |

`status` is `queued`, `running`, `done`, `failed` or `cancelled`. The text is the lesson as Claude writes it
(Markdown, then one fenced `check` block of practice questions), so Kea shows it streaming in by asking again with
`since` set to `length`. A follow-up carries the lesson it follows (there's no conversation to continue). Only the
question, the answers and the lesson text are sent; never anything else from the user's Kea.

An older KeaC has no `sharedTeach`: Kea doesn't offer Teach through it. An older Kea never asks.

**Usage** (`features` has `usageTracking`): KeaC counts the tokens each shared-Claude job used, per account, day and
kind, for the daily cap and for the owner. Nothing about it is shown to other accounts.

## 5. Approvals (public summary)

- **Public class list**: a creator applies (`POST /v1/apply { kind: 'creator', note, organization }`). Only
  approved creators' classes appear in Kea's public list, with the creator's name.
- **Hosting on KeaC**: a school or employer applies (`kind: 'hosting'`, `{ orgKind: 'school'|'employer', name,
  note }`). When the owner approves it, KeaC makes the organization at once, active, with the applicant as its owner
  (the notification's `data` carries `orgId`). Nothing else makes one: `POST /v1/orgs` on KeaC answers 403 with a
  sentence to show. Hosted orgs run on KeaC with the same org engine as KeaS.
- No badges, except the owner's own account.

### Hosted organizations (public)

A hosted organization speaks the same org API as a KeaS server (KeaS `docs/DEVELOPING.md`, "The org engine"), on
KeaC's own address, with one difference: **sign-in is the Kea account session itself** (`Authorization: Bearer
<KeaC session token>`), with no pass and no separate org session. So Kea's per-server org client treats KeaC as a
server whose session is the account session it already has; for a KeaS server it gets a pass first (section 2) and
uses the KeaS session from `POST <keas>/v1/auth/pass`. Everything after that is the same path.

Why no pass: KeaC already knows the account (it issues the passes), so a pass to itself would only add a token to
renew and a second revocation path. Suspending or deleting the account ends its KeaC sessions, which ends its access to
hosted orgs at once.

| Method, path (on KeaC) | What |
|---|---|
| `GET /v1/orgs` | the hosted orgs the account is in (`[]` when none) |
| `POST /v1/orgs/join` | `{ code }`: join a hosted org with one of its join codes (a KeaS server's codes go to that server) |
| `GET /v1/orgs/:id` | the org and `me` (`abilities`, `scopes`, `roles`, legacy `role`) |
| `/v1/orgs/:id/*` | members, roles, structure, forms, schedules and shifts, swaps, policies, the time clock, timecards, time off, pay codes and `me/pay`, `pay-feed` |
| `GET /v1/todo`, `POST /v1/todo/snooze`, `GET /v1/orgs-calendar`, `GET /v1/orgs-export` | across all of the account's hosted orgs |
| `POST /v1/orgs` | refused (403): hosted orgs come only from an approved application |

`GET /v1/health` lists `hostedOrgs` in `features`. A suspended org answers 403 "This organization is suspended on
this server." on its routes and its join codes stop working; an org that isn't hosted (or was deleted) is 404.


## 7. What the KeaS server answers (KeaS 0.6)

- `GET /v1/health` -> `{ ok, service: 'keas', version, serverId, features, claimed }` (after a Kea Hub's accounts moved:
  also `movedTo`, `keacKeyKid`).
- `GET /v1/identity?nonce=<16-128 of A-Z a-z 0-9 - _>` -> `{ serverId, publicKey: { kty: 'OKP', crv: 'Ed25519', x }, name, sig }`,
  `sig` = Ed25519 over `kea-server-identity:<serverId>:<nonce>`, base64url.
- `POST /v1/auth/pass { pass }` -> `{ token, exp, expiresAt, renewed, me: { id, email, name, operator } }`. `token` is a
  KeaS session (64 hex characters), sent as `Authorization: Bearer <token>`; `exp` is in ms (30 days). Sent with the
  session it came from, a pass at least as new renews that session (same token, `renewed: true`). Refused: 401
  `{ error, reason }`, reason one of `format, key, signature, iss, aud, expired, future, lifetime, claims, revoked`.
- `POST /v1/auth/logout`, `GET /v1/me`, `GET /v1/me/notifications`, `GET|PUT|DELETE /v1/files/<path>` (each member's
  files area, the Kea Hub's files API; as big as their organization allows, 1 GB by default), `POST /v1/me/leave-server`
  (`{ confirm: <email> }`), and the org engine's `/v1/orgs/*`, `/v1/todo`, `/v1/orgs-calendar` (joining:
  `POST /v1/orgs/join { code }`; join links are `kea://join?s=<server url>&c=<join code>`).
- A data folder that was a Kea Hub, after `moved-to-keac.json` (`{ at, keacUrl, keacKeyKid }`, written by KeaC's
  migration or the KeaS app): the Kea Hub's account routes answer 410 `{ error: 'Kea accounts moved', movedTo,
  keacKeyKid }`. Kea follows `movedTo` only when that address lists the same `kid` at `/v1/keys`.
