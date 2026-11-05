# Kea's shared Claude: internal guidelines

The owner's own Claude plan ($100/month Max) does a limited amount of work for other Kea users. These rules keep that plan usable for the owner and stop anyone from spamming it. The Hub enforces them (`hub/lib/budget.mjs`), so a modified app can't get around them. Every number is an owner setting (`POST /owner/settings`).

## What people can ask for
| Request | Rule |
|---|---|
| **First scan of a class** | Once per class per person. If anyone in the same course section (school + course code + term + section) was already scanned, they **share** it at once and no Claude runs. If a classmate's scan is already waiting, they **join** it. |
| **Update scan** (what's new) | At most once every 20 hours **per course section**, shared by everyone in it. |
| **25 more questions** | Exactly one batch of 25 for one chapter. At most 4 batches per chapter per person (100 extra questions) and 2 batches per day. New questions go into the course's shared pool, and a second request for the same chapter joins the first. |
| **Regenerate** | **Never.** Nothing is rewritten from scratch on the shared Claude. People who want that connect their own Claude. |

## Limits per person (owner: none)
- A verified email (Verify with Google) is required.
- 3 Claude jobs started per day and 10 per week. Sharing and joining are free.
- At most 3 requests waiting at once.

## Limits for everyone together
- 40 jobs a day from everyone except the owner. After that, only the owner's jobs run until tomorrow.
- Pause any time (`POST /owner/scan/pause {hours}`), for example when the plan hits its usage window. Others wait; the owner's jobs still run.
- One job runs at a time. The owner's jobs go first. After that, whoever has had the fewest jobs today goes next, then the oldest request. Wait estimates come from the average of the last 20 jobs.

## Abuse
- **15 refused requests in a day:** the account is flagged for review. Nothing else happens.
- **200 requests in a day:** that's a script, not a person. The account is **suspended automatically**, signed out everywhere, and flagged.
- The owner reviews flags (`GET /owner/flags`) and dismisses, unsuspends or suspends (`POST /owner/flags/:id/resolve`).

## Money
- **Donations only.** One quiet "Support Kea" link on the account page (`GET /v1/support`). No pop-ups, no reminders, no features locked behind it.
- Donations are gifts. They buy no extra Claude use and no promise of service. That keeps the owner's personal Claude plan from being resold, which Anthropic's consumer terms likely don't allow.
- People who want more than the shared allowance connect their own Claude, and Kea does everything on their plan.

## Not yet built
- **The worker in the owner's Kea.** It takes the next job (`POST /owner/scan/next`), runs it, and reports back (`/finish`).
- **Students' Kea collecting their class pages and uploading them** (or the remote-browsing version), so school passwords never leave their devices.
- **Parent sign-off for under-18 accounts** before scans.
- **Course-membership checks.** Today anyone can claim a course section to get its shared materials. They're Claude-written study material, low-risk, but worth tightening later.
