// Kea Hub: accounts, classes, invites, class calendar, study sets and leaderboards.
//
// Two listeners, both bound to 127.0.0.1:
//   - the public API (port 4860). The tunnel (Tailscale Funnel or Cloudflare Tunnel) forwards the internet to this one.
//   - the owner console (port 4861). Never tunneled, so it can't be reached from the internet at all, and every call
//     also needs the owner key from the Hub's data folder. Becoming an owner is only possible from this PC
//     (`node hub/owner.mjs make-owner <email>`), never through the API.
import http from 'node:http';
import { createHash, randomBytes, randomUUID, sign as edSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statfsSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdir as mkdirP, readFile as readFileP, rename as renameP, rm as rmP } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTerms, diffTerms, sameSections, termsPage } from './lib/terms.mjs';
import { DEFAULTS as BUDGET, ACCOUNT_LIMITS, courseKey, decide, isMinor, pickNext, cleanOverride, describeOverride, limitsFor } from './lib/budget.mjs';
import { PHONE_VISIBILITY, normalizePhone, phoneShownIn, fmtBytes, fmtDate, supporterUntil } from './lib/account.mjs';
import { googleKeys, verifyGoogleIdToken } from './lib/google.mjs';
import { consentPage, consentCsp } from './lib/consentPage.mjs';
import { openDb, DATA_DIR } from './db.mjs';
import { hashPassword, verifyPassword, needsRehash, passwordProblem } from './lib/passwords.mjs';
import { newSecret, checkCode, otpauthUri, totpKeyFrom, sealSecret, openSecret, isSealed } from './lib/totp.mjs';
import { ownerNonces, ownerReplyMac, OWNER_AUTH_HEADER, OWNER_CHALLENGE_HEADER, OWNER_REPLY_HEADER } from './lib/ownerauth.mjs';
import { cleanText, isReservedName } from './lib/names.mjs';
import { loadOrCreateKey, signToken } from './lib/tokens.mjs';
import { writeSecretFile } from './lib/secureFile.mjs';
import { Windows, Buckets, failures } from './lib/limiter.mjs';
import { Busy } from './lib/hashpool.mjs';
import { hashStats } from './lib/passwords.mjs';
import { createHubLog } from './lib/hublog.mjs';
import { FLOW_DEFAULTS, jsonParts } from './lib/flow.mjs';
import { clientAddress, ipBucket, isLoopback } from './lib/clientip.mjs';
import { scoreAnswer, capped, levelOf, weekStart, dayKey, streak } from './lib/study.mjs';
import { mountOrgs } from './org/routes.mjs';

// The version the Hub reports (/v1/health; Kea reads it to tell which Hub it talks to). It comes from KeaS's own
// package.json, or from version.txt beside the before-sign-in copy, so a release can't leave it behind.
function readVersion() {
  for (const f of ['../package.json', '../version.txt']) {
    try {
      const t = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      const v = f.endsWith('.json') ? JSON.parse(t).version : t.trim();
      if (/^\d+\.\d+\.\d+/.test(String(v))) return String(v);
    } catch {}
  }
  return '0.0.0';
}
export const VERSION = readVersion();
const HOST = '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const SESSION_MAX_DAYS = 365;
const TOKEN_MINUTES = 15;
export const COOKIE = 'kea_hub';

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => { throw new HttpError(400, m, extra); };
const forbidden = (m = 'Not allowed.') => { throw new HttpError(403, m); };
const notFound = (m = 'Not found.') => { throw new HttpError(404, m); };

const V = {
  str(v, name, { optional = false, max = 500, min = 0 } = {}) {
    if ((v == null || v === '') && optional) return null;
    if (typeof v !== 'string') bad(`${name} must be text.`);
    const t = v.trim();
    if (t.length < min || t.length > max) bad(`${name} must be ${min}-${max} characters.`);
    return t;
  },
  email(v) {
    const e = V.str(v, 'Email', { max: 254, min: 3 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) bad('Enter a valid email address.');
    return e;
  },
  int(v, name, { optional = false, min = -Infinity, max = Infinity } = {}) {
    if (v == null && optional) return null;
    if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}.`);
    return v;
  },
  bool(v, name, { optional = false } = {}) { if (v == null && optional) return null; if (typeof v !== 'boolean') bad(`${name} must be true or false.`); return v; },
  enum(v, name, list, { optional = false } = {}) { if (v == null && optional) return null; if (!list.includes(v)) bad(`${name} must be one of: ${list.join(', ')}.`); return v; },
  // A time as whole milliseconds between 2000 and 2100 (a number, or text Date.parse reads).
  time(v, name) {
    const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 64 ? Date.parse(v) : NaN;
    if (!Number.isInteger(t) || t < TIME_MIN || t > TIME_MAX) bad(`${name} must be a date and time between 2000 and 2100.`);
    return t;
  },
  /**
   * A name people see (display name, nickname, title): cleaned (hub/lib/names.mjs), then its length checked. With
   * `reserved`, names that pass for Kea or the Hub's owner are refused unless `owner` (the Hub owner is the one asking).
   */
  name(v, label, { optional = false, min = 1, max = 60, reserved = null } = {}) {
    if ((v == null || v === '') && optional) return null;
    if (typeof v !== 'string') bad(`${label} must be text.`);
    const t = cleanText(v);
    if (!t && optional) return null;
    const n = [...t].length;
    if (n < min || n > max) bad(`${label} must be ${min}-${max} characters.`);
    if (reserved && !reserved.owner && isReservedName(t, reserved.ownerNames())) bad(`“${t}” is kept for Kea itself. Pick another ${label.toLowerCase()}.`);
    return t;
  },
  url(v, name) {
    const s = V.str(v, name, { optional: true, max: 500 });
    if (s == null) return null;
    let u; try { u = new URL(s); } catch { bad(`${name} must be a full https:// link.`); }
    if (u.protocol !== 'https:') bad(`${name} must be a full https:// link.`);
    return u.toString();
  },
  obj(v) { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) bad('Body must be a JSON object.'); return v; },
};

const TIME_MIN = Date.UTC(2000, 0, 1), TIME_MAX = Date.UTC(2100, 0, 1);
/** An ISO time, or null for a stored value that isn't one (an old bad row never breaks a whole list). */
export const isoOrNull = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const OWNER_TOTP_MESSAGE = 'The Kea Hub owner account needs two-step sign-in turned on first. Turn it on under Settings > Security (or in KeaS setup), then try again.';
const nameHash = (email) => sha(`login:${email}`);
const sessionCookie = (token, maxAge, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { const v = part.slice(i + 1).trim(); return /^[0-9a-f]{64}$/.test(v) ? v : null; }
  }
  return null;
}
function sameOrigin(req, secure) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return origin == null || origin === `${secure ? 'https' : 'http'}://${req.headers.host}`;
}
/**
 * Reads a request body of at most `max` bytes. A body announced (Content-Length) or found to be bigger is refused
 * without reading more of it: the answer goes out with Connection: close (handleApi), so the rest is never taken in.
 */
function readRaw(req, max, message = 'Request too large.', idleMs = FLOW_DEFAULTS.bodyIdleMs) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { req.pause(); return reject(new HttpError(413, message)); }
    let size = 0; const chunks = [];
    // A body that stops arriving is dropped soon: what it sent so far is held in memory.
    let idle = null;
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { chunks.length = 0; reject(new HttpError(408, 'The request stopped arriving.')); req.destroy(); }, idleMs);
      idle.unref?.();
    };
    const onData = (c) => {
      size += c.length;
      if (size > max) { clearTimeout(idle); req.off('data', onData); req.pause(); chunks.length = 0; reject(new HttpError(413, message)); } else { chunks.push(c); watch(); }
    };
    watch();
    req.on('data', onData);
    req.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { clearTimeout(idle); reject(e); });
    req.on('close', () => clearTimeout(idle));
  });
}
const readBody = async (req, max = MAX_BODY, idleMs) => (await readRaw(req, max, undefined, idleMs)).toString('utf8');
// Codes people type: no 0/O/1/I/L confusion. 10 characters of 31 symbols is about 49 bits, and joining is rate-limited.
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => [...randomBytes(10)].map((b) => CODE_ALPHA[b % CODE_ALPHA.length]).join('');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function makeRouter() {
  const routes = [];
  const add = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    // terms: false lets an account that hasn't agreed to the current terms still use the route.
    // basic: true lets the Hub owner's account use the route before its two-step sign-in is on (setting it up).
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, terms: opts.terms !== false, basic: opts.basic === true });
  };
  const find = (method, pathname) => {
    const r = routes.find((x) => x.method === method && x.re.test(pathname));
    if (!r) throw new HttpError(routes.some((x) => x.re.test(pathname)) ? 405 : 404, 'Not found.');
    const m = pathname.match(r.re); const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { r, params };
  };
  return { add, find };
}

const send = (res, status, payload, cookies = []) => {
  const headers = {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  };
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload ?? {}));
};

export function createHub({
  dataDir = DATA_DIR,
  dbFile = join(dataDir, 'hub.db'),
  now = () => Date.now(),
  // The header the tunnel puts the visitor's address in: 'x-forwarded-for' behind Tailscale Funnel (KeaS sets it),
  // 'cf-connecting-ip' behind Cloudflare. Only its last entry is used (hub/lib/clientip.mjs).
  ipHeader = process.env.KEA_HUB_IP_HEADER || null,
  limits = {},
  log = true,
  // Kea storage: where account files live (point this at the big drive), and each account's default limit and a
  // supporter's. Both are owner settings too (POST /owner/settings { storage }), which win over these.
  storageDir = process.env.KEA_HUB_STORAGE || join(dataDir, 'storage'),
  defaultQuotaBytes = (Number(process.env.KEA_HUB_QUOTA_GB) || 5) * 1024 ** 3,
  supporterQuotaBytes = (Number(process.env.KEA_HUB_SUPPORTER_QUOTA_GB) || 25) * 1024 ** 3,
  // Free space always left on the storage and data drives: null = the bigger of 5 GB and 2% of the drive.
  minFreeBytes = null,
  maxFileBytes = 64 * 1024 ** 2,
  // Each file also counts this much toward the limit (so millions of empty files aren't free), and there's a cap on
  // how many one account can keep.
  fileOverheadBytes = 4096,
  maxFilesPerAccount = 50_000,
  // An account whose email nobody has proven yet gets this much storage at most (until verified with Google).
  unverifiedQuotaBytes = 250 * 1024 ** 2,
  // The request log: a size-limited file of its own (hub/lib/hublog.mjs); `log` also prints it.
  logFile = null,
  // Verify with Google: the Kea OAuth client IDs whose tokens are accepted, and how to get Google's keys.
  googleClientIds = String(process.env.KEA_GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  googleKeyFn = null,
  // The web client for the /consent page's Google button (a parent signs in there, in their own browser). Its tokens
  // are accepted too. The page needs the Hub's public address listed as an authorized JavaScript origin of this client.
  googleWebClientId = String(process.env.KEA_GOOGLE_WEB_CLIENT_ID || '').trim() || null,
  // The Hub's public address, for the sign-off links members send (default: the address the request came to).
  publicUrl = String(process.env.KEA_HUB_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
  termsFile = join(dirname(fileURLToPath(import.meta.url)), 'terms', 'terms.json'),
  // The relay: how long a person's Kea waits for calls per request, and how long the worker waits for an answer.
  relayWaitMs = 20_000,
  relayAnswerMs = 120_000,
  // Limits on slow and heavy traffic (hub/lib/flow.mjs): any of them can be changed here.
  flow = {},
} = {}) {
  const F = { ...FLOW_DEFAULTS, ...flow };
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  const h = openDb(dbFile);
  const gKeys = googleKeyFn ?? googleKeys({ nowFn: now });
  const key = loadOrCreateKey(join(dataDir, 'hub-signing-key.pem'));
  const ownerKeyFile = join(dataDir, 'owner.key');
  if (!existsSync(ownerKeyFile)) writeSecretFile(ownerKeyFile, randomBytes(32).toString('hex'));
  // The owner key is read again whenever the file changes, so `node hub/owner.mjs rotate-key` works without a restart.
  let ownerKeyCache = { stamp: null, key: '' };
  const ownerKeyNow = () => {
    let st = null;
    try { st = statSync(ownerKeyFile); } catch {}
    const stamp = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'none';
    if (stamp !== ownerKeyCache.stamp) ownerKeyCache = { stamp, key: st ? readFileSync(ownerKeyFile, 'utf8').trim() : '' };
    return ownerKeyCache.key;
  };
  ownerKeyNow();
  const nonces = ownerNonces(now);
  // TOTP secrets are kept sealed (hub/lib/totp.mjs). Ones stored before that are sealed now.
  const totpKey = totpKeyFrom(key.privateKey);
  for (const a of h.all('SELECT id, totp_secret FROM accounts WHERE totp_secret IS NOT NULL')) {
    if (!isSealed(a.totp_secret)) h.run('UPDATE accounts SET totp_secret = ? WHERE id = ?', sealSecret(totpKey, a.totp_secret, a.id), a.id);
  }
  /** An account's TOTP secret (base32), or null. A secret that doesn't open (tampered with) counts as none. */
  const totpSecretOf = (a) => { try { return openSecret(totpKey, a.totp_secret, a.id); } catch { return null; } };
  const checkTotp = (a, code) => { const s = totpSecretOf(a); return s ? checkCode(s, code, now(), a.totp_last_step) : null; };
  const windows = new Windows();
  const fails = failures(h, now);
  // phone: changes to the phone number, per account per day.
  // joinRequest: requests to join someone else's course section, per account per day (each one notifies the section).
  // pwcheck: password checks with a session (changing it, two-step changes), per account. google: verifying with Google
  // while signed in, per account. Buckets (rate a second, burst): rps per address and rpsAll for everyone, before
  // anything else; authAll for all sign-ins and sign-ups together (each costs a password hash); writes per account.
  const L = {
    login: [30, 10 * 60_000], register: [5, 60 * 60_000], join: [20, 10 * 60_000], answer: [240, 60_000], phone: [5, 86400_000], joinRequest: [10, 86400_000],
    pwcheck: [10, 10 * 60_000], google: [10, 10 * 60_000],
    rps: [20, 60], rpsAll: [2000, 4000], authAll: [20, 200], writes: [20, 100],
    ...limits,
  };
  // An address that can stand for many people (the tunnel's own loopback address, when the Hub can't tell clients
  // apart) gets SHARED_FACTOR times the limit, so a few bad requests can't lock everyone out of the Hub.
  const SHARED_FACTOR = 20;
  const limit = (kind, who) => {
    const [base, ms] = L[kind];
    const n = isLoopback(who) || who === 'unknown' ? base * SHARED_FACTOR : base;
    const wait = windows.hit(`${kind}:${ipBucket(String(who))}`, n, ms, now());
    if (wait > 0) throw new HttpError(429, `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`, { retryAfter: Math.ceil(wait / 1000) });
  };
  // Names only the owner may use (hub/lib/names.mjs): Kea's own, and the owner's display name.
  const ownerNames = () => h.all("SELECT display_name FROM accounts WHERE role = 'owner'").map((r) => r.display_name);
  const reservedFor = (me) => ({ owner: me?.role === 'owner', ownerNames });
  // ---------- load: cheap checks before anything else, and what's busy (shown in /owner/stats) ----------
  const buckets = new Buckets();
  const busy = { rejected: 0, shed: 0, lagMs: 0, maxLagMs: 0, downloads: 0, uploads: 0, connections: 0, refusedConnections: 0, slowDropped: 0 };
  let lagAt = Date.now();
  const lagTimer = setInterval(() => { const t = Date.now(); busy.lagMs = Math.max(0, t - lagAt - 100); busy.maxLagMs = Math.max(busy.maxLagMs, busy.lagMs); lagAt = t; }, 100);
  lagTimer.unref?.();
  /** Every sign-in and sign-up together (each costs a password hash): past the budget, "busy" at once. */
  const authBudget = () => { const [rate, burst] = L.authAll; if (buckets.take('auth:all', rate, burst, Date.now()) > 0) throw new Busy('Many people are signing in right now. Try again in a few seconds.'); };
  // Concurrency slots: downloads and uploads per account, per address and in all.
  const slots = new Map();
  function takeSlots(list) {
    for (const [k, max] of list) if ((slots.get(k) || 0) >= max) return null;
    for (const [k] of list) slots.set(k, (slots.get(k) || 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; for (const [k] of list) { const n = (slots.get(k) || 1) - 1; if (n) slots.set(k, n); else slots.delete(k); } };
  }
  // Bytes in and out per day (per account and for everyone), for the owner's daily budgets. In memory: a restart
  // starts the day's count again.
  const daily = new Map();
  const dayCount = (key) => daily.get(`${dayKey(now())}|${key}`) || 0;
  const dayAdd = (key, n) => {
    const today = dayKey(now()), k = `${today}|${key}`;
    daily.set(k, (daily.get(k) || 0) + n);
    if (daily.size > 20_000) for (const kk of daily.keys()) if (!kk.startsWith(today)) daily.delete(kk);
  };
  const hlog = createHubLog({ file: logFile, toConsole: !!log });
  const audit = (actor, action, target, detail, ip) =>
    h.run('INSERT INTO audit (at,actor,action,target,detail,ip) VALUES (?,?,?,?,?,?)', now(), actor ?? null, action, target ?? null, detail == null ? null : JSON.stringify(detail), ip ?? null);
  const getSetting = (k, fallback) => { const r = h.get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : fallback; };
  const setSetting = (k, v) => h.run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));

  // ---------- notifications ----------
  // One person's notices. Kept to the newest 500 each; read ones go after 180 days (sweep below).
  const NOTE_KEEP = 500;
  const notify = (accountId, kind, title, body = '', { note = null, data = null } = {}) => {
    if (!accountId) return null;
    const r = h.run('INSERT INTO notifications (account_id,kind,title,body,note,data,created_at) VALUES (?,?,?,?,?,?,?)', accountId, kind, String(title).slice(0, 200), String(body ?? '').slice(0, 4000), note ? String(note).slice(0, 2000) : null, data == null ? null : JSON.stringify(data), now());
    h.run('DELETE FROM notifications WHERE account_id = ? AND id <= (SELECT id FROM notifications WHERE account_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', accountId, accountId, NOTE_KEEP);
    return Number(r.lastInsertRowid);
  };
  const noteOut = (n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, note: n.note, data: n.data ? JSON.parse(n.data) : null, createdAt: n.created_at, readAt: n.read_at });
  const unreadCount = (accountId) => h.get('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL', accountId).n;

  // ---------- terms ----------
  const termsRow = (n) => h.get('SELECT * FROM terms_versions WHERE n = ?', n);
  const currentTerms = () => {
    const r = h.get('SELECT * FROM terms_versions ORDER BY n DESC LIMIT 1');
    return r && { ...r, sections: JSON.parse(r.sections) };
  };
  const publishTerms = (doc) => {
    const t = checkTerms(doc);
    const cur = currentTerms();
    if (cur && sameSections(cur.sections, t.sections) && cur.title === t.title) return { n: cur.n, published: false };
    const r = h.run('INSERT INTO terms_versions (label,title,summary,sections,published_at) VALUES (?,?,?,?,?)', t.label, t.title, t.summary, JSON.stringify(t.sections), now());
    audit('owner', 'terms.publish', String(r.lastInsertRowid), { label: t.label }, 'local');
    return { n: Number(r.lastInsertRowid), published: true };
  };
  // The terms file that ships with the Hub: published the first time, and again whenever an update of the Hub brings a
  // changed file (everyone then re-agrees to only what changed). Terms the owner published from the console stay until
  // the file itself changes.
  {
    const text = readFileSync(termsFile, 'utf8');
    const fileHash = sha(JSON.stringify(JSON.parse(text))); // (the same however its line endings were checked out)
    const seen = h.get("SELECT value FROM settings WHERE key = 'termsFileHash'");
    if (!currentTerms() || (seen && JSON.parse(seen.value) !== fileHash)) publishTerms(JSON.parse(text));
    h.run("INSERT INTO settings (key,value) VALUES ('termsFileHash',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(fileHash));
  }
  const acceptedVersion = (accountId) => h.get('SELECT MAX(version) AS v FROM terms_acceptances WHERE account_id = ?', accountId)?.v ?? null;
  const termsStatus = (accountId) => {
    const cur = currentTerms();
    const accepted = acceptedVersion(accountId);
    return { current: cur.n, accepted, needsAgreement: accepted !== cur.n };
  };
  /** Records agreement; every section of the current version must be listed. */
  const recordAgreement = (accountId, body, ip, client) => {
    const cur = currentTerms();
    if (body.termsVersion !== cur.n) throw new HttpError(409, 'The terms changed. Read the latest version and agree to it.', { termsVersion: cur.n });
    const agreed = new Set(Array.isArray(body.termsSections) ? body.termsSections : []);
    const missing = cur.sections.filter((s) => !agreed.has(s.id)).map((s) => s.id);
    if (missing.length) bad('Agree to every section of the terms.', { missing });
    h.run('INSERT OR IGNORE INTO terms_acceptances (account_id,version,sections,at,ip,client) VALUES (?,?,?,?,?,?)', accountId, cur.n, JSON.stringify(cur.sections.map((s) => s.id)), now(), ip ?? null, client ?? null);
  };

  // ---------- Google ----------
  const google = async (idToken) => {
    if (typeof idToken !== 'string' || idToken.length > 8000) bad('Missing Google sign-in.');
    let g;
    try { g = await verifyGoogleIdToken(idToken, { clientIds: googleWebClientId ? [...googleClientIds, googleWebClientId] : googleClientIds, keys: gKeys, nowMs: now() }); }
    catch (e) { throw new HttpError(e.status ?? 401, e.message); }
    // Each Google sign-in can be used once.
    const th = sha(`google:${idToken}`);
    if (h.get('SELECT 1 FROM google_tokens_used WHERE token_hash = ?', th)) throw new HttpError(401, 'That Google sign-in was already used. Try again.');
    h.run('INSERT INTO google_tokens_used (token_hash,at) VALUES (?,?)', th, now());
    h.run('DELETE FROM google_tokens_used WHERE at < ?', now() - 86400_000);
    return g;
  };
  const markGoogleVerified = (accountId, g) =>
    h.run("UPDATE accounts SET email_verified = 1, verified_by = 'Google', google_sub = ?, updated_at = ? WHERE id = ?", g.sub, now(), accountId);
  // A code's time step is used once: the step is claimed in one statement, so two sign-ins sent at the same moment with
  // the same code (read before either awaited the password check) can't both get in.
  const claimStep = (id, step) => Number(h.run('UPDATE accounts SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, id, step).changes) === 1;
  // Two-step sign-in. A missing code counts as a failure too: "code needed" only comes after a correct password, so it
  // would otherwise let someone test passwords without ever being throttled. (Kea's normal first try without a code
  // costs one count, which the successful sign-in right after clears.)
  const requireTotp = (a, code, nh, ipKey, ip) => {
    if (!a.totp_enabled) return;
    if (code == null || code === '') { fails.fail(nh, ipKey); throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { totpRequired: true }); }
    const step = checkTotp(a, code);
    if (step == null || !claimStep(a.id, step)) { fails.fail(nh, ipKey); audit(a.id, 'auth.fail_totp', null, null, ip); throw new HttpError(401, 'That code is wrong or already used.', { totpRequired: true }); }
  };
  const lockedError = (ms, everywhere) => new HttpError(429, everywhere
    ? `Too many wrong tries for this account from many places. Wait ${Math.ceil(ms / 1000)} seconds, or sign in with Google.`
    : `Too many wrong tries for this account. Wait ${Math.ceil(ms / 1000)} seconds.`, { retryAfter: Math.ceil(ms / 1000) });

  // ---------- storage ----------
  // Everyone gets the default; a supporter gets at least the supporter size; the owner can set any size for one
  // person (accounts.quota_bytes), and a supporter keeps the bigger of that and the supporter size. Nothing is ever
  // deleted when a limit drops below what someone uses: they just can't add more until they're under it again.
  // The owner's limits for everyone together (null = none): all storage, and new bytes per day per account and in all.
  // An account whose email isn't verified gets at most unverifiedQuotaBytes, so throwaway accounts can't fill the drive.
  const storageSettings = () => {
    const s = getSetting('storage', {});
    const ok = (v) => Number.isFinite(v) && v >= 0;
    const or = (v, d) => (ok(v) ? v : d);
    return {
      defaultQuotaBytes: or(s.defaultQuotaBytes, defaultQuotaBytes), supporterQuotaBytes: or(s.supporterQuotaBytes, supporterQuotaBytes),
      unverifiedQuotaBytes: or(s.unverifiedQuotaBytes, unverifiedQuotaBytes),
      globalBytes: ok(s.globalBytes) ? s.globalBytes : null,
      dailyAccountBytes: or(s.dailyAccountBytes, 5 * 1024 ** 3), dailyGlobalBytes: or(s.dailyGlobalBytes, 100 * 1024 ** 3),
      dailyEgressBytes: or(s.dailyEgressBytes, 50 * 1024 ** 3),
    };
  };
  const supporterActive = (a) => a.supporter_until != null && a.supporter_until > now();
  const quotaOf = (a, S = storageSettings()) => {
    let base = a.quota_bytes == null ? S.defaultQuotaBytes : a.quota_bytes;
    if (a.quota_bytes == null && !a.email_verified && a.role !== 'owner') base = Math.min(base, S.unverifiedQuotaBytes);
    return supporterActive(a) ? Math.max(base, S.supporterQuotaBytes) : base;
  };
  // What an account uses: kept in accounts.used_bytes and file_count by triggers on the files table (hub/db.mjs), so
  // checking it is one row, not a sum over every file. Each file also counts fileOverheadBytes.
  const usage = (accountId) => h.get('SELECT used_bytes, file_count FROM accounts WHERE id = ?', accountId) ?? { used_bytes: 0, file_count: 0 };
  const usedBy = (accountId) => { const u = usage(accountId); return u.used_bytes + u.file_count * fileOverheadBytes; };
  const storageOut = (a) => {
    const used = usedBy(a.id), quota = quotaOf(a), S = storageSettings();
    return { used, quota, over: used > quota, custom: a.quota_bytes != null, supporter: supporterActive(a), standard: S.defaultQuotaBytes, supporterQuota: S.supporterQuotaBytes,
      files: usage(a.id).file_count, maxFiles: maxFilesPerAccount, unverifiedLimit: a.quota_bytes == null && !a.email_verified && a.role !== 'owner' ? S.unverifiedQuotaBytes : null };
  };
  /** Refuses a write that would leave less free space than the minimum on the storage drive or the data drive. */
  function checkDisk(size) {
    for (const d of new Set([storageDir, dataDir])) {
      let fs;
      try { fs = statfsSync(d); } catch { continue; }
      const keep = minFreeBytes != null ? minFreeBytes : Math.max(5 * 1024 ** 3, Math.floor(fs.blocks * fs.bsize * 0.02));
      if (fs.bavail * fs.bsize - size < keep) throw new HttpError(507, "The Kea Hub's drive is nearly full. Try again later.", { storageFull: true });
    }
  }
  /** The owner's storage budgets: all storage together, and new bytes today (this account's and everyone's). */
  function checkBudgets(me, size) {
    const S = storageSettings();
    if (S.globalBytes != null && h.get('SELECT COALESCE(SUM(used_bytes),0) AS s FROM accounts').s + size > S.globalBytes) throw new HttpError(507, 'The Kea Hub’s storage is full right now. Nothing of yours was deleted; try again later.', { storageFull: true });
    if (me.role !== 'owner' && dayCount(`in:${me.id}`) + size > S.dailyAccountBytes) throw new HttpError(429, `You’ve uploaded ${fmtBytes(dayCount(`in:${me.id}`))} today, the most for one day. The rest can go up tomorrow.`, { retryAfter: 3600 });
    if (me.role !== 'owner' && dayCount('in:*') + size > S.dailyGlobalBytes) throw new HttpError(503, 'The Kea Hub has taken in all it can for today. Try again tomorrow.', { retryAfter: 3600 });
  }
  /** Says plainly what a smaller limit means for someone already over it. */
  /** After the standard or supporter size changed: a notice to everyone whose storage changed because of it. */
  function noticeStorageChange(before, after) {
    for (const a of h.all('SELECT * FROM accounts')) {
      const was = quotaOf(a, before), is = quotaOf(a, after);
      if (was === is) continue;
      const used = usedBy(a.id);
      const body = is < was && used > is ? overText(used, is) : is < was ? `You’re using ${fmtBytes(used)}, so nothing changes for what you have now.` : '';
      notify(a.id, 'storage', `Your Kea storage is now ${fmtBytes(is)}`, body, { data: { quota: is, previous: was } });
    }
  }
  const overText = (used, quota) => `You’re using ${fmtBytes(used)}, which is more than that. Nothing has been deleted: your files stay, and you can still open, change and delete them. New files wait until you’re under ${fmtBytes(quota)} again.`;
  const blobPath = (accountId, blob) => join(storageDir, accountId, blob);
  // A storage "space": one person's files, or a course section's shared folder. Same rules for both: files on disk
  // under random names, versions in the database, atomic writes.
  const spaces = {
    user: (id) => ({ table: 'files', col: 'account_id', id, dir: join(storageDir, id) }),
    course: (key) => ({ table: 'course_files', col: 'course_key', id: key, dir: join(storageDir, 'courses', sha(`course:${key}`).slice(0, 32)) }),
  };
  const spaceRow = (sp, p) => h.get(`SELECT * FROM ${sp.table} WHERE ${sp.col} = ? AND path = ?`, sp.id, p);
  const spaceList = (sp, prefix = '', since = 0) =>
    h.all(`SELECT path, size, version, sha256, updated_at FROM ${sp.table} WHERE ${sp.col} = ? AND substr(path, 1, length(?)) = ? AND updated_at > ? ORDER BY path`, sp.id, prefix, prefix, since)
      .map((f) => ({ path: f.path, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updated_at }));
  const spaceRead = (sp, row) => readFileSync(join(sp.dir, row.blob));
  function spaceWrite(sp, p, data) {
    checkDisk(data.length);
    const row = spaceRow(sp, p);
    const blob = randomUUID();
    mkdirSync(sp.dir, { recursive: true });
    writeFileSync(join(sp.dir, `${blob}.tmp`), data);
    renameSync(join(sp.dir, `${blob}.tmp`), join(sp.dir, blob));
    const version = (row?.version ?? 0) + 1;
    const hash = createHash('sha256').update(data).digest('hex');
    h.run(`INSERT INTO ${sp.table} (${sp.col},path,blob,size,version,sha256,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(${sp.col},path) DO UPDATE SET blob=excluded.blob, size=excluded.size, version=excluded.version, sha256=excluded.sha256, updated_at=excluded.updated_at`,
      sp.id, p, blob, data.length, version, hash, now());
    if (row) rmSync(join(sp.dir, row.blob), { force: true });
    return { path: p, version, size: data.length, sha256: hash };
  }
  function spaceDeletePrefix(sp, prefix) {
    for (const r of h.all(`SELECT * FROM ${sp.table} WHERE ${sp.col} = ? AND substr(path, 1, length(?)) = ?`, sp.id, prefix, prefix)) rmSync(join(sp.dir, r.blob), { force: true });
    h.run(`DELETE FROM ${sp.table} WHERE ${sp.col} = ? AND substr(path, 1, length(?)) = ?`, sp.id, prefix, prefix);
  }
  const rawOut = (data, headers = {}) => ({ __raw: data, headers });
  // Pacing what the Hub sends, so big downloads never fill the owner's home upload: everything over 16 KB (files and
  // big JSON answers alike) shares one budget of maxSendMbps, and each account gets a fair share of it while several
  // download at once. Files are streamed from disk, never read whole into memory. A client that stops reading for
  // DRAIN_MS is cut off.
  const SMALL = 16 * 1024, CHUNK = 64 * 1024, DRAIN_MS = 30_000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const activeSenders = new Map();
  const drained = (res, ms = DRAIN_MS) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { busy.slowDropped++; res.destroy(); reject(new Error('The client stopped reading.')); }, ms);
    const done = () => { clearTimeout(t); res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
  /**
   * A small answer counts toward the account's egress too: a cheap counter, and it only waits when that account is over
   * its share (many small files from many addresses are as much traffic as one big one).
   */
  async function countSmall(who, bytes) {
    if (!who) return;
    dayAdd(`out:${who}`, bytes);
    const rate = (Math.max(1, limitsNow().maxSendMbps) * 1e6) / 8 / Math.max(1, activeSenders.size);
    // (Its own count: a big download just finished mustn't hold up the next sync file.)
    const wait = buckets.spend(`small:${who}`, rate, F.smallEgressBurstBytes, Date.now(), bytes);
    if (wait > 0) await sleep(Math.min(wait, 10_000));
  }
  /** Sends a Buffer or a readable stream (headers already written), paced; `who` is the account it counts for. */
  async function sendPaced(res, src, who = null) {
    if (Buffer.isBuffer(src) && src.length <= SMALL) { await countSmall(who, src.length); res.end(src); return; }
    if (who) activeSenders.set(who, (activeSenders.get(who) || 0) + 1);
    // Only the time spent waiting for the client counts here (not the pacing above, not a slow disk): a client that
    // keeps a download open by reading a trickle is dropped.
    let blockedMs = 0, blockedBytes = 0;
    try {
      const chunks = Buffer.isBuffer(src) ? (function* () { for (let o = 0; o < src.length; o += CHUNK) yield src.subarray(o, o + CHUNK); })() : src;
      for await (const part of chunks) {
        const rate = (Math.max(1, limitsNow().maxSendMbps) * 1e6) / 8;
        let wait = buckets.spend('egress:all', rate, CHUNK * 2, Date.now(), part.length);
        if (who) {
          const share = rate / Math.max(1, activeSenders.size);
          wait = Math.max(wait, buckets.spend(`egress:${who}`, share, CHUNK * 2, Date.now(), part.length));
          dayAdd(`out:${who}`, part.length);
        }
        if (wait > 0) await sleep(Math.min(wait, 10_000));
        if (res.destroyed) return;
        blockedBytes += part.length;
        if (!res.write(part)) {
          const t = Date.now();
          await drained(res, Math.min(DRAIN_MS, F.minRateWindowMs));
          blockedMs += Date.now() - t;
        }
        if (blockedMs >= F.minRateWindowMs) {
          if (blockedBytes < (F.minRateBytes * blockedMs) / 1000) { busy.slowDropped++; res.destroy(); return; }
          blockedMs = 0; blockedBytes = 0;
        }
      }
      res.end();
    } catch {
      res.destroy();
    } finally {
      if (who) { const n = (activeSenders.get(who) || 1) - 1; if (n) activeSenders.set(who, n); else activeSenders.delete(who); }
      if (!Buffer.isBuffer(src)) src.destroy?.();
    }
  }

  const publicAccount = (a) => ({
    id: a.id, email: a.email, displayName: a.display_name, role: a.role, status: a.status,
    emailVerified: !!a.email_verified, verifiedBy: a.verified_by, identityVerified: !!a.identity_verified,
    canHost: !!a.can_host || a.role === 'owner', totpEnabled: !!a.totp_enabled, owner: a.role === 'owner', createdAt: a.created_at,
    birthYear: a.birth_year ?? null, ...consentOf(a),
    leaderboard: { show: a.board_default || 'name', nickname: a.nickname ?? null },
    supporter: { active: supporterActive(a), until: a.supporter_until ?? null, since: a.supporter_since ?? null },
    phone: { number: a.phone ?? null, visibility: a.phone_visibility || 'nobody' },
  });
  // (publicAccount is the person's own view, and the owner console's. Other people only see what member lists pick
  // out with extrasFor: the supporter badge, and the phone number where its owner allowed it.)
  /** Besides a name, what a member list ('classes' or 'orgs') may show about someone. */
  const extrasFor = (row, where, { phone = true } = {}) => ({
    supporter: row.supporter_until != null && row.supporter_until > now(),
    ...(phone && row.phone && phoneShownIn(row.phone_visibility, where) ? { phone: row.phone } : {}),
  });
  // ---------- parent or guardian sign-off (members under 18, before the shared Claude) ----------
  const thisYear = () => new Date(now()).getUTCFullYear();
  const parentApproved = (accountId) => !!h.get("SELECT 1 FROM parent_consents WHERE account_id = ? AND status = 'approved'", accountId);
  /** { minor, parentSignOff: 'not_needed' | 'needed' | 'pending' | 'approved', parentEmail } for the apps. */
  function consentOf(a) {
    const under = limitsNow().parentConsentUnder;
    const minor = a.role !== 'owner' && isMinor(a.birth_year, thisYear(), under);
    if (!minor) return { minor: false, parentSignOff: 'not_needed', parentEmail: null };
    const last = h.get("SELECT * FROM parent_consents WHERE account_id = ? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1", a.id);
    if (last?.status === 'approved' || parentApproved(a.id)) return { minor: true, parentSignOff: 'approved', parentEmail: last?.parent_email ?? null };
    if (last && last.expires_at > now()) return { minor: true, parentSignOff: 'pending', parentEmail: last.parent_email };
    return { minor: true, parentSignOff: 'needed', parentEmail: null };
  }
  const birthYearOf = (v) => {
    const y = V.int(v, 'Birth year', { min: 1900, max: thisYear() });
    if (thisYear() - y < 13) bad('Kea accounts are for people 13 and older.');
    return y;
  };
  // A parent's email (or Google account) that belongs to a Kea account under 18 can't sign off: that's a teen with a
  // second account, not a parent.
  const MINOR_PARENT = 'That email belongs to a Kea account under 18. A parent or guardian signs off with their own email.';
  const minorParent = ({ email = null, sub = null }) => h.all('SELECT birth_year, role FROM accounts WHERE email = ? OR (google_sub IS NOT NULL AND google_sub = ?)', email, sub)
    .some((a) => a.role !== 'owner' && isMinor(a.birth_year, thisYear(), 18));
  function approveConsent(c, method, g, ip) {
    h.tx(() => {
      h.run("UPDATE parent_consents SET status = 'approved', method = ?, parent_google_sub = ?, decided_at = ? WHERE id = ?", method, g?.sub ?? null, now(), c.id);
      h.run("UPDATE parent_consents SET status = 'revoked', decided_at = ? WHERE account_id = ? AND status = 'pending' AND id != ?", now(), c.account_id, c.id);
    });
    audit(c.account_id, 'consent.approve', c.id, { method, parent: c.parent_email }, ip);
    notify(c.account_id, 'parent_signoff', 'Your parent or guardian signed off', 'Kea’s shared Claude works for you now.', { data: { status: 'approved' } });
  }
  const newSession = (accountId, client) => {
    const token = randomBytes(32).toString('hex');
    const t = now();
    h.run('INSERT INTO sessions (token_hash,account_id,created_at,expires_at,last_seen,client) VALUES (?,?,?,?,?,?)', sha(token), accountId, t, t + SESSION_DAYS * 86400_000, t, client ?? null);
    return token;
  };
  const progressOf = (accountId, classId = null) => {
    const where = classId ? 'account_id = ? AND class_id = ?' : 'account_id = ?';
    const args = classId ? [accountId, classId] : [accountId];
    const total = h.get(`SELECT COALESCE(SUM(points),0) AS s FROM xp_events WHERE ${where}`, ...args).s;
    const today = h.get('SELECT COALESCE(SUM(points),0) AS s FROM xp_events WHERE account_id = ? AND day = ?', accountId, dayKey(now())).s;
    const days = h.all('SELECT DISTINCT day FROM xp_events WHERE account_id = ? ORDER BY day DESC LIMIT 400', accountId).map((r) => r.day);
    return { ...levelOf(total), today, streak: streak(days, now()) };
  };

  // ---------- membership helpers ----------
  const membership = (classId, accountId) => h.get('SELECT * FROM class_members WHERE class_id = ? AND account_id = ?', classId, accountId);
  const loadClass = (id) => h.get('SELECT * FROM classes WHERE id = ?', id) ?? notFound('Class not found.');
  // A class that belongs to an organization works only while the owner has the organization approved (active).
  const orgActive = (orgId) => !orgId || h.get('SELECT status FROM orgs WHERE id = ?', orgId)?.status === 'active';
  const ORG_CLASS_OFF = 'This class belongs to an organization that isn’t active on the Kea Hub right now.';
  const ACTIVE_ORG_SQL = "(c.org_id IS NULL OR c.org_id IN (SELECT id FROM orgs WHERE status = 'active'))";
  const asMember = (classId, me) => {
    const c = loadClass(classId);
    const m = membership(classId, me.id);
    if (!m && me.role !== 'owner') notFound('Class not found.');
    if (!orgActive(c.org_id) && me.role !== 'owner') forbidden(ORG_CLASS_OFF);
    return { c, m: m ?? { role: 'instructor', owner: true } };
  };
  const asTeacher = (classId, me) => {
    const x = asMember(classId, me);
    if (!['instructor', 'ta'].includes(x.m.role)) forbidden('Only the class instructors can do that.');
    return x;
  };
  const asInstructor = (classId, me) => {
    const x = asMember(classId, me);
    if (x.m.role !== 'instructor') forbidden('Only the class instructor can do that.');
    return x;
  };
  const classOut = (c, m) => ({
    id: c.id, title: c.title, description: c.description, kind: c.kind, status: c.status, meetingUrl: c.meeting_url, createdAt: c.created_at,
    role: m?.role ?? null, board: m?.board ?? null, nickname: m?.nickname ?? null,
    members: h.get('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?', c.id).n,
    instructors: h.all("SELECT a.display_name AS name, a.identity_verified AS v, a.role AS r FROM class_members m JOIN accounts a ON a.id = m.account_id WHERE m.class_id = ? AND m.role = 'instructor'", c.id)
      .map((x) => ({ name: x.name, verified: !!x.v || x.r === 'owner' })),
  });
  const boardName = (row) => (row.board === 'nickname' && row.nickname ? row.nickname : row.board === 'hidden' ? null : row.display_name);
  const sessionOut = (s) => ({ id: s.id, classId: s.class_id, title: s.title, start: isoOrNull(s.start_at), end: isoOrNull(s.end_at), location: s.location, meetingUrl: s.meeting_url, notes: s.notes });

  // ---------- supporters, and the owner's view of an account ----------
  function supporterEnded(a, note = null) {
    const used = usedBy(a.id), quota = quotaOf(a);
    notify(a.id, 'supporter', 'Your supporter time has ended. Thank you!',
      `The supporter badge is gone and your Kea storage is ${fmtBytes(quota)} again.${used > quota ? ` ${overText(used, quota)}` : ''}`,
      { note, data: { until: a.supporter_until } });
  }
  /** Everything the owner sees and can set for one account. */
  const ownerView = (a) => {
    const o = overrideOf(a), L = limitsOf(a);
    const shown = (v) => (Number.isFinite(v) ? v : null);
    return {
      ...publicAccount(a),
      storage: storageOut(a), quotaOverride: a.quota_bytes ?? null,
      sharedClaude: { ...o, limits: o.limits, applies: Object.fromEntries(ACCOUNT_LIMITS.map((k) => [k, shown(L[k])])) },
      unreadNotifications: unreadCount(a.id),
    };
  };
  // Supporter time that ran out gets a notice (once), and old read notices go. Runs hourly, and when someone looks.
  let sweptAt = 0;
  function sweep(force = false) {
    if (!force && now() - sweptAt < 60_000) return;
    sweptAt = now();
    for (const a of h.all('SELECT * FROM accounts WHERE supporter_until IS NOT NULL AND supporter_until <= ? AND supporter_lapse_noted = 0', now())) {
      h.run('UPDATE accounts SET supporter_lapse_noted = 1 WHERE id = ?', a.id);
      supporterEnded(a);
    }
    h.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?', now() - 180 * DAY_MS);
    // Routine sign-in records (auth.*) go after the owner's setting (default 365 days); changes to accounts stay.
    h.run("DELETE FROM audit WHERE action LIKE 'auth.%' AND at < ?", now() - auditKeepDays() * DAY_MS);
    // Once a day: what's only kept for a while.
    if (force || now() - (getSetting('prunedAt', 0) || 0) > DAY_MS) prune();
  }
  function prune() {
    setSetting('prunedAt', now());
    h.run('DELETE FROM sessions WHERE expires_at < ?', now());
    h.run('DELETE FROM login_failures WHERE last_at < ?', now() - DAY_MS);
    h.run('DELETE FROM login_fail_pairs WHERE last_at < ?', now() - DAY_MS);
    h.run('DELETE FROM scan_requests WHERE at < ?', now() - 30 * DAY_MS);
    h.run("DELETE FROM course_join_requests WHERE status != 'pending' AND COALESCE(decided_at, created_at) < ?", now() - 30 * DAY_MS);
    h.run('DELETE FROM google_tokens_used WHERE at < ?', now() - DAY_MS);
  }
  const sweepTimer = setInterval(() => { try { sweep(true); } catch (e) { console.error(e); } }, 3600_000);
  sweepTimer.unref?.();
  // The standard storage size changed since the Hub last ran (an update, or KeaS's setting): a notice to everyone it
  // changes for. Before this was recorded, the standard size was 25 GB.
  {
    const seen = getSetting('storageSeen', null);
    const cur = storageSettings();
    const hadAccounts = !!h.get('SELECT 1 FROM accounts LIMIT 1');
    const was = seen ?? (hadAccounts ? { defaultQuotaBytes: 25 * 1024 ** 3, supporterQuotaBytes: cur.supporterQuotaBytes } : cur);
    if (was.defaultQuotaBytes !== cur.defaultQuotaBytes || was.supporterQuotaBytes !== cur.supporterQuotaBytes) noticeStorageChange(was, cur);
    setSetting('storageSeen', cur);
  }

  // ---------- deleting an account ----------
  // Removes the account and everything kept for it: sessions, files (and their blobs on disk), notifications, phone,
  // parent sign-offs, study progress and points, shared-Claude jobs and requests, flags, class/section/org memberships,
  // and its rows in organization tables. Audit rows are kept but anonymized (no account id, address or details).
  // Refused while it would leave an organization or a class with members but no owner: hand those over first.
  function deleteAccount(a, by, ip) {
    const blockers = [];
    for (const o of h.all("SELECT o.id, o.name FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = ? AND m.role = 'owner'", a.id)) {
      const otherOwners = h.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner' AND account_id != ?", o.id, a.id).n;
      const others = h.get('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND account_id != ?', o.id, a.id).n;
      if (!otherOwners && others) blockers.push({ kind: 'org', id: o.id, name: o.name });
    }
    for (const c of h.all('SELECT * FROM classes WHERE owner_id = ?', a.id)) {
      const heir = h.get("SELECT 1 FROM class_members WHERE class_id = ? AND role = 'instructor' AND account_id != ?", c.id, a.id);
      const others = h.get('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND account_id != ?', c.id, a.id).n;
      if (!heir && others) blockers.push({ kind: 'class', id: c.id, name: c.title });
    }
    if (blockers.length) {
      throw new HttpError(409, `This account can’t be deleted yet. It’s the only owner of ${blockers.map((b) => `${b.kind === 'org' ? 'the organization' : 'the class'} “${b.name}”`).join(' and ')}. Make someone else an owner (or instructor) first, or remove its members.`, { blockers });
    }
    const running = h.all("SELECT id FROM scan_jobs WHERE account_id = ? AND status = 'running'", a.id).map((j) => j.id);
    h.tx(() => {
      // Organizations they made: handed to another owner (or member), or deleted when they were its only member.
      for (const o of h.all('SELECT id FROM orgs WHERE created_by = ?', a.id)) {
        const heir = h.get("SELECT account_id FROM org_members WHERE org_id = ? AND account_id != ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at LIMIT 1", o.id, a.id);
        if (heir) h.run('UPDATE orgs SET created_by = ? WHERE id = ?', heir.account_id, o.id);
        else h.run('DELETE FROM orgs WHERE id = ?', o.id);
      }
      // Classes they made: to another instructor, or deleted when nobody else is in them.
      for (const c of h.all('SELECT id FROM classes WHERE owner_id = ?', a.id)) {
        const heir = h.get("SELECT account_id FROM class_members WHERE class_id = ? AND role = 'instructor' AND account_id != ? ORDER BY joined_at LIMIT 1", c.id, a.id);
        if (heir) h.run('UPDATE classes SET owner_id = ? WHERE id = ?', heir.account_id, c.id);
        else h.run('DELETE FROM classes WHERE id = ?', c.id);
      }
      // Every table that keeps rows per account (organization tables too, some of which have no foreign key).
      for (const { name } of h.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('accounts','audit') AND name NOT LIKE 'sqlite_%'")) {
        const cols = new Set(h.db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
        if (name === 'org_shifts' && cols.has('account_id')) { h.db.prepare('UPDATE org_shifts SET account_id = NULL WHERE account_id = ?').run(a.id); continue; }
        for (const col of ['account_id', 'from_account', 'claimant']) if (cols.has(col)) h.db.prepare(`DELETE FROM "${name}" WHERE "${col}" = ?`).run(a.id);
      }
      h.run('DELETE FROM accounts WHERE id = ?', a.id);
      h.run("UPDATE audit SET actor = 'deleted-account', ip = NULL, detail = NULL WHERE actor = ?", a.id);
      h.run('UPDATE audit SET target = NULL, detail = NULL WHERE target = ?', a.id);
      h.run("UPDATE audit SET detail = NULL WHERE detail LIKE '%' || ? || '%'", a.id);
    });
    for (const id of running) dropRelay(id, 'The account was deleted.');
    fails.clearAll(nameHash(a.email));
    rmSync(join(storageDir, a.id), { recursive: true, force: true });
    audit(by === a.id ? 'deleted-account' : 'owner', 'account.delete', null, { ref: sha(`deleted:${a.id}`).slice(0, 16), by: by === a.id ? 'self' : 'owner' }, by === a.id ? null : ip);
  }
  const auditKeepDays = () => { const d = getSetting('auditKeepDays', 365); return Number.isInteger(d) && d >= 30 ? d : 365; };

  // ================= public API =================
  const api = makeRouter();
  const R = api.add;

  R('GET', '/v1/health', () => ({ ok: true, service: 'kea-hub', version: VERSION }), { auth: false });
  R('GET', '/v1/keys', () => ({ keys: [key.jwk] }), { auth: false });
  // Proves this is the Hub whose signing key is in its data folder: signs the caller's random nonce. KeaS checks it
  // against the key file before sending the owner's password to whatever answers on 127.0.0.1:4860.
  // (The signed text starts "kea-hub-identity:", which no token's signed text can, so it can't stand in for a token.)
  R('GET', '/v1/identity', ({ query }) => {
    const n = String(query.nonce ?? '');
    if (!/^[0-9a-f]{32,128}$/.test(n)) bad('Send nonce: 32 to 128 hex characters.');
    return { kid: key.kid, sig: edSign(null, Buffer.from(`kea-hub-identity:v1:${n}`), key.privateKey).toString('base64url') };
  }, { auth: false });

  // Making an account answers the same whether or not the email already has one (so it can't be used to find out who
  // has a Kea account), and never signs anyone in: the app signs in right after with the same email and password. For
  // a new email that works at once; for one that already had an account it works only with that account's password.
  const REGISTERED = 'If this email isn’t registered yet, your account is ready. If it is, sign in with your password.';
  R('POST', '/v1/auth/register', async ({ body, ip, client }) => {
    limit('register', ip);
    authBudget();
    const email = V.email(body.email);
    const displayName = V.name(body.displayName, 'Name', { min: 1, max: 60, reserved: reservedFor(null) });
    if (body.age13 !== true) bad('Kea accounts are for people 13 and older.');
    const problem = passwordProblem(body.password, { email, name: displayName });
    if (problem) bad(problem, { field: 'password' });
    const birthYear = body.birthYear == null ? null : birthYearOf(body.birthYear);
    const cur = currentTerms();
    if (body.termsVersion !== cur.n) throw new HttpError(409, 'The terms changed. Read the latest version and agree to it.', { termsVersion: cur.n });
    const agreed = new Set(Array.isArray(body.termsSections) ? body.termsSections : []);
    const missing = cur.sections.filter((s) => !agreed.has(s.id)).map((s) => s.id);
    if (missing.length) bad('Agree to every section of the terms.', { missing });
    const g = body.googleIdToken ? await google(body.googleIdToken) : null;
    if (g && g.email !== email) bad(`That Google account is ${g.email}, not ${email}.`);
    // (Hashed either way, so both answers take the same time.)
    const pwHash = await hashPassword(body.password);
    const existing = h.get('SELECT id FROM accounts WHERE email = ?', email);
    if (existing) {
      audit(existing.id, 'account.register_existing', existing.id, null, ip);
    } else {
      const id = randomUUID();
      const t = now();
      h.tx(() => {
        h.run('INSERT INTO accounts (id,email,display_name,pw_hash,created_at,updated_at,birth_year) VALUES (?,?,?,?,?,?,?)', id, email, displayName, pwHash, t, t, birthYear);
        recordAgreement(id, body, ip, client);
        if (g) markGoogleVerified(id, g);
      });
      audit(id, 'account.register', id, { google: !!g }, ip);
    }
    return { status: 202, body: { ok: true, signIn: true, message: REGISTERED } };
  }, { auth: false });

  R('POST', '/v1/auth/login', async ({ body, ip, ipKey, client }) => {
    limit('login', ipKey);
    authBudget();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) bad('Enter your email and password.');
    const nh = nameHash(email);
    // Locked from this address: refused, even with the right password.
    const pairMs = fails.pairLocked(nh, ipKey);
    if (pairMs > 0) throw lockedError(pairMs, false);
    const a = h.get('SELECT * FROM accounts WHERE email = ?', email);
    // Locked everywhere (guessing spread over many addresses): only a correct password WITH a correct two-step code
    // gets through, and any miss looks exactly like the lock, so it tells a guesser nothing.
    const globalMs = fails.globalLocked(nh);
    if (globalMs > 0) {
      const code = body.code;
      const hasCode = code != null && code !== '';
      const pwOk = hasCode && (await verifyPassword(password, a?.pw_hash ?? null));
      const step0 = pwOk && a.totp_enabled && a.status === 'active' ? checkTotp(a, code) : null;
      const step = step0 != null && claimStep(a.id, step0) ? step0 : null;
      if (step == null) {
        if (hasCode) { fails.fail(nh, ipKey); audit(a?.id ?? null, 'auth.fail', null, { lockedEverywhere: true }, ip); }
        throw lockedError(globalMs, true);
      }
      fails.clear(nh, ipKey);
      audit(a.id, 'auth.login', null, { lockedEverywhere: true }, ip);
      const token = newSession(a.id, client);
      return { body: { token, account: publicAccount(a), terms: termsStatus(a.id) }, token };
    }
    const ok = await verifyPassword(password, a?.pw_hash ?? null);
    if (!ok) {
      const f = fails.fail(nh, ipKey);
      audit(a?.id ?? null, 'auth.fail', null, { count: f.count }, ip);
      throw new HttpError(401, 'Wrong email or password.');
    }
    // (Only after the right password, so this says nothing to someone who doesn't have it.)
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    requireTotp(a, body.code, nh, ipKey, ip);
    fails.clear(nh, ipKey);
    if (needsRehash(a.pw_hash)) h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(password), now(), a.id);
    audit(a.id, 'auth.login', null, null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(a), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  // Sign in with Google instead of a password (the account must already exist with that email). Two-step sign-in
  // still applies. Also proves the email. A fresh, single-use Google sign-in proves who it is, so the password lockouts
  // don't apply to it; only guessing the two-step code from one address is throttled.
  R('POST', '/v1/auth/google', async ({ body, ip, ipKey, client }) => {
    limit('login', ipKey);
    const g = await google(body.idToken);
    const a = h.get('SELECT * FROM accounts WHERE email = ?', g.email);
    if (!a) throw new HttpError(404, `There's no Kea account for ${g.email} yet. Create one first.`, { email: g.email, name: g.name });
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    const nh = nameHash(a.email);
    if (a.totp_enabled) { const ms = fails.pairLocked(nh, ipKey); if (ms > 0) throw lockedError(ms, false); }
    requireTotp(a, body.code, nh, ipKey, ip);
    fails.clear(nh, ipKey);
    markGoogleVerified(a.id, g);
    audit(a.id, 'auth.login_google', null, null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  // Forgot your password: prove the email with Google, then set a new one. Every other session is signed out.
  R('POST', '/v1/auth/reset/google', async ({ body, ip, ipKey, client }) => {
    limit('login', ipKey);
    authBudget();
    const g = await google(body.idToken);
    const a = h.get('SELECT * FROM accounts WHERE email = ?', g.email);
    if (!a) throw new HttpError(404, `There's no Kea account for ${g.email}.`);
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    const problem = passwordProblem(body.password, { email: a.email, name: a.display_name });
    if (problem) bad(problem, { field: 'password' });
    const nh = nameHash(a.email);
    // An email nobody had proven before: whoever turned on two-step sign-in may not have owned it (someone can make an
    // account with another person's email). Proving it with Google now clears that two-step sign-in; the real owner
    // can turn their own on again.
    const clearTotp = !!a.totp_enabled && !a.email_verified;
    if (a.totp_enabled && !clearTotp) { const ms = fails.pairLocked(nh, ipKey); if (ms > 0) throw lockedError(ms, false); requireTotp(a, body.code, nh, ipKey, ip); }
    const pwHash = await hashPassword(body.password);
    h.tx(() => {
      h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', pwHash, now(), a.id);
      if (clearTotp) h.run('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL, totp_last_step = -1 WHERE id = ?', a.id);
      h.run('DELETE FROM sessions WHERE account_id = ?', a.id);
      markGoogleVerified(a.id, g);
    });
    // A new password: earlier guesses at the old one don't matter any more.
    fails.clearAll(nh);
    audit(a.id, 'account.reset_google', a.id, clearTotp ? { totpCleared: true } : null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  R('POST', '/v1/me/verify/google', async ({ me, body, ip }) => {
    limit('google', me.id);
    const g = await google(body.idToken);
    if (g.email !== me.email) bad(`That Google account is ${g.email}, but your Kea account is ${me.email}. Sign in to Google with ${me.email}.`);
    markGoogleVerified(me.id, g);
    audit(me.id, 'account.verify_google', me.id, null, ip);
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });

  // ---------- terms ----------
  const termsOut = (t) => ({ version: t.n, label: t.label, title: t.title, summary: t.summary, publishedAt: t.published_at, sections: t.sections });
  R('GET', '/v1/terms', ({ query }) => {
    const t = query.version ? termsRow(Number(query.version)) : null;
    if (query.version && !t) notFound('No such version.');
    return { terms: termsOut(t ? { ...t, sections: JSON.parse(t.sections) } : currentTerms()), versions: h.all('SELECT n, label, published_at FROM terms_versions ORDER BY n').map((v) => ({ version: v.n, label: v.label, publishedAt: v.published_at })) };
  }, { auth: false });
  // What changed since a version (default: the one this person last agreed to).
  R('GET', '/v1/terms/changes', ({ me, query }) => {
    const cur = currentTerms();
    const since = query.since ? Number(query.since) : acceptedVersion(me.id);
    const old = since ? termsRow(since) : null;
    if (since && !old) notFound('No such version.');
    return { from: since ?? null, to: cur.n, summary: cur.summary, ...diffTerms(old ? JSON.parse(old.sections) : [], cur.sections) };
  }, { terms: false, basic: true });
  R('POST', '/v1/terms/accept', ({ me, body, ip, client }) => {
    recordAgreement(me.id, body, ip, client);
    audit(me.id, 'terms.accept', String(body.termsVersion), null, ip);
    return { terms: termsStatus(me.id) };
  }, { terms: false, basic: true });

  // Kea storage: list (optionally under a folder prefix, or only what changed since a time, for syncing).
  // With `limit` (at most 5000), one page at a time: `after` is the last path of the page before, and `next` says where
  // the next page starts (null at the end). Without it, everything at once, as before (an account holds at most
  // maxFilesPerAccount files).
  R('GET', '/v1/files', ({ me, query }) => {
    const prefix = String(query.prefix ?? '');
    const since = Number(query.since) || 0;
    let nextPath = null;
    const paged = query.limit != null;
    const n = paged ? Math.min(5000, Math.max(1, Number(query.limit) || 1000)) : -1;
    const after = String(query.after ?? '');
    const listSql = 'SELECT path, size, version, sha256, updated_at FROM files WHERE account_id = ? AND substr(path, 1, length(?)) = ? AND updated_at > ? AND path > ? ORDER BY path LIMIT ?';
    // A long list goes out a batch at a time, so it's never held whole in memory (same JSON as a short one), and only a
    // few run at once (handleApi).
    if (paged ? n > F.listBatch : usage(me.id).file_count > F.listBatch) {
      return { __stream: jsonParts(function* () {
        yield ['used', usedBy(me.id)];
        yield ['quota', quotaOf(me)];
        yield ['now', now()];
        yield ['files', (function* () {
          let last = after, left = paged ? n : Infinity;
          while (left > 0) {
            const rows = h.all(listSql, me.id, prefix, prefix, since, last, Math.min(left, F.listBatch));
            for (const f of rows) yield { path: f.path, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updated_at };
            if (rows.length < Math.min(left, F.listBatch)) { nextPath = null; return; }
            last = rows[rows.length - 1].path;
            left -= rows.length;
            nextPath = last;
          }
        })()];
        if (paged) yield ['next', () => (nextPath != null && h.get(listSql, me.id, prefix, prefix, since, nextPath, 1) ? nextPath : null)];
      }(), CHUNK) };
    }
    const rows = h.all(listSql, me.id, prefix, prefix, since, after, paged ? n + 1 : -1);
    const more = paged && rows.length > n;
    if (more) rows.length = n;
    return {
      used: usedBy(me.id), quota: quotaOf(me), now: now(),
      files: rows.map((f) => ({ path: f.path, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updated_at })),
      ...(paged ? { next: more ? rows[rows.length - 1].path : null } : {}),
    };
  });

  // Download everything the Hub keeps about you (allowed even before agreeing to new terms).
  // (A section at a time: never all of it in memory at once.)
  R('GET', '/v1/me/export', ({ me }) => ({
    __stream: jsonParts(Object.entries({
      exportedAt: () => new Date(now()).toISOString(),
      account: () => publicAccount(me),
      termsAgreements: () => h.all('SELECT version, at FROM terms_acceptances WHERE account_id = ? ORDER BY version', me.id),
      classes: () => h.all('SELECT c.id, c.title, m.role, m.board, m.nickname, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.account_id = ?', me.id),
      studyAnswers: () => h.all('SELECT question_id, box, due_at, seen FROM review_state WHERE account_id = ?', me.id),
      points: () => h.all('SELECT class_id, question_id, points, at FROM xp_events WHERE account_id = ? ORDER BY at', me.id),
      files: () => h.all('SELECT path, size, version, updated_at FROM files WHERE account_id = ? ORDER BY path', me.id),
      signIns: () => h.all("SELECT action, at, ip FROM audit WHERE actor = ? AND action LIKE 'auth.%' ORDER BY id DESC LIMIT 500", me.id),
      storage: () => storageOut(me),
      sharedClaude: () => cleanOverride(me.claude_override ? JSON.parse(me.claude_override) : null),
      notifications: () => h.all('SELECT * FROM notifications WHERE account_id = ? ORDER BY id', me.id).map(noteOut),
      parentSignOffs: () => h.all('SELECT * FROM parent_consents WHERE account_id = ? ORDER BY created_at', me.id).map(consentOut),
      scanJobs: () => h.all('SELECT id, kind, course_key, chapter, status, created_at, started_at, finished_at, note FROM scan_jobs WHERE account_id = ? ORDER BY created_at', me.id),
      scanJobsJoined: () => h.all('SELECT job_id, joined_at FROM scan_job_members WHERE account_id = ? ORDER BY joined_at', me.id),
      scanRequests: () => h.all('SELECT kind, outcome, at FROM scan_requests WHERE account_id = ? ORDER BY id', me.id),
      flags: () => h.all('SELECT reason, detail, auto_suspended, status, at, resolved_at FROM flags WHERE account_id = ? ORDER BY id', me.id),
      hostingApplications: () => h.all('SELECT reason, status, created_at, decided_at FROM host_applications WHERE account_id = ? ORDER BY created_at', me.id),
      courseSections: () => h.all('SELECT course_key, joined_at, target FROM course_members WHERE account_id = ? ORDER BY joined_at', me.id),
      courseJoinRequests: () => h.all('SELECT course_key, label, status, created_at, decided_at FROM course_join_requests WHERE account_id = ? ORDER BY created_at', me.id),
      // Course files that came from scans you started (shared with your section).
      contributedCourseFiles: () => h.all('SELECT cf.course_key, cf.path, cf.size, cf.updated_at FROM course_files cf JOIN course_materials cm ON cm.course_key = cf.course_key JOIN scan_jobs j ON j.id = cm.first_job_id WHERE j.account_id = ? ORDER BY cf.course_key, cf.path', me.id),
      orgs: () => h.all('SELECT org_id, role, status, joined_at FROM org_members WHERE account_id = ?', me.id),
      activity: () => h.all('SELECT at, action, target, ip FROM audit WHERE actor = ? ORDER BY id DESC LIMIT 5000', me.id),
    }), CHUNK),
  }), { terms: false, basic: true });

  R('POST', '/v1/auth/logout', ({ token }) => {
    if (token) h.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
    return { body: { ok: true }, clearCookie: true };
  }, { auth: false });

  // A short-lived signed token for an org server or Kea to check offline (aud names who it's for).
  R('POST', '/v1/auth/token', ({ me, body }) => {
    const aud = V.str(body.aud ?? 'kea', 'Audience', { min: 1, max: 200 });
    // Only audiences something checks: Kea, the payroll vault, and an org server (org:<id>). A token for one never
    // works at another, and nobody can mint one named after something else.
    if (!['kea', 'keas-payroll'].includes(aud) && !/^org:[A-Za-z0-9_-]{1,64}$/.test(aud)) bad('Unknown audience.');
    const t = Math.floor(now() / 1000);
    const token = signToken(key, {
      iss: 'kea-hub', sub: me.id, aud, iat: t, exp: t + TOKEN_MINUTES * 60,
      email: me.email, name: me.display_name, ev: !!me.email_verified, iv: !!me.identity_verified, owner: me.role === 'owner',
    });
    return { token, expiresIn: TOKEN_MINUTES * 60 };
  });

  // ---------- me ----------
  R('GET', '/v1/me', ({ me }) => {
    sweep();
    return {
      account: publicAccount(me), progress: progressOf(me.id), terms: termsStatus(me.id),
      storage: storageOut(me), notifications: { unread: unreadCount(me.id), latest: h.get('SELECT MAX(id) AS n FROM notifications WHERE account_id = ?', me.id).n ?? 0 },
    };
  }, { terms: false, basic: true });
  // Notifications: newest first (or only those after an id, for polling), and marking them read. Readable before
  // agreeing to new terms, like the account itself.
  R('GET', '/v1/me/notifications', ({ me, query }) => {
    sweep();
    const after = Math.max(0, Number(query.after) || 0);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const unreadOnly = query.unread === '1' || query.unread === 'true';
    return {
      notifications: h.all(`SELECT * FROM notifications WHERE account_id = ? AND id > ?${unreadOnly ? ' AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, me.id, after, limit).map(noteOut),
      unread: unreadCount(me.id),
    };
  }, { terms: false, basic: true });
  R('POST', '/v1/me/notifications/read', ({ me, body }) => {
    if (body.all === true) h.run('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL', now(), me.id);
    else {
      if (!Array.isArray(body.ids) || body.ids.length > 500) bad('Say which notifications: ids (a list), or all: true.');
      for (const id of body.ids) h.run('UPDATE notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL', now(), V.int(id, 'id', { min: 1 }), me.id);
    }
    return { unread: unreadCount(me.id) };
  }, { terms: false, basic: true });
  R('POST', '/v1/me/notifications/delete', ({ me, body }) => {
    if (body.all === true) h.run('DELETE FROM notifications WHERE account_id = ? AND read_at IS NOT NULL', me.id);
    else {
      if (!Array.isArray(body.ids) || body.ids.length > 500) bad('Say which notifications: ids (a list), or all: true for every read one.');
      for (const id of body.ids) h.run('DELETE FROM notifications WHERE id = ? AND account_id = ?', V.int(id, 'id', { min: 1 }), me.id);
    }
    return { unread: unreadCount(me.id) };
  }, { terms: false, basic: true });
  // An optional phone number, and who sees it: classmates in my classes, coworkers in my organizations, both, or
  // nobody (the default). Never on leaderboards, never public. Changing the number is limited to a few times a day.
  R('POST', '/v1/me/phone', ({ me, body, ip }) => {
    let number = me.phone ?? null;
    if ('phone' in body) { try { number = body.phone == null || body.phone === '' ? null : normalizePhone(body.phone); } catch (e) { bad(e.message, { field: 'phone' }); } }
    const visibility = body.visibility == null ? (number ? me.phone_visibility || 'nobody' : 'nobody') : V.enum(body.visibility, 'Who sees it', PHONE_VISIBILITY);
    if (number !== (me.phone ?? null)) limit('phone', me.id);
    h.run('UPDATE accounts SET phone = ?, phone_visibility = ?, updated_at = ? WHERE id = ?', number, visibility, now(), me.id);
    if (number !== (me.phone ?? null) || visibility !== me.phone_visibility) audit(me.id, number ? 'account.phone' : 'account.phone_clear', me.id, { visibility }, ip);
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  R('POST', '/v1/me', ({ me, body }) => {
    const name = V.name(body.displayName, 'Name', { min: 1, max: 60, reserved: reservedFor(me) });
    h.run('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?', name, now(), me.id);
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  // Birth year: set once by the member (only the owner can change it after that), so it can't be edited to skip the
  // parent sign-off.
  R('POST', '/v1/me/birth-year', ({ me, body, ip }) => {
    const y = birthYearOf(body.birthYear);
    if (me.birth_year != null && me.birth_year !== y) forbidden('Your birth year is already set. Contact Kea support to correct it.');
    h.run('UPDATE accounts SET birth_year = ?, updated_at = ? WHERE id = ?', y, now(), me.id);
    audit(me.id, 'account.birth_year', me.id, null, ip);
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  function consentOut(c) { return c && consentOutRow(c); }
  const consentOutRow = (c) => ({ id: c.id, parentEmail: c.parent_email, status: c.status, method: c.method, createdAt: c.created_at, expiresAt: c.expires_at, decidedAt: c.decided_at });
  R('GET', '/v1/me/consent', ({ me }) => ({
    ...consentOf(me),
    requests: h.all('SELECT * FROM parent_consents WHERE account_id = ? ORDER BY created_at DESC LIMIT 10', me.id).map(consentOut),
    googleOnWeb: !!googleWebClientId,
  }));
  // Ask a parent or guardian: their email, and a link they open (sent by the member however they like). The parent
  // proves the email with Google, on the link's page or in the member's Kea.
  R('POST', '/v1/me/consent', ({ me, body, ip, origin }) => {
    limit('join', me.id);
    const st = consentOf(me);
    if (!st.minor) bad(me.birth_year == null ? 'Tell Kea the year you were born first.' : 'You don’t need a parent’s sign-off.');
    if (st.parentSignOff === 'approved') return { ...st, link: null };
    const parentEmail = V.email(body.parentEmail);
    if (parentEmail === me.email) bad('Use your parent’s or guardian’s own email, not yours.');
    if (minorParent({ email: parentEmail })) bad(MINOR_PARENT);
    const token = randomBytes(24).toString('hex');
    const id = randomUUID();
    h.tx(() => {
      h.run("UPDATE parent_consents SET status = 'revoked', decided_at = ? WHERE account_id = ? AND status = 'pending'", now(), me.id);
      h.run('INSERT INTO parent_consents (id,account_id,parent_email,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)', id, me.id, parentEmail, sha(`consent:${token}`), now(), now() + 14 * DAY_MS);
    });
    audit(me.id, 'consent.request', id, { parent: parentEmail }, ip);
    return { ...consentOf(me), link: `${publicUrl || origin}/consent?t=${token}` };
  });
  // The parent, at the member's computer: Kea opens Google sign-in for the parent's email.
  R('POST', '/v1/me/consent/google', async ({ me, body, ip }) => {
    limit('google', me.id);
    const c = h.get("SELECT * FROM parent_consents WHERE account_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1", me.id, now()) ?? bad('Ask for a sign-off first: enter your parent’s or guardian’s email.');
    const g = await google(body.idToken);
    if (g.email === me.email) bad('That’s your own Google account. Your parent or guardian signs in with theirs.');
    if (g.email !== c.parent_email) bad(`That Google account is ${g.email}, but the sign-off is for ${c.parent_email}.`);
    if (minorParent(g)) bad(MINOR_PARENT);
    approveConsent(c, 'google-kea', g, ip);
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  // The link's page (/consent) calls this once the parent has signed in with Google there.
  const consentByToken = (token) => {
    const t = String(token ?? '');
    if (!/^[0-9a-f]{48}$/.test(t)) return null;
    return h.get('SELECT c.*, a.display_name, a.email AS member_email FROM parent_consents c JOIN accounts a ON a.id = c.account_id WHERE c.token_hash = ?', sha(`consent:${t}`));
  };
  R('POST', '/v1/consent/confirm', async ({ body, ip }) => {
    limit('login', ip);
    const c = consentByToken(body.token);
    if (!c || c.status === 'revoked' || c.expires_at <= now()) notFound('This sign-off link has expired or was replaced. Ask for a new one.');
    if (c.status !== 'pending') return { status: c.status };
    const approve = V.bool(body.approve, 'approve');
    const g = await google(body.idToken);
    if (g.email !== c.parent_email) bad(`You signed in to Google as ${g.email}, but this sign-off was sent to ${c.parent_email}. Sign in with that account.`);
    if (g.email === c.member_email) bad('A member can’t sign off for themselves.');
    if (approve && minorParent(g)) bad(MINOR_PARENT);
    if (approve) approveConsent(c, 'google-link', g, ip);
    else {
      h.run("UPDATE parent_consents SET status = 'declined', method = 'google-link', parent_google_sub = ?, decided_at = ? WHERE id = ?", g.sub, now(), c.id);
      audit(c.account_id, 'consent.decline', c.id, { parent: c.parent_email }, ip);
      notify(c.account_id, 'parent_signoff', 'Your parent or guardian didn’t sign off', 'Kea’s shared Claude stays off for you. Everything else in Kea works as before. You can ask again under Your account.', { data: { status: 'declined' } });
    }
    return { status: approve ? 'approved' : 'declined' };
  }, { auth: false });

  // How the person shows on leaderboards: their name, a nickname, or hidden. It's the default for classes they join
  // later, and (unless everyClass is false) it replaces each class's own choice too.
  R('POST', '/v1/me/leaderboard', ({ me, body }) => {
    const show = V.enum(body.show, 'Leaderboard name', ['name', 'nickname', 'hidden']);
    const nickname = 'nickname' in body ? V.name(body.nickname, 'Nickname', { optional: true, max: 30, reserved: reservedFor(me) }) : me.nickname ?? null;
    if (show === 'nickname' && !nickname) bad('Pick a nickname first.');
    h.tx(() => {
      h.run('UPDATE accounts SET board_default = ?, nickname = ?, updated_at = ? WHERE id = ?', show, nickname, now(), me.id);
      if (body.everyClass !== false) h.run('UPDATE class_members SET board = ?, nickname = ? WHERE account_id = ?', show, nickname, me.id);
    });
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  // ---------- proving it's really you, again ----------
  // Changing how you sign in (two-step sign-in, signing out your other devices) needs your password (or a fresh Google
  // sign-in), not just a session, so a stolen session can't lock the real person out. A proof counts for this session
  // for REAUTH_MS. Wrong passwords here count toward the same lockouts as signing in, and locks are checked first.
  const REAUTH_MS = 10 * 60_000;
  const WRONG_CREDS = 'Your password or two-step code is wrong.';
  /** Checks my password (and code, when `code` is given) with the sign-in lockouts; one message for any miss. */
  async function checkMine(me, { password, code = undefined, ipKey, ip, message = WRONG_CREDS }) {
    limit('pwcheck', me.id);
    const nh = nameHash(me.email);
    const pairMs = fails.pairLocked(nh, ipKey);
    if (pairMs > 0) throw lockedError(pairMs, false);
    const globalMs = fails.globalLocked(nh);
    if (globalMs > 0) throw lockedError(globalMs, true);
    const pwOk = await verifyPassword(typeof password === 'string' ? password : '', me.pw_hash);
    const step0 = code === undefined ? true : pwOk ? checkTotp(me, code) : null;
    const step = code === undefined || step0 == null ? step0 : claimStep(me.id, step0) ? step0 : null;
    if (!pwOk || step == null) {
      fails.fail(nh, ipKey);
      audit(me.id, 'auth.fail_reauth', null, null, ip);
      throw new HttpError(401, message);
    }
    fails.clear(nh, ipKey);
  }
  /** Password, a fresh Google sign-in for my email, or (when `recent`) a proof given in this session in the last minutes. */
  async function freshAuth({ me, body, token, ipKey, ip }, { recent = false } = {}) {
    const s = h.get('SELECT reauth_at FROM sessions WHERE token_hash = ?', sha(token));
    if (recent && body.password == null && body.googleIdToken == null && s?.reauth_at && now() - s.reauth_at < REAUTH_MS) return;
    if (body.googleIdToken != null) {
      const g = await google(body.googleIdToken);
      if (g.email !== me.email) bad(`That Google account is ${g.email}, but your Kea account is ${me.email}.`);
    } else {
      if (body.password == null || body.password === '') throw new HttpError(401, 'Enter your password to change this.', { passwordRequired: true });
      await checkMine(me, { password: body.password, ipKey, ip, message: 'Your password is wrong.' });
    }
    h.run('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?', now(), sha(token));
  }

  R('POST', '/v1/me/password', async ({ me, body, token, ip, ipKey }) => {
    await checkMine(me, { password: body.current, ipKey, ip, message: 'Your current password is wrong.' });
    const problem = passwordProblem(body.next, { email: me.email, name: me.display_name });
    if (problem) bad(problem, { field: 'next' });
    h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(body.next), now(), me.id);
    h.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', me.id, sha(token));
    fails.clearAll(nameHash(me.email));
    audit(me.id, 'account.password', me.id, null, ip);
    return { ok: true, otherSessionsSignedOut: true };
  }, { basic: true });
  R('GET', '/v1/me/sessions', ({ me, token }) => ({
    sessions: h.all('SELECT * FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen DESC', me.id, now())
      .map((s) => ({ id: s.token_hash.slice(0, 12), client: s.client, createdAt: s.created_at, lastSeen: s.last_seen, current: s.token_hash === sha(token) })),
  }), { terms: false, basic: true });
  R('POST', '/v1/me/sessions/sign-out-others', async (ctx) => {
    await freshAuth(ctx);
    const r = h.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', ctx.me.id, sha(ctx.token));
    audit(ctx.me.id, 'account.sign_out_others', ctx.me.id, { count: Number(r.changes) }, ctx.ip);
    return { signedOut: Number(r.changes) };
  }, { terms: false, basic: true });
  R('POST', '/v1/me/totp/setup', async (ctx) => {
    const { me } = ctx;
    if (me.totp_enabled) bad('Two-step sign-in is already on.');
    await freshAuth(ctx);
    const secret = newSecret();
    h.run('UPDATE accounts SET totp_secret = ?, updated_at = ? WHERE id = ?', sealSecret(totpKey, secret, me.id), now(), me.id);
    return { secret, uri: otpauthUri(secret, me.email) };
  }, { basic: true });
  R('POST', '/v1/me/totp/enable', async (ctx) => {
    const { me, body, ip } = ctx;
    if (me.totp_enabled) bad('Two-step sign-in is already on.');
    if (!me.totp_secret) bad('Start setup first.');
    // (Setup just proved it's you; that proof is enough for the next few minutes.)
    await freshAuth(ctx, { recent: true });
    const step = checkTotp(me, body.code);
    if (step == null) bad('That code is wrong. Check the time on your phone and try the newest code.');
    h.run('UPDATE accounts SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?', step, now(), me.id);
    // Sign-ins made before two-step was on never passed it: they end (this one stays), so a session someone got with
    // the password alone doesn't keep working, or become an owner's, once the code is required.
    h.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', me.id, sha(ctx.token));
    audit(me.id, 'account.totp_on', me.id, null, ip);
    return { ok: true };
  }, { basic: true });
  R('POST', '/v1/me/totp/disable', async ({ me, body, ip, ipKey }) => {
    if (!me.totp_enabled) return { ok: true };
    if (me.role === 'owner') forbidden('The owner account must keep two-step sign-in on.');
    await checkMine(me, { password: body.password, code: body.code, ipKey, ip });
    h.run('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL, totp_last_step = -1, updated_at = ? WHERE id = ?', now(), me.id);
    audit(me.id, 'account.totp_off', me.id, null, ip);
    return { ok: true };
  });

  // Deleting your account: your password (and two-step code, when it's on). See deleteAccount for what goes.
  R('POST', '/v1/me/delete', async ({ me, body, ip, ipKey }) => {
    if (me.role === 'owner') forbidden('The Hub owner’s account can’t be deleted from the app.');
    if (body.confirm !== 'DELETE') bad('Type DELETE to confirm.', { field: 'confirm' });
    await checkMine(me, { password: body.password, code: me.totp_enabled ? body.code : undefined, ipKey, ip });
    deleteAccount(me, me.id, ip);
    return { body: { ok: true, deleted: true }, clearCookie: true };
  }, { terms: false });

  // ---------- hosting ----------
  R('POST', '/v1/hosting/apply', ({ me, body, ip }) => {
    if (me.can_host || me.role === 'owner') return { status: 'approved' };
    const reason = V.str(body.reason, 'Reason', { min: 20, max: 2000 });
    if (h.get("SELECT 1 FROM host_applications WHERE account_id = ? AND status = 'pending'", me.id)) bad('Your application is already waiting for review.');
    const id = randomUUID();
    h.run('INSERT INTO host_applications (id,account_id,reason,created_at) VALUES (?,?,?,?)', id, me.id, reason, now());
    audit(me.id, 'hosting.apply', id, null, ip);
    return { status: 'pending', id };
  });
  R('GET', '/v1/hosting', ({ me }) => {
    if (me.can_host || me.role === 'owner') return { status: 'approved' };
    const a = h.get('SELECT * FROM host_applications WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', me.id);
    return a ? { status: a.status, note: a.note, appliedAt: a.created_at } : { status: 'none' };
  });

  // ---------- classes ----------
  R('POST', '/v1/classes', ({ me, body, ip }) => {
    const owner = me.role === 'owner';
    if (!owner && !me.can_host) forbidden('Hosting classes on the Kea Hub needs approval. Apply under Hosting.');
    const kind = V.enum(body.kind ?? 'class', 'Kind', ['class', 'general']);
    if (kind === 'general' && !owner && !me.identity_verified) forbidden('General curricula need an identity-verified account.');
    const id = randomUUID();
    h.tx(() => {
      h.run('INSERT INTO classes (id,owner_id,title,description,kind,meeting_url,created_at) VALUES (?,?,?,?,?,?,?)', id, me.id,
        V.name(body.title, 'Title', { min: 1, max: 120 }), V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '', kind, V.url(body.meetingUrl, 'Meeting link'), now());
      h.run("INSERT INTO class_members (class_id,account_id,role,joined_at) VALUES (?,?,'instructor',?)", id, me.id, now());
    });
    audit(me.id, 'class.create', id, { kind }, ip);
    return { status: 201, body: { class: classOut(loadClass(id), membership(id, me.id)) } };
  });
  R('GET', '/v1/classes', ({ me }) => ({
    classes: h.all(`SELECT c.*, m.role AS m_role, m.board AS m_board, m.nickname AS m_nick FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.account_id = ? AND c.status = 'active' AND ${ACTIVE_ORG_SQL} ORDER BY c.title`, me.id)
      .map((c) => classOut(c, { role: c.m_role, board: c.m_board, nickname: c.m_nick })),
  }));
  R('GET', '/v1/classes/:id', ({ me, params }) => {
    const { c, m } = asMember(params.id, me);
    return { class: classOut(c, m), progress: progressOf(me.id, c.id) };
  });
  R('POST', '/v1/classes/:id', ({ me, params, body }) => {
    const { c } = asInstructor(params.id, me);
    h.run('UPDATE classes SET title = ?, description = ?, meeting_url = ?, status = ? WHERE id = ?',
      body.title != null ? V.name(body.title, 'Title', { min: 1, max: 120 }) : c.title,
      body.description != null ? V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '' : c.description,
      'meetingUrl' in body ? V.url(body.meetingUrl, 'Meeting link') : c.meeting_url,
      body.status != null ? V.enum(body.status, 'Status', ['active', 'archived']) : c.status, c.id);
    return { class: classOut(loadClass(c.id), membership(c.id, me.id)) };
  });

  R('POST', '/v1/classes/:id/invites', ({ me, params, body }) => {
    const { c, m } = asTeacher(params.id, me);
    const role = V.enum(body.role ?? 'student', 'Role', ['student', 'ta']);
    if (role === 'ta' && m.role !== 'instructor') forbidden('Only the class instructor can invite teaching assistants.');
    const maxUses = V.int(body.maxUses, 'Max uses', { optional: true, min: 1, max: 10000 });
    const days = V.int(body.expiresDays, 'Days', { optional: true, min: 1, max: 365 });
    const code = newCode();
    h.run('INSERT INTO invites (code,class_id,role,created_by,max_uses,expires_at,created_at) VALUES (?,?,?,?,?,?,?)', code, c.id, role, me.id, maxUses, days ? now() + days * 86400_000 : null, now());
    return { status: 201, body: { code, role, maxUses, expiresAt: days ? now() + days * 86400_000 : null } };
  });
  R('GET', '/v1/classes/:id/invites', ({ me, params }) => {
    asTeacher(params.id, me);
    return { invites: h.all('SELECT * FROM invites WHERE class_id = ? AND revoked = 0 ORDER BY created_at DESC', params.id)
      .map((i) => ({ code: i.code, role: i.role, uses: i.uses, maxUses: i.max_uses, expiresAt: i.expires_at, expired: (i.expires_at != null && i.expires_at <= now()) || (i.max_uses != null && i.uses >= i.max_uses) })) };
  });
  R('POST', '/v1/invites/:code/revoke', ({ me, params }) => {
    const inv = h.get('SELECT * FROM invites WHERE code = ?', normCode(params.code)) ?? notFound('Invite not found.');
    asTeacher(inv.class_id, me);
    h.run('UPDATE invites SET revoked = 1 WHERE code = ?', inv.code);
    return { ok: true };
  });
  // What a code would join, so Kea can ask "Join BIOL 1010?" first. Same answer for a bad code as /v1/join gives.
  R('GET', '/v1/invites/:code', ({ me, params, ip }) => {
    limit('join', ip); limit('join', me.id);
    const code = normCode(params.code);
    const inv = code.length === 10 ? h.get('SELECT * FROM invites WHERE code = ?', code) : null;
    const usable = inv && !inv.revoked && (inv.expires_at == null || inv.expires_at > now()) && (inv.max_uses == null || inv.uses < inv.max_uses);
    const c = usable ? loadClass(inv.class_id) : null;
    if (!c || c.status !== 'active' || !orgActive(c.org_id)) notFound("That code doesn't work. Check it, or ask for a new one.");
    const out = classOut(c, membership(c.id, me.id));
    return { class: { id: out.id, title: out.title, description: out.description, members: out.members, instructors: out.instructors }, role: inv.role, alreadyMember: !!out.role };
  });
  R('POST', '/v1/join', ({ me, body, ip }) => {
    limit('join', ip); limit('join', me.id);
    const code = normCode(body.code);
    const inv = code.length === 10 ? h.get('SELECT * FROM invites WHERE code = ?', code) : null;
    const usable = inv && !inv.revoked && (inv.expires_at == null || inv.expires_at > now()) && (inv.max_uses == null || inv.uses < inv.max_uses);
    if (!usable) notFound("That code doesn't work. Check it, or ask for a new one.");
    const c = loadClass(inv.class_id);
    if (c.status !== 'active' || !orgActive(c.org_id)) notFound("That code doesn't work. Check it, or ask for a new one.");
    const existing = membership(c.id, me.id);
    if (!existing) {
      h.tx(() => {
        // (No choice given: the account's own leaderboard setting.)
        const nick = 'nickname' in body ? V.name(body.nickname, 'Nickname', { optional: true, max: 30, reserved: reservedFor(me) }) : me.nickname ?? null;
        let board = V.enum(body.board ?? me.board_default ?? 'name', 'Leaderboard name', ['name', 'nickname', 'hidden']);
        if (board === 'nickname' && !nick) board = 'name';
        h.run('INSERT INTO class_members (class_id,account_id,role,board,nickname,joined_at) VALUES (?,?,?,?,?,?)', c.id, me.id, inv.role, board, nick, now());
        h.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
      });
      audit(me.id, 'class.join', c.id, { role: inv.role }, ip);
    }
    return { class: classOut(c, membership(c.id, me.id)), alreadyMember: !!existing };
  });
  R('POST', '/v1/classes/:id/me', ({ me, params, body }) => {
    const { m } = asMember(params.id, me);
    if (m.owner) bad('You are not a member of this class.');
    const board = V.enum(body.board ?? m.board, 'Leaderboard name', ['name', 'nickname', 'hidden']);
    const nickname = 'nickname' in body ? V.name(body.nickname, 'Nickname', { optional: true, max: 30, reserved: reservedFor(me) }) : m.nickname;
    if (board === 'nickname' && !nickname) bad('Pick a nickname first.');
    h.run('UPDATE class_members SET board = ?, nickname = ? WHERE class_id = ? AND account_id = ?', board, nickname, params.id, me.id);
    return { board, nickname };
  });
  R('POST', '/v1/classes/:id/leave', ({ me, params }) => {
    const { c, m } = asMember(params.id, me);
    if (c.owner_id === me.id) bad("You made this class, so you can't leave it. Archive it instead.");
    if (!m.owner) h.run('DELETE FROM class_members WHERE class_id = ? AND account_id = ?', c.id, me.id);
    return { ok: true };
  });
  R('GET', '/v1/classes/:id/members', ({ me, params }) => {
    const { m } = asMember(params.id, me);
    const teacher = ['instructor', 'ta'].includes(m.role);
    const rows = h.all('SELECT m.*, a.display_name, a.phone, a.phone_visibility, a.supporter_until FROM class_members m JOIN accounts a ON a.id = m.account_id WHERE m.class_id = ? ORDER BY m.role, a.display_name', params.id);
    // Phone numbers only between real members of the class (not the Hub owner looking in from outside).
    const classmate = !m.owner;
    return {
      members: rows
        .filter((r) => teacher || r.role !== 'student' || r.board !== 'hidden' || r.account_id === me.id)
        // (A phone number would say who a nickname is: next to a student who doesn't show their name, only teachers see it.)
        .map((r) => ({ id: teacher ? r.account_id : undefined, name: teacher || r.role !== 'student' ? r.display_name : boardName(r), role: r.role, joinedAt: r.joined_at, you: r.account_id === me.id, ...extrasFor(r, 'classes', { phone: classmate && (teacher || r.role !== 'student' || r.board === 'name') }) })),
    };
  });
  R('POST', '/v1/classes/:id/members/:accountId/remove', ({ me, params, ip }) => {
    const { c } = asInstructor(params.id, me);
    if (params.accountId === c.owner_id) bad("The class's creator can't be removed.");
    h.run('DELETE FROM class_members WHERE class_id = ? AND account_id = ?', c.id, params.accountId);
    audit(me.id, 'class.remove_member', c.id, { account: params.accountId }, ip);
    return { ok: true };
  });

  // ---------- class calendar ----------
  const sessionFields = (body, prev = {}) => {
    const start = body.start != null ? V.time(body.start, 'Start') : prev.start_at;
    const end = body.end != null ? V.time(body.end, 'End') : prev.end_at;
    if (start == null || end == null) bad('Give a start and an end.');
    if (end <= start) bad('The end must be after the start.');
    if (end - start > 14 * 86400_000) bad('A session can be at most 14 days long.');
    return {
      title: body.title != null ? V.str(body.title, 'Title', { min: 1, max: 120 }) : prev.title,
      start, end,
      location: 'location' in body ? V.str(body.location, 'Location', { optional: true, max: 200 }) : prev.location ?? null,
      meetingUrl: 'meetingUrl' in body ? V.url(body.meetingUrl, 'Meeting link') : prev.meeting_url ?? null,
      notes: 'notes' in body ? V.str(body.notes, 'Notes', { optional: true, max: 4000 }) : prev.notes ?? null,
    };
  };
  R('POST', '/v1/classes/:id/sessions', ({ me, params, body }) => {
    const { c } = asTeacher(params.id, me);
    const f = sessionFields(body);
    const id = randomUUID();
    h.run('INSERT INTO class_sessions (id,class_id,title,start_at,end_at,location,meeting_url,notes) VALUES (?,?,?,?,?,?,?,?)', id, c.id, f.title, f.start, f.end, f.location, f.meetingUrl, f.notes);
    return { status: 201, body: { session: sessionOut(h.get('SELECT * FROM class_sessions WHERE id = ?', id)) } };
  });
  R('GET', '/v1/classes/:id/sessions', ({ me, params }) => {
    asMember(params.id, me);
    return { sessions: h.all('SELECT * FROM class_sessions WHERE class_id = ? ORDER BY start_at', params.id).map(sessionOut) };
  });
  R('POST', '/v1/class-sessions/:sid', ({ me, params, body }) => {
    const s = h.get('SELECT * FROM class_sessions WHERE id = ?', params.sid) ?? notFound('Session not found.');
    asTeacher(s.class_id, me);
    const f = sessionFields(body, s);
    h.run('UPDATE class_sessions SET title=?, start_at=?, end_at=?, location=?, meeting_url=?, notes=? WHERE id = ?', f.title, f.start, f.end, f.location, f.meetingUrl, f.notes, s.id);
    return { session: sessionOut(h.get('SELECT * FROM class_sessions WHERE id = ?', s.id)) };
  });
  R('POST', '/v1/class-sessions/:sid/delete', ({ me, params }) => {
    const s = h.get('SELECT * FROM class_sessions WHERE id = ?', params.sid) ?? notFound('Session not found.');
    asTeacher(s.class_id, me);
    h.run('DELETE FROM class_sessions WHERE id = ?', s.id);
    return { ok: true };
  });
  R('GET', '/v1/calendar', ({ me, query }) => {
    const from = query.from ? V.time(query.from, 'from') : now() - 7 * 86400_000;
    const to = query.to ? V.time(query.to, 'to') : now() + 60 * 86400_000;
    if (to - from > 400 * 86400_000) bad('Ask for at most 400 days at a time.');
    return {
      sessions: h.all(`SELECT s.*, c.title AS class_title FROM class_sessions s JOIN class_members m ON m.class_id = s.class_id JOIN classes c ON c.id = s.class_id WHERE m.account_id = ? AND c.status = 'active' AND ${ACTIVE_ORG_SQL} AND s.end_at >= ? AND s.start_at <= ? ORDER BY s.start_at`, me.id, from, to)
        .map((s) => ({ ...sessionOut(s), classTitle: s.class_title })),
    };
  });

  // ---------- study sets ----------
  const parseQuestions = (list) => {
    if (!Array.isArray(list) || list.length < 1 || list.length > 500) bad('A set needs 1 to 500 questions.');
    return list.map((q, i) => {
      const n = i + 1;
      const text = V.str(q?.q, `Question ${n}`, { min: 1, max: 2000 });
      if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 8) bad(`Question ${n} needs 2 to 8 choices.`);
      const choices = q.choices.map((c, j) => V.str(c, `Question ${n} choice ${j + 1}`, { min: 1, max: 500 }));
      const answer = V.int(q.answer, `Question ${n} answer`, { min: 0, max: choices.length - 1 });
      return { q: text, choices, answer, why: V.str(q.why, `Question ${n} explanation`, { optional: true, max: 2000 }) };
    });
  };
  R('POST', '/v1/classes/:id/sets', ({ me, params, body }) => {
    const { c } = asTeacher(params.id, me);
    const qs = parseQuestions(body.questions);
    const id = randomUUID();
    h.tx(() => {
      h.run('INSERT INTO sets (id,class_id,title,leaderboard,created_by,created_at) VALUES (?,?,?,?,?,?)', id, c.id, V.str(body.title, 'Title', { min: 1, max: 120 }), body.leaderboard === false ? 0 : 1, me.id, now());
      qs.forEach((q, i) => h.run('INSERT INTO questions (id,set_id,idx,q,choices,answer,why) VALUES (?,?,?,?,?,?,?)', randomUUID(), id, i, q.q, JSON.stringify(q.choices), q.answer, q.why));
    });
    return { status: 201, body: { id, count: qs.length } };
  });
  R('GET', '/v1/classes/:id/sets', ({ me, params }) => {
    asMember(params.id, me);
    return {
      sets: h.all('SELECT * FROM sets WHERE class_id = ? ORDER BY created_at', params.id).map((s) => {
        const total = h.get('SELECT COUNT(*) AS n FROM questions WHERE set_id = ?', s.id).n;
        const notDue = h.get('SELECT COUNT(*) AS n FROM review_state r JOIN questions q ON q.id = r.question_id WHERE q.set_id = ? AND r.account_id = ? AND r.due_at > ?', s.id, me.id, now()).n;
        const seen = h.get('SELECT COUNT(*) AS n FROM review_state r JOIN questions q ON q.id = r.question_id WHERE q.set_id = ? AND r.account_id = ? AND r.seen = 1', s.id, me.id).n;
        return { id: s.id, title: s.title, leaderboard: !!s.leaderboard, questions: total, due: total - notDue, learned: seen };
      }),
    };
  });
  const loadSet = (id) => h.get('SELECT * FROM sets WHERE id = ?', id) ?? notFound('Set not found.');
  // Questions come without answers: grading happens here, so scores can't be faked by a modified app.
  R('GET', '/v1/sets/:id', ({ me, params }) => {
    const s = loadSet(params.id);
    const { m } = asMember(s.class_id, me);
    const teacher = ['instructor', 'ta'].includes(m.role);
    const states = new Map(h.all('SELECT r.* FROM review_state r JOIN questions q ON q.id = r.question_id WHERE q.set_id = ? AND r.account_id = ?', s.id, me.id).map((r) => [r.question_id, r]));
    return {
      set: { id: s.id, classId: s.class_id, title: s.title, leaderboard: !!s.leaderboard },
      questions: h.all('SELECT * FROM questions WHERE set_id = ? ORDER BY idx', s.id).map((q) => {
        const st = states.get(q.id);
        return { id: q.id, q: q.q, choices: JSON.parse(q.choices), due: !st || st.due_at <= now(), dueAt: st?.due_at ?? null, box: st?.box ?? 0, ...(teacher ? { answer: q.answer, why: q.why } : {}) };
      }),
    };
  });
  R('POST', '/v1/sets/:id/delete', ({ me, params }) => {
    const s = loadSet(params.id);
    asTeacher(s.class_id, me);
    h.run('DELETE FROM sets WHERE id = ?', s.id);
    return { ok: true };
  });
  R('POST', '/v1/sets/:id/answer', ({ me, params, body }) => {
    limit('answer', me.id);
    const s = loadSet(params.id);
    const { m } = asMember(s.class_id, me);
    const teacher = ['instructor', 'ta'].includes(m.role);
    const q = h.get('SELECT * FROM questions WHERE id = ? AND set_id = ?', V.str(body.questionId, 'Question', { min: 1, max: 100 }), s.id) ?? notFound('Question not found.');
    const choice = V.int(body.choice, 'Choice', { min: 0, max: JSON.parse(q.choices).length - 1 });
    const correct = choice === q.answer;
    const t = now();
    return h.tx(() => {
      const prev = h.get('SELECT * FROM review_state WHERE account_id = ? AND question_id = ?', me.id, q.id);
      const r = scoreAnswer(prev ? { box: prev.box, dueAt: prev.due_at, missedThisWindow: !!prev.missed, seen: !!prev.seen } : null, correct, t);
      h.run('INSERT INTO review_state (account_id,question_id,box,due_at,missed,seen) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,question_id) DO UPDATE SET box=excluded.box, due_at=excluded.due_at, missed=excluded.missed, seen=excluded.seen',
        me.id, q.id, r.state.box, r.state.dueAt, r.state.missedThisWindow ? 1 : 0, r.state.seen ? 1 : 0);
      let points = 0;
      // (Teachers practise like anyone, but never score on their own class's leaderboard.)
      if (s.leaderboard && r.points > 0 && !teacher) {
        const today = h.get('SELECT COALESCE(SUM(points),0) AS s FROM xp_events WHERE account_id = ? AND day = ?', me.id, dayKey(t)).s;
        points = capped(r.points, today);
        if (points > 0) h.run('INSERT INTO xp_events (account_id,class_id,question_id,points,at,day) VALUES (?,?,?,?,?,?)', me.id, s.class_id, q.id, points, t, dayKey(t));
      }
      // A leaderboard set doesn't hand out its answer key: a wrong answer while the question still scores says only
      // that it was wrong (it comes back to try again). The answer and why come once it's right, or when the question
      // isn't scoring for this person now (they already got it right this round), and always in practice-only sets.
      const reveal = !s.leaderboard || teacher || correct || !r.due;
      if (!reveal) return { correct: false, again: true, points: 0, scoring: true, capped: false, nextDueAt: r.state.dueAt, box: r.state.box, progress: progressOf(me.id) };
      return {
        correct, answer: q.answer, why: q.why, points, scoring: r.due,
        capped: s.leaderboard && r.points > 0 && !teacher && points < r.points,
        nextDueAt: r.state.dueAt, box: r.state.box, progress: progressOf(me.id),
      };
    });
  });

  // ---------- leaderboards ----------
  R('GET', '/v1/classes/:id/leaderboard', ({ me, params, query }) => {
    asMember(params.id, me);
    const period = V.enum(query.period ?? 'week', 'Period', ['week', 'all']);
    const since = period === 'week' ? weekStart(now()) : 0;
    const rows = h.all(`SELECT m.account_id, m.board, m.nickname, a.display_name, a.supporter_until, COALESCE(SUM(x.points),0) AS points
      FROM class_members m JOIN accounts a ON a.id = m.account_id
      LEFT JOIN xp_events x ON x.account_id = m.account_id AND x.class_id = m.class_id AND x.at >= ?
      WHERE m.class_id = ? GROUP BY m.account_id ORDER BY points DESC, a.display_name`, since, params.id);
    let rank = 0, last = null, shown = 0;
    const out = []; let mine = null;
    rows.forEach((r, i) => {
      if (r.points !== last) { rank = i + 1; last = r.points; }
      // (The supporter badge, and never a phone number.)
      const entry = { rank, name: boardName(r) ?? 'Hidden', points: r.points, you: r.account_id === me.id, supporter: r.board !== 'hidden' && r.supporter_until != null && r.supporter_until > now() };
      if (entry.you) mine = entry;
      if ((r.board !== 'hidden' || entry.you) && r.points > 0 && shown < 100) { out.push(entry); shown++; }
    });
    return { period, since, board: out, you: mine };
  });

  // ================= the shared Claude (owner's plan): queue + limits =================
  const limitsNow = () => ({ ...BUDGET, ...getSetting('limits', {}) });
  // One person's shared-Claude settings from the owner (limits, trusted, blocked), and the limits that apply to them.
  const overrideOf = (a) => cleanOverride(a?.claude_override ? JSON.parse(a.claude_override) : null);
  const limitsOf = (a) => limitsFor(getSetting('limits', {}), overrideOf(a));
  const ownerIds = () => new Set(h.all("SELECT id FROM accounts WHERE role = 'owner'").map((r) => r.id));
  const DAY_MS = 86400_000;
  const dayStart = () => Date.parse(`${dayKey(now())}T00:00:00Z`);
  // Jobs someone takes part in: ones they started plus ones they joined.
  const MINE = '(j.account_id = ? OR j.id IN (SELECT job_id FROM scan_job_members WHERE account_id = ?))';
  const avgMinutes = () => {
    const r = h.all("SELECT started_at, finished_at FROM scan_jobs WHERE status = 'done' AND started_at IS NOT NULL ORDER BY finished_at DESC LIMIT 20");
    return r.length ? r.reduce((s, x) => s + (x.finished_at - x.started_at), 0) / r.length / 60_000 : limitsNow().defaultJobMinutes;
  };
  const queueOrder = () => {
    const owners = ownerIds();
    return h.all("SELECT * FROM scan_jobs WHERE status IN ('queued','running') ORDER BY created_at")
      .sort((a, b) => (b.status === 'running') - (a.status === 'running') || owners.has(b.account_id) - owners.has(a.account_id) || a.created_at - b.created_at);
  };
  const jobOut = (j, order = queueOrder()) => {
    const pos = order.findIndex((x) => x.id === j.id);
    return {
      id: j.id, kind: j.kind, course: j.course_key, chapter: j.chapter, status: j.status, createdAt: j.created_at, finishedAt: j.finished_at, note: j.note,
      ...(pos >= 0 && j.status === 'queued' ? { position: pos, etaMinutes: Math.round(pos * avgMinutes()) } : {}),
    };
  };
  const allowance = (me) => {
    const L = limitsOf(me);
    const o = overrideOf(me);
    const today = h.get(`SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'`, me.id, dayStart()).n;
    const week = h.get(`SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'`, me.id, now() - 7 * DAY_MS).n;
    if (me.role === 'owner') return { unlimited: true };
    const cap = (v) => (Number.isFinite(v) ? v : null); // (null: no limit for this person)
    return { today, perDay: cap(L.perAccountDaily), week, perWeek: cap(L.perAccountWeekly), batchSize: L.questionBatchSize, trusted: o.trusted, blocked: o.blocked };
  };
  /** Counts every request; flags someone refused a lot, and suspends an account sending requests like a script. */
  const watchRequests = (me, kind, outcome, ip) => {
    const day = dayKey(now());
    h.run('INSERT INTO scan_requests (account_id,kind,outcome,at,day) VALUES (?,?,?,?,?)', me.id, kind, outcome, now(), day);
    if (me.role === 'owner') return;
    const L = limitsOf(me);
    const all = h.get('SELECT COUNT(*) AS n FROM scan_requests WHERE account_id = ? AND day = ?', me.id, day).n;
    const refused = h.get("SELECT COUNT(*) AS n FROM scan_requests WHERE account_id = ? AND day = ? AND outcome LIKE 'refuse%'", me.id, day).n;
    const openToday = (reason) => h.get("SELECT 1 FROM flags WHERE account_id = ? AND reason = ? AND status = 'open' AND at >= ?", me.id, reason, dayStart());
    if (all >= L.requestsBeforeSuspend) {
      h.tx(() => {
        h.run("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?", now(), me.id);
        h.run('DELETE FROM sessions WHERE account_id = ?', me.id);
        if (!openToday('script_requests')) h.run('INSERT INTO flags (account_id,reason,detail,auto_suspended,at) VALUES (?,?,?,1,?)', me.id, 'script_requests', JSON.stringify({ requestsToday: all }), now());
      });
      audit('system', 'flag.auto_suspend', me.id, { requestsToday: all }, ip);
      throw new HttpError(403, 'This account was paused for review: it sent far more requests than a person would. Kea’s creator will look at it.');
    }
    if (refused >= L.refusalsBeforeFlag && !openToday('many_refusals')) {
      h.run('INSERT INTO flags (account_id,reason,detail,at) VALUES (?,?,?,?)', me.id, 'many_refusals', JSON.stringify({ refusedToday: refused }), now());
      audit('system', 'flag.open', me.id, { refusedToday: refused }, ip);
    }
  };

  // ---------- Course material into each person's own Kea storage ----------
  // What the shared Claude made for a course section (textbook chapters, new questions) is kept in the section's
  // folder under material/. Everyone who asked for it, joined it, or shares the section gets a copy in their own
  // storage, under <their Kea folder>/Shared/, which their Kea takes in on its next sync.
  function targetOf(v) {
    const t = checkPath(V.str(v, 'Target', { min: 5, max: 300 }).replace(/\/+$/, ''));
    if (!t.startsWith('kea/') || t === 'kea/Documents' || t.startsWith('kea/Documents/')) bad('Course material can only go into your Kea folder.');
    return `${t}/`;
  }
  /** Their Kea folder when their Kea didn't say: the one profile folder in their storage, if there's exactly one. */
  function guessTarget(accountId) {
    const roots = new Set(h.all("SELECT path FROM files WHERE account_id = ? AND path LIKE 'kea/%/Devices/%'", accountId).map((r) => r.path.slice(0, r.path.indexOf('/Devices/') + 1)));
    return roots.size === 1 ? [...roots][0] : null;
  }
  /** Copies course files (material/<rel>) to each person's <target>Shared/<rel>. Returns how many copies were made. */
  function deliver(key, files, people) {
    const sp = spaces.course(key);
    let n = 0;
    for (const p of people) {
      const target = p.target || guessTarget(p.id);
      const a = h.get('SELECT * FROM accounts WHERE id = ?', p.id);
      if (!a) continue;
      if (!target) { audit('system', 'material.no_folder', p.id, { course: key }, 'local'); continue; }
      const user = spaces.user(p.id);
      let room = quotaOf(a) - usedBy(p.id);
      for (const f of files) {
        if (!f.path.startsWith('material/')) continue;
        let dest;
        try { dest = checkPath(`${target}Shared/${f.path.slice('material/'.length)}`); } catch { continue; }
        const mine = spaceRow(user, dest);
        if (mine?.sha256 === f.sha256) continue; // already there
        if (f.size - (mine?.size ?? 0) > room) {
          audit('system', 'material.storage_full', p.id, { course: key, path: f.path }, 'local');
          notify(p.id, 'storage', 'Your Kea storage is full', `New course material couldn’t be copied into your Kea storage (${fmtBytes(quotaOf(a))}). Nothing was deleted. Make some room and it comes with the next update.`, { data: { course: key } });
          break;
        }
        const row = spaceRow(sp, f.path);
        if (!row) continue;
        spaceWrite(user, dest, spaceRead(sp, row));
        room -= f.size - (mine?.size ?? 0);
        n++;
      }
    }
    return n;
  }
  // When a job finishes: what it added to the section's material, to everyone in it. A scan's requester already has
  // theirs (the worker wrote their whole folder as their primary device); a question batch goes to everyone.
  /** "BIO 1010, Chapter 4" style words for a job, from what the person's Kea said when it asked. */
  // (Built only from the normalized course key and a cleaned chapter name: what a person types never reaches someone
  // else's notice as is, so nobody can put a message or a link in a classmate's notifications.)
  function jobLabel(j) {
    const course = j.kind === 'initial_scan' ? 'your classes' : keyLabel(j.course_key);
    const chapter = j.chapter ? cleanText(j.chapter).replace(/[^\p{L}\p{N} .#-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return chapter ? `${course}, ${chapter}` : course;
  }
  function deliverJob(j) {
    if (j.delivered) return 0;
    const files = spaceList(spaces.course(j.course_key), 'material/').filter((f) => f.updatedAt >= (j.started_at ?? 0));
    const people = [
      ...(j.kind === 'more_questions' ? [{ id: j.account_id, target: j.target }] : []),
      ...h.all('SELECT account_id AS id, target FROM scan_job_members WHERE job_id = ?', j.id),
    ];
    const got = new Map(people.map((p) => [p.id, files.length ? deliver(j.course_key, files, [p]) : 0]));
    const n = [...got.values()].reduce((a, b) => a + b, 0);
    h.run('UPDATE scan_jobs SET delivered = 1 WHERE id = ?', j.id);
    // Course material that arrived for someone who only joined (or asked for questions): a notice.
    const what = jobLabel(j);
    for (const [id, count] of got) {
      if (!count || id === j.account_id) continue; // (the person who asked hears it from the finish notice)
      if (j.kind === 'more_questions') notify(id, 'material', `New practice questions: ${what}`, 'They’re in your Kea storage and show up in My resources after Kea’s next sync.', { data: { jobId: j.id, files: count } });
      else notify(id, 'material', `Course material arrived: ${what}`, `${count} file${count === 1 ? '' : 's'} from a classmate’s scan are in your Kea storage. Kea takes them in with its next sync.`, { data: { jobId: j.id, files: count } });
    }
    // Classmates who joined a first scan now share the section's material from here on.
    if (j.kind === 'initial_scan') for (const p of people) h.run('INSERT OR IGNORE INTO course_members (course_key,account_id,joined_at,target) VALUES (?,?,?,?)', j.course_key, p.id, now(), p.target);
    return n;
  }

  // ---------- Getting into a course section ----------
  // A course key ("school|code|term|section") is easy to guess, so knowing it isn't enough: the people already in a
  // section let someone in (a request each of them sees in Kea, and a notice), or share the section's join code.
  // Until then they get no material and no course_members row.
  const isCourseMember = (key, accountId) => !!h.get('SELECT 1 FROM course_members WHERE course_key = ? AND account_id = ?', key, accountId);
  const sectionExists = (key) => !!key && !!(h.get('SELECT 1 FROM course_members WHERE course_key = ? LIMIT 1', key) || h.get('SELECT 1 FROM course_files WHERE course_key = ? LIMIT 1', key));
  /** "BIOL1010, fall 2026, section 2" from a course key ("school|code|term|section", already normalized). */
  function keyLabel(key) {
    const part = (v, max) => String(v ?? '').replace(/[^a-z0-9 .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const [, code, term, section] = String(key ?? '').split('|');
    const c = part(code, 16).toUpperCase();
    return [c || 'a course', part(term, 20), part(section, 10) ? `section ${part(section, 10)}` : ''].filter(Boolean).join(', ');
  }
  /** In: a member from now on, with what the section already has copied over, and in its first scan if that's still running. */
  function admit(key, accountId, target, by) {
    h.run('INSERT OR IGNORE INTO course_members (course_key,account_id,joined_at,target) VALUES (?,?,?,?)', key, accountId, now(), target ?? null);
    if (target) h.run('UPDATE course_members SET target = ? WHERE course_key = ? AND account_id = ?', target, key, accountId);
    h.run("UPDATE course_join_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE course_key = ? AND account_id = ? AND status = 'pending'", by, now(), key, accountId);
    const scan = h.get("SELECT * FROM scan_jobs WHERE course_key = ? AND kind = 'initial_scan' AND status IN ('queued','running') ORDER BY created_at LIMIT 1", key);
    if (scan && scan.account_id !== accountId) h.run('INSERT OR IGNORE INTO scan_job_members (job_id,account_id,joined_at,target) VALUES (?,?,?,?)', scan.id, accountId, now(), target ?? null);
    const delivered = deliver(key, spaceList(spaces.course(key), 'material/'), [{ id: accountId, target: target ?? h.get('SELECT target FROM course_members WHERE course_key = ? AND account_id = ?', key, accountId)?.target }]);
    return { delivered, jobId: scan?.id ?? null };
  }
  const requestOut = (r) => ({ id: r.id, course: r.course_key, label: r.label, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at });
  function askToJoin(me, key, target, label, ip) {
    const PENDING = 'Someone in this course section has to let you in first. They got your request in Kea. Or ask one of them for the section code.';
    const open = h.get("SELECT * FROM course_join_requests WHERE course_key = ? AND account_id = ? AND status = 'pending'", key, me.id);
    if (open) {
      if (target) h.run('UPDATE course_join_requests SET target = ? WHERE id = ?', target, open.id);
      return { status: 'pending', message: PENDING, request: requestOut(open), allowance: allowance(me) };
    }
    // Said no recently: no new request (and no new notices for them) for a day.
    const no = h.get("SELECT * FROM course_join_requests WHERE course_key = ? AND account_id = ? AND status = 'declined' AND decided_at > ? ORDER BY decided_at DESC LIMIT 1", key, me.id, now() - DAY_MS);
    if (no) return { status: 'declined', message: 'Someone in this section said no. Ask one of them for the section code instead.', request: requestOut(no), allowance: allowance(me) };
    // A few new requests a day per person: each one notifies everyone in the section.
    const [perDay, dayMs] = L.joinRequest;
    if (me.role !== 'owner' && h.get('SELECT COUNT(*) AS n FROM course_join_requests WHERE account_id = ? AND created_at > ?', me.id, now() - dayMs).n >= perDay)
      throw new HttpError(429, `You’ve asked to join ${perDay} course sections today. Try again tomorrow, or ask someone in the section for its code.`, { code: 'join_requests_daily' });
    const id = randomUUID();
    h.run('INSERT INTO course_join_requests (id,course_key,account_id,target,label,created_at) VALUES (?,?,?,?,?,?)', id, key, me.id, target, label, now());
    audit(me.id, 'course.join_request', id, { course: key }, ip);
    // (The asker's name goes along as data for the app to show, never inside the title.) A section that got a lot of
    // requests today stops getting notices for new ones; the requests still wait in Kea's list.
    const todays = h.get('SELECT COUNT(*) AS n FROM course_join_requests WHERE course_key = ? AND created_at > ?', key, now() - DAY_MS).n;
    if (todays <= 20) for (const m of h.all('SELECT account_id FROM course_members WHERE course_key = ? ORDER BY joined_at LIMIT 50', key))
      notify(m.account_id, 'course_join', `Someone asks to join ${label}`, 'Let them in from Kea’s shared Claude panel, or give them this section’s code. Say no if you don’t know them.', { data: { requestId: id, course: key, label, name: cleanText(me.display_name).slice(0, 60) } });
    return { status: 'pending', message: PENDING, request: requestOut(h.get('SELECT * FROM course_join_requests WHERE id = ?', id)), allowance: allowance(me) };
  }
  const sectionKeyOf = (v) => (typeof v === 'string' ? V.str(v, 'Course', { min: 3, max: 400 }) : courseKey(V.obj(v))) ?? bad('Say which course.');
  const asSectionMember = (me, key) => { if (me.role !== 'owner' && !isCourseMember(key, me.id)) notFound('Course not found.'); };
  // Requests to join sections I'm in (to let in or turn down), and my own.
  R('GET', '/v1/course-sections/requests', ({ me }) => ({
    incoming: h.all("SELECT r.*, a.display_name FROM course_join_requests r JOIN accounts a ON a.id = r.account_id WHERE r.status = 'pending' AND r.course_key IN (SELECT course_key FROM course_members WHERE account_id = ?) ORDER BY r.created_at", me.id)
      .map((r) => ({ ...requestOut(r), name: r.display_name })),
    mine: h.all('SELECT * FROM course_join_requests WHERE account_id = ? ORDER BY created_at DESC LIMIT 50', me.id).map(requestOut),
  }));
  R('POST', '/v1/course-sections/requests/:id/decide', ({ me, params, body, ip }) => {
    const r = h.get('SELECT * FROM course_join_requests WHERE id = ?', params.id) ?? notFound('Request not found.');
    asSectionMember(me, r.course_key);
    const approve = V.bool(body.approve, 'approve');
    if (r.status !== 'pending') return { request: requestOut(r) };
    if (approve) {
      const got = admit(r.course_key, r.account_id, r.target, me.id);
      notify(r.account_id, 'course_join', `You’re in: ${r.label}`, got.jobId ? 'The class scan is still running. Its material comes into Kea when it finishes.' : 'The section’s material comes into Kea with the next sync.', { data: { requestId: r.id, course: r.course_key, status: 'approved' } });
    } else {
      h.run("UPDATE course_join_requests SET status = 'declined', decided_by = ?, decided_at = ? WHERE id = ?", me.id, now(), r.id);
      notify(r.account_id, 'course_join', `Your request to join ${r.label} wasn’t accepted`, 'You can ask someone in the section for its code.', { data: { requestId: r.id, course: r.course_key, status: 'declined' } });
    }
    audit(me.id, approve ? 'course.join_approve' : 'course.join_decline', r.id, { course: r.course_key, account: r.account_id }, ip);
    return { request: requestOut(h.get('SELECT * FROM course_join_requests WHERE id = ?', r.id)) };
  });
  // The section's join code, for someone in it to share (made the first time it's asked for; reset: true makes a new
  // one, so an old code that went around stops working).
  R('POST', '/v1/course-sections/code', ({ me, body, ip }) => {
    const key = sectionKeyOf(body.course);
    asSectionMember(me, key);
    let c = h.get('SELECT * FROM course_codes WHERE course_key = ?', key);
    if (!c || body.reset === true) {
      h.run('INSERT INTO course_codes (course_key,code,created_by,created_at) VALUES (?,?,?,?) ON CONFLICT(course_key) DO UPDATE SET code = excluded.code, created_by = excluded.created_by, created_at = excluded.created_at', key, newCode(), me.id, now());
      audit(me.id, 'course.code', null, { course: key, reset: !!c }, ip);
      c = h.get('SELECT * FROM course_codes WHERE course_key = ?', key);
    }
    return { course: key, code: c.code, createdAt: c.created_at };
  });

  R('POST', '/v1/scan', ({ me, body, ip }) => {
    limit('join', me.id);
    const kind = V.str(body.kind, 'Kind', { min: 1, max: 40 });
    const key = courseKey(V.obj(body.course));
    if (!key && kind !== 'regenerate') bad('Say which course: school, course code and term (and section if there is one).');
    const chapter = kind === 'more_questions' ? V.str(body.chapter, 'Chapter', { optional: true, max: 120 }) : null;
    const t = now();
    const mats = key ? h.get('SELECT * FROM course_materials WHERE course_key = ?', key) : null;
    const same = key ? h.get(`SELECT * FROM scan_jobs WHERE kind = ? AND course_key = ? AND status IN ('queued','running') ${kind === 'more_questions' ? 'AND chapter = ?' : ''} ORDER BY created_at LIMIT 1`, ...[kind, key, ...(kind === 'more_questions' ? [chapter] : [])]) : null;
    // Where course material for them goes in their own Kea storage (their Kea's folder for this profile).
    const target = body.target == null ? null : targetOf(body.target);
    const facts = {
      verified: !!me.email_verified, owner: me.role === 'owner', chapter,
      blocked: overrideOf(me).blocked, blockedReason: overrideOf(me).reason,
      birthYear: me.birth_year ?? null, year: thisYear(), parentApproved: parentApproved(me.id),
      alreadyScannedByMe: !!(key && h.get('SELECT 1 FROM course_members WHERE course_key = ? AND account_id = ?', key, me.id)),
      courseHasMaterials: !!mats, hoursSinceCourseUpdate: mats ? (t - mats.updated_at) / 3600_000 : null,
      joinJobId: same && same.account_id !== me.id ? same.id : same ? same.id : null,
      myQueued: h.get("SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND status IN ('queued','running')", me.id).n,
      myJobsToday: h.get("SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'", me.id, dayStart()).n,
      myJobsThisWeek: h.get("SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'", me.id, t - 7 * DAY_MS).n,
      myBatchesThisChapter: kind === 'more_questions' ? h.get(`SELECT COUNT(*) AS n FROM scan_jobs j WHERE ${MINE} AND kind = 'more_questions' AND course_key = ? AND chapter = ? AND status NOT IN ('cancelled','failed')`, me.id, me.id, key, chapter).n : 0,
      myBatchesToday: kind === 'more_questions' ? h.get(`SELECT COUNT(*) AS n FROM scan_jobs j WHERE ${MINE} AND kind = 'more_questions' AND created_at >= ? AND status NOT IN ('cancelled','failed')`, me.id, me.id, dayStart()).n : 0,
    };
    const d = decide(kind, limitsOf(me), facts);
    const gated = d.action !== 'refuse' && me.role !== 'owner' && sectionExists(key) && !isCourseMember(key, me.id);
    watchRequests(me, kind, d.action === 'refuse' ? `refuse:${d.code}` : gated ? 'gate' : d.action, ip);
    if (d.action === 'refuse') throw new HttpError(429, d.reason, { code: d.code, allowance: allowance(me) });
    // A section someone else already started (its material, its running jobs): only for people in it. Getting in takes
    // the section's join code, or someone in it saying yes to a request.
    if (gated) {
      if (body.joinCode != null && body.joinCode !== '') {
        limit('join', ip);
        const c = h.get('SELECT * FROM course_codes WHERE course_key = ?', key);
        if (!c || c.code !== normCode(body.joinCode)) notFound("That section code doesn't work. Check it, or ask someone in the section.");
        const got = admit(key, me.id, target, null);
        audit(me.id, 'course.join_code', null, { course: key }, ip);
        if (kind === 'initial_scan') return { status: 'shared', message: 'You’re in this section now. Its material comes into Kea with the next sync.', delivered: got.delivered, allowance: allowance(me) };
        // (Asking for something else, like more questions: carry on with that now they're in.)
      } else {
        // (Whatever they asked for: once someone lets them in, they get the section's material and can ask again.)
        return askToJoin(me, key, target, keyLabel(key), ip);
      }
    }
    // The first person in a section (by asking for anything on it) is its first member, and can let others in.
    if (kind === 'initial_scan' || (d.action === 'queue' && !sectionExists(key))) {
      h.run('INSERT OR IGNORE INTO course_members (course_key,account_id,joined_at) VALUES (?,?,?)', key, me.id, t);
      if (target) h.run('UPDATE course_members SET target = ? WHERE course_key = ? AND account_id = ?', target, key, me.id);
    }
    if (d.action === 'share') {
      // The section's material, copied into their own Kea storage now: their Kea takes it in on its next sync.
      const copied = deliver(key, spaceList(spaces.course(key), 'material/'), [{ id: me.id, target }]);
      return { status: 'shared', message: d.reason, delivered: copied, allowance: allowance(me) };
    }
    if (d.action === 'join') {
      h.run('INSERT OR IGNORE INTO scan_job_members (job_id,account_id,joined_at,target) VALUES (?,?,?,?)', d.jobId, me.id, t, target);
      return { status: 'joined', message: d.reason, job: jobOut(h.get('SELECT * FROM scan_jobs WHERE id = ?', d.jobId)), allowance: allowance(me) };
    }
    const id = randomUUID();
    // Scans need what the person's Kea collected from their class site: they upload it to
    // scan-inbox/<job id>/ in their own Kea storage, then say it's ready. Question batches work from the course's
    // shared material, so they're ready at once.
    // The whole line has a cap, so a crowd of new accounts can't queue thousands of jobs.
    if (me.role !== 'owner' && h.get("SELECT COUNT(*) AS n FROM scan_jobs WHERE status = 'queued'").n >= (limitsNow().maxQueuedJobs ?? 100))
      throw new HttpError(503, 'Kea’s shared Claude has a long line right now. Try again later.', { code: 'queue_full', retryAfter: 600, allowance: allowance(me) });
    const ready = kind === 'more_questions' ? 1 : 0;
    const detail = body.detail == null ? null : JSON.stringify(body.detail);
    if (detail && detail.length > 4000) bad('The request’s details are too long.');
    h.run('INSERT INTO scan_jobs (id,account_id,kind,course_key,chapter,detail,created_at,ready,target) VALUES (?,?,?,?,?,?,?,?,?)', id, me.id, kind, key, chapter, detail, t, ready, target);
    return { status: 'queued', job: jobOut(h.get('SELECT * FROM scan_jobs WHERE id = ?', id)), uploadTo: ready ? null : `scan-inbox/${id}/`, allowance: allowance(me) };
  });
  R('POST', '/v1/scan/:id/ready', ({ me, params }) => {
    const j = h.get("SELECT * FROM scan_jobs WHERE id = ? AND account_id = ? AND status = 'queued'", params.id, me.id) ?? notFound('Nothing waiting with that id.');
    const files = spaceList(spaces.user(me.id), `scan-inbox/${j.id}/`);
    if (!files.length) bad(`Upload your class content to scan-inbox/${j.id}/ first.`);
    h.run('UPDATE scan_jobs SET ready = 1 WHERE id = ?', j.id);
    return { job: jobOut(h.get('SELECT * FROM scan_jobs WHERE id = ?', j.id)), files: files.length };
  });
  // A course section's shared material (what the shared Claude made), for anyone in that section.
  const courseAccess = (me, key) => {
    if (!key) bad('Say which course.');
    if (me.role !== 'owner' && !h.get('SELECT 1 FROM course_members WHERE course_key = ? AND account_id = ?', key, me.id)) notFound('Course not found.');
    return spaces.course(key);
  };
  R('GET', '/v1/course-files', ({ me, query }) => ({ files: spaceList(courseAccess(me, query.course), String(query.prefix ?? ''), Number(query.since) || 0) }));
  R('GET', '/v1/course-file', ({ me, query }) => {
    const sp = courseAccess(me, query.course);
    const row = spaceRow(sp, String(query.path ?? '')) ?? notFound('No such file.');
    return rawOut(spaceRead(sp, row), { etag: `"${row.version}"`, 'x-kea-sha256': row.sha256 });
  });
  R('GET', '/v1/scan', ({ me }) => {
    const order = queueOrder();
    return {
      jobs: h.all(`SELECT * FROM scan_jobs j WHERE ${MINE} ORDER BY created_at DESC LIMIT 50`, me.id, me.id).map((j) => jobOut(j, order)),
      allowance: allowance(me),
      paused: (getSetting('pausedUntil', 0) || 0) > now(),
    };
  });
  R('POST', '/v1/scan/:id/cancel', ({ me, params }) => {
    const j = h.get("SELECT * FROM scan_jobs WHERE id = ? AND status = 'queued'", params.id) ?? notFound('Nothing waiting with that id.');
    if (j.account_id !== me.id) {
      h.run('DELETE FROM scan_job_members WHERE job_id = ? AND account_id = ?', j.id, me.id);
      return { ok: true };
    }
    // Someone else joined it: it's theirs now instead of being cancelled.
    const heir = h.get('SELECT account_id FROM scan_job_members WHERE job_id = ? ORDER BY joined_at LIMIT 1', j.id);
    h.tx(() => {
      if (heir) {
        h.run('UPDATE scan_jobs SET account_id = ? WHERE id = ?', heir.account_id, j.id);
        h.run('DELETE FROM scan_job_members WHERE job_id = ? AND account_id = ?', j.id, heir.account_id);
      } else h.run("UPDATE scan_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?", now(), j.id);
    });
    return { ok: true };
  });
  // ---------- The relay: the owner's worker browses through the person's own Kea ----------
  // While a job runs, the worker (Claude on the owner's PC) asks the person's Kea to fetch, open or click on their
  // class site. Their Kea is signed in with their own password; only page text comes back. Calls live in memory:
  // they only matter while both sides are connected.
  const relays = new Map(); // job id -> { queue: [], waiters: [], pending: Map(callId -> { resolve, timer }), seenAt }
  const relayOf = (jobId) => {
    let r = relays.get(jobId);
    if (!r) relays.set(jobId, (r = { queue: [], waiters: [], pending: new Map(), seenAt: 0 }));
    return r;
  };
  const dropRelay = (jobId, why) => {
    const r = relays.get(jobId);
    if (!r) return;
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: why }); }
    for (const w of r.waiters) w([]);
    relays.delete(jobId);
  };
  const RELAY_OPS = ['request', 'open', 'click', 'status'];
  const myRunningJob = (me, id) => h.get("SELECT * FROM scan_jobs WHERE id = ? AND account_id = ? AND status = 'running'", id, me.id) ?? notFound('No job of yours is running with that id.');
  // The person's Kea waits here (up to 20 s at a time) for the worker's next calls.
  R('GET', '/v1/scan/:id/calls', async ({ me, params }) => {
    const j = myRunningJob(me, params.id);
    const r = relayOf(j.id);
    r.seenAt = now();
    if (r.queue.length) return { calls: r.queue.splice(0) };
    const calls = await new Promise((resolve) => {
      const w = (list) => { clearTimeout(t); resolve(list); };
      const t = setTimeout(() => { r.waiters = r.waiters.filter((x) => x !== w); resolve([]); }, relayWaitMs);
      r.waiters.push(w);
    });
    r.seenAt = now();
    return { calls };
  });
  R('POST', '/v1/scan/:id/calls/:callId/result', ({ me, params, body }) => {
    const j = myRunningJob(me, params.id);
    const r = relayOf(j.id);
    const p = r.pending.get(params.callId);
    if (!p) return { ok: true, late: true };
    clearTimeout(p.timer);
    r.pending.delete(params.callId);
    p.resolve({ ok: body.ok !== false, result: body.result ?? null, error: body.error ? String(body.error).slice(0, 2000) : null });
    return { ok: true };
  });

  // Donations: one quiet link the apps can show on the account page. Never a pop-up, never a nag.
  R('GET', '/v1/support', () => getSetting('donate', { url: null, message: null }), { auth: false });

  // ================= owner console (localhost, never tunneled) =================
  const own = makeRouter();
  const O = own.add;
  // The worker on the owner's PC: take the next job, report when it's done. Paused (or over today's total for others):
  // only the owner's own jobs come out.
  O('POST', '/owner/scan/next', () => {
    if (h.get("SELECT 1 FROM scan_jobs WHERE status = 'running'")) return { job: null, reason: 'A job is already running.' };
    const done = new Map(h.all("SELECT account_id, COUNT(*) AS n FROM scan_jobs WHERE started_at >= ? AND status IN ('running','done') GROUP BY account_id", dayStart()).map((r) => [r.account_id, r.n]));
    const owners = ownerIds();
    const globalUsedToday = h.get(`SELECT COUNT(*) AS n FROM scan_jobs WHERE started_at >= ? AND status IN ('running','done','failed') AND account_id NOT IN (SELECT id FROM accounts WHERE role = 'owner')`, dayStart()).n;
    const j = pickNext(h.all("SELECT * FROM scan_jobs WHERE status = 'queued' AND ready = 1"), { doneTodayByAccount: done, ownerIds: owners, globalUsedToday, limits: getSetting('limits', {}), paused: (getSetting('pausedUntil', 0) || 0) > now() });
    if (!j) return { job: null };
    h.run("UPDATE scan_jobs SET status = 'running', started_at = ? WHERE id = ?", now(), j.id);
    const members = h.all('SELECT a.id, a.email FROM accounts a WHERE a.id = ? OR a.id IN (SELECT account_id FROM scan_job_members WHERE job_id = ?)', j.account_id, j.id);
    return { job: { ...jobOut(h.get('SELECT * FROM scan_jobs WHERE id = ?', j.id)), detail: j.detail ? JSON.parse(j.detail) : null, members } };
  });
  O('POST', '/owner/scan/:id/finish', ({ params, body }) => {
    const j = h.get("SELECT * FROM scan_jobs WHERE id = ? AND status = 'running'", params.id) ?? notFound('No running job with that id.');
    const ok = V.bool(body.ok, 'ok');
    h.tx(() => {
      h.run('UPDATE scan_jobs SET status = ?, finished_at = ?, note = ? WHERE id = ?', ok ? 'done' : 'failed', now(), V.str(body.note, 'note', { optional: true, max: 2000 }), j.id);
      if (ok && j.kind !== 'more_questions') h.run('INSERT INTO course_materials (course_key,first_job_id,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(course_key) DO UPDATE SET updated_at = excluded.updated_at', j.course_key, j.id, now(), now());
      // The uploaded class content isn't kept once the job is over.
      spaceDeletePrefix(spaces.user(j.account_id), `scan-inbox/${j.id}/`);
    });
    dropRelay(j.id, 'The job has finished.');
    // The person who asked hears that it finished (or didn't); people who joined hear when material arrives.
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    const what = jobLabel(j);
    if (ok && j.kind === 'more_questions') notify(j.account_id, 'scan_done', `Your new practice questions are ready: ${what}`, 'They show up in My resources after Kea’s next sync.', { data: { jobId: j.id, ok } });
    else if (ok) notify(j.account_id, 'scan_done', 'Kea’s shared Claude finished setting up your classes', 'Your classes come into Kea with its next sync.', { data: { jobId: j.id, ok } });
    else notify(j.account_id, 'scan_done', j.kind === 'more_questions' ? `Your new practice questions didn’t finish: ${what}` : 'Your class scan didn’t finish', `${note ? `${note} ` : ''}You can ask again.`, { data: { jobId: j.id, ok } });
    const delivered = ok ? deliverJob(h.get('SELECT * FROM scan_jobs WHERE id = ?', j.id)) : 0;
    return { ok: true, delivered };
  });
  const runningJob = (id) => h.get("SELECT * FROM scan_jobs WHERE id = ? AND status = 'running'", id) ?? notFound('No running job with that id.');
  // The worker's side of the relay: one call, answered by the person's Kea (or an error if it's closed).
  O('POST', '/owner/scan/:id/call', async ({ params, body }) => {
    const j = runningJob(params.id);
    const op = V.enum(body.op, 'op', RELAY_OPS);
    const r = relayOf(j.id);
    const id = randomUUID();
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => { r.pending.delete(id); resolve({ ok: false, error: 'The student’s Kea didn’t answer in time. Is it open and online?' }); }, relayAnswerMs);
      r.pending.set(id, { resolve, timer });
    });
    const call = { id, op, args: V.obj(body.args) };
    const w = r.waiters.shift();
    if (w) w([call]); else r.queue.push(call);
    return answer;
  });
  O('GET', '/owner/scan/:id/relay', ({ params }) => {
    const j = runningJob(params.id);
    const r = relays.get(j.id);
    return { connected: !!r && now() - (r.seenAt || 0) < 30_000, waiting: r?.waiters.length ?? 0, queued: r?.queue.length ?? 0 };
  });
  // The person's Kea profile folder for this job (kea/Kea/<profile>/) while their job runs: the worker is their primary
  // device for it. Nothing else in their storage: not their other profiles, and never their Kea Cloud documents
  // (kea/Documents/).
  const PROFILE_DIR = /^kea\/Kea\/[^/]+\/$/;
  function jobScope(j) {
    let t = PROFILE_DIR.test(j.target || '') ? j.target : guessTarget(j.account_id);
    // (Else the profile their Kea named in the job.json it uploaded for this job.)
    if (!t || !PROFILE_DIR.test(t)) {
      try {
        const sp = spaces.user(j.account_id);
        const row = spaceRow(sp, `scan-inbox/${j.id}/job.json`);
        const profile = row && row.size < 64 * 1024 ? JSON.parse(spaceRead(sp, row).toString('utf8')).profile : null;
        if (typeof profile === 'string') t = `${checkPath(`kea/Kea/${profile}`)}/`;
      } catch {}
    }
    if (!t || !PROFILE_DIR.test(t)) forbidden('This job has no Kea profile folder to work in.');
    return t;
  }
  function inScope(j, p) {
    const scope = jobScope(j);
    if (!p.startsWith(scope) || p === scope || p.startsWith('kea/Documents/')) forbidden('Only the job’s Kea profile folder.');
    return p;
  }
  O('GET', '/owner/scan/:id/kea-files', ({ params, query }) => {
    const j = runningJob(params.id);
    const scope = jobScope(j);
    return { files: spaceList(spaces.user(j.account_id), scope, Number(query.since) || 0), scope, now: now() };
  });
  O('GET', '/owner/scan/:id/kea-file', ({ params, query }) => {
    const j = runningJob(params.id);
    const p = inScope(j, String(query.path ?? ''));
    const sp = spaces.user(j.account_id);
    return rawOut(spaceRead(sp, spaceRow(sp, p) ?? notFound()));
  });
  O('PUT', '/owner/scan/:id/kea-file', ({ params, query, raw }) => {
    const j = runningJob(params.id);
    const p = inScope(j, checkPath(String(query.path ?? '')));
    return spaceWrite(spaces.user(j.account_id), p, raw);
  });
  O('DELETE', '/owner/scan/:id/kea-file', ({ params, query }) => {
    const j = runningJob(params.id);
    const p = inScope(j, String(query.path ?? ''));
    const sp = spaces.user(j.account_id);
    const row = spaceRow(sp, p);
    if (row) { h.run('DELETE FROM files WHERE account_id = ? AND path = ?', j.account_id, p); rmSync(join(sp.dir, row.blob), { force: true }); }
    return { ok: true };
  });
  // What the person's Kea uploaded for this job.
  O('GET', '/owner/scan/:id/inbox', ({ params }) => {
    const j = runningJob(params.id);
    return { files: spaceList(spaces.user(j.account_id), `scan-inbox/${j.id}/`) };
  });
  O('GET', '/owner/scan/:id/inbox-file', ({ params, query }) => {
    const j = runningJob(params.id);
    const p = String(query.path ?? '');
    if (!p.startsWith(`scan-inbox/${j.id}/`)) forbidden('Only this job’s uploads.');
    const sp = spaces.user(j.account_id);
    return rawOut(spaceRead(sp, spaceRow(sp, p) ?? notFound()));
  });
  // Results: shared ones into the course section's folder; private ones (a person's own assignment guides) into
  // that person's storage. Only while the job runs, and only for its own course and members.
  O('PUT', '/owner/scan/:id/course-file', ({ params, query, raw }) => {
    const j = runningJob(params.id);
    return spaceWrite(spaces.course(j.course_key), checkPath(String(query.path ?? '')), raw);
  });
  O('PUT', '/owner/scan/:id/member-file', ({ params, query, raw }) => {
    const j = runningJob(params.id);
    const who = String(query.account ?? '');
    if (who !== j.account_id && !h.get('SELECT 1 FROM scan_job_members WHERE job_id = ? AND account_id = ?', j.id, who)) forbidden('Not in this job.');
    return spaceWrite(spaces.user(who), `kea-results/${checkPath(String(query.path ?? ''))}`, raw);
  });
  // The plan hit its limit, or the owner needs it: others' jobs wait until then (hours null = resume now).
  O('POST', '/owner/scan/pause', ({ body }) => {
    const hours = body.hours == null ? null : Number(body.hours);
    setSetting('pausedUntil', hours ? now() + hours * 3600_000 : 0);
    return { pausedUntil: getSetting('pausedUntil', 0) };
  });
  O('GET', '/owner/scan/queue', () => {
    const order = queueOrder();
    const emails = new Map(h.all('SELECT id, email FROM accounts').map((a) => [a.id, a.email]));
    return { paused: (getSetting('pausedUntil', 0) || 0) > now(), avgMinutes: Math.round(avgMinutes()), jobs: order.map((j) => ({ ...jobOut(j, order), email: emails.get(j.account_id), joined: h.get('SELECT COUNT(*) AS n FROM scan_job_members WHERE job_id = ?', j.id).n })) };
  });
  const settingsOut = () => ({ limits: limitsNow(), donate: getSetting('donate', { url: null, message: null }), storage: storageSettings(), audit: { keepDays: auditKeepDays() } });
  O('GET', '/owner/settings', () => settingsOut());
  O('POST', '/owner/settings', ({ body }) => {
    // Storage sizes, in bytes or GB: the standard size for everyone, and a supporter's.
    if (body.storage) {
      const st = V.obj(body.storage);
      const size = (bytesKey, gbKey) => {
        if (st[bytesKey] != null) return V.int(st[bytesKey], bytesKey, { min: 0, max: 1024 ** 5 });
        if (st[gbKey] != null) { const g = st[gbKey]; if (typeof g !== 'number' || !Number.isFinite(g) || g < 0 || g > 1_000_000) bad(`${gbKey} must be a number of GB from 0 to 1,000,000.`); return Math.round(g * 1024 ** 3); }
        return undefined;
      };
      const before = storageSettings();
      const next = { ...getSetting('storage', {}) };
      const d = size('defaultQuotaBytes', 'defaultGb'), sp = size('supporterQuotaBytes', 'supporterGb');
      if (d !== undefined) next.defaultQuotaBytes = d;
      if (sp !== undefined) next.supporterQuotaBytes = sp;
      // The limits for everyone together (bytes; globalBytes: null for none).
      for (const k of ['unverifiedQuotaBytes', 'dailyAccountBytes', 'dailyGlobalBytes', 'dailyEgressBytes']) if (st[k] != null) next[k] = V.int(st[k], k, { min: 0, max: 1024 ** 5 });
      if ('globalBytes' in st) next.globalBytes = st.globalBytes == null ? null : V.int(st.globalBytes, 'globalBytes', { min: 0, max: 1024 ** 5 });
      setSetting('storage', next);
      setSetting('storageSeen', storageSettings());
      audit('owner', 'owner.storage_settings', null, next, 'local');
      noticeStorageChange(before, storageSettings());
    }
    if (body.limits) {
      const next = { ...getSetting('limits', {}) };
      for (const [k, v] of Object.entries(V.obj(body.limits))) {
        if (!(k in BUDGET)) bad(`Unknown limit: ${k}`);
        if (typeof BUDGET[k] === 'boolean') next[k] = V.bool(v, k);
        else next[k] = V.int(v, k, { min: 0, max: 100_000 });
      }
      setSetting('limits', next);
    }
    if (body.audit) {
      const a = V.obj(body.audit);
      if (a.keepDays != null) { setSetting('auditKeepDays', V.int(a.keepDays, 'keepDays', { min: 30, max: 3650 })); audit('owner', 'owner.audit_settings', null, { keepDays: a.keepDays }, 'local'); sweep(true); }
    }
    if (body.donate) {
      const d = V.obj(body.donate);
      setSetting('donate', { url: V.url(d.url, 'Donation link'), message: V.str(d.message, 'Message', { optional: true, max: 200 }) });
    }
    return settingsOut();
  });
  O('GET', '/owner/flags', ({ query }) => ({
    flags: h.all('SELECT f.*, a.email, a.status AS account_status FROM flags f JOIN accounts a ON a.id = f.account_id WHERE f.status = ? ORDER BY f.at DESC LIMIT 200', query.status ?? 'open')
      .map((f) => ({ id: f.id, accountId: f.account_id, email: f.email, reason: f.reason, detail: f.detail ? JSON.parse(f.detail) : null, autoSuspended: !!f.auto_suspended, accountStatus: f.account_status, at: f.at, note: f.note })),
  }));
  O('POST', '/owner/flags/:id/resolve', ({ params, body }) => {
    const f = h.get('SELECT * FROM flags WHERE id = ?', Number(params.id)) ?? notFound();
    const action = V.enum(body.action ?? 'dismiss', 'action', ['dismiss', 'unsuspend', 'suspend']);
    h.tx(() => {
      if (action === 'unsuspend') h.run("UPDATE accounts SET status = 'active', updated_at = ? WHERE id = ?", now(), f.account_id);
      if (action === 'suspend') { h.run("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?", now(), f.account_id); h.run('DELETE FROM sessions WHERE account_id = ?', f.account_id); }
      h.run("UPDATE flags SET status = 'resolved', resolved_at = ?, note = ? WHERE id = ?", now(), V.str(body.note, 'note', { optional: true, max: 2000 }), f.id);
    });
    audit('owner', `owner.flag_${action}`, f.account_id, null, 'local');
    return { ok: true };
  });
  const getAccount = (id) => h.get('SELECT * FROM accounts WHERE id = ? OR email = ?', id, String(id).toLowerCase()) ?? notFound('No such account.');
  O('GET', '/owner/stats', () => ({
    accounts: h.get('SELECT COUNT(*) AS n FROM accounts').n,
    classes: h.get("SELECT COUNT(*) AS n FROM classes WHERE status = 'active'").n,
    pendingHosting: h.get("SELECT COUNT(*) AS n FROM host_applications WHERE status = 'pending'").n,
    failedSignInsToday: h.get("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'auth.fail%' AND at > ?", now() - 86400_000).n,
    // How the Hub tells visitors apart (the header it trusts), and any setup problem with it.
    clientAddress: { header: ipHeader || null, warnings: [...ipWarnings].map((code) => ({ code, text: IP_WARN[code] })) },
    // How loaded the Hub is: event-loop lag, password hashing, transfers, refused and shed requests, the log.
    busy: { ...busy, hashing: hashStats(), slots: Object.fromEntries(slots), log: hlog.stats() },
    // Owner powers (here and in the apps) wait until the owner account's two-step sign-in is on.
    ownerTotp: { ok: !ownerTotpOff(), message: ownerTotpOff() ? OWNER_TOTP_MESSAGE : null },
  }));
  O('GET', '/owner/accounts', ({ query }) => {
    const q = `%${String(query.q ?? '').toLowerCase()}%`;
    return { accounts: h.all('SELECT * FROM accounts WHERE lower(email) LIKE ? OR lower(display_name) LIKE ? ORDER BY created_at DESC LIMIT 200', q, q).map(ownerView) };
  });
  // One account, with everything the owner can set for it: storage, shared Claude, supporter.
  O('GET', '/owner/accounts/:id', ({ params }) => {
    const a = getAccount(params.id);
    return { account: ownerView(a), notifications: h.all('SELECT * FROM notifications WHERE account_id = ? ORDER BY id DESC LIMIT 20', a.id).map(noteOut) };
  });
  // Any storage size for one person (for example 5000 GB), or null for the standard size again.
  O('POST', '/owner/accounts/:id/quota', ({ params, body }) => {
    const a = getAccount(params.id);
    let bytes;
    if (body.bytes !== undefined) bytes = body.bytes === null ? null : V.int(body.bytes, 'bytes', { min: 0, max: 1024 ** 5 });
    else if (body.gb === null) bytes = null;
    else {
      if (typeof body.gb !== 'number' || !Number.isFinite(body.gb) || body.gb < 0 || body.gb > 1_000_000) bad('gb must be a number from 0 to 1,000,000, or null for the standard size.');
      bytes = Math.round(body.gb * 1024 ** 3);
    }
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    h.run('UPDATE accounts SET quota_bytes = ?, updated_at = ? WHERE id = ?', bytes, now(), a.id);
    const after = h.get('SELECT * FROM accounts WHERE id = ?', a.id);
    const quota = quotaOf(after), used = usedBy(a.id);
    audit('owner', 'owner.quota', a.id, { bytes, note }, 'local');
    notify(a.id, 'storage', `Your Kea storage is now ${fmtBytes(quota)}`, [bytes == null ? (supporterActive(after) ? 'That’s the supporter size, while you’re a supporter.' : 'That’s the standard size.') : '', used > quota ? overText(used, quota) : ''].filter(Boolean).join(' '), { note, data: { quota } });
    return { used, quota, account: ownerView(after) };
  });
  // Kea's shared Claude for one person: any per-account limit from hub/lib/budget.mjs (null = the Hub-wide number),
  // trusted (lifts their own caps), or blocked (with a reason they see). reset: true clears all of it.
  O('POST', '/owner/accounts/:id/claude', ({ params, body }) => {
    const a = getAccount(params.id);
    const before = overrideOf(a);
    const next = body.reset === true ? cleanOverride(null) : { ...before, limits: { ...before.limits } };
    if (body.limits != null) {
      for (const [k, v] of Object.entries(V.obj(body.limits))) {
        if (!ACCOUNT_LIMITS.includes(k)) bad(`Not a per-account limit: ${k}. Use one of: ${ACCOUNT_LIMITS.join(', ')}.`);
        if (v === null) delete next.limits[k];
        else next.limits[k] = V.int(v, k, { min: 0, max: 100_000 });
      }
    }
    if (body.trusted != null) next.trusted = V.bool(body.trusted, 'trusted');
    if (body.blocked != null) next.blocked = V.bool(body.blocked, 'blocked');
    if ('reason' in body) next.reason = V.str(body.reason, 'reason', { optional: true, max: 500 });
    if (!next.blocked) next.reason = null;
    const clean = cleanOverride(next);
    const empty = !Object.keys(clean.limits).length && !clean.trusted && !clean.blocked;
    h.run('UPDATE accounts SET claude_override = ?, updated_at = ? WHERE id = ?', empty ? null : JSON.stringify(clean), now(), a.id);
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    audit('owner', 'owner.claude', a.id, { before, after: clean, note }, 'local');
    const lines = describeOverride(before, clean, getSetting('limits', {}));
    if (lines.length) notify(a.id, 'claude', lines.length === 1 ? lines[0] : 'Changes to Kea’s shared Claude for you', lines.length === 1 ? '' : lines.join('\n'), { note, data: { override: clean } });
    return { account: ownerView(h.get('SELECT * FROM accounts WHERE id = ?', a.id)), notified: lines.length > 0 };
  });
  // Supporter, by hand: a month (or `months`) from now, or added to the end of the current time; or `until` a date;
  // or end: true to stop it now. Storage and a badge only: their shared-Claude limits don't change.
  O('POST', '/owner/accounts/:id/supporter', ({ params, body }) => {
    const a = getAccount(params.id);
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    const wasActive = supporterActive(a);
    if (body.end === true) {
      h.run('UPDATE accounts SET supporter_until = ?, supporter_lapse_noted = 1, updated_at = ? WHERE id = ?', wasActive ? now() : a.supporter_until, now(), a.id);
      audit('owner', 'owner.supporter_end', a.id, { note }, 'local');
      if (wasActive) supporterEnded(h.get('SELECT * FROM accounts WHERE id = ?', a.id), note);
      return { account: ownerView(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
    }
    const until = body.until != null ? V.time(body.until, 'until') : null;
    if (until != null && until <= now()) bad('Pick a date in the future.');
    const months = body.months == null ? null : V.int(body.months, 'months', { min: 1, max: 120 });
    const end = supporterUntil(a.supporter_until, now(), { months, until });
    h.run('UPDATE accounts SET supporter_until = ?, supporter_since = ?, supporter_lapse_noted = 0, updated_at = ? WHERE id = ?', end, wasActive ? a.supporter_since ?? now() : now(), now(), a.id);
    const after = h.get('SELECT * FROM accounts WHERE id = ?', a.id);
    audit('owner', wasActive ? 'owner.supporter_extend' : 'owner.supporter_start', a.id, { until: end, months, note }, 'local');
    notify(a.id, 'supporter', wasActive ? `Your supporter time now runs until ${fmtDate(end)}` : 'Thank you for supporting Kea!',
      `Until ${fmtDate(end)}, your Kea storage is ${fmtBytes(quotaOf(after))} and a supporter badge shows next to your name in your classes and organizations. It’s a thank-you: everything else in Kea stays the same.`,
      { note, data: { until: end } });
    return { account: ownerView(after) };
  });
  // A plain notice to one person (for example after they emailed).
  O('POST', '/owner/accounts/:id/notify', ({ params, body }) => {
    const a = getAccount(params.id);
    const title = V.str(body.title, 'title', { min: 1, max: 200 });
    const text = V.str(body.body, 'body', { optional: true, max: 4000 }) ?? '';
    const id = notify(a.id, 'notice', title, text);
    audit('owner', 'owner.notify', a.id, { title }, 'local');
    return { id };
  });
  O('POST', '/owner/accounts/:id', ({ params, body }) => {
    const a = getAccount(params.id);
    const set = (col, v) => h.run(`UPDATE accounts SET ${col} = ?, updated_at = ? WHERE id = ?`, v, now(), a.id);
    if (body.emailVerified != null) { set('email_verified', V.bool(body.emailVerified, 'emailVerified') ? 1 : 0); set('verified_by', body.emailVerified ? 'owner' : null); }
    if (body.identityVerified != null) set('identity_verified', V.bool(body.identityVerified, 'identityVerified') ? 1 : 0);
    if (body.canHost != null) set('can_host', V.bool(body.canHost, 'canHost') ? 1 : 0);
    if ('birthYear' in body) set('birth_year', body.birthYear == null ? null : V.int(body.birthYear, 'birthYear', { min: 1900, max: thisYear() }));
    if (body.status != null) {
      set('status', V.enum(body.status, 'status', ['active', 'suspended']));
      if (body.status === 'suspended') h.run('DELETE FROM sessions WHERE account_id = ?', a.id);
    }
    audit('owner', 'owner.account_update', a.id, body, 'local');
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    if (body.canHost === true && !a.can_host) notify(a.id, 'account', 'You can host classes on the Kea Hub now', 'Make a class from My classes and share its invite code.', { note });
    if (body.canHost === false && a.can_host) notify(a.id, 'account', 'Hosting classes on the Kea Hub is off for your account', 'Classes you already made stay as they are.', { note });
    if (body.identityVerified === true && !a.identity_verified) notify(a.id, 'account', 'Your identity is verified', 'A verified mark shows next to your name where you teach.', { note });
    if (body.emailVerified === true && !a.email_verified) notify(a.id, 'account', 'Your email is verified', 'Kea’s creator verified it by hand.', { note });
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
  });
  // Parent sign-offs: see them all, and approve or withdraw one by hand (for example after a parent emailed).
  O('GET', '/owner/consents', ({ query }) => ({
    consents: h.all(`SELECT c.*, a.email, a.display_name, a.birth_year FROM parent_consents c JOIN accounts a ON a.id = c.account_id ${query.status ? 'WHERE c.status = ?' : ''} ORDER BY c.created_at DESC LIMIT 500`, ...(query.status ? [String(query.status)] : []))
      .map((c) => ({ id: c.id, accountId: c.account_id, email: c.email, name: c.display_name, birthYear: c.birth_year, parentEmail: c.parent_email, status: c.status, method: c.method, note: c.note, createdAt: c.created_at, decidedAt: c.decided_at, concerns: consentConcerns(c) }))
      // review=1: only sign-offs with something to look at (a teen may have signed off for themselves).
      .filter((c) => query.review !== '1' || c.concerns.length),
    waiting: h.all("SELECT id, email, display_name, birth_year FROM accounts WHERE birth_year IS NOT NULL AND role != 'owner' AND id NOT IN (SELECT account_id FROM parent_consents WHERE status = 'approved')")
      .filter((a) => isMinor(a.birth_year, thisYear(), limitsNow().parentConsentUnder))
      .map((a) => ({ accountId: a.id, email: a.email, name: a.display_name, birthYear: a.birth_year })),
  }));
  O('POST', '/owner/accounts/:id/consent', ({ params, body }) => {
    const a = getAccount(params.id);
    const approved = V.bool(body.approved, 'approved');
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    if (approved) {
      const parentEmail = body.parentEmail == null ? 'set by the owner' : V.email(body.parentEmail);
      h.run("INSERT INTO parent_consents (id,account_id,parent_email,token_hash,status,method,note,created_at,expires_at,decided_at) VALUES (?,?,?,?,'approved','owner',?,?,?,?)",
        randomUUID(), a.id, parentEmail, sha(`owner:${randomUUID()}`), note, now(), now(), now());
    } else h.run("UPDATE parent_consents SET status = 'revoked', note = COALESCE(?, note), decided_at = ? WHERE account_id = ? AND status IN ('pending','approved')", note, now(), a.id);
    audit('owner', approved ? 'owner.consent_approve' : 'owner.consent_revoke', a.id, { note }, 'local');
    if (approved) notify(a.id, 'parent_signoff', 'Your parent’s or guardian’s sign-off is recorded', 'Kea’s shared Claude works for you now.', { data: { status: 'approved' } });
    else notify(a.id, 'parent_signoff', 'Your parent’s or guardian’s sign-off was withdrawn', 'Kea’s shared Claude is off for you until a parent or guardian signs off again. Everything else in Kea works as before.', { data: { status: 'revoked' } });
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
  });
  /** What makes a sign-off worth a look: the parent's email has a Kea account (under 18 even), or signed off for many. */
  function consentConcerns(c) {
    const out = [];
    const acct = h.get('SELECT birth_year, role FROM accounts WHERE email = ?', c.parent_email);
    if (acct) {
      out.push('parent_email_has_kea_account');
      if (acct.role !== 'owner' && isMinor(acct.birth_year, thisYear(), 18)) out.push('parent_account_under_18');
    }
    const others = h.get("SELECT COUNT(DISTINCT account_id) AS n FROM parent_consents WHERE status = 'approved' AND account_id != ? AND (parent_email = ? OR (parent_google_sub IS NOT NULL AND parent_google_sub = ?))", c.account_id, c.parent_email, c.parent_google_sub ?? null).n;
    if (others >= 3) out.push('parent_signed_for_many');
    return out;
  }
  // Two-step sign-in off for someone who lost their phone (after checking it's really them). Signs them out everywhere
  // and tells them, so a person who didn't ask for it finds out.
  O('POST', '/owner/accounts/:id/totp-reset', ({ params, body }) => {
    const a = getAccount(params.id);
    const note = V.str(body.note, 'note', { optional: true, max: 2000 });
    h.tx(() => {
      h.run('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL, totp_last_step = -1, updated_at = ? WHERE id = ?', now(), a.id);
      h.run('DELETE FROM sessions WHERE account_id = ?', a.id);
    });
    audit('owner', 'owner.totp_reset', a.id, { note, wasOn: !!a.totp_enabled }, 'local');
    notify(a.id, 'account', 'Two-step sign-in was turned off for your account', 'Kea support turned it off and signed you out everywhere. Sign in with your password and turn two-step sign-in on again under Settings > Security. If you didn’t ask for this, change your password now and contact Kea support.', { note });
    return { account: ownerView(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
  });
  // Delete an account (after the person asked, by email for example). Same rules as deleting it yourself.
  O('POST', '/owner/accounts/:id/delete', ({ params, body }) => {
    const a = getAccount(params.id);
    if (a.role === 'owner') forbidden('The Hub owner’s account can’t be deleted here.');
    if (body.confirm !== a.email) bad('Send confirm: the account’s email address.');
    deleteAccount(a, 'owner', 'local');
    return { ok: true, deleted: true };
  });
  // Course sections: who's in each one, and taking someone out (or everyone, so the section starts over). A section's
  // key is easy to guess, so the first person in becomes its gatekeeper; this is how the owner undoes squatting.
  O('GET', '/owner/course-sections', ({ query }) => {
    const q = `%${String(query.q ?? '').toLowerCase()}%`;
    return {
      sections: h.all('SELECT course_key, COUNT(*) AS n, MIN(joined_at) AS since FROM course_members WHERE course_key LIKE ? GROUP BY course_key ORDER BY since DESC LIMIT 200', q).map((k) => ({
        course: k.course_key, label: keyLabel(k.course_key), since: k.since,
        members: h.all('SELECT a.id, a.email, a.display_name, m.joined_at FROM course_members m JOIN accounts a ON a.id = m.account_id WHERE m.course_key = ? ORDER BY m.joined_at', k.course_key)
          .map((m) => ({ accountId: m.id, email: m.email, name: m.display_name, joinedAt: m.joined_at })),
        hasCode: !!h.get('SELECT 1 FROM course_codes WHERE course_key = ?', k.course_key),
        pendingRequests: h.get("SELECT COUNT(*) AS n FROM course_join_requests WHERE course_key = ? AND status = 'pending'", k.course_key).n,
        hasMaterial: !!h.get('SELECT 1 FROM course_files WHERE course_key = ? LIMIT 1', k.course_key),
      })),
    };
  });
  O('POST', '/owner/course-sections/remove', ({ body }) => {
    const key = V.str(body.course, 'course', { min: 3, max: 400 });
    const a = getAccount(V.str(body.account, 'account', { min: 1, max: 254 }));
    const r = h.run('DELETE FROM course_members WHERE course_key = ? AND account_id = ?', key, a.id);
    audit('owner', 'owner.course_remove', a.id, { course: key }, 'local');
    return { removed: Number(r.changes) };
  });
  // Everyone out except `keep` (account ids or emails); the join code stops working and open requests are cancelled.
  O('POST', '/owner/course-sections/reset', ({ body }) => {
    const key = V.str(body.course, 'course', { min: 3, max: 400 });
    const keep = new Set((Array.isArray(body.keep) ? body.keep : []).slice(0, 100).map((x) => getAccount(String(x)).id));
    let removed = 0;
    h.tx(() => {
      for (const m of h.all('SELECT account_id FROM course_members WHERE course_key = ?', key)) {
        if (keep.has(m.account_id)) continue;
        h.run('DELETE FROM course_members WHERE course_key = ? AND account_id = ?', key, m.account_id);
        removed++;
      }
      h.run('DELETE FROM course_codes WHERE course_key = ?', key);
      h.run("UPDATE course_join_requests SET status = 'cancelled', decided_by = 'owner', decided_at = ? WHERE course_key = ? AND status = 'pending'", now(), key);
    });
    audit('owner', 'owner.course_reset', null, { course: key, removed, kept: keep.size }, 'local');
    return { removed, kept: keep.size };
  });
  O('POST', '/owner/accounts/:id/unlock', ({ params }) => {
    const a = getAccount(params.id);
    fails.clearAll(nameHash(a.email));
    audit('owner', 'owner.unlock', a.id, null, 'local');
    return { ok: true };
  });
  O('GET', '/owner/hosting', ({ query }) => ({
    applications: h.all('SELECT h.*, a.email, a.display_name FROM host_applications h JOIN accounts a ON a.id = h.account_id WHERE h.status = ? ORDER BY h.created_at', query.status ?? 'pending')
      .map((x) => ({ id: x.id, accountId: x.account_id, email: x.email, name: x.display_name, reason: x.reason, status: x.status, createdAt: x.created_at, note: x.note })),
  }));
  O('POST', '/owner/hosting/:id/decide', ({ params, body }) => {
    const app = h.get('SELECT * FROM host_applications WHERE id = ?', params.id) ?? notFound();
    const approve = V.bool(body.approve, 'approve');
    h.tx(() => {
      h.run('UPDATE host_applications SET status = ?, decided_at = ?, note = ? WHERE id = ?', approve ? 'approved' : 'denied', now(), V.str(body.note, 'note', { optional: true, max: 2000 }), app.id);
      if (approve) h.run('UPDATE accounts SET can_host = 1, updated_at = ? WHERE id = ?', now(), app.account_id);
    });
    const hostNote = V.str(body.note, 'note', { optional: true, max: 2000 });
    if (approve) notify(app.account_id, 'hosting', 'You can host classes on the Kea Hub now', 'Your application was approved. Make a class from My classes and share its invite code.', { note: hostNote });
    else notify(app.account_id, 'hosting', 'Your application to host classes wasn’t approved', 'You can still join classes, and host them on your own organization’s server.', { note: hostNote });
    audit('owner', approve ? 'owner.hosting_approve' : 'owner.hosting_deny', app.account_id, null, 'local');
    return { ok: true };
  });
  O('GET', '/owner/audit', ({ query }) => ({
    entries: h.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', Math.min(1000, Number(query.limit) || 200)),
  }));
  // Publish a new terms version (no-op if nothing changed). Everyone must agree again before using the Hub.
  O('POST', '/owner/terms', ({ body }) => {
    try { return publishTerms(body); } catch (e) { bad(e.message); }
  });
  O('GET', '/owner/terms', () => {
    const cur = currentTerms();
    return {
      current: cur.n,
      versions: h.all('SELECT n, label, published_at FROM terms_versions ORDER BY n'),
      agreedToCurrent: h.get('SELECT COUNT(*) AS n FROM terms_acceptances WHERE version = ?', cur.n).n,
      accounts: h.get('SELECT COUNT(*) AS n FROM accounts').n,
    };
  });

  // (After /owner/scan/queue, so that one isn't taken for a job id.)
  // The running job, for the worker: what was asked for and where it goes.
  O('GET', '/owner/scan/:id', ({ params }) => {
    const j = runningJob(params.id);
    return {
      job: { ...jobOut(j), detail: j.detail ? JSON.parse(j.detail) : null, target: j.target, batchSize: limitsNow().questionBatchSize },
      members: h.all('SELECT a.id, a.email, m.target FROM scan_job_members m JOIN accounts a ON a.id = m.account_id WHERE m.job_id = ?', j.id),
    };
  });
  // The section's material so far (the worker checks new questions against the shared pool, so none repeat).
  O('GET', '/owner/scan/:id/course-files', ({ params, query }) => ({ files: spaceList(spaces.course(runningJob(params.id).course_key), String(query.prefix ?? '')) }));
  O('GET', '/owner/scan/:id/course-file', ({ params, query }) => {
    const sp = spaces.course(runningJob(params.id).course_key);
    return rawOut(spaceRead(sp, spaceRow(sp, String(query.path ?? '')) ?? notFound()));
  });
  // Organizations (hub/org/): members and codes, structure, budgets, certs, availability, schedules, the to-do box.
  mountOrgs({ R, O, h, V, now, audit, limit, normCode, HttpError, bad, forbidden, notFound, rawOut, notify, extrasFor });

  // ================= request handling =================
  // Where requests come from: see hub/lib/clientip.mjs for what the tunnel sends and what is trusted.
  // A setup mistake that makes every visitor look like one address (so per-IP limits act on everyone at once) is
  // warned about once in the log and shown in /owner/stats.
  const ipWarnings = new Set();
  const warnIp = (code, text) => {
    if (ipWarnings.has(code)) return;
    ipWarnings.add(code);
    console.warn(`Kea Hub warning: ${text}`);
  };
  const IP_WARN = {
    forwarded: 'Requests are arriving through a proxy (X-Forwarded-For), but the Hub wasn’t told which header holds the visitor’s address (KEA_HUB_IP_HEADER, for example x-forwarded-for behind Tailscale Funnel). Everyone looks like one address, so per-address limits are loosened for it and sign-in lockouts can affect everyone.',
    exposed: 'The public API is listening on an address other than this PC’s own (127.0.0.1) and no KEA_HUB_IP_HEADER is set.',
  };
  const clientOf = (req) => {
    const c = clientAddress(req.headers, req.socket.remoteAddress, ipHeader);
    if (c.forwardedUntrusted) warnIp('forwarded', IP_WARN.forwarded);
    return c;
  };
  // Body size limits. Before anyone is signed in, only small bodies are read (sign-in, making an account, a parent's
  // sign-off); the big limit is only for the person whose own job is running, answering one of its relay calls.
  const PRE_AUTH_BODY = 64 * 1024;
  const SMALL_BODY = 16 * 1024;
  const RELAY_RESULT_BODY = 48 * 1024 * 1024;
  const RELAY_RESULT = /^\/v1\/scan\/([^/]+)\/calls\/[^/]+\/result$/;

  const quick = (res, status, retryAfter, error) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(retryAfter), 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify({ error, retryAfter }));
  };
  async function handleApi(req, res) {
    const t0 = Date.now();
    // Before anything else (routing, the database, the log): requests per address and for everyone, from token buckets,
    // and load shedding while the Hub is stalled. Refused here costs almost nothing and writes no log line.
    const from = clientOf(req);
    const f = from.shared || isLoopback(from.ip) ? SHARED_FACTOR : 1;
    if (buckets.take(`rps:${ipBucket(from.ip)}`, L.rps[0] * f, L.rps[1] * f, t0) > 0 || buckets.take('rps:*', L.rpsAll[0], L.rpsAll[1], t0) > 0) {
      busy.rejected++;
      return quick(res, 429, 1, 'Too many requests. Slow down.');
    }
    // In flight per client. Behind the tunnel every connection is from loopback, so the connection cap can't tell people
    // apart; each request says who it's for.
    const inflight = takeSlots([[`req:${ipBucket(from.ip)}`, F.clientInflight * f]]);
    if (!inflight) { busy.rejected++; res.setHeader('connection', 'close'); return quick(res, 429, 1, 'Too many requests at once. Slow down.'); }
    res.once('close', inflight);
    // (This connection said something: it gets the longer limit now, see 'connection' below.)
    req.socket.setTimeout(apiServer.timeout);
    const url = new URL(req.url, 'http://localhost');
    if (busy.lagMs > F.shedLagMs && url.pathname !== '/v1/health') { busy.shed++; return quick(res, 503, 5, 'The Kea Hub is busy. Try again in a few seconds.'); }
    // Everything but uploads (files and relay answers) must arrive within 30 seconds.
    if (req.method !== 'PUT' && !RELAY_RESULT.test(url.pathname)) {
      const tm = setTimeout(() => { if (!req.complete) req.socket.destroy(); }, 30_000);
      tm.unref?.();
      res.once('close', () => clearTimeout(tm));
    }
    const secure = !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    let status = 200, payload, cookies = [], who = null;
    // The readable terms page (Kea opens it in a window; anyone can read it).
    if (url.pathname === '/terms' && req.method === 'GET') return serveTermsPage(url, res);
    // The page a parent opens from a member's sign-off link.
    if (url.pathname === '/consent' && req.method === 'GET') return serveConsentPage(url, res);
    const joinLink = /^\/join\/([A-Za-z0-9-]{1,40})$/.exec(url.pathname);
    if (joinLink && req.method === 'GET') return serveJoinPage(joinLink[1], res);
    try {
      const fileMatch = /^\/v1\/files\/(.+)$/.exec(url.pathname);
      const fileRoute = fileMatch && ['GET', 'PUT', 'DELETE'].includes(req.method);
      const { r, params } = fileRoute ? { r: { auth: true, terms: true }, params: {} } : api.find(req.method, url.pathname);
      const auth = req.headers.authorization;
      const bearer = auth ? /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1] ?? null : null;
      if (auth && !bearer) throw new HttpError(401, 'Sign in again.');
      const cookieToken = bearer ? null : readCookie(req.headers.cookie, COOKIE);
      if (req.method !== 'GET' && !bearer) {
        if (!sameOrigin(req, secure)) forbidden('Cross-site request refused.');
        if (cookieToken && req.headers['x-kea'] !== '1') forbidden('Missing X-Kea header.');
      }
      const ctx = { params, body: {}, query: Object.fromEntries(url.searchParams), ip: from.ip, ipKey: ipBucket(from.ip), client: String(req.headers['x-kea-client'] || req.headers['user-agent'] || '').slice(0, 120), token: bearer || cookieToken, origin: `${secure ? 'https' : 'http'}://${String(req.headers.host || 'localhost').replace(/[^\w.:[\]-]/g, '')}` };
      // Who it is comes first: nothing is read from a request body until the sign-in checks out.
      if (r.auth) {
        if (!ctx.token) throw new HttpError(401, 'Sign in first.');
        const s = h.get('SELECT * FROM sessions WHERE token_hash = ?', sha(ctx.token));
        if (!s || s.expires_at <= now()) {
          if (cookieToken) cookies = [sessionCookie('', 0, secure)];
          throw new HttpError(401, 'Your sign-in expired. Sign in again.');
        }
        const me = h.get('SELECT * FROM accounts WHERE id = ?', s.account_id);
        if (!me || me.status !== 'active') throw new HttpError(401, 'Sign in again.');
        // A sign-in in use stays signed in: each use (at most hourly) moves its end to SESSION_DAYS from now, up to
        // SESSION_MAX_DAYS after it was made. Unused for SESSION_DAYS, it ends.
        if (now() - s.last_seen > 3600_000) h.run('UPDATE sessions SET last_seen = ?, expires_at = MAX(expires_at, MIN(?, created_at + ?)) WHERE token_hash = ?', now(), now() + SESSION_DAYS * 86400_000, SESSION_MAX_DAYS * 86400_000, s.token_hash);
        ctx.me = me;
        who = me.id;
        // The Hub owner's account has powers over everyone's: none of them work until its two-step sign-in is on. Only
        // what's needed to turn it on (and to read the account and terms) works before that.
        if (me.role === 'owner' && !me.totp_enabled && !r.basic) throw new HttpError(403, OWNER_TOTP_MESSAGE, { ownerTotpRequired: true });
        // Nothing else works until the current terms are agreed to (reading them, exporting data and signing out still do).
        if (r.terms) {
          const ts = termsStatus(me.id);
          if (ts.needsAgreement) throw new HttpError(428, 'The Kea terms have changed. Read what changed and agree to keep using Kea.', { termsRequired: true, ...ts });
        }
      }
      if (req.method === 'POST') {
        let max = ctx.me ? MAX_BODY : PRE_AUTH_BODY;
        const relay = RELAY_RESULT.exec(url.pathname);
        if (relay && ctx.me && h.get("SELECT 1 FROM scan_jobs WHERE id = ? AND account_id = ? AND status = 'running'", decodeURIComponent(relay[1]), ctx.me.id)) max = RELAY_RESULT_BODY;
        // A signed-in person's big bodies are held in memory until they're whole: only so many at once.
        const size = Number(req.headers['content-length']);
        const small = Number.isFinite(size) && size <= SMALL_BODY;
        const release = ctx.me && !small ? takeSlots([[`body:${ctx.me.id}`, F.bodiesPerAccount], [`bodyip:${ctx.ipKey}`, F.bodiesPerClient * f], ['body:*', F.bodiesGlobal]]) : () => {};
        if (!release) throw new HttpError(429, 'Too many requests being sent at once. Wait for one to finish.', { retryAfter: 5 });
        let raw;
        try { raw = await readBody(req, max, F.bodyIdleMs); } finally { release(); }
        let body = {};
        if (raw.trim()) { try { body = JSON.parse(raw); } catch { bad('Invalid JSON.'); } }
        ctx.body = V.obj(body);
      }
      if (fileRoute) return await handleFile(req, res, ctx, decodeURIComponent(fileMatch[1]), t0);
      let out = await r.handler(ctx);
      if (out && out.__raw) {
        const big = out.__raw.length > SMALL;
        const release = big ? takeSlots(downloadSlots(ctx)) : () => {};
        if (!release) throw new HttpError(429, 'Too many downloads at once. Wait for one to finish.', { retryAfter: 5 });
        try {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.__raw.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...out.headers });
          await sendPaced(res, out.__raw, ctx.me?.id ?? null);
        } finally { release(); }
        hlog.request(req.method, url.pathname, 200, Date.now() - t0);
        return;
      }
      // A long answer, written as it's made.
      if (out && out.__stream) {
        const release = takeSlots([[`heavy:${ctx.me.id}`, F.heavyPerAccount], ['heavy:*', F.heavyGlobal]]);
        if (!release) throw new HttpError(429, 'Too many long lists at once. Try again in a few seconds.', { retryAfter: 5 });
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
          await sendPaced(res, out.__stream, ctx.me.id);
        } finally { release(); }
        hlog.request(req.method, url.pathname, 200, Date.now() - t0);
        return;
      }
      if (out && 'body' in out && (typeof out.status === 'number' || 'token' in out || 'clearCookie' in out)) {
        if (out.token) cookies = [sessionCookie(out.token, SESSION_DAYS * 86400, secure)];
        if (out.clearCookie) cookies = [sessionCookie('', 0, secure)];
        if (typeof out.status === 'number') status = out.status;
        out = out.body;
      }
      payload = out;
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else if (e?.busy) { status = 503; payload = { error: e.message, retryAfter: e.retryAfter }; }
      // The client went away (or was dropped as too slow) in the middle of sending: nothing to answer, nothing wrong here.
      else if (req.destroyed && !req.complete) { hlog.request(req.method, url.pathname, 499, Date.now() - t0); return; }
      else { status = 500; payload = { error: 'Something went wrong on the Hub.' }; console.error(e); }
    }
    if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
    if ((status === 429 || status === 503) && payload?.retryAfter) res.setHeader('retry-after', String(payload.retryAfter));
    // Refused before its body was read (or while reading it): answer and close, rather than taking in the rest.
    if (!req.complete) res.setHeader('connection', 'close');
    // A big answer (a long list) goes out paced like a download; small ones at once.
    const text = JSON.stringify(payload ?? {});
    if (text.length > SMALL) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
      await sendPaced(res, Buffer.from(text), who);
    } else { await countSmall(who, text.length); send(res, status, payload, cookies); }
    hlog.request(req.method, url.pathname, status, Date.now() - t0);
  }
  /** Download slots: 2 at a time per account, 3 per address (more for the tunnel's shared address), 16 in all. */
  const downloadSlots = (ctx) => [...(ctx.me ? [[`dl:${ctx.me.id}`, 2]] : []), [`dlip:${ctx.ipKey}`, isLoopback(ctx.ip) ? 3 * SHARED_FACTOR : 3], ['dl:*', 16]];

  // An invite link (https://<hub>/join/<code>) opened in a browser: how to use it in Kea. It doesn't look the code up,
  // so the page says nothing about the class to someone who only has the link.
  function serveJoinPage(code, res) {
    const c = normCode(code).slice(0, 10);
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join a class in Kea</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1f1f1f;--muted:#5f6368;--card:#fff;--line:#dadce0}@media (prefers-color-scheme:dark){:root{--bg:#131314;--fg:#e3e3e3;--muted:#9aa0a6;--card:#1e1f20;--line:#3c4043}}
body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:420px}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:var(--muted);line-height:1.5}
.code{font:600 26px/1.2 ui-monospace,Consolas,monospace;letter-spacing:3px;padding:12px 16px;border:1px dashed var(--line);border-radius:10px;text-align:center;color:var(--fg);user-select:all}</style>
<main><h1>Join a class in Kea</h1><p>Open Kea, go to School, choose <strong>Join a class</strong>, and paste this link or type the code:</p>
<div class="code">${c || '—'}</div><p>New to Kea? Download it, sign in to your Kea account, then use the code.</p></main></html>`;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(html);
  }

  function serveTermsPage(url, res) {
    const versions = h.all('SELECT n FROM terms_versions ORDER BY n');
    const want = Number(url.searchParams.get('version')) || null;
    const row = want ? termsRow(want) : null;
    const t = row ? { ...row, sections: JSON.parse(row.sections) } : currentTerms();
    const since = Number(url.searchParams.get('since')) || null;
    const old = since ? termsRow(since) : null;
    const html = termsPage(t, { since, diff: old ? diffTerms(JSON.parse(old.sections), t.sections) : null, versions });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(html);
  }

  function serveConsentPage(url, res) {
    const token = url.searchParams.get('t') || '';
    const c = consentByToken(token);
    const nonce = randomBytes(16).toString('base64');
    const html = consentPage({
      found: !!c, status: c?.status, expired: !!c && c.status === 'pending' && c.expires_at <= now(),
      memberName: c?.display_name, parentEmail: c?.parent_email, webClientId: googleWebClientId,
    }, { nonce, token });
    res.writeHead(c ? 200 : 404, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': consentCsp(nonce),
    });
    res.end(html);
  }

  // ---------- Kea storage: GET (list or read), PUT (write), DELETE ----------
  // Paths are like "kea/School/kea-data.json". Files are stored on disk under random names, so a path can never point
  // outside the account's folder. Writes are atomic, and If-Match: "<version>" makes a write fail (412) if another
  // device changed the file first, so devices never overwrite each other silently.
  const SEGMENT = /^[\p{L}\p{N} ._()+@,'&!~-]{1,120}$/u;
  function checkPath(p) {
    if (p.length > 500) bad('That path is too long.');
    const parts = p.split('/');
    if (parts.length > 12 || parts.some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || s.trim() !== s || !plainDecoded(s))) bad('That file path has characters Kea storage does not allow.');
    return parts.join('/');
  }
  const readFileBody = (req, max) => readRaw(req, max, `Files can be at most ${Math.round(max / 1024 ** 2)} MB.`);
  /**
   * Kea writes characters the Hub doesn't allow in names as ~<hex>~ and turns them back when it saves the file
   * (electron/scholar/hubsync.cjs, decodeSeg). A stored name must still be a plain name after that: not "." or "..",
   * no / \ or :, no control characters, not a Windows device name (CON, NUL, COM1, ...).
   */
  function plainDecoded(seg) {
    let d = seg;
    if (seg.includes('~')) { try { d = seg.replace(/~([0-9a-f]+)~/g, (_, x) => String.fromCodePoint(parseInt(x, 16))); } catch { return false; } }
    if (!d || d === '.' || d === '..' || d.trim() === '' ) return false;
    if (/[\\/:\x00-\x1f\x7f]/.test(d)) return false;
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(d)) return false;
    return true;
  }
  const etagVersion = (v) => { const m = /^"?(\d+)"?$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : null; };

  // Uploads in flight, per account: counted toward the limit while they arrive, so parallel uploads can't all fit.
  const reserved = new Map();
  async function handleFile(req, res, ctx, rawPath, t0) {
    const me = ctx.me;
    const done = (status, payload, headers = {}) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      send(res, status, payload);
      hlog.request(req.method, '/v1/files/…', status, Date.now() - t0);
    };
    // GET /v1/files/ (empty path) is handled by the list route; here the path is a file.
    const path = checkPath(rawPath);
    if (req.method !== 'GET') {
      const wait = buckets.take(`wr:${me.id}`, L.writes[0], L.writes[1], Date.now());
      if (wait > 0) throw new HttpError(429, 'Too many file changes at once. Slow down a little.', { retryAfter: Math.ceil(wait / 1000) });
    }
    const row = h.get('SELECT * FROM files WHERE account_id = ? AND path = ?', me.id, path);
    if (req.method === 'GET') {
      if (!row) notFound('No such file.');
      if (etagVersion(req.headers['if-none-match']) === row.version) { res.writeHead(304, { etag: `"${row.version}"` }); res.end(); return; }
      if (dayCount(`out:${me.id}`) > storageSettings().dailyEgressBytes && me.role !== 'owner') throw new HttpError(429, 'You’ve downloaded the most for one day. Try again tomorrow.', { retryAfter: 3600 });
      const big = row.size > SMALL;
      const release = big ? takeSlots(downloadSlots(ctx)) : () => {};
      if (!release) throw new HttpError(429, 'Too many downloads at once. Wait for one to finish.', { retryAfter: 5 });
      busy.downloads++;
      try {
        const src = big ? createReadStream(blobPath(me.id, row.blob), { highWaterMark: CHUNK }) : await readFileP(blobPath(me.id, row.blob));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': row.size, etag: `"${row.version}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-kea-sha256': row.sha256 });
        await sendPaced(res, src, me.id);
      } finally { busy.downloads--; release(); }
      hlog.request(req.method, '/v1/files/…', 200, Date.now() - t0);
      return;
    }
    const ifMatch = req.headers['if-match'];
    const conflict = () => { throw new HttpError(412, 'This file was changed on another device. Get the newest copy first.', { version: row?.version ?? null }); };
    if (ifMatch != null) {
      if (ifMatch === '*' ? !row : etagVersion(ifMatch) !== row?.version) conflict();
    }
    if (req.headers['if-none-match'] === '*' && row) conflict();
    if (req.method === 'DELETE') {
      if (!row) notFound('No such file.');
      h.run('DELETE FROM files WHERE account_id = ? AND path = ?', me.id, path);
      await rmP(blobPath(me.id, row.blob), { force: true });
      return done(200, { ok: true });
    }
    // PUT
    const quota = quotaOf(me);
    const tooBig = `Files can be at most ${Math.round(maxFileBytes / 1024 ** 2)} MB.`;
    const declared = Number(req.headers['content-length']);
    const known = Number.isFinite(declared) && declared >= 0;
    if (known && declared > maxFileBytes) throw new HttpError(413, tooBig);
    if (!row && usage(me.id).file_count >= maxFilesPerAccount) throw new HttpError(507, `Your Kea storage holds the most files it can (${maxFilesPerAccount.toLocaleString('en-US')}). Delete some to add more.`, { storageFull: true, tooManyFiles: true });
    // Full (or over, after a limit went down): nothing is deleted, and a file can still be replaced by one no bigger.
    // `before` is the size of the file being replaced (0 for a new one). Checked before anything is read (with the
    // announced size), after it arrived, and again inside the database transaction; uploads of the same account still
    // arriving count too (`reserved`), so uploads running at the same time can't all fit under one limit.
    const mine = known ? declared : 0;
    const checkRoom = (size, before) => {
      const used = usedBy(me.id) - before + (row ? 0 : fileOverheadBytes) + ((reserved.get(me.id) || 0) - mine);
      if (used + size > quota && size > before) {
        const all = usedBy(me.id);
        throw new HttpError(507, all > quota
          ? `Your Kea storage is over its limit: ${fmtBytes(all)} of ${fmtBytes(quota)}. Nothing has been deleted, but new files wait until you’re under the limit. Delete some files to make room.`
          : `Your Kea storage is full (${fmtBytes(quota)}). Delete some files to make room.`, { used: all, quota, storageFull: true });
      }
    };
    checkRoom(mine, row?.size ?? 0);
    checkBudgets(me, mine);
    checkDisk(mine);
    // Only a real upload takes an upload slot: empty and small files can't keep other people's uploads out. (A body
    // that doesn't say its size takes one once that much of it has come.)
    let release = null;
    const takeUpload = () => {
      release = takeSlots([[`up:${me.id}`, 2], ['up:*', 16]]);
      if (!release) throw new HttpError(429, 'Too many uploads at once. Wait for one to finish.', { retryAfter: 5 });
    };
    if (known && declared > F.uploadSlotMinBytes) takeUpload();
    reserved.set(me.id, (reserved.get(me.id) || 0) + mine);
    busy.uploads++;
    const dir = join(storageDir, me.id);
    const blob = randomUUID();
    const tmp = join(dir, `${blob}.tmp`);
    try {
      // Streamed to a temporary file, hashed on the way, never held whole in memory.
      await mkdirP(dir, { recursive: true });
      const hasher = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > maxFileBytes) return cb(new HttpError(413, tooBig));
          if (!release && size > F.uploadSlotMinBytes) { try { takeUpload(); } catch (e) { return cb(e); } }
          hasher.update(chunk);
          cb(null, chunk);
        },
      });
      // An upload that stops, or only trickles, is dropped: it holds a slot and a file open.
      let mark = 0, markAt = Date.now(), lastSize = 0, lastAt = markAt;
      const watch = setInterval(() => {
        const t = Date.now();
        if (size !== lastSize) { lastSize = size; lastAt = t; }
        let slow = t - lastAt >= F.bodyIdleMs;
        if (t - markAt >= F.minRateWindowMs) {
          const need = (F.minRateBytes * (t - markAt)) / 1000;
          slow ||= size - mark < (known ? Math.min(need, declared - mark) : need);
          mark = size; markAt = t;
        }
        if (slow) { busy.slowDropped++; req.destroy(); }
      }, Math.max(50, Math.min(F.minRateWindowMs, F.bodyIdleMs) / 4));
      watch.unref?.();
      try { await pipeline(req, meter, createWriteStream(tmp)); } finally { clearInterval(watch); }
      checkRoom(size, row?.size ?? 0);
      checkBudgets(me, size);
      checkDisk(size);
      await renameP(tmp, join(dir, blob));
      const version = (row?.version ?? 0) + 1;
      const hash = hasher.digest('hex');
      try {
        h.tx(() => {
          // Re-check inside the transaction so two simultaneous writes can't both win.
          const cur = h.get('SELECT version, size FROM files WHERE account_id = ? AND path = ?', me.id, path);
          if ((cur?.version ?? 0) !== (row?.version ?? 0)) conflict();
          checkRoom(size, cur?.size ?? 0);
          h.run('INSERT INTO files (account_id,path,blob,size,version,sha256,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET blob=excluded.blob, size=excluded.size, version=excluded.version, sha256=excluded.sha256, updated_at=excluded.updated_at',
            me.id, path, blob, size, version, hash, now());
        });
      } catch (e) { await rmP(join(dir, blob), { force: true }); throw e; }
      dayAdd(`in:${me.id}`, size);
      dayAdd('in:*', size);
      if (row) await rmP(blobPath(me.id, row.blob), { force: true });
      return done(row ? 200 : 201, { path, version, size, sha256: hash }, { etag: `"${version}"` });
    } catch (e) {
      await rmP(tmp, { force: true }).catch(() => {});
      throw e;
    } finally {
      release?.();
      busy.uploads--;
      const left = (reserved.get(me.id) || 0) - mine;
      if (left > 0) reserved.set(me.id, left); else reserved.delete(me.id);
    }
  }

  // Owner-console routes that work while the owner account's two-step sign-in is off: the status page only.
  const OWNER_OPEN = new Set(['GET /owner/stats']);
  const ownerTotpOff = () => !!h.get("SELECT 1 FROM accounts WHERE role = 'owner' AND totp_enabled = 0");
  async function handleOwner(req, res) {
    let status = 200, payload;
    // Set once the caller proved it holds the owner key: answers from then on prove the Hub holds it too (ownerauth.mjs).
    let prove = null;
    try {
      // Belt and braces: the listener is bound to 127.0.0.1, and every call answers a fresh challenge too.
      const addr = req.socket.remoteAddress;
      if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') forbidden();
      if (req.headers.origin || req.headers['sec-fetch-site']) forbidden('The owner console takes no browser requests.');
      const url = new URL(req.url, 'http://localhost');
      // The challenge (hub/lib/ownerauth.mjs): a nonce, answered with an HMAC made with the owner key.
      if (req.method === 'GET' && url.pathname === '/owner/nonce') { send(res, 200, { nonce: nonces.issue(String(addr)) }); return; }
      if (req.headers['x-kea-owner-key'] != null) throw new HttpError(401, 'The owner console no longer takes the owner key itself. Update KeaS and Kea on this PC.');
      const taken = nonces.take(req.headers[OWNER_AUTH_HEADER]);
      if (!taken) throw new HttpError(401, 'Owner sign-in required: answer a fresh challenge from /owner/nonce.');
      const raw = req.method === 'POST' || req.method === 'PUT' ? await readRaw(req, req.method === 'PUT' ? maxFileBytes : MAX_BODY) : Buffer.alloc(0);
      const signKey = ownerKeyNow();
      if (!nonces.check(signKey, taken, req.method, req.url, raw)) throw new HttpError(401, 'Owner sign-in failed.');
      prove = (code, bytes) => ownerReplyMac(signKey, taken.nonce, req.headers[OWNER_CHALLENGE_HEADER], code, req.method, req.url, bytes);
      const { r, params } = own.find(req.method, url.pathname);
      if (!OWNER_OPEN.has(`${req.method} ${url.pathname}`) && ownerTotpOff()) throw new HttpError(403, OWNER_TOTP_MESSAGE, { ownerTotpRequired: true });
      let body = {};
      if (req.method === 'POST') { const text = raw.toString('utf8'); if (text.trim()) { try { body = JSON.parse(text); } catch { bad('Invalid JSON.'); } } body = V.obj(body); }
      payload = await r.handler({ params, body, raw: req.method === 'PUT' ? raw : null, query: Object.fromEntries(url.searchParams) });
      if (payload && payload.__raw) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.__raw.length, 'cache-control': 'no-store', ...payload.headers, [OWNER_REPLY_HEADER]: prove(200, payload.__raw) });
        res.end(payload.__raw);
        return;
      }
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else { status = 500; payload = { error: 'internal error' }; console.error(e); }
    }
    if (prove) { const bytes = Buffer.from(JSON.stringify(payload ?? {})); res.setHeader(OWNER_REPLY_HEADER, prove(status, bytes)); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' }); res.end(bytes); return; }
    send(res, status, payload);
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'internal error' }); } catch {} });
  // Limits on connections themselves: 2000 at once, 50 per address (not the tunnel's own loopback, which carries
  // everyone), small headers, and idle sockets closed.
  const apiServer = http.createServer({ maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 5000 }, wrap(handleApi));
  apiServer.maxConnections = 2000;
  apiServer.maxHeadersCount = 100;
  apiServer.timeout = 60_000;
  const perAddress = new Map();
  apiServer.on('connection', (sock) => {
    const a = String(sock.remoteAddress || '');
    if (!isLoopback(a)) {
      const n = (perAddress.get(a) || 0) + 1;
      if (n > 50) { busy.refusedConnections++; sock.destroy(); return; }
      perAddress.set(a, n);
    }
    busy.connections++;
    // A connection that says nothing at all is closed soon (http's own timers only start with the first bytes).
    sock.setTimeout(F.noBytesMs);
    sock.once('close', () => {
      busy.connections--;
      if (!isLoopback(a)) { const n = (perAddress.get(a) || 1) - 1; if (n) perAddress.set(a, n); else perAddress.delete(a); }
    });
  });
  const ownerServer = http.createServer(wrap(handleOwner));
  // (Uploads of up to 64 MB get five minutes in all; everything else is cut at 30 seconds in handleApi.)
  apiServer.headersTimeout = 15_000; apiServer.requestTimeout = 300_000;
  // The owner console is local only, but a stuck or slow client still shouldn't hold it open. (Large worker uploads
  // are 64 MB at most over loopback, so two minutes is plenty.)
  ownerServer.headersTimeout = 15_000; ownerServer.requestTimeout = 120_000;
  // A port another program already holds (maybe another Windows account's program pretending to be the Hub) is a clear
  // error, never a crash and never a silent second Hub.
  const listenOn = (srv, port) => new Promise((resolve, reject) => {
    const onError = (e) => {
      srv.off('listening', onListening);
      reject(e.code === 'EADDRINUSE'
        ? Object.assign(new Error(`Port ${port} on ${HOST} is already in use by another program, so the Kea Hub can’t start. Close the other Kea Hub (or whatever holds that port; check with: netstat -ano | findstr :${port}) and start it again.`), { code: 'EADDRINUSE', port })
        : e);
    };
    const onListening = () => {
      srv.off('error', onError);
      srv.on('error', (e) => console.error(`Kea Hub listener on port ${port}: ${e.message}`));
      const a = srv.address();
      if (srv === apiServer && !ipHeader && !isLoopback(a.address)) warnIp('exposed', IP_WARN.exposed);
      resolve(a.port);
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, HOST);
  });

  return {
    h, key,
    /** The owner key now (it can be rotated: `node hub/owner.mjs rotate-key`). */
    get ownerKey() { return ownerKeyNow(); },
    async listen({ port = Number(process.env.KEA_HUB_PORT) || 4860, ownerPort = Number(process.env.KEA_HUB_OWNER_PORT) || 4861 } = {}) {
      const p = await listenOn(apiServer, port);
      try { return { port: p, ownerPort: await listenOn(ownerServer, ownerPort) }; }
      catch (e) { await new Promise((r) => apiServer.close(() => r())); throw e; }
    },
    /** The request log (the Hub run by itself sends its errors here too). */
    log: hlog,
    close() {
      clearInterval(sweepTimer);
      clearInterval(lagTimer);
      hlog.close();
      return Promise.all([apiServer, ownerServer].map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r())))).then(() => h.close());
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // KeaS refused this folder (something another account could have planted is still in it): don't serve from it.
  if (existsSync(join(DATA_DIR, '.keas-lockdown-pending'))) {
    console.error('The Kea Hub won’t start: KeaS found this data folder was open to other accounts and hasn’t finished checking it. Open KeaS to see what to clean up.');
    process.exit(3);
  }
  // Run by itself (the Hub started before sign-in): its log is a size-limited file in its data folder, and its errors
  // go there too, never to an ever-growing output file.
  const hub = createHub({ logFile: join(DATA_DIR, 'logs', 'hub.log'), log: false });
  for (const level of ['error', 'warn']) console[level] = (...a) => hub.log.line(`${new Date().toISOString()} ${level.toUpperCase()} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}`);
  let ports;
  try { ports = await hub.listen(); } catch (e) { console.error(e.message); await hub.close().catch(() => {}); process.exit(1); }
  const { port, ownerPort } = ports;
  // Which process this is, for stopping it (KeaS's hub:stop step), rather than matching command lines.
  const pidFile = join(DATA_DIR, 'hub.pid');
  try {
    rmSync(pidFile, { force: true });
    writeSecretFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) }));
    process.on('exit', () => { try { rmSync(pidFile, { force: true }); } catch {} });
  } catch (e) { console.error(`Couldn’t record the Hub’s process: ${e.message}`); }
  console.log(`Kea Hub ${VERSION} on http://${HOST}:${port} (tunnel this one). Owner console on http://${HOST}:${ownerPort} (never tunnel this).`);
}
