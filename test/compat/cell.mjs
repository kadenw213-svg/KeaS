// One cell of the cross-version compatibility matrix (test/compat/harness.mjs), run in a child process of its own so
// each (client version, server version) pair gets fresh module state:
//   node cell.mjs <spec.json> <result.json>
// The spec names the flow, the client (Kea PC or phone, at a folder: the working tree or an older release extracted
// from git) and the servers (KeaC and KeaS folders). Every server is a real one, started here in this process on
// 127.0.0.1 port 0 with scratch data; Google is a stand-in (our own RSA key). Nothing leaves this computer: fetch is
// fenced to loopback addresses, and the phone's native side maps its https address to the local KeaC.
// The same file is in Kea, KeaS and KeaC (test/compat/cell.mjs): keep them the same.
// (Run with no arguments, as `node --test` over every file would, it does nothing.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [specFile, outFile] = process.argv.slice(2);

// ---------- safety: loopback only ----------
const realFetch = globalThis.fetch;
function fenceFetch() {
  globalThis.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return Promise.reject(new Error(`compat: refused a request off this computer (${u.origin})`));
    return realFetch(input, init);
  };
}

// ---------- a stand-in Google ----------
const GOOGLE_CLIENT = 'kea-compat-test.apps.googleusercontent.com';
function fakeGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'compat-kid', alg: 'RS256', use: 'sig' };
  let n = 0;
  const token = (email, extra = {}) => {
    const t = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const h = enc({ alg: 'RS256', kid: 'compat-kid', typ: 'JWT' });
    const b = enc({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: `g-${email}`, email, email_verified: true, name: 'Compat Person', iat: t, exp: t + 3600, jti: `c${++n}-${crypto.randomUUID()}`, nonce: crypto.randomUUID(), ...extra });
    return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`;
  };
  return { token, keacOptions: { googleClientIds: [GOOGLE_CLIENT], googleKeyFn: async () => [jwk], microsoftClientIds: [], microsoftKeyFn: async () => [] } };
}

// ---------- steps ----------
function recorder() {
  const steps = [];
  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) });
      return detail;
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.stack || e?.message || e).slice(0, 2000), status: e?.status ?? null, data: e?.data ?? null });
      return undefined;
    }
  }
  const skip = (name, reason, observed) => steps.push({ name, skip: reason, ...(observed === undefined ? {} : { observed }) });
  const passed = (name) => steps.some((s) => s.name === name && s.ok);
  return { steps, step, skip, passed };
}
const check = (cond, msg, data) => {
  if (!cond) throw Object.assign(new Error(msg), { data: data ?? null });
};
const mkScratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `kea-compat-${label}-`));
const scratch = [];
const closers = [];

async function main(spec, out) {
  fenceFetch();
  process.env.KEAC_RELEASE_FEEDS = '0';
  process.env.KEAS_RELEASE_FEEDS = '0';
  const r = recorder();
  const google = fakeGoogle();
  const world = { spec, r, google };
  let fatal = null;
  try {
    await FLOWS[spec.flow](world);
  } catch (e) {
    fatal = String(e?.stack || e);
  }
  for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => {});
  fs.writeFileSync(out, JSON.stringify({ flow: spec.flow, steps: r.steps, fatal }, null, 1));
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  process.exit(0);
}

// ---------- servers ----------
async function startKeaC(world, opts = {}) {
  const dir = mkScratch('keac');
  scratch.push(dir);
  const { createKeaC } = await import(pathToFileURL(path.join(world.spec.keac.dir, 'server', 'index.mjs')).href);
  const keac = createKeaC({ dataDir: dir, log: false, minFreeBytes: 0, fileOverheadBytes: 0, ...world.google.keacOptions, ...opts });
  const p = await keac.listen({ port: 0, ownerPort: 0 });
  closers.push(() => keac.close());
  const base = `http://127.0.0.1:${p.port}`;
  return { keac, base, dir };
}
/** A request to a server: { status, body, headers }. */
async function call(base, method, p, { token, body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json ?? text, headers: r.headers };
}
const ok = (r, want = [200, 201]) => {
  check([].concat(want).includes(r.status), `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`, r.body);
  return r.body;
};
/** A new Kea account on KeaC the way every Kea signs in: Google's ID token, 404 needsAccount, the same token with the terms. */
async function keacAccount(world, base, email, headers = {}) {
  const idToken = world.google.token(email);
  const first = await call(base, 'POST', '/v1/auth/google', { body: { idToken }, headers });
  check(first.status === 404 && first.body?.needsAccount, `expected 404 needsAccount, got ${first.status} ${JSON.stringify(first.body)}`);
  const t = ok(await call(base, 'GET', '/v1/terms', { headers })).terms;
  const made = ok(await call(base, 'POST', '/v1/auth/google', { headers, body: { idToken, termsVersion: t.version, termsSections: t.sections.map((s) => s.id), age13: true, birthYear: 1990, name: 'Server Operator' } }));
  return { token: made.token, id: (made.account || made.me?.account || made.me)?.id, email };
}
/** KeaC's current signing key, as published at /v1/keys. */
async function keacKey(base) {
  const keys = ok(await call(base, 'GET', '/v1/keys')).keys;
  return keys.find((k) => k.status === 'current') || keys[0];
}
function verifyPass(pass, keys, serverId, accountId) {
  const [h, b, s] = String(pass).split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  const k = keys.find((x) => x.kid === head.kid);
  check(k, `the pass's key ${head.kid} isn't in KeaC's /v1/keys`);
  const key = crypto.createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' });
  check(crypto.verify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, 'base64url')), 'the pass signature does not check out');
  check(body.iss === 'kea' && body.aud === `keas:${serverId}` && body.ev === true, `pass claims ${JSON.stringify(body)}`);
  if (accountId) check(body.sub === accountId, `pass sub ${body.sub} is not ${accountId}`);
  return { kid: head.kid, aud: body.aud, ev: body.ev, lifetimeH: Math.round((body.exp - body.iat) / 3600) };
}
const randomServerId = () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return crypto.createHash('sha256').update(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).digest('base64url').slice(0, 22);
};

/** A KeaS that trusts this KeaC's key, claimed by an operator, with one organization and a member join code. */
async function startKeaS(world, keacBase, opts = {}) {
  const dir = mkScratch('keas');
  scratch.push(dir);
  const { createHub } = await import(pathToFileURL(path.join(world.spec.keas.dir, 'hub', 'index.mjs')).href);
  const { ownerFetch } = await import(pathToFileURL(path.join(world.spec.keas.dir, 'hub', 'lib', 'ownerauth.mjs')).href);
  const seen = [];
  const keacFetch = async (url, init = {}) => {
    const h = new Headers(init.headers || {});
    const r = await fetch(url, init);
    seen.push({ path: new URL(url).pathname, status: r.status, client: h.get('x-kea-client') });
    return r;
  };
  const key = await keacKey(keacBase);
  const hub = createHub({ dataDir: dir, log: false, minFreeBytes: 0, keacUrl: keacBase, keacKeys: [{ kty: key.kty, crv: key.crv, x: key.x, kid: key.kid, alg: key.alg || 'EdDSA', use: 'sig' }], keacFetch, ...opts });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  closers.push(() => hub.close());
  const base = `http://127.0.0.1:${p.port}`, ownerBase = `http://127.0.0.1:${p.ownerPort}`;
  const owner = async (method, pth, body) => {
    const x = await ownerFetch(ownerBase, hub.ownerKey, method, pth, body);
    return { status: x.status, body: await x.json() };
  };
  return { hub, base, ownerBase, owner, seen, dir };
}
async function orgOnKeaS(world, keacBase, S) {
  const op = await keacAccount(world, keacBase, `operator-${crypto.randomUUID().slice(0, 8)}@compat.test`);
  const { pass } = ok(await call(keacBase, 'POST', '/v1/pass', { token: op.token, body: { serverId: S.hub.serverId } }));
  const claim = ok(await S.owner('POST', '/owner/claim', { pass, secret: S.hub.setupSecret }));
  const opToken = claim.token;
  let org = ok(await call(S.base, 'POST', '/v1/orgs', { token: opToken, body: { name: 'Compat Pool', tz: 'America/Denver', state: 'CO' } })).org;
  if (org.status !== 'active') ok(await S.owner('POST', `/owner/orgs/${org.id}/decide`, { approve: true }));
  const code = ok(await call(S.base, 'POST', `/v1/orgs/${org.id}/codes`, { token: opToken, body: { role: 'member', needsApproval: false } })).code.code;
  return { org, code, opToken, link: `kea://join?s=${encodeURIComponent(S.base)}&c=${encodeURIComponent(code)}` };
}

// ---------- the PC client (electron/hub.cjs and friends, under Node) ----------
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } };
function loadPc(world) {
  const dir = world.spec.client.dir;
  const userData = mkScratch('pc');
  scratch.push(userData);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const handlers = {};
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
  const stub = {
    app: { getPath: () => userData, getVersion: () => version, getAppPath: () => dir, isPackaged: false, on() {}, exit() {}, whenReady: () => Promise.resolve(), getName: () => 'Kea' },
    ipcMain: { on() {}, handle: (n, f) => (handlers[n] = f), removeHandler() {} },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    Notification: class { static isSupported() { return false; } show() {} close() {} },
    dialog: deep(),
    session: deep(),
    net: { fetch: (...a) => globalThis.fetch(...a) },
    shell: { openExternal: async () => { throw new Error('compat: no browser'); }, showItemInFolder() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    webContents: deep(),
  };
  const id = path.join(userData, 'electron-stub.cjs');
  require_cache_put(id, stub);
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return id;
    return resolve.call(this, request, ...rest);
  };
  const req = createRequire(path.join(dir, 'electron', 'x.cjs'));
  const settings = req('./settings.cjs');
  settings.set({ 'hub.url': world.keacBase });
  process.env.KEA_HUB_URL = world.keacBase;
  const hub = req('./hub.cjs');
  const A = hub._account;
  A.setBackground(false);
  A.setLimits({ req: 8000, status: 4000 });
  return { hub, A, req, settings, handlers, userData, version };
}
function require_cache_put(id, exports) {
  const m = new Module(id);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  Module._cache[id] = m;
}
async function pcSignIn(world, pc, email) {
  pc.A.setIdTokens(async () => world.google.token(email));
  let first = null;
  try {
    first = await pc.A.oauthSignIn({ provider: 'google' });
  } catch (e) {
    if (!(e.status === 404 && e.data?.needsAccount)) throw e;
  }
  check(!first, 'a brand-new account signed in without the terms');
  const terms = (await pc.hub.req('GET', '/v1/terms', undefined, { auth: false })).terms;
  const s = await pc.A.continueSignIn({ termsVersion: terms.version, termsSections: terms.sections.map((x) => x.id), age13: true, name: 'Compat PC' });
  check(s.state === 'online' && s.signedIn, `state after sign-in: ${JSON.stringify({ state: s.state, signedIn: s.signedIn })}`);
  check(s.account?.email === email && s.account.linked, `account after sign-in: ${JSON.stringify(s.account)}`);
  return { state: s.state, id: s.me?.account?.id };
}

// ---------- the phone client (mobile/src bundled with esbuild, over a stand-in for Hub.java and Orgs.java) ----------
const PHONE_URL = 'https://keac.compat.test';
async function loadPhone(world, email) {
  const dir = world.spec.client.dir;
  const keaModules = path.join(world.spec.keaDir, 'node_modules');
  const esbuild = createRequire(path.join(world.spec.keaDir, 'package.json'))('esbuild');
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => void storage.set(k, String(v)), removeItem: (k) => void storage.delete(k), clear: () => storage.clear() };
  storage.set('kea.accountUrl', PHONE_URL);
  const native = fakePhoneNative(world, email);
  globalThis.__keaMock = native;
  const out = path.join(mkScratch('phone'), 'phone.cjs');
  scratch.push(path.dirname(out));
  const stub = { name: 'kea-stub', setup: (b) => { b.onResolve({ filter: /^\.\/kea$/ }, () => ({ path: 'kea', namespace: 'kea-stub' })); b.onLoad({ filter: /.*/, namespace: 'kea-stub' }, () => ({ contents: 'export const Kea = globalThis.__keaMock;', loader: 'js' })); } };
  await esbuild.build({
    stdin: { contents: "export * as A from './account'; export * as H from './hub'; export * as O from './orgs';", resolveDir: path.join(dir, 'mobile', 'src'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [stub], nodePaths: [keaModules],
    define: { 'import.meta.env': JSON.stringify({ VITE_KEA_GOOGLE_CLIENT_ID: GOOGLE_CLIENT, VITE_KEA_MICROSOFT_CLIENT_ID: '' }) },
  });
  const m = createRequire(import.meta.url)(out);
  return { ...m, native };
}
/** What Hub.java and Orgs.java do, with real fetch: the headers each sends, the session kept natively, never handed back. */
function fakePhoneNative(world, email) {
  const hubHeader = world.spec.client.phoneHeader?.hub ?? 'Kea for Android';
  const orgsHeader = world.spec.client.phoneHeader?.orgs ?? 'Kea for Android';
  const map = (u) => {
    const o = new URL(u).origin;
    if (o !== PHONE_URL) throw new Error(`compat: the phone only knows ${PHONE_URL}, not ${o}`);
    return world.keacBase;
  };
  const st = { url: '', token: '', email: '', accounts: '', listeners: { oauth: [] }, rec: new Map(), checked: new Map(), seen: [] };
  const http1 = async (base, method, p, body, token, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'x-kea': '1', 'x-kea-client': orgsHeader, accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body != null ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ?? undefined, signal: AbortSignal.timeout(8000) });
    return { status: r.status, body: await r.text() };
  };
  async function hubHttp(o) {
    if (!st.url) throw new Error('This copy of Kea has no Kea account address yet.');
    if (!String(o.path).startsWith('/v1/') || String(o.path).includes('..')) throw new Error('Not a Kea account address.');
    const headers = { 'x-kea-client': hubHeader };
    if (o.auth !== false && st.token) headers.authorization = `Bearer ${st.token}`;
    if (o.ifMatch) headers['if-match'] = `"${o.ifMatch}"`;
    if (o.ifNoneMatch) headers['if-none-match'] = '*';
    if (o.body != null && o.method !== 'GET') headers['content-type'] = o.contentType || 'application/json';
    const r = await fetch(map(st.url) + o.path, { method: o.method, headers, body: o.body != null && o.method !== 'GET' ? o.body : undefined, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    return { status: r.status, text: await r.text(), version: String(r.headers.get('etag') || '').replace(/"/g, '').trim() };
  }
  const k = (a, id) => `${a}|${id}`;
  const view = (e) => ({ serverId: e.serverId, url: e.url, name: e.name, joinedAt: e.joinedAt, signedOut: !!e.signedOut, message: e.message ?? null, passAt: e.passAt ?? null, passExp: e.passExp ?? null, hasPass: !!e.pass, hasToken: !!e.token });
  const native = {
    st,
    phoneHeader: { hub: hubHeader, orgs: orgsHeader },
    async hubState() { return { url: st.url, signedIn: !!st.token, email: st.email, root: os.tmpdir() }; },
    async hubSetUrl({ url }) {
      if (!st.url || new URL(url).origin !== new URL(st.url).origin) st.token = st.email = '';
      st.url = url;
    },
    async hubForget() { st.token = st.email = ''; },
    async hubRequest(o) {
      const r = await hubHttp(o);
      let text = r.text;
      if (o.keepToken && r.status >= 200 && r.status < 300) {
        try {
          const j = JSON.parse(text);
          if (j.token) {
            st.token = j.token;
            st.email = (j.account || j.me?.account || {}).email || '';
            delete j.token;
            text = JSON.stringify(j);
          }
        } catch {}
      }
      return { status: r.status, body: text, version: r.version };
    },
    async hubDownload() { return { status: 500, body: '{}' }; },
    async hubRemoveLocal() {},
    async accountsRead() { return { text: st.accounts }; },
    async accountsWrite({ text }) { st.accounts = text; },
    async addListener(ev, cb) { (st.listeners[ev] ||= []).push(cb); return { remove() {} }; },
    async takeOauth() { return {}; },
    async takeJoin() { return {}; },
    async oauthOpen({ url }) {
      const u = new URL(url);
      const back = `${u.searchParams.get('redirect_uri')}?code=compat-${Date.now()}&state=${encodeURIComponent(u.searchParams.get('state'))}`;
      setTimeout(() => st.listeners.oauth.forEach((cb) => cb({ url: back })), 5);
    },
    async oauthToken() { return { status: 200, body: JSON.stringify({ id_token: world.google.token(email) }) }; },
    // Orgs.java
    async orgList({ account }) { return { servers: [...st.rec.values()].filter((e) => e.account === account).map(view) }; },
    async orgIdentity({ url }) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const r = await http1(url, 'GET', `/v1/identity?nonce=${nonce}`);
      let verdict = 'bad';
      try {
        const a = JSON.parse(r.body);
        const raw = Buffer.from(a.publicKey.x, 'base64url');
        const id = crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 22);
        if (raw.length === 32 && id === a.serverId) {
          const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: a.publicKey.x }, format: 'jwk' });
          verdict = crypto.verify(null, Buffer.from(`kea-server-identity:${id}:${nonce}`), key, Buffer.from(a.sig, 'base64url')) ? 'ok' : 'bad';
          if (verdict === 'ok') st.checked.set(url, id);
        }
      } catch {}
      return { ...r, nonce, check: verdict };
    },
    async orgAdd({ account, url, serverId, name }) {
      if (st.checked.get(url) !== serverId) throw new Error('Kea hasn’t checked this server’s identity.');
      if (!st.rec.has(k(account, serverId))) st.rec.set(k(account, serverId), { account, url, serverId, name, joinedAt: Date.now() });
    },
    async orgUpdate({ account, serverId, ...patch }) {
      const e = st.rec.get(k(account, serverId));
      if (e) for (const key of ['name', 'signedOut', 'message']) if (key in patch) e[key] = patch[key];
    },
    async orgRemove({ account, serverId }) { st.rec.delete(k(account, serverId)); },
    async orgDropSession({ account, serverId }) { const e = st.rec.get(k(account, serverId)); if (e) delete e.token; },
    async orgFetchPass({ account, serverId }) {
      const e = st.rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      const r = await hubHttp({ method: 'POST', path: '/v1/pass', body: JSON.stringify({ serverId }), auth: true });
      if (r.status < 200 || r.status >= 300) return { status: r.status, body: r.text };
      const j = JSON.parse(r.text);
      const aud = JSON.parse(Buffer.from(String(j.pass).split('.')[1], 'base64url')).aud;
      if (aud !== `keas:${serverId}`) return { status: 502, body: JSON.stringify({ error: 'wrong', wrongAudience: true }) };
      const exp = j.exp < 1e12 ? j.exp * 1000 : j.exp;
      Object.assign(e, { pass: j.pass, passExp: exp, passAt: Date.now() });
      return { status: r.status, body: JSON.stringify({ exp }), exp };
    },
    async orgSignIn({ account, serverId }) {
      const e = st.rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      if (!e.pass) return { status: 401, body: '{"noPass":true}' };
      if (st.checked.get(e.url) !== serverId) return { status: 495, body: '{"identity":false}' };
      const r = await http1(e.url, 'POST', '/v1/auth/pass', JSON.stringify({ pass: e.pass }));
      if (r.status >= 200 && r.status < 300) {
        const j = JSON.parse(r.body);
        e.token = j.token;
        delete j.token;
        return { status: r.status, body: JSON.stringify(j) };
      }
      return r;
    },
    async orgRequest({ account, serverId, method, path: p, body }) {
      const e = st.rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      if (!e.token) return { status: 401, body: '{"noSession":true}' };
      return http1(e.url, method, p, method === 'GET' ? undefined : body, e.token);
    },
  };
  return native;
}
async function phoneSignIn(P) {
  await P.A.status();
  let first = null;
  try {
    first = await P.A.oauthSignIn({ provider: 'google' });
  } catch (e) {
    if (!(e.status === 404 && e.data?.needsAccount)) throw e;
  }
  check(!first, 'a brand-new account signed in without the terms');
  const terms = await P.A.currentTerms();
  const s = await P.A.continueSignIn({ termsVersion: terms.version, termsSections: terms.sections.map((x) => x.id), age13: true });
  check(s.state === 'online' && s.signedIn, `state after sign-in: ${JSON.stringify({ state: s.state, signedIn: s.signedIn })}`);
  return { state: s.state, header: P.native.phoneHeader.hub };
}

// ---------- the flows ----------
const has = (world, what) => world.spec.keac?.has?.[what] !== false;
const FLOWS = {
  /** Kea PC -> KeaC: sign-in, status and /v1/me, profile get and patch, a pass, Kea cloud files. */
  async 'pc-keac'(world) {
    const { r } = world;
    const K = await startKeaC(world);
    world.keacBase = K.base;
    const pc = loadPc(world);
    const email = 'pc-person@compat.test';
    await r.step('health', async () => {
      const h = ok(await call(K.base, 'GET', '/v1/health'));
      check(h.service === 'keac', `service ${h.service}`);
      const s = await pc.A.status();
      check(s.state === 'none', `state before sign-in ${s.state}`);
      return { version: h.version, protocol: h.protocol ?? null };
    });
    if (!(await r.step('sign-in', () => pcSignIn(world, pc, email)))) return;
    await r.step('status/me', async () => {
      const s = await pc.A.status();
      check(s.signedIn && s.state === 'online' && s.me?.account?.email === email, `status ${JSON.stringify({ state: s.state, signedIn: s.signedIn, me: s.me?.account })}`);
      const me = await pc.hub.req('GET', '/v1/me');
      check(me.account.email === email, 'GET /v1/me');
      return { client: `Kea/${pc.version}` };
    });
    await r.step('profile get', async () => {
      const me = await pc.hub.req('GET', '/v1/me');
      const p = pc.A.profileOf(me);
      check(typeof p.name === 'string' && p.name.length > 0, `profile ${JSON.stringify(p)}`);
      return p;
    });
    if (has(world, 'profilePatch')) {
      await r.step('profile patch', async () => {
        const s = await pc.A.saveProfile({ name: 'Compat Renamed', phone: '+15551234567', phoneShare: { orgs: true, classmates: false } });
        check(!s.profileQueued, 'the change was queued, not saved');
        const p = pc.A.profileOf(await pc.hub.req('GET', '/v1/me'));
        check(p.name === 'Compat Renamed' && p.phone === '+15551234567', `after PATCH: ${JSON.stringify(p)}`);
        return p;
      });
    } else {
      let observed;
      try {
        const s = await pc.A.saveProfile({ name: 'Compat Renamed' });
        observed = { queued: !!s.profileQueued };
      } catch (e) {
        observed = { status: e.status, error: e.message };
      }
      r.skip('profile patch', `KeaC ${world.spec.keac.label} has no PATCH /v1/me (name/phone profile came in 0.3.0)`, observed);
    }
    await r.step('pass', async () => {
      const serverId = randomServerId();
      const me = await pc.hub.req('GET', '/v1/me');
      const res = await pc.hub.req('POST', '/v1/pass', { serverId });
      check(typeof res.pass === 'string' && res.exp, `POST /v1/pass ${JSON.stringify(res).slice(0, 200)}`);
      return verifyPass(res.pass, ok(await call(K.base, 'GET', '/v1/keys')).keys, serverId, me.account.id);
    });
    await r.step('files sync', async () => {
      const root = pc.hub.syncRoot();
      const local = path.join(root, 'Documents', 'compat-from-pc.txt');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, 'written on the PC');
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(local, old, old);
      await pc.hub.startSync();
      const listed = async () => (await pc.hub.req('GET', '/v1/files?prefix=kea/')).files.map((f) => f.path);
      let paths = [];
      for (let i = 0; i < 20 && !paths.includes('kea/Documents/compat-from-pc.txt'); i++) {
        await pc.hub.syncNow();
        paths = await listed();
        if (!paths.includes('kea/Documents/compat-from-pc.txt')) await new Promise((res) => setTimeout(res, 250));
      }
      check(paths.includes('kea/Documents/compat-from-pc.txt'), `put+list: not on the server after sync (${paths.join(', ')}; ${JSON.stringify(pc.hub.syncState())})`);
      const got = await call(K.base, 'GET', '/v1/files/kea/Documents/compat-from-pc.txt', { token: pc.hub._token() });
      check(got.status === 200 && got.body === 'written on the PC', `server copy ${got.status}`);
      // Another device puts a file; the next sync brings it here (get).
      ok(await call(K.base, 'PUT', '/v1/files/kea/Documents/compat-from-web.txt', { token: pc.hub._token(), body: 'from another device', headers: { 'content-type': 'application/octet-stream', 'x-kea': '1' } }));
      const down = path.join(root, 'Documents', 'compat-from-web.txt');
      for (let i = 0; i < 20 && !fs.existsSync(down); i++) {
        await pc.hub.syncNow();
        if (!fs.existsSync(down)) await new Promise((res) => setTimeout(res, 250));
      }
      check(fs.existsSync(down) && fs.readFileSync(down, 'utf8') === 'from another device', `get: the other device's file didn't come down (${JSON.stringify(pc.hub.syncState())})`);
      return { listed: paths.length, counts: pc.hub.syncState().counts };
    });
  },

  /** Kea phone -> KeaC: sign-in, status, profile get and patch, Kea cloud files list and put. */
  async 'phone-keac'(world) {
    const { r } = world;
    const K = await startKeaC(world);
    world.keacBase = K.base;
    const email = 'phone-person@compat.test';
    const P = await loadPhone(world, email);
    await r.step('health', async () => {
      const s = await P.A.status();
      check(s.state === 'none', `state before sign-in ${s.state}`);
      const h = await P.A.serverHealth();
      check(h?.service === 'keac', `health ${JSON.stringify(h)}`);
      return { version: h.version, protocol: h.protocol ?? null };
    });
    if (!(await r.step('sign-in', () => phoneSignIn(P)))) return;
    await r.step('status/me', async () => {
      const s = await P.A.status();
      check(s.state === 'online' && s.signedIn && s.account?.email === email && s.account.linked, `status ${JSON.stringify({ state: s.state, account: s.account })}`);
      const me = await P.H.hubMe();
      check(typeof me.name === 'string', `hubMe ${JSON.stringify(me)}`);
      return { header: P.native.phoneHeader.hub };
    });
    await r.step('profile get', async () => {
      const p = await P.A.profile();
      check(p && typeof p.name === 'string', `profile ${JSON.stringify(p)}`);
      return p;
    });
    if (has(world, 'profilePatch')) {
      await r.step('profile patch', async () => {
        const s = await P.A.saveProfile({ name: 'Phone Renamed', phone: '+15557654321', phoneShare: { orgs: true, classmates: false } });
        check(!s.queued, 'the change was queued, not saved');
        const me = JSON.parse((await P.native.hubRequest({ method: 'GET', path: '/v1/me', auth: true })).body);
        const p = { name: me.name ?? me.account?.displayName, phone: me.phone ?? null };
        check(p.name === 'Phone Renamed' && p.phone === '+15557654321', `after PATCH: ${JSON.stringify(p)}`);
        return p;
      });
    } else {
      let observed;
      try {
        const s = await P.A.saveProfile({ name: 'Phone Renamed' });
        observed = { queued: s.queued };
      } catch (e) {
        observed = { status: e.status, error: e.message };
      }
      r.skip('profile patch', `KeaC ${world.spec.keac.label} has no PATCH /v1/me (name/phone profile came in 0.3.0)`, observed);
    }
    await r.step('files list/put', async () => {
      // The PC's classes in Kea cloud (put there as the PC would), then the phone's own calls: list, read, put.
      const data = JSON.stringify({ compat: true, at: Date.now() });
      const seed = await P.native.hubRequest({ method: 'PUT', path: '/v1/files/kea/Kea/Compat/kea-data.json', body: data, contentType: 'application/octet-stream', auth: true, ifNoneMatch: true });
      check(seed.status < 300, `seeding kea-data.json: ${seed.status} ${seed.body}`);
      const folder = await P.H.hubPickFolder();
      check(folder === 'Compat', `list: picked folder ${JSON.stringify(folder)}`);
      const read = await P.H.hubReadData(true);
      check(read === data, 'get: kea-data.json text differs');
      const sent = await P.H.hubPushPhone(JSON.stringify({ phone: 'compat' }));
      check(sent === true, 'put: phone.json not sent');
      const back = await P.native.hubRequest({ method: 'GET', path: '/v1/files/kea/Kea/Compat/phone.json', auth: true });
      check(back.status === 200 && JSON.parse(back.body).phone === 'compat', `phone.json on the server: ${back.status}`);
      return { folder };
    });
  },

  /** Kea PC -> KeaS (through a real KeaC): pass, join with a code, clock in; KeaS -> KeaC: keys, revocations, passes. */
  async 'pc-keas'(world) {
    const { r } = world;
    const K = await startKeaC(world);
    world.keacBase = K.base;
    const S = await startKeaS(world, K.base);
    const o = await r.step('keas setup (claim with a KeaC pass, org, join code)', () => orgOnKeaS(world, K.base, S));
    if (!o) return;
    const pc = loadPc(world);
    if (!(await r.step('sign-in', () => pcSignIn(world, pc, 'pc-member@compat.test')))) return;
    const servers = pc.req('./servers.cjs');
    const hubOrg = pc.req('./hubOrg.cjs');
    hubOrg.register();
    const handle = (n, a) => pc.handlers[n](APP, a);
    const joined = await r.step('pass + join', async () => {
      // (servers:join is what the page calls: identity, POST /v1/pass to KeaC, POST /v1/auth/pass, POST /v1/orgs/join.)
      const res = await servers.store().join(o.link);
      check(res.org?.id === o.org.id || res.org?.name === 'Compat Pool', `join: ${JSON.stringify(res).slice(0, 300)}`);
      check(res.server?.serverId === S.hub.serverId, 'joined server id');
      return { org: res.org?.name, role: res.org?.role ?? null };
    });
    if (joined) {
      await r.step('org list', async () => {
        const res = await handle('hubOrg:call', { method: 'GET', path: '/v1/orgs' });
        check(res.ok, `hubOrg:call GET /v1/orgs: ${res.error}`);
        const org = (res.value.orgs || []).find((x) => x.id === o.org.id);
        check(org, `org not listed: ${JSON.stringify(res.value).slice(0, 300)}`);
        return { src: org.src ?? null };
      });
      await r.step('clock in', async () => {
        const res = await handle('hubOrg:call', { method: 'POST', path: `/v1/orgs/${o.org.id}/clock`, body: { type: 'in' } });
        check(res.ok && res.value?.punch?.type === 'in', `clock in: ${JSON.stringify(res).slice(0, 400)}`);
        return { punch: res.value.punch.type };
      });
    }
    await keasTrustsKeac(world, S);
  },

  /** Kea phone -> KeaS (through a real KeaC): pass, join with a code, clock in. */
  async 'phone-keas'(world) {
    const { r } = world;
    const K = await startKeaC(world);
    world.keacBase = K.base;
    const S = await startKeaS(world, K.base);
    const o = await r.step('keas setup (claim with a KeaC pass, org, join code)', () => orgOnKeaS(world, K.base, S));
    if (!o) return;
    const P = await loadPhone(world, 'phone-member@compat.test');
    if (!(await r.step('sign-in', () => phoneSignIn(P)))) return;
    await P.O.workAccount();
    const joined = await r.step('pass + join', async () => {
      const res = await P.O.work.join(o.link);
      check(res.org?.id === o.org.id || res.org?.name === 'Compat Pool', `join: ${JSON.stringify(res).slice(0, 300)}`);
      return { org: res.org?.name };
    });
    if (joined) {
      await r.step('org list', async () => {
        const res = await P.O.work.orgs();
        const org = res.orgs.find((x) => x.id === o.org.id);
        check(org, `org not listed: ${JSON.stringify(res).slice(0, 300)}`);
        return { src: org.src === S.hub.serverId ? 'keas' : org.src };
      });
      await r.step('clock in', async () => {
        const res = await P.O.work.clock(o.org.id, 'in');
        check(res?.punch?.type === 'in', `clock in: ${JSON.stringify(res).slice(0, 400)}`);
        return { punch: res.punch.type };
      });
    }
    await keasTrustsKeac(world, S);
  },

  /** The version contract (protocol 1) on the CURRENT servers; see harness.mjs PROTOCOL_CHECKS. */
  async protocol(world) {
    await protocolChecks(world);
  },
};

/** KeaS -> KeaC: it fetched KeaC's /v1/keys and /v1/revoked (and took them), and took the passes KeaC made. */
async function keasTrustsKeac(world, S) {
  const { r } = world;
  await r.step('keas: /v1/keys from keac', async () => {
    if (typeof S.hub.keac?.refreshKeys === 'function') await S.hub.keac.refreshKeys();
    const got = S.seen.filter((x) => x.path === '/v1/keys');
    check(got.length && got.every((x) => x.status === 200), `KeaS's /v1/keys requests: ${JSON.stringify(got)}`);
    const st = S.hub.keac?.status?.() || {};
    check(!st.keysError, `keysError: ${st.keysError}`);
    return { requests: got.length, client: got.at(-1).client };
  });
  await r.step('keas: /v1/revoked from keac', async () => {
    if (typeof S.hub.keac?.tick === 'function') await S.hub.keac.tick();
    const got = S.seen.filter((x) => x.path === '/v1/revoked');
    check(got.length && got.every((x) => x.status === 200), `KeaS's /v1/revoked requests: ${JSON.stringify(got)}`);
    return { requests: got.length };
  });
  if (!world.r.passed('pass + join')) world.r.skip('keas: accepts keac pass', 'the join step failed, so this cell could not show it');
  else world.r.steps.push({ name: 'keas: accepts keac pass', ok: true, detail: 'POST /v1/auth/pass with a pass from KeaC POST /v1/pass made a KeaS session (the join above)' });
}

// ---------- the protocol contract (current servers only) ----------
const SEMVER = /^\d+\.\d+\.\d+$/;
function healthContract(h, server) {
  check(h.protocol === 1, `${server} /v1/health protocol: ${JSON.stringify(h.protocol)}`, h);
  for (const k of ['kea', 'keaPhone', 'keas']) check(typeof h.minClients?.[k] === 'string' && SEMVER.test(h.minClients[k]), `${server} minClients.${k}: ${JSON.stringify(h.minClients)}`, h);
  for (const k of ['kea', 'keas']) check(h.latest && (h.latest[k] === null || (typeof h.latest[k] === 'string' && SEMVER.test(h.latest[k]))), `${server} latest.${k}: ${JSON.stringify(h.latest)}`, h);
  for (const k of ['kea', 'keaPhone', 'keas']) check(typeof h.updateUrls?.[k] === 'string' && /^https:\/\//.test(h.updateUrls[k]), `${server} updateUrls.${k}: ${JSON.stringify(h.updateUrls)}`, h);
  return { protocol: h.protocol, minClients: h.minClients, latest: h.latest };
}
function is426(res, app, minVersion, error) {
  check(res.status === 426, `expected 426, got ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`, res.body);
  const b = res.body;
  check(b.upgradeRequired === true && b.app === app && b.minVersion === minVersion && typeof b.updateUrl === 'string' && b.updateUrl.startsWith('https://'), `426 body ${JSON.stringify(b)}`, b);
  if (error) check(b.error === error, `426 error ${JSON.stringify(b.error)}, wanted ${JSON.stringify(error)}`, b);
  return b;
}
async function protocolChecks(world) {
  const { r, spec } = world;
  const pcVersion = JSON.parse(fs.readFileSync(path.join(spec.client.dir, 'package.json'), 'utf8')).version;
  const keasVersion = JSON.parse(fs.readFileSync(path.join(spec.keas.dir, 'package.json'), 'utf8')).version;
  const HIGH = '99.0.0';
  // 1. Health on both current servers.
  {
    const K = await startKeaC(world);
    world.keacBase = K.base;
    await r.step('keac health contract', async () => healthContract(ok(await call(K.base, 'GET', '/v1/health')), 'KeaC'));
    const S = await startKeaS(world, K.base);
    await r.step('keas health contract', async () => healthContract(ok(await call(S.base, 'GET', '/v1/health')), 'KeaS'));
    await r.step('keas sends KeaS/<version> to keac', async () => {
      if (typeof S.hub.keac?.refreshKeys === 'function') await S.hub.keac.refreshKeys();
      const c = S.seen.map((x) => x.client);
      check(c.length && c.every((x) => x === `KeaS/${keasVersion}`), `x-kea-client KeaS sent to KeaC: ${JSON.stringify(c)}`);
      return c[0];
    });
    // The current PC client, no minimums raised: works, and says Kea/<version>.
    const pc = loadPc(world);
    await r.step('equal or newer client works (default minimums)', async () => {
      await pcSignIn(world, pc, 'proto-ok@compat.test');
      const s = await pc.A.status();
      check(s.signedIn, 'not signed in');
      return { client: `Kea/${pcVersion}` };
    });
  }
  // 2. KeaC with every minimum raised: too-old apps get 426; no header, an unversioned one and /v1/health still work.
  {
    const K = await startKeaC(world, { minClients: { kea: HIGH, keaPhone: HIGH, keas: HIGH } });
    await r.step('keac 426: Kea PC too old (raw)', async () => is426(await call(K.base, 'GET', '/v1/terms', { headers: { 'x-kea-client': `Kea/${pcVersion}` } }), 'kea', HIGH, 'Update Kea to keep using your Kea account.'));
    await r.step('keac 426: Kea phone too old (raw)', async () => is426(await call(K.base, 'GET', '/v1/terms', { headers: { 'x-kea-client': `Kea-Phone/${pcVersion}` } }), 'keaPhone', HIGH));
    await r.step('keac 426: KeaS too old (raw)', async () => is426(await call(K.base, 'GET', '/v1/keys', { headers: { 'x-kea-client': `KeaS/${keasVersion}` } }), 'keas', HIGH, 'Update KeaS to keep signing people in with their Kea accounts.'));
    await r.step('keac /v1/health never 426', async () => {
      const h = await call(K.base, 'GET', '/v1/health', { headers: { 'x-kea-client': `Kea/${pcVersion}` } });
      check(h.status === 200, `health ${h.status}`);
      check(h.body.minClients?.kea === HIGH, `minClients.kea ${JSON.stringify(h.body.minClients)}`);
    });
    await r.step('keac: no header works (account made, signed in, /v1/me)', async () => {
      const a = await keacAccount(world, K.base, 'proto-noheader@compat.test');
      ok(await call(K.base, 'GET', '/v1/me', { token: a.token }));
      ok(await call(K.base, 'GET', '/v1/keys'));
    });
    await r.step('keac: unversioned "Kea for Android" works', async () => {
      const a = await keacAccount(world, K.base, 'proto-oldphone@compat.test', { 'x-kea-client': 'Kea for Android' });
      ok(await call(K.base, 'GET', '/v1/me', { token: a.token, headers: { 'x-kea-client': 'Kea for Android' } }));
    });
    world.keacBase = K.base;
    const pc = loadPc(world);
    await r.step('keac 426: current Kea PC client (hub.cjs) sees upgradeRequired', async () => {
      pc.A.setIdTokens(async () => world.google.token('proto-old@compat.test'));
      let err = null;
      try {
        await pc.A.oauthSignIn({ provider: 'google' });
      } catch (e) {
        err = e;
      }
      check(err && err.status === 426 && err.data?.upgradeRequired === true && err.data.app === 'kea', `sign-in error: ${JSON.stringify({ status: err?.status, data: err?.data, message: err?.message })}`);
      check(err.message === 'Update Kea to keep using your Kea account.', `message ${err.message}`);
      return { status: err.status, minVersion: err.data.minVersion };
    });
    // The current phone: 426 when it says its version (Kea-Phone/<v>), works as before when it doesn't.
    const P = await loadPhone(world, 'proto-phone@compat.test');
    await r.step('keac: current phone client vs raised keaPhone minimum', async () => {
      const header = P.native.phoneHeader.hub;
      const versioned = /^Kea-Phone\//.test(header);
      let err = null, s = null;
      try {
        s = await phoneSignIn(P);
      } catch (e) {
        err = e;
      }
      if (versioned) check(err && err.status === 426 && err.data?.upgradeRequired === true && err.data.app === 'keaPhone', `phone (${header}) should get 426: ${JSON.stringify({ status: err?.status, data: err?.data, s })}`);
      else check(!err && s, `phone (${header}, unversioned) should work as before: ${err?.message}`);
      return { header, outcome: err ? err.status : 'signed in' };
    });
    await r.step('phone sends Kea-Phone/<version>', async () => {
      check(/^Kea-Phone\/\d+\.\d+\.\d+$/.test(P.native.phoneHeader.hub) && /^Kea-Phone\/\d+\.\d+\.\d+$/.test(P.native.phoneHeader.orgs), `Hub.java/Orgs.java send ${JSON.stringify(P.native.phoneHeader)}`);
      return P.native.phoneHeader;
    });
  }
  // 3. The minimum itself is fine (not "below").
  {
    const K = await startKeaC(world, { minClients: { kea: pcVersion } });
    await r.step('keac: client at exactly minClients works', async () => {
      const t = await call(K.base, 'GET', '/v1/terms', { headers: { 'x-kea-client': `Kea/${pcVersion}` } });
      check(t.status === 200, `GET /v1/terms ${t.status}`);
    });
  }
  // 4. KeaS with raised minimums.
  {
    const K = await startKeaC(world);
    const S = await startKeaS(world, K.base, { minClients: { kea: HIGH, keaPhone: HIGH } });
    await r.step('keas 426: Kea PC too old (raw)', async () => is426(await call(S.base, 'GET', `/v1/identity?nonce=${crypto.randomBytes(16).toString('hex')}`, { headers: { 'x-kea-client': `Kea/${pcVersion}` } }), 'kea', HIGH, 'Update Kea to keep using this organization’s server.'));
    await r.step('keas 426: Kea phone too old (raw)', async () => is426(await call(S.base, 'GET', `/v1/identity?nonce=${crypto.randomBytes(16).toString('hex')}`, { headers: { 'x-kea-client': `Kea-Phone/${pcVersion}` } }), 'keaPhone', HIGH));
    await r.step('keas /v1/health never 426', async () => {
      const h = await call(S.base, 'GET', '/v1/health', { headers: { 'x-kea-client': `Kea/${pcVersion}` } });
      check(h.status === 200 && h.body.minClients?.kea === HIGH, `health ${h.status} ${JSON.stringify(h.body.minClients)}`);
    });
    await r.step('keas: no header and unversioned work (identity, pass sign-in)', async () => {
      ok(await call(S.base, 'GET', `/v1/identity?nonce=${crypto.randomBytes(16).toString('hex')}`));
      ok(await call(S.base, 'GET', `/v1/identity?nonce=${crypto.randomBytes(16).toString('hex')}`, { headers: { 'x-kea-client': 'Kea for Android' } }));
      const a = await keacAccount(world, K.base, 'proto-keas@compat.test');
      const { pass } = ok(await call(K.base, 'POST', '/v1/pass', { token: a.token, body: { serverId: S.hub.serverId } }));
      ok(await call(S.base, 'POST', '/v1/auth/pass', { body: { pass } }));
    });
    // The current PC's server code (serversCore.cjs): 426 when it says Kea/<v>, works when it says nothing.
    world.keacBase = K.base;
    const o = await orgOnKeaS(world, K.base, S);
    const pc = loadPc(world);
    await pcSignIn(world, pc, 'proto-pc-keas@compat.test');
    await r.step('keas: current Kea PC client (serversCore) vs raised kea minimum', async () => {
      const src = fs.readFileSync(path.join(spec.client.dir, 'electron', 'serversCore.cjs'), 'utf8');
      const sends = /x-kea-client/.test(src);
      let err = null, res = null;
      try {
        res = await pc.req('./servers.cjs').store().join(o.link);
      } catch (e) {
        err = e;
      }
      if (sends) check(err && err.status === 426 && err.data?.upgradeRequired === true, `serversCore sends x-kea-client, so join should get 426: ${JSON.stringify({ status: err?.status, data: err?.data, message: err?.message })}`);
      else check(!err && res?.org, `serversCore sends no x-kea-client, so join should work as before: ${err?.message}`);
      return { sendsHeader: sends, outcome: err ? err.status : 'joined' };
    });
  }
}

export { FLOWS };

// (Last, so everything above is defined.)
if (specFile && outFile) await main(JSON.parse(fs.readFileSync(specFile, 'utf8')), outFile);
