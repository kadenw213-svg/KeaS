# Kea protocol: Kea, KeaS and KeaC

Version 1. This document is the contract between the three apps (the public parts; KeaC's internals aren't here).

## Roles

| App | Who runs it | What it holds |
|---|---|---|
| **Kea** | everyone | the user's own data; works fully offline |
| **KeaS** | an organization (school, employer) on its own PC | that org's people, roles, classes, schedules, time clock, payroll |
| **KeaC** | the Kea owner only | every Kea account, verification, two-step, personal cloud, shared Claude, hosted orgs, approvals |

Users never see the name KeaC. In Kea and KeaS it is "your Kea account"; its address shows only under Advanced.

## 1. Kea accounts (public)

- **Offline account** (in Kea only): email + password, stored on the device (scrypt verifier). No storage, no sync,
  no joining anything hosted. Never leaves the device.
- **Online account** (on KeaC): created only with a verified email from **Google** or **Microsoft**: the client sends
  the provider's ID token; KeaC checks it (signature against the provider's keys, issuer, audience = Kea's client id,
  expiry, `email_verified` for Google) and that its email is the account email. Microsoft: the `email` claim of a
  personal account, or of a work/school account only with `xms_edov: true`; never `preferred_username`. A display
  name is optional.
- **Linking**: an offline account becomes online when the same email signs in with Google/Microsoft. A different
  email never links; the offline account and its data stay as they are.
- Sign-in: email + password (+ two-step code or backup code when two-step is on), or Google/Microsoft.
- Sessions: opaque 32-byte tokens, stored hashed; 30 days from last use, at most 365 days. A session records whether
  it passed two-step (`mfa`); owner powers need `mfa`.

### Endpoints on KeaC (all under `https://<keac>/v1`, JSON)

| Method, path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, features[] }` |
| `GET /terms` | | current terms |
| `POST /auth/register` | `{ provider: 'google'\|'microsoft', idToken, password, name?, termsVersion, termsSections, age13 }` | `{ token, me }` |
| `POST /auth/login` | `{ email, password, code? }` | `{ token, me }`, or 401 `{ totpRequired, backupCodes }` |
| `POST /auth/oauth` | `{ provider, idToken }` | `{ token, me }` (sign in with Google/Microsoft) |
| `POST /auth/reset/oauth` | `{ provider, idToken, password }` | `{ ok }` (new password) |
| `GET /me`, `POST /auth/logout`, sessions, two-step, backup codes, export, delete | as Hub 0.5 | |

## 2. Server passes (public)

How a Kea account signs in to a KeaS server without KeaS ever seeing a password.

1. **Server identity.** Each KeaS makes an Ed25519 key on first start. `serverId` = base64url(SHA-256(raw public
   key)) cut to 22 characters. `GET <keas>/v1/identity?nonce=<n>` returns
   `{ serverId, publicKey (JWK), name, sig }` where `sig` signs `kea-server-identity:<serverId>:<nonce>`.
   Kea checks the signature and that `serverId` matches the key. A KeaS is **never registered** with KeaC.
2. **Pass request.** Kea (signed in to KeaC) calls `POST <keac>/v1/pass { serverId }` with its session. Needs a
   two-step session if the account has two-step on, and a verified email (403 `{ needsVerify: true }` otherwise: only an
   account moved from the old Hub can lack one, until it verifies with Google or Microsoft). KeaC answers `{ pass, exp }`.
3. **Pass format.** JWT-shaped, `alg: EdDSA`, header `kid`. Payload:
   `{ iss: 'kea', aud: 'keas:<serverId>', sub: <account id>, email, name, ev: true, iat, exp }`.
   Lifetime **7 days**. Kea renews it silently once a day while online, so users never see expiry.
   Passes are only for KeaS servers. Organizations hosted on KeaC take no pass (section 5): KeaC is the account
   service, so their routes accept the Kea account's own KeaC session. No `keac-org:` audience is issued.
4. **Using it.** Kea sends `POST <keas>/v1/auth/pass { pass }`. KeaS checks: signature against KeaC's keys, `iss`,
   `aud` equals its own id, `exp` in the future, `iat` not in the future (2 minutes skew), `sub` not on the
   revocation list. Then it makes its own KeaS session for that `sub` (KeaS session rules are KeaS's own).
   A newer pass for the same `sub` renews the KeaS session.
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

Kea prefers the user's own Claude. When the user has none, Kea can ask KeaC (`/v1/scan`, as Hub 0.5). KeaC enforces:

| What | Limit (owner-adjustable) |
|---|---|
| Full class scan | one per class per term; a whole-class rescan needs the user's own Claude |
| Light check for new work | at most once a day per class |
| Study questions | 25 at a time; the next 25 only after 20 of the last batch were answered |
| Assignment guide | one per assignment |

Refusals answer 429 `{ error, limit, retryAt? }` with a plain sentence Kea shows as is.

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
