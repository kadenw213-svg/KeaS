// The KeaS server: one organization's (or a few organizations') server, run on their own PC by the KeaS app.
//
// Who people are comes from Kea accounts on KeaC (the Kea account server), never from here: KeaS has no passwords, no
// two-step codes and no account sign-up. Kea asks KeaC for a pass for this server (docs/protocol.md section 2), and
// POST /v1/auth/pass turns it into a KeaS session (hub/lib/keac.mjs checks it). What KeaS keeps:
//   - the org engine (org/): members by Kea account id, roles, structure, schedules, the time clock, pay codes, stubs;
//   - its own sessions, and keas_members (the name and email from each person's newest pass);
//   - its server identity (server-identity.pem): an Ed25519 key, its id the key's fingerprint, never registered
//     anywhere; GET /v1/identity proves it;
//   - each member's files area (/v1/files, the Kea Hub's API), as big as their organization allows (1 GB by default);
//   - the payroll vault's local token (the owner console only), see /owner/payroll-token.
//
// Two listeners, both on 127.0.0.1:
//   - the public API (port 4860), which Tailscale Funnel (or another tunnel) forwards the internet to;
//   - the owner console (port 4861), never tunneled: loopback only, and every call answers a fresh challenge with the
//     owner key from the data folder (hub/lib/ownerauth.mjs). The KeaS app uses it to claim the server at setup
//     (POST /owner/claim, with the one-time setup code), for the payroll vault's token and for the server's status.
//     Claiming is only possible there: there is no remote way to claim a server.
import http from 'node:http';
import { createHash, randomBytes, randomUUID, sign as edSign, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync, createReadStream, createWriteStream, statfsSync } from 'node:fs';
import { mkdir as mkdirP, readFile as readFileP, rename as renameP, rm as rmP } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DATA_DIR } from './db.mjs';
import { upgradeHub05, folderState, readMarker, writeMarker, hubKeyOf, MARKER, KEAS_DB } from './upgrade.mjs';
import { createKeac, envKeys, keyFingerprint, cleanKeys, KEAC_URL, KEAC_KEYS, PassError } from './lib/keac.mjs';
import { ownerNonces, ownerReplyMac, OWNER_AUTH_HEADER, OWNER_CHALLENGE_HEADER, OWNER_REPLY_HEADER } from './lib/ownerauth.mjs';
import { cleanText, isReservedName } from './lib/names.mjs';
import { loadOrCreateKey, signToken } from './lib/tokens.mjs';
import { writeSecretFile } from './lib/secureFile.mjs';
import { Windows, Buckets } from './lib/limiter.mjs';
import { createHubLog } from './lib/hublog.mjs';
import { clientAddress, ipBucket, isLoopback } from './lib/clientip.mjs';
import { mountOrg, passIdentity } from '../org/index.mjs';

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
const PRE_AUTH_BODY = 16 * 1024;
export const SESSION_DAYS = 30;
export const PAYROLL_TOKEN_MINUTES = 15;
export const PAYROLL_AUDIENCE = 'keas-payroll';
export const IDENTITY_KEY_FILE = 'server-identity.pem';
export const SETUP_FILE = 'setup.secret';
// The Kea Hub's (KeaS 0.5) account routes, none of which a KeaS server has: answered 410 with movedTo once moved.
const LEGACY_ROUTE = /^\/v1\/(auth\/(register|login|google|oauth|reset\/.*|token)|keys|terms(\/.*)?|me\/(password|totp\/.*|delete|export|verify\/.*|consent(\/.*)?|leaderboard|phone|birth-year)|consent\/.*|hosting(\/.*)?|classes(\/.*)?|invites\/.*|join|class-sessions\/.*|calendar|sets\/.*|course-sections\/.*|course-files?|scan(\/.*)?|support)$/;
export const LEGACY_MESSAGE = 'Your Kea accounts are still here. Move them to your Kea account server, then this PC becomes your organization’s server.';
const FEATURES = ['passes', 'orgs', 'orgRoles', 'orgClock', 'payCodes', 'payCodeRates', 'stubs', 'files'];

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => { throw new HttpError(400, m, extra); };
const forbidden = (m = 'Not allowed.') => { throw new HttpError(403, m); };
const notFound = (m = 'Not found.') => { throw new HttpError(404, m); };
const TIME_MIN = Date.UTC(2000, 0, 1), TIME_MAX = Date.UTC(2100, 0, 1);

const V = {
  str(v, name, { optional = false, max = 500, min = 0 } = {}) {
    if ((v == null || v === '') && optional) return null;
    if (typeof v !== 'string') bad(`${name} must be text.`);
    const t = v.trim();
    if (t.length < min || t.length > max) bad(`${name} must be ${min}-${max} characters.`);
    return t;
  },
  int(v, name, { optional = false, min = -Infinity, max = Infinity } = {}) {
    if (v == null && optional) return null;
    if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}.`);
    return v;
  },
  bool(v, name, { optional = false } = {}) { if (v == null && optional) return null; if (typeof v !== 'boolean') bad(`${name} must be true or false.`); return v; },
  enum(v, name, list, { optional = false } = {}) { if (v == null && optional) return null; if (!list.includes(v)) bad(`${name} must be one of: ${list.join(', ')}.`); return v; },
  time(v, name) {
    const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 64 ? Date.parse(v) : NaN;
    if (!Number.isInteger(t) || t < TIME_MIN || t > TIME_MAX) bad(`${name} must be a date and time between 2000 and 2100.`);
    return t;
  },
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
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = (n = 12) => [...randomBytes(n)].map((b) => CODE_ALPHA[b % CODE_ALPHA.length]).join('');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** This server's id from its public key: base64url(SHA-256(the 32-byte raw key)), the first 22 characters. */
export const serverIdOf = (jwk) => createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url').slice(0, 22);

function readRaw(req, max, message = 'Request too large.', idleMs = 15_000) {
  return new Promise((resolveP, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { req.pause(); return reject(new HttpError(413, message)); }
    let size = 0; const chunks = [];
    let idle = null;
    const watch = () => { clearTimeout(idle); idle = setTimeout(() => { chunks.length = 0; reject(new HttpError(408, 'The request stopped arriving.')); req.destroy(); }, idleMs); idle.unref?.(); };
    const onData = (c) => {
      size += c.length;
      if (size > max) { clearTimeout(idle); req.off('data', onData); req.pause(); chunks.length = 0; reject(new HttpError(413, message)); } else { chunks.push(c); watch(); }
    };
    watch();
    req.on('data', onData);
    req.on('end', () => { clearTimeout(idle); resolveP(Buffer.concat(chunks)); });
    req.on('error', (e) => { clearTimeout(idle); reject(e); });
    req.on('close', () => clearTimeout(idle));
  });
}

function makeRouter() {
  const routes = [];
  const add = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
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
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const send = (res, status, payload, extra = {}) => { res.writeHead(status, { ...HEADERS, ...extra }); res.end(JSON.stringify(payload ?? {})); };

export function createHub({
  dataDir = DATA_DIR,
  dbFile = join(dataDir, KEAS_DB),
  now = () => Date.now(),
  // The header the tunnel puts the visitor's address in ('x-forwarded-for' behind Tailscale Funnel).
  ipHeader = process.env.KEA_HUB_IP_HEADER || null,
  limits = {},
  log = true,
  logFile = null,
  // KeaC: its address (null: the one confirmed in the KeaS app, then KEAC_URL), keys trusted besides the one confirmed
  // there, and how to reach it (tests).
  keacUrl = null,
  keacKeys = [...KEAC_KEYS, ...envKeys()],
  keacFetch = fetch,
  keacStart = true,
  // A display name for /v1/identity when this server has no organization yet (or several).
  serverName = null,
  sessionDays = SESSION_DAYS,
  maxFileBytes = 64 * 1024 ** 2,
  maxFilesPerAccount = 20_000,
  minFreeBytes = null,
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  // A KeaS 0.5 Kea Hub folder: still the Kea Hub until its accounts moved to KeaC (openServer runs it); once moved,
  // keas.db is made from a copy of it (hub/upgrade.mjs), and hub.db stays as it was.
  if (folderState(dataDir) === 'legacy') throw Object.assign(new Error(LEGACY_MESSAGE), { code: 'LEGACY_HUB' });
  const upgraded = upgradeHub05(dataDir, { now: now() });
  const h = openDb(dbFile);
  const identityKey = loadOrCreateKey(join(dataDir, IDENTITY_KEY_FILE));
  const serverId = serverIdOf(identityKey.jwk);
  const ownerKeyFile = join(dataDir, 'owner.key');
  if (!existsSync(ownerKeyFile)) writeSecretFile(ownerKeyFile, randomBytes(32).toString('hex'));
  // The org data key: seals pay code rates and published stubs in the org engine (org/paycodes.mjs, org/stubs.mjs).
  const orgDataKeyFile = join(dataDir, 'org-data.key');
  if (!existsSync(orgDataKeyFile)) writeSecretFile(orgDataKeyFile, randomBytes(32).toString('hex'));
  const orgDataKey = readFileSync(orgDataKeyFile, 'utf8').trim();
  const filesDir = join(dataDir, 'member-files');
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
  const hlog = createHubLog({ file: logFile, toConsole: !!log });

  const getSetting = (k, fallback) => { const r = h.get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : fallback; };
  const setSetting = (k, v) => h.run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  const audit = (actor, action, target, detail, ip) =>
    h.run('INSERT INTO audit (at,actor,action,target,detail,ip) VALUES (?,?,?,?,?,?)', now(), actor ?? null, action, target ?? null, detail == null ? null : JSON.stringify(detail), ip ?? null);
  const operatorId = () => getSetting('operator', null);

  // ---------- the one-time setup code (claiming the server; see /owner/claim) ----------
  const setupFile = join(dataDir, SETUP_FILE);
  const setupSecret = () => { try { return readFileSync(setupFile, 'utf8').trim(); } catch { return null; } };
  if (!operatorId() && !setupSecret()) { const c = newCode(12); writeSecretFile(setupFile, `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`); }
  if (operatorId()) rmSync(setupFile, { force: true });

  // ---------- limits ----------
  const windows = new Windows();
  const buckets = new Buckets();
  const L = { pass: [30, 10 * 60_000], claim: [10, 10 * 60_000], join: [20, 10 * 60_000], rps: [20, 60], rpsAll: [2000, 4000], writes: [20, 100], ...limits };
  const SHARED_FACTOR = 20;
  const limit = (kind, who) => {
    const [base, ms] = L[kind];
    const n = isLoopback(who) || who === 'unknown' ? base * SHARED_FACTOR : base;
    const wait = windows.hit(`${kind}:${ipBucket(String(who))}`, n, ms, now());
    if (wait > 0) throw new HttpError(429, `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`, { retryAfter: Math.ceil(wait / 1000) });
  };

  // ---------- notifications ----------
  const NOTE_KEEP = 500;
  const notify = (accountId, kind, title, body = '', { note = null, data = null } = {}) => {
    if (!accountId) return null;
    const r = h.run('INSERT INTO notifications (account_id,kind,title,body,note,data,created_at) VALUES (?,?,?,?,?,?,?)', accountId, kind, String(title).slice(0, 200), String(body ?? '').slice(0, 4000), note ? String(note).slice(0, 2000) : null, data == null ? null : JSON.stringify(data), now());
    h.run('DELETE FROM notifications WHERE account_id = ? AND id <= (SELECT id FROM notifications WHERE account_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', accountId, accountId, NOTE_KEEP);
    return Number(r.lastInsertRowid);
  };
  const noteOut = (n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, note: n.note, data: n.data ? JSON.parse(n.data) : null, createdAt: n.created_at, readAt: n.read_at });
  const unreadCount = (accountId) => h.get('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL', accountId).n;

  // ---------- KeaC: keys, revocation, passes ----------
  const keacAddress = () => (typeof keacUrl === 'function' ? keacUrl() : keacUrl) || getSetting('keac.url', null) || process.env.KEAC_URL || KEAC_URL || null;
  const endSessionsOf = (ids) => { for (const id of ids) { const n = Number(h.run('DELETE FROM keas_sessions WHERE account_id = ?', id).changes); if (n) audit('keac', 'session.revoked', id, { ended: n }, null); } };
  const keac = createKeac({
    url: keacAddress,
    builtIn: () => [...keacKeys, ...getSetting('keac.pinned', [])],
    store: { get: getSetting, set: setSetting },
    revoked: {
      has: (id) => !!h.get('SELECT 1 FROM keac_revoked WHERE account_id = ?', id),
      count: () => h.get('SELECT COUNT(*) AS n FROM keac_revoked').n,
      add: (ids) => h.tx(() => { for (const id of ids) h.run('INSERT OR IGNORE INTO keac_revoked (account_id,at) VALUES (?,?)', id, now()); }),
      set: (ids) => h.tx(() => { h.run('DELETE FROM keac_revoked'); for (const id of ids) h.run('INSERT OR IGNORE INTO keac_revoked (account_id,at) VALUES (?,?)', id, now()); }),
    },
    onRevoked: endSessionsOf,
    fetchImpl: keacFetch, now,
    log: (m) => { if (log) console.warn(`KeaS: ${m}`); },
  });
  const AUD = `keas:${serverId}`;
  /** A pass checked (or an HttpError 401 saying why), and its member row brought up to date. */
  async function acceptPass(pass, ip) {
    let p;
    try { p = await keac.verify(pass, { aud: AUD }); }
    catch (e) {
      if (e instanceof PassError) { audit(null, 'pass.refused', null, { reason: e.reason }, ip); throw new HttpError(401, e.message, { reason: e.reason }); }
      throw e;
    }
    // The phone number, phoneOrgs and phoneClassmates follow the newest pass too: a pass without them clears them (the
    // person stopped sharing, or removed the number).
    h.run(`INSERT INTO keas_members (id,email,name,first_seen,last_pass_at,pass_iat,phone,phone_orgs,phone_classmates) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email = CASE WHEN excluded.pass_iat >= pass_iat THEN COALESCE(excluded.email, email) ELSE email END,
        name = CASE WHEN excluded.pass_iat >= pass_iat AND excluded.name != '' THEN excluded.name ELSE name END,
        phone = CASE WHEN excluded.pass_iat >= pass_iat THEN excluded.phone ELSE phone END,
        phone_orgs = CASE WHEN excluded.pass_iat >= pass_iat THEN excluded.phone_orgs ELSE phone_orgs END,
        phone_classmates = CASE WHEN excluded.pass_iat >= pass_iat THEN excluded.phone_classmates ELSE phone_classmates END,
        last_pass_at = excluded.last_pass_at, pass_iat = MAX(pass_iat, excluded.pass_iat)`, p.sub, p.email, p.name, now(), now(), p.iat, p.phone ?? null, p.phoneOrgs ? 1 : 0, p.phoneClassmates ? 1 : 0);
    return p;
  }
  const memberOf = (id) => h.get('SELECT id, email, name FROM keas_members WHERE id = ?', id);
  /** A new KeaS session for a checked pass (at most 20 per person: the oldest go). */
  function newSession(p, client) {
    const token = randomBytes(32).toString('hex');
    const exp = now() + sessionDays * 86400_000;
    h.tx(() => {
      h.run('INSERT INTO keas_sessions (token_hash,account_id,created_at,expires_at,last_seen,pass_iat,client) VALUES (?,?,?,?,?,?,?)', sha(token), p.sub, now(), exp, now(), p.iat, client || null);
      h.run('DELETE FROM keas_sessions WHERE account_id = ? AND token_hash NOT IN (SELECT token_hash FROM keas_sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 20)', p.sub, p.sub);
    });
    return { token, exp };
  }
  const liveSession = (token) => {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const s = h.get('SELECT * FROM keas_sessions WHERE token_hash = ?', sha(token));
    if (!s || s.expires_at <= now() || h.get('SELECT 1 FROM keac_revoked WHERE account_id = ?', s.account_id)) return null;
    return s;
  };
  const meOut = (m) => ({ id: m.id, email: m.email, name: m.name, operator: m.id === operatorId() });

  // ---------- members' files area ----------
  /** How much one member may keep here: the biggest files allowance of their active organizations (0 with none). */
  const quotaOf = (aid) => {
    let gb = 0;
    for (const r of h.all("SELECT o.settings FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = ? AND m.status = 'active' AND o.status = 'active'", aid)) {
      let s = {}; try { s = JSON.parse(r.settings || '{}'); } catch {}
      const g = typeof s.filesQuotaGb === 'number' && s.filesQuotaGb >= 0 ? s.filesQuotaGb : 1;
      if (g > gb) gb = g;
    }
    return Math.round(gb * 1024 ** 3);
  };
  const usage = (aid) => h.get('SELECT COALESCE(SUM(size),0) AS used, COUNT(*) AS n FROM member_files WHERE account_id = ?', aid);
  const blobPath = (aid, blob) => join(filesDir, sha(`member:${aid}`).slice(0, 32), blob);
  const dirOf = (aid) => join(filesDir, sha(`member:${aid}`).slice(0, 32));
  function checkDisk(size) {
    try {
      const s = statfsSync(dataDir);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      const keep = minFreeBytes ?? Math.max(5 * 1024 ** 3, total * 0.02);
      if (free - size < keep) throw new HttpError(507, 'This KeaS server’s drive is nearly full, so new files wait. Tell whoever runs it.', { storageFull: true });
    } catch (e) { if (e instanceof HttpError) throw e; }
  }

  // ---------- routes ----------
  const api = makeRouter();
  const own = makeRouter();
  const R = api.add;
  const O = own.add;

  // A folder that was a Kea Hub: its Kea accounts moved to KeaC (moved-to-keac.json). Kea apps still pointed at this
  // address are told where (they follow only when that address lists the same key kid at /v1/keys).
  const moved = readMarker(dataDir);
  const movedTo = () => (moved ? moved.keacUrl || keacAddress() || null : null);
  R('GET', '/v1/health', () => ({ ok: true, service: 'keas', version: VERSION, serverId, features: FEATURES, claimed: !!operatorId(), ...(moved ? { movedTo: movedTo(), keacKeyKid: moved.keacKeyKid } : {}) }), { auth: false });
  // Proves this server holds the key its id is made from: signs `kea-server-identity:<serverId>:<nonce>`.
  R('GET', '/v1/identity', ({ query }) => {
    const n = String(query.nonce ?? '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(n)) bad('Send nonce: 16 to 128 letters, digits, - or _.');
    const orgs = h.all("SELECT name FROM orgs WHERE status = 'active' ORDER BY created_at LIMIT 2");
    return {
      serverId, publicKey: { kty: 'OKP', crv: 'Ed25519', x: identityKey.jwk.x }, name: orgs.length === 1 ? orgs[0].name : serverName || 'KeaS',
      sig: edSign(null, Buffer.from(`kea-server-identity:${serverId}:${n}`), identityKey.privateKey).toString('base64url'),
    };
  }, { auth: false });
  // A pass from KeaC for this server: a KeaS session. Sent with the session it renews (Authorization), a pass at least
  // as new as that session's renews it; otherwise a new session.
  R('POST', '/v1/auth/pass', async ({ body, ip, client, token }) => {
    limit('pass', ip);
    const pass = typeof body.pass === 'string' ? body.pass : bad('Send pass: the pass from your Kea account.');
    const p = await acceptPass(pass, ip);
    const s = liveSession(token);
    if (s && s.account_id === p.sub && p.iat >= s.pass_iat) {
      const exp = now() + sessionDays * 86400_000;
      h.run('UPDATE keas_sessions SET expires_at = ?, pass_iat = ?, last_seen = ? WHERE token_hash = ?', exp, p.iat, now(), s.token_hash);
      return { token, exp, expiresAt: new Date(exp).toISOString(), renewed: true, me: meOut(memberOf(p.sub)) };
    }
    const n = newSession(p, client);
    audit(p.sub, 'auth.pass', p.sub, { kid: p.kid }, ip);
    return { token: n.token, exp: n.exp, expiresAt: new Date(n.exp).toISOString(), renewed: false, me: meOut(memberOf(p.sub)) };
  }, { auth: false });
  R('POST', '/v1/auth/logout', ({ token }) => {
    if (token) h.run('DELETE FROM keas_sessions WHERE token_hash = ?', sha(token));
    return { ok: true };
  }, { auth: false });

  R('GET', '/v1/me', ({ me }) => {
    const u = usage(me.id);
    return {
      me: meOut(me), files: { used: u.used, quota: quotaOf(me.id), count: u.n },
      notifications: { unread: unreadCount(me.id), latest: h.get('SELECT MAX(id) AS n FROM notifications WHERE account_id = ?', me.id).n ?? 0 },
    };
  });
  R('GET', '/v1/me/sessions', ({ me, token }) => ({
    sessions: h.all('SELECT * FROM keas_sessions WHERE account_id = ? ORDER BY last_seen DESC', me.id).map((s) => ({ current: s.token_hash === sha(token), createdAt: s.created_at, expiresAt: s.expires_at, lastSeen: s.last_seen, client: s.client })),
  }));
  R('POST', '/v1/me/sessions/sign-out-others', ({ me, token }) => ({ ended: Number(h.run('DELETE FROM keas_sessions WHERE account_id = ? AND token_hash != ?', me.id, sha(token)).changes) }));
  R('GET', '/v1/me/notifications', ({ me, query }) => {
    const after = Math.max(0, Number(query.after) || 0);
    const lim = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const unreadOnly = query.unread === '1' || query.unread === 'true';
    return { notifications: h.all(`SELECT * FROM notifications WHERE account_id = ? AND id > ?${unreadOnly ? ' AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, me.id, after, lim).map(noteOut), unread: unreadCount(me.id) };
  });
  R('POST', '/v1/me/notifications/read', ({ me, body }) => {
    if (body.all === true) h.run('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL', now(), me.id);
    else {
      if (!Array.isArray(body.ids) || body.ids.length > 500) bad('Say which notifications: ids (a list), or all: true.');
      for (const id of body.ids) h.run('UPDATE notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL', now(), V.int(id, 'id', { min: 1 }), me.id);
    }
    return { unread: unreadCount(me.id) };
  });
  R('POST', '/v1/me/notifications/delete', ({ me, body }) => {
    if (body.all === true) h.run('DELETE FROM notifications WHERE account_id = ? AND read_at IS NOT NULL', me.id);
    else {
      if (!Array.isArray(body.ids) || body.ids.length > 500) bad('Say which notifications: ids (a list), or all: true for every read one.');
      for (const id of body.ids) h.run('DELETE FROM notifications WHERE id = ? AND account_id = ?', V.int(id, 'id', { min: 1 }), me.id);
    }
    return { unread: unreadCount(me.id) };
  });
  // The files list (the Kea Hub's GET /v1/files): with `limit`, a page at a time (`after`, `next`).
  R('GET', '/v1/files', ({ me, query }) => {
    const prefix = String(query.prefix ?? '');
    const since = Number(query.since) || 0;
    const paged = query.limit != null;
    const n = paged ? Math.min(5000, Math.max(1, Number(query.limit) || 1000)) : -1;
    const rows = h.all('SELECT path, size, version, sha256, updated_at FROM member_files WHERE account_id = ? AND substr(path, 1, length(?)) = ? AND updated_at > ? AND path > ? ORDER BY path LIMIT ?', me.id, prefix, prefix, since, String(query.after ?? ''), paged ? n + 1 : -1);
    const more = paged && rows.length > n;
    if (more) rows.length = n;
    return {
      used: usage(me.id).used, quota: quotaOf(me.id), now: now(),
      files: rows.map((f) => ({ path: f.path, size: f.size, version: f.version, sha256: f.sha256, updatedAt: f.updated_at })),
      ...(paged ? { next: more ? rows[rows.length - 1].path : null } : {}),
    };
  });

  // ---------- the org engine ----------
  const rawOut = (data, headers = {}) => ({ __raw: Buffer.isBuffer(data) ? data : Buffer.from(String(data)), headers });
  const orgEngine = mountOrg({
    R, O, h, now, audit, notify, classes: true, dataKey: orgDataKey,
    identity: passIdentity({ h, operatorId, getSetting }),
    operator: { autoApprove: () => getSetting('orgs', {}).autoApprove === true, setAutoApprove: (v) => setSetting('orgs', { ...getSetting('orgs', {}), autoApprove: v }) },
    kit: { HttpError, V, limit, normCode, rawOut },
  });

  // ---------- forgetting someone (they ask to leave this server, or the operator removes them) ----------
  // Everything this server keeps for one Kea account: memberships, roles, punches, certs, answers (org/index.mjs
  // forgetAccount), notices, files, sessions and the member row. Shifts they worked stay, without them. Refused while
  // they're the only owner of an organization others are still in (they hand it over first).
  async function forgetMember(aid, confirm, by, ip) {
    const m = memberOf(aid) ?? notFound('Nobody with that id has signed in here.');
    if (String(confirm ?? '').trim().toLowerCase() !== String(m.email ?? '').toLowerCase()) bad('Type the email address to confirm.');
    const blocked = orgEngine.soleOwnerOrgs(aid);
    if (blocked.length) throw new HttpError(409, `${blocked.map((o) => o.name).join(', ')} would have no owner. Make someone else an owner first.`, { orgs: blocked });
    h.tx(() => {
      orgEngine.forgetAccount(aid);
      for (const t of ['keas_sessions', 'notifications', 'member_files', 'class_members']) h.run(`DELETE FROM ${t} WHERE account_id = ?`, aid);
      h.run('DELETE FROM keas_members WHERE id = ?', aid);
      h.run('UPDATE audit SET actor = NULL WHERE actor = ?', aid);
    });
    await rmP(dirOf(aid), { recursive: true, force: true });
    audit(by, 'member.forget', null, null, ip);
    return { ok: true };
  }
  R('POST', '/v1/me/leave-server', ({ me, body, ip }) => forgetMember(me.id, body.confirm, null, ip));

  // ---------- the owner console (KeaS app on this PC only) ----------
  O('GET', '/owner/stats', () => ({
    version: VERSION, serverId, claimed: !!operatorId(), setupPending: !!setupSecret(), operator: operatorId() ? meOut(memberOf(operatorId()) ?? { id: operatorId() }) : null,
    members: h.get('SELECT COUNT(*) AS n FROM keas_members').n, sessions: h.get('SELECT COUNT(*) AS n FROM keas_sessions WHERE expires_at > ?', now()).n,
    orgs: h.all('SELECT id, name, status, state, tz FROM orgs ORDER BY created_at'), keac: keac.status(), upgrade: getSetting('upgrade.05', null),
    dataDir: resolve(dataDir),
  }));
  // Claiming a fresh server (setup, in the KeaS app): the one-time setup code (made at first start, in setup.secret,
  // shown only on this PC) and a pass for this server. The person becomes its operator; they then make their
  // organization (POST /v1/orgs with the session this returns) and own it.
  O('POST', '/owner/claim', async ({ body }) => {
    limit('claim', 'local');
    if (operatorId()) throw new HttpError(409, 'This KeaS server is set up already.', { claimed: true });
    const want = setupSecret();
    const got = normCode(body.secret);
    if (!want || got.length !== normCode(want).length || !timingSafeEqual(Buffer.from(got), Buffer.from(normCode(want)))) throw new HttpError(403, 'That setup code isn’t this server’s. It’s shown in the KeaS app on this PC.');
    const p = await acceptPass(String(body.pass ?? ''), 'local');
    setSetting('operator', p.sub);
    rmSync(setupFile, { force: true });
    audit(p.sub, 'owner.claim', serverId, null, 'local');
    const n = newSession(p, 'KeaS app');
    return { token: n.token, exp: n.exp, me: meOut(memberOf(p.sub)) };
  });
  O('POST', '/owner/settings', ({ body }) => {
    if (body.orgs != null) {
      const o = V.obj(body.orgs), cur = getSetting('orgs', {});
      setSetting('orgs', { ...cur, ...('anyoneCreates' in o ? { anyoneCreates: V.bool(o.anyoneCreates, 'anyoneCreates') } : {}), ...('autoApprove' in o ? { autoApprove: V.bool(o.autoApprove, 'autoApprove') } : {}) });
    }
    return { orgs: getSetting('orgs', {}) };
  });
  // The payroll vault's sign-in (server/payroll/hub.mjs): a 15-minute token for the audience 'keas-payroll', signed by
  // this server's identity key, for the KeaS session the KeaS app holds. Only here (owner key, loopback), never on the
  // public API: the vault trusts this server's key (it reads it from the data folder on this PC).
  O('POST', '/owner/payroll-token', ({ body }) => {
    const s = liveSession(String(body.session ?? ''));
    if (!s) throw new HttpError(401, 'That KeaS sign-in has ended. Sign in again with your Kea account.');
    const m = memberOf(s.account_id) ?? notFound();
    const t = Math.floor(now() / 1000);
    const token = signToken(identityKey, { iss: AUD, aud: PAYROLL_AUDIENCE, sub: m.id, email: m.email, name: m.name, ev: true, iat: t, exp: t + PAYROLL_TOKEN_MINUTES * 60 });
    return { token, expiresIn: PAYROLL_TOKEN_MINUTES * 60, iss: AUD };
  });
  O('GET', '/owner/keac', () => keac.status());
  // Trusting KeaC's key (KeaS setup): the keys it lists now, with fingerprints the owner compares with KeaC's Keys
  // screen, then the one they confirmed (kid and fingerprint) is pinned, with the address.
  const urlIn = (v) => {
    const u = V.str(v, 'Address', { min: 8, max: 300 });
    let x; try { x = new URL(u); } catch { bad('That isn’t a web address.'); }
    if (!(x.protocol === 'https:' || (x.protocol === 'http:' && isLoopback(x.hostname.replace(/^\[|\]$/g, ''))) || (x.protocol === 'http:' && x.hostname === 'localhost'))) bad('Use the Kea account server’s https:// address.');
    return x.origin + x.pathname.replace(/\/+$/, '');
  };
  O('GET', '/owner/keac/offer', async ({ query }) => {
    const url = query.url ? urlIn(query.url) : keacAddress();
    let keys;
    try { keys = await keac.offer(url); } catch (e) { throw new HttpError(502, `Couldn’t get the keys from ${url}: ${e.message}`); }
    const marker = readMarker(dataDir), own = hubKeyOf(dataDir);
    return { url, keys: keys.map((k) => ({ kid: k.kid, status: k.status, fingerprint: k.fingerprint, oldHubKey: !!own && own.kid === k.kid && own.jwk.x === k.x })), suggested: marker?.keacKeyKid ?? keys.find((k) => k.status === 'current')?.kid ?? null, pinned: getSetting('keac.pinned', []).map((k) => ({ kid: k.kid, fingerprint: keyFingerprint(k) })) };
  });
  O('POST', '/owner/keac/pin', async ({ body }) => {
    const url = urlIn(body.url);
    const kid = V.str(body.kid, 'Key', { min: 1, max: 80 });
    const fp = String(body.fingerprint ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
    let keys;
    try { keys = await keac.offer(url); } catch (e) { throw new HttpError(502, `Couldn’t get the keys from ${url}: ${e.message}`); }
    const k = keys.find((x) => x.kid === kid) ?? bad('The Kea account server doesn’t list that key now. Look again.');
    if (k.fingerprint.replace(/ /g, '') !== fp) throw new HttpError(409, 'That fingerprint isn’t the one the Kea account server shows for this key now. Nothing was trusted; compare again.');
    setSetting('keac.url', url);
    setSetting('keac.pinned', cleanKeys([k], { status: false }));
    keac.reset();
    audit('owner', 'keac.pin', kid, { url, fingerprint: k.fingerprint }, 'local');
    await keac.refreshKeys();
    keac.pollRevoked({ full: true });
    return { url, pinned: { kid, fingerprint: k.fingerprint }, status: keac.status() };
  });
  O('POST', '/owner/keac/refresh', async () => ({ keys: await keac.refreshKeys(), revoked: await keac.pollRevoked({ full: true }), status: keac.status() }));
  O('GET', '/owner/members', () => ({ members: h.all('SELECT m.*, (SELECT COUNT(*) FROM keas_sessions s WHERE s.account_id = m.id AND s.expires_at > ?) AS sessions, (SELECT 1 FROM keac_revoked r WHERE r.account_id = m.id) AS revoked FROM keas_members m ORDER BY m.name', now()).map((m) => ({ id: m.id, email: m.email, name: m.name, firstSeen: m.first_seen, lastPassAt: m.last_pass_at, sessions: m.sessions, revoked: !!m.revoked })) }));
  O('POST', '/owner/members/:id/forget', ({ params, body }) => forgetMember(params.id, body.confirm, 'owner', 'local'));
  O('POST', '/owner/members/:id/sign-out', ({ params }) => ({ ended: Number(h.run('DELETE FROM keas_sessions WHERE account_id = ?', params.id).changes) }));
  O('GET', '/owner/audit', ({ query }) => ({ entries: h.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', Math.min(1000, Number(query.limit) || 200)) }));

  // ================= request handling =================
  const clientOf = (req) => clientAddress(req.headers, req.socket.remoteAddress, ipHeader);
  async function handleApi(req, res) {
    const t0 = Date.now();
    const from = clientOf(req);
    const f = from.shared || isLoopback(from.ip) ? SHARED_FACTOR : 1;
    if (buckets.take(`rps:${ipBucket(from.ip)}`, L.rps[0] * f, L.rps[1] * f, t0) > 0 || buckets.take('rps:*', L.rpsAll[0], L.rpsAll[1], t0) > 0) return send(res, 429, { error: 'Too many requests. Slow down.', retryAfter: 1 }, { 'retry-after': '1' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'PUT') { const tm = setTimeout(() => { if (!req.complete) req.socket.destroy(); }, 30_000); tm.unref?.(); res.once('close', () => clearTimeout(tm)); }
    let status = 200, payload;
    // The Kea Hub's account routes, after its accounts moved: where they went.
    if (moved && LEGACY_ROUTE.test(url.pathname)) {
      const to = movedTo();
      send(res, 410, to ? { error: 'Kea accounts moved', movedTo: to, keacKeyKid: moved.keacKeyKid } : { error: 'Kea accounts moved to the Kea account server.', movedTo: null });
      hlog.request(req.method, url.pathname, 410, Date.now() - t0);
      return;
    }
    try {
      const fileMatch = /^\/v1\/files\/(.+)$/.exec(url.pathname);
      const fileRoute = fileMatch && ['GET', 'PUT', 'DELETE'].includes(req.method);
      const { r, params } = fileRoute ? { r: { auth: true }, params: {} } : api.find(req.method, url.pathname);
      const auth = req.headers.authorization;
      const bearer = auth ? /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1] ?? null : null;
      if (auth && !bearer && r.auth) throw new HttpError(401, 'Sign in again.');
      // (Browsers don't get in: KeaS is used from Kea and the KeaS app, which send no Origin of another site.)
      const site = req.headers['sec-fetch-site'];
      if (req.method !== 'GET' && site && site !== 'same-origin' && site !== 'none') forbidden('Cross-site request refused.');
      const ctx = { params, body: {}, query: Object.fromEntries(url.searchParams), ip: from.ip, ipKey: ipBucket(from.ip), client: String(req.headers['x-kea-client'] || req.headers['user-agent'] || '').slice(0, 120), token: bearer };
      if (r.auth) {
        const s = liveSession(bearer);
        if (!s) throw new HttpError(401, bearer ? 'Your sign-in here ended. Kea signs in again with your Kea account.' : 'Sign in first.');
        const me = memberOf(s.account_id);
        if (!me) throw new HttpError(401, 'Sign in again.');
        if (now() - s.last_seen > 3600_000) h.run('UPDATE keas_sessions SET last_seen = ? WHERE token_hash = ?', now(), s.token_hash);
        ctx.me = me; ctx.session = s;
      }
      if (req.method === 'POST') {
        const raw = (await readRaw(req, ctx.me ? MAX_BODY : PRE_AUTH_BODY)).toString('utf8');
        let body = {};
        if (raw.trim()) { try { body = JSON.parse(raw); } catch { bad('Invalid JSON.'); } }
        ctx.body = V.obj(body);
      }
      if (fileRoute) return await handleFile(req, res, ctx, decodeURIComponent(fileMatch[1]), t0);
      const out = await r.handler(ctx);
      if (out && out.__raw) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.__raw.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...out.headers });
        res.end(out.__raw);
        hlog.request(req.method, url.pathname, 200, Date.now() - t0);
        return;
      }
      if (out && 'body' in out && typeof out.status === 'number') { status = out.status; payload = out.body; } else payload = out;
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else if (req.destroyed && !req.complete) { hlog.request(req.method, url.pathname, 499, Date.now() - t0); return; }
      else { status = 500; payload = { error: 'Something went wrong on the KeaS server.' }; console.error(e); }
    }
    if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
    if (!req.complete) res.setHeader('connection', 'close');
    send(res, status, payload, status === 429 && payload?.retryAfter ? { 'retry-after': String(payload.retryAfter) } : {});
    hlog.request(req.method, url.pathname, status, Date.now() - t0);
  }

  // ---------- one member's files: GET (read), PUT (write, If-Match), DELETE ----------
  const SEGMENT = /^[\p{L}\p{N} ._()+@,'&!~-]{1,120}$/u;
  function checkPath(p) {
    if (p.length > 500) bad('That path is too long.');
    const parts = p.split('/');
    if (parts.length > 12 || parts.some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || s.trim() !== s || !plainDecoded(s))) bad('That file path has characters KeaS files don’t allow.');
    return parts.join('/');
  }
  function plainDecoded(seg) {
    let d = seg;
    if (seg.includes('~')) { try { d = seg.replace(/~([0-9a-f]+)~/g, (_, x) => String.fromCodePoint(parseInt(x, 16))); } catch { return false; } }
    if (!d || d === '.' || d === '..' || d.trim() === '') return false;
    if (/[\\/:\x00-\x1f\x7f]/.test(d)) return false;
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(d)) return false;
    return true;
  }
  const etagVersion = (v) => { const m = /^"?(\d+)"?$/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : null; };
  const reserved = new Map();
  async function handleFile(req, res, ctx, rawPath, t0) {
    const me = ctx.me;
    const done = (status, payload, headers = {}) => { send(res, status, payload, headers); hlog.request(req.method, '/v1/files/…', status, Date.now() - t0); };
    const path = checkPath(rawPath);
    if (req.method !== 'GET' && buckets.take(`wr:${me.id}`, L.writes[0], L.writes[1], Date.now()) > 0) throw new HttpError(429, 'Too many file changes at once. Slow down a little.', { retryAfter: 1 });
    const row = h.get('SELECT * FROM member_files WHERE account_id = ? AND path = ?', me.id, path);
    if (req.method === 'GET') {
      if (!row) notFound('No such file.');
      if (etagVersion(req.headers['if-none-match']) === row.version) { res.writeHead(304, { etag: `"${row.version}"` }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': row.size, etag: `"${row.version}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-kea-sha256': row.sha256 });
      await pipeline(createReadStream(blobPath(me.id, row.blob)), res);
      hlog.request(req.method, '/v1/files/…', 200, Date.now() - t0);
      return;
    }
    const conflict = () => { throw new HttpError(412, 'This file was changed on another device. Get the newest copy first.', { version: row?.version ?? null }); };
    const ifMatch = req.headers['if-match'];
    if (ifMatch != null && (ifMatch === '*' ? !row : etagVersion(ifMatch) !== row?.version)) conflict();
    if (req.headers['if-none-match'] === '*' && row) conflict();
    if (req.method === 'DELETE') {
      if (!row) notFound('No such file.');
      h.run('DELETE FROM member_files WHERE account_id = ? AND path = ?', me.id, path);
      await rmP(blobPath(me.id, row.blob), { force: true });
      return done(200, { ok: true });
    }
    const quota = quotaOf(me.id);
    const tooBig = `Files can be at most ${Math.round(maxFileBytes / 1024 ** 2)} MB.`;
    const declared = Number(req.headers['content-length']);
    const known = Number.isFinite(declared) && declared >= 0;
    if (known && declared > maxFileBytes) throw new HttpError(413, tooBig);
    if (!quota) throw new HttpError(507, 'Files on this KeaS server are for members of its organizations.', { storageFull: true, quota: 0 });
    if (!row && usage(me.id).n >= maxFilesPerAccount) throw new HttpError(507, `Your files here hold the most they can (${maxFilesPerAccount.toLocaleString('en-US')}). Delete some to add more.`, { storageFull: true, tooManyFiles: true });
    const mine = known ? declared : 0;
    const checkRoom = (size, before) => {
      const used = usage(me.id).used - before + ((reserved.get(me.id) || 0) - mine);
      if (used + size > quota && size > before) throw new HttpError(507, `Your files on this KeaS server are full (${Math.round(quota / 1024 ** 2)} MB, set by your organization). Delete some to make room.`, { used: usage(me.id).used, quota, storageFull: true });
    };
    checkRoom(mine, row?.size ?? 0);
    checkDisk(mine);
    reserved.set(me.id, (reserved.get(me.id) || 0) + mine);
    const dir = dirOf(me.id);
    const blob = randomUUID();
    const tmp = join(dir, `${blob}.tmp`);
    try {
      await mkdirP(dir, { recursive: true });
      const hasher = createHash('sha256');
      let size = 0;
      const meter = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; if (size > maxFileBytes) return cb(new HttpError(413, tooBig)); hasher.update(chunk); cb(null, chunk); } });
      await pipeline(req, meter, createWriteStream(tmp));
      checkRoom(size, row?.size ?? 0);
      await renameP(tmp, join(dir, blob));
      const version = (row?.version ?? 0) + 1;
      const hash = hasher.digest('hex');
      try {
        h.tx(() => {
          const cur = h.get('SELECT version, size FROM member_files WHERE account_id = ? AND path = ?', me.id, path);
          if ((cur?.version ?? 0) !== (row?.version ?? 0)) conflict();
          checkRoom(size, cur?.size ?? 0);
          h.run('INSERT INTO member_files (account_id,path,blob,size,version,sha256,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET blob=excluded.blob, size=excluded.size, version=excluded.version, sha256=excluded.sha256, updated_at=excluded.updated_at', me.id, path, blob, size, version, hash, now());
        });
      } catch (e) { await rmP(join(dir, blob), { force: true }); throw e; }
      if (row) await rmP(blobPath(me.id, row.blob), { force: true });
      return done(row ? 200 : 201, { path, version, size, sha256: hash }, { etag: `"${version}"` });
    } catch (e) { await rmP(tmp, { force: true }).catch(() => {}); throw e; }
    finally {
      const left = (reserved.get(me.id) || 0) - mine;
      if (left > 0) reserved.set(me.id, left); else reserved.delete(me.id);
    }
  }

  async function handleOwner(req, res) {
    let status = 200, payload, prove = null;
    try {
      const addr = req.socket.remoteAddress;
      if (!isLoopback(addr)) forbidden();
      if (req.headers.origin || req.headers['sec-fetch-site']) forbidden('The owner console takes no browser requests.');
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/owner/nonce') { send(res, 200, { nonce: nonces.issue(String(addr)) }); return; }
      const taken = nonces.take(req.headers[OWNER_AUTH_HEADER]);
      if (!taken) throw new HttpError(401, 'Owner sign-in required: answer a fresh challenge from /owner/nonce.');
      const raw = req.method === 'POST' ? await readRaw(req, MAX_BODY) : Buffer.alloc(0);
      const signKey = ownerKeyNow();
      if (!nonces.check(signKey, taken, req.method, req.url, raw)) throw new HttpError(401, 'Owner sign-in failed.');
      prove = (code, bytes) => ownerReplyMac(signKey, taken.nonce, req.headers[OWNER_CHALLENGE_HEADER], code, req.method, req.url, bytes);
      const { r, params } = own.find(req.method, url.pathname);
      let body = {};
      if (req.method === 'POST') { const text = raw.toString('utf8'); if (text.trim()) { try { body = JSON.parse(text); } catch { bad('Invalid JSON.'); } } body = V.obj(body); }
      payload = await r.handler({ params, body, query: Object.fromEntries(url.searchParams) });
      if (payload && payload.__raw) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.__raw.length, 'cache-control': 'no-store', ...payload.headers, [OWNER_REPLY_HEADER]: prove(200, payload.__raw) });
        res.end(payload.__raw);
        return;
      }
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; payload = { error: e.message, ...(e.extra || {}) }; }
      else { status = 500; payload = { error: 'internal error' }; console.error(e); }
    }
    if (prove) { const bytes = Buffer.from(JSON.stringify(payload ?? {})); res.writeHead(status, { ...HEADERS, [OWNER_REPLY_HEADER]: prove(status, bytes) }); res.end(bytes); return; }
    send(res, status, payload);
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'internal error' }); } catch {} });
  const apiServer = http.createServer({ maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 5000 }, wrap(handleApi));
  apiServer.maxConnections = 2000;
  apiServer.headersTimeout = 15_000; apiServer.requestTimeout = 300_000; apiServer.timeout = 60_000;
  const perAddress = new Map();
  apiServer.on('connection', (sock) => {
    const a = String(sock.remoteAddress || '');
    if (!isLoopback(a)) {
      const n = (perAddress.get(a) || 0) + 1;
      if (n > 50) { sock.destroy(); return; }
      perAddress.set(a, n);
      sock.once('close', () => { const k = (perAddress.get(a) || 1) - 1; if (k) perAddress.set(a, k); else perAddress.delete(a); });
    }
  });
  const ownerServer = http.createServer(wrap(handleOwner));
  ownerServer.headersTimeout = 15_000; ownerServer.requestTimeout = 120_000;
  const listenOn = (srv, port) => new Promise((resolveP, reject) => {
    const onError = (e) => { srv.off('listening', onListening); reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${port} on ${HOST} is already in use by another program, so the KeaS server can’t start. Close the other one (check with: netstat -ano | findstr :${port}) and start it again.`), { code: 'EADDRINUSE', port }) : e); };
    const onListening = () => { srv.off('error', onError); srv.on('error', (e) => console.error(`KeaS listener on port ${port}: ${e.message}`)); resolveP(srv.address().port); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, HOST);
  });
  const sweep = setInterval(() => { try { h.run('DELETE FROM keas_sessions WHERE expires_at <= ?', now()); } catch {} }, 3600_000);
  sweep.unref?.();
  if (keacStart) keac.start();

  return {
    h, serverId, identityKey, upgraded,
    keac,
    /** The org engine (org/index.mjs): payroll reads hours and pay codes from it, and publishes stubs to it. */
    get org() { return orgEngine; },
    get ownerKey() { return ownerKeyNow(); },
    /** The one-time setup code while nobody has claimed this server (shown in the KeaS app on this PC), else null. */
    get setupSecret() { return operatorId() ? null : setupSecret(); },
    async listen({ port = Number(process.env.KEA_HUB_PORT) || 4860, ownerPort = Number(process.env.KEA_HUB_OWNER_PORT) || 4861 } = {}) {
      const p = await listenOn(apiServer, port);
      try { return { port: p, ownerPort: await listenOn(ownerServer, ownerPort) }; }
      catch (e) { await new Promise((r) => apiServer.close(() => r())); throw e; }
    },
    log: hlog,
    close() {
      clearInterval(sweep);
      keac.stop();
      hlog.close();
      return Promise.all([apiServer, ownerServer].map((s) => new Promise((r) => { if (!s.listening) return r(); s.close(() => r()); s.closeAllConnections?.(); }))).then(() => h.close());
    },
  };
}

/**
 * The server for a data folder: the Kea Hub as KeaS 0.5 ran it while the folder still holds Kea accounts that haven't
 * moved to KeaC (hub/legacy/; mode 'legacy', with `status` saying so), otherwise the KeaS server (mode 'keas'; a moved
 * Hub folder is upgraded first). `legacy` options go to the Kea Hub only (its storage folder, Google client ids...).
 */
export async function openServer({ legacy = {}, ...opts } = {}) {
  const dataDir = opts.dataDir ?? DATA_DIR;
  if (folderState(dataDir) === 'legacy') {
    const { createHub: createLegacyHub } = await import('./legacy/index.mjs');
    const { now, ipHeader, limits, log, logFile, minFreeBytes } = opts;
    const hub = createLegacyHub({ dataDir, ...(now ? { now } : {}), ...(ipHeader !== undefined ? { ipHeader } : {}), ...(limits ? { limits } : {}), ...(log !== undefined ? { log } : {}), ...(logFile ? { logFile } : {}), ...(minFreeBytes !== undefined ? { minFreeBytes } : {}), ...legacy });
    return Object.assign(hub, { mode: 'legacy', status: LEGACY_MESSAGE, marker: MARKER });
  }
  return Object.assign(createHub(opts), { mode: 'keas', status: null });
}
export { folderState, readMarker, writeMarker, hubKeyOf, MARKER };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (existsSync(join(DATA_DIR, '.keas-lockdown-pending'))) {
    console.error('The KeaS server won’t start: KeaS found this data folder was open to other accounts and hasn’t finished checking it. Open KeaS to see what to clean up.');
    process.exit(3);
  }
  const hub = await openServer({ logFile: join(DATA_DIR, 'logs', 'hub.log'), log: false });
  for (const level of ['error', 'warn']) console[level] = (...a) => hub.log.line(`${new Date().toISOString()} ${level.toUpperCase()} ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')}`);
  let ports;
  try { ports = await hub.listen(); } catch (e) { console.error(e.message); await hub.close().catch(() => {}); process.exit(1); }
  const pidFile = join(DATA_DIR, 'hub.pid');
  try {
    rmSync(pidFile, { force: true });
    writeSecretFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) }));
    process.on('exit', () => { try { rmSync(pidFile, { force: true }); } catch {} });
  } catch (e) { console.error(`Couldn’t record the server’s process: ${e.message}`); }
  if (hub.mode === 'legacy') console.log(`${LEGACY_MESSAGE} (When they have: ${MARKER} in ${DATA_DIR}.)`);
  console.log(`KeaS server ${VERSION}${hub.serverId ? ` (id ${hub.serverId})` : ' (Kea Hub)'} on http://${HOST}:${ports.port} (tunnel this one). Owner console on http://${HOST}:${ports.ownerPort} (never tunnel this).`);
  if (hub.setupSecret) console.log(`Not set up yet. Setup code (for the KeaS app on this PC): ${hub.setupSecret}`);
  if (hub.upgraded) console.log(`Upgraded from KeaS 0.5: ${hub.upgraded.file}`);
}
