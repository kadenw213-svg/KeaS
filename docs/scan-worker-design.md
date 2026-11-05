# Scanning for other people on the owner's Claude: the worker design (2026-11-05)

Built so far:
- **The Hub side** (`hub/index.mjs`, "shared Claude"): the queue and limits, plus `scan-inbox/` uploads, the worker's claim/finish calls, shared course folders and private member results.
- **Kea syncing through the Hub** (Kea `electron/scholar/hubsync.cjs`). It mirrors the same `Kea/<profile>/` folder layout Kea used in OneDrive.

## The idea: the worker is a remote "primary device" for that person's profile
Kea's device protocol (`devices.cjs`) already has one **primary** device. The primary scans, then writes these into the sync folder:
- `Devices/classes.db`;
- `Devices/shared/…`;
- `Textbooks/`;
- `primary.json`.

Every other device follows: it pulls those files in, and sends requests through `Devices/requests/`.

With sync going through the Hub, the student's sync folder **is** their Hub storage (`kea/<profile>/…`). So the owner's worker can act as the primary for that student's profile:
1. It runs the scan in a **separate workspace** on the owner's PC: its own profile folder per student, never the owner's own profile.
2. It writes the results into the student's `kea/<profile>/Devices/…` and `Textbooks/` through the owner console.
3. The student's Kea, already following through the Hub, picks them up with **no new code on the student's side** for receiving results.

## Browsing their class site without their password: remote tools
Claude's MCP tools (`d2l_open`, `page_click`, `d2l_fetch`, `d2l_download`) are relayed through the Hub to the student's own Kea:
1. Claude, on the owner's PC, calls a tool. The worker's MCP server posts the call to the Hub (`POST /owner/scan/:id/call`).
2. The student's Kea long-polls for calls (`GET /v1/scan/:id/calls`). It runs each call in its own hidden browser, signed in with its own password and two-step approval, and posts back the page text (`POST /v1/scan/:id/calls/:callId/result`).
3. Only the text Claude asked for crosses the owner's internet. The school sees sign-ins from the student's usual computer.
4. The student's Kea has to be open during the scan. The queue tells them when their turn is coming.

Kea's plain (no-Claude) checks (`precheck.run`, the class areas and digests) also run on the student's device. Their output is uploaded to `scan-inbox/<job>/` so Claude starts with everything already gathered.

## What has to change in Kea
- **runner.cjs:** run a job in a given workspace and profile folder, instead of only `profiles.active()`. The worker's jobs must never block the owner's own scans: run them only when the owner's queue is idle, with the shared-Claude pause.
- **mcp.cjs:** a "remote" mode where the `d2l_*` tools forward to the Hub relay instead of the local hidden browser.
- **Hub:** the relay endpoints above (calls with timeouts, rate-limited, only while the job is running, only to that job's person).
- **Owner console:** allow the worker to write `kea/<profile>/…` for the job's person while the job runs (today only `kea-results/`).
- **Student's Kea:**
  - a "Use Kea's shared Claude" option;
  - the request button;
  - queue position;
  - answering relayed tool calls while the job runs.
- **Phone:** reads `kea-data.json` from the Hub instead of a Drive file (KeaPlugin `readFile`/`writeFile`, `mobile/src/kea.ts`). Textbooks come per file, not as a zip.
