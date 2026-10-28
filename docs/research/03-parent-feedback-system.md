# 03 — Parent Feedback System (Swim Lessons -> Instructor Score)

*Research date: 2026-10-21. Scope: collecting parent feedback after lessons, getting it delivered, turning it into a fair score for shift bidding, the ethics and legal side, and how to build it. The scheduling/scoring engine itself is covered in a separate report. This one only defines the **feedback component** that feeds it.*

> **Not legal advice.** The legal sections summarize public sources so you can spot the issues. Before you use ratings in pay, firing or scheduling decisions, have an employment lawyer check your state's rules.

---

## TL;DR

1. **Off-the-shelf swim software has little built-in parent feedback.** Jackrabbit, iClassPro and similar tools focus on skill tracking and parent portals. I found no documented post-lesson survey feature, so schools mostly use Google Forms, SurveyMonkey or Jotform. This is a real gap the app can fill.
2. **Keep the form to 6 questions**, about 60 seconds. Rate four things the instructor controls (overall, child's progress, safety/attentiveness, communication). Add one facility NPS question, which is kept *out of* the instructor score. End with an optional comment. Anonymity applies to what staff see; the system still knows who the respondent is.
3. **Send it once per session block, not after every lesson.** Use email with a unique single-use token link. Send 2–24 h after the block's last class, with one reminder to non-responders at about 72 h. Put a QR code on the pool deck as a backup channel. Use SMS only with recorded opt-in.
4. **Deliverability:** SPF + DKIM + DMARC (p=none is enough to start) on your own domain. Brevo free (300/day) or Resend free (100/day, 3,000/mo) covers a small facility. SMS through Twilio is about $0.0083/segment plus carrier fees, plus 10DLC registration and monthly campaign fees.
5. **Scoring formula:** level-adjusted, outlier-clipped, time-decayed, Bayesian-shrunk average, with minimum-response gates. In the worked example below, a naive average ranks instructors wrongly. The formula fixes it.
6. **Feedback should be about 15–20% of an instructor's total score**, e.g. ±10 points next to roughly 40 attendance/reliability points. I recommend **bonus-only (0 to +10)** at launch. Negative signals go to coaching, not to automatic score cuts.
7. **Customer ratings are measurably biased** by gender and race (Hekman et al. 2010, Boring et al. 2016, MacNell et al. 2014). Using them in employment decisions creates **disparate-impact risk** under Title VII (Rosenblat et al. 2016; *Liu v. Uber*). Mitigations: manager review, staff can see their own feedback, an adverse-impact check, caps on weight, and no automatic penalties.
8. **COPPA mostly doesn't apply**, because parents (adults) fill out the forms. Still minimize the child's data, and build a retention policy (e.g. raw comments deleted after 24 months).
9. **Build it in the app.** Tokenized pages are simple, and the token-to-enrollment link is what makes scoring trustworthy. Use **Google Forms + Sheets** as an interim step with prefilled hidden-ish fields and an Apps Script webhook. Formbricks is the best open-source embed if you'd rather not build. Avoid OhMyForm (archived). Tally isn't open source.

---

## 1. How swim schools collect feedback today, and what they ask

### 1.1 What the platforms offer

| Tool | Feedback capability found | Notes |
|---|---|---|
| **Jackrabbit Class / Jackrabbit Swim** | No dedicated survey feature found. Strong on **skills tracking** pushed to parents through the Parent Portal, plus staff-to-parent email. | Capterra reviewers rate Skills Tracking 4.3 and call it useful but cumbersome to enter ([Capterra](https://www.capterra.com/p/172589/Jackrabbit-Swim/); [Jackrabbit blog](https://www.jackrabbitclass.com/?p=12606)). |
| **iClassPro** | No survey feature documented in search results. | Parent portal, skills, and communications ([Capterra reviews](https://capterra.com/p/127097/iClassPro/reviews/)). |
| **Swim Manager / SwimTopia / Commit / iSplash / SimplySwim** | Parent portals, messaging and progress tracking. No survey module found. | ([Commit](https://www.commitswimming.com/solutions/for-parents), [SimplySwim](https://www.getapp.com/education-childcare-software/a/simplyswim/)) |
| **Daxko / ActiveNet** | No participant post-program survey feature documented. Daxko's *own* customer program uses one question plus a comment, quarterly, with staff calling respondents back to "close the loop". That's a useful model. | ([Daxko: Our Customer Survey Philosophy](https://www.daxko.com/insights/our-customer-survey-philosophy); [Following Up on Feedback](https://www.daxko.com/insights/following-up-on-feedback)) |
| **Google Forms / SurveyMonkey / Jotform / Typeform** | What facilities actually use. City and county rec departments publish standalone parent evaluation forms. | Examples: [Torrance CA Plunge lesson survey](https://www.torranceca.gov/services/recreation-services/aquatics/classes-and-programs/h2o-eggstravaganza-survey), [Tuolumne County swim lesson parent evaluation](https://tuolumnecounty.ca.gov/FormCenter/Parks-and-Recreation-10/Swimming-Lesson-Parent-Evaluation-Form-64), [Jotform swim lesson survey](https://form.jotform.com/240366460606151), [SurveyMonkey example](https://www.surveymonkey.com/r/2XW3NKD). |

**Takeaway:** none of the platforms I found link feedback to a specific instructor-session-enrollment record. That linkage is what makes a feedback score usable for scheduling, and it's the main reason to build this in the app. (Caveat: vendor feature lists change. I found no *documentation* of such features, which isn't proof they don't exist.)

### 1.2 Common question themes in existing swim-lesson surveys

From the public forms above and the [GWR YMCA Swim Lesson Impact Report](https://gwrymca.org/sites/default/files/2019%20Swim%20Lesson%20Impact%20Report.pdf):

- Instructor knowledge and how they present the stage/level skills; whether they're prepared and on time (Jotform)
- Staff professionalism, preparation and customer service (Torrance)
- A separate instructor-evaluation block (Tuolumne)
- Child's progress / skill gains, and whether the child had fun and felt safe
- Facility: cleanliness, water temperature, scheduling, registration
- Parent-requested themes: **instructor consistency** and **better communication** (YMCA report)
- A 0–10 "likelihood to recommend" (NPS) question ([SurveyMonkey example](https://www.surveymonkey.com/r/VHX23DG))

### 1.3 Recommended form (6 questions plus 2 options, about 60 seconds)

Design principles:
- Rate only what the **instructor controls**. Keep facility items (water temperature, parking, price) out of the instructor score, so instructors aren't penalized for a cold pool.
- Use **behaviorally anchored** wording, e.g. "kept my child within arm's reach / attentive". Vague "overall satisfaction" items are where bias creeps in most; see Section 4.
- Use 1–5 stars with labeled ends, and allow "N/A / didn't observe" on the observation items.
- Show the instructor's first name and photo on the form so parents rate the *right* person. Substitutes and co-teaching cause many misattributed ratings.

**Header (prefilled from the token, read-only):** "Feedback for *Level 3 – Tue/Thu 4:30 pm, Session Fall A* with *Instructor: Maya*". There's also a checkbox, "This wasn't my child's instructor / we had a substitute". If checked, the ratings go to manager triage instead of Maya's score.

| # | Question | Type | Used in instructor score? |
|---|---|---|---|
| 1 | **How would you rate Maya as your child's instructor overall?** | 1–5 stars | Yes |
| 2 | **My child made progress on their swim skills this session.** | 1–5 (Strongly disagree to Strongly agree) | Yes, level-adjusted |
| 3 | **Maya kept the class safe and paid close attention to my child in the water.** | 1–5, plus "couldn't observe" | Yes. Also a *safety flag*: any rating of 1–2 alerts the aquatics manager regardless of score logic. |
| 4 | **Maya communicated clearly with me / my child** (what was worked on, what to practice, how they did). | 1–5, plus "N/A" | Yes |
| 5 | **How likely are you to recommend [Facility] swim lessons to a friend?** | 0–10 (NPS) | **No.** Facility KPI only. NPS = %9–10 minus %0–6, range −100 to +100 ([NPS calculation](https://smallbiztrends.com/nps-score-calculation/)). |
| 6 | **Anything you'd like to share: what went well, or what could be better?** | Free text (optional, ~1,000 char) | Not scored directly. Goes through manager review (Section 4.3). |
| opt | **Share my comment with Maya:** ( ) with my name  ( ) anonymously (default)  ( ) don't share, manager only | Radio | Controls *staff visibility*, not inclusion in the score |
| opt | "I'd like someone to contact me about this." | Checkbox | Routes to the manager's queue. Closes the loop the way Daxko does. |

**On "anonymous":** offer **confidential-to-staff** anonymity, not true anonymity. The token still ties the response to the enrollment. That's what blocks ballot-stuffing and lets you weight one response per family. Say so plainly on the form: *"Your name is never shown to the instructor unless you choose to share it. Managers can see who submitted feedback so we can follow up and prevent duplicate responses."* Truly anonymous channels (the pool-deck QR without a token) should be accepted but **don't feed the score** (Section 2.3).

Optional add-on, every 2nd or 3rd session only: "Which day/time works best for next session?" This doubles as demand data for scheduling.

---

## 2. Distribution

### 2.1 When to send

- **Per session block, not per lesson.** Swim lessons are usually 4–10-class sessions. Surveying after every class trains parents to ignore you and inflates complaint rates. Trigger it when the **last class of the session** ends, or at the midpoint and end for long sessions (8+ weeks).
- **Send 2–24 hours after the final class**, inside the parent's quiet window (e.g. 6–8 pm the same day, or 9 am the next day). Fresher is better: in SurveyMonkey's data, up to **86% of responses arrive within 48 h** of an invite ([SurveyMonkey](https://uk.surveymonkey.com/curiosity/how-often-should-you-use-email-reminders/)). Event research says response rates fall the further you are from the event ([Explori](https://kb.explori.com/knowledge/5-top-tips-to-increase-your-post-event-survey-response-rates)).
- **One reminder, non-responders only, at about 48–72 h.** Send a second one at most, around day 6, then close the token at day 10–14. SurveyMonkey recommends 48–72 h and 1–2 reminders. Wikimedia advises reminding only people who haven't answered ([Wikimedia learning pattern](https://meta.wikimedia.org/wiki/Learning_patterns/Timing_and_tenaciousness_-_How_to_ensure_high_participation_rates_at_post-conference_surveys)).
- **Expected response rate:** 20–30% is realistic for a well-timed survey ([Explori](https://kb.explori.com/knowledge/5-top-tips-to-increase-your-post-event-survey-response-rates)). Plan the scoring thresholds around that. An instructor teaching 4 classes × 5 kids per session gets about 4–6 responses per session.
- **Throttle per family:** at most one survey email per family per 14 days, even with multiple kids or classes. Bundle the kids into one message with one link per child/instructor.

### 2.2 Unique tokens (the core mechanism)

One `feedback_invite` row per **(enrollment × session block × instructor)**:

```
feedback_invite(
  id, token_hash,          -- store SHA-256 of a 128-bit random token, never the raw token
  enrollment_id, child_id, guardian_id, class_section_id, session_id,
  instructor_id,           -- instructor of record (from the schedule; updated if subs > 50% of classes)
  sent_at, reminder_count, opened_at, submitted_at, expires_at,
  channel                  -- email | sms | qr | kiosk
)
```

- URL: `https://app.example.org/f/<token>`. No login. The token is single-use and expires (e.g. 14 days).
- Build the token with a CSPRNG (e.g. `crypto.randomBytes(16)` as base64url). Rate-limit the endpoint so tokens can't be guessed.
- Prefill everything from the token. The parent never types a name or picks an instructor, which kills misattribution and impersonation.
- Allow **editing until expiry** (same token), but count only the final submission.
- Don't put PII in the URL, only the opaque token.

### 2.3 QR codes on the pool deck

- **Generic QR (sign on the deck or front desk):** opens a form asking for the parent's email or phone. The system then **emails/texts a tokenized link** to the address on file. This turns an anonymous scan into a verified response without a login. A response submitted directly through a generic QR, with no verification, should be **stored and shown to managers but excluded from the score**. Otherwise anyone can stuff it.
- **Per-class QR (printed on the class's roster clipboard or a laminated card):** encodes `class_section_id`. It still needs verification against the roster before it counts.
- **End-of-session take-home card** with a QR code and short URL: good for parents who don't read email.

### 2.4 Email deliverability

- **Send from your own domain**, e.g. `feedback@yourswimschool.org`, never from a Gmail address.
- **SPF + DKIM + DMARC.** Google's and Yahoo's 2024 rules require all three for **bulk senders (>5,000/day to Gmail)**. A small facility is below that line, but the rules are now baseline good practice. At least one of SPF or DKIM must *align* with the From domain. A DMARC policy of `p=none` (monitoring) is enough to start. Yahoo wants DKIM keys of 1024 bits or more. Keep the **spam complaint rate under 0.3%** (target <0.1%). Microsoft (Outlook/Hotmail) began enforcing similar rules for 5,000+/day senders in May 2025 ([Bird: Gmail/Yahoo requirements](https://bird.com/docs/knowledge-base/deliverability/gmail-yahoo-requirements); [MessageGears](https://messagegears.com/resources/blog/google-yahoo-to-combat-spam-with-new-email-rules-for-senders/); [PowerDMARC 2026](https://powerdmarc.com/google-and-yahoo-email-authentication-requirements)).
- **One-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers):** required for marketing/subscribed mail, and opt-outs must be honored within 2 days. Transactional mail is exempt ([Bird](https://bird.com/explained/deliverability/what-are-the-gmail-and-yahoo-bulk-sender-requirements)). A survey invite sits in a gray zone. **Add the header anyway**, and give parents a "stop feedback requests" preference that's separate from operational emails (cancellations, pool closures).
- **CAN-SPAM:** a pure feedback request with no promotion is generally "transactional or relationship" content. Still include the facility's physical address and an opt-out. Don't add promos ("10% off next session!") to the survey email, or it becomes commercial.
- **Content hygiene:** plain, short, personal ("How did Maya do with Ava this session?"), one clear button, a text version, no link shorteners, and consistent sending times.

**Free and cheap sending options**

| Option | Free tier | Notes |
|---|---|---|
| **Brevo** | **300 emails/day** (~9k/mo), transactional API included; Starter from ~$9/mo removes the daily cap | Best free daily allowance ([Brevo pricing review](https://ecommerce-platforms.com/email-marketing-services-reviews/sendinblue-pricing); [dreamlit](https://dreamlit.ai/blog/brevo-review)) |
| **Resend** | **100/day, 3,000/mo** (counts received mail too); 1 domain (some sources say 3) | Great developer API/SDKs ([Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits); [Resend free tier](https://resend.com/blog/new-free-tier)) |
| **Amazon SES** | Pay-as-you-go, very cheap (cents per 1,000) | More setup; good if self-hosting on AWS (pricing not re-verified here) |
| **Self-hosted SMTP** (Postfix, Mailcow, etc.) | Free software | **Not recommended** for an open-source app's default. Residential and VPS IPs are often blocklisted and IP reputation is hard to maintain. Make it an option, with an SMTP relay as the default. |

**App design:** use a pluggable `EmailProvider` interface (SMTP, Brevo, Resend, SES) so each facility running the open-source app brings its own credentials.

### 2.5 SMS: compliance and cost

SMS gets much higher open rates, but carries **real legal exposure**. Make it opt-in and off by default.

- **TCPA:** texts to mobile numbers sent with an autodialer/platform need **prior express consent**. Marketing texts need **prior express *written* consent**. A post-lesson survey request with no promotion is generally treated as informational. Even so, collect a clear SMS opt-in checkbox at registration and keep the consent records (Foley recommends at least 4 years) ([Foley TCPA checklist](https://foley.com/-/media/5a031499fb77473c83e8bb3ba43df687.ashx)). The FCC's stricter "one-to-one consent" rule was **vacated by the 11th Circuit on Jan 24, 2025** ([Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/eleventh-circuit-vacates-tcpa-11-consent-rule); [MoFo](https://mofo.com/resources/insights/250130-eleventh-circuit-vacates-fcc-s-tcpa-one-to-one-consent-rule)).
- **Quiet hours:** federal TCPA says no texts 9 pm–8 am recipient-local. **State "mini-TCPAs"** (Florida, Oklahoma, Maryland and others) are stricter: **8 am–8 pm**, at most **3 messages per 24 h**, and sender identification required ([Klaviyo: mini-TCPA](https://www.klaviyo.com/glossary/what-is-mini-tcpa); [Yotpo](https://support.yotpo.com/docs/complying-with-us-sms-marketing-regulations)). **Simplest rule for the app:** send SMS only 10 am–7 pm local, at most one survey text plus one reminder per session.
- **CTIA best practice:** identify the sender in every message and support **STOP / HELP** keywords ([Telebroad CTIA summary](https://helpdesk.telebroad.com/support/solutions/articles/4000188137-ctia-messaging-principles-and-best-practices)). Twilio and similar providers handle STOP automatically. Mirror the opt-outs into your DB.
- **10DLC registration** (required for business texting from local numbers in the US): brand registration costs about **$4.50** (sole prop/low-volume) to **$46** (standard brand incl. secondary vetting), one-time. Campaign vetting is about **$15** one-time. Monthly campaign fees are about **$1.50–$10/mo** depending on use case, with lower rates for charity/501(c)(3) ([Twilio support: 10DLC fees](https://support.twilio.com/hc/en-us/articles/1260803965530); [Twilio brand registration docs](https://static0.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand.md); [Sociocs](https://www.sociocs.com/post/twilio-10dlc-explained/)). Many municipal rec departments and nonprofits (YMCAs) qualify for nonprofit/government campaign types. **Toll-free verification** is an alternative to 10DLC that's often simpler for low volume.
- **Twilio cost:** **$0.0083 per outbound US SMS segment** (Twilio's page, Aug 2026), plus carrier pass-through fees of roughly $0.003–0.005/segment, plus a number at about $1.15/mo ([Twilio US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us); [Telnyx comparison](https://telnyx.com/resources/twilio-telnyx-sms-pricing)).
  - *Example:* 400 families/session × 2 texts × about $0.012 = **about $10/session**, plus about $1.15–$12/mo in fixed fees. Cheap, but not free, and the registration work is the real cost.
- **Recommendation:** email first. SMS is an optional plugin (Twilio/Telnyx/etc.) the facility enables after doing 10DLC or toll-free verification. Keep the message short and 160-char/GSM-7 safe: `KeaS Swim: How did Maya do with Ava this session? 1-min feedback: https://ks.example/f/x7Q2 Reply STOP to opt out`.

---

## 3. Turning feedback into a fair score

### 3.1 Problems to solve

| Problem | Why it matters | Mitigation |
|---|---|---|
| **Small samples** | 3 five-star reviews shouldn't beat 40 reviews averaging 4.8 | Bayesian average (shrink toward the facility mean) plus a minimum-response gate |
| **Harsh/lenient raters** | Some parents give everyone 3s, others give all 5s | Optional rater-leniency adjustment once a parent has rated 3+ instructors. Otherwise rely on shrinkage. |
| **Tougher class levels** | Toddler/parent-tot classes get glowing reviews. Level 4–5 stroke classes (more correction, slower visible progress) and adaptive or fearful-swimmer classes score lower. | Normalize by **class level baseline** |
| **One angry parent** | One 1-star can sink an instructor with few reviews | Clip how far any single response can sit below the mean, route extreme lows to manager review, cap per-family weight |
| **Review bombing / collusion** | Friends of a disgruntled parent, or an instructor's friends stuffing 5s | Only **token-verified, enrolled** responses count, one per enrollment per session, with anomaly flags (burst of responses, identical text) |
| **Staleness** | Feedback from 2 years ago shouldn't define someone | Time decay (half-life) |
| **Misattribution** | Parent rates the sub, or the facility, not the instructor | Instructor photo on the form, "this wasn't our instructor" checkbox, facility questions kept separate |
| **Demographic bias in ratings** | See Section 4 | Low weight, bonus-only, adverse-impact monitoring |

### 3.2 Methods from the literature/industry

- **Bayesian average (IMDb-style weighted rating):** `WR = (v/(v+m))·R + (m/(v+m))·C`, where *v* = number of ratings, *R* = item mean, *m* = prior weight / minimum votes, *C* = overall mean. With few votes the score sits near the overall mean, and as votes accumulate it approaches the item's own mean ([IMDb help](https://help.imdb.com/article/imdb/track-movies-tv/weighted-average-ratings/GWT2DSBYVT2F25SK); [explainer](https://neurobiology.substack.com/p/how-imdb-determines-top-250_27)). This is the standard conjugate-prior shrinkage estimator.
- **Wilson score lower bound** (for thumbs-up/down data): ranks by "the fraction positive is *at least* X with 95% confidence". It's more conservative with small *n* ([Evan Miller, "How Not To Sort By Average Rating"](https://evanmiller.org/how-not-to-sort-by-average-rating.html)). A Beta-prior alternative is described [here](https://www.greaterwrong.com/posts/SnSYB8CFpjESfRuCm/how-not-to-sort-by-a-complicated-frequentist-formula). Wilson fits binary data. For 1–5 stars, a Bayesian average is simpler and more interpretable. Nicereply (a CSAT tool) uses a similar small-sample-aware formula for agent rankings ([Nicereply agent ranking](https://support.nicereply.com/article/117-agent-ranking-formula)).
- **Rater normalization:** standard practice in peer review and grading is to z-score each rater, or subtract the rater's mean offset. It only works if a rater has rated several people, which is often not the case for a parent with one child and one instructor. So make it optional, and shrink each parent's offset.
- **Outlier handling:** winsorize (cap) individual ratings, or use a robust M-estimator. For transparency, capping is easier to explain to staff.
- **Time decay:** an exponential half-life weight `w = 0.5^(age/H)`.

### 3.3 Proposed formula ("Feedback Score", FS)

All rating items are 1–5. For each **eligible** response *i* (token-verified, submitted, not excluded by manager review, not marked "wrong instructor"):

1. **Response rating** `r_i` = mean of the answered instructor items Q1–Q4 (skip N/A).
   *(Option: weight Q1 a bit higher, e.g. 0.4/0.2/0.2/0.2.)*
2. **Level adjustment:** `a_i = r_i − L(level_i) + G`
   - `G` = facility-wide mean of `r` over the trailing 12 months (e.g. 4.60)
   - `L(level)` = trailing-12-month mean of `r` for that class level/program across *all* instructors, itself shrunk toward G with m=20 so rare levels don't swing.
   - Effect: an instructor isn't punished for teaching Level 5 or adaptive classes, and isn't rewarded just for teaching parent-tot.
3. **Optional rater-leniency adjustment** (only if the parent has 3+ rated instructors historically): `a_i −= k·(parent_mean_offset)` with `k = n_p/(n_p+3)`.
4. **Clip single-response influence:** `c_i = clamp(a_i, G − 1.5, G + 1.5)`.
   Any raw `r_i ≤ 2` **or** Q3 (safety) ≤ 2 also creates a **manager-review task**. The response counts *after* review if the manager confirms it's genuine and attributable. It's excluded if it's misattributed or about something outside the instructor's control.
5. **Time decay:** `w_i = 0.5^(age_days_i / 180)` (6-month half-life).
   **Per-family cap:** if one guardian submits for multiple children with the same instructor in the same session, divide those weights by the number of children, so the total weight per family-instructor-session is 1.
6. **Bayesian shrinkage:**
   `FS = (m·G + Σ w_i·c_i) / (m + Σ w_i)` with **m = 8** (prior worth about 8 fresh responses).
7. **Gates (no points until met):** at least **5 eligible responses from 3+ distinct families** within the trailing 12 months. Below that, the instructor gets **0 feedback points** (neutral). The FS is still shown to managers as "provisional".
8. **Convert to points:**
   `z = clamp((FS − G) / 0.4, −1, +1)`. ±0.4 stars from the facility mean saturates the scale. Tune this to the observed spread, e.g. 2× the standard deviation of instructor FS values.
   - **Bonus-only mode (recommended at launch):** `FeedbackPts = 10 · max(0, z)` gives 0 to +10.
   - **Symmetric mode (later, after a bias audit):** `FeedbackPts = 10 · z` gives −10 to +10.
9. **Recompute** nightly or when a session closes. Store a snapshot of the inputs for each score so it's auditable and explainable to the instructor.

### 3.4 Worked example

Facility mean **G = 4.60**, m = 8, half-life 180 days, clip ±1.5. (I computed these numbers with a script. They're reproducible.)

**Instructor A teaches Level 5 (stroke development), level baseline L = 4.40**, so +0.20 is added to each response.

| Raw r | Adjusted a = r − 4.40 + 4.60 | Clipped c | Age (days) | Weight w |
|---|---|---|---|---|
| 5.00 | 5.20 | 5.20 | 10 | 0.962 |
| 4.75 | 4.95 | 4.95 | 20 | 0.926 |
| 4.50 | 4.70 | 4.70 | 35 | 0.874 |
| 5.00 | 5.20 | 5.20 | 40 | 0.857 |
| 4.00 | 4.20 | 4.20 | 60 | 0.794 |
| 4.75 | 4.95 | 4.95 | 90 | 0.707 |
| **1.50** (angry parent, reviewed and kept) | 1.70 | **3.10** | 15 | 0.944 |
| 4.50 | 4.70 | 4.70 | 120 | 0.630 |

Σw = 6.694, Σw·c = 30.872, so FS = (8·4.60 + 30.872)/(8 + 6.694) = **4.605**. z ≈ 0.01, which gives **≈ +0.1 points** (neutral).
- Naive average = **4.25**, which would have looked like the worst instructor at the facility.
- Without the clip, FS would be about 4.515 (z = −0.21). One parent would cost a Level 5 instructor about 2 points in symmetric mode.

**Instructor B teaches parent-tot (L = 4.75): three 5-star reviews.**
Adjusted 4.85 each, Σw = 2.862, FS = **4.666** (z = +0.17). **But 3 responses < 5, so 0 points (provisional).** A naive average of 5.00 would have put B at the top.

**Instructor C teaches Level 3 (L = 4.60 = G): 20 responses, raw average 4.275, spread over 10 months.**
Σw = 12.205, FS = **4.407**, z = −0.48. **Bonus-only: 0 points. Symmetric: −4.8 points.** C is consistently below peers on a large sample. This is a *real* signal, and it should trigger a **coaching conversation** where the manager reads C's comments, not an automatic penalty.

**Ranking by naive average:** B (5.00) > C (4.275) > A (4.25).
**Ranking by FS:** B (provisional) ≈ A > C. This matches intuition once level difficulty and the one outlier are accounted for.

### 3.5 How much should feedback count compared with attendance?

- Feedback is **noisier and more bias-prone** than objective measures (attendance, punctuality, shift-swap reliability, certifications current). It should be a **minority** of the score.
- **Recommendation:** feedback ≤ **15–20%** of the total bid-priority score. Example: attendance/reliability up to 40 pts, seniority/certifications per the scheduling report, **feedback up to 10 pts**.
- Use **bonus-only (0 to +10)** for the first 2–3 sessions while you collect data and run the adverse-impact check (4.4). Move to symmetric only if the audit is clean and staff have been consulted.
- **Hard rule:** no automatic disciplinary or firing consequence from FS. Safety flags go to humans immediately.
- Show each instructor *why* their points are what they are: n responses, FS, level adjustment applied, approved comments.

### 3.6 Anti-gaming checklist

- Only enrollments with ≥50% attendance in the session get an invite (parents of a no-show can't rate).
- One active token per enrollment-session-instructor. Invalidate it on submit, and allow edits until expiry.
- Flag bursts (more than X responses for one instructor within an hour), near-identical comments, or many submissions from one IP/device.
- Instructors can't see raw responses in real time or know who responded, which prevents pressuring parents. Feedback is released to staff when the session closes, aggregated.
- Prohibit staff from soliciting ratings with incentives ("give me 5 stars"). Put this in the staff handbook.

---

## 4. Ethics and legal

### 4.1 Customer ratings carry demographic bias

- **Hekman et al. (2010), *Academy of Management Journal*:** in a lab study with identical scripted videos, viewers rated a white male clerk's service **19% higher** than the same script performed by a Black man or a white woman. Across 10,000+ patient ratings of HMO physicians, the same behaviors earned higher satisfaction scores only for white male doctors. The authors attribute the bias to ratings being "anonymous judgments by untrained raters" with no evaluation standard ([paper PDF](https://leeds-faculty.colorado.edu/dahe7472/racefinal.pdf); [abstract](https://academicnewsletter.sufe.edu.cn/info/361557); [CustomerThink commentary](https://customerthink.com/?p=75837)).
- **Boring, Ottoboni & Stark (2016):** across 23,001 student evaluations at a French university plus a randomized US experiment, evaluations were "more sensitive to students' gender bias and grade expectations than they are to teaching effectiveness". The bias even affected "objective" items like grading promptness ([ScienceOpen/DOAJ](https://doaj.org/article/f74e8e3f674646a9befb4961ee7b53b0); [AAUP](https://www.aaup.org/article/student-evaluations-teaching-are-not-valid)).
- **MacNell, Driscoll & Hunt (2014):** in an online course where instructors swapped gender identities, students rated the "male" identity higher. On promptness, with work returned at the same time, the scores were 4.35 vs 3.55 ([NC State news](https://news.ncsu.edu/2014/12/macnell-gender-2014); [paper](https://www2.math.upenn.edu/%7Epemantle/active-papers/Evals/macnell-driscoll-hunt.pdf)).
- **Relevance to swim lessons:** parents are untrained, anonymous raters with no standard, the exact conditions Hekman identifies. Likely bias axes also include **age** (teen instructors) and **accent/English fluency**, plus **disability**. Behaviorally anchored questions (Section 1.3) and level normalization help, but they don't eliminate this.

### 4.2 Legal risk: disparate impact

- **Title VII disparate impact:** a neutral practice that disproportionately disadvantages a protected group can be unlawful even without intent, unless it's job-related and consistent with business necessity. **Rosenblat, Levy, Barocas & Hwang, "Discriminating Tastes: Customer Ratings as Vehicles for Bias" (2016)** argues that an employer relying on biased customer ratings can produce disparate impact while avoiding disparate *treatment*. The bias gets "laundered" through customers ([Data & Society](https://datasociety.net/output/discriminating-tastes-customer-ratings-as-vehicles-for-bias/); [PDF](https://blogs.oii.ox.ac.uk/ipp-conference/sites/ipp/files/documents/Discriminating_Tastes_Customer_Ratings_as_Vehicles_for_Bias.pdf); [Cornell news](https://news.cornell.edu/node/286963)).
- **Litigation example:** *Liu v. Uber* (N.D. Cal., 3:20-cv-07499) brought a Title VII claim over Uber's use of star ratings to deactivate drivers. The intentional disparate-treatment theory was dismissed in July 2021, and the disparate-impact theory went forward ([docket](https://www.docketalarm.com/cases/California_Northern_District_Court/3--20-cv-07499/Liu_v._Uber_Technologies_Inc/57)).
- **EEOC Uniform Guidelines, "four-fifths rule":** if a group's selection/favorable-outcome rate is below 80% of the highest group's rate, that's evidence of adverse impact. It's a screening rule of thumb, and statistical significance tests are also used ([PrevueHR](https://www.prevuehr.com/resources/insights/adverse-impact-analysis-four-fifths-rule/); [EEOC AI guidance summary](https://littler.com/node/607951)). Shift-bid priority that decides who gets preferred or more hours is plausibly an "employment decision" (terms and conditions of employment).
- **Age:** many swim instructors are 15–22. The ADEA protects only those 40+, so a young-instructor bias isn't ADEA exposure. A bias *against* older instructors could be. Some states protect age more broadly.
- **Minors as employees:** teen instructors' feedback records are employment records of minors. Handle them with the same care as other personnel data.

### 4.3 Safeguards to build in

1. **Manager review before comments count.** Use a moderation queue for:
   - all free-text comments (approve as "share with instructor", "manager only", or "exclude: not about instructor / abusive / misattributed")
   - any response with r ≤ 2 or a safety item ≤ 2
   - anomaly-flagged responses

   Star ratings without flags auto-approve after N days (e.g. 7) so the queue doesn't block scoring. **Log every exclusion with a reason** for auditability, and don't let managers exclude *positive* reviews selectively. Exclusion criteria should be the same either way.
2. **Staff can see their own feedback:** aggregated scores, distribution, and approved comments (anonymized unless the parent opted to share their name), after the session closes. Add a **"request review / add context"** button. Transparency matters ethically, and several states give employees rights to inspect personnel files (e.g. CA Labor Code §1198.5; check your state).
3. **Adverse-impact monitoring:** if the facility collects voluntary self-ID for EEO purposes, run a quarterly report comparing average FeedbackPts and the share getting bonus points by gender, race/ethnicity and age band, applying the four-fifths test. Small facilities will have small n, so treat the results as a warning light, not proof. *Never* use demographics in the score itself.
4. **Weight caps and bonus-only** (Section 3.5) limit the damage of any residual bias.
5. **Human in the loop:** FS informs bid priority but can't alone cause discipline, termination or loss of hours. The scheduling report should let a manager override, with a reason logged.
6. **Tell staff and parents:** an instructor handbook section on how feedback is used, and a one-line note on the form ("Feedback helps us recognize great instructors and improve lessons").
7. **Union/CBA:** if instructors are unionized (common in municipal aquatics), using ratings in scheduling is likely a mandatory bargaining subject. Check before rollout.

### 4.4 Children's privacy

- **COPPA** applies to online services directed to children under 13, or with actual knowledge that they collect personal info **from** children under 13. The FTC's FAQ states COPPA applies to information collected **from children, not from their parents or other adults** ([archived FTC COPPA FAQ](https://webharvest.gov/peth04/20041022093947/http://www3.ftc.gov/privacy/coppafaqs.htm); [Paul Hastings summary of the revised FAQs](https://paulhastings.com/insights/caveat-vendor/blog-ftc-releases-second-set-of-coppa-faqs-here-are-some-highlights); [Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ftc-issues-updated-coppa-faqs)). A parent-completed form therefore generally isn't COPPA collection. **Don't** add "let your child rate their teacher" emoji screens unless you're prepared for COPPA (verifiable parental consent, etc.). Keep the form parent-only and say so: "This form is for parents/guardians."
  - The amended COPPA Rule (finalized 2025) tightened data retention and security expectations for covered operators. It isn't directly applicable here, but it's a good benchmark.
- **Data minimization:** the feedback record should reference `child_id` internally only. Don't ask for the child's age, medical info or photos in the form. Free text may contain health/disability details ("my son has autism…"). Restrict comment access to managers, and let them redact before sharing with instructors.
- **State consumer privacy laws:** CCPA/CPRA applies only to for-profit businesses with ≥$26.625M revenue (2025 inflation-adjusted), 100k+ CA consumers, or 50%+ revenue from selling/sharing data ([Clym](https://www.clym.io/blog/ccpa-applicability-guide); [Feroot](https://www.feroot.com/blog/ccpa-applicability-website-california-law/)). Most swim schools, nonprofits (YMCAs) and government rec departments fall outside CCPA and similar state laws (VA, CO, CT, TX etc. have comparable thresholds or exclude nonprofits/government). **But:** government facilities are subject to **public records laws**. Feedback naming staff could be disclosable, so check with the city attorney. Several states also have children's data or "age-appropriate design" laws aimed at services used by minors. Keeping the form parent-only largely avoids these.
- **Since the app is open source:** ship privacy-friendly defaults (self-hosted data, no third-party trackers on the form page, no analytics pixels in emails by default, configurable retention), so every deploying facility starts compliant.

### 4.5 Data retention (suggested defaults, configurable)

| Data | Retention |
|---|---|
| Unused/expired invite tokens | Purge hashes 30 days after expiry |
| Raw responses (ratings) | 24 months (scoring uses 12 months; the extra 12 cover disputes), then aggregate and delete |
| Free-text comments | 24 months, or shorter. Delete on parent request. |
| Comments flagged as safety incidents | Follow the facility's incident-report retention policy. These are no longer just "feedback". |
| Score snapshots (aggregates per instructor per session) | Keep with personnel records (often 3–7 years by state/employer policy) |
| SMS/email consent records | ≥ 4 years (TCPA statute-of-limitations practice) |
| Parent opt-out list | Indefinitely (needed to honor the opt-out) |

---

## 5. Implementation options

### 5.1 Comparison

| Criterion | **Build in-app (tokenized pages)** | **Formbricks** (self-host) | **LimeSurvey** (self-host) | **OhMyForm** | **Tally** (hosted) | **Google Forms + Sheets** |
|---|---|---|---|---|---|---|
| License | Yours (same as the app) | AGPLv3 core plus a commercial `/ee` folder. EE features need a license key. The Community Edition limit (e.g. 3 projects) has changed between doc versions ([Formbricks license docs](https://formbricks.com/docs/self-hosting/license); [GitHub](https://github.com/formbricks/formbricks)) | GPL. Mature (20+ yrs) | AGPL. **Archived / unmaintained** (main repo archived, last push 2024) ([ecosyste.ms](https://opencollective.ecosyste.ms/projects/16003)) | **Proprietary SaaS**. Generous free tier with hidden fields and webhooks ([Tally pricing](https://Tally.so/pricing)) | Proprietary, free |
| Per-enrollment tokens | Native | Single-use links / hidden fields (verify whether single-use is CE or EE) | Excellent: closed-access participant tables, unique tokens, invites, **reminders to non-completers only** ([LimeSurvey manual](https://manual.limesurvey.org/Tokens)) | Weak | Hidden fields via URL params. No true single-use. | Prefilled `entry.X` params only. Editable by the respondent. |
| Data into the scoring engine | Direct (same DB) | Webhooks/API | API (RemoteControl) / plugin | — | Webhooks | Apps Script webhook / Sheets API |
| Ops burden | Lowest (one app) | Extra Docker service plus Postgres | Extra PHP app plus DB | Don't | None, but third-party data custody | None |
| Mobile UX | You control it | Very good | Dated but OK | — | Very good | Good |
| Privacy (children/staff data) | Best: stays in your DB | Good (self-hosted) | Good (self-hosted) | — | Data at Tally (EU-based) | Data in Google |
| Fit for a 6-question form | Perfect | Overkill | Overkill | — | Fine | Fine |

([Formbricks vs LimeSurvey 2026](https://blog.elest.io/formbricks-vs-limesurvey-which-self-hosted-survey-tool-in-2026/); [OpnForm vs Tally](https://forms.grad.ttu.edu/opnform-vs-tally). OpnForm is another AGPL option if you want a Tally-like open-source builder.)

### 5.2 Recommendation: build it in-app

The form is small and fixed (6 questions). The value is in the **token-to-enrollment-to-instructor linkage**, moderation, and scoring, all of which live in the app anyway. An embedded survey tool adds a second service, a second auth/DB, and a webhook sync that can drift. A minimal build:

- **Tables:** `feedback_invite` (Section 2.2), `feedback_response` (invite_id, q1..q4, q3_na, nps, comment, share_mode, wrong_instructor, contact_me, submitted_at, ip_hash), `feedback_review` (response_id, reviewer_id, decision, reason, at), `feedback_score_snapshot` (instructor_id, as_of, n, n_families, FS, z, points, params_json).
- **Pages:** `/f/:token` (server-rendered, no JS required, accessible, mobile-first, ~30 KB). Thank-you page. `/f/qr/:section` for verified QR entry.
- **Jobs:** `on session close: create invites + send`, `reminder at +72h`, `expire at +14d`, `nightly: recompute FS`, `retention purge`.
- **Admin:** moderation queue, per-instructor dashboard, facility NPS, adverse-impact report, CSV export.
- **Integrations:** a pluggable `EmailProvider` (SMTP/Brevo/Resend/SES) and an optional `SmsProvider` (Twilio/Telnyx).
- **Escape hatch:** accept **inbound webhooks** in a generic JSON shape, so a facility that prefers Formbricks/Tally/LimeSurvey can still feed the scoring engine, as long as the invite token is passed as a hidden field.

Effort estimate: about 1–2 developer-weeks for the form, tokens, email and moderation, plus about 1 week for scoring, dashboards and tests.

### 5.3 Interim: Google Forms + Sheets ("the sheet")

Works today with no code in the app, and migrates cleanly later.

1. **Build the Form** with Q1–Q6 plus three short-answer fields at the top: `Invite code`, `Instructor`, `Class`. Put them in a first section titled "Lesson details (filled in for you — please don't change)".
2. **Generate prefilled links:** in the Form editor, use ⋮ → *Get pre-filled link*. Fill dummy values, then copy the URL to learn the `entry.NNNN` IDs ([Labnol](https://Labnol.org/prefilled-google-forms-200601); [Supademo](https://supademo.com/blog/how-to-prefill-answers-in-a-google-form)). Respondents *can* edit prefilled fields, and deleting/re-adding a question changes its ID ([Formester](https://formester.com/blog/google-form-auto-filler/)). Google Forms has no true hidden fields.
3. **Roster sheet** (exported from the app or the current registration system): `family_email, child, class, instructor, session, invite_code`. Here `invite_code` is a random 8–10-character string per row (`=LEFT(SUBSTITUTE(LOWER(BASE(RANDBETWEEN(…)…` or an Apps Script UUID). Build each link with `SUBSTITUTE`/`ENCODEURL` into the prefilled template.
4. **Send** with a Gmail mail-merge (Apps Script `MailApp`/`GmailApp`, or the free YAMM tier). Gmail consumer accounts are limited to about 100–500 recipients/day, so use the facility's Workspace account.
5. **Validate:** the response sheet joins on `invite_code`. Rows with a missing, unknown or duplicate code, or a code/instructor mismatch, are **excluded from scoring** (the "verification" step).
6. **Sync into the app later:** an installable **On form submit** trigger in Apps Script POSTs `e.response.getItemResponses()` as JSON via `UrlFetchApp` to `POST /api/feedback/import` (HMAC-signed shared secret). Use an *installable* trigger, because simple triggers can't call `UrlFetchApp`. Apps Script doesn't retry failed POSTs, so also run a nightly "re-send unsynced rows" function, or have the app pull via the Sheets API ([WebhookRelay guide](https://webhookrelay.com/blog/google-forms-webhook/); [Svix guide](https://www.svix.com/resources/guides/google-forms-webhook/); [Formester](https://formester.com/blog/google-forms-webhooks/)).
7. **Score in the sheet meanwhile:** the formula in 3.3 can be built with `SUMPRODUCT` over a filtered range. Keep it bonus-only and manager-reviewed.

Interim limitations: codes can be shared or edited, there's no automatic reminders-to-non-responders (you can script that by checking which codes are missing), the data lives in Google, and moderation is manual (a "Status" column). That's fine for a pilot of 1–2 sessions. Migrate to in-app once the shape is validated.

---

## 6. Open questions for the user / other agents

- **Scheduling engine agent:** confirm the total score scale so FeedbackPts (0 to +10 suggested) stays ≤ about 15–20% of the total, and confirm whether bid priority is the only use of FS.
- Is the facility municipal (public records, union), nonprofit (YMCA-type), or private? This changes the privacy-law and bargaining analysis.
- Will you collect voluntary EEO self-ID? Without it, the adverse-impact check in 4.3 isn't possible.
- Typical session length and class size, to tune `m`, the gates, and the half-life.
- Who moderates (aquatics coordinator? head instructor?), and how quickly reviews must be done.

---

## Sources

**Swim/rec software and forms**
- Jackrabbit skills tracking blog: https://www.jackrabbitclass.com/?p=12606
- Jackrabbit Swim on Capterra: https://www.capterra.com/p/172589/Jackrabbit-Swim/
- iClassPro reviews (Capterra): https://capterra.com/p/127097/iClassPro/reviews/
- Commit Swimming (parents): https://www.commitswimming.com/solutions/for-parents
- SimplySwim (GetApp): https://www.getapp.com/education-childcare-software/a/simplyswim/
- Daxko customer survey philosophy: https://www.daxko.com/insights/our-customer-survey-philosophy
- Daxko following up on feedback: https://www.daxko.com/insights/following-up-on-feedback
- Torrance CA Plunge lesson survey: https://www.torranceca.gov/services/recreation-services/aquatics/classes-and-programs/h2o-eggstravaganza-survey
- Tuolumne County swim lesson parent evaluation: https://tuolumnecounty.ca.gov/FormCenter/Parks-and-Recreation-10/Swimming-Lesson-Parent-Evaluation-Form-64
- Jotform swim lesson survey: https://form.jotform.com/240366460606151
- GWR YMCA 2019 Swim Lesson Impact Report: https://gwrymca.org/sites/default/files/2019%20Swim%20Lesson%20Impact%20Report.pdf
- SurveyMonkey examples: https://www.surveymonkey.com/r/2XW3NKD, https://www.surveymonkey.com/r/VHX23DG
- NPS calculation: https://smallbiztrends.com/nps-score-calculation/

**Distribution / deliverability / SMS**
- SurveyMonkey reminder timing: https://uk.surveymonkey.com/curiosity/how-often-should-you-use-email-reminders/
- Wikimedia survey timing learning pattern: https://meta.wikimedia.org/wiki/Learning_patterns/Timing_and_tenaciousness_-_How_to_ensure_high_participation_rates_at_post-conference_surveys
- Explori response-rate tips: https://kb.explori.com/knowledge/5-top-tips-to-increase-your-post-event-survey-response-rates
- Bird — Gmail/Yahoo requirements: https://bird.com/docs/knowledge-base/deliverability/gmail-yahoo-requirements and https://bird.com/explained/deliverability/what-are-the-gmail-and-yahoo-bulk-sender-requirements
- MessageGears on Google/Yahoo rules: https://messagegears.com/resources/blog/google-yahoo-to-combat-spam-with-new-email-rules-for-senders/
- PowerDMARC 2026 requirements: https://powerdmarc.com/google-and-yahoo-email-authentication-requirements
- Resend quotas: https://resend.com/docs/knowledge-base/account-quotas-and-limits ; https://resend.com/blog/new-free-tier
- Brevo pricing: https://ecommerce-platforms.com/email-marketing-services-reviews/sendinblue-pricing ; https://dreamlit.ai/blog/brevo-review
- Twilio US SMS pricing: https://www.twilio.com/en-us/sms/pricing/us
- Twilio 10DLC fees: https://support.twilio.com/hc/en-us/articles/1260803965530 ; https://static0.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand.md
- Sociocs Twilio 10DLC explainer: https://www.sociocs.com/post/twilio-10dlc-explained/
- Telnyx vs Twilio pricing: https://telnyx.com/resources/twilio-telnyx-sms-pricing
- 11th Cir. vacates 1:1 consent rule: https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/eleventh-circuit-vacates-tcpa-11-consent-rule ; https://mofo.com/resources/insights/250130-eleventh-circuit-vacates-fcc-s-tcpa-one-to-one-consent-rule
- Foley TCPA checklist: https://foley.com/-/media/5a031499fb77473c83e8bb3ba43df687.ashx
- Klaviyo mini-TCPA: https://www.klaviyo.com/glossary/what-is-mini-tcpa
- Yotpo SMS regulations: https://support.yotpo.com/docs/complying-with-us-sms-marketing-regulations
- CTIA principles summary: https://helpdesk.telebroad.com/support/solutions/articles/4000188137-ctia-messaging-principles-and-best-practices

**Scoring methods**
- IMDb weighted average ratings: https://help.imdb.com/article/imdb/track-movies-tv/weighted-average-ratings/GWT2DSBYVT2F25SK
- IMDb Top 250 formula explainer: https://neurobiology.substack.com/p/how-imdb-determines-top-250_27
- Evan Miller, How Not To Sort By Average Rating: https://evanmiller.org/how-not-to-sort-by-average-rating.html
- Beta-prior alternative: https://www.greaterwrong.com/posts/SnSYB8CFpjESfRuCm/how-not-to-sort-by-a-complicated-frequentist-formula
- Nicereply agent ranking formula: https://support.nicereply.com/article/117-agent-ranking-formula

**Bias / legal / privacy**
- Hekman et al. 2010 (AMJ): https://leeds-faculty.colorado.edu/dahe7472/racefinal.pdf ; https://academicnewsletter.sufe.edu.cn/info/361557
- CustomerThink on CSAT bias and bonuses: https://customerthink.com/?p=75837
- Boring, Ottoboni & Stark 2016: https://doaj.org/article/f74e8e3f674646a9befb4961ee7b53b0 ; AAUP: https://www.aaup.org/article/student-evaluations-teaching-are-not-valid
- MacNell, Driscoll & Hunt 2014: https://news.ncsu.edu/2014/12/macnell-gender-2014 ; https://www2.math.upenn.edu/%7Epemantle/active-papers/Evals/macnell-driscoll-hunt.pdf
- Rosenblat et al., Discriminating Tastes: https://datasociety.net/output/discriminating-tastes-customer-ratings-as-vehicles-for-bias/ ; https://blogs.oii.ox.ac.uk/ipp-conference/sites/ipp/files/documents/Discriminating_Tastes_Customer_Ratings_as_Vehicles_for_Bias.pdf ; https://news.cornell.edu/node/286963
- Liu v. Uber docket: https://www.docketalarm.com/cases/California_Northern_District_Court/3--20-cv-07499/Liu_v._Uber_Technologies_Inc/57
- Four-fifths rule: https://www.prevuehr.com/resources/insights/adverse-impact-analysis-four-fifths-rule/ ; EEOC AI/Title VII guidance (Littler): https://littler.com/node/607951
- FTC COPPA FAQ (archived): https://webharvest.gov/peth04/20041022093947/http://www3.ftc.gov/privacy/coppafaqs.htm
- Paul Hastings on COPPA FAQs: https://paulhastings.com/insights/caveat-vendor/blog-ftc-releases-second-set-of-coppa-faqs-here-are-some-highlights
- Kelley Drye on COPPA FAQs: https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ftc-issues-updated-coppa-faqs
- CCPA applicability: https://www.clym.io/blog/ccpa-applicability-guide ; https://www.feroot.com/blog/ccpa-applicability-website-california-law/

**Implementation tools**
- Formbricks license docs: https://formbricks.com/docs/self-hosting/license ; GitHub: https://github.com/formbricks/formbricks
- Formbricks vs LimeSurvey 2026: https://blog.elest.io/formbricks-vs-limesurvey-which-self-hosted-survey-tool-in-2026/
- LimeSurvey participants/tokens: https://manual.limesurvey.org/Tokens
- OhMyForm status: https://opencollective.ecosyste.ms/projects/16003
- Tally pricing: https://Tally.so/pricing ; OpnForm vs Tally: https://forms.grad.ttu.edu/opnform-vs-tally
- Google Forms prefilled links: https://Labnol.org/prefilled-google-forms-200601 ; https://supademo.com/blog/how-to-prefill-answers-in-a-google-form ; https://formester.com/blog/google-form-auto-filler/
- Google Forms webhook via Apps Script: https://webhookrelay.com/blog/google-forms-webhook/ ; https://www.svix.com/resources/guides/google-forms-webhook/ ; https://formester.com/blog/google-forms-webhooks/
