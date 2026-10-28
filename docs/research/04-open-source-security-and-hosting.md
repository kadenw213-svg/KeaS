# 04 — Open Source, Security, Compliance, and Hosting

*Research date: 2026-10-21. Scope: a free, open-source workforce management app (timekeeping, scheduling with shift bidding and staff scores, availability, certification tracking with expiry alerts, parent feedback forms for swim lessons). The first deployment is likely an aquatics facility where many employees are minors.*

> **Not legal advice.** The retention periods and legal points below come from public sources. Have an employment or privacy attorney check them before you rely on them for a production deployment, especially before payroll or biometric features ship.

---

## TL;DR

- **License:** use **AGPL-3.0** for the core. If you later want a business model, add a separately licensed `/ee` folder later (the Cal.com, Formbricks and Twenty pattern). AGPL stops someone from hosting a closed fork as SaaS, it is OSI-approved, and it still lets any facility self-host for free.
- **Open source is not the main security risk.** The real risks are committed secrets, weak authentication and authorization, and insecure *deployments* by other people. Kerckhoffs's principle applies: the system must be secure even when the attacker knows the code.
- **Collect less data.** At first, do **not** store SSNs, bank or routing numbers, I-9 copies or biometrics. Let the payroll provider (Gusto, ADP and so on) hold them. Your app's job is time, schedules, certifications and feedback.
- **Retention rules you must support:** time cards for 2 years and payroll records for 3 years (FLSA), employment tax records for 4 years (IRS), and I-9s until the later of 3 years after hire or 1 year after termination. That means soft-delete plus retention policies, not hard deletes.
- **Security priorities:** a proven auth library with MFA or passkeys, server-side RBAC on every query, append-only audit logs for punch edits and score changes, TLS, encrypted backups with tested restores, and secret scanning from the first commit.
- **Hosting:** one small VPS (about $5–$15/mo) running Docker Compose with Postgres, Caddy for automatic TLS, and encrypted offsite backups (about $1–$6/mo). Total is about **$8–$25/month**. Avoid a home server for real employee data. Free PaaS tiers sleep or expire, so they are fine for demos and not for a time clock.
- **Stack:** TypeScript, Next.js (or SvelteKit), PostgreSQL, Drizzle, Better Auth, pg-boss for jobs, and a PWA for clock-in.

---

## 1. Risks of open-sourcing this app

### 1.1 "Attackers can read the code"

**The risk is real but smaller than it looks.** Public source makes it easier for attackers to find logic bugs, such as a missing permission check on `/api/timepunch/:id`, an IDOR on another employee's certification file, or a predictable reset token.

**Counterarguments:**
- **Kerckhoffs's principle:** a system should stay secure even if everything about it except the keys is public. If an HR app is secure only because its code is hidden, it is not secure. Closed-source apps get exploited constantly through black-box testing, leaked code or decompiled clients.
- **"Many eyes" (Linus's law):** this only helps when people actually look. Heartbleed sat in OpenSSL for years. Don't assume volunteers will audit you. Run your own SAST, dependency scanning and a published disclosure policy, which turns friendly researchers into reporters instead of exploiters.
- **What actually gets small orgs breached:** credential stuffing on accounts without MFA, unpatched dependencies, exposed admin panels and databases, leaked `.env` files, and phishing. None of these depend on whether your code is public.

**Takeaway:** design as if the attacker has the source. Every authorization decision is server-side, every secret lives outside the repo, and every default is secure.

### 1.2 Secrets accidentally committed

This is the most common way open-source projects hurt themselves. Bots scrape GitHub for keys within minutes of a push.
- Turn on **GitHub secret scanning push protection**. It has been free for all public repos since May 2023. It blocks a push that contains known secret formats, but it does not scan history and only covers well-known token formats ([GitHub blog](https://github.blog/news-insights/product-news/push-protection-is-generally-available-and-free-for-all-public-repositories/)).
- Add **gitleaks** as a pre-commit hook and a CI job. It also scans past commits and supports custom rules ([gitleaks](https://github.com/gitleaks/gitleaks), [Help Net Security](https://www.helpnetsecurity.com/2024/06/27/gitleaks-open-source-solution-detecting-secrets-in-code/)).
- Commit only `.env.example`. Put `.env*` in `.gitignore` from day one.
- **If a secret leaks, rotate it immediately.** Rewriting git history is not enough, because forks and caches keep the old commits.
- Never ship default admin passwords. Generate one at first boot, or force setup through a one-time wizard.

### 1.3 Forks or competitors commercializing your work

- With **MIT or Apache-2.0**, anyone, including a funded competitor or a payroll vendor, can take the code, close it and sell it as SaaS. That is legal and expected.
- With **GPL-3.0**, they must share source only if they *distribute* binaries. Running it as SaaS is not distribution (the "SaaS loophole").
- **AGPL-3.0** closes that loophole: anyone who lets users interact with a modified version over a network must offer those users the source.
- Real examples:
  - **Plausible** moved from MIT to AGPLv3 in Oct 2020. The goals were to stop its code being used in closed proprietary products, stop companies offering it as a service without contributing back, and stop products implying the original team endorsed them. Self-hosters and cloud customers were unaffected ([Plausible blog](https://plausible.io/blog/open-source-licenses), [LWN](https://lwn.net/Articles/834120/)). Some corporate users said AGPL ruled the product out for internal use. Google, for example, bans AGPL code internally.
  - **Cal.com** moved from MIT to AGPLv3 and added an `/ee` folder under a commercial license "to guard against large companies taking over" ([Cal.com blog](https://cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition)). It promised to relicense to MIT if it ever stops maintaining the project ([longevity post](https://cal.com/blog/longevity)). A May 2026 report says the public repo was renamed **Cal.diy** and relicensed MIT, with the enterprise code moved out ([isitreallyfoss tracker](https://zff.dev/danb/isitreallyfoss/issues/297)). *I could not verify this; check the repo.*
  - **Formbricks** uses an AGPLv3 core plus `/apps/web/modules/ee` under an Enterprise License that a license key unlocks. It runs a daily license check with a 3-day grace period ([Formbricks docs](https://formbricks.com/docs/self-hosting/advanced/license), [isitreallyfoss](https://isitreallyfoss.com/projects/formbricks)).
  - **Twenty CRM** has an AGPL-3.0 community edition. SSO, advanced RBAC and similar features sit in a proprietary `twenty-ee` package ([opentechhub](https://www.opentechhub.io/twenty/), secondary source).
  - **Odoo** has Community under LGPLv3 and a proprietary Enterprise edition at about $24–70/user/mo. That is classic open-core ([comparison](https://ecosire.com/blog/odoo-vs-frappe-vanilla-comparison-2026); verify the LICENSE in `odoo/odoo`).
  - **Frappe:** the framework is MIT, and ERPNext and Frappe HR are GPL-3.0. Frappe makes money from hosting (Frappe Cloud) and support rather than closed features. This is the closest analog to your project (verify the LICENSE in `frappe/hrms`).

### 1.4 Liability when someone else's deployment leaks data

- Every OSI license (MIT, Apache, GPL, AGPL) includes an **"AS IS" / no-warranty / limitation of liability** clause. That is your main protection for code other people self-host.
- **Where you become liable is when you operate it.** If *you* host it for the aquatics facility, you are a service provider or data processor. Then you need a written agreement (a simple DPA or terms of service), reasonable security, and breach notification duties (see Section 2).
- Reduce your exposure:
  - Write a clear README and SECURITY.md saying that self-hosters are responsible for their own deployments.
  - Ship secure defaults: TLS required, MFA available, no default credentials, and secure cookies.
  - Don't market it as "compliant" with anything you haven't been audited for.
  - If you host for others, consider an LLC and general liability or cyber insurance.

### 1.5 Support burden

Open-sourcing invites issues, feature requests and "it doesn't work on my Raspberry Pi" reports.
- **Mitigations:**
  - Issue templates.
  - GitHub Discussions for Q&A.
  - A short list of supported deployment paths (Docker Compose only at first).
  - A `CONTRIBUTING.md`.
  - Saying "no" to features outside your scope.
  - Labeling `good first issue` to grow contributors.
- Many projects (Plausible, Cal.com, Frappe) pay for this burden with paid hosting or support. That option stays open with AGPL.

### 1.6 Trademark

- Copyright licenses **do not grant trademark rights**. Apache-2.0 says so explicitly in §6.
- Pick a distinctive name and check the USPTO TESS search for conflicts, especially in HR or workforce software. Consider registering it later.
- Publish a short `TRADEMARK.md`: forks must rename if they distribute modified versions or sell hosting, and "powered by X" is fine. Plausible's third license goal ("don't imply endorsement") is essentially a trademark goal.

### 1.7 License comparison

| License | SaaS free-riding? | Copyleft | Patent grant | OSI-approved | Corporate adoption | Fit for this app |
|---|---|---|---|---|---|---|
| **MIT** | Allowed | None | No | Yes | Highest | Maximizes adoption, gives no protection |
| **Apache-2.0** | Allowed | None | **Yes** | Yes | Very high | Better than MIT if you want permissive |
| **GPL-3.0** | Allowed (SaaS loophole) | Strong, on distribution | Yes | Yes | Medium | Little benefit for a web app |
| **AGPL-3.0** | **Must share modified source with network users** | Strong, including network use | Yes | Yes | Lower (some companies ban it) | **Recommended** |
| **BSL 1.1** (MariaDB, HashiCorp) | Restricted by "Additional Use Grant" | Converts to open source after up to 4 years | Varies | **No** | Low | Too complex for a solo dev, and not "open source" |
| **FSL** (Sentry) | Competing use prohibited | Converts to Apache-2.0 or MIT **after 2 years**, per version | Apache variant: yes | **No** | Low–medium | Possible if you plan a company, but you couldn't call it "open source" ([fsl.software](https://fsl.software/), [Sentry blog](https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/)) |
| **Open-core** (AGPL core + commercial `/ee`) | Core protected; paid features closed | Mixed | — | Core yes | Medium | A good *later* step if you monetize |

**Recommendation: AGPL-3.0 for the whole repo now.**
1. It meets the user's goal of free and open source. It is OSI-approved, so you can honestly say "open source," which BSL and FSL do not allow.
2. It blocks the main threat: a UKG or Paycom competitor (or a reseller) taking the code and offering a closed hosted version.
3. Pools, schools and city parks departments can self-host it for free without obligation, as long as they don't modify and serve it without sharing.
4. It keeps options open:
   - **Add a CLA or DCO.** Use a Contributor License Agreement if you want to relicense or dual-license later. With only a DCO you need every contributor's consent to relicense.
   - **Add an `/ee` directory later** for features large organizations pay for, such as SSO/SAML, advanced audit export and multi-location rollups.
5. One caveat: if your goal becomes *maximum* adoption, including embedding by vendors, Apache-2.0 is the alternative. For a full app, as opposed to a library, AGPL's adoption cost is small.

---

## 2. Data sensitivity and compliance

### 2.1 Data you might hold, by sensitivity

| Tier | Data | Recommendation |
|---|---|---|
| **Critical** | SSNs, bank and routing numbers, I-9 documents and ID scans, biometric templates | **Don't collect (v1).** Leave them to the payroll provider. If unavoidable later, use field-level encryption and strict access. |
| **High** | DOB (identifies minors), home address, phone, emergency contacts, certification documents (Lifeguard, CPR/AED, WSI; these may show DOB and photo), disciplinary notes, staff scores, pay rates | Collect only what is needed. Encrypt sensitive fields. Use RBAC plus audit logging. |
| **Moderate** | Time punches, schedules, availability, shift bids | Integrity matters most here, for legal records: append-only edits with an audit trail. |
| **Minors (students)** | Parent feedback about swim students: child's name, level, instructor | Collect from parents only. Keep the child's data minimal (first name, class or level) and no photos. |

### 2.2 Laws and standards

**State data breach notification laws.**
- All 50 states, DC, Puerto Rico, Guam and USVI have one ([Privacy Rights Clearinghouse](https://privacyrights.org/blog/data-breach-notification-laws-now-all-50-states), [Jackson Lewis overview](https://www.jacksonlewis.com/insights/state-data-breach-notification-laws-overview-patchwork)).
- "Personal information" typically means name **plus** SSN, driver's license or state ID, or a financial account number with its access code. Many states also count biometrics, usernames with passwords, and medical or health insurance data.
- **If you don't store SSNs, bank numbers or biometrics, most of your data falls outside the trigger definitions.** That is the strongest argument for minimizing data.
- Deadlines vary. Some states require notice within 30–45 days, and some require notice to the attorney general.

**CCPA/CPRA (California).**
- The employee data exemption expired **January 1, 2023**. Employees and applicants of covered businesses now have rights to know, delete, correct and limit use of sensitive personal information ([Holland & Knight](https://hklaw.com/en/insights/publications/2022/12/california-employee-data-exemption-expires-on-january-1), [Morgan Lewis](https://www.morganlewis.com/pubs/2022/10/california-consumer-privacy-act-employee-and-b2b-exemptions-expire-january-1-2023)).
- It applies only to businesses above the thresholds (roughly $25M+ revenue, adjusted for inflation, among other tests). A single city pool usually won't qualify, and government entities are exempt.
- Still, build "export my data," "correct my data" and retention-aware deletion features. Larger customers will ask for them, and other state privacy laws are similar.

**FLSA recordkeeping (29 CFR Part 516).**
- **Payroll records** (name, address, DOB if under 19, hours per day and week, wages): keep **3 years** (§516.5).
- **Time cards, work schedules and wage-rate tables**: keep **2 years** (§516.6) ([DOL Fact Sheet #21](https://www.dol.gov/agencies/whd/fact-sheets/21-flsa-recordkeeping), [NMU summary](https://nmu.edu/compliance/299), [state-by-state table](https://www.clockspot.com/articles/recordkeeping-requirements-by-state)).
- Records must be available for inspection, and many states require longer periods (for example, California and New York require longer for some records).
- **Note for minors:** the FLSA requires the **date of birth for employees under 19**. Your schema needs DOB anyway for child labor hour rules.
- Feature idea: warn when scheduling 14–15-year-olds outside FLSA hour limits. That generally means no more than 3 hours on a school day, 18 hours in a school week, and no work after 7 pm (9 pm from June 1 to Labor Day). Verify against 29 CFR 570 and state law.
- **Design implication:** *never hard-delete time punches.* Edits create new versions with reason, editor and timestamp. Set the retention default to at least 3 years, and make it configurable per state.

**IRS.**
- Keep employment tax records for **at least 4 years after filing the 4th-quarter return** for the year ([IRS employment tax recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-recordkeeping)).
- This mostly falls on the payroll provider. If your app exports hours that feed payroll, keep those exports and their source records for 4 years to be safe.

**Form I-9.**
- Retain until the **later of 3 years after hire or 1 year after termination** ([SHRM](https://shrm.org/topics-tools/tools/how-to-guides/how-to-retain-file-9-forms), [Tennessee MTAS](https://www.mtas.tennessee.edu/reference/i-9-record-maintenance-and-retention); primary source is 8 CFR 274a.2 and USCIS M-274).
- Inspections require production within 3 business days.
- **Recommendation:** don't store I-9s in v1. If you add them later, keep them in a separate, restricted store with an automatic purge date calculation.

**SOC 2.**
- No law requires it. It is an AICPA attestation that mid-size and large customers ask SaaS vendors for. Type I costs roughly $10k–$30k+, and Type II requires 6–12 months of evidence.
- For self-hosted open source it is irrelevant: the customer runs it.
- If you ever sell hosting, adopting SOC 2-style controls early (access reviews, change management, logging, backups, incident response) makes a later audit much cheaper. The checklist at the end lines up with those controls.

**PCI DSS.**
- This only matters if you take card payments, for example swim lesson registration fees.
- **Never touch card data.** Use Stripe Checkout or Payment Links, a hosted redirect, so you stay in the simplest PCI scope (SAQ A).

**Minors.**
- **COPPA** applies to online services directed to children under 13 that collect personal information *from* them. Parent feedback forms collect from parents, so keep it that way and don't let children create accounts.
- Teen employees (14–17) are not COPPA subjects as employees. Some state privacy and child-data laws add duties for minors' data, and a breach involving minors draws more attention.
- Keep minors' data lean. Don't use staff photos publicly. Limit visibility of minors' DOB and contact info to managers.

**Biometrics (Illinois BIPA and others).**
- See Section 3.10. Short version: **don't do fingerprint or face punch-in for v1.**

### 2.3 Data minimization recommendations

1. **No SSN, bank or routing numbers, or I-9 images in v1.** Integrate with payroll providers instead: export hours as CSV first, then use APIs such as Gusto or Check.
2. Store **DOB** (needed for minor-labor rules) but show only an "is minor" flag to supervisors.
3. **Certification docs:**
   - Store the expiry date, cert type and issuer. The uploaded file is optional.
   - If you keep files, put them in private object storage behind signed short-lived URLs, never public buckets.
4. **Parent feedback:**
   - Make it a public form with rate limiting and CAPTCHA (Cloudflare Turnstile is free).
   - Collect parent email optionally, plus the child's first name and class.
   - Auto-purge after a defined period, for example 2 years.
5. Build **retention policies** into the schema: `retain_until`, legal hold flag, and a scheduled purge job.

---

## 3. Security methods, in priority order

### 3.1 Authentication (P0)

**Don't write your own auth.** Use a proven library or identity provider:

| Option | Type | Notes |
|---|---|---|
| **Better Auth** | TS library, in-app, your DB | Supports email/password, passkeys, TOTP 2FA, OAuth/OIDC, organizations and RBAC plugins. Took over maintenance of **Auth.js/NextAuth** in Sept 2025 and recommends itself for new projects ([announcement](https://www.better-auth.com/blog/authjs-joins-better-auth)). Joined Vercel in July 2026 ([blog](https://better-auth.com/blog/better-auth-joins-vercel)). **Best fit for a solo TS dev.** |
| Auth.js (NextAuth) | TS library | Now maintenance-mode (security fixes); prefer Better Auth for new code. |
| **Keycloak** | Self-hosted IdP (Java) | Very mature: SAML, OIDC, MFA, LDAP. Heavy (about 512MB–1GB RAM) and more ops work. |
| **Authentik** | Self-hosted IdP (Python) | Friendlier UI than Keycloak and good for SSO across multiple apps. Still a separate service to run. |
| Ory (Kratos/Hydra) | Self-hosted or cloud, Go | Powerful, API-first, steeper learning curve. |
| Supabase Auth | Managed (or self-hosted GoTrue) | Easy if you use Supabase, but it ties you to their platform. Free tier pauses (see Section 4). |

Requirements:
- **Passkeys (WebAuthn)** for managers and admins, with a **TOTP MFA** fallback. **Require MFA for any role that can edit time or scores.**
- **OIDC SSO** (Google Workspace or Microsoft 365) as an option for facilities that use them.
- **Minor staff:**
  - Many teens won't have work email. Support username or phone login plus passkey.
  - Use **magic links or SMS only as fallbacks.** SMS is phishable and costs money.
- Session cookies set to `HttpOnly; Secure; SameSite=Lax`. Rotate the session on login and privilege change, and use short admin session lifetimes.
- **Password hashing: argon2id.** OWASP's minimum is m=19 MiB, t=2, p=1 ([OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). Better Auth uses scrypt by default, which OWASP also accepts. Either is fine; don't use bcrypt with a low cost, and never use SHA-256.
- Check new passwords against breached-password lists (HIBP k-anonymity API) per NIST SP 800-63B. Don't force periodic rotation.

### 3.2 Authorization: RBAC and row-level security (P0)

- **Roles:**
  - `staff`: own schedule, punches, availability, bids and certs.
  - `supervisor`: their team, approve swaps, view scores.
  - `manager`: edit schedules and scores, approve punch edits, reports.
  - `admin`: org settings, users, retention, integrations.
- **Scope every query by `org_id` and `location_id`**, even with one tenant. Retrofitting multi-tenancy is painful.
- Enforce access in **one server-side policy layer**, for example `can(user, "edit", timePunch)`. Never rely on hiding UI buttons.
- **Postgres Row-Level Security (RLS)** is a second layer: `SET app.current_org = ...` per request, plus policies on each table. It is mandatory if clients talk to the DB directly (Supabase style). If you use an ORM server-side, RLS is still good defense in depth for tenant isolation.
- Test authorization: write tests asserting that staff A **cannot** read or modify staff B's punches or scores (IDOR is OWASP A01, Broken Access Control).

### 3.3 Immutable audit logs (P0 for this domain)

Time punch edits and staff score changes are legally and politically sensitive. Wage claims, favoritism complaints and "my supervisor changed my hours" disputes all turn on this trail.
- Use an append-only `audit_events` table: actor, action, entity, before and after JSON, reason (required for punch edits), IP or device, and timestamp.
- **Make it tamper-evident:**
  - Revoke `UPDATE` and `DELETE` on the table from the app's DB role.
  - Optionally hash-chain rows (`hash = sha256(prev_hash || row)`).
  - Ship logs periodically to separate storage, such as an object-locked S3/B2 bucket.
- Never edit punches in place. Store original punches, plus **adjustments** that reference them.
- Show employees their own punch-edit history. That transparency reduces disputes and is required in some states.

### 3.4 Encryption (P0/P1)

- **In transit:** use TLS everywhere through **Caddy** (automatic Let's Encrypt), Traefik, or certbot with Nginx. Add an HSTS header. Use TLS to the DB when it is not on localhost.
- **At rest:**
  - Use full-disk or volume encryption. Most VPS providers' block storage is encrypted at rest, so confirm yours is.
  - Managed Postgres (Neon, Supabase) encrypts at rest.
- **Field-level encryption** for the high-sensitivity columns you do store (DOB, phone, emergency contact, and SSN or bank details if ever added):
  - Use app-side AES-256-GCM via libsodium or `node:crypto`, with a key from env or KMS. **Keep the key off the DB host's backups.**
  - Use blind indexes (HMAC) if you need to search encrypted fields.
- Backups are encrypted with a separate key (see Section 3.8).

### 3.5 OWASP Top 10 and ASVS (P1)

- Use **OWASP ASVS 5.0** (released 30 May 2025, about 350 requirements in 17 chapters; [asvs.dev](https://asvs.dev), [SoftwareMill summary](https://softwaremill.com/whats-new-in-asvs-5-0/)) as your checklist. Target **Level 1 now and Level 2 for anything hosted for others.** Level 2 is the right bar for apps handling PII.
- Key items for this app:
  - Parameterized queries (ORMs handle this).
  - Output encoding (React and Svelte escape by default; avoid `dangerouslySetInnerHTML`).
  - CSRF protection (SameSite cookies plus framework tokens).
  - File upload validation (type and size checks, store outside the web root, scan if feasible).
  - A strict Content-Security-Policy.
  - SSRF protection if you fetch URLs.
  - Generic error messages.
  - Dependency hygiene.

### 3.6 Rate limiting and abuse protection (P1)

- Rate-limit login, password reset, MFA verification, kiosk PIN entry and the **public parent feedback form**.
  - Better Auth has built-in rate limiting.
  - Otherwise, use a Postgres or Redis token bucket, or Cloudflare's free WAF rules.
- Lock accounts with progressive delays rather than hard locks, so attackers can't lock staff out.
- Use Cloudflare **Turnstile** on public forms.

### 3.7 Supply chain: dependency, secret and code scanning (P1, mostly free)

| Concern | Tool (free for public repos) |
|---|---|
| Vulnerable dependencies | **Dependabot** alerts and security updates, or **Renovate** (better grouping and automerge for patch versions) |
| Container and OS vulnerabilities | **Trivy** in CI on your Docker image (`trivy image`), plus `trivy fs` for IaC |
| Secrets | GitHub **push protection** plus **gitleaks** (pre-commit and CI) |
| SAST | **CodeQL** (GitHub code scanning, free for public repos) and/or **Semgrep** CE rules |
| Lockfiles | Commit `pnpm-lock.yaml`; use `pnpm install --frozen-lockfile` in CI; consider `pnpm`'s `minimumReleaseAge` to avoid freshly published malicious versions (npm supply-chain worms hit in 2025) |
| Repo hygiene | Branch protection, required reviews or CI checks, and **OpenSSF Scorecard** action |

### 3.8 Backups: 3-2-1, encrypted, tested (P0)

- **3 copies, 2 media, 1 offsite.**
- Run nightly `pg_dump` (or continuous WAL archiving via **pgBackRest** or **WAL-G** for point-in-time recovery), then **restic** or **Borg** (encrypted and deduplicated) to **Backblaze B2**, Cloudflare R2 or Hetzner Storage Box.
- Enable **object lock or immutability** on the bucket so ransomware or a compromised server can't delete backups.
- **Test restores monthly**: an automated job restores to a scratch DB and runs sanity queries. A backup you have never restored is unproven.
- Store the backup encryption key outside the server, in a password manager, and keep a second copy offline.
- Back up uploaded files (certification docs) as well as the DB.

### 3.9 Disclosure, releases and operations (P1/P2)

- **`SECURITY.md`:**
  - Supported versions.
  - A private reporting channel (enable **GitHub Private Vulnerability Reporting**).
  - Response SLA (for example, acknowledge in 3 days).
  - Safe-harbor language.
- Publish fixes through GitHub Security Advisories (GHSA, which can issue CVEs).
- **Signed releases:** sign container images with **cosign** (Sigstore keyless via GitHub OIDC) and generate SBOMs (Syft) plus build provenance (`actions/attest-build-provenance`). Tag releases with signed git tags.
- Ship a **secure-by-default `docker-compose.yml`**:
  - Postgres not exposed publicly.
  - The app runs as non-root.
  - Secrets come from env files outside the repo.
- Server hardening:
  - SSH keys only, root login disabled.
  - `unattended-upgrades` on, firewall (ufw or provider firewall) allowing only 80, 443 and SSH (or SSH only via Tailscale).
  - fail2ban.
- Monitoring:
  - Uptime monitoring (Uptime Kuma, or free Better Stack / UptimeRobot).
  - Error tracking (Sentry free tier or GlitchTip self-hosted).
  - An alert on failed backup jobs.
- An incident response one-pager: who to call, how to rotate keys, and how to assess notification duties.

### 3.10 Time-clock anti-fraud (buddy punching) vs. privacy

Options, from least to most invasive:

1. **Kiosk mode with a per-employee PIN.** A shared tablet at the front desk runs a locked-down PWA (Guided Access on iOS, screen pinning on Android). The kiosk device authenticates once with a device token. Staff enter a 4–6 digit PIN, rate-limited. This is cheap and familiar.
2. **Kiosk PIN plus photo capture.** Take a snapshot at punch time and store it for manager review. **This is *not* biometric** as long as you don't run face recognition or extract face geometry. Disclose it to staff and get written acknowledgment. Auto-delete photos after, for example, 30–90 days.
3. **Mobile PWA with geofencing.**
   - Allow a punch only within X meters of the facility, using the browser Geolocation API checked server-side.
   - GPS can be spoofed, so treat it as a *signal*, not proof.
   - Capture location **only at punch time**, never continuous tracking.
   - Disclose it in policy; some states restrict employee location tracking.
4. **Network or IP restriction.** Allow mobile punches only on the facility Wi-Fi's public IP. It is simple and surprisingly effective.
5. **Device binding.** Each staff phone registers once (a passkey bound to the device, or a device token), and an alert fires if the same device punches for two people.
6. **Rotating QR code on the kiosk.** Staff scan a QR code that changes every 30s with their own phone, which proves presence plus identity through their own login.
7. **Biometrics (fingerprint or face recognition): avoid in v1.**
   - **Illinois BIPA** requires written notice, a published retention schedule and written consent *before* collection. It provides liquidated damages of $1,000 per negligent violation and $5,000 per reckless one.
   - The Aug 2024 amendment (SB 2979) limits recovery to **one violation per person per collection method** (rather than per scan, after the *Cothron* ruling) and allows e-signature consent ([Greenberg Traurig](https://www.gtlaw.com/en/insights/2024/8/bipa-update-illinois-limits-liability-and-clarifies-electronic-consent-for-biometric-data-collection), [Taft](https://www.taftlaw.com/news-events/law-bulletins/illinois-bipa-reform-new-legislation-promises-stronger-privacy-protections-and-clearer-guidelines-for-businesses/)).
   - The 7th Circuit reportedly held in April 2026 that the amendment applies retroactively ([HC Mag](https://www.hcamag.com/us/specialization/employment-law/seventh-circuit-limits-bipa-damages-to-one-recovery-per-employee/570970); verify).
   - Texas (CUBI), Washington and several cities (for example, NYC and Portland) have biometric rules too, and **minors can't give legal consent themselves.**
   - Timeclock vendors have paid large BIPA settlements. Biometric data is also breach-notification-triggering data in many states.
   - **Conclusion:** options 1, 2, 4 and 6 give most of the anti-fraud value with very little legal risk.

**Recommended v1:** kiosk plus PIN plus optional punch photo, mobile punch restricted by geofence **or** facility IP (configurable), and a manager exceptions report (missed punches, punches outside the geofence, overlapping devices).

---

## 4. Hosting options for a small organization

*Prices are mid/late-2026 and change often; Hetzner raised prices twice in 2026. Verify on vendor pages.*

| Option | Est. monthly cost | Pros | Cons / risks |
|---|---|---|---|
| **Home server** (old PC or mini-PC) | $0–$10 (power) | Free hardware, full control | Residential IP and ISP terms. Power and internet outages kill the time clock. You personally hold minors' PII at home. Physical theft. No SLA. **Not recommended for real employee data.** If used, put it behind Cloudflare Tunnel and never port-forward. |
| **Hetzner Cloud** (CX23: 2 vCPU / 4GB) | ~€5.49 + €0.50 IPv4 ≈ **$6.50** | Best price for performance; EU and US locations; cheap Storage Box backups | Prices rose in April and June 2026 ([WZ-IT](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/), [Northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases)). The cost-optimized CX line was reported "currently not available" in Aug 2026 ([Findstack](https://findstack.com/resources/hetzner-price-increase-2026)). Limited US locations. |
| **DigitalOcean** Droplet | $6 (1GB), $12 (2GB), $24 (4GB) ([infratally](https://infratally.com/articles/digitalocean-droplet-pricing-guide-2026/)) | Great docs, simple UI, US datacenters, +20% for weekly backups | Pricier per GB of RAM |
| **Akamai Linode** | $5 Nanode 1GB, $12 2GB, $24 4GB ([subger](https://subger.com/en/service/linode)) | Similar to DO, cheap egress | Similar |
| **Railway** | Hobby $5/mo including $5 usage; realistic app plus DB is $5–$15 | Easiest deploys from git, no cold starts | Usage-based bill can surprise you; free plan is only a trial or tiny credit ([Findstack comparison](https://findstack.com/resources/railway-vs-render-vs-fly-io)) |
| **Render** | Free web service **sleeps after 15 min** (about 1 min cold start); **free Postgres expires after 30 days**; Starter $7 plus DB from about $6–$7 | Simple, good DX | Free tier unusable for a time clock ([Render](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)) |
| **Fly.io** | No real free tier for new accounts; small VM about $2–$5 plus volume and Postgres | Edge regions, Docker-native | More ops complexity ([price history](https://www.saaspricepulse.com/blog/flyio-pricing-history)) |
| **Supabase** (managed Postgres, Auth, Storage) | Free: 500MB DB, 1GB files, **pauses after 7 days of inactivity**; Pro **$25/mo** | Postgres, RLS, auth and storage in one; daily backups on Pro | Free tier pauses, which is risky for production; vendor coupling ([Makerkit](https://makerkit.dev/blog/saas/supabase-pricing), [JetAdmin](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/)) |
| **Neon** (serverless Postgres) | Free: 0.5GB/project (reports of 1GB), scales to zero, no time limit; paid from about $5–$19 | Branching for dev; generous free tier | Cold-start latency on scale-to-zero; storage cap ([costbench](https://costbench.com/software/database-as-service/neon/free-plan)) |
| **Cloudflare Tunnel / Zero Trust** | **Free** (Zero Trust free for up to 50 users) | Exposes a server with no open inbound ports; hides origin IP; free WAF, DDoS protection, Turnstile; Access can gate `/admin` | Cloudflare terminates TLS, so it can see traffic. Fine for most, but note it. |
| **Backups: Backblaze B2 / Cloudflare R2 / Hetzner Storage Box** | ~$1–$6 | Cheap, offsite; B2 supports object lock | — |

### Recommended setups

**A. Production for one facility (recommended): about $10–$20/month**
- One VPS (DigitalOcean 2GB at $12, or Hetzner about $6.50) in a US region near the facility.
- **Docker Compose** with `caddy` (auto-TLS), `app` (Next.js), `worker` (jobs), and `postgres:17` (not exposed).
- Optionally put the app behind **Cloudflare** (proxy or Tunnel) for free WAF and DDoS protection.
- Backups:
  - The provider's server snapshots (about $2.40/mo on DO).
  - Plus **restic to Backblaze B2 with object lock**, about $1/mo for small data.
- Free uptime monitoring and Sentry free tier.
- **Total: about $10–$20/month.**

**B. Lowest-ops / "managed DB": about $12–$40/month**
- App on Railway or Render Starter ($5–$7).
- **Neon** (free or $5–$19) or **Supabase Pro** ($25) for managed Postgres with PITR and backups.
- Less server patching, higher cost, more vendors.

**C. Demo or staging: about $0**
- Neon free plus Render free or a Railway trial.
- Acceptable for demos with **fake data only**.

**Ops notes:**
- A time clock needs **high availability during operating hours**. Provide an **offline-capable PWA kiosk** that queues punches locally (IndexedDB) and syncs when back online, with server-side timestamps reconciled against device time.
- Keep `docker compose pull && up -d` plus migrations as a one-command upgrade. Document it, since self-hosters will need it.

---

## 5. Recommended tech stack (solo or small team)

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** end-to-end | One language for UI, API and jobs; type safety on a complex domain (shifts, punches, bids); biggest hiring and contributor pool. |
| Framework | **Next.js (App Router)**, or **SvelteKit** if you prefer it | Next.js has the largest ecosystem and Better Auth's primary target. SvelteKit is simpler and lighter. Either works; pick the one you'll ship faster in. Use `output: "standalone"` for a small Docker image. |
| Database | **PostgreSQL 16/17** | Relational data (orgs → locations → positions → shifts → bids → punches); `tstzrange` plus **exclusion constraints** prevent overlapping shifts at the DB level; JSONB for audit diffs; RLS; runs anywhere (VPS, Neon, Supabase). |
| ORM / queries | **Drizzle ORM** (or Prisma) | Drizzle is SQL-like, lightweight, has good migrations, and makes raw SQL (exclusion constraints, RLS policies) easy. Prisma is fine too but heavier, and RLS is awkward with it. |
| Auth | **Better Auth** | Passkeys, TOTP, OIDC, organization and role plugins, rate limiting, and it stores data in your Postgres. Add Authentik or Keycloak later only if customers demand SAML. |
| Validation | **Zod** | Shared schemas for forms, API input and env vars. |
| Background jobs | **pg-boss** (Postgres-backed queue) or **Graphile Worker** | No Redis needed. Handles cert-expiry alerts (30/14/7 days before), shift reminders, bid-window close and award, retention purges, backup verification. BullMQ plus Redis if you outgrow it. |
| Notifications | Email: **Resend**, Postmark or AWS SES (pennies); **Web Push** (VAPID, free) via PWA; SMS via Twilio only if needed (costs money, and 10DLC registration is required) | Teens respond to push and SMS more than email. Web Push on iOS works for installed PWAs (iOS 16.4+). |
| Mobile | **PWA** (installable, offline punch queue, push) | One codebase, no app store review, and kiosk mode on a tablet. Consider Capacitor later only if you need native APIs. |
| UI | **Tailwind CSS + shadcn/ui** (React) or Skeleton/Bits UI (Svelte) | Fast, accessible components; a calendar or scheduler via FullCalendar or a custom grid. |
| File storage | S3-compatible (**MinIO** self-hosted, Cloudflare R2, or B2) with presigned URLs | Certification docs; private buckets only. |
| Testing | **Vitest** (unit), **Playwright** (e2e, including authorization tests) | Authorization regression tests are your most valuable security tests. |
| CI/CD | **GitHub Actions**: lint, typecheck, test, CodeQL, gitleaks, Trivy, build and sign the image, push to GHCR | Free for public repos. |
| Deploy | **Docker Compose + Caddy** | One file self-hosters can run; matches recommendation 4A. |
| Observability | Sentry or GlitchTip, plus pino structured logs, plus Uptime Kuma | Cheap or free. |

**Domain-modeling tips that affect security and compliance:**
- Store all timestamps as `timestamptz` (UTC), and keep the facility time zone on the location. DST bugs cause wage errors.
- Keep punches append-only, with an `adjustments` table and reasons (see Section 3.3).
- Staff scores:
  - Store each score change as an event (who, when, why, rubric item).
  - Let staff see their own score history.
  - Define rules for how scores feed shift-bid priority, which reduces favoritism disputes.
- Certifications have `type`, `issued_at`, `expires_at`, `verified_by` and an optional `file_id`. The scheduler should **block or warn** when assigning someone with an expired required cert (for example, lifeguard or CPR).
- Minor flag from DOB, with configurable hour-limit rules per state.

---

## 6. Prioritized security checklist

### P0: before any real employee data goes in
- [ ] Repo: `.gitignore` covers `.env*`; GitHub **push protection** and secret scanning on; **gitleaks** pre-commit and CI; no default credentials anywhere.
- [ ] Choose and add **LICENSE (AGPL-3.0)**, **SECURITY.md** (private vulnerability reporting enabled), and CONTRIBUTING.md with DCO or CLA.
- [ ] Auth via **Better Auth** (or another proven IdP); **argon2id or scrypt** hashing; breached-password check; secure session cookies.
- [ ] **MFA required** (passkey or TOTP) for supervisor, manager and admin roles.
- [ ] **Server-side RBAC** on every endpoint and query, scoped by `org_id`; authorization tests for IDOR (staff A ≠ staff B).
- [ ] **Append-only audit log** for punch edits, score changes, role changes, cert changes and logins; the app's DB role cannot UPDATE or DELETE audit rows.
- [ ] **TLS everywhere** (Caddy or Let's Encrypt) plus HSTS; Postgres not exposed to the internet.
- [ ] **Data minimization:** no SSN, bank or I-9 storage; DOB visible only to managers; cert files in private storage with signed URLs.
- [ ] **Encrypted offsite backups** (restic to B2 with object lock), with one **successful test restore** documented.
- [ ] Server hardening: SSH keys only, firewall (80/443 only), unattended security upgrades, non-root containers.
- [ ] Rate limiting on login, reset, MFA, kiosk PIN and the public feedback form; Turnstile on public forms.

### P1: before or soon after launch
- [ ] **Dependabot or Renovate**, **CodeQL or Semgrep**, and **Trivy** image scanning in CI; fail builds on critical issues.
- [ ] Field-level encryption for DOB, phone and emergency contact (key kept off the DB backups).
- [ ] Postgres **RLS** policies for tenant isolation (defense in depth).
- [ ] Strict **CSP**, CSRF protection verified, file upload validation (type, size, storage outside the web root).
- [ ] Retention engine: configurable retention (default 3 years for time and payroll data, 4 years for payroll exports), legal hold, scheduled purge, and data export and correction for employees.
- [ ] Time-clock anti-fraud: kiosk device token plus PIN, optional punch photo with disclosure and auto-delete, geofence or IP restriction, exceptions report. **No biometrics.**
- [ ] Monitoring: uptime checks, error tracking, alerts on failed backups and repeated auth failures.
- [ ] Incident response one-pager (key rotation, contacts, breach-notification assessment by state).
- [ ] Self-assess against **OWASP ASVS 5.0 Level 1**.

### P2: maturity and hosting for others
- [ ] **Signed releases:** cosign-signed container images, SBOM (Syft), build provenance attestations; signed git tags.
- [ ] OpenSSF Scorecard and branch protection with required reviews.
- [ ] Hash-chained audit log, with periodic export to immutable storage.
- [ ] WAL archiving or PITR (pgBackRest or WAL-G); monthly automated restore tests.
- [ ] OIDC SSO (Google or Microsoft), and SAML through Authentik or Keycloak if requested.
- [ ] **ASVS Level 2** self-assessment; a third-party pentest before selling hosting.
- [ ] If offering hosted service: a DPA or terms template, an LLC plus cyber insurance, SOC 2-aligned controls (access reviews, change management, vendor list).
- [ ] TRADEMARK.md; consider registering the project name.

---

## Sources

- GitHub push protection free for public repos: https://github.blog/news-insights/product-news/push-protection-is-generally-available-and-free-for-all-public-repositories/
- Gitleaks: https://github.com/gitleaks/gitleaks ; https://www.helpnetsecurity.com/2024/06/27/gitleaks-open-source-solution-detecting-secrets-in-code/
- Plausible license change: https://plausible.io/blog/open-source-licenses ; https://lwn.net/Articles/834120/
- Cal.com AGPL and EE: https://cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition ; https://cal.com/blog/longevity ; reported Cal.diy MIT relicense (unverified): https://zff.dev/danb/isitreallyfoss/issues/297
- Formbricks license: https://formbricks.com/docs/self-hosting/advanced/license ; https://isitreallyfoss.com/projects/formbricks
- Twenty CRM licensing: https://www.opentechhub.io/twenty/
- Odoo vs. Frappe licensing: https://ecosire.com/blog/odoo-vs-frappe-vanilla-comparison-2026
- Functional Source License: https://fsl.software/ ; https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/
- DOL FLSA recordkeeping Fact Sheet #21: https://www.dol.gov/agencies/whd/fact-sheets/21-flsa-recordkeeping ; https://nmu.edu/compliance/299 ; https://www.clockspot.com/articles/recordkeeping-requirements-by-state
- IRS employment tax recordkeeping: https://www.irs.gov/businesses/small-businesses-self-employed/employment-tax-recordkeeping
- I-9 retention: https://shrm.org/topics-tools/tools/how-to-guides/how-to-retain-file-9-forms ; https://www.mtas.tennessee.edu/reference/i-9-record-maintenance-and-retention
- CCPA employee exemption expiry: https://hklaw.com/en/insights/publications/2022/12/california-employee-data-exemption-expires-on-january-1 ; https://www.morganlewis.com/pubs/2022/10/california-consumer-privacy-act-employee-and-b2b-exemptions-expire-january-1-2023
- State breach laws: https://privacyrights.org/blog/data-breach-notification-laws-now-all-50-states ; https://www.jacksonlewis.com/insights/state-data-breach-notification-laws-overview-patchwork
- BIPA 2024 amendment: https://www.gtlaw.com/en/insights/2024/8/bipa-update-illinois-limits-liability-and-clarifies-electronic-consent-for-biometric-data-collection ; https://www.taftlaw.com/news-events/law-bulletins/illinois-bipa-reform-new-legislation-promises-stronger-privacy-protections-and-clearer-guidelines-for-businesses/ ; https://www.hcamag.com/us/specialization/employment-law/seventh-circuit-limits-bipa-damages-to-one-recovery-per-employee/570970
- OWASP ASVS 5.0: https://asvs.dev ; https://softwaremill.com/whats-new-in-asvs-5-0/
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Better Auth / Auth.js: https://www.better-auth.com/blog/authjs-joins-better-auth ; https://better-auth.com/blog/better-auth-joins-vercel
- Hetzner 2026 prices: https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/ ; https://northflank.com/blog/hetzner-cloud-server-price-increases ; https://findstack.com/resources/hetzner-price-increase-2026
- DigitalOcean pricing: https://infratally.com/articles/digitalocean-droplet-pricing-guide-2026/
- Linode pricing: https://subger.com/en/service/linode
- PaaS free tiers: https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026 ; https://findstack.com/resources/railway-vs-render-vs-fly-io ; https://www.saaspricepulse.com/blog/flyio-pricing-history
- Supabase pricing: https://makerkit.dev/blog/saas/supabase-pricing ; https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/
- Neon free plan: https://costbench.com/software/database-as-service/neon/free-plan
