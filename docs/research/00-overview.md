# KeaS — Research Overview & Recommended Plan

_Compiled 2026-10-21 from four research reports in this folder. Not legal advice — have an employment attorney review the scoring rules before they affect hours or discipline._

| File | Topic |
|---|---|
| [01-competitor-and-feature-research.md](01-competitor-and-feature-research.md) | Paycom/UKG/others feature matrix, pricing, complaints, open-source alternatives, payroll strategy |
| [02-scheduling-scoring-and-certifications.md](02-scheduling-scoring-and-certifications.md) | Shift bidding, scoring model, schedule algorithm, labor-law constraints, certifications, data model |
| [03-parent-feedback-system.md](03-parent-feedback-system.md) | Feedback form, distribution, fair rating formula, bias/legal, implementation |
| [04-open-source-security-and-hosting.md](04-open-source-security-and-hosting.md) | License choice, data compliance, security checklist, hosting costs, tech stack |

---

## 1. Positioning: how to compete with Paycom

Don't fight Paycom on payroll. Win where they're weak:

- **Price model:** Paycom/UKG charge ~$21–41 per employee per month — brutal for seasonal/part-time staff. KeaS is free to self-host; paid hosting (if offered) priced per location, not per head.
- **No lock-in:** Paycom complaints center on 3-year contracts, surprise fees, poor support. KeaS: open data, export everything, cancel anytime.
- **Resilience:** UKG's 2021 ransomware outage pushed employers to paper payroll for weeks. Self-hostable + offline kiosk punching is a direct answer.
- **Transparency:** staff can see exactly why their score, hours, and shift awards are what they are ("explain my score / explain my hours").
- **Niche no one serves:** seasonal & youth hourly workforces (pools, rec centers, camps, parks). No open-source project has cert-gated scheduling, minor-labor guardrails, an open-shift marketplace, and performance-weighted bidding together.

**Payroll:** do NOT process payroll or file taxes yourself (treated as money transmission in many states; requires licenses/bonds). Phase 1: export approved hours to Paycom/ADP/Gusto/QuickBooks. Later: optional paid add-on via an embedded payroll API (Check, Gusto Embedded, Zeal).

## 2. Feature list (consolidated)

**Core (MVP)**
- Staff profiles, roles (staff / supervisor / manager / admin)
- Availability entry (recurring + date exceptions)
- Shift templates, open shifts, shift bidding with ranked preferences
- Auto schedule builder (score-weighted, constraint-checked) + manager review before publish
- Cover/swap marketplace with manager approval; all coverage tracked
- Time clock: kiosk PIN + optional photo, geofence/facility Wi‑Fi check, offline queue (PWA)
- Punctuality metrics: clock-in vs. shift start, per person and trend
- Staff score with full event history, disputes, manager override
- Certifications: upload, manager verification, expiry reminders (90/60/30/14/7 days), auto-block from roles requiring them
- Minor work-hour rules enforced in scheduler AND cover/swap flows
- Payroll export (CSV per provider)
- Append-only audit log (punch edits, score changes, overrides)

**Phase 2**
- Parent feedback forms (tokenized links per session block) feeding the score
- SMS notifications (opt-in), push notifications
- Optimization solver (OR-Tools CP-SAT) behind the same scheduler interface
- Lesson-enrollment-driven staffing, pool rotation
- Optional fair-workweek mode

**Phase 3+**
- Embedded payroll add-on, PTO accrual, onboarding docs, hosted multi-tenant offering

## 3. The scoring system — reconciled design

Everyone starts at **100** (floor 50, ceiling 150). Score is always **recomputed from events**, never edited directly. Events decay (half-life 90 days, drop after 365).

| Event | Points | Notes |
|---|---|---|
| Cover someone's shift | +3 to +7 (by notice) | cap +12 / 30 days |
| Get covered, 72h+ notice | 0 | |
| Get covered, 24–72h | −1 | |
| Get covered, <24h | −2 | |
| No-call/no-show | −15 | manager must confirm |
| Late 0–5 min | 0 | grace |
| Late 6–15 min | −1 | |
| Late >15 min | −3 | |
| Arrive 10–20 min early | +0.5 | cap +4 / month; >20 early = 0 |
| Parent feedback | 0 to +10 (bonus-only at launch) | see below |
| **Protected absence** (sick leave, FMLA, ADA, etc.) | **always 0** | hard rule, enforced by tests |

**Parent feedback** — use report 03's formula instead of a flat "+2 per 5-star review": normalize per class level, Bayesian-shrink toward the facility mean (8 phantom average ratings), one response per family, 6‑month half-life, minimum 5 responses from 3 families before any points. Low ratings go to a manager for review, not automatic deductions. Keep feedback ≤15–20% of score influence (customer ratings carry documented gender/race bias).

**Fairness guards so top scorers don't take everything:** score advantage shrinks as someone nears their desired hours; optional tiers (A/B/C) so tiny differences don't matter; draft-style award rounds; caps on premium shifts. **Tie-break:** fewer hours awarded → higher bid rank → hire date → stored random seed.

**Clock-in pay rule:** pay exact punch times (no rounding). Record "arrived" separately from "clocked in" — early arrivals that involve work (chemical checks, opening) must be paid.

## 4. Must-have legal guardrails

- **Protected leave never costs points** (CA, NYC, NY State, FMLA, ADA). Absence reason list with "protected" flag; no automatic discipline.
- **Minors (federal, ages 14–15):** max 3 h school day, 18 h school week, 8 h non-school day, 40 h non-school week; 7am–7pm (9pm June 1–Labor Day). 14-year-olds can't lifeguard; 15-year-olds only at pools with certification. Check your state's rules (often stricter, also for 16–17).
- **Record retention:** time records 2 years, payroll 3 years, tax records 4 years. Never delete punches; edits are new versions.
- **Biometrics:** don't use fingerprint/face clock-in (Illinois BIPA liability; minors can't consent).
- **SMS:** opt-in only, STOP/HELP, 10DLC registration, send 10am–7pm.

## 5. Open source, security & hosting

- **License: AGPL-3.0** (others can self-host free; nobody can sell a closed hosted copy). Use a CLA if you want to keep the option of paid enterprise features.
- **Biggest open-source risk is leaked secrets**, not public code. Enable GitHub push protection + gitleaks from commit #1. Never commit `.env`.
- **Collect less:** no SSNs, bank info, I-9s, or biometrics in v1 — the payroll provider holds those.
- **Security priorities:** proven auth library (Better Auth), passkeys/TOTP MFA required for anyone who can edit time or scores, server-side role checks + Postgres row-level security, append-only audit log, TLS (Caddy/Let's Encrypt), encrypted backups offsite (3‑2‑1) with tested restores, Dependabot/CodeQL/Trivy in CI, SECURITY.md, OWASP ASVS Level 1 now / Level 2 before hosting for others.
- **Hosting:** one VPS (~$6.50–12/mo, Hetzner or DigitalOcean) + Docker Compose + Postgres + Caddy + Backblaze B2 backups ≈ **$10–20/month**. Free PaaS tiers sleep or expire — unsuitable for a time clock. Cloudflare Tunnel/WAF (free) recommended. Avoid a home server for minors' data.
- **Liability:** the moment you host it for an organization, you're responsible — written terms, incident plan, consider an LLC + insurance.

## 6. Recommended tech stack

TypeScript · Next.js (or SvelteKit) · PostgreSQL · Drizzle ORM · Better Auth · pg-boss (background jobs: cert reminders, bid deadlines, feedback emails) · Resend/Brevo (email) · PWA for mobile clock-in & push · Docker Compose · GitHub Actions (CodeQL, Trivy, Dependabot).

## 7. Suggested roadmap

1. **Weeks 0–2 — Validate:** interview managers/staff at your facility; finalize point values and absence categories; confirm your state's minor-labor and sick-leave rules.
2. **Months 1–4 — MVP:** auth/roles, staff + certs, availability, shifts + bidding, greedy scheduler, cover/swap, time clock, score engine + history, audit log, payroll CSV export.
3. **Season 1 — Harden:** run alongside your current system; tune scoring; add parent feedback (start with the Google Form + Apps Script bridge if needed, then build in-app, ~2–3 dev-weeks).
4. **Later:** OR-Tools solver, SMS, more facilities, optional hosted plan and embedded payroll add-on.

## 8. Open questions for you

- Which state(s) will this run in? (Drives minor-labor, sick-leave, and privacy rules.)
- Is the facility private, a nonprofit (YMCA-style), or city-run? (City-run → public-records rules.)
- Unionized staff? (Scoring may need to be bargained.)
- Which payroll system do you use today? (First export target.)
- Do you plan to eventually offer hosted KeaS to other facilities, or just self-host?

## Items flagged "verify" in the reports
Cal.com's 2026 license change; the Illinois BIPA retroactivity ruling; Hetzner's current plans and prices; YMCA lifeguard cert validity; WSI renewal rules; the outcome of *Camp v. Home Depot* (California time-rounding case); state rules for 16–17-year-olds; Twilio 10DLC fees; vendor pricing estimates.
