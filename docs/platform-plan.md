# Kea platform plan: the Hub, accounts, orgs, classes and payroll (2026-11-05)

This plan adds to `docs/plan.md`. It covers the user's request of 2026-11-05: KeaS becomes the "main brain" for Kea. The owner's PC runs a central server, and one account works in both Kea and KeaS. Orgs, classes, live sessions, study groups and leaderboards hang off that account. Payroll grows to compete with full payroll suites.

Nothing here is built yet. The decisions still open are listed at the end.

---

## 1. The shape: three tiers

| Tier | Runs where | Holds | Never holds |
|---|---|---|---|
| **Kea Hub** (central) | The owner's PC, reached through a tunnel | Accounts (password **hashes**), email verification, 2FA, the org directory and join codes, verified badges, instructor applications, the approved curriculum library, classes hosted for others, live sessions, opt-in study groups, leaderboards and levels | Payroll data (SSNs, bank details, pay runs) and orgs' timecards |
| **KeaS org server** | Either hosted on the Hub (after approval), or self-hosted by the org on its own PC or server | Departments, positions, people, schedules, punches, timecards, budgets, the org's classes and calendar, cert records the org shares | Passwords: sign-in always goes through the Hub |
| **Payroll vault** | The payroll admin's own PC (KeaS desktop) | SSNs, bank accounts, W-4 and state forms, pay runs, encrypted with its own passphrase | |

**Clients**
- **Kea** (Electron) and **KeaS desktop** (Electron, wrapping the server and the web UI) sign in to the Hub with the same account.
- The **KeaS PWA** serves phones.

**How one sign-in works everywhere**
- The Hub issues short-lived **signed tokens** (Ed25519) that say who you are and which orgs you belong to.
- Org servers check the signature with the Hub's public key. Passwords never reach an org server, and a self-hosted org can't see them.
- If the Hub is offline (for example the owner's PC is off), clients keep a cached session and keep working. Org servers keep running. Only new sign-ins and Hub features wait.

**What "managing every server" means**
- **The owner can:** see every registered org server (name, code, version, last seen); approve or suspend hosting; revoke an org's registration or its join codes; push "minimum version" notices; and, for orgs hosted on the Hub, administer them fully.
- **The owner can't** reach into the data on a self-hosted org server. That is the org's data, and it is legally theirs as data controller. This is a feature: it's why an org can trust KeaS.

---

## 2. Security: nobody brute-forces their way in

The repo is public, so the security has to come from the design, not from secrecy.

**Passwords**
- Passwords are **never stored**, only Argon2id hashes (scrypt as a fallback), with per-user salt.
- Not even the owner can read them. Account recovery is a reset by email, never "look up the password".

**Login protection**
- Per-IP and per-account rate limits, with exponential backoff (1s → 2s → 4s … capped). After 10 failures there's a 15-minute lock on that account from new IPs; the real owner can still unlock it by email.
- The same error message for "no such user" and "wrong password", so nobody can probe which emails have accounts.
- New passwords are checked against a bundled list of the 100k most common leaked ones.
- 2FA: TOTP (an authenticator app) for everyone, optional. Passkeys come later.
  - **Required** for the owner, org owners, payroll admins and verified instructors.

**Sessions**
- Random 32-byte tokens, stored hashed (as the prototype already does).
- HttpOnly + SameSite=Strict cookies, plus the CSRF header the prototype already uses.

**Owner powers**
- The owner console listens on **localhost only**. It isn't reachable from the internet at all, even with the right password.
- Owner actions also need an owner key generated on the owner's PC, plus 2FA.
- Owner status is never "whoever signed in as kadenw213@gmail.com". An email alone would be a single point of failure.

**Network**
- The Hub is never port-forwarded directly. It goes out through a **Cloudflare Tunnel** (free; needs a domain, about $10 a year), which provides:
  - hiding the home IP;
  - TLS;
  - DDoS absorption;
  - a WAF rate limit in front of `/auth`.
- Tailscale Funnel is the alternative, with no domain but fewer protections.

**Data at rest**
- Sensitive columns (emails, TOTP secrets, DOBs) are encrypted with a key wrapped by Windows DPAPI.
- BitLocker on the drive is recommended.

**Backups**
- A nightly encrypted backup (age/AES-GCM with an offline recovery key) to the owner's OneDrive.
- Losing the PC must never mean losing everyone's accounts.

**Audit log**
- Every admin action, every sign-in, and every failed sign-in burst is logged.
- The owner console shows the logs.

---

## 3. Accounts, modes and orgs

**One account** for Kea and KeaS: email, display name, avatar, password hash, 2FA, and verification level.

**Verification levels** (each one is a badge):
1. **Email verified:** a link is emailed. Sending needs an email account for Kea, for example a Gmail app password or a free transactional sender. Mail sent straight from a home IP lands in spam.
2. **Identity verified:** the owner reviews it by hand. Needed for making *general* (public library) curricula.
3. **Approved instructor host:** an application to host classes on the Hub.

**Kea's first sign-in asks "How do you use Kea?"** You can pick more than one, and switch later in Settings.
- **Personal:** your own school and study tools offline. No Classes tab from orgs, no Work features shown.
- **School:** today's Scholar (D2L/Canvas class scanning).
- **Work:** "Join an organization" with a code. The org's classes, trainings, shifts and calendar show up in Kea. Each joined org is listed with a Leave button.

Kea's existing local profiles (School, Personal) map onto these modes.

**Org join codes**
- Each org has codes per role (member, manager), with an optional expiry, maximum number of uses and required approval.
- Codes are 10+ random characters, are rate-limited, and can be revoked.

**Kea's current "verified" check** (local proof through Claude, OneDrive or Google sign-ins) becomes a fallback. The Hub account is the real one.

---

## 4. KeaS first-run wizard

On first launch, KeaS desktop walks through:
1. **Sign in or create an account** (Hub).
2. **"What are you setting up?"**
   - **Join an organization:** enter a code. Done.
   - **Create an organization:** host it on the Kea Hub (needs approval) **or** on this PC. The wizard then installs the org server as a background service and sets up the tunnel.
   - **Run the Kea Hub:** only shown on the owner's PC, the first time. It generates the Hub keys, the owner key and the backup recovery key (printed or saved offline), and sets up the tunnel and domain.
3. **Org basics:** name, type (nonprofit, government, private, school), location, then suggested labor and tax packs.
4. **Structure:** departments and subdepartments, positions, cost centers, budgets. An industry template can be imported.
5. **Payroll setup** (payroll admins only):
   - create the vault passphrase;
   - pay schedules;
   - EINs and state accounts;
   - **connect Claude** (see §6).
6. **Invite people:** codes, CSV import, or an import from Gusto, ADP or Paychex exports.

Every step can be skipped and finished later from Settings. The Advanced panels follow the usual rule.

---

## 5. Classes and LMS (shared by Kea and KeaS)

**Who can make what**
- **Org classes** (for example a lifeguarding class): any org admin or instructor in the org. Only that org sees them.
- **General curricula** (the public library): needs an **identity-verified** account, and every class goes through the owner's review queue, as in Kea's `ideas/class-library.md`. The queue moves from GitHub issues to the Hub.

**Where a class is hosted**
- **On the instructor's own org server:** they must belong to (or create) an org.
- **On the Hub:** they apply, and the owner approves. This is the hosting approval, separate from the identity verification for general curricula.

**What a class has**
- **Content:** units, readings, flashcards, a quiz bank, assignments and exams. This uses the Kea library package format (`ideas/class-library.md`, the Phase 3 manifest), so one format serves self-paced and instructor-led classes.
- **Sessions on the org calendar:** dates, times, a location or "live online", an instructor, capacity, prerequisites, a waitlist.
- **Roster:**
  - admins **assign** people, or people self-enroll if that's allowed;
  - attendance taken by the instructor on a device;
  - skills check-offs.
- **On completion:** the class can **issue an org certification** automatically (for example the org's Lifeguard cert, with an expiry). The cert-gated scheduler already uses those certs.
- **Assigned classes** appear in each member's Kea calendar (Work mode) and in the KeaS app.

**Live classes on the Hub**
- Self-hosted **LiveKit** (Apache-2.0, a WebRTC media server), plus a TURN server for people behind strict firewalls.
- **The honest limit is home upload speed.** At about 1.5 Mbps per viewer, a 20 Mbps upload carries roughly 10–12 viewers watching one presenter's video. Screen-share and audio-first sessions stretch further.
  - Big classes need either an org that self-hosts LiveKit, or a small rented server later.
- **Recordings** are stored on the Hub with a per-instructor quota. Disk space is the limit: about 0.5–1 GB per recorded hour.

**The editing suite comes along:** students and instructors open class documents, decks and PDFs in Kea's own editors.

---

## 6. Claude in KeaS (tax and labor research)

KeaS connects Claude the same way Kea does: the admin's own Claude Code login, run in the background with bundled KeaS skills. A remote MCP connector for claude.ai can come later.

**What Claude does:**
- researches the org's state and local rules (withholding, SUI, paid leave, local taxes, minimum wage, breaks);
- drafts a pack change, with **every number cited to its official source**;
- explains a pay-stub line on request;
- compares each December's new official PDFs with last year's.

**What Claude never does:** mark anything verified. A drafted pack stays "unverified" until its test cases pass and a person signs it off. The existing safety rule (no finalizing a pay run on unverified tables) stands.

**Required or optional:** required to *add or update a jurisdiction pack*. **Not** required to run payroll on packs already verified. Otherwise every small org would have to pay for a Claude plan, which breaks "free".

---

## 7. Payroll and HR: the full competitor list

The existing `docs/plan.md` already covers:
- the time clock;
- rules;
- gross-to-net;
- the NACHA file;
- checks;
- forms;
- garnishments;
- benefits deductions;
- GL export;
- ACA;
- 1099s;
- the all-50-states labor table.

The user asked for these on top:

**Org structure and budgets**
- A department tree of any depth (department → subdepartment → team), with cost centers, locations and multiple legal entities (EINs).
- **Budgets** per department or cost center, per period:
  - labor budget against scheduled and actual cost, updated live as shifts are drafted;
  - warnings before publishing a schedule that would go over;
  - budget versions (original or revised) with approvals.
- **Labor allocation:**
  - an hour or a shift can be split across departments, programs, funds or grants;
  - default allocations per person;
  - the GL export carries the splits.
- A headcount plan and open positions per department.

**Moving money** (as decided before: KeaS never holds funds)
- NACHA file upload to the org's own bank (already prototyped).
- **Opt-in bank API** (Mercury, Increase, Column and so on) using the org's own API key. "Approve run" sends direct deposits **from the org's own account**.
- **Off-cycle payments and reimbursements** go through the same bank API.
- KeaS never routes money through the owner or the Hub. That would make the owner a money transmitter, which needs state licenses.

**Things that big payroll suites have and the list didn't mention** (to build toward):
- **Onboarding:**
  - offer letters;
  - e-signed W-4 and state forms;
  - I-9 workflow (the document check stays human);
  - state new-hire reporting;
  - direct-deposit setup;
  - policy acknowledgments.
- **Offboarding:** final-pay deadlines per state, PTO payout rules, COBRA notice reminders, equipment return, access removal.
- **PTO and leave policies:**
  - accrual rules per policy;
  - holiday calendars;
  - FMLA and state leave tracking;
  - balances on stubs.
- **Pay structure:**
  - multiple rates per person;
  - shift differentials;
  - pay grades and bands;
  - raises with effective dates and approval chains;
  - retro pay calculated automatically.
- **Approvals engine:** configurable chains for time off, timecards, budget changes, raises and pay runs.
- **Reporting:** a custom report builder (pick fields, filter, group, schedule by email) and a payroll register, tax liability and labor distribution.
- **Expenses:** receipts, mileage, approval, reimbursement through payroll or the bank API.
- **Hiring (ATS):** job posts, an application form (KeaS Forms), interview scheduling, converting a candidate into an employee.
- **Performance:** reviews, goals, check-ins (no automated scoring, as with attendance).
- **Data import** from Gusto, ADP, Paychex and QuickBooks exports, including year-to-date amounts mid-year. Without this nobody can switch over mid-year.
- **Employee documents:** e-sign, a per-person file cabinet, retention rules.
- **SSO (SAML/OIDC)** for larger orgs, using the Hub as the identity provider.
- **Year-end:** W-2 and 1099, plus ACA forms (already in the plan).

---

## 8. Study groups, leaderboards and levels (opt-in)

**Opt-in**
- Each user chooses to share "my name and my classes" with the Hub. It's off by default.
- On leaderboards, each user can show their real name, a nickname, or stay hidden.

**Study groups for real classes**
- Classes are matched by school + course code + term (for example "UCCS · BIOL 1010 · Spring 2027"). A group shares study sets, flashcards, notes and a chat thread.
- **Copyright:** shared material is what members made. Uploading publisher test banks or textbook scans is blocked by policy and a report button.

**Leaderboard scoring** (designed so "brute force" practice helps learning but can't be farmed):
- Points come from **the first correct answer to each question in each review window**, not from every attempt. A question you got right comes back on a spaced schedule (1 day, 3 days, 7 days and so on). Answering it then earns points again, and answering it sooner earns nothing.
- Wrong answers cost nothing, so guessing and retrying is fine. A question only scores when you get it right on the first try of that window.
- New questions are worth more than reviews, and a daily cap stops all-night farming.
- **Grading happens on the Hub.** The answer key stays on the server for leaderboard sets, so a modified client can't fake scores. Off-leaderboard practice still works offline.

**Levels and leaderboards**
- XP builds into levels, with streaks and badges.
- Each class has a leaderboard with a weekly board (resets on Monday) and an all-time board. There are also a group board and an org board for training classes.

**Minors**
- Social features (study groups, public leaderboards, chat) are **13 and over** to stay clear of COPPA.
- Under-18s get private-by-default settings, and an org's youth employees only see their org's boards.

---

## 9. Things the user didn't mention that matter

1. **Your PC is now a server.**
   - When it's off, asleep or updating, nobody can make new sign-ins or join live classes. Clients must cache sessions and work offline (planned in §1).
   - Some home internet plans forbid hosting public services. A tunnel avoids an open port, but it doesn't change the plan's terms.
2. **Home upload bandwidth caps live classes** at about 10–12 video viewers (§5).
3. **Email sending** is needed for verification and resets. Home IPs can't send mail reliably.
4. **You become the data controller** for every Hub account. That needs a privacy policy and terms, deletion requests, and breach duties. Payroll data stays off the Hub for this reason.
5. **An LLC before outside orgs run payroll** on KeaS (already in `plan.md`).
6. **Real school classes:** students sharing their own enrollment is fine. Avoid anything that looks like pulling school records (FERPA belongs to the school, not to you).
7. **"Saving passwords"** means hashes: you can reset but never read. Saved D2L passwords for Kea's scanner stay on the student's own PC, as today.
8. **Public repo:** keys, the `.env` file and the Hub database must never be committed. A pre-commit secret check gets added.
9. **Single point of failure:** encrypted off-machine backups and a written restore procedure (§2).
10. **Updates:** the Hub, org servers and clients version-check each other (`minClient` already exists), so an old Kea doesn't break.
11. **Scale honesty:**
    - The Hub on one PC handles thousands of accounts fine (SQLite).
    - It doesn't handle thousands of *concurrent live viewers*.
    - The move to a rented server is planned as a config change, not a rewrite.

---

## 10. Build passes (honest sizes)

**Pass 1: the foundation.** The goal: the owner installs KeaS, sets up the Hub, signs in with a real account in KeaS **and** Kea, makes an org, and assigns a class.
- **Hub service:**
  - accounts, Argon2id, rate limiting, TOTP, email verification and reset (through a configurable SMTP account);
  - signed tokens;
  - the localhost owner console;
  - the org registry and join codes;
  - the audit log;
  - encrypted backups.
- **KeaS desktop:**
  - an Electron shell around the server and the web app;
  - the first-run wizard (§4) with the Hub, org-on-this-PC and join-by-code paths;
  - Cloudflare Tunnel setup;
  - a Windows installer.
- **Org model upgrade:**
  - the department tree;
  - cost centers;
  - budgets against scheduled and actual labor;
  - roles and permissions;
  - real people replacing the demo login.
- **Classes v1:**
  - create a class, with sessions on the org calendar;
  - assign or enroll people;
  - attendance;
  - completion issues a cert;
  - the hosting application and the general-curriculum gate on the Hub.
- **Kea:**
  - sign in with a Hub account;
  - the mode picker (Personal, School, Work);
  - join an org by code;
  - org classes and shifts in Kea's calendar.
- **Claude connector:** a KeaS skill that drafts a cited jurisdiction-pack change (stays unverified).
- **Size:** large. Expect several working sessions, not one. Security and the wizard get tests first.

**Pass 2:**
- live classes (LiveKit + TURN);
- study groups;
- leaderboards and levels with server grading;
- the class package import from the library;
- data import from other payroll providers.

**Pass 3+:** payroll breadth from `plan.md` (15a–15d, about 330–610 hours), the bank API, onboarding and offboarding, PTO policies, the approvals engine, the report builder, expenses, ATS, performance, SSO.

**Pass 1 does not include** real money movement or finalized pay runs. Both stay blocked until the tax tables are verified and the bank API work is done.

---

## 11. Decisions needed from the user
1. **Tunnel:**
   - Cloudflare Tunnel with your own domain (recommended; about $10 a year, adds a free Cloudflare account);
   - or Tailscale Funnel (no domain, fewer protections).
2. **Payroll data stays on the payroll admin's PC** (recommended, already decided in `plan.md`), not on the Hub. Confirm.
3. **Claude:** required only for adding or updating tax and labor packs (recommended), or required for all payroll use?
4. **Email sender** for verification: a new Gmail account for Kea with an app password (simplest), or a transactional service.
5. **Pass 1 scope** as in §10, or swap something in (for example leaderboards earlier).
