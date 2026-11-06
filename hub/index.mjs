// Kea Hub: accounts, classes, invites, class calendar, study sets and leaderboards.
//
// Two listeners, both bound to 127.0.0.1:
//   - the public API (port 4860). The tunnel (Tailscale Funnel or Cloudflare Tunnel) forwards the internet to this one.
//   - the owner console (port 4861). Never tunneled, so it can't be reached from the internet at all, and every call
//     also needs the owner key from the Hub's data folder. Becoming an owner is only possible from this PC
//     (`node hub/owner.mjs make-owner <email>`), never through the API.
import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTerms, diffTerms, sameSections, termsPage } from './lib/terms.mjs';
import { DEFAULTS as BUDGET, courseKey, decide, isMinor, pickNext } from './lib/budget.mjs';
import { googleKeys, verifyGoogleIdToken } from './lib/google.mjs';
import { consentPage, consentCsp } from './lib/consentPage.mjs';
import { openDb, DATA_DIR } from './db.mjs';
import { hashPassword, verifyPassword, needsRehash, passwordProblem } from './lib/passwords.mjs';
import { newSecret, checkCode, otpauthUri } from './lib/totp.mjs';
import { loadOrCreateKey, signToken } from './lib/tokens.mjs';
import { Windows, failures } from './lib/limiter.mjs';
import { scoreAnswer, capped, levelOf, weekStart, dayKey, streak } from './lib/study.mjs';

export const VERSION = '0.1.0';
const HOST = '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
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
  time(v, name) { const t = typeof v === 'number' ? v : Date.parse(v); if (!Number.isFinite(t)) bad(`${name} must be a date and time.`); return t; },
  url(v, name) {
    const s = V.str(v, name, { optional: true, max: 500 });
    if (s == null) return null;
    let u; try { u = new URL(s); } catch { bad(`${name} must be a full https:// link.`); }
    if (u.protocol !== 'https:') bad(`${name} must be a full https:// link.`);
    return u.toString();
  },
  obj(v) { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) bad('Body must be a JSON object.'); return v; },
};

const sha = (s) => createHash('sha256').update(s).digest('hex');
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
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
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
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, terms: opts.terms !== false });
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
  ipHeader = process.env.KEA_HUB_IP_HEADER || null, // e.g. 'cf-connecting-ip' behind Cloudflare, 'x-forwarded-for' behind Funnel
  limits = {},
  log = true,
  // Kea storage: where account files live (point this at the big drive), and each account's default limit.
  storageDir = process.env.KEA_HUB_STORAGE || join(dataDir, 'storage'),
  defaultQuotaBytes = (Number(process.env.KEA_HUB_QUOTA_GB) || 25) * 1024 ** 3,
  minFreeBytes = 5 * 1024 ** 3,
  maxFileBytes = 64 * 1024 ** 2,
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
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  const h = openDb(dbFile);
  const gKeys = googleKeyFn ?? googleKeys({ nowFn: now });
  const key = loadOrCreateKey(join(dataDir, 'hub-signing-key.pem'));
  const ownerKeyFile = join(dataDir, 'owner.key');
  if (!existsSync(ownerKeyFile)) writeFileSync(ownerKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const ownerKey = Buffer.from(readFileSync(ownerKeyFile, 'utf8').trim());
  const windows = new Windows();
  const fails = failures(h, now);
  const L = { login: [30, 10 * 60_000], register: [5, 60 * 60_000], join: [20, 10 * 60_000], answer: [240, 60_000], ...limits };
  const limit = (kind, who) => {
    const [n, ms] = L[kind];
    const wait = windows.hit(`${kind}:${who}`, n, ms, now());
    if (wait > 0) throw new HttpError(429, `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`, { retryAfter: Math.ceil(wait / 1000) });
  };
  const audit = (actor, action, target, detail, ip) =>
    h.run('INSERT INTO audit (at,actor,action,target,detail,ip) VALUES (?,?,?,?,?,?)', now(), actor ?? null, action, target ?? null, detail == null ? null : JSON.stringify(detail), ip ?? null);

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
  const requireTotp = (a, code, nh, ip) => {
    if (!a.totp_enabled) return;
    if (code == null || code === '') throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { totpRequired: true });
    const step = checkCode(a.totp_secret, code, now(), a.totp_last_step);
    if (step == null) { fails.fail(nh); audit(a.id, 'auth.fail_totp', null, null, ip); throw new HttpError(401, 'That code is wrong or already used.', { totpRequired: true }); }
    h.run('UPDATE accounts SET totp_last_step = ? WHERE id = ?', step, a.id);
  };

  // ---------- storage ----------
  const quotaOf = (a) => (a.quota_bytes == null ? defaultQuotaBytes : a.quota_bytes);
  const usedBy = (accountId) => h.get('SELECT COALESCE(SUM(size),0) AS s FROM files WHERE account_id = ?', accountId).s;
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
  // Pacing what the Hub sends, so big downloads never fill the owner's home upload: every large response shares one
  // budget of maxSendMbps. Small files (under 256 KB: sync data, cards, requests) go straight out.
  const SMALL = 256 * 1024, CHUNK = 64 * 1024;
  let paceAt = Date.now();
  async function sendPaced(res, data) {
    if (data.length <= SMALL) return void res.end(data);
    for (let o = 0; o < data.length; o += CHUNK) {
      const part = data.subarray(o, o + CHUNK);
      const bytesPerMs = (Math.max(1, limitsNow().maxSendMbps) * 1e6) / 8 / 1000;
      // Reserve this chunk's time on the shared clock; wait until it comes round.
      const t = Date.now();
      paceAt = Math.max(paceAt, t) + part.length / bytesPerMs;
      const wait = paceAt - t - part.length / bytesPerMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (res.destroyed) return;
      if (!res.write(part)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  const publicAccount = (a) => ({
    id: a.id, email: a.email, displayName: a.display_name, role: a.role, status: a.status,
    emailVerified: !!a.email_verified, verifiedBy: a.verified_by, identityVerified: !!a.identity_verified,
    canHost: !!a.can_host || a.role === 'owner', totpEnabled: !!a.totp_enabled, owner: a.role === 'owner', createdAt: a.created_at,
    birthYear: a.birth_year ?? null, ...consentOf(a),
    leaderboard: { show: a.board_default || 'name', nickname: a.nickname ?? null },
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
  function approveConsent(c, method, g, ip) {
    h.tx(() => {
      h.run("UPDATE parent_consents SET status = 'approved', method = ?, parent_google_sub = ?, decided_at = ? WHERE id = ?", method, g?.sub ?? null, now(), c.id);
      h.run("UPDATE parent_consents SET status = 'revoked', decided_at = ? WHERE account_id = ? AND status = 'pending' AND id != ?", now(), c.account_id, c.id);
    });
    audit(c.account_id, 'consent.approve', c.id, { method, parent: c.parent_email }, ip);
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
  const asMember = (classId, me) => {
    const c = loadClass(classId);
    const m = membership(classId, me.id);
    if (!m && me.role !== 'owner') notFound('Class not found.');
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
  const sessionOut = (s) => ({ id: s.id, classId: s.class_id, title: s.title, start: new Date(s.start_at).toISOString(), end: new Date(s.end_at).toISOString(), location: s.location, meetingUrl: s.meeting_url, notes: s.notes });

  // ================= public API =================
  const api = makeRouter();
  const R = api.add;

  R('GET', '/v1/health', () => ({ ok: true, service: 'kea-hub', version: VERSION }), { auth: false });
  R('GET', '/v1/keys', () => ({ keys: [key.jwk] }), { auth: false });

  R('POST', '/v1/auth/register', async ({ body, ip, client }) => {
    limit('register', ip);
    const email = V.email(body.email);
    const displayName = V.str(body.displayName, 'Name', { min: 1, max: 60 });
    if (body.age13 !== true) bad('Kea accounts are for people 13 and older.');
    const problem = passwordProblem(body.password, { email, name: displayName });
    if (problem) bad(problem, { field: 'password' });
    const birthYear = body.birthYear == null ? null : birthYearOf(body.birthYear);
    if (h.get('SELECT 1 FROM accounts WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    const cur = currentTerms();
    if (body.termsVersion !== cur.n) throw new HttpError(409, 'The terms changed. Read the latest version and agree to it.', { termsVersion: cur.n });
    const g = body.googleIdToken ? await google(body.googleIdToken) : null;
    if (g && g.email !== email) bad(`That Google account is ${g.email}, not ${email}.`);
    const id = randomUUID();
    const t = now();
    const pwHash = await hashPassword(body.password);
    h.tx(() => {
      h.run('INSERT INTO accounts (id,email,display_name,pw_hash,created_at,updated_at,birth_year) VALUES (?,?,?,?,?,?,?)', id, email, displayName, pwHash, t, t, birthYear);
      recordAgreement(id, body, ip, client);
      if (g) markGoogleVerified(id, g);
    });
    audit(id, 'account.register', id, { google: !!g }, ip);
    const token = newSession(id, client);
    return { status: 201, body: { token, account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', id)) }, token };
  }, { auth: false });

  R('POST', '/v1/auth/login', async ({ body, ip, client }) => {
    limit('login', ip);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) bad('Enter your email and password.');
    const nh = nameHash(email);
    const locked = fails.locked(nh);
    if (locked > 0) throw new HttpError(429, `Too many wrong tries for this account. Wait ${Math.ceil(locked / 1000)} seconds.`, { retryAfter: Math.ceil(locked / 1000) });
    const a = h.get('SELECT * FROM accounts WHERE email = ?', email);
    const ok = await verifyPassword(password, a?.pw_hash ?? null);
    if (!ok) {
      const f = fails.fail(nh);
      audit(a?.id ?? null, 'auth.fail', null, { count: f.count }, ip);
      throw new HttpError(401, 'Wrong email or password.');
    }
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    requireTotp(a, body.code, nh, ip);
    fails.clear(nh);
    if (needsRehash(a.pw_hash)) h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(password), now(), a.id);
    audit(a.id, 'auth.login', null, null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(a), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  // Sign in with Google instead of a password (the account must already exist with that email). Two-step sign-in
  // still applies. Also proves the email.
  R('POST', '/v1/auth/google', async ({ body, ip, client }) => {
    limit('login', ip);
    const g = await google(body.idToken);
    const a = h.get('SELECT * FROM accounts WHERE email = ?', g.email);
    if (!a) throw new HttpError(404, `There's no Kea account for ${g.email} yet. Create one first.`, { email: g.email, name: g.name });
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    const nh = nameHash(a.email);
    const locked = fails.locked(nh);
    if (locked > 0) throw new HttpError(429, `Too many wrong tries for this account. Wait ${Math.ceil(locked / 1000)} seconds.`, { retryAfter: Math.ceil(locked / 1000) });
    requireTotp(a, body.code, nh, ip);
    markGoogleVerified(a.id, g);
    audit(a.id, 'auth.login_google', null, null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  // Forgot your password: prove the email with Google, then set a new one. Every other session is signed out.
  R('POST', '/v1/auth/reset/google', async ({ body, ip, client }) => {
    limit('login', ip);
    const g = await google(body.idToken);
    const a = h.get('SELECT * FROM accounts WHERE email = ?', g.email);
    if (!a) throw new HttpError(404, `There's no Kea account for ${g.email}.`);
    if (a.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact Kea support.');
    const problem = passwordProblem(body.password, { email: a.email, name: a.display_name });
    if (problem) bad(problem, { field: 'password' });
    const nh = nameHash(a.email);
    requireTotp(a, body.code, nh, ip);
    const pwHash = await hashPassword(body.password);
    h.tx(() => {
      h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', pwHash, now(), a.id);
      h.run('DELETE FROM sessions WHERE account_id = ?', a.id);
      markGoogleVerified(a.id, g);
    });
    fails.clear(nh);
    audit(a.id, 'account.reset_google', a.id, null, ip);
    const token = newSession(a.id, client);
    return { body: { token, account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)), terms: termsStatus(a.id) }, token };
  }, { auth: false });

  R('POST', '/v1/me/verify/google', async ({ me, body, ip }) => {
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
  }, { terms: false });
  R('POST', '/v1/terms/accept', ({ me, body, ip, client }) => {
    recordAgreement(me.id, body, ip, client);
    audit(me.id, 'terms.accept', String(body.termsVersion), null, ip);
    return { terms: termsStatus(me.id) };
  }, { terms: false });

  // Kea storage: list (optionally under a folder prefix, or only what changed since a time, for syncing).
  R('GET', '/v1/files', ({ me, query }) => {
    const prefix = String(query.prefix ?? '');
    const since = Number(query.since) || 0;
    return {
      used: usedBy(me.id), quota: quotaOf(me), now: now(),
      files: h.all("SELECT path, size, version, sha256, updated_at FROM files WHERE account_id = ? AND substr(path, 1, length(?)) = ? AND updated_at > ? ORDER BY path", me.id, prefix, prefix, since)
        .map((f) => ({ path: f.path, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updated_at })),
    };
  });

  // Download everything the Hub keeps about you (allowed even before agreeing to new terms).
  R('GET', '/v1/me/export', ({ me }) => ({
    exportedAt: new Date(now()).toISOString(),
    account: publicAccount(me),
    termsAgreements: h.all('SELECT version, at FROM terms_acceptances WHERE account_id = ? ORDER BY version', me.id),
    classes: h.all('SELECT c.id, c.title, m.role, m.board, m.nickname, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.account_id = ?', me.id),
    studyAnswers: h.all('SELECT question_id, box, due_at, seen FROM review_state WHERE account_id = ?', me.id),
    points: h.all('SELECT class_id, question_id, points, at FROM xp_events WHERE account_id = ? ORDER BY at', me.id),
    files: h.all('SELECT path, size, version, updated_at FROM files WHERE account_id = ? ORDER BY path', me.id),
    signIns: h.all("SELECT action, at, ip FROM audit WHERE actor = ? AND action LIKE 'auth.%' ORDER BY id DESC LIMIT 500", me.id),
  }), { terms: false });

  R('POST', '/v1/auth/logout', ({ token }) => {
    if (token) h.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
    return { body: { ok: true }, clearCookie: true };
  }, { auth: false });

  // A short-lived signed token for an org server or Kea to check offline (aud names who it's for).
  R('POST', '/v1/auth/token', ({ me, body }) => {
    const aud = V.str(body.aud ?? 'kea', 'Audience', { min: 1, max: 200 });
    const t = Math.floor(now() / 1000);
    const token = signToken(key, {
      iss: 'kea-hub', sub: me.id, aud, iat: t, exp: t + TOKEN_MINUTES * 60,
      email: me.email, name: me.display_name, ev: !!me.email_verified, iv: !!me.identity_verified, owner: me.role === 'owner',
    });
    return { token, expiresIn: TOKEN_MINUTES * 60 };
  });

  // ---------- me ----------
  R('GET', '/v1/me', ({ me }) => ({
    account: publicAccount(me), progress: progressOf(me.id), terms: termsStatus(me.id),
    storage: { used: usedBy(me.id), quota: quotaOf(me) },
  }), { terms: false });
  R('POST', '/v1/me', ({ me, body }) => {
    const name = V.str(body.displayName, 'Name', { min: 1, max: 60 });
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
  const consentOut = (c) => c && ({ id: c.id, parentEmail: c.parent_email, status: c.status, method: c.method, createdAt: c.created_at, expiresAt: c.expires_at, decidedAt: c.decided_at });
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
    const c = h.get("SELECT * FROM parent_consents WHERE account_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1", me.id, now()) ?? bad('Ask for a sign-off first: enter your parent’s or guardian’s email.');
    const g = await google(body.idToken);
    if (g.email === me.email) bad('That’s your own Google account. Your parent or guardian signs in with theirs.');
    if (g.email !== c.parent_email) bad(`That Google account is ${g.email}, but the sign-off is for ${c.parent_email}.`);
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
    if (approve) approveConsent(c, 'google-link', g, ip);
    else {
      h.run("UPDATE parent_consents SET status = 'declined', method = 'google-link', parent_google_sub = ?, decided_at = ? WHERE id = ?", g.sub, now(), c.id);
      audit(c.account_id, 'consent.decline', c.id, { parent: c.parent_email }, ip);
    }
    return { status: approve ? 'approved' : 'declined' };
  }, { auth: false });

  // How the person shows on leaderboards: their name, a nickname, or hidden. It's the default for classes they join
  // later, and (unless everyClass is false) it replaces each class's own choice too.
  R('POST', '/v1/me/leaderboard', ({ me, body }) => {
    const show = V.enum(body.show, 'Leaderboard name', ['name', 'nickname', 'hidden']);
    const nickname = 'nickname' in body ? V.str(body.nickname, 'Nickname', { optional: true, max: 30 }) : me.nickname ?? null;
    if (show === 'nickname' && !nickname) bad('Pick a nickname first.');
    h.tx(() => {
      h.run('UPDATE accounts SET board_default = ?, nickname = ?, updated_at = ? WHERE id = ?', show, nickname, now(), me.id);
      if (body.everyClass !== false) h.run('UPDATE class_members SET board = ?, nickname = ? WHERE account_id = ?', show, nickname, me.id);
    });
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', me.id)) };
  });
  R('POST', '/v1/me/password', async ({ me, body, token, ip }) => {
    if (!(await verifyPassword(body.current ?? '', me.pw_hash))) { fails.fail(nameHash(me.email)); throw new HttpError(401, 'Your current password is wrong.'); }
    const problem = passwordProblem(body.next, { email: me.email, name: me.display_name });
    if (problem) bad(problem, { field: 'next' });
    h.run('UPDATE accounts SET pw_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(body.next), now(), me.id);
    h.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', me.id, sha(token));
    audit(me.id, 'account.password', me.id, null, ip);
    return { ok: true, otherSessionsSignedOut: true };
  });
  R('GET', '/v1/me/sessions', ({ me, token }) => ({
    sessions: h.all('SELECT * FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen DESC', me.id, now())
      .map((s) => ({ id: s.token_hash.slice(0, 12), client: s.client, createdAt: s.created_at, lastSeen: s.last_seen, current: s.token_hash === sha(token) })),
  }), { terms: false });
  R('POST', '/v1/me/sessions/sign-out-others', ({ me, token }) => {
    const r = h.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', me.id, sha(token));
    return { signedOut: Number(r.changes) };
  }, { terms: false });
  R('POST', '/v1/me/totp/setup', ({ me }) => {
    if (me.totp_enabled) bad('Two-step sign-in is already on.');
    const secret = newSecret();
    h.run('UPDATE accounts SET totp_secret = ?, updated_at = ? WHERE id = ?', secret, now(), me.id);
    return { secret, uri: otpauthUri(secret, me.email) };
  });
  R('POST', '/v1/me/totp/enable', ({ me, body, ip }) => {
    if (!me.totp_secret) bad('Start setup first.');
    const step = checkCode(me.totp_secret, body.code, now(), me.totp_last_step);
    if (step == null) bad('That code is wrong. Check the time on your phone and try the newest code.');
    h.run('UPDATE accounts SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?', step, now(), me.id);
    audit(me.id, 'account.totp_on', me.id, null, ip);
    return { ok: true };
  });
  R('POST', '/v1/me/totp/disable', async ({ me, body, ip }) => {
    if (!me.totp_enabled) return { ok: true };
    if (me.role === 'owner') forbidden('The owner account must keep two-step sign-in on.');
    if (!(await verifyPassword(body.password ?? '', me.pw_hash))) throw new HttpError(401, 'Wrong password.');
    if (checkCode(me.totp_secret, body.code, now(), me.totp_last_step) == null) throw new HttpError(401, 'That code is wrong.');
    h.run('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL, totp_last_step = -1, updated_at = ? WHERE id = ?', now(), me.id);
    audit(me.id, 'account.totp_off', me.id, null, ip);
    return { ok: true };
  });

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
        V.str(body.title, 'Title', { min: 1, max: 120 }), V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '', kind, V.url(body.meetingUrl, 'Meeting link'), now());
      h.run("INSERT INTO class_members (class_id,account_id,role,joined_at) VALUES (?,?,'instructor',?)", id, me.id, now());
    });
    audit(me.id, 'class.create', id, { kind }, ip);
    return { status: 201, body: { class: classOut(loadClass(id), membership(id, me.id)) } };
  });
  R('GET', '/v1/classes', ({ me }) => ({
    classes: h.all("SELECT c.*, m.role AS m_role, m.board AS m_board, m.nickname AS m_nick FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.account_id = ? AND c.status = 'active' ORDER BY c.title", me.id)
      .map((c) => classOut(c, { role: c.m_role, board: c.m_board, nickname: c.m_nick })),
  }));
  R('GET', '/v1/classes/:id', ({ me, params }) => {
    const { c, m } = asMember(params.id, me);
    return { class: classOut(c, m), progress: progressOf(me.id, c.id) };
  });
  R('POST', '/v1/classes/:id', ({ me, params, body }) => {
    const { c } = asInstructor(params.id, me);
    h.run('UPDATE classes SET title = ?, description = ?, meeting_url = ?, status = ? WHERE id = ?',
      body.title != null ? V.str(body.title, 'Title', { min: 1, max: 120 }) : c.title,
      body.description != null ? V.str(body.description, 'Description', { optional: true, max: 4000 }) ?? '' : c.description,
      'meetingUrl' in body ? V.url(body.meetingUrl, 'Meeting link') : c.meeting_url,
      body.status != null ? V.enum(body.status, 'Status', ['active', 'archived']) : c.status, c.id);
    return { class: classOut(loadClass(c.id), membership(c.id, me.id)) };
  });

  R('POST', '/v1/classes/:id/invites', ({ me, params, body }) => {
    const { c } = asTeacher(params.id, me);
    const role = V.enum(body.role ?? 'student', 'Role', ['student', 'ta']);
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
    if (!c || c.status !== 'active') notFound("That code doesn't work. Check it, or ask for a new one.");
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
    if (c.status !== 'active') notFound("That code doesn't work. Check it, or ask for a new one.");
    const existing = membership(c.id, me.id);
    if (!existing) {
      h.tx(() => {
        // (No choice given: the account's own leaderboard setting.)
        const nick = 'nickname' in body ? V.str(body.nickname, 'Nickname', { optional: true, max: 30 }) : me.nickname ?? null;
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
    const nickname = 'nickname' in body ? V.str(body.nickname, 'Nickname', { optional: true, max: 30 }) : m.nickname;
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
    const rows = h.all('SELECT m.*, a.display_name FROM class_members m JOIN accounts a ON a.id = m.account_id WHERE m.class_id = ? ORDER BY m.role, a.display_name', params.id);
    return {
      members: rows
        .filter((r) => teacher || r.role !== 'student' || r.board !== 'hidden' || r.account_id === me.id)
        .map((r) => ({ id: teacher ? r.account_id : undefined, name: teacher || r.role !== 'student' ? r.display_name : boardName(r), role: r.role, joinedAt: r.joined_at, you: r.account_id === me.id })),
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
      sessions: h.all("SELECT s.*, c.title AS class_title FROM class_sessions s JOIN class_members m ON m.class_id = s.class_id JOIN classes c ON c.id = s.class_id WHERE m.account_id = ? AND c.status = 'active' AND s.end_at >= ? AND s.start_at <= ? ORDER BY s.start_at", me.id, from, to)
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
    asMember(s.class_id, me);
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
      if (s.leaderboard && r.points > 0) {
        const today = h.get('SELECT COALESCE(SUM(points),0) AS s FROM xp_events WHERE account_id = ? AND day = ?', me.id, dayKey(t)).s;
        points = capped(r.points, today);
        if (points > 0) h.run('INSERT INTO xp_events (account_id,class_id,question_id,points,at,day) VALUES (?,?,?,?,?,?)', me.id, s.class_id, q.id, points, t, dayKey(t));
      }
      return {
        correct, answer: q.answer, why: q.why, points, scoring: r.due,
        capped: s.leaderboard && r.points > 0 && points < r.points,
        nextDueAt: r.state.dueAt, box: r.state.box, progress: progressOf(me.id),
      };
    });
  });

  // ---------- leaderboards ----------
  R('GET', '/v1/classes/:id/leaderboard', ({ me, params, query }) => {
    asMember(params.id, me);
    const period = V.enum(query.period ?? 'week', 'Period', ['week', 'all']);
    const since = period === 'week' ? weekStart(now()) : 0;
    const rows = h.all(`SELECT m.account_id, m.board, m.nickname, a.display_name, COALESCE(SUM(x.points),0) AS points
      FROM class_members m JOIN accounts a ON a.id = m.account_id
      LEFT JOIN xp_events x ON x.account_id = m.account_id AND x.class_id = m.class_id AND x.at >= ?
      WHERE m.class_id = ? GROUP BY m.account_id ORDER BY points DESC, a.display_name`, since, params.id);
    let rank = 0, last = null, shown = 0;
    const out = []; let mine = null;
    rows.forEach((r, i) => {
      if (r.points !== last) { rank = i + 1; last = r.points; }
      const entry = { rank, name: boardName(r) ?? 'Hidden', points: r.points, you: r.account_id === me.id };
      if (entry.you) mine = entry;
      if ((r.board !== 'hidden' || entry.you) && r.points > 0 && shown < 100) { out.push(entry); shown++; }
    });
    return { period, since, board: out, you: mine };
  });

  // ================= the shared Claude (owner's plan): queue + limits =================
  const getSetting = (k, fallback) => { const r = h.get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : fallback; };
  const setSetting = (k, v) => h.run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  const limitsNow = () => ({ ...BUDGET, ...getSetting('limits', {}) });
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
    const L = limitsNow();
    const today = h.get(`SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'`, me.id, dayStart()).n;
    const week = h.get(`SELECT COUNT(*) AS n FROM scan_jobs WHERE account_id = ? AND created_at >= ? AND status != 'cancelled'`, me.id, now() - 7 * DAY_MS).n;
    return me.role === 'owner' ? { unlimited: true } : { today, perDay: L.perAccountDaily, week, perWeek: L.perAccountWeekly, batchSize: L.questionBatchSize };
  };
  /** Counts every request; flags someone refused a lot, and suspends an account sending requests like a script. */
  const watchRequests = (me, kind, outcome, ip) => {
    const day = dayKey(now());
    h.run('INSERT INTO scan_requests (account_id,kind,outcome,at,day) VALUES (?,?,?,?,?)', me.id, kind, outcome, now(), day);
    if (me.role === 'owner') return;
    const L = limitsNow();
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
    if (!t.startsWith('kea/')) bad('Course material can only go into your Kea folder.');
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
        if (f.size - (mine?.size ?? 0) > room) { audit('system', 'material.storage_full', p.id, { course: key, path: f.path }, 'local'); break; }
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
  function deliverJob(j) {
    if (j.delivered) return 0;
    const files = spaceList(spaces.course(j.course_key), 'material/').filter((f) => f.updatedAt >= (j.started_at ?? 0));
    const people = [
      ...(j.kind === 'more_questions' ? [{ id: j.account_id, target: j.target }] : []),
      ...h.all('SELECT account_id AS id, target FROM scan_job_members WHERE job_id = ?', j.id),
    ];
    const n = files.length ? deliver(j.course_key, files, people) : 0;
    h.run('UPDATE scan_jobs SET delivered = 1 WHERE id = ?', j.id);
    // Classmates who joined a first scan now share the section's material from here on.
    if (j.kind === 'initial_scan') for (const p of people) h.run('INSERT OR IGNORE INTO course_members (course_key,account_id,joined_at,target) VALUES (?,?,?,?)', j.course_key, p.id, now(), p.target);
    return n;
  }

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
    const d = decide(kind, getSetting('limits', {}), facts);
    watchRequests(me, kind, d.action === 'refuse' ? `refuse:${d.code}` : d.action, ip);
    if (d.action === 'refuse') throw new HttpError(429, d.reason, { code: d.code, allowance: allowance(me) });
    if (kind === 'initial_scan') {
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
  // The person's Kea folder (kea/...) while their job runs: the worker is their primary device for it.
  O('GET', '/owner/scan/:id/kea-files', ({ params, query }) => {
    const j = runningJob(params.id);
    return { files: spaceList(spaces.user(j.account_id), 'kea/', Number(query.since) || 0), now: now() };
  });
  O('GET', '/owner/scan/:id/kea-file', ({ params, query }) => {
    const j = runningJob(params.id);
    const p = String(query.path ?? '');
    if (!p.startsWith('kea/')) forbidden('Only their Kea folder.');
    const sp = spaces.user(j.account_id);
    return rawOut(spaceRead(sp, spaceRow(sp, p) ?? notFound()));
  });
  O('PUT', '/owner/scan/:id/kea-file', ({ params, query, raw }) => {
    const j = runningJob(params.id);
    const p = checkPath(String(query.path ?? ''));
    if (!p.startsWith('kea/')) forbidden('Only their Kea folder.');
    return spaceWrite(spaces.user(j.account_id), p, raw);
  });
  O('DELETE', '/owner/scan/:id/kea-file', ({ params, query }) => {
    const j = runningJob(params.id);
    const p = String(query.path ?? '');
    if (!p.startsWith('kea/') || p === 'kea/') forbidden('Only files in their Kea folder.');
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
  O('GET', '/owner/settings', () => ({ limits: limitsNow(), donate: getSetting('donate', { url: null, message: null }) }));
  O('POST', '/owner/settings', ({ body }) => {
    if (body.limits) {
      const next = { ...getSetting('limits', {}) };
      for (const [k, v] of Object.entries(V.obj(body.limits))) {
        if (!(k in BUDGET)) bad(`Unknown limit: ${k}`);
        if (typeof BUDGET[k] === 'boolean') next[k] = V.bool(v, k);
        else next[k] = V.int(v, k, { min: 0, max: 100_000 });
      }
      setSetting('limits', next);
    }
    if (body.donate) {
      const d = V.obj(body.donate);
      setSetting('donate', { url: V.url(d.url, 'Donation link'), message: V.str(d.message, 'Message', { optional: true, max: 200 }) });
    }
    return { limits: limitsNow(), donate: getSetting('donate', { url: null, message: null }) };
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
  }));
  O('GET', '/owner/accounts', ({ query }) => {
    const q = `%${String(query.q ?? '').toLowerCase()}%`;
    return { accounts: h.all('SELECT * FROM accounts WHERE lower(email) LIKE ? OR lower(display_name) LIKE ? ORDER BY created_at DESC LIMIT 200', q, q).map(publicAccount) };
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
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
  });
  // Parent sign-offs: see them all, and approve or withdraw one by hand (for example after a parent emailed).
  O('GET', '/owner/consents', ({ query }) => ({
    consents: h.all(`SELECT c.*, a.email, a.display_name, a.birth_year FROM parent_consents c JOIN accounts a ON a.id = c.account_id ${query.status ? 'WHERE c.status = ?' : ''} ORDER BY c.created_at DESC LIMIT 500`, ...(query.status ? [String(query.status)] : []))
      .map((c) => ({ id: c.id, accountId: c.account_id, email: c.email, name: c.display_name, birthYear: c.birth_year, parentEmail: c.parent_email, status: c.status, method: c.method, note: c.note, createdAt: c.created_at, decidedAt: c.decided_at })),
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
    return { account: publicAccount(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
  });
  O('POST', '/owner/accounts/:id/unlock', ({ params }) => {
    const a = getAccount(params.id);
    fails.clear(nameHash(a.email));
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
  O('POST', '/owner/accounts/:id/quota', ({ params, body }) => {
    const a = getAccount(params.id);
    const gb = body.gb === null ? null : V.int(body.gb, 'gb', { min: 0, max: 100_000 });
    h.run('UPDATE accounts SET quota_bytes = ?, updated_at = ? WHERE id = ?', gb == null ? null : gb * 1024 ** 3, now(), a.id);
    audit('owner', 'owner.quota', a.id, { gb }, 'local');
    return { used: usedBy(a.id), quota: quotaOf(h.get('SELECT * FROM accounts WHERE id = ?', a.id)) };
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

  // ================= request handling =================
  const clientIp = (req) => {
    // Behind one trusted proxy (Tailscale Funnel), X-Forwarded-For's LAST entry is the address the proxy saw; earlier
    // entries come from the client and can be faked to dodge the per-IP limits. Single-value headers
    // (cf-connecting-ip) are used as they are.
    if (ipHeader) {
      const v = req.headers[ipHeader.toLowerCase()];
      if (v) { const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
    }
    return req.socket.remoteAddress || 'unknown';
  };

  async function handleApi(req, res) {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const secure = !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    let status = 200, payload, cookies = [];
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
      let body = {};
      if (req.method === 'POST') {
        const raw = await readBody(req, /^\/v1\/scan\/[^/]+\/calls\/[^/]+\/result$/.test(url.pathname) ? 48 * 1024 * 1024 : MAX_BODY);
        if (raw.trim()) { try { body = JSON.parse(raw); } catch { bad('Invalid JSON.'); } }
        body = V.obj(body);
      }
      const auth = req.headers.authorization;
      const bearer = auth ? /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1] ?? null : null;
      if (auth && !bearer) throw new HttpError(401, 'Sign in again.');
      const cookieToken = bearer ? null : readCookie(req.headers.cookie, COOKIE);
      if (req.method !== 'GET' && !bearer) {
        if (!sameOrigin(req, secure)) forbidden('Cross-site request refused.');
        if (cookieToken && req.headers['x-kea'] !== '1') forbidden('Missing X-Kea header.');
      }
      const ctx = { params, body, query: Object.fromEntries(url.searchParams), ip: clientIp(req), client: String(req.headers['x-kea-client'] || req.headers['user-agent'] || '').slice(0, 120), token: bearer || cookieToken, origin: `${secure ? 'https' : 'http'}://${String(req.headers.host || 'localhost').replace(/[^\w.:[\]-]/g, '')}` };
      if (r.auth) {
        if (!ctx.token) throw new HttpError(401, 'Sign in first.');
        const s = h.get('SELECT * FROM sessions WHERE token_hash = ?', sha(ctx.token));
        if (!s || s.expires_at <= now()) {
          if (cookieToken) cookies = [sessionCookie('', 0, secure)];
          throw new HttpError(401, 'Your sign-in expired. Sign in again.');
        }
        const me = h.get('SELECT * FROM accounts WHERE id = ?', s.account_id);
        if (!me || me.status !== 'active') throw new HttpError(401, 'Sign in again.');
        if (now() - s.last_seen > 3600_000) h.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now(), s.token_hash);
        ctx.me = me;
        // Nothing else works until the current terms are agreed to (reading them, exporting data and signing out still do).
        if (r.terms) {
          const ts = termsStatus(me.id);
          if (ts.needsAgreement) throw new HttpError(428, 'The Kea terms have changed. Read what changed and agree to keep using Kea.', { termsRequired: true, ...ts });
        }
      }
      if (fileRoute) return await handleFile(req, res, ctx, decodeURIComponent(fileMatch[1]), t0);
      let out = await r.handler(ctx);
      if (out && out.__raw) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.__raw.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...out.headers });
        await sendPaced(res, out.__raw);
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
      else { status = 500; payload = { error: 'Something went wrong on the Hub.' }; console.error(e); }
    }
    if (status === 429 && payload?.retryAfter) res.setHeader('retry-after', String(payload.retryAfter));
    send(res, status, payload, cookies);
    if (log) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms`);
  }

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
    if (parts.length > 12 || parts.some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || s.trim() !== s)) bad('That file path has characters Kea storage does not allow.');
    return parts.join('/');
  }
  const readRaw = (req, max) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, `Files can be at most ${Math.round(max / 1024 ** 2)} MB.`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const etagVersion = (v) => { const m = /^"?(\d+)"?$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : null; };

  async function handleFile(req, res, ctx, rawPath, t0) {
    const me = ctx.me;
    const done = (status, payload, headers = {}) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      send(res, status, payload);
      if (log) console.log(`${new Date().toISOString()} ${req.method} /v1/files/… ${status} ${Date.now() - t0}ms`);
    };
    // GET /v1/files/ (empty path) is handled by the list route; here the path is a file.
    const path = checkPath(rawPath);
    const row = h.get('SELECT * FROM files WHERE account_id = ? AND path = ?', me.id, path);
    if (req.method === 'GET') {
      if (!row) notFound('No such file.');
      if (etagVersion(req.headers['if-none-match']) === row.version) { res.writeHead(304, { etag: `"${row.version}"` }); res.end(); return; }
      const data = readFileSync(blobPath(me.id, row.blob));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, etag: `"${row.version}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-kea-sha256': row.sha256 });
      await sendPaced(res, data);
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
      rmSync(blobPath(me.id, row.blob), { force: true });
      return done(200, { ok: true });
    }
    // PUT
    const data = await readRaw(req, maxFileBytes);
    const used = usedBy(me.id) - (row?.size ?? 0);
    const quota = quotaOf(me);
    if (quota >= 0 && used + data.length > quota) throw new HttpError(507, `Your Kea storage is full (${(quota / 1024 ** 3).toFixed(1)} GB). Delete some files or ask for more space.`, { used, quota });
    try { const fs = statfsSync(storageDir); if (fs.bavail * fs.bsize - data.length < minFreeBytes) throw new HttpError(507, "The Kea Hub's drive is nearly full. Try again later."); } catch (e) { if (e instanceof HttpError) throw e; }
    const blob = randomUUID();
    const dir = join(storageDir, me.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${blob}.tmp`), data);
    renameSync(join(dir, `${blob}.tmp`), join(dir, blob));
    const version = (row?.version ?? 0) + 1;
    const hash = createHash('sha256').update(data).digest('hex');
    try {
      h.tx(() => {
        // Re-check inside the transaction so two simultaneous writes can't both win.
        const cur = h.get('SELECT version FROM files WHERE account_id = ? AND path = ?', me.id, path);
        if ((cur?.version ?? 0) !== (row?.version ?? 0)) conflict();
        h.run('INSERT INTO files (account_id,path,blob,size,version,sha256,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET blob=excluded.blob, size=excluded.size, version=excluded.version, sha256=excluded.sha256, updated_at=excluded.updated_at',
          me.id, path, blob, data.length, version, hash, now());
      });
    } catch (e) { rmSync(join(dir, blob), { force: true }); throw e; }
    if (row) rmSync(blobPath(me.id, row.blob), { force: true });
    return done(row ? 200 : 201, { path, version, size: data.length, sha256: hash }, { etag: `"${version}"` });
  }

  async function handleOwner(req, res) {
    let status = 200, payload;
    try {
      // Belt and braces: the listener is bound to 127.0.0.1, and the key must match too.
      const addr = req.socket.remoteAddress;
      if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') forbidden();
      if (req.headers.origin || req.headers['sec-fetch-site']) forbidden('The owner console takes no browser requests.');
      const given = Buffer.from(String(req.headers['x-kea-owner-key'] || ''));
      if (given.length !== ownerKey.length || !timingSafeEqual(given, ownerKey)) throw new HttpError(401, 'Owner key required.');
      const url = new URL(req.url, 'http://localhost');
      const { r, params } = own.find(req.method, url.pathname);
      let body = {}, raw = null;
      if (req.method === 'POST') { const text = await readBody(req); if (text.trim()) { try { body = JSON.parse(text); } catch { bad('Invalid JSON.'); } } body = V.obj(body); }
      if (req.method === 'PUT') raw = await readRaw(req, maxFileBytes);
      payload = await r.handler({ params, body, raw, query: Object.fromEntries(url.searchParams) });
      if (payload && payload.__raw) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.__raw.length, 'cache-control': 'no-store', ...payload.headers });
        res.end(payload.__raw);
        return;
      }
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else { status = 500; payload = { error: 'internal error' }; console.error(e); }
    }
    send(res, status, payload);
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'internal error' }); } catch {} });
  const apiServer = http.createServer(wrap(handleApi));
  const ownerServer = http.createServer(wrap(handleOwner));
  apiServer.headersTimeout = 15_000; apiServer.requestTimeout = 120_000;
  const listenOn = (srv, port) => new Promise((resolve) => srv.listen(port, HOST, () => resolve(srv.address().port)));

  return {
    h, key, ownerKey: ownerKey.toString(),
    async listen({ port = Number(process.env.KEA_HUB_PORT) || 4860, ownerPort = Number(process.env.KEA_HUB_OWNER_PORT) || 4861 } = {}) {
      return { port: await listenOn(apiServer, port), ownerPort: await listenOn(ownerServer, ownerPort) };
    },
    close() {
      return Promise.all([apiServer, ownerServer].map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r())))).then(() => h.close());
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hub = createHub();
  const { port, ownerPort } = await hub.listen();
  console.log(`Kea Hub ${VERSION} on http://${HOST}:${port} (tunnel this one). Owner console on http://${HOST}:${ownerPort} (never tunnel this).`);
}
