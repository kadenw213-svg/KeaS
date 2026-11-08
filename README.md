<p align="center">
  <img src="docs/logo/keas-a-key.svg" width="96" alt="KeaS logo">
</p>

<h1 align="center">KeaS</h1>

<p align="center">
  Your organization's own server for Kea: schedules, the time clock, pay codes and payroll prep, on your own computer.
</p>

<p align="center">
  <a href="https://github.com/kadenw213-svg/KeaS/releases/latest"><b>⬇ Download KeaS</b></a>
</p>

---

KeaS turns a Windows computer into your organization's server. Your people use it from
[Kea](https://github.com/kadenw213-svg/kea) on their computers and phones: their shifts, swaps and availability,
clocking in and out, their pay codes, hours and pay stubs. Everyone signs in with the Kea account they already have;
KeaS never sees a password. Everything runs on hardware you own, and a few clicks make it reachable from anywhere.

## Setup

The first time KeaS opens, it walks you through it: pick the drive for the data, check your Kea account server's key
(its fingerprint, against the one it shows), sign in with your Kea account, set up the server with the one-time code
KeaS shows on this computer, create your organization and say where people work, and turn on Tailscale Funnel, which
gives the server a public https address for free without changing router settings or revealing your address. Then a
"Get set up" list shows what's left, Payroll's steps included. From then on KeaS runs in the tray and starts with
Windows.

## Sign-in

People sign in with their Kea accounts. Kea asks the Kea account server for a pass for your server (it lasts a week
and renews by itself), and KeaS checks it with the account server's key, then keeps its own sign-in. If the account
server can't be reached, everything already signed in keeps working. A suspended Kea account is signed out of your
server within the hour.

## Your organization

Roles you make (or Owner, Admin, Manager and Member), for the whole organization or chosen departments. Pay codes for
each job and its rate, with rate changes from a date: every hour is paid at the code it was worked at, at the rate in
effect that day. Join codes, departments, positions, certifications, availability forms, schedules and the time clock.
Each person also gets a files area on the server for what Kea keeps in sync there (1 GB unless you set more).

## Payroll

**Payroll** in the tray menu (or on the KeaS window) runs payroll and HR for an organization on the payroll
admin's own computer: pay runs from approved timecards, several pay rates per person, shift differentials, overtime,
paid time off and holidays, raises with approvals and automatic retro pay, departments and cost centers with labor
splits, onboarding with e-signed W-4 and state forms, the I-9 checklist, offboarding with each state's final-pay
deadline, expenses, documents, reports, and W-2, 1099 and ACA data at year end. SSNs, bank details and documents
are encrypted with a passphrase only you know and never leave that computer. When a pay run is finalized, each person
gets their own pay stub in Kea, sealed for them. Admins sign in with their Kea account
plus the passphrase. KeaS prepares the direct-deposit file for your own bank; it never holds or moves money. A pay
run can be finalized only once that year's tax and labor tables have been checked against official sources.

## Install

**Windows 10 or 11 (64-bit):** download `KeaS-Setup-….exe` from the
[latest release](https://github.com/kadenw213-svg/KeaS/releases/latest) and run it. The installer isn't code-signed
yet, so Windows may show a warning; choose **More info → Run anyway**.

## Built with

Electron and Node.js, with SQLite (`node:sqlite`) for the server's data, and electron-updater for KeaS's own updates.
Sign-in uses Ed25519-signed passes from the Kea account server (`docs/protocol.md`), and public access goes through
Tailscale Funnel. To build KeaS from source, see [docs/DEVELOPING.md](docs/DEVELOPING.md).

## Feedback

Report bugs and ideas by [opening an issue](https://github.com/kadenw213-svg/KeaS/issues).

---

MIT licensed.
