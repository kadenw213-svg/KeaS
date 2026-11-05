# KeaS

KeaS is the server side of [Kea](https://github.com/kadenw213-svg/Kea). It runs the **Kea Hub**: one Kea account for everything, classes and study groups, leaderboards, Kea storage and sync, and Kea's shared Claude. It also includes a Windows app that turns any computer into a Kea server in a few clicks.

Free, open source, and yours to host.

## Download

Get the latest **KeaS Setup** from [Releases](https://github.com/kadenw213-svg/KeaS/releases). On first launch, KeaS walks you through setting up this computer as a Kea Hub:

1. **Choose where the data goes.** Any drive or folder; a big drive is best, since every account gets its own Kea storage.
2. **Make it reachable from anywhere** with Tailscale Funnel, for free. KeaS installs Tailscale and sets up Funnel for you, so people can reach the Hub without you changing router settings or showing your home address.
3. **Create the owner account**, with two-step sign-in.

After that, KeaS runs in the tray and starts with Windows. Light and dark themes are included.

## The Kea Hub

- **One Kea account.** Sign in once in Kea and KeaS.
  - Passwords are stored only as a slow one-way hash (Argon2id or scrypt).
  - Repeated wrong guesses lock the account for longer and longer.
  - Two-step sign-in works with any authenticator app, and "Verify with Google" proves an email address.
- **Terms that stay current.** Every account agrees to every section. When the terms change, people see exactly what changed and agree again before continuing.
- **Classes.** Instructors create classes, invite people with a code, and put sessions on a shared calendar with meeting links. Hosting classes on a Hub needs the owner's approval.
- **Studying that rewards studying:**
  - practice sets graded by the Hub, so scores can't be faked;
  - questions come back on a spaced schedule;
  - XP, levels, streaks, and weekly and all-time class leaderboards;
  - everyone chooses whether they appear by name, by nickname, or not at all.
- **Kea storage and sync.** Kea syncs your devices through your Hub instead of a cloud drive. Only changed files move, and each version is tracked so devices never overwrite each other. Big downloads are paced so they can't fill the owner's internet connection.
- **Kea's shared Claude.** People without their own Claude account can queue a scan of their classes on the Hub owner's Claude. Their school password never leaves their own computer: the scan reads their class site through their own Kea. The Hub keeps it fair with daily and weekly limits, one shared scan per course section, and question batches instead of regenerating.
- **Built to be safe:**
  - the owner console only answers on the Hub's own computer;
  - every admin action is logged;
  - backups are encrypted;
  - anything that sends requests like a script is paused for the owner to review.

## Build from source

Needs Node 24.

```
npm install
npm run hub              # the Kea Hub on 127.0.0.1:4860 (owner console on 4861)
npm run desktop          # the KeaS app
npm run desktop:build    # the Windows installer
npm test                 # all tests
```

**Owner tools** run on the Hub's own computer:
- `node hub/owner.mjs make-owner <email>`
- `node hub/owner.mjs publish-terms`
- `node hub/backup.mjs create <folder>`

## Roadmap

KeaS is growing into a free workforce suite for organizations:
- scheduling, availability forms, time clock and certifications;
- departments and budgets;
- payroll preparation with tax tables verified each year.

That work lives in `server/` and `web/`.

## License

[MIT](LICENSE)
