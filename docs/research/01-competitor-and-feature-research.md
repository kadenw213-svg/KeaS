# Competitor & Feature Research: Free Open-Source Workforce Management (vs. UKG / Paycom)

*Prepared 2026-10-21. Target: an aquatics / swim-lesson facility (lifeguards, swim instructors, front desk, often hourly, often minors, heavily seasonal). The product should still generalize to other hourly, shift-based employers.*

> **Confidence note.** Vendors in this space (UKG, Paycom, ADP, Paylocity, Check, Gusto Embedded) mostly **do not publish prices**. Price figures below come from third-party aggregators and review sites and conflict with each other. Treat them as rough ranges and get quotes. Feature claims come from vendor pages plus review sites. Where something is from general industry knowledge and not a cited source, it is marked *(general knowledge)*.

---

## 0. Executive Summary

1. **Paycom and UKG are full HCM suites.** One database covers HR, payroll, tax, benefits, time, scheduling, talent, and learning. Their moats are **payroll tax compliance, money movement, and enterprise implementation services**, not scheduling UX.
2. **The hourly/shift-worker gap is real.** SMB scheduling tools such as When I Work, Sling, Homebase, Deputy and 7shifts exist because suite scheduling is clunky, mobile is weak, and pricing is per employee per month (PEPM) with long contracts.
3. **The common complaints are pricing opacity, contracts, support and UX.** Reviews of Paycom mention 3-year lock-ins and cancellation fees (one reviewer reports $10,000), opaque billing, lag, and rigid reporting. Reviews of UKG mention a dated, steep-learning-curve UI, outsourced support, bugs after updates, and costly implementation (40-70% of first-year fees). UKG's Dec 2021 Kronos Private Cloud ransomware attack left employers on paper payroll for weeks.
4. **Open source is strong on HR records, weak on hourly-workforce scheduling.** Frappe HR (GPL-3.0, ~8.9k stars, very active) is the best OSS HRMS. Horilla (LGPL-2.1) is the rising one. Kimai (AGPL) is excellent at time tracking but project-oriented. OrangeHRM's open edition is slow-moving. TimeTrex's community edition is effectively stagnant. Sentrifugo is dead (last push 2021). **None of them does great mobile-first shift scheduling, swaps, certification-gated assignment, or minor-labor-law compliance.** That gap is the opening.
5. **Do not build payroll tax filing or money movement.** It means money-transmitter licensing in many states, surety bonds, tax liability, and filing in 50 states plus local jurisdictions. Integrate instead: **Check** or **Zeal** (payroll-as-a-service APIs), **Gusto Embedded**, or simply **export to the customer's existing payroll provider**, optionally via **Finch**. Any "embedded payroll" option carries per-company and per-employee fees, so "free" applies to WFM/HR, not to payroll processing.
6. **Recommended wedge:** a free, self-hostable, mobile-first **"time + scheduling + certifications + compliance for seasonal/youth hourly workforces"** app, starting with aquatics and recreation. Its outputs are payroll-ready exports for Paycom, UKG, ADP, Gusto and QuickBooks. Sustain it with open-core plus paid hosting.

---

## 1. Feature Breakdown

### 1.1 Paycom (single-database HCM, ~mid-market)

| Area | What Paycom offers |
|---|---|
| **Payroll** | Full-service payroll, tax calc and filing, garnishments, GL. **Beti**: employee-driven payroll. Employees preview their upcoming paycheck (including net pay), find and fix errors, and approve it before payday. An "Ask Here" feature routes questions to HR ([HR Executive](https://hrexecutive.com/paycom-beti/)). Paycom markets Beti as reducing disputes, compliance fines and correction time ([BusinessWire, G2 Summer 2026](https://www.businesswire.com/news/home/20260526471533/en/Paycom-Earns-Top-Payroll-Provider-Spot-in-G2s-Summer-2026-Grid-Reports)). Beti is also now framed as an AI assistant ([G2 review](https://g2.com/products/paycom/reviews/paycom-review-169513)). |
| **Time & labor** | Web/mobile punching, physical time clocks and terminals (biometric/fingerprint) ([Paycom time clocks](https://www.paycom.com/our-solution/time-clocks-and-terminals/)), missed-punch self-correction, geofencing *(general knowledge)*, labor allocation. |
| **Scheduling** | Schedule builder, shift trades, open shifts, time-off visibility *(general knowledge)*. Less specialized than Deputy and similar tools. |
| **PTO** | Accrual policies, requests and approvals, balances in the app. **GONE** automates time-off approval decisions by rules *(general knowledge; not confirmed in 2026 sources)*. |
| **Onboarding / HR** | Applicant tracking, background checks, onboarding docs, E-Verify, document management, compensation budgeting. |
| **Benefits** | Benefits admin, ACA reporting, enrollment. |
| **Talent** | Performance management, **Paycom Learning** (LMS), career and succession planning (launched 2026) ([Nasdaq Q2'26 call](https://www.nasdaq.com/articles/paycom-software-q2-earnings-call-highlights)). |
| **New in 2026** | **Project Arc**, a personalized system-wide UX release with claimed performance gains, and **Asset Management** (July 2026) ([MarketBeat Q2'26](https://www.marketbeat.com/instant-alerts/paycom-software-q2-earnings-call-highlights-2026-08-08/)). Paycom also describes expanding AI and "automated decisioning." |
| **Mobile** | One app for employees and managers (punch, PTO, pay stubs, approvals). Some reviewers report connectivity issues and limited mobile web ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/?page=23)). |

### 1.2 UKG (Ultimate Kronos Group)

Three main lines matter:

- **UKG Pro**: enterprise HCM and payroll (formerly UltiPro), including global/multi-currency payroll. **UKG Pro Workforce Management** (formerly Dimensions) is the enterprise WFM.
- **UKG Ready**: SMB/mid-market all-in-one (formerly Kronos Workforce Ready). Strong US payroll and time & attendance ([OutSail](https://www.outsail.co/post/ukg-ready-vs-ukg-pro-which-platform-fits-your-company-size), [SelectHub](https://www.selecthub.com/hr-management-software/ukg-pro-vs-ukg-ready/)).
- **Legacy Workforce Central / TeleStaff** (Kronos Private Cloud), being migrated.

| Area | What UKG offers |
|---|---|
| **Timekeeping** | Industry-leading **labor-rule engine** for complex OT, union, differential and rounding rules. Physical InTouch clocks, mobile punching with **geofencing** ([UKG customer story](https://www.ukg.com/for-llms/customers/carlie-cs-iga)), attestation. |
| **Scheduling** | Demand-based / forecast-driven scheduling, optimization, open shifts, **shift swaps** where the coworker accepts and the manager approves ([GWU guide](https://hr.gwu.edu/node/4866)), self-scheduling. **Bidding** for jobs, vacation and shifts is often extended through partners such as CloudApper ([CloudApper](https://ukg.cloudapper.ai/automate-job-vacation-and-shift-bidding-in-ukg/)). |
| **AI** | **UKG Bryte** AI includes nudges such as flight risk, fatigue patterns and cost projections ([Surety Systems](https://www.suretysystems.com/?p=34704)). |
| **PTO / leave** | Accruals, leave case management (FMLA). |
| **Payroll / tax** | Full-service US payroll and tax filing. Pro adds global payroll. |
| **HR / onboarding / benefits** | Core HR, recruiting, onboarding, benefits admin, ACA. |
| **Talent** | Performance, compensation, succession, learning. |
| **Analytics** | Prebuilt dashboards, People Analytics. |
| **Mobile** | UKG Pro mobile app; Ready mobile app. |

### 1.3 Other players (brief)

| Product | Positioning | Notable strengths | Notable gaps |
|---|---|---|---|
| **ADP Workforce Now** | Mid-market HCM | Payroll/tax depth, compliance, scale, marketplace | Quote-based; implementation $1k-$5k+ ([CostBench](https://www.costbench.com/compare/adp-workforce-now-vs-gusto/)); UX dated |
| **Paylocity** | Mid-market HCM | Strong employee experience and communications (Community), learning | Quote-based (~$20-40 PEPM est. ([CostBench](https://costbench.com/compare/adp-workforce-now-vs-paylocity/))) |
| **Gusto** | Small-business payroll | Easy payroll, contractor plan, transparent pricing | Basic scheduling/time; light WFM |
| **Rippling** | Modular HR+IT+Finance | Device/app management, automation workflows | Price grows with modules (~$8-35 PEPM ([CostBench](https://costbench.com/compare/adp-workforce-now-vs-rippling/))) |
| **Deputy** | Hourly scheduling + time | Auto-scheduling, labor-law compliance (breaks, predictive scheduling), kiosk with facial recognition | No native payroll in US (integrates) |
| **When I Work** | SMB scheduling | Simple scheduling, shift trades, team messaging | Time clock is a paid add-on ([Dupple](https://dupple.com/learn/best-employee-scheduling-software)) |
| **Homebase** | SMB scheduling + time (per location) | Free tier for 1 location, hiring, payroll add-on | Per-location pricing gets costly at multiple sites |
| **Sling** (Toast) | Cheap scheduling | Free up to ~30 users, labor-cost view | Shallow HR |
| **7shifts** | Restaurants | Tip pooling, POS integration, free Comp plan (≤15 employees) | Restaurant-specific |
| **Humanity / TCP** | Shift scheduling; TCP (TimeClock Plus) is strong in public sector, K-12 and **parks & recreation** | Complex public-sector rules, kiosk clocks, Humanity's scheduling | Legacy UX; TCP acquired Humanity *(general knowledge)* |

### 1.4 Feature Matrix

Legend: ● full/native, ◐ partial/basic or add-on, ○ none (integrate), **?** unverified

| Feature | Paycom | UKG Pro / Ready | ADP WFN | Paylocity | Gusto | Rippling | Deputy | When I Work | Homebase | Sling | 7shifts | Humanity/TCP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web/mobile time clock | ● | ● | ● | ● | ◐ | ● | ● | ◐ (add-on) | ● | ● | ● | ● |
| Physical/biometric kiosk | ● | ● | ● | ● | ○ | ◐ | ● (tablet face) | ◐ | ● (tablet) | ◐ | ● (tablet) | ● |
| Geofencing | ● | ● | ● | ● | ◐ | ● | ● | ● | ● | ◐ | ● | ● |
| Complex OT/pay rules engine | ● | ● (best) | ● | ● | ◐ | ● | ● | ◐ | ◐ | ◐ | ● (restaurant) | ● |
| Schedule builder | ● | ● | ● | ● | ◐ | ● | ● | ● | ● | ● | ● | ● |
| Auto/demand scheduling | ◐ | ● (Pro WFM) | ◐ | ◐ | ○ | ◐ | ● | ◐ | ◐ | ◐ | ● | ● |
| Shift swap / open shift pickup | ● | ● | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ● |
| Shift **bidding** (seniority-based) | ◐ | ◐ (partner) | ◐ | ◐ | ○ | ○ | ◐ | ○ | ○ | ○ | ○ | ● (TCP/TeleStaff-style) |
| Skill/cert-gated assignment | ◐ | ● | ◐ | ◐ | ○ | ◐ | ● (training) | ◐ | ○ | ◐ | ◐ | ● |
| PTO accrual & requests | ● | ● | ● | ● | ● | ● | ● | ● | ● | ◐ | ◐ | ● |
| Minor-labor-law checks | ◐ | ● | ◐ | ◐ | ○ | ◐ | ● | ◐ | ● | ○ | ● | ◐ |
| Onboarding (I-9, W-4, e-sign) | ● | ● | ● | ● | ● | ● | ◐ | ○ | ● | ○ | ◐ | ◐ |
| ATS / hiring | ● | ● | ● | ● | ◐ | ● | ○ | ○ | ● | ○ | ● | ○ |
| Payroll (full-service) | ● | ● | ● | ● | ● | ● | ○ (US) | ○ | ◐ (add-on) | ○ | ◐ (add-on) | ○ |
| Payroll tax filing | ● | ● | ● | ● | ● | ● | ○ | ○ | ◐ | ○ | ◐ | ○ |
| Employee pay preview/approval | ● (Beti) | ◐ | ◐ | ◐ | ○ | ◐ | ○ | ○ | ○ | ○ | ○ | ○ |
| Earned wage access | ◐ | ● (Wallet) | ● | ● | ● | ◐ | ○ | ○ | ● | ○ | ● | ○ |
| Benefits admin | ● | ● | ● | ● | ● | ● | ○ | ○ | ◐ | ○ | ○ | ○ |
| Performance mgmt | ● | ● | ● | ● | ◐ | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| Learning / cert tracking | ● | ● | ● | ● | ○ | ● | ◐ | ○ | ○ | ○ | ◐ | ◐ |
| Team messaging | ◐ | ◐ | ◐ | ● | ○ | ◐ | ● | ● | ● | ● | ● | ● |
| Reporting / analytics | ● | ● | ● | ● | ◐ | ● | ● | ◐ | ◐ | ◐ | ● | ● |
| Open API | ◐ | ● | ● | ● | ● | ● | ● | ● | ◐ | ◐ | ● | ◐ |
| Transparent public pricing | ○ | ○ | ○ | ○ | ● | ◐ | ● | ● | ● | ● | ● | ◐ |

*Matrix synthesized from vendor pages, review sites cited throughout, and general industry knowledge. Individual cells, especially ◐, should be verified before publishing competitively.*

---

## 2. Pricing & Weaknesses (Competitive Openings)

### 2.1 Pricing snapshot (estimates)

| Vendor | Model | Estimated price | Source |
|---|---|---|---|
| Paycom | PEPM, quote, multi-year contracts | ~$26-35 PEPM all-in (another source cites ~$4 PE + $500 setup for basic) | [OutSail](https://www.outsail.co/post/paycom-review-2026-pricing-features-pros-cons), [Sonary](https://sonary.com/b/paycom-software-inc/paycom+payroll-services/) |
| UKG Ready | PEPM, quote | ~$21-33 PEPM | [OutSail](https://www.outsail.co/post/how-much-does-ukg-cost-in-2026) |
| UKG Pro | PEPM, quote | ~$26-41+ PEPM; implementation 40-70% of year-1 fees | [OutSail](https://www.outsail.co/post/how-much-does-ukg-cost-in-2026), [Soon.works](https://soon.works/blog/what-a-ukg-implementation-actually-costs) |
| ADP WFN | Quote | ~$10-25 PEPM est.; impl. $1k-5k | [CostBench](https://costbench.com/compare/adp-workforce-now-vs-rippling/) |
| Paylocity | Quote | ~$20-40 PEPM est. | [CostBench](https://costbench.com/compare/adp-workforce-now-vs-paylocity/) |
| Gusto | Base + per person | Simple ~$49/mo + $6/person; Plus ~$80 + $12; Premium ~$180 + $22 | [Capterra](https://capterra.com/p/131882/Gusto/pricing/), [TechRepublic](https://www.techrepublic.com/es/article/gusto-review/) |
| Rippling | Modular PEPM | ~$8-35 PEPM | [CostBench](https://costbench.com/compare/adp-workforce-now-vs-rippling/) |
| Deputy | Per user | ~$5-9/user/mo ($30 minimum) | [Homebase blog](https://wf.joinhomebase.com/blog/deputy-alternatives) |
| When I Work | Per user | ~$2.50 (single loc) / $5 (multi), time clock extra | [Dupple](https://dupple.com/learn/best-employee-scheduling-software) |
| Homebase | Per location | Free (1 loc); ~$30-120/loc/mo | [Rework](https://resources.rework.com/tools/workforce-management/best-homebase-alternatives) |
| Sling | Per user | Free ≤30 users; ~$1.70-4/user | [Homebase blog](https://www.joinhomebase.com/blog/sling-alternatives) |
| 7shifts | Per location | Free Comp (≤15 emp); Essentials ~$39.99-44.99/loc | [Homebase blog](https://wf.joinhomebase.com/blog/7shifts-alternatives) |

**Why this matters for aquatics:** headcount spikes 2-4x in summer with part-time staff working a few hours a week. **PEPM pricing charges full price for a lifeguard who works 6 hours a week.** Some vendors bill for every active employee record, so seasonal rehires and staff who are inactive but not terminated keep costing money *(general knowledge; verify contract terms)*. Pricing by active hours, or a free product, is a sharp differentiator.

### 2.2 What users dislike about Paycom

- **Contracts and cancellation.** A reviewer asked for 1 year, got locked into 3 years, and was charged a **$10,000** cancellation fee that was disclosed only after cancelling ([Trustpilot](https://ca.trustpilot.com/review/paycom.com?page=2)).
- **Opaque billing and hidden fees.** Reviewers report incorrect fees and opaque billing ([Software Finder](https://softwarefinder.com/hr/paycom/reviews?page=23)). An aggregator documents ~7 hidden cost categories: implementation, training, add-ons ([CostBench](https://www.costbench.com/software/payroll/paycom/)). An older review says the customer was charged for items promised as included ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/?page=24)).
- **Support after the sale.** Reviewers say the consultant disappeared after the sale and extra help cost more ([Software Finder](https://softwarefinder.com/hr/paycom/reviews?page=23), [TrustRadius](https://tr-web.dev.trustradius.com/reviews/paycom-2021-10-27-17-27-19)).
- **Performance and lag**, especially in payroll processing, plus rigid reporting and customization ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/?page=24)). Paycom's 2026 "Project Arc" release is framed around fixing performance, which suggests the complaint was widespread ([Nasdaq](https://www.nasdaq.com/articles/paycom-software-q2-earnings-call-highlights)).
- **Hard-to-understand time calculations.** One reviewer: "we could never figure out how they calculated time" ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/Capterra___6174911/)). An unresponsive vendor: "patently awful" ([G2](https://www.g2.com/survey_responses/paycom-review-3030438)).
- **Mobile connectivity issues** and limited mobile web ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/?page=23)).
- **Abrupt loss of access on termination**, which matters to ex-employees who still need W-2s and pay stubs ([Kimola summary](https://kimola.com/reports/unlock-insights-paycom-customer-feedback-analysis-trustpilot-en-us-144906)).

Paycom still rates well overall: Capterra 4.4/5 from 1,173 reviews ([Capterra](https://www.capterra.com/p/130949/Paycom/reviews/?page=24)). Users like the single database and the depth of payroll. The complaints are about the **commercial relationship and UX**, not about missing features.

### 2.3 What users dislike about UKG

- **Dated, unintuitive UI and a steep learning curve** with confusing workflows ([Capterra](https://www.capterra.com/p/198579/UKG-Ready/reviews/?page=5), [GetApp](https://www.getapp.com/hr-employee-management-software/a/workforce-ready/reviews/)).
- **Outsourced support with language barriers**, slow ticket responses, and tickets left open for weeks ([Capterra](https://www.capterra.com/p/198579/UKG-Ready/reviews/?page=3)).
- **Bugs, slow loading, and settings lost after updates** ([Capterra](https://www.capterra.com/p/198579/UKG-Ready/reviews/?page=2)).
- **Expensive, painful implementations.** Implementation can exceed year-1 subscription fees ([Soon.works](https://soon.works/blog/what-a-ukg-implementation-actually-costs), [OutSail](https://www.outsail.co/post/how-much-does-ukg-cost-in-2026)).
- **Concentration and vendor risk.** The **Dec 2021 Kronos Private Cloud ransomware attack** took down Workforce Central and TeleStaff for weeks, with restoration targeted for Jan 28. Employers went to paper and estimated hours, and workers sued over missed overtime ([SHRM](https://shrm.org/topics-tools/news/technology/ukg-hack-disrupts-scheduling-payroll-thousands-employers), [BankInfoSecurity](https://www.bankinfosecurity.com/hr-platform-ukg-says-cloud-solutions-hit-ransomware-a-18118), [TechTarget](https://www.techtarget.com/enterprise-software/news/252512253/Tesla-PepsiCo-workers-bring-lawsuit-over-UKG-payroll-outage?amp=1)). **A self-hostable, exportable, open-source system is a direct answer to this risk.**
- **Feature fragmentation.** Shift bidding and similar features often require third-party partner add-ons ([CloudApper](https://ukg.cloudapper.ai/employee-shift-bidding-solution-for-ukg)).

### 2.4 Openings to compete on

| Pain | Opening |
|---|---|
| Opaque quotes, multi-year lock-in, cancellation fees | Free/self-host; transparent hosted pricing; month-to-month; one-click full data export |
| PEPM billing for part-time seasonal staff | Free core; price hosted tiers by location or active staff-hours, not headcount |
| Clunky UI, learning curve | Mobile-first, teenager-friendly UX (staff are 15-22) |
| Poor support | Community plus paid-support SLA; transparent issue tracker |
| Opaque time calculations | "Explain my pay": each paid minute traced to a rule (rounding, OT, differential), like Beti's preview but for hours |
| Vendor outage risk | Self-host or multi-tenant hosting with offline-capable kiosk punching and exportable data |
| Generic scheduling | Vertical features: certification-gated scheduling, rotation and break compliance, lesson-to-instructor ratios, minor-hour rules |

---

## 3. Open-Source Alternatives

GitHub stats were pulled live via the GitHub API on 2026-10-21.

| Project | License | Stars / forks | Last push | Stack | Strengths | Gaps for hourly/aquatics |
|---|---|---|---|---|---|---|
| **Frappe HR** ([frappe/hrms](https://github.com/frappe/hrms)) | GPL-3.0 | ~8.9k / 2.8k | Active (today) | Python/Frappe, MariaDB, Vue PWA | 13+ modules: employee lifecycle, leave, **shift types with auto-attendance**, drag-and-drop **shift planning view** with swaps, **geolocation check-in** on mobile, biometric device sync, payroll (salary structures), expense, performance ([Frappe HR shifts](https://frappe.io/hr/shifts-and-attendance), [README](https://cdn.jsdelivr.net/gh/frappe/hrms@develop/README.md)) | Payroll is gross-to-net framework, **no US tax filing**; heavy ERPNext-style UI, not teen-friendly; scheduling is roster-style, not demand/class-driven; no minor-labor rules; GPL limits proprietary forks |
| **Horilla** ([horilla/horilla-hr](https://github.com/horilla/horilla-hr)) | LGPL-2.1 | ~1.5k / 950 | Active (today); separate mobile repo | Django | Modern UI; recruitment, onboarding, attendance check-in/out, shifts, leave, payroll with allowances/deductions, performance, assets, helpdesk ([Horilla docs](https://docs.horilla.com/), [OpenAlternative](https://openalternative.co/horilla)) | India-oriented origins; no US tax engine; scheduling basic; young ecosystem |
| **OrangeHRM Starter** ([orangehrm/orangehrm](https://github.com/orangehrm/orangehrm)) | GPL-3.0 | ~1.2k / 760 | Jun 2026 (slower) | PHP/Symfony + Vue | Mature core HR: PIM, leave, time, recruitment, performance, mobile ([SourceForge](https://sourceforge.net/projects/orangehrm/)) | Payroll, API and advanced modules gated to paid edition ([OpenTechHub](https://www.opentechhub.io/orangehrm/)); reviewers report slow, buggy, dated UI, timesheet gaps ([Capterra](https://www.capterra.com/p/49068/OrangeHRM/reviews/)) |
| **Odoo Community** ([odoo/odoo](https://github.com/odoo/odoo)) | LGPL-3.0 (Community); Enterprise proprietary *(general knowledge)* | ~55k / 34k | Active | Python/Postgres | Huge ecosystem; Employees, Time Off, basic Attendance in Community | **Payroll, Planning (shift scheduling), GPS/kiosk attendance are Enterprise-only** ([Cybrosys](https://www.cybrosys.com/blog/what-are-the-differences-between-odoo-18-community-and-enterprise-in-terms-of-hr), [Cybrosys attendance](https://www.cybrosys.com/blog/what-are-the-differences-between-odoo-18-community-enterprise-in-attendance)); open-core ceiling |
| **Kimai** ([kimai/kimai](https://github.com/kimai/kimai)) | AGPL-3.0 | ~5.1k / 860 | Active (today) | PHP/Symfony | Excellent time tracking: timers, timesheets, approvals, invoicing, REST API, SAML/LDAP, plugin marketplace ([Symfony](https://symfony.com/projects/kimai)) | Project/client billing model, not shift scheduling; no PTO accruals or HR records natively |
| **TimeTrex Community** | AGPL-3.0 | Official GitHub is stale; forks such as FairnessTNA last pushed 2019 | Stagnant | PHP | Only OSS with US-style payroll calc, scheduling and time in one ([SourceForge](https://www.sourceforge.net/projects/timetrex)) | Community edition lags far behind paid; geofencing and job costing paid-only ([Merchant Maverick](https://www.merchantmaverick.com/reviews/timetrex)); user must file taxes themselves ([FitSmallBusiness](https://fitsmallbusiness.com/timetrex-review/)); no professional support |
| **IceHrm** ([gamonoid/icehrm](https://github.com/gamonoid/icehrm)) | Core MIT/Apache per listings; Pro edition Elastic License v2 ([IceHrm blog](https://icehrm.com/blog/is-icehrm-free/)) | ~730 / 430 | Active | PHP | Core HR, leave, attendance, documents | Small community; open-core with source-available Pro |
| **Sentrifugo** ([sapplica/sentrifugo](https://github.com/sapplica/sentrifugo)) | GPL-3.0 | ~540 / 430 | **Last push Jul 2021, effectively abandoned** | PHP/Zend | Historical reference | Do not build on it |
| **Staffjoy Suite** ([Staffjoy/suite](https://Www.GitHub.com/Staffjoy/suite)) | Open-sourced after shutdown | Dormant ~9 yrs | Dead | Python | Proof that a startup tried OSS scheduling | Reference only |

**Takeaways**

- **No open-source project is a credible Deputy/When I Work equivalent.** Mobile-first shift scheduling, open-shift marketplace, swaps with rule checks, SMS/push, kiosk punching and labor-law guardrails are all missing or weak. This is the clearest whitespace.
- **Frappe HR is the strongest base** if the goal is to extend instead of building greenfield. However, it is GPL and its UX/architecture is ERP-heavy. Building a separate, focused app that **integrates** with Frappe HR/Odoo/OrangeHRM for HR records is often the better path.
- **No OSS project files US payroll taxes.** None should try, for the reasons in Section 4.

---

## 4. Honest Assessment: Payroll Is the Hard Part

### 4.1 Why not build payroll processing

- **Money transmission.** The CSBS Model Money Transmission Modernization Act (MTMA) explicitly includes payroll processing in "money transmission." Some states exempt it (Ohio, Washington, Indiana's version), others don't. Between 2018 and 2022, **nine states took enforcement actions against payroll providers** as unlicensed money transmitters (e.g., Texas fines). Licensing requires audited financials, **surety bonds, net-worth requirements**, and ongoing multi-state compliance ([Asure: MTMA explained](https://www.asuresoftware.com/blog/money-transmitter-law-explained-the-seismic-shift-impacting-payroll-providers/), [NPRC response to CSBS](https://www.csbs.org/sites/default/files/2019-04/NPRC%20Response%20to%20Request%20for%20Information.pdf)).
- **Tax liability.** Filing Form 941/940, state withholding, SUI, local taxes (OH/PA local EIT and similar), W-2/W-3 and amendments across 50 states plus localities means continuously maintained tax tables, agency registrations, and penalty exposure when something is wrong *(general knowledge)*.
- **Banking.** ACH origination needs an ODFI bank sponsor, NACHA compliance, risk and underwriting for fraud such as payroll-funding fraud, and banks increasingly demand proof of licensing or exemption ([Asure](https://www.asuresoftware.com/blog/money-transmitter-law-explained-the-seismic-shift-impacting-payroll-providers/)).
- **Error cost.** A wrong paycheck is a wage-and-hour violation. The UKG outage lawsuits show how fast this becomes legal exposure ([TechTarget](https://www.techtarget.com/enterprise-software/news/252512253/Tesla-PepsiCo-workers-bring-lawsuit-over-UKG-payroll-outage?amp=1)).

**Verdict:** an open-source community project should **not** move money or file taxes. It can safely compute **hours and gross pay** (with rules, OT and differentials) and hand them off.

### 4.2 Integrate-instead options

| Option | What it is | What it handles | Commercial reality |
|---|---|---|---|
| **Check** ([checkhq.com](https://www.checkhq.com/platform/payroll), [docs](https://docs.checkhq.com/)) | Payroll-as-a-service API for vertical SaaS | Gross-to-net, tax calc, **filing in all 50 states + DC and local**, licensed money movement, garnishments, paystubs, white-label React components, CLI, MCP server, amendment workflows ([Check 2025 review](https://www.checkhq.com/2025-year-in-review)) | Partner contract with per-company + PEPM fees (not public); you become a payroll *reseller* with support obligations |
| **Zeal** ([BusinessWire](https://businesswire.com/news/home/20210827005003/en/5036966/Zeal-Raises-13-Million-Series-A-to-Scale-API-Infrastructure-Allowing-Companies-to-Build-Custom-Payroll-Products)) | API-first payroll infra; takes on payroll liability | W-2 + 1099 payroll, tax, onboarding incl. I-9/E-Verify, **instant pay** with partner fee share ([Sacra](https://sacra.com/chat/h/d3c1b70e-ad8a-4620-9d56-38013b83a4f9/)) | Similar partner model; strong for gig/contractor |
| **Gusto Embedded** ([Sacra](https://sacra.com/c/gusto/)) | White-label Gusto payroll engine (powers e.g. U.S. Bank's payroll product, 2025) | Full-service payroll and tax | Partnership; established brand trust |
| **Others** (Nmbr, Salsa, Everee, etc.) | Embedded payroll APIs | Varies | Typical market pricing: **~$35-70/company/mo base + ~$6-10 PEPM**, with platforms keeping a revenue share ([banq.ai](https://www.banq.ai/embedded-finance/category/payroll)) |
| **Finch** ([tryfinch.com](https://tryfinch.com/finch-api)) | Unified API *into* existing payroll/HRIS providers (Paycom, UKG, ADP, Gusto, etc.) | Mostly **read** (directory, pay statements); **write** largely limited to deductions ([Finch Deductions](https://developer.tryfinch.com/products/deductions/Overview)); many "assisted" connections refresh ~weekly ([Apideck](https://www.apideck.com/alternatives/finch)) | Starter ~$65/mo per connection; write access needs Pro/Premier (quote) ([PricingSaaS](https://pricingsaas.com/companies/tryfinch)) |
| **Plain export** | CSV/XLSX/API payroll file formats per provider | Hours/earnings import into Paycom, UKG, ADP, Gusto, QuickBooks, Paychex | Free; zero regulatory exposure; customer keeps their payroll vendor |

### 4.3 What this means for "free"

- **Free (open source):** HR records, onboarding docs, scheduling, time & attendance, PTO, certifications, compliance rules, gross-pay calculation, reporting, and payroll export.
- **Not free (pass-through cost):** actual payroll processing, tax filing and direct deposit. These are partner fees. Be upfront: "Run payroll inside the app via our partner for $X/mo + $Y per employee, or export to the payroll you already use for free."
- **Practical path for the aquatics org itself:** keep the current payroll provider (Paycom/UKG/ADP/Gusto) for pay and tax. Replace its **scheduling, time, certs and staff app** with this product, and feed approved hours back via export or API. That alone may let the org drop to a cheaper payroll-only tier.

---

## 5. Strategy Recommendations

### 5.1 Positioning

**"The free, open-source workforce app for seasonal and youth hourly teams: pools, rec centers, camps, parks, ski hills, amusement parks."**

Why this niche:

- **Underserved.** Suites are overkill and priced PEPM. Generic schedulers miss certifications and minor rules. Existing aquatics tools such as DigiQuatics ([site](https://www.digiquatics.com/)), RosterElf ([swim centres](https://www.rosterelf.com/industries/swimming-centre)), SchedulingKit ([swim schools](https://schedulingkit.com/scheduling-software/swim-schools)) and the Red Cross / Counsilman-Hunsaker lifeguard app ([SwimSwam](https://swimswam.com/american-red-cross-and-counsilman-hunsaker-collaborate-to-provide-new-lifeguard-management-app/)) are proprietary and mostly focus on pool operations or class booking, not WFM. Public-sector parks and rec often uses TCP.
- **Compliance-heavy in a way software can help with:**
  - **FLSA child labor (ages 14-15):** max 3 hrs on a school day, 18 hrs in a school week, 8 hrs on a non-school day, 40 hrs in a non-school week, 7am-7pm (9pm from June 1 to Labor Day) ([DOL eLaws](https://webapps.dol.gov/elaws/whd/flsa/cl/e14.asp)). **States can be stricter**; Washington caps 14-15 year olds at 16 hrs/school week ([WA L&I](https://www.lni.wa.gov/workers-rights/_docs/esc4.1.pdf)).
  - Federal rules allow **15-year-olds** (not 14) to work as lifeguards at traditional pools and water parks with certification (29 CFR 570.34(l)) *(general knowledge; verify)*.
  - Work permits and age certificates vary by state.
- **Certification-gated staffing is life-safety, not convenience.** Lifeguarding/CPR/AED/First Aid (Red Cross certs commonly 2-year validity), WSI, LGI, pool operator (CPO), and background checks. Vendors already market 60/30/15-day expiry reminders ([Fieldproxy](https://www.fieldproxy.ai/automations/pool-spa-lifeguard-certification-tracking)).

### 5.2 Differentiating features (aquatics wedge)

1. **Certification-aware scheduler.** A shift can't be published or swapped to someone whose lifeguard/CPR/WSI cert is missing or expires before the shift. Includes an expiry dashboard and automated reminders.
2. **Minor-labor-law guardrails.** Track DOB, school calendar and state profile. The app blocks or warns on violations at schedule time, swap time and punch time.
3. **Rotation and coverage rules.** Minimum guards per zone and open-hours, guard-to-swimmer ratios, rotation/break enforcement, and in-service training hours logged (for example, monthly in-service requirements).
4. **Lesson-driven scheduling.** Import class rosters (or integrate with swim-school booking systems) and generate instructor demand from enrollments and ratios.
5. **Seasonal lifecycle.** Bulk rehire returning staff, a "returning staff" onboarding fast-path, end-of-season offboarding with continued pay-stub/W-2 access, and an interest form for next season.
6. **Teen-friendly mobile/PWA.** SMS and push, open-shift marketplace, swaps with auto-validation, parent/guardian contact, multilingual.
7. **Kiosk punch** on a shared tablet at the pool with PIN/QR/photo. Works offline and syncs later, which helps on pool decks with bad Wi-Fi. Geofence is optional for mobile punches.
8. **"Explain my hours" pay preview.** Like Beti for hours. Staff approve their timecard before payroll export, which cuts disputes.
9. **Payroll export adapters** for Paycom, UKG Ready/Pro, ADP, Gusto, Paychex, QuickBooks, plus generic CSV/API.
10. **Incident and in-service logs** tied to staff (rescues, first-aid, drills). This is valuable for aquatics risk management.

### 5.3 MVP scope (v0.1, about 3-4 months for a small team)

| In MVP | Out of MVP |
|---|---|
| Orgs, locations, positions, roles (admin/manager/staff) | Payroll processing / tax filing |
| Staff profiles, DOB/minor flag, emergency/guardian contacts | Benefits admin |
| Certifications with expiry, uploads, reminders, gated scheduling | ATS beyond a simple application form |
| Schedule builder (week view, templates, copy-week), publish, notifications | Performance reviews |
| Open shifts, shift swap/drop with manager approval and rule checks | AI auto-scheduling |
| Time clock: mobile (optional geofence) + kiosk PWA, offline support | Native iOS/Android apps (use PWA first) |
| Timesheet approval, OT rules (FLSA weekly 40 + state daily OT for CA etc.) | Multi-country |
| PTO / availability / time-off requests (simple accruals) | |
| Minor-hour rules engine (federal + config for state) | |
| Payroll CSV export (generic + 2-3 provider formats) | |
| Basic reports: hours, labor cost, cert expiry, minor-hour compliance | |
| Audit log, data export, self-host via Docker | |

### 5.4 Phased roadmap

| Phase | Timeline | Focus |
|---|---|---|
| **0: Validate** | Month 0-1 | Shadow the facility's managers through a summer schedule and payroll cycle; list every spreadsheet and workaround; interview 5-10 other pools, YMCAs, camps |
| **1: MVP** | Months 1-4 | Scope above; run at the home facility in parallel with the current system for 1-2 pay periods |
| **2: Seasonal hardening** | Months 4-8 | Bulk rehire/onboarding (e-sign W-4/I-9 forms, document storage), lesson-roster import, rotation/coverage rules, SMS, multi-location, more state rule packs |
| **3: Integrations** | Months 8-12 | Provider-specific export/API adapters; Finch or direct APIs for employee sync; SSO; HRIS sync with Frappe HR / OrangeHRM / Odoo; webhooks |
| **4: Embedded payroll (optional, hosted only)** | Year 2 | Partner with Check/Zeal/Gusto Embedded for orgs that want payroll inside the app, as a paid hosted add-on |
| **5: Broader HR** | Year 2+ | Onboarding workflows, training/LMS-lite (in-service tracking), light performance, ACA hour tracking (variable-hour lookback measurement is a big need for seasonal employers) |

### 5.5 Sustainability / business model

| Model | How it works | Fit |
|---|---|---|
| **Open core + paid cloud hosting** (Kimai, Odoo, Cal.com, Plausible pattern) | Free self-host; hosted SaaS priced per location or flat by active staff (not PEPM for idle seasonal staff) | **Primary recommendation.** Most aquatics orgs won't self-host. |
| **Paid support / SLA / implementation** | Setup, data migration from Paycom/UKG, training | Strong secondary; TimeTrex and OrangeHRM use this |
| **Embedded payroll revenue share** | Platforms commonly keep a share of embedded payroll fees ([banq.ai](https://www.banq.ai/embedded-finance/category/payroll)) | Good margin later; adds support burden |
| **Enterprise features** (SSO/SAML, advanced audit, multi-entity) | Source-available or paid add-ons | Use sparingly; don't gate core scheduling/compliance |
| **Grants / sponsorships / association partnerships** | Partner with aquatics associations (e.g., NRPA, state park and rec associations, YMCA networks) for distribution | Distribution channel more than revenue |
| **Instant / earned-wage-access fee share** (via Zeal etc.) | Partner fee on instant payouts ([Sacra](https://sacra.com/chat/h/d3c1b70e-ad8a-4620-9d56-38013b83a4f9/)) | Possible later; reputational care needed with teen staff |

**License choice:**

- **AGPL-3.0** for the core. It protects against a competitor hosting a closed fork (as Kimai does) while allowing self-hosting.
- Or **Apache-2.0/MIT** for maximum adoption, with a separate license for proprietary hosted add-ons.
- Avoid basing on GPL code (Frappe) if you want flexibility. Integrating over APIs avoids license entanglement.

### 5.6 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wage-and-hour errors from the rules engine | Extensive test fixtures per state; "explain my pay" traceability; staff timecard approval; disclaimers; never auto-file |
| Privacy of minors' data (DOB, guardians, SSNs) | Don't store SSNs in MVP (payroll provider holds them); encryption at rest; RBAC; audit log; COPPA isn't triggered for 13+ employees but treat minors' data conservatively |
| Self-host security burden | Hardened Docker image, automatic updates, managed hosting as the default recommendation |
| Feature creep toward "full HCM" | Stay WFM-first; integrate HR/payroll |
| Small team sustainability | Hosted revenue from day one; recruit design partners (other pools) |

---

## 6. Source List

**Paycom:** [OutSail review 2026](https://www.outsail.co/post/paycom-review-2026-pricing-features-pros-cons) · [HR Executive: Beti](https://hrexecutive.com/paycom-beti/) · [BusinessWire G2 Summer 2026](https://www.businesswire.com/news/home/20260526471533/en/Paycom-Earns-Top-Payroll-Provider-Spot-in-G2s-Summer-2026-Grid-Reports) · [Nasdaq Q2 2026 call](https://www.nasdaq.com/articles/paycom-software-q2-earnings-call-highlights) · [MarketBeat Q2 2026](https://www.marketbeat.com/instant-alerts/paycom-software-q2-earnings-call-highlights-2026-08-08/) · [Capterra reviews](https://www.capterra.com/p/130949/Paycom/reviews/?page=24) · [Trustpilot](https://ca.trustpilot.com/review/paycom.com?page=2) · [Software Finder](https://softwarefinder.com/hr/paycom/reviews?page=23) · [CostBench](https://www.costbench.com/software/payroll/paycom/) · [G2 review](https://www.g2.com/survey_responses/paycom-review-3030438) · [Paycom time clocks](https://www.paycom.com/our-solution/time-clocks-and-terminals/) · [Sonary](https://sonary.com/b/paycom-software-inc/paycom+payroll-services/)

**UKG:** [OutSail UKG cost 2026](https://www.outsail.co/post/how-much-does-ukg-cost-in-2026) · [OutSail Ready vs Pro](https://www.outsail.co/post/ukg-ready-vs-ukg-pro-which-platform-fits-your-company-size) · [SelectHub](https://www.selecthub.com/hr-management-software/ukg-pro-vs-ukg-ready/) · [Soon.works implementation](https://soon.works/blog/what-a-ukg-implementation-actually-costs) · [UKG customer story](https://www.ukg.com/for-llms/customers/carlie-cs-iga) · [GWU shift swap](https://hr.gwu.edu/node/4866) · [CloudApper bidding](https://ukg.cloudapper.ai/automate-job-vacation-and-shift-bidding-in-ukg/) · [Surety Systems](https://www.suretysystems.com/?p=34704) · [Capterra UKG Ready](https://capterra.com/p/198579/UKG-Ready/reviews/) · [GetApp](https://www.getapp.com/hr-employee-management-software/a/workforce-ready/reviews/) · [SHRM on hack](https://shrm.org/topics-tools/news/technology/ukg-hack-disrupts-scheduling-payroll-thousands-employers) · [BankInfoSecurity](https://www.bankinfosecurity.com/hr-platform-ukg-says-cloud-solutions-hit-ransomware-a-18118) · [TechTarget lawsuit](https://www.techtarget.com/enterprise-software/news/252512253/Tesla-PepsiCo-workers-bring-lawsuit-over-UKG-payroll-outage?amp=1)

**Other vendors:** [CostBench ADP vs Rippling](https://costbench.com/compare/adp-workforce-now-vs-rippling/) · [CostBench ADP vs Paylocity](https://costbench.com/compare/adp-workforce-now-vs-paylocity/) · [CostBench ADP vs Gusto](https://www.costbench.com/compare/adp-workforce-now-vs-gusto/) · [Capterra Gusto pricing](https://capterra.com/p/131882/Gusto/pricing/) · [Dupple scheduling](https://dupple.com/learn/best-employee-scheduling-software) · [Homebase: Deputy alts](https://wf.joinhomebase.com/blog/deputy-alternatives) · [Homebase: Sling alts](https://www.joinhomebase.com/blog/sling-alternatives) · [Homebase: 7shifts alts](https://wf.joinhomebase.com/blog/7shifts-alternatives) · [Rework: Homebase alts](https://resources.rework.com/tools/workforce-management/best-homebase-alternatives)

**Open source:** [frappe/hrms](https://github.com/frappe/hrms) · [Frappe HR shifts](https://frappe.io/hr/shifts-and-attendance) · [horilla/horilla-hr](https://github.com/horilla/horilla-hr) · [Horilla docs](https://docs.horilla.com/) · [orangehrm/orangehrm](https://github.com/orangehrm/orangehrm) · [OpenTechHub OrangeHRM](https://www.opentechhub.io/orangehrm/) · [Capterra OrangeHRM](https://www.capterra.com/p/49068/OrangeHRM/reviews/) · [odoo/odoo](https://github.com/odoo/odoo) · [Cybrosys Odoo 18 HR](https://www.cybrosys.com/blog/what-are-the-differences-between-odoo-18-community-and-enterprise-in-terms-of-hr) · [kimai/kimai](https://github.com/kimai/kimai) · [TimeTrex SourceForge](https://www.sourceforge.net/projects/timetrex) · [Merchant Maverick TimeTrex](https://www.merchantmaverick.com/reviews/timetrex) · [FitSmallBusiness TimeTrex](https://fitsmallbusiness.com/timetrex-review/) · [gamonoid/icehrm](https://github.com/gamonoid/icehrm) · [IceHrm licensing](https://icehrm.com/blog/is-icehrm-free/) · [sapplica/sentrifugo](https://github.com/sapplica/sentrifugo) · [Staffjoy suite](https://Www.GitHub.com/Staffjoy/suite)

**Payroll infrastructure & regulation:** [Check platform](https://www.checkhq.com/platform/payroll) · [Check docs](https://docs.checkhq.com/) · [Check 2025 review](https://www.checkhq.com/2025-year-in-review) · [Zeal Series A](https://businesswire.com/news/home/20210827005003/en/5036966/Zeal-Raises-13-Million-Series-A-to-Scale-API-Infrastructure-Allowing-Companies-to-Build-Custom-Payroll-Products) · [Sacra: Zeal/contractor payroll](https://sacra.com/chat/h/d3c1b70e-ad8a-4620-9d56-38013b83a4f9/) · [Sacra: Gusto](https://sacra.com/c/gusto/) · [banq.ai embedded payroll](https://www.banq.ai/embedded-finance/category/payroll) · [Finch API](https://tryfinch.com/finch-api) · [Finch Deductions](https://developer.tryfinch.com/products/deductions/Overview) · [PricingSaaS Finch](https://pricingsaas.com/companies/tryfinch) · [Apideck on Finch](https://www.apideck.com/alternatives/finch) · [Asure: MTMA](https://www.asuresoftware.com/blog/money-transmitter-law-explained-the-seismic-shift-impacting-payroll-providers/) · [NPRC to CSBS](https://www.csbs.org/sites/default/files/2019-04/NPRC%20Response%20to%20Request%20for%20Information.pdf)

**Aquatics & labor law:** [DOL child labor 14-15](https://webapps.dol.gov/elaws/whd/flsa/cl/e14.asp) · [WA L&I teen rules](https://www.lni.wa.gov/workers-rights/_docs/esc4.1.pdf) · [DigiQuatics](https://www.digiquatics.com/) · [RosterElf swim centres](https://www.rosterelf.com/industries/swimming-centre) · [SchedulingKit swim schools](https://schedulingkit.com/scheduling-software/swim-schools) · [Fieldproxy cert tracking](https://www.fieldproxy.ai/automations/pool-spa-lifeguard-certification-tracking) · [SwimSwam Red Cross app](https://swimswam.com/american-red-cross-and-counsilman-hunsaker-collaborate-to-provide-new-lifeguard-management-app/)
