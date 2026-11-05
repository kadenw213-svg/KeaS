# KeaS

> ## PROTOTYPE — NOT FOR REAL USE
> - The **org server** runs on a **demo workplace with made-up people**, and its sign-in has no password. (The Kea Hub's accounts are real: see below.)
> - **Payroll numbers are unverified estimates.** The tax and labor tables have not been checked for this year, every pay run is marked `unverified`, and **a pay run cannot be finalized**. The direct-deposit (NACHA) file is a sample that is never sent anywhere.
> - The server listens on **127.0.0.1 only** (this computer).

KeaS is a free, self-hosted system for scheduling staff, clocking in and out, timecards and payroll prep, built first for a Colorado community pool with teen lifeguards.

**Why it exists:** big payroll suites charge roughly $21–41 per employee per month, which is brutal for seasonal and part-time teams, and they lock you into long contracts. KeaS is:

- **Free to host yourself**, with open data you can export at any time. No per-head pricing, no lock-in.
- **Built for seasonal and youth workforces** (pools, rec centers, camps, parks): shifts are checked against certifications (an expired lifeguard cert blocks the shift) and against minor work-hour rules before anyone is scheduled.
- **Transparent:** staff can see exactly how their hours and pay were worked out. Every pay amount comes with its explanation.
- **Resilient:** your workplace runs its own server, so a vendor outage doesn't stop the clock.

KeaS is not a payroll processor. It prepares approved hours and pay estimates; paying people and filing taxes stays with your payroll provider or bank.

## What's in the prototype

- **Phone-first web app** served by the KeaS server itself. Staff just open the link (and can install it to their home screen); managers and payroll use it in a browser or on a kiosk tablet.
  - **Today:** a big Clock in / Clock out button, your next shift, and for managers a live board of who's on, late or missing.
  - **Schedule:** the week (a day-by-day list on phones), shift swaps, and for managers adding shifts with live checks (certifications, ages, minor hours, overtime) and publishing.
  - **Timecards:** hours per pay period, missed-punch fix requests, manager approvals.
  - **People & certifications** (managers/payroll) and **Pay run** preview (payroll), with every warning and explanation.
- **Org server** (`server/`): plain Node, SQLite, no runtime dependencies. API documented in [server/README.md](server/README.md).
- **Kea Hub** (`hub/`): the server behind Kea accounts.
  - **Accounts:** passwords stored only as a slow one-way hash, lockouts after repeated wrong tries, optional two-step sign-in, and versioned terms everyone agrees to.
  - **Classes:** invite codes and a class calendar.
  - **Studying:** server-graded study sets and leaderboards.
  - **Kea storage and sync.**
  - **Kea's shared Claude:** a limited, queued service for people without their own Claude.
  - Tests: `npm run test:hub`.
- **KeaS desktop** (`desktop/`): the Windows app (`npm run desktop:build`). On first run it sets up this computer as a server:
  - pick a data drive;
  - optionally make it reachable from anywhere with Tailscale Funnel (installed and set up for you);
  - it runs in the tray and starts with Windows.

## Run it

Needs Node 24.

```
npm install
node server/seed.mjs --reset     # create the demo workplace (dates are set around today)
npm run dev                      # server on 127.0.0.1:4850 + the web app with live reload
```

Open the URL Vite prints (normally **http://127.0.0.1:5173**) and pick a demo person to sign in as. Try a lifeguard (staff), a manager (live board, approvals, adding shifts) and the payroll person (pay run).

To run it the way a workplace would, with the server serving the built app:

```
npm run web:build                # builds web/ into web/dist
npm run server:dev               # then open http://127.0.0.1:4850
```

Other commands:

```
npm run test:server              # server tests (API, rules, pay, cookie auth/CSRF, static serving)
npm run typecheck                # TypeScript check of the web app
```

## Security notes (prototype)

- The web app uses a same-origin `HttpOnly; SameSite=Strict` session cookie; scripts and the desktop app can use `Authorization: Bearer`.
- Cookie-authenticated writes must carry `X-KeaS: 1` and come from the same origin; cross-site requests are refused.
- Pages are served with a strict Content-Security-Policy, `nosniff` and `no-referrer`; files are only ever served from inside `web/dist`.
- The service worker caches the app shell only. API responses (schedules, punches, pay) are never cached.
- The app icon is a placeholder: replace `web/public/icon.svg`.

## License

[MIT](LICENSE)
