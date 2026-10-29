# KeaS plan: scheduling, time clock, certifications and payroll

Split out of the Kea plan on 2026-10-29. KeaS is its own app: an org server plus a phone-first web app (PWA) the server serves itself. Kea keeps documents, school, and the LMS (classes, trainings, in-services, refresher scores). **Certifications live here in KeaS**; trainings stay in Kea.

**Rules for this work**
- Prototype on the local branch `prototype/work-server`. Local commits only; **never push or release without asking**.
- **Payroll safety rule:** a state's tables can't be used to finalize a pay run until they're marked verified for that year.
- Nothing is built for one org (for example the owner's YMCA). Everything specific lives in packs and org settings.

**Built so far (prototype):** see the README. The server covers punches, overtime/breaks/minors rules, cert-gated scheduling, swaps, missed-punch requests, a pay-run preview with unverified tax estimates and a sample NACHA file. 33 server tests pass.

**Open items**
- Logo: concepts in `docs/logo/` (A key-in-beak recommended). The chosen one becomes `web/public/icon.svg` plus PNG icons for the manifest.
- The Oct 21 research (`docs/research/02-...`) proposes a staff score. Reconcile it with the rule below: flags only, protected leave (Colorado HFWA sick leave and others) never counts, and a manager decides.
- Hosting, accounts and the shared key hierarchy are described in the Kea plan (Phases 5, 8 and 9). KeaS org servers should reuse that model rather than invent a second one.

## Design principle: a generic core, with everything else in configurable packs
The user said: "i dont want it built for my ymca i want it to function anywhere". Nothing org-, state- or industry-specific is hard-coded. The core is generic, and everything specific is a **pack** that an org turns on and can override.

- **Certification types are defined by the org.** Each type has a name, issuer, validity (months), renewal grace period, whether proof is required, and which positions require it.
  - **Starter templates are optional:** Red Cross, YMCA, StarGuard, Ellis, CPR/AED, First Aid, EMT, WSI, CPO/AFO. The org can edit them or delete them.
  - The cert-blocked scheduling check uses whatever the org has defined.
- **Positions, assessment labels, incident types, checklist items, log fields and their ranges, attendance thresholds, retention periods, notification rules:** all org-defined, with defaults supplied by the chosen packs.
- **Jurisdiction packs** are data files, versioned and cited, each with a maintainer, a reviewer and a "last re-signed" date, exactly like the payroll rule packs:
  - **Labor packs** cover overtime, breaks, minor-labor limits, sick leave and minimum wages. Federal and Colorado come first.
  - **Pool-code packs** cover water-test frequency and ranges, closure rules and incident timers. Colorado 5 CCR 1003-5 and the CDC Model Aquatic Health Code come first.
  - **Tax packs** come later, as above.
  - The org picks its location (state, county or city) and KeaS suggests the matching packs. Every rule can be overridden, and the override is logged with a reason. Where KeaS has no pack, the org enters its own rules.
- **Industry templates** bundle positions, cert types, checklists, logs, forms and in-service courses: Aquatics first, then summer camp, EMS, food service, retail and general.
  - The YMCA pool is just Aquatics + Colorado + the org's own YMCA cert type.
- **Org types:** nonprofit, government, private, school. The type only changes defaults, such as the privacy notice wording and children's-data protections. The strictest setting is the default.
- **The test for generality:** every feature must work for an org that has no pack at all, and must be checked against a second, very different org setup (for example a Texas summer camp) as well as the user's Colorado YMCA pool.


## Certification tracker
- **Each person's cert details** (type, issuer, number, issue date, expiry, card photo) stay on their own device; only what they choose to share reaches the org server.
- **Cert types are defined by the org** (see the design principle), with optional starter templates whose standard validity fills in the expiry.
- **Calendar:** each cert's expiry can be sent to the person's Kea calendar (if they use Kea) or exported as .ics, with reminders 60, 30 and 7 days before (configurable under Advanced).
- **Sharing:** each cert can be Private (default), visible to admins of my orgs, or visible to members. Only `{type, issuer, expires}` goes to the server. The admin roster shows people × required certs, flagging certs expiring within 30 days or expired.

## Schedule
- **Shifts:** positions and locations; an admin drafts shifts, then publishes them, and they go into members' calendars through sync.
- **Availability and time off.**
- **Swaps:** a member offers a shift, someone claims it, and an admin approves it (or the org turns on auto-approve).
- **Checks:** overlapping shifts, availability, and whether **required certs are valid on the shift date**.
- **Notifications:** in-app only, through sync.
- **Before release:** org terms say the **org is the data controller** for its members' and employees' data. KeaS is not the official record of hours. Deletion requests on self-hosted servers go to the org.

## Time clock, rules engine, gross pay and exports (federal + Colorado packs first)
Researched 2026-10-27. Several figures are marked [verify] in the research and get checked against the official PDFs before coding.

**Competitive position.** No free tier combines an unlimited-employee time clock, Colorado overtime and break logic, and training and certifications:
- Homebase's free tier stops at 10 employees;
- Sling has no time clock;
- When I Work dropped its free plan.

**Phase 12: Time clock**
- Punch on the phone (optional geofence) or at a shared kiosk PC (PIN, optional photo), tied to the scheduled shift. Early or late tolerance and no-show alerts. Offline punches are queued and synced.
- **Punches are append-only.**
  - Every edit stores who, when, the old and new value, and a required reason.
  - The employee attests to breaks at clock-out and signs off the period.
  - The manager approves, which locks the period; reopening creates a new version.
  - Device and location are recorded per punch.

**Phase 13: Rules engine** (data-driven rule packs `federal`, `colorado`, plus custom; the strictest rule wins)
- **Overtime:**
  - weekly over 40, plus Colorado's daily over 12 and 12 consecutive hours (aware of shifts crossing midnight, never double-counted);
  - configurable workweek start;
  - a weighted regular rate when someone works at several rates (guard vs instructor).
- **Rounding** is off by default; neutral 5/6/15-minute rounding is an Advanced option, with exact minutes always stored.
- **Breaks (COMPS Order #40):**
  - a 30-minute meal break for shifts over 5 hours;
  - a paid 10-minute rest per 4 hours;
  - **a missed rest break automatically adds 10 minutes' pay**;
  - prompts and a compliance report.
- **Minor-labor checks, both at scheduling (Phase 11) and at clock-in:**
  - federal limits for 14–15-year-olds (hours, weeks, time of day, school calendar as an input), plus Colorado's;
  - **block 14-year-olds from lifeguard roles**, and require a valid lifeguard cert for 15-year-olds;
  - overrides need a reason.
  
  This needs a date of birth for minors. It's stored on the org server as an employment record, never on the central server.
- **HFWA sick leave:** 1 hour per 30 hours worked, a 48-hour cap, carryover, reinstatement within 6 months of rehire, balances in the employee app, and a statement on request.
- **Wage-floor warnings:** against the 2026 Colorado, Denver, Boulder and Edgewater minimums, the tipped minimums, and the 15% youth rule, which can't be used where a local minimum applies.

**Phase 14: Gross pay + exports**
- **Gross pay preview** per period.
- **A generic pay-period CSV:** ID, name, period, regular, overtime and double-time hours, sick/PTO/holiday hours, rest-premium minutes, department or rate code.
- **Presets for Gusto, ADP RUN and Paychex Flex**, plus a column mapper.
  - QuickBooks Online US has no CSV import, so show a manual-entry summary; an API push comes later.
  - Square: Labor API push, optional.
- **Records:** retention defaults to 4 years (minors until the later rule allows deletion), PDF/CSV timesheets, and a poster checklist.

**Later (Phase 15): "Payroll Prep, admin-verified." A conditional go.**
- **Scope:** W-2 hourly staff, one Colorado employer, OPT cities only (Denver, Glendale, Greenwood Village, Sheridan).
- **Calculations:** the Pub 15-T automated percentage method, FICA plus Additional Medicare, Colorado DR 1098 at 4.4%, FAMLI 0.88% (split, with the under-10-employee rule), and OPT.
- **Outputs:** Colorado-compliant pay stubs; a **NACHA PPD file the admin uploads to their own bank**; MICR checks plus a positive-pay file; prepared worksheets for 941, 940, DR 1094, UI and FAMLI, and W-2 (EFW2 plus Colorado's file).
- **The admin submits everything**, through EFTPS, SSA BSO, Revenue Online, MyUI and My FAMLI+.
- **KeaS never holds, moves or deposits money and never files on anyone's behalf.** Doing so would make it a money transmitter and expose volunteer treasurers to the trust-fund recovery penalty.
- **Safeguards:** a deposit-due calendar, a line-by-line breakdown of every calculation, year-start test vectors against the IRS examples, "you are the employer of record" warnings, and the first runs done in parallel with another calculator.
- **The payroll vault:** SSNs, bank details, W-4/DR 0004 forms and pay runs live **only** on the payroll admin's PC. The vault is encrypted with its own passphrase (DPAPI plus an Argon2-derived key) and has its own encrypted backups. The org server holds only hours and punches. Under Colorado law, a breach of encrypted data where the key isn't exposed doesn't require notification.
- **Upkeep:** about **100–200 hours a year**, mostly a December release with the new tables: Pub 15-T, the wage bases, the FUTA list, EFW2, Colorado's rate and file spec, SUTA, FAMLI, minimum wages, OPT, the COMPS poster, child-labor rules, and Nacha changes.
  - The user decided payroll ships as a standalone feature. See "Standalone payroll" below for the full-state scope, the estimates and the "verified for <year>" safety rule that replaces this gate.

## Workforce platform: the rest of the "best free Paycom-style suite" (researched 2026-10-27)
**Competitive bar:**
- Homebase's free tier and Connecteam's both stop at 10 people, and a 40-guard pool would pay about $70–105 a month.
- Nothing on the market does **lifeguard stand rotations**, **blocking a shift when the person's cert has expired**, **attendance flags that never count protected leave**, or a **Colorado personnel-file export**.
- The closest pool-ops product (DigiQuatics) is quote-only and has no rotations, incidents or audits.

KeaS's position: free, unlimited users, every feature included, and it can be self-hosted.

**Avoid what users of these products dislike:**
- paywalls;
- lag (clock-in has to be instant and work offline);
- notification floods (quiet hours, digests, per-channel opt-in);
- nag banners;
- features that exist only on the phone or only on the PC.

### Employee self-service (phone + PC)
- **Schedule and time:** schedule, open shifts, swaps, availability, time-off requests and balances, timesheets with sign-off, missed-punch requests.
- **Records:** certifications, training, policy acknowledgments, documents to sign.
- **Profile:** profile edits, and a "my personnel file" view.
- **Pay:** pay stubs and W-2s once payroll prep exists, or a "view in your payroll provider" link.
- **A pre-payday check** (like Paycom's Beti): "You have 1 missing punch and 1 unapproved shift before Friday." It nudges people to fix problems before payroll runs.

### Attendance (adds to Phases 12–13)
- **Late alerts:** when someone clocks in more than X minutes after their shift starts, with the grace period and threshold set per org and per position. Managers see live status: on time, late, no-show.
  - Alerts fire **at shift start plus the threshold**, not after the person arrives, so they never come too late.
- **Missed-punch and edit workflow:** the employee requests, the manager approves. Every edit needs a reason code. Missed-punch and edit counts are tracked per person.
- **Pattern flags, not automatic points:**
  - rolling-window counts of lateness, no-shows and missed punches;
  - **Colorado HFWA sick leave, ADA accommodations, pregnancy accommodations, jury duty, voting and approved swaps are never counted**;
  - KeaS only flags, and a manager decides and records why.
  
  (Colorado's HFWA treats counting sick leave as retaliation. Avoiding automated scoring also keeps KeaS clear of AI-decision rules.)
- **Clock-in methods:** PIN, QR, or an optional plain photo. **No face templates by default** (Colorado HB24-1130 biometric rules, Illinois BIPA). Geofence is checked only at punch time, never continuous tracking.

### Staff metrics (managers only)
- **Measures:** attendance rate, tardies, no-shows, missed punches, overtime %, labor cost %, training completion, cert compliance, rescue and incident counts, and lesson-review averages per instructor.
- **Format:** dashboards plus CSV. Every measure links back to its underlying records, so it's explainable.

### Discipline and documentation (tied to the person's org account)
- **Entries:** coaching, verbal, written, final, with attachments and links to the attendance records involved.
- **Employee side:** e-acknowledgment ("I've read this", not "I agree") plus an **optional rebuttal or comment**.
- **Visibility:** manager / HR / owner tiers, and an access log.
- **Minors:** an optional setting to notify a parent for 15–17-year-olds. Minors' contact details are visible to managers only.
- **Colorado C.R.S. 8-2-129:** a one-click **personnel-file export**. It leaves out legally separate records (I-9, medical) and confidential reports.
- **Retention:** the default is 3 years after the person leaves, never below the legal minimums. A **litigation hold** overrides auto-delete (EEOC 1602.14).

### KeaS Forms (QR feedback, a Google Forms replacement)
**v1:**
- **Question types:** text, choices, dropdown, date, number, star rating, NPS, Likert grid, scale, yes/no, sections, logic, validation.
- **Who can answer:** public anonymous (the default), public with optional contact details, or members only.
- **Built-in QR posters with hidden fields.** For example `?class=L3-Tue-5pm&instructor=…`, so one swim-review form covers every class and each response attaches itself to the right class and instructor, without asking for the child's name.
- **Spam protection with no Google:** honeypot, minimum fill time, signed load token, rate limits, self-hosted proof-of-work (ALTCHA, MIT) when under load, and optional one-response-per-device.
- **Controls:** close date and response cap.
- **Results:** live charts per class and per instructor, CSV export, and alerts such as "only when rating ≤ 2".
- **Privacy:** no IP addresses stored, retention per form (default 365 days), and templates addressed to the parent or guardian (Colorado SB24-041 covers minors under 18; COPPA for under-13s).

**v2:**
- Spanish versions.
- **Kiosk mode on a kiosk tablet:** offline queue, locked exit, auto-reset.
- Single-use links and rotating QR codes.
- File uploads behind an admin toggle (the upload pipeline).
- A local profanity and personal-info flagger.
- **A low rating opens a follow-up task**, and a form can create an incident or maintenance ticket.

### Operations modules: a generic engine with the Aquatics template first
**The engines are generic** (Logs, Checklists, Incidents, Equipment, Audits, Counts, Timers), and every item below is a **template plus pack content**, not hard-coded:
- **Logs** have fields, ranges, a frequency and out-of-range actions.
- **Incidents** have org-defined types and optional timers.
- **Equipment** items have a service life.
- **Audits** have rubric items.

The section numbers cited below come from the Colorado pool-code pack. Another state's pack, or the org's own settings, would replace them.
**v1 (daily compliance):**
- **Chemical and water log:** pools 3 times a day, with at least one manual reading; spas every 2 hours (5 CCR 1003-5 §4.9). Out-of-range pH or disinfectant prompts a **closure** (§4.7). Printable inspector view.
- **Opening, closing and shift checklists** with signatures.
- **Incident, rescue and first-aid reports**, with **fecal-incident closure timers**: 60 minutes for solid, 24 hours for diarrheal (§4.14).
- **In-service attendance** with sign-in on the device and hours per guard (built on the LMS).
- **Swim-lesson review forms.**
- **The certification tracker blocks scheduling a guard whose cert has expired.** It covers Red Cross (2-year), StarGuard (1-year), CPO/AFO and CPR/AED/first aid.

**v2 (operations):**
- **Rotation and stand board:** timers, push reminders, zone-coverage log, kiosk display.
- **Patron and bather-load counts** against the posted limit (§4.11).
- **Weather and lightning log**, with a 30-minute timer that resets on each strike.
- **Maintenance tickets and equipment register**, including **VGBA drain-cover service-life expiry**.
- **Internal audits:** VAT and recognition drills, zone tests and skills checks, with follow-up tasks.

**Later:**
- **Swim-lesson management:** levels and skills, instructor check-off on a tablet, parent report cards, waitlists with prerequisites.
- Importing readings from a LaMotte Spin Touch tester.
- Export formats for county health departments.

**Pack content to check before it ships:**
- the §4.7 free-chlorine table and any record-retention period, from the official Colorado PDF;
- which Colorado counties have adopted the CDC Model Aquatic Health Code (it's a choice in the pack, so the org picks its county);
- what each certifying agency requires for audits and in-services, which goes in the optional cert templates.

The user's YMCA (a Colorado nonprofit with its own YMCA cert type) is the first test org. A second, different test org is required (see the design principle).
- **Opt-in payroll provider connection** (user-approved): the org connects its own Gusto, ADP or QuickBooks account, and KeaS sends approved hours and earnings. It's off unless the org turns it on.

### Standalone payroll: the user's decision (2026-10-27) overrides the research caution below
The user wants KeaS's payroll to **stand on its own** ("that's all of our value").

**What standalone means:**
- **KeaS calculates:**
  - gross pay;
  - federal withholding (Pub 15-T);
  - FICA and Additional Medicare;
  - FUTA;
  - state income tax withholding;
  - SUI, using the employer's own rate entered against a wage-base table;
  - state paid-leave programs;
  - simple local taxes;
  - deductions.
- **KeaS produces:** pay stubs, a NACHA direct-deposit file, check printing with a positive-pay file, a deposit-due calendar, and pre-filled federal and state forms and files (941, 940, W-2/W-3 plus an EFW2 file, state returns, SUI wage reports).
- **The employer submits and pays.** KeaS never moves money and never files on the employer's behalf. Licensing as a money transmitter and IRS e-file transmitter approval are separate "much later" questions.

**Phases, with honest estimates** (Claude does most of the coding; a person checks results against official worked examples):
- **15a:** engine core (pay periods, year-to-date wage bases, deductions, supplemental pay, pay stubs, NACHA file, check printing), plus federal, Colorado and the 9 no-tax states. **About 150–250 hours.**
- **15b:** income tax withholding for every remaining state plus DC, as table-driven formula types (flat, brackets, allowance credit, percent of federal), plus reciprocity certificates. **About 100–200 hours.**
- **15c:** SUI wage-base table, employee-paid SUI (AK/NJ/PA), and the ~14 state paid-leave and disability programs. **About 40–80 hours.**
- **15d:** simple local taxes (CO OPT, MD counties, IN counties, MI cities, NYC/Yonkers, KC/STL, OR transit). **About 40–80 hours.**
- **15e (last):** PA, OH and KY local taxes, with address-to-district lookup. **About 200+ hours**; until then KeaS tells the user to handle them in a payroll provider.

**Total through 15d: about 330–610 hours.**

**Yearly upkeep: about 40–100 hours every December.** Claude compares each new official PDF with last year's version and drafts the table changes, then a person signs off.

**The safety rule (non-negotiable):**
- A state's tables are marked **"verified for <year>"** only when its cited sources are recorded and its test cases pass. Test cases come from the state's own published examples and are cross-checked against the TimeTrex CE tests and PolicyEngine annual totals. Both are reference only; their code isn't copied, because of the AGPL licence.
- If a state isn't verified for the current year, KeaS **warns plainly and blocks finalizing a payroll run** until the admin acknowledges it. It never calculates silently.
- Every pay stub line can be expanded to show exactly how it was calculated.

**The payroll vault:** SSNs, bank details and W-4/state forms stay encrypted on the payroll admin's PC only (as described in Phase 15 above).

**The pay run, start to finish:**
1. **Punches → timecards.** Missed punches, lateness and overtime are flagged.
2. **The manager approves timecards.** The period locks.
3. **The payroll admin opens the pay run.** Per person: gross pay, every deduction and tax (each line expandable to show how it was calculated), net pay, and the employer's own taxes. Warnings also appear here:
   - a state not verified for the year;
   - pay below the minimum wage;
   - a missing W-4;
   - a garnishment cap reached.
4. **The admin approves the run.** KeaS:
   - locks it;
   - publishes pay stubs to the employee self-service app;
   - writes the NACHA direct-deposit file (or prints checks plus a positive-pay file);
   - updates the deposit-due calendar.
5. **Paying employees:** the admin uploads the NACHA file to the org's own bank.
   - **Optional (opt-in):** if the org's bank has an API (Mercury, Increase, Column, and so on), the admin connects it with the org's own API key. Approving then sends the deposits **from the org's own account**, and KeaS never holds any funds.
6. **Paying taxes:** KeaS shows "deposit $X by <date>" for federal (EFTPS) and each state portal. The admin pays them by hand; EFTPS bulk filing for other employers is only open to approved batch providers.
7. **Quarterly and year-end:** 941/940, W-2/W-3 plus the EFW2 file, W-2c corrections, state returns, SUI and paid-leave wage reports, all filled in for the admin to file.

**Deductions and special cases** (needed to truly replace payroll software):
- **Pre-tax:** Section 125 health, dental and vision; 403(b)/401(k) with annual and catch-up limits; HSA/FSA.
- **Post-tax:** Roth, union dues, other.
- **Garnishments:** child support, creditor, tax levies, student loans. Federal CCPA limits apply, plus state rules and the order of priority between them.
- **Off-cycle runs:** final pay (state deadlines from the labor table), bonuses with supplemental rates, corrections, retro pay, PTO payout, reimbursements.
- **Nonprofit options:**
  - a 501(c)(3) **is exempt from FUTA** (toggle);
  - **reimbursable SUI** instead of the contribution rate (toggle).
- **Year-end:** new-hire reporting reminders (state deadlines), workers' comp payroll reports by class code, W-2c corrections.

**More features needed to truly replace payroll software:**
- **Labor-cost allocation by program, fund or grant**, with a general-ledger export to QuickBooks, Xero or Sage. Nonprofits like YMCAs need this.
- **ACA 1095-C/1094-C** for employers with 50+ FTEs, plus FTE tracking.
- **1099-NEC** for contractors.
- **Tips; employees working in more than one state** (work-state vs residence-state rules); **employee loans and advances**.
- **Simple benefits enrollment:** plans, elections, effective dates, and the deductions they create.
- **Left out on purpose:** certified/prevailing-wage payroll and union contract rules. PA/OH/KY local taxes come last (15e).

**How much stays manual compared with full-service payroll:**
- **Paying employees:** automatic with the bank API, otherwise a 2-minute NACHA upload.
- **Tax deposits:** manual on EFTPS and the state portals, about 5–10 minutes a month.
- **Quarterly and year-end forms:** KeaS fills them in and the admin submits.
  - **Form 941 can't be e-filed by the employer directly.** It's printed and mailed until KeaS becomes an IRS-authorized e-file provider (Software Developer/Transmitter, ATS testing). That's a later step, and it needs a legal entity.
  - W-2s go through SSA BSO (free), and Colorado returns through Revenue Online.
- **Overall:** about 1–2 hours a month for a small org.

**Legal posture (users and the author):**
- **The employer always remains liable** for withholding and filing, whatever software they use.
- **What KeaS can't offer:** paid services sell penalty guarantees. KeaS can't, so it relies on accuracy and transparency:
  - the "verified for <year>" block;
  - per-line explanations;
  - a required parallel run on the first pay run of a new org;
  - in-app advice to have a CPA review the first year.
- **No licensing is needed** as long as KeaS never holds or moves funds and never acts as a reporting agent.
- **Data:** SSNs and bank details are only in the encrypted payroll vault. A breach of properly encrypted data where the key isn't exposed doesn't require notification under C.R.S. 6-1-716.
- **Author protection, before promoting payroll to outside orgs:**
  - form a legal entity (an LLC or a nonprofit);
  - have a lawyer review the terms of use and disclaimer once;
  - keep the open-source licence's "AS IS" clause, and show a clear in-app notice that the employer is the employer of record.

**What makes KeaS competitive:**
- free and unlimited;
- one system covering scheduling, time, payroll, training and certifications (shifts blocked when a cert has expired);
- rotations, operations logs and QR forms;
- every number explained;
- the payroll data stays on the admin's PC.

**The honest gap compared with Paycom:** Paycom is a licensed payroll *service*. It takes the funds from the employer, pays employees and agencies itself, and files as the employer's agent (Form 8655). KeaS calculates and prepares everything. The org's own bank moves the money, and a person makes the tax deposits and filings.

**Labor rules for all 50 states plus DC** go in **one editable defaults table** (user decision): overtime, meal and rest breaks, minors' hours, minimum and tipped wages, sick leave accrual.
- Each row cites its source and a "checked on" date, and is labelled "defaults, check your state's rules".
- Orgs can override any value, and the reason is logged.
- Building it takes **a few days**; keeping it current is mostly the January minimum-wage changes.

### Payroll across all 50 states: what the original research found (kept for reference)
- **The size of the job:**
  - every state publishes its tables as PDFs, and there are about 4,900 local tax jurisdictions;
  - payroll filings would need about 90–100 separate file formats, each revised every year;
  - all 50 states would take **about 2,000–3,500 hours to build and 500–900 hours a year to maintain** (calculation only; filings roughly double it).
  
  A licensed engine (Symmetry) costs around $260k a year and can't be redistributed. Embedded payroll services (Check, Gusto Embedded) need a company with a security program.
- **Architecture:**
  - one engine plus **rule packs**, one per jurisdiction, with every number cited to its source and dated, and test vectors cross-checked against the TimeTrex CE tests and PolicyEngine-US annual totals (both AGPL, so use them as reference only and don't copy their code);
  - each pack has a maintainer and a reviewer who didn't write it, and **a pack drops to "Unmaintained" automatically if nobody re-signs it for the new tax year**.
- **Rollout:**
  - **Supported first:** federal and Colorado.
  - **Then:** the 9 states with no income tax and the ~15 flat-tax states (cheap to add, and they cover many employers).
  - **Progressive states:** "Experimental" until they pass review.
  - **PA, OH and KY local taxes are out of scope:** KeaS says "use your payroll provider".
- **For full service, KeaS connects to the org's own payroll provider (opt-in):** the org keeps its own Gusto, ADP or QuickBooks account, and KeaS sends hours and earnings to it. This needs each provider's partner approval. It's an opt-in cloud connection, so the user should confirm it.
- **Realistic target:** federal and Colorado solid, and about 20–25 states supported within 2–3 years if there are 5–10 committed state maintainers.


## Dead ends to cover
| Situation | What the user sees and can do |
|---|---|
| Expired certification | A reminder and a renewal action (enter new dates; the expiry is recalculated). Shifts needing it are blocked until then |
| No one takes a shift swap | The shift stays with the original person, and the manager sees the open request |
| State tables not verified for this year | A plain warning; the pay run can be previewed but not finalized |

## Verification still to add
- Cert sharing settings are respected (the number and photo never reach the server).
- A shift swap updates both people's schedules (and Kea calendars, if linked).
- Assigning a shift to someone whose required cert has expired is blocked.
