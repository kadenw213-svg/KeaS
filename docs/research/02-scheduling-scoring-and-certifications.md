# 02: Scheduling, Staff Scoring, Shift Bidding and Certifications

*Research date: 2026-10-21. Written for KeaS, a free, open-source workforce management app for aquatics facilities (lifeguards and swim instructors, mostly hourly, often minors).*

> **Not legal advice.** This document lists legal risks and design mitigations found in public sources. Before the scoring system affects pay, discipline or hours in production, have an employment attorney in each deployment state review it. The rules vary a lot by state and city.

---

## 0. TL;DR design decisions

1. **Call it a "priority score," not a discipline score.** Use it only to order who gets contested shifts. Don't wire it to discipline, firing or pay automatically. This lowers legal risk a great deal (section 4).
2. **Every score change is an immutable `score_event` row with a reason code and a reason category.** A score is always *derived* from events, never edited directly. Staff can see the full ledger.
3. **Protected absences produce zero-point events, never negative ones.** Examples: sick/safe leave, FMLA, ADA accommodation, jury duty, voting, military, school-required time for minors. "Getting your shift covered" is only penalized when the reason is unprotected, and even then the penalty is small.
4. **Decay old events.** Use a 90-day half-life (exponential decay) plus a hard cutoff at 365 days, so old mistakes fade.
5. **Hard rules first, score second.** Certifications, availability, minor-hour limits, max hours and ratios are *hard constraints*. The score only breaks ties among *legal, qualified* candidates. A score can never get an uncertified person onto the stand.
6. **Scheduling engine:** a greedy priority-assignment MVP (simple, explainable, fast). Plan for an upgrade path to **Google OR-Tools CP-SAT** (Apache-2.0, available in Python, Java, C# and C++) once fairness and ratio constraints get complex.
7. **Pay from actual punches; score from arrival behavior.** Arriving 10 to 20 minutes early can earn points. But if the employee is clocked in *and working*, that time must be paid. Don't let the score push minors to come in early unpaid.

---

## 1. How existing products handle bidding, open shifts and swaps

### 1.1 Commercial SMB schedulers (Deputy, When I Work, Homebase, TimeForge, RosterElf)

| Feature | How it typically works |
|---|---|
| **Open shifts / marketplace** | Manager publishes an unassigned shift. Qualified, available staff see it and "request" it. When I Work shows it on the Open Shifts dashboard card ([softwarefinder](https://softwarefinder.com/resources/when-i-work-swap-shifts)). Deputy offers **"Open Shift with Approval"**: staff opt in, the system shows managers *recommended candidates*, and the manager decides ([Deputy blog](https://www.deputy.com/blog/ensure-the-most-suitable-employee-fills-your-open-shift)). RosterElf similarly suggests candidates and the manager picks ([RosterElf](https://www.rosterelf.com/support/knowledge-base/open-and-shift-swaps/managing-shift-swaps-and-open-shifts-from-a-browser)). |
| **Shift offers (give-away/cover)** | Deputy: the employee offers a shift to eligible coworkers. By default no manager approval is needed, but the manager is notified on acceptance. This can be configured per location ([Deputy help](https://help.deputy.com/hc/en-au/articles/4688726501135)). |
| **Swaps (trade)** | Configurable as manager-approved or auto-approved, in both Deputy ([Deputy shift trading](https://www.deputy.com/au/features/shift-trading)) and When I Work. Deputy shows the **cost impact** (overtime etc.) before approval. TimeForge separates "open swaps" (given up, not yet picked up) from "pending swaps" (picked up, awaiting approval) ([TimeForge](https://guides.timeforge.com/a/1290860)). |
| **Eligibility filtering** | All of them filter candidates by role/skill, availability, conflicts and overtime before showing a shift. |

**Takeaways for KeaS:**
- Use a three-state cover flow: `offered → claimed → approved/auto-approved`.
- Make approval configurable per location and per role. For example, lifeguard covers might auto-approve if the claimer is certified and under max hours.
- Always re-run the hard-constraint check at claim time *and* approval time, because certs can expire in between.

### 1.2 Enterprise (UKG Pro / Dimensions, Paycom)
UKG Pro Scheduling (formerly UKG Dimensions) handles open shifts, self-scheduling and time-off ([Surety Systems](https://www.suretysystems.com/insights/ukg-schedule-everything-you-need-to-know/)). The detailed seniority bidding rules that unions require (CBA tie-breakers, classification seniority) are often bolted on with third-party rules engines that sit on top of UKG data ([CloudApper on UKG seniority bidding](https://ukg.cloudapper.ai/bidding/how-to-set-up-seniority-based-shift-bidding-in-ukg-pro-for-union-workforces/)). This gap is an opportunity for KeaS: a **transparent, configurable rules engine** is a real differentiator.

### 1.3 Airline crew bidding (PBS vs. line bidding)
- **Line bidding (legacy):** a line optimizer prebuilds legal schedules ("lines"). Crew bid on whole lines in strict seniority order, and the most senior bidder wins each line.
- **Preferential Bidding System (PBS):** crew submit *weighted preferences* (days off, start times, trip length). A solver builds individual schedules that honor seniority, regulations and coverage ([Wikipedia: PBS](https://en.wikipedia.org/wiki/Preferential_bidding_system); [ALPA PBS workshop](https://www.alpa.org/articles/2023/11/pbs-applications-at-alpa-workshop)).
- Award logic differs. A **sequential** PBS awards in strict seniority order: it processes pilot #1's full schedule, then #2, and so on. **Globalization** logic optimizes the whole set of schedules at once and can occasionally favor juniors. This causes perceived unfairness ("lucky lineholders/unlucky reserves") ([ALPA FAQ](https://alata.alpa.org/FAQs)).

**Takeaway:** the user's design ("higher weight wins a contested shift") is essentially *sequential seniority bidding*, with a performance score in place of tenure. Two lessons apply directly:
1. **Explain awards.** Show "you did not get Sat 8am because Alex (score 112) also bid on it and ranked it higher."
2. **Let staff rank preferences** instead of only giving yes/no, so the solver can give each person their best remaining option.

### 1.4 Nurse self-scheduling and union seniority
- CBAs typically rank bids by seniority, with **ties broken by a documented, published rule** applied consistently ([Law Insider sample clauses](https://www.lawinsider.com/clause/scheduling-shift-bidding); [StaffReady](https://staffready.com/?p=2728)).
- Seniority is defined either as total service or as time in a classification. Tie-break cascades such as hire date → rank → ID number are common ([USPTO patent 11488078](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11488078)).
- Self-scheduling commonly fails when senior staff take all the desirable shifts. Best practice is **rotation rules so undesirable shifts are shared** ([Synerion](https://www.synerion.com/blog/self-scheduling-for-nurses-will-it-work-on-your-unit); [Becker's](https://www.beckershospitalreview.com/workforce/the-dos-and-donts-of-nurse-self-scheduling.html)).

---

## 2. Scoring model design ("Priority Score")

### 2.1 Principles
- **Explainable:** every point traces to a dated event with a human-readable reason.
- **Bounded:** caps per event type per window, so one person can't farm points (for example by covering 20 shifts in a week).
- **Forgiving:** recent behavior matters more than old behavior. There's a floor so nobody is permanently locked out.
- **Protected-safe:** the reason taxonomy is designed so that legally protected absences cannot produce negative points (section 4).
- **Tunable:** all values live in a `score_rule` config table per organization, not in code.

### 2.2 Proposed event point values (defaults; admin-configurable)

| Event | Points | Notes / caps |
|---|---|---|
| **Base score** | 100 | Every employee starts at 100. New hires sit at base, not zero, so they aren't starved of shifts. |
| Covered a coworker's shift (offered ≥ 24h ahead) | **+3** | Cap: +12 per rolling 30 days from covers. |
| Covered a shift on short notice (< 24h) | **+5** | Counts toward the same cap. Rewards emergency help. |
| Covered a shift on very short notice (< 4h / "rescue") | **+7** | Same cap. |
| Got own shift covered, unprotected reason, ≥ 72h notice | **0** | Planning ahead should not be punished. It's what you want staff to do. |
| Got own shift covered, unprotected reason, 24 to 72h notice | **−1** | |
| Got own shift covered, unprotected reason, < 24h notice | **−2** | |
| Shift released, **protected reason** (sick/safe, FMLA, ADA, jury, military, voting, school-required) | **0** | Recorded as a *neutral* event for audit only. Its notes are never shown to coworkers. |
| Called out (no cover found), unprotected, ≥ 2h notice | **−4** | |
| **No-call/no-show** | **−15** | Manager must confirm it within 48h (it was not an emergency, system outage etc.). Auto-converts to "pending review" until then. |
| Late arrival, 1 to 5 min (grace) | **0** | Grace period. Phone clocks drift and parking happens. |
| Late arrival, 6 to 15 min | **−1** | |
| Late arrival, > 15 min | **−3** | |
| Early arrival, 10 to 20 min before shift start | **+0.5** | Cap: +4 per rolling 30 days. Arriving > 20 min early = 0, per the user's request. **Arrival time ≠ paid time; see 4.6.** |
| Positive parent feedback (verified lesson, rating ≥ 4/5) | **+2** | Cap: +8 per rolling 30 days. Requires a verified lesson link so it can't be spammed. |
| Negative parent feedback | **0 by default** | Route to manager review rather than auto-deducting. Parent reviews can carry bias, so negative ones should be screened by a person (see 4.7). |
| Manager commendation | **+1 to +5** | Requires a written note. Visible to the employee. |
| Manager adjustment / reversal | ± any | Requires a reason. Audit-logged. Typically used to void a mistaken penalty. |

The *ratios* matter more than the exact numbers. A no-show (−15) should equal roughly 3 to 5 short-notice covers. Lateness should be small enough that a single bad day barely moves the ranking.

### 2.3 Decay

Use **exponential decay with a half-life** (default `H = 90 days`) plus a **hard cutoff** (default 365 days, after which an event contributes 0 and is archived).

```
weight(event, today) = 0                                  if age_days > CUTOFF
                     = 0.5 ^ (age_days / H)               otherwise
```

Why exponential instead of a pure rolling 90-day window:
- A rolling window creates a "cliff": the score jumps on day 91, which feels arbitrary.
- Exponential decay is smooth and still easy to explain ("a penalty loses half its weight every 3 months").
- A rolling 90-day window is still offered as a simple config option for organizations that prefer "points drop off after 90 days." Many attendance-point HR policies are written that way, and it's easy to state in a handbook.

**Leave-freeze rule:** when an employee is on approved protected leave (FMLA etc.), **pause the decay clock for both positive and negative events**. This mirrors DOL opinion letter FMLA2018-1-A, which allowed freezing attendance points during FMLA leave if it's applied the same way to comparable leave types ([DOL FMLA2018-1-A](https://www.dol.gov/whd/opinion/FMLA/2018/2018_08_28_1A_FMLA.pdf); [HR Dive](https://www.hrdive.com/news/dol-oks-freezing-no-fault-attendance-points-during-fmla/531141/)). The simplest safe alternative is to *not* freeze. Then just ensure no negative events come from the leave itself. Decide on one policy and apply it consistently.

### 2.4 Floor, ceiling, caps

- **Floor:** `score ≥ 50`. Nobody drops below 50. A low score lowers your priority but never locks you out of all hours. Manager discipline is a separate, human process.
- **Ceiling:** `score ≤ 150`. This prevents runaway leaders.
- **Per-category caps per rolling 30 days** (shown in the table) stop farming.
- **Probation display:** score < 70 can trigger a *notification to a manager* to have a conversation. It never triggers automatic discipline.

### 2.5 Formula

```
raw(e, t)       = sum over events i of e:  points_i * decay(t - date_i)   (after per-category caps)
priority(e, t)  = clamp( BASE + raw(e, t), FLOOR, CEILING )
```

Caps are applied **before** decay, at award time. If an award would exceed the 30-day cap, the event is still stored with `points_awarded = 0` and `capped = true`, so the ledger stays honest.

### 2.6 Tie-breakers (applied in order)
1. Higher priority score (rounded to 1 decimal, so near-ties count as ties)
2. **Fairness term:** fewer hours already awarded in this schedule period (see 3.4)
3. Higher bid rank (did the employee rank this shift as their #1 choice or their #5?)
4. Longer tenure (hire date)
5. Deterministic random seed per schedule run, stored for audit. **Don't** use SSN digits.

### 2.7 Worked example

Settings: BASE = 100, half-life H = 90 days. Today is day 0. Events for **Maya (16, lifeguard)**:

| Event | Age (days) | Points | Decay factor 0.5^(age/90) | Contribution |
|---|---|---|---|---|
| No-call/no-show | 120 | −15 | 0.397 | −5.95 |
| Covered shift < 24h | 40 | +5 | 0.735 | +3.67 |
| Covered shift ≥ 24h | 20 | +3 | 0.857 | +2.57 |
| Late 8 min | 10 | −1 | 0.926 | −0.93 |
| Early 15 min (x3) | 2 to 9 | +0.5 x3 | about 0.95 avg | +1.43 |
| Parent review 5★ | 5 | +2 | 0.962 | +1.92 |
| Sick day (protected) | 30 | 0 | n/a | 0 |
| **Total** | | | | **+2.71** |

Maya's priority = clamp(100 + 2.71) = **102.7**.

**Jordan (17)** has two covered shifts 15 and 60 days ago (+3 each → 2.67 + 1.89 = 4.56) and nothing else. Priority = **104.6**.

Both bid on Saturday 8am to 12pm at the main pool. Jordan wins on score. The explanation shown to Maya:

> *"Sat 8:00 to 12:00 Main Pool went to another bidder with a higher priority score (104.6 vs 102.7). Your biggest factor is a no-show on Jun 23 (currently −5.9; it halves again by Sep 21). You were awarded your #2 choice, Sat 12:00 to 4:00."*

**The score breakdown screen** shows: the current score, a sparkline over time, each event with its *original* and *current decayed* value, which caps applied, and the date each penalty halves. This transparency is the core fairness feature.

---

## 3. Schedule generation algorithms

### 3.1 Constraints for aquatics

**Hard constraints (never violate):**
- Employee is available (from the availability table) and has no approved time-off.
- No overlapping shifts. Minimum rest between shifts (configurable, for example 8h).
- **Required certification(s) for the role are valid for the entire shift date** (for example Lifeguard + CPR/AED-PR + First Aid for a guard. WSI for a swim instructor).
- **Minor hour limits** (federal and state, whichever is stricter; see 4.5): daily/weekly hours, time-of-day windows, school-day vs non-school-day rules.
- **Minor job restrictions:** 14-year-olds can't lifeguard. 15-year-olds can lifeguard only at pools/water parks, with certification, and not in chemical/mechanical rooms ([29 CFR 570.34(l)](https://www.law.cornell.edu/cfr/text/29/570.34); [DOL Fact Sheet #60](https://dol.gov/agencies/whd/fact-sheets/60-child-labor-lifeguards)).
- **Coverage/ratio:** each pool/zone/time slot needs N qualified guards. The facility's written staffing plan sets N. Under MAHC-style codes, each zone must be fully visible to its guard and reachable within 20 seconds, and guards rotate at least every 60 minutes ([Pueblo County MAHC summary](https://www.pueblocounty.gov/sites/default/files/2024-02/Written%20Plans%20for%20Aquatic%20Facility_Lifeguards%20Required.pdf); [NEHA MAHC lifeguard module](https://www.neha.org/Images/resources/Understanding%20&%20Applying%20LifeguardBather%20Supervision%20and%20Operational%20Entries%20in%20the%20MAHC.pdf)). Model this as "required headcount per zone per time block." Also consider requiring at least one 18+ or supervisor-certified guard per shift.
- Max hours per week (org policy). Overtime > 40h/week (FLSA) is a hard constraint unless a manager overrides it.

**Soft constraints (optimize):**
- Honor bids and preferences, weighted by priority score.
- Fairness: spread hours. Desired-hours targets (each person states min/max desired hours).
- Avoid split shifts, minimize "clopens," keep consistent instructor-to-class assignments for lessons.
- Minimize schedule changes after publishing (important if a predictive-scheduling ordinance applies).

### 3.2 Option A: greedy priority assignment (recommended MVP)

```
function build_schedule(period):
    slots  = all unfilled (shift, role) slots in period
    # Hardest-to-fill first: fewest eligible candidates, then earliest start
    sort slots by (count_eligible(slot), slot.start)

    hours_awarded = map employee -> 0
    for slot in slots:
        candidates = [e for e in staff if hard_ok(e, slot, current_assignments)]
        if candidates empty:
            flag slot as UNFILLED (alert manager, post as open shift); continue
        for e in candidates:
            e.key = (
                bid_bonus(e, slot),                         # bid rank → value; 0 if no bid
                effective_score(e, hours_awarded[e]),      # score with fairness damping
                -hours_awarded[e],
                -e.bid_rank(slot),
                e.hire_date (earlier first),
                seeded_random(e.id, run_seed)
            )
        winner = max(candidates, key)
        assign(winner, slot); hours_awarded[winner] += slot.hours
        log AwardDecision(slot, winner, runners_up=top 3 with keys)   # for explanations

function effective_score(e, hours):
    # Fairness: score advantage shrinks as you approach your desired hours
    target = e.desired_hours_max or org_default
    damp   = max(0, 1 - hours / target)
    return BASE + (e.priority - BASE) * damp  -  OVER_TARGET_PENALTY * max(0, hours - target)
```

`hard_ok` checks availability, overlap, rest, cert validity on the shift date, minor rules (cumulative daily/weekly with the candidate slot added), max hours/overtime and role qualification.

**Pros:** simple, fast (milliseconds for ~100 staff), every decision is explainable ("you lost to X with key Y").
**Cons:** myopic. Assigning a scarce WSI to an early slot may leave a later lesson unfillable. Mitigations: sort hardest-to-fill first, then run a **repair pass**. Try 2-swap moves for unfilled slots: find an assigned person who could move elsewhere, freeing a qualified person.

### 3.3 Option B: constraint solver (upgrade path)

**Google OR-Tools CP-SAT** (Apache-2.0, Python/Java/C#/C++). Its official nurse-scheduling tutorial models a boolean `x[e, s]` per employee and shift, with coverage and per-employee constraints ([OR-Tools employee scheduling](https://developers.google.com/optimization/scheduling/employee_scheduling); [nurses_sat notebook](https://nbviewer.org/github/google/or-tools/blob/v99bugfix/examples/notebook/sat/nurses_sat.ipynb)). The repo also has a larger `shift_scheduling_sat.py` example with soft constraints and penalties.

```python
from ortools.sat.python import cp_model
m = cp_model.CpModel()
x = {(e,s): m.NewBoolVar(f"x_{e}_{s}") for e in staff for s in slots if eligible(e,s)}  # prefilter hard rules

# Coverage: each slot gets exactly its required headcount (or allow shortfall var with big penalty)
for s in slots:
    short[s] = m.NewIntVar(0, s.required, f"short_{s}")
    m.Add(sum(x[e,s] for e in staff if (e,s) in x) + short[s] == s.required)

# No overlaps
for e in staff:
    for (s1, s2) in overlapping_pairs:
        if (e,s1) in x and (e,s2) in x: m.AddBoolOr([x[e,s1].Not(), x[e,s2].Not()])

# Minor and max-hour limits (minutes): per day and per week
for e in staff:
    for day in days:   m.Add(sum(mins(s)*x[e,s] for s in slots_on(day) if (e,s) in x) <= day_limit(e, day))
    for wk in weeks:   m.Add(sum(mins(s)*x[e,s] for s in slots_in(wk) if (e,s) in x) <= week_limit(e, wk))

# Fairness: hours per employee; penalize deviation from desired target
for e in staff:
    h[e] = sum(mins(s)*x[e,s] ...); dev[e] = m.NewIntVar(0, BIG, ""); m.AddAbsEquality(dev[e], h[e] - target(e))

# Objective: honour bids weighted by priority score, minimize shortfall and unfairness
m.Maximize(
    sum(x[e,s] * bid_value(e,s) * score_weight(e) for (e,s) in x)
  - W_SHORT * sum(short.values())
  - W_FAIR  * sum(dev.values())
)
solver = cp_model.CpSolver(); solver.parameters.max_time_in_seconds = 20
```

**Timefold Solver** (the fork of OptaPlanner, Apache-2.0, Java/Kotlin, plus Python) ships an **employee-scheduling quickstart** with REST API and UI. Constraints are written as code ("constraint streams") with hard and soft scores ([Timefold quickstarts](https://docs.timefold.ai/timefold-solver/1.x/quickstart/overview); [Timefold Python](https://timefold.ai/blog/new-open-source-solver-python)). It's a good fit if the backend is JVM-based.

| | Greedy | CP-SAT | Timefold |
|---|---|---|---|
| Explainability | Excellent | Moderate (explain via "what changed if you remove X") | Good (score explanation API) |
| Optimality | Heuristic | Optimal or near-optimal | Near-optimal (local search) |
| Complex fairness/ratios | Hard | Natural | Natural |
| Ops complexity | None | pip/NuGet dependency | JVM / Python lib |
| Best for | MVP, < 50 staff, simple pools | Growth, multi-pool, lessons | JVM shops |

### 3.4 Recommendation
- **Phase 1:** greedy + repair pass, plus a full `award_decision` log for explanations. Same hard-constraint module (`hard_ok`) used everywhere: build time, open-shift claim, swap approval and manager drag-and-drop (a manager override must state a reason).
- **Phase 2:** swap the engine for CP-SAT behind the same interface (`Schedule build(period, staff, slots, rules)`). The objective uses `bid_value × score_weight` so the "higher weight wins" intent is preserved, while CP-SAT can also find globally better solutions.
- **Fairness so top scorers don't take everything:**
  - (a) Score only orders *contested* shifts.
  - (b) Desired-hours targets with diminishing returns (the `damp` term).
  - (c) Optional per-person cap on "premium" shifts (for example weekend mornings) per period.
  - (d) Consider **tiering**: convert scores into tiers (A ≥ 110, B 90 to 110, C < 90). Within a tier, rotate or use the hours-fairness term. This makes small score differences irrelevant and reduces gaming and anxiety.
  - (e) Like sequential PBS, process in rounds. Each bidder gets their top remaining choice per round (a "draft" style), instead of the top scorer taking all their choices first.

---

## 4. Legal risks of the scoring system (US)

### 4.1 Paid sick leave laws: the biggest risk
Many states and cities forbid counting protected sick/safe leave as an attendance "occurrence" or using it against the employee.
- **California:** Labor Code §246.5 prohibits discharging, threatening, demoting, suspending, or "in any manner" discriminating against an employee for using accrued sick days. The Labor Commissioner's FAQ says assigning an "occurrence" for a covered absence with accrued leave available is not permitted. §234 makes an absence-control policy that counts kin-care leave a per se violation. If no accrued leave is available, an occurrence may be assigned ([CA DLSE Sick Leave FAQ](https://www.dir.ca.gov/dlse/Sick_Leave_Law_FAQs.pdf); [Ogletree](https://ogletree.com/shared-content/content/blog/2017/may/california-paid-sick-leave-update-employer-attendance-policies-may-interfere-with-labor-code-rights); [Lab. Code 246.5](https://california.public.law/codes/labor_code_section_246.5)).
- **New York City:** Earned Safe and Sick Time Act bars an "absence control policy that counts safe and sick leave as an absence that may lead to or result in an adverse action."
- **New York State (2022 amendment to Labor Law §215):** bars assessing points or deductions under a no-fault attendance policy for **any** absence protected by federal, state or local law. Remedies include lost pay, liquidated damages and attorneys' fees ([Gibson Dunn](https://www.gibsondunn.com/new-york-amends-labor-law-to-prohibit-retaliation-for-lawful-absences/); [Jones Day](https://www.jonesday.com/en/insights/2022/12/new-york-state-prohibits-retaliation-against-employees-who-use-legally-protected-leave); [SHRM](https://www.shrm.org/in/topics-tools/employment-law-compliance/new-york-law-bans-penalties-protected-absences)).
- Most of the ~18+ states and many cities with paid sick leave have similar anti-retaliation provisions (verify per jurisdiction).

**Is a lower shift-priority score an "adverse action"?** Almost certainly yes, if it means fewer or worse hours. Treat it as one.

### 4.2 FMLA
FMLA covers employers with 50+ employees within 75 miles, for employees with 12 months/1,250 hours. Many small pools won't be covered, but municipal and parks departments often are. The DOL's position is that employees **cannot accrue points for FMLA leave** under a no-fault policy (29 CFR 825.220(c)). Freezing points during FMLA leave is acceptable if it's applied consistently with other leave ([DOL FMLA2018-1-A](https://www.dol.gov/whd/opinion/FMLA/2018/2018_08_28_1A_FMLA.pdf); [Jackson Kelly](https://jacksonkelly.com/labor-employment-personnel-blog/department-of-labor-issues-opinion-letter-regarding-no-fault-attendance-policies-and-the-fmla)).

### 4.3 ADA (15+ employees)
The EEOC treats rigid no-fault attendance policies as a frequent source of ADA violations. Exceptions to the policy can themselves be a required reasonable accommodation, assessed individually. Mueller Industries paid $1M over a no-fault attendance policy, and a separate EEOC matter involved points assigned for disability-related absences ([HR Dive](https://www.hrdive.com/news/manufacturer-pays-1m-for-180-day-no-fault-attendance-policy/528126/); [Bradley](https://www.bradley.com/insights/publications/2023/05/bueller-bueller-eeoc-examining-attendance-policies-for-ada-violations); [Duane Morris](https://www.duanemorris.com/articles/eeoc_continues_target_inflexible_leaves_of_absence_attendance_policies_4220.html)). Lateness penalties also matter here. Late arrivals caused by a disability (for example medication timing or paratransit) may need an accommodation that waives them. The same reasoning applies to pregnancy under the PWFA.

### 4.4 Predictive scheduling / fair workweek
These laws exist in **Oregon** (statewide) and roughly 10 localities: NYC, San Francisco, Seattle, Philadelphia, Chicago, LA City, LA County, Berkeley, Emeryville and Evanston. Several states preempt them ([Clockspot list](https://www.clockspot.com/articles/predictive-scheduling-laws-by-state); [Homebase 2026 guide](https://wf.joinhomebase.com/blog/predictive-scheduling-laws)). Most cover only retail, food service and hospitality, often with large-employer thresholds. Oregon applies to retail/hotel/food service employers with 500+ employees worldwide ([Oregon BOLI](https://www.oregon.gov/boli/workers/Pages/predictive-scheduling.aspx)). A standalone swim school is **usually not covered**, but a pool inside a hotel chain or a large rec employer in Chicago or Seattle might be. Typical rules: post schedules 14 days ahead, pay "predictability pay" for employer-initiated changes, offer hours to existing staff before hiring, and give a right to rest between shifts. Most ordinances **exempt employee-initiated, voluntary swaps and covers** from predictability pay, so the cover marketplace must record *who initiated* each change.
**Design:** add an org-level "fair workweek mode" that enforces the posting lead time, flags changes inside the window with a premium-pay estimate, and records `initiated_by` (employee vs employer) on every change.

### 4.5 Child labor (FLSA plus state law, stricter rule wins)

| Age | Federal limits (non-agricultural) | Aquatics-specific |
|---|---|---|
| **14 to 15** | Outside school hours only. ≤ 3h on a school day (including Friday). ≤ 18h in a school week. ≤ 8h on a non-school day. ≤ 40h in a non-school week. Between 7am and 7pm (until **9pm June 1 to Labor Day**) ([DOL eLaws](https://webapps.dol.gov/elaws/whd/flsa/cl/e14.asp); [DOL short guide](https://www.dol.gov/agencies/whd/child-labor/short-guide-to-child-labor-non-ag)) | **14-year-olds can't lifeguard.** **15-year-olds** may lifeguard at traditional pools and water parks (not natural waters like lakes or beaches, and not elevated slide platforms) if certified by the Red Cross or a similar body. No mechanical or chemical rooms. Teaching swimming requires an instructor certification (for example WSI) ([29 CFR 570.34(l)](https://www.ecfr.gov/current/title-29/subtitle-B/chapter-V/subchapter-A/part-570/subpart-C/section-570.34); [DOL FS #60](https://dol.gov/agencies/whd/fact-sheets/60-child-labor-lifeguards)) |
| **16 to 17** | No federal hour limits. Hazardous occupations are barred (for example motor vehicle driving, power-driven equipment) ([DOL eLaws 16-17](https://webapps.dol.gov/elaws/whd/flsa/cl/y16.asp)) | Many **states** impose hour, night and school-week limits and work permits for 16 to 17 (for example CA, NY, WA, MA). Use a per-state rules table. |

**Design:**
- Store `date_of_birth`, `state`, and an optional `school_calendar_id` (the school district where the minor lives sets "school hours").
- Compute age **on the shift date**, not today.
- Treat minor rules as hard constraints in the scheduler *and* in the cover/swap flow. A 15-year-old must not be able to claim a 6pm to 10pm cover in October.
- Track work-permit documents like certifications.
- **The scoring system must not reward minors for violating limits.** Never award points for a cover that should have been blocked. Also consider not penalizing minors for declining shifts that would exceed limits.

### 4.6 Clock-in rounding and early arrival
- **Federal (29 CFR 785.48):** time from voluntary early clock-ins with **no work performed** need not be paid. Rounding to the nearest 5, 6 or 15 minutes is allowed only if it's neutral and doesn't, over time, underpay employees ([eCFR via Cornell](https://www.law.cornell.edu/cfr/text/29/785.48); [Parker Poe](https://www.parkerpoe.com/news/2023/08/clocking-in-what-employers-need-to-watch-for)). A DOL opinion letter said rounding that only cuts early pre-shift *work* time is not neutral ([Perkins Coie](https://perkinscoie.com/insights/update/dol-opinion-letter-addresses-hospital-pre-shift-pay-practices-de-minimis-doctrine)).
- **California:** rounding meal periods is barred (*Donohue v. AMN*, 2021). *Camp v. Home Depot* (Ct. App. 2022) held that when exact time is captured, all of it must be paid. Review by the California Supreme Court was granted, so check the current status ([Proskauer](https://calemploymentlawupdate.proskauer.com/2022/10/california-court-of-appeal-dismantles-rounding-where-accurate-timekeeping-records-exist/); [Husch Blackwell](https://www.huschblackwell.com/newsandinsights/no-well-rounded-timekeeping-why-california-employers-need-to-stop-rounding-now)).
- **Aquatics reality:** guards arriving early often *do* work. They do opening chemical checks, set up equipment, take water tests and attend pre-shift briefings. Pre-shift in-service training is compensable.

**Design recommendations:**
1. **Default to no rounding: pay exact punch-to-punch minutes.** This is the safest choice and simple in software. Offer neutral rounding only as an explicit opt-in, with a disclaimer and a periodic "rounding neutrality" report (sum of rounded vs actual minutes per employee).
2. **Separate "arrival" from "clock-in."** Record `arrived_at` (geofence/kiosk check-in, optional) separately from `clock_in_at`. Score early arrival from the arrival check-in. Pay from clock-in. Better still, **block clocking in more than X minutes early** unless a manager approves, and pay whatever is clocked.
3. **Keep the early-arrival reward small and capped**, as in the table above. Message it as "be ready on time," not "come in unpaid." Show a banner: "If you are doing any work, you must be clocked in." For minors, an early arrival must not push them past daily limits or time-of-day windows (for example clocking in at 6:45am when 7am is the limit).
4. Late/early metrics for the "clock-in vs shift start" dashboard should use **actual punch times**, not rounded times.

### 4.7 Other risks
- **Discrimination / disparate impact (Title VII, ADEA, state law):** parent reviews may encode bias about accent, race, gender or age. Run negative reviews through manager review. Periodically audit the score distribution by protected characteristics where data exists. Allow employees to dispute events.
- **Minors' data / privacy:** collect only what you need. Restrict who sees DOB and documents. Comply with state student/minor privacy rules. Don't make scores public to coworkers; show only "you were outbid."
- **Retaliation for protected activity** (complaints, workers' comp claims, union organizing under NLRA §7): never key penalties off these. Allow manager override and audit any manual negative adjustment.
- **Union environments:** a CBA's seniority clause may override score-based awarding. Support "seniority-only" as a ranking mode.
- **Public employers** (municipal pools): civil-service rules may apply, and score data may be subject to public records requests. Keep reason notes professional.

### 4.8 Design-around checklist
- [ ] Absence reason taxonomy with `protected: bool` per reason, configurable by jurisdiction: sick/safe, family care, FMLA, ADA/PWFA accommodation, jury/witness, voting, military, school activity (minors), bereavement (some states), domestic violence leave.
- [ ] The employee picks the reason when releasing a shift. **No medical documentation is required in the app** (many sick-leave laws limit documentation requests, for example to absences of 3+ days). The manager can reclassify, with an audit log.
- [ ] Protected reason → a 0-point neutral event, which can never turn negative. A *system-level invariant* test enforces this.
- [ ] Sick-leave balance check: if the reason is "sick" and the jurisdiction protects it, the event is neutral, at least up to the statutory accrued amount.
- [ ] Manager override and **employee dispute** button on every event. Disputed events are frozen at 0 until resolved.
- [ ] Score is advisory for awarding contested shifts only. No auto-discipline or auto-termination.
- [ ] Per-jurisdiction rule packs: minor limits, sick-leave protection, fair workweek.
- [ ] Policy text generator: a plain-English handbook paragraph describing the scoring, so employers disclose it.
- [ ] "Explain my score" page and a data export for the employee.

---

## 5. Certification tracking

### 5.1 Common aquatics certifications and typical validity

| Certification | Issuer | Typical validity | Notes |
|---|---|---|---|
| Lifeguarding (incl. CPR/AED for Professional Rescuers + First Aid) | American Red Cross | **2 years** | Recert ("review") course is allowed if current or expired ≤ 30 days. Otherwise the full course is needed. Digital certificates are verifiable via the Red Cross Learning Center (ID/QR) ([Red Cross](https://redcross.org/take-a-class/lifeguarding/lifeguard-training/lifeguard-certification); [South Alabama](https://southalabama.edu/departments/campusrec/aquatics/lifeguard.html); [U-Mich](https://sessions.studentlife.umich.edu/track/event/session/88046)) |
| CPR/AED for Professional Rescuers | American Red Cross | 2 years | Often bundled with Lifeguarding but may carry its own date. Track it separately. |
| First Aid | American Red Cross | 2 years | |
| Water Safety Instructor (WSI) | American Red Cross | **2 years**, with minimum teaching requirements | Instructors recertify via an online course plus teaching minimums ([Purdue](https://www.purdue.edu/recwell/sports-and-programs/aquatics/safety-training/aquatic-safety/instructor-training.php); [Red Cross instructors](https://www.redcross.org/take-a-class/instructors)) |
| Lifeguarding Instructor (LGI) | American Red Cross | 2 years | Can recertify up to 1 year after expiry but cannot teach while expired. |
| International Lifeguard Training Program (ILTP) | Ellis & Associates | **1 year**, plus ongoing in-service and audits | Facility-specific licenses are not accepted elsewhere ([MA DCR accepted certs](https://www.mass.gov/doc/dcr-accepted-certifications/download); [Ellis ILTP](https://jellis.com/node/1882)) |
| YMCA Lifeguard | YMCA of the USA | About 2 years (verify) | An Oregon table lists 2 yrs ([Oregon OHA](https://www.oregon.gov/oha/ph/HealthyEnvironments/Recreation/PoolsLodging/Documents/poollifeguards.pdf)) |
| StarGuard ELITE (SGE), USLA (open water), NASM etc. | Various | 1 to 2 years | Make the cert catalog data-driven. |
| Certified Pool Operator (CPO) / AFO | PHTA / NRPA | 5 years (CPO), verify | Needed for chemical/mechanical work. Minors under 16 are barred from those rooms anyway. |
| Background check / child-safeguarding training (for example SafeSport-style, Praesidium) | Org / vendor | 1 to 2 years | Strongly recommended for swim-lesson staff working with kids. |
| Minor work permit / age certificate | State | Per state or school year | Treat it like a cert. |

**Important:** state and local health codes decide which certifications are accepted and may differ from issuer validity. The Oregon table, for example, listed an older 3-year figure for ARC. Make validity periods **organization-configurable defaults**, and always store the **actual expiration date printed on the card**.

### 5.2 Notification cadence (default; configurable)

| When | Who | Channel |
|---|---|---|
| 90 days before expiry | Employee | In-app + email ("Plan your recert; classes fill up") |
| 60 days | Employee + manager | In-app + email. Include links to recert classes. |
| 30 days | Employee + manager | Email + push/SMS. Scheduler starts showing a warning icon on future shifts past the expiry date. |
| 14 days | Employee + manager | Daily digest for the manager |
| 7 days | Employee + manager + admin | Push/SMS. **Future shifts after the expiry date are auto-flagged** and offered to the open-shift marketplace if not renewed. |
| Day 0 (expired) | All | **Hard block** for roles that require the cert. Existing assignments after the expiry date are unassigned or flagged for the manager. The employee is notified. |
| Recert grace window (for example ARC 30 days) | Employee | "You can still take the shorter review course until X." This is a *training* grace, **not** a work grace. They still can't guard. |

Also: a **weekly manager digest** of everything expiring in the next 60 days, and a **coverage risk forecast**, for example "On Jul 1 you will have only 3 guards with valid certs for 4 required slots."

### 5.3 Document upload and verification
- Upload a photo/PDF of the card. Optional OCR pre-fills the issuer, cert ID and dates. Require **manager verification** (status `pending → verified/rejected`) before the cert counts.
- Store the cert ID and issuer verification URL. The Red Cross supports online lookup by certificate ID/QR code, so store the link for one-click verification.
- Keep the history of all versions. Never overwrite. Also track **in-service training hours** (E&A and many facilities require monthly in-services) and **skills audits** as cert-like records.
- Retention: keep records for at least the duration of employment plus the state's statute of limitations (often 3 to 7 years). Pool incident litigation often asks for cert proof as of the incident date.
- Access control: certs are visible to the employee and their managers. Strip EXIF/GPS from uploaded photos.

### 5.4 Auto-blocking rules
- `role_requirement(role, cert_type, required: bool, min_age, must_be_valid_through: 'shift_end')`. A role can require **all of** a set (for example Lifeguard AND CPR-PR AND First Aid) or **any of** a set (ARC Lifeguarding OR E&A ILTP OR YMCA).
- Check validity **on the shift date** and at **clock-in time**. Optionally block clock-in for a role whose cert has expired, while allowing clock-in to a non-guard role such as front desk.
- Pending (unverified) uploads don't count unless the org enables "provisional for 7 days."
- Managers can override only for non-safety roles. Life-safety roles allow no override. If an override exists anyway, it requires a reason and admin role, and is logged.

---

## 6. Data model

Relational (PostgreSQL recommended: `tstzrange` plus exclusion constraints prevent overlaps, and JSONB holds rule configs). Every table gets `id`, `org_id`, `created_at`, `updated_at`. Multi-tenant via `org_id`.

```text
organization(id, name, timezone, jurisdiction_state, jurisdiction_city, settings_json)
location(id, org_id, name, address, timezone)                       -- facility
zone(id, location_id, name, type[pool|deep_end|slide|lesson_lane|front_desk], required_guards_default)

employee(id, org_id, user_id, first_name, last_name, date_of_birth, hire_date,
         state_of_residence, school_calendar_id NULL, status[active|leave|inactive],
         desired_hours_min, desired_hours_max, max_hours_week, union_seniority_date NULL)
role(id, org_id, name, is_life_safety bool, min_age)                 -- Lifeguard, Head Guard, WSI, Front Desk
employee_role(employee_id, role_id, pay_rate, primary bool)

-- Certifications
cert_type(id, org_id NULL(global), name, issuer, default_validity_months, recert_grace_days, verify_url_template)
role_cert_requirement(role_id, cert_group_id)                         -- AND across groups
cert_group(id, name) ; cert_group_member(cert_group_id, cert_type_id)  -- OR within a group
employee_cert(id, employee_id, cert_type_id, cert_number, issued_on, expires_on,
              status[pending|verified|rejected|expired|revoked], verified_by, verified_at,
              document_id, superseded_by NULL)
document(id, org_id, owner_employee_id, storage_key, mime, sha256, uploaded_by, uploaded_at)
cert_notification(id, employee_cert_id, threshold_days, sent_at, channel)  -- idempotent sends

-- Availability and time off
availability_rule(id, employee_id, weekday, start_time, end_time, kind[available|preferred|unavailable],
                  effective_from, effective_to)
availability_exception(id, employee_id, date, start_time NULL, end_time NULL, kind)
time_off_request(id, employee_id, period tstzrange, reason_code, status, decided_by)

-- Schedule
schedule_period(id, location_id, starts_on, ends_on, status[draft|bidding|built|published|locked],
                bid_open_at, bid_close_at, published_at, run_seed)
shift(id, location_id, zone_id NULL, role_id, period tstzrange, required_headcount,
      schedule_period_id, is_premium bool, notes)
shift_assignment(id, shift_id, employee_id, status[assigned|released|covered|no_show|completed],
                 source[auto|manager|open_shift|swap|cover], created_by, override_reason NULL)
  -- EXCLUDE USING gist (employee_id WITH =, period WITH &&) via denormalized period column

-- Bidding
shift_bid(id, schedule_period_id, employee_id, shift_id, rank int, created_at)
award_decision(id, schedule_period_id, shift_id, winner_employee_id, algorithm_version,
               winner_key_json, runners_up_json, explanation_text)   -- powers "why didn't I get it"

-- Coverage marketplace / swaps
coverage_request(id, shift_assignment_id, requested_by, type[give_away|swap|open_shift],
                 reason_code, reason_protected bool, notice_hours numeric,
                 initiated_by[employee|employer], status[open|claimed|approved|denied|cancelled|expired],
                 claimed_by NULL, swap_shift_assignment_id NULL, approved_by NULL, decided_at)
absence_reason(code, org_id, label, protected bool, requires_manager_review bool, jurisdiction NULL)

-- Time and attendance
punch(id, employee_id, shift_assignment_id NULL, kind[in|out|break_start|break_end],
      at timestamptz, source[kiosk|mobile|web|manager], geo_ok bool NULL, device_id,
      edited_from_punch_id NULL, edit_reason NULL)
arrival_checkin(id, employee_id, shift_assignment_id, at, source)   -- optional, separate from paid time
attendance_metric(shift_assignment_id, minutes_early_late int, classification[early_bonus|on_time|grace|late_minor|late_major|no_show])

-- Scoring
score_rule(id, org_id, event_type, points, cap_points, cap_window_days, active_from, active_to)
score_config(org_id, base, floor, ceiling, half_life_days, cutoff_days, decay_mode[exponential|rolling], freeze_on_protected_leave bool)
score_event(id, employee_id, event_type, occurred_at, points_raw, points_awarded, capped bool,
            source_table, source_id, reason_code, protected bool, status[active|disputed|voided],
            created_by[system|user_id], note, voided_by NULL, void_reason NULL)
score_dispute(id, score_event_id, employee_id, message, status, resolved_by, resolution_note)
score_snapshot(employee_id, as_of_date, score, breakdown_json)       -- nightly cache for fast ranking and sparkline

-- Feedback (detailed by the forms agent)
lesson(id, location_id, shift_id, instructor_employee_id, ...)
parent_feedback(id, lesson_id, instructor_employee_id, rating, comment, verified bool, reviewed_by NULL, status)

-- Compliance packs
minor_rule(id, jurisdiction, min_age, max_age, school_day_max_hours, school_week_max_hours,
           nonschool_day_max_hours, nonschool_week_max_hours, earliest_start, latest_end,
           summer_latest_end, summer_from, summer_to, permit_required bool)
audit_log(id, org_id, actor, action, entity, entity_id, before_json, after_json, at)
```

**Key invariants (enforce in code and tests):**
1. `score_event.protected = true` ⇒ `points_awarded >= 0`.
2. A shift assignment for a role with requirements exists only if the employee has a verified cert in each required group with `expires_on >= shift end date`. Re-validate nightly and on every cert change.
3. Minor rules are evaluated over the *cumulative* day/week including the candidate shift.
4. Score is derived only from `score_event` rows. `score_snapshot` is a cache that can be rebuilt.
5. Every manager override of a hard rule writes to `audit_log` with a reason.

---

## 7. Open questions for the product owner
1. Which states/cities will the first customers be in? This decides which rule packs to build first.
2. Should the score be visible to the employee only, or as a tier label (A/B/C) instead of a number? Tiers reduce anxiety and gaming.
3. Does the org want the score to influence *anything* besides contested shift awards? Recommendation: no.
4. Union or public-sector customers? If so, add a seniority-only ranking mode.
5. Geofenced mobile punches vs kiosk only? Kiosk is more reliable for arrival and early/late metrics.
