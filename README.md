<p align="center">
  <img src="docs/logo/keas-a-key.svg" width="96" alt="KeaS logo">
</p>

<h1 align="center">KeaS</h1>

<p align="center">
  The server behind Kea: accounts, classes, study groups and sync, run on your own computer.
</p>

<p align="center">
  <a href="https://github.com/kadenw213-svg/KeaS/releases/latest"><b>⬇ Download KeaS</b></a>
</p>

---

KeaS turns a Windows computer into a Kea Hub, the server that [Kea](https://github.com/kadenw213-svg/kea) connects
to. It gives everyone one Kea account, lets instructors run classes and study groups, keeps each person's devices in
step through their own Kea storage, and lets people without a Claude account have their classes set up on the Hub
owner's Claude. Everything runs on hardware you own, and a few clicks of setup make it reachable from anywhere.

## Setup

The first time KeaS opens, it walks you through three steps. Choose the drive the Hub keeps its data on; a large
drive is best, since every account gets its own storage. KeaS then installs Tailscale and turns on Funnel, which
gives the Hub a public https address for free without changing router settings or revealing your home address.
Finally, create the owner account with two-step sign-in. From then on KeaS runs in the tray, starts with Windows,
and keeps the Hub running.

## Accounts

One Kea account works in Kea and KeaS. Passwords are stored only as a slow one-way hash, never in a form anyone can
read, and repeated wrong guesses lock an account for longer each time. Two-step sign-in works with any
authenticator app, and **Verify with Google** proves an email address. Every account agrees to the Hub's terms
section by section; when the terms change, people are shown exactly what changed and agree again before continuing.

## Classes and studying

Instructors create classes, invite people with a code, and put sessions on a shared calendar with meeting links.
Practice questions are graded by the Hub, so scores can't be edited, and each question comes back on a spaced
schedule. XP, levels, streaks, and weekly and all-time leaderboards reward studying. Each person chooses whether
they appear by name, by nickname, or not at all.

## Storage and sync

Kea syncs each person's computers through their Kea storage on the Hub instead of a cloud drive. Only changed files
move, every file keeps a version so two devices never overwrite each other, and large downloads are paced so they
never fill the owner's internet connection.

## Kea's shared Claude

People without their own Claude account can queue a scan of their classes on the Hub owner's Claude. Their school
password never leaves their own computer: the scan reads their class site through their own Kea, and only page text
reaches the Hub. Daily and weekly limits, one shared scan per course section, and batches of new questions in place
of regenerating keep the queue fair and the owner's plan usable.

## Payroll

**Payroll** in the tray menu (or on the KeaS window) runs payroll and HR for an organization on the payroll
admin's own computer: pay runs from approved timecards, several pay rates per person, shift differentials, overtime,
paid time off and holidays, raises with approvals and automatic retro pay, departments and cost centers with labor
splits, onboarding with e-signed W-4 and state forms, the I-9 checklist, offboarding with each state's final-pay
deadline, expenses, documents, reports, and W-2, 1099 and ACA data at year end. SSNs, bank details and documents
are encrypted with a passphrase only you know and never leave that computer. Admins sign in with their Kea account
plus the passphrase. KeaS prepares the direct-deposit file for your own bank; it never holds or moves money. A pay
run can be finalized only once that year's tax and labor tables have been checked against official sources.

## Install

**Windows 10 or 11 (64-bit):** download `KeaS-Setup-….exe` from the
[latest release](https://github.com/kadenw213-svg/KeaS/releases/latest) and run it. The installer isn't code-signed
yet, so Windows may show a warning; choose **More info → Run anyway**.

## Built with

Electron and Node.js, with SQLite (`node:sqlite`) for the Hub's data, and electron-updater for KeaS's own updates. Accounts use
Argon2id or scrypt password hashing, Ed25519-signed tokens and TOTP two-step sign-in, and public access goes through
Tailscale Funnel. To build KeaS from source, see [docs/DEVELOPING.md](docs/DEVELOPING.md).

## Feedback

Report bugs and ideas by [opening an issue](https://github.com/kadenw213-svg/KeaS/issues).

---

MIT licensed.
