// Tailscale, set up by KeaS so the Hub (or an org server) can be reached from anywhere, for free, without opening a
// port on the router: install it (winget), sign in (the person's browser), then turn on Funnel for the server's port.
// Funnel gives a public https://<this-pc>.<tailnet>.ts.net address with a real certificate. Funnel listens on https
// port 443, 8443 or 10000; KeaS takes 443 unless something else on this PC already has it (on the Kea Hub's PC that's
// the Kea account server, KeaC, on 443), then 8443, then 10000, so it never takes another program's address.
// `tailscale funnel status --json` is Tailscale's serve config: Web { "<host>:<https port>": { Handlers: { "/": { Proxy:
// "http://127.0.0.1:<local port>" } } } } and AllowFunnel { "<host>:<https port>": true }.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')];
const exe = () => CANDIDATES.find((p) => fs.existsSync(p)) || null;
const URL_RE = /https:\/\/login\.tailscale\.com\/[^\s"']+/g;

function run(file, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: String(stdout), err: String(stderr) }));
  });
}

/** The https ports Funnel may use. */
const FUNNEL_PORTS = [443, 8443, 10000];
/**
 * What the serve config publishes: [{ https, local, funnel }] (https: the public port; local: the 127.0.0.1 port it
 * forwards to, or null; funnel: open to the internet).
 */
function published(fj) {
  const out = [];
  for (const [hostPort, web] of Object.entries(fj?.Web || {})) {
    const https = Number(String(hostPort).split(':').pop()) || 443;
    const m = /(?:127\.0\.0\.1|localhost):(\d+)/.exec(JSON.stringify(web?.Handlers || web || {}));
    out.push({ https, local: m ? Number(m[1]) : null, funnel: !!fj?.AllowFunnel?.[hostPort] });
  }
  return out;
}
/** The https port Funnel publishes `port` on, or null. */
const funnelPortOf = (fj, port) => published(fj).find((x) => x.funnel && x.local === port)?.https ?? null;
/** The https port to publish `port` on: the one it already has, else the first one nothing else uses. */
function freePortFor(fj, port) {
  const have = published(fj);
  const mine = have.find((x) => x.local === port);
  if (mine) return mine.https;
  return FUNNEL_PORTS.find((p) => !have.some((x) => x.https === p)) ?? null;
}
const addressOf = (dnsName, https) => (dnsName ? `https://${dnsName}${https && https !== 443 ? `:${https}` : ''}` : null);

/** { installed, running, loggedIn, dnsName, url, funnel, httpsPort } (url: where Funnel publishes `port`) */
async function status(port) {
  const t = exe();
  if (!t) return { installed: false };
  const r = await run(t, ['status', '--json'], { timeout: 15_000 });
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  const state = j?.BackendState || (r.err.includes('not running') ? 'Stopped' : 'Unknown');
  const dnsName = j?.Self?.DNSName ? j.Self.DNSName.replace(/\.$/, '') : null;
  let funnel = false, httpsPort = null;
  if (port && state === 'Running') {
    const f = await run(t, ['funnel', 'status', '--json'], { timeout: 15_000 });
    try {
      httpsPort = funnelPortOf(JSON.parse(f.out || '{}'), port);
      funnel = httpsPort != null;
    } catch {}
  }
  return { installed: true, running: state !== 'Stopped', state, loggedIn: state === 'Running', needsLogin: state === 'NeedsLogin' || state === 'NoState', dnsName, url: addressOf(dnsName, httpsPort ?? 443), funnel, httpsPort, authUrl: j?.AuthURL || null };
}

/** Installs with winget (one Windows permission prompt). onLine gets progress text. */
function install(onLine = () => {}) {
  return new Promise((resolve, reject) => {
    if (exe()) return resolve(true);
    const p = spawn('winget', ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { windowsHide: true });
    const feed = (b) => String(b).split(/\r?\n|\r/).map((s) => s.trim()).filter((s) => s && !/^[-\\|/ ]+$/.test(s)).forEach((s) => onLine(s));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', () => reject(new Error('Windows couldn’t run the installer (winget). Install Tailscale from tailscale.com/download, then come back.')));
    p.on('close', async (code) => {
      // The service takes a moment to appear after install.
      for (let i = 0; i < 20 && !exe(); i++) await new Promise((r) => setTimeout(r, 1000));
      if (exe()) resolve(true);
      else reject(new Error(`Tailscale didn’t install (code ${code}). Install it from tailscale.com/download, then come back.`));
    });
  });
}

/** The `tailscale up` arguments KeaS uses. */
function upArgs(timeoutMs, platform = process.platform) {
  return ['up', '--hostname', 'keas-hub', ...(platform === 'win32' ? ['--unattended'] : []), '--timeout', `${Math.round(timeoutMs / 1000)}s`];
}

/** Signs in: opens the sign-in page in the browser and waits until this PC is on the tailnet. */
async function login(openUrl, onLine = () => {}, { timeoutMs = 10 * 60_000 } = {}) {
  const t = exe();
  if (!t) throw new Error('Install Tailscale first.');
  const s = await status();
  if (s.loggedIn) return s;
  const opened = new Set();
  // --unattended (Windows): Tailscale keeps running when nobody is signed in to Windows, so the Hub that starts
  // before sign-in stays reachable.
  const p = spawn(t, upArgs(timeoutMs), { windowsHide: true });
  const watch = (b) => {
    const text = String(b);
    for (const u of text.match(URL_RE) || []) if (!opened.has(u)) { opened.add(u); onLine('Opening the Tailscale sign-in page in your browser…'); openUrl(u); }
  };
  p.stdout.on('data', watch);
  p.stderr.on('data', watch);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await status();
    if (now.authUrl && !opened.has(now.authUrl)) { opened.add(now.authUrl); openUrl(now.authUrl); }
    if (now.loggedIn) { try { p.kill(); } catch {} return now; }
  }
  try { p.kill(); } catch {}
  throw new Error('Tailscale sign-in didn’t finish. Try again.');
}

/**
 * Turns on Funnel for the local port (kept on across restarts by Tailscale itself). The first time on a tailnet,
 * Tailscale asks its admin to allow Funnel: that page opens in the browser, and this keeps trying until it's allowed.
 */
async function funnel(port, openUrl, onLine = () => {}, { timeoutMs = 10 * 60_000 } = {}) {
  const t = exe();
  if (!t) throw new Error('Install Tailscale first.');
  const started = Date.now();
  const opened = new Set();
  // (443 when it's free; on a PC where another program has it, 8443 or 10000: never someone else's address.)
  let fj = {};
  try { fj = JSON.parse((await run(t, ['funnel', 'status', '--json'], { timeout: 15_000 })).out || '{}'); } catch {}
  const https = freePortFor(fj, port);
  if (https == null) throw new Error('Tailscale Funnel’s three https ports (443, 8443, 10000) are all used by other programs on this PC. Free one (tailscale funnel status shows them), then try again.');
  while (Date.now() - started < timeoutMs) {
    const r = await run(t, ['funnel', '--bg', '--yes', `--https=${https}`, String(port)], { timeout: 30_000 });
    const text = r.out + r.err;
    for (const u of text.match(URL_RE) || []) if (!opened.has(u)) { opened.add(u); onLine('Tailscale needs you to allow Funnel once. Opening that page…'); openUrl(u); }
    const s = await status(port);
    if (s.funnel) return s;
    if (/unknown flag.*yes/i.test(text)) {
      // Older Tailscale without --yes.
      await run(t, ['funnel', '--bg', `--https=${https}`, String(port)], { timeout: 30_000 });
      const s2 = await status(port);
      if (s2.funnel) return s2;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Funnel didn’t turn on. In the Tailscale admin page, allow Funnel and HTTPS for this PC, then try again.');
}

/** Does Tailscale's Funnel publish this port (KeaS's own Funnel)? From `tailscale funnel status --json`. */
const servesPort = (fj, port) => funnelPortOf(fj, port) != null;

/**
 * Turns off KeaS's Funnel only: the https handler (443, 8443 or 10000) that `funnel` set up for this port. Other things the person set
 * up in Tailscale stay as they are (it never runs `tailscale funnel reset`). The command is the one that set it up with
 * "off" on the end (Tailscale docs, kb/1311: "rerun the original command with off appended").
 */
async function funnelOff(port, { runFn = run } = {}) {
  const t = exe();
  if (!t) return { installed: false, funnel: false };
  const before = await runFn(t, ['funnel', 'status', '--json'], { timeout: 15_000 });
  let fj = null;
  try { fj = JSON.parse(before.out || '{}'); } catch {}
  if (fj && !servesPort(fj, port)) return { ...(await status(port)), funnel: false, changed: false };
  const https = (fj && funnelPortOf(fj, port)) || 443;
  await runFn(t, ['funnel', `--https=${https}`, 'off'], { timeout: 30_000 });
  let s = await status(port);
  if (s.funnel) { await runFn(t, ['funnel', '--bg', `--https=${https}`, 'off'], { timeout: 30_000 }); s = await status(port); }
  if (s.funnel) throw new Error(`Tailscale didn’t turn Funnel off. Run "tailscale funnel --https=${https} off" in a terminal, or turn it off in the Tailscale admin page.`);
  return { ...s, changed: true };
}

module.exports = { exe, status, install, login, funnel, funnelOff, upArgs, servesPort, published, funnelPortOf, freePortFor, addressOf, FUNNEL_PORTS };
