// Setting up and signing in to the payroll vault: the payroll admin's Kea Hub account plus the vault passphrase, which
// unlocks the encrypted data for this run of the server.
//
// - The Kea Hub is the one the KeaS app on this computer names (c.defaultHubUrl), never one a request names, and its
//   signing key is pinned at setup (see hub.mjs). The owner accepts a new key in the KeaS app only (c.repinHub).
// - A local password is a fallback for when that Hub can't be reached. It is off unless the owner turns it on in the
//   KeaS app on this computer (c.localSignIn()), needs a long passphrase-style password, works only while the Hub
//   really can't be reached, and is rate-limited per account.
// - Wrong tries are counted per account and per address, never for everyone at once: someone else's wrong guesses
//   can't lock out a payroll admin who signs in at the Hub (password and two-step code) with the right passphrase.
//   The counts are kept in the vault's database, so restarting the vault doesn't reset them.
// - The vault locks itself (key wiped from memory, everyone signed out) after a quiet spell (15 minutes unless the
//   settings say otherwise), and a sign-in lasts 2 hours at most.
import { timingSafeEqual, createHash } from 'node:crypto';
import { hashLocalPassword, checkLocalPassword } from '../lib/vault.mjs';
import { byName } from '../db.mjs';
import { HubUnreachable, HubRefused, ISSUER, KEY_CHANGED, keyFingerprint } from './hub.mjs';
import { addDays, weekStartOf } from '../lib/time.mjs';

/** Where wrong-try counts live: in memory (tests), or a table (the vault: survives restarts). */
export function memoryLimitStore() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, e) => m.set(k, { ...e }), del: (k) => m.delete(k), size: () => m.size, prune(before) { for (const [k, e] of m) if (e.until <= before && e.at < before) m.delete(k); } };
}
export function dbLimitStore(h) {
  return {
    get: (k) => h.get('SELECT n, until, at FROM vault_limits WHERE k = ?', k) ?? undefined,
    set: (k, e) => h.run('INSERT INTO vault_limits (k, n, until, at) VALUES (?,?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, until = excluded.until, at = excluded.at', k, e.n, e.until, e.at),
    del: (k) => h.run('DELETE FROM vault_limits WHERE k = ?', k),
    size: () => h.get('SELECT COUNT(*) AS n FROM vault_limits').n,
    prune: (before) => h.run('DELETE FROM vault_limits WHERE until <= ? AND at < ?', before, before),
  };
}

/** Wrong-try counting by key ('acct:<email>', 'ip:<address>', 'user:<id>'): 5 free, then a doubling wait up to 15 minutes. */
export function makeLimiter({ now, free = 5, baseMs = 30_000, capMs = 15 * 60_000, maxKeys = 10_000, store = memoryLimitStore() }) {
  return {
    /** Milliseconds to wait before this key may try again (0: go ahead). */
    wait(key) { const e = key && store.get(key); return e && e.until > now() ? e.until - now() : 0; },
    fail(key) {
      if (!key) return;
      if (store.size() >= maxKeys) store.prune(now() - capMs);
      const e = store.get(key) || { n: 0, until: 0, at: 0 };
      const next = { n: e.n + 1, until: e.until, at: now() };
      if (next.n >= free) next.until = now() + Math.min(capMs, baseMs * 2 ** (next.n - free));
      store.set(key, next);
    },
    clear(key) { if (key) store.del(key); },
  };
}

export const IDLE_LOCK_DEFAULT_MIN = 15;
export const IDLE_LOCK_MAX_MIN = 120;

/** A local password strong enough to stand in for a Hub sign-in with two-step codes: a passphrase, not a word. */
export function checkLocalStrength(pw, { email, passphrase } = {}) {
  const s = String(pw ?? '');
  if (s.length < 16) return 'The local password needs at least 16 characters. A few unrelated words work well.';
  if (s.length > 300) return 'The local password can be 300 characters at most.';
  if (new Set(s.toLowerCase()).size < 8) return 'The local password repeats too few different characters.';
  const low = s.toLowerCase();
  if (email && low.includes(String(email).toLowerCase().split('@')[0])) return 'The local password can’t contain your email name.';
  if (passphrase && s === passphrase) return 'The local password can’t be the vault passphrase.';
  return null;
}

const LOCAL_OFF = 'Signing in with a local password is turned off. The owner can turn it on in the KeaS app on this computer (Payroll, Advanced).';
const VERIFY_EMAIL = 'Verify your email address in your Kea account first (in the Kea app: Kea account, Verify with Google), then open Payroll again.';
const CODE_NEEDED = 'Enter the two-step code from your authenticator app.';
const CODE_USED = 'That two-step code was already used or has expired. Wait for the next one and try again.';
const LOCAL_HUB_UP ='The Kea Hub can be reached, so sign in with your Kea Hub account. A local password only works while the Hub can’t be reached.';
const isLoopback = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export function registerVaultAuth(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, hub, now, iso } = c;
  const hubUrl = () => c.defaultHubUrl || null;
  const localOn = () => !!c.localSignIn();
  const pin = () => vault.setting('hubPin', null);
  const limiter = makeLimiter({ now, store: c.mode === 'vault' ? dbLimitStore(h) : memoryLimitStore() });

  // Locks the vault when nobody has used it for a while: the key is wiped from memory and every sign-in ends.
  // (Requests a page makes by itself, marked X-KeaS-Background, don't count as use.)
  let lastUse = now();
  const idleMinutes = () => Math.min(IDLE_LOCK_MAX_MIN, Math.max(1, Number(vault.setting('idleLockMinutes', IDLE_LOCK_DEFAULT_MIN)) || IDLE_LOCK_DEFAULT_MIN));
  c.touchVault = () => { lastUse = now(); };
  c.lockVault = (why) => {
    if (!vault.unlocked()) return false;
    const orgId = h.get('SELECT id FROM orgs LIMIT 1')?.id ?? null;
    audit(orgId, 'keas', 'vault_lock', null, { why });
    h.run('DELETE FROM sessions');
    vault.lock();
    c.onVaultLock?.(why);
    return true;
  };
  c.checkIdle = () => {
    if (c.mode !== 'vault' || !vault.unlocked()) return false;
    return now() - lastUse >= idleMinutes() * 60_000 ? c.lockVault('idle') : false;
  };
  if (c.mode === 'vault') {
    const t = setInterval(() => { try { c.checkIdle(); } catch {} }, 15_000);
    t.unref?.();
    c.onClose.push(() => clearInterval(t));
  }
  const guard = (...keys) => {
    const ms = Math.max(0, ...keys.map((k) => limiter.wait(k)));
    if (ms) throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil(ms / 1000)} seconds.`);
  };
  // Per-address counting only means something for other machines: everything on this PC shares 127.0.0.1.
  const ipKey = (ip) => (isLoopback(ip) ? null : `ip:${ip}`);
  const WRONG = 'Wrong email, password or vault passphrase.';

  route('GET', '/v1/vault/status', () => ({
    mode: c.mode, initialized: vault.initialized(), locked: !vault.unlocked(), hubUrl: hubUrl(),
    org: vault.initialized() ? h.get('SELECT name FROM orgs LIMIT 1')?.name ?? null : null,
    localSignIn: localOn(),
    localAccounts: localOn() && !!h.get('SELECT 1 FROM vault_users WHERE local_pw IS NOT NULL'),
    hubKeyPinned: !!pin(),
  }), { auth: false, open: true });

  /** The Hub sign-in as an HTTP error the page understands. */
  function hubError(e, user) {
    if (e instanceof HubUnreachable) return new HttpError(503, e.message, { hubUnreachable: true, localAvailable: localOn() && !!user?.local_pw });
    if (e instanceof HubRefused) return new HttpError(e.status === 429 ? 429 : e.status === 401 || e.status === 403 ? 401 : 400, e.extra?.hubKeyChanged ? e.message : e.status === 401 || e.status === 403 ? WRONG : e.message, { hub: true, ...(e.extra || {}) });
    return e;
  }
  /** Pins the Hub's key the first time (a vault set up before keys were pinned trusts the KeaS app's own Hub once). */
  const savePin = (keys) => vault.setSetting('hubPin', { url: hubUrl(), iss: ISSUER, keys: keys.map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid ?? null })), at: iso(now()) });

  /** Checks the person at the Hub; returns the vault user row, or null when it isn't them. */
  async function identifyAtHub(user, { email, password, code }) {
    let who;
    try { who = await hub.signIn(hubUrl(), { email, password, code }, { pin: pin(), trust: c.hubTrustKeys?.() }); }
    catch (e) {
      // The password was right but the Hub wants a code (or the code was used up): say which, instead of "wrong".
      if (e instanceof HubRefused && e.extra?.totpRequired) throw new HttpError(401, code ? CODE_USED : CODE_NEEDED, { totpRequired: true });
      if (e instanceof HubRefused && (e.status === 401 || e.status === 403) && !e.extra?.hubKeyChanged) return null;
      throw hubError(e, user);
    }
    if (!user || who.email !== user.email || (user.hub_sub && user.hub_sub !== who.sub)) return null;
    if (!user.hub_sub) {
      // Linking an account for the first time: only one whose email the Hub has verified.
      if (!who.emailVerified) throw new HttpError(403, 'Verify your email address in your Kea Hub account first, then sign in here.');
      h.run('UPDATE vault_users SET hub_sub = ? WHERE id = ?', who.sub, user.id);
    }
    if (!pin()) savePin(who.keys);
    return user;
  }

  // Setting up: only from the KeaS app's own payroll window, which got the one-time token when the app started this
  // server. Anything else on this PC that finds the port before the owner does can't claim the empty vault.
  const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(String(a ?? '')).digest(), createHash('sha256').update(String(b ?? '')).digest());
  const checkSetupToken = (given) => { if (c.setupToken && !sameSecret(given, c.setupToken)) throw new HttpError(403, 'Set up payroll from the Payroll window in the KeaS app on this computer.'); };

  /**
   * The key to send the password to on first setup. The Hub on this PC: its own key file (c.hubTrustKeys). A Hub on
   * another PC: the key whose fingerprint the owner was shown and confirmed (GET /v1/vault/setup-hub-key). A Hub
   * offering any other key gets neither the password nor the code.
   */
  async function setupTrust(confirmed) {
    const own = c.hubTrustKeys?.();
    if (own?.length) return own;
    if (!c.setupToken) return null;
    const want = String(confirmed ?? '').toUpperCase().trim();
    if (!want) throw new HttpError(409, 'Compare the Kea Hub’s key fingerprint with the one on the Hub’s PC and confirm it first.', { confirmHubKey: true });
    const keys = await hub.fetchKeys(hubUrl()).catch((e) => { throw hubError(e, null); });
    if (keyFingerprint(keys) !== want) throw new HttpError(409, 'The Kea Hub is now offering a different key from the one you confirmed. Nothing was sent to it; check the fingerprint again.', { confirmHubKey: true, hubKeyChanged: true });
    return keys;
  }
  route('GET', '/v1/vault/setup-hub-key', async ({ query }) => {
    if (c.mode !== 'vault') throw new HttpError(404, 'not found');
    if (vault.initialized()) throw new HttpError(409, 'This vault is already set up.');
    checkSetupToken(query.token);
    if (!hubUrl()) throw new HttpError(409, 'No Kea Hub is set for payroll on this computer.');
    if (c.hubTrustKeys?.()?.length) return { url: hubUrl(), ownHub: true, fingerprint: keyFingerprint(c.hubTrustKeys()) };
    try { return { url: hubUrl(), ownHub: false, fingerprint: keyFingerprint(await hub.fetchKeys(hubUrl())) }; } catch (e) { throw hubError(e, null); }
  }, { auth: false, open: true });

  route('POST', '/v1/vault/setup', async ({ body, secure }) => {
    if (c.mode !== 'vault') throw new HttpError(404, 'not found');
    if (vault.initialized()) throw new HttpError(409, 'This vault is already set up. Sign in instead.');
    checkSetupToken(body.setupToken);
    if (body.hubUrl !== undefined) bad('The Kea Hub for payroll is set in the KeaS app on this computer, not here.');
    const passphrase = V.str(body.passphrase, 'passphrase', { min: 12, max: 500 });
    const o = body.org || {}, a = body.admin || {}, s = body.signIn || {};
    const email = V.str(a.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    const name = V.str(a.name, 'name', { min: 1, max: 120 });
    const state = V.str(o.state, 'state', { min: 2, max: 2 }).toUpperCase();
    const tz = V.str(o.tz ?? 'America/Denver', 'tz', { min: 3, max: 60 });
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { bad('unknown time zone'); }
    const mode = V.enum(s.mode ?? 'hub', 'signIn.mode', ['hub', 'local']);
    const strong = (pw) => { const why = checkLocalStrength(pw, { email, passphrase }); if (why) bad(why); return hashLocalPassword(String(pw)); };
    let hubSub = null, localPw = null, keys = null;
    if (mode === 'hub') {
      let who;
      const trust = await setupTrust(s.hubKeyFingerprint);
      try { who = await hub.signIn(hubUrl(), { email, password: String(s.password ?? ''), code: s.code ? String(s.code) : undefined }, { trust }); }
      catch (e) { if (e instanceof HubRefused && (e.status === 401 || e.status === 403)) throw new HttpError(401, e.message); throw hubError(e, null); }
      if (who.email !== email) bad('That Kea Hub account has a different email.');
      if (!who.emailVerified) throw new HttpError(403, 'Verify your email address in your Kea Hub account first, then set up payroll.');
      hubSub = who.sub; keys = who.keys;
      if (s.localPassword) { if (!localOn()) throw new HttpError(403, LOCAL_OFF); localPw = strong(s.localPassword); }
    } else {
      if (!localOn()) throw new HttpError(403, LOCAL_OFF);
      if (await hub.reachable(hubUrl())) throw new HttpError(409, 'The Kea Hub can be reached, so set up payroll with your Kea Hub account.');
      localPw = strong(s.password);
    }
    const pid = createVault({ passphrase, keys, o, state, tz, name, email, hubSub, localPw, mode });
    return c.newSession(pid, secure);
  }, { auth: false, open: true });

  /** Makes the vault, its organization and its first payroll admin; returns the admin's person id. */
  function createVault({ passphrase, keys, o, state, tz, name, email, hubSub, localPw, mode }) {
    const orgName = V.str(o.name, 'org name', { min: 1, max: 120 });
    const today = new Date(now()).toISOString().slice(0, 10);
    const anchor = o.payPeriodAnchor ? V.date(o.payPeriodAnchor, 'payPeriodAnchor') : weekStartOf(today, 0);
    vault.create(passphrase);
    if (keys) savePin(keys);
    const orgId = uid('org'), pid = uid('p');
    h.tx(() => {
      h.run(`INSERT INTO orgs (id,name,state,tz,pay_frequency,pay_period_anchor,futa_exempt,suta_rate,bank,settings) VALUES (?,?,?,?,?,?,?,?,?,?)`, orgId, orgName, state, tz, 'biweekly', anchor, o.futaExempt ? 1 : 0, Number(o.sutaRate) || 0, '{}', JSON.stringify(o.workCity ? { workCity: String(o.workCity).trim().slice(0, 60) } : {}));
      h.run(`INSERT INTO people (id,org_id,name,email,roles,positions,status,w4,ytd_wages_cents,hire_date) VALUES (?,?,?,?,?,?,?,?,0,?)`, pid, orgId, name, email, '["member","owner","payroll"]', '[]', 'active', '{}', null);
      h.run('INSERT INTO vault_users (id,person_id,email,hub_sub,local_pw,created_at) VALUES (?,?,?,?,?,?)', uid('vu'), pid, email, hubSub, localPw, iso(now()));
    });
    audit(orgId, pid, 'vault_setup', orgId, { mode });
    return pid;
  }

  // ---------- the KeaS app's own sign-in (in this process only: nothing here is reachable over HTTP) ----------
  // The KeaS app is already signed in to the payroll admin's Kea account. It gets a short-lived token for the audience
  // "keas-payroll" from that Hub and hands it over here with the passphrase, so nobody types their email and password
  // again. The token must be signed by the Hub key this vault trusts (pinned at setup, or this PC's own Hub key).
  function verifyGrant(hubToken, keys, iss = ISSUER) {
    try { return hub.verifyWith(keys, String(hubToken || ''), { iss }); }
    catch (e) {
      if (e instanceof HubRefused && e.extra?.hubKeyChanged) throw new HttpError(401, KEY_CHANGED, { hubKeyChanged: true });
      throw new HttpError(401, 'Payroll couldn’t confirm your Kea sign-in with the Kea Hub it trusts. Sign out of KeaS and in again.');
    }
  }
  /** The admin a verified grant belongs to (linking the Hub account the first time, as the HTTP sign-in does). */
  function userForGrant(p) {
    const email = String(p.email || '').toLowerCase();
    const user = h.get('SELECT * FROM vault_users WHERE hub_sub = ?', p.sub) || h.get('SELECT * FROM vault_users WHERE email = ? AND hub_sub IS NULL', email);
    if (!user) throw new HttpError(403, `${email || 'This Kea account'} isn’t a payroll admin in this vault. Ask the owner to add you (Payroll, Vault and settings).`);
    if (!user.hub_sub) {
      if (p.ev !== true) throw new HttpError(403, VERIFY_EMAIL);
      h.run('UPDATE vault_users SET hub_sub = ? WHERE id = ?', p.sub, user.id);
    }
    return user;
  }
  c.keas = {
    status: () => ({ initialized: vault.initialized(), unlocked: vault.unlocked(), idleMinutes: idleMinutes(), hubUrl: hubUrl(), ownHub: !!c.hubTrustKeys?.()?.length, org: vault.initialized() ? h.get('SELECT name FROM orgs LIMIT 1')?.name ?? null : null }),
    /** The Hub's key fingerprint to confirm before setting up with a Hub on another PC (none needed for this PC's own). */
    async setupKey() {
      if (vault.initialized()) throw new HttpError(409, 'This vault is already set up.');
      if (!hubUrl()) throw new HttpError(409, 'No Kea Hub is set for payroll on this computer.');
      const own = c.hubTrustKeys?.();
      if (own?.length) return { url: hubUrl(), ownHub: true, fingerprint: keyFingerprint(own) };
      try { return { url: hubUrl(), ownHub: false, fingerprint: keyFingerprint(await hub.fetchKeys(hubUrl())) }; } catch (e) { throw hubError(e, null); }
    },
    /** Sets up an empty vault for the signed-in account. Returns a session for the payroll window. */
    async setup({ hubToken, passphrase, org = {}, hubKeyFingerprint }) {
      if (c.mode !== 'vault') throw new HttpError(404, 'not found');
      if (vault.initialized()) throw new HttpError(409, 'This vault is already set up.');
      const pass = V.str(passphrase, 'passphrase', { min: 12, max: 500 });
      const state = V.str(org.state, 'state', { min: 2, max: 2 }).toUpperCase();
      const tz = V.str(org.tz ?? 'America/Denver', 'tz', { min: 3, max: 60 });
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { bad('unknown time zone'); }
      const keys = (await setupTrust(hubKeyFingerprint)) || (await hub.fetchKeys(hubUrl()).catch((e) => { throw hubError(e, null); }));
      const p = verifyGrant(hubToken, keys);
      if (p.ev !== true) throw new HttpError(403, VERIFY_EMAIL);
      const email = String(p.email || '').toLowerCase();
      const pid = createVault({ passphrase: pass, keys, o: org, state, tz, name: String(p.name || email).slice(0, 120), email, hubSub: p.sub, localPw: null, mode: 'keas' });
      lastUse = now();
      return c.newSession(pid, false);
    },
    /** Opens the vault for the signed-in account with the passphrase. Returns a session for the payroll window. */
    signIn({ hubToken, passphrase }) {
      if (c.mode !== 'vault') throw new HttpError(404, 'not found');
      if (!vault.initialized()) throw new HttpError(409, 'Set up the vault first.');
      let p0 = pin();
      if (p0 && p0.url !== hubUrl()) throw new HttpError(401, KEY_CHANGED, { hubKeyChanged: true });
      const own = c.hubTrustKeys?.();
      const p = verifyGrant(hubToken, p0?.keys || own || [], p0?.iss || ISSUER);
      const user = userForGrant(p);
      if (!p0 && own?.length) savePin(own);
      const mine = `user:${user.id}`;
      guard(mine);
      const wasLocked = !vault.unlocked();
      if (!vault.unlock(V.str(passphrase, 'passphrase', { min: 1, max: 500 }))) {
        limiter.fail(mine);
        if (wasLocked && !h.get('SELECT 1 FROM sessions')) vault.lock();
        throw new HttpError(401, 'That isn’t the vault passphrase.', { passphrase: true });
      }
      limiter.clear(mine);
      lastUse = now();
      h.run('UPDATE vault_users SET last_login = ? WHERE id = ?', iso(now()), user.id);
      const orgId = h.get('SELECT org_id FROM people WHERE id = ?', user.person_id).org_id;
      audit(orgId, user.person_id, 'vault_signin', user.id, { mode: 'keas' });
      return c.newSession(user.person_id, false);
    },
    /**
     * Checks a payroll admin's passphrase before the two-step code is asked for (so the code doesn't run out while
     * they type). Changes nothing; wrong tries count as at sign-in.
     */
    checkPassphrase({ email, passphrase }) {
      if (!vault.initialized()) throw new HttpError(409, 'Set up the vault first.');
      const user = h.get('SELECT * FROM vault_users WHERE email = ?', String(email || '').trim().toLowerCase());
      if (!user) throw new HttpError(403, `${email || 'This Kea account'} isn’t a payroll admin in this vault.`);
      const mine = `user:${user.id}`;
      guard(mine);
      if (!vault.check(String(passphrase ?? ''))) { limiter.fail(mine); throw new HttpError(401, 'That isn’t the vault passphrase.', { passphrase: true }); }
      return true;
    },
    lock: (why) => c.lockVault(why),
  };

  route('POST', '/v1/vault/signin', async ({ body, secure, ip }) => {
    if (c.mode !== 'vault') throw new HttpError(404, 'not found');
    if (!vault.initialized()) throw new HttpError(409, 'Set up the vault first.');
    const email = V.str(body.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    const mode = V.enum(body.mode ?? 'hub', 'mode', ['hub', 'local']);
    const passphrase = V.str(body.passphrase, 'passphrase', { min: 1, max: 500 });
    const password = String(body.password ?? '');
    const where = ipKey(ip), acct = `acct:${email}`;
    const user = h.get('SELECT * FROM vault_users WHERE email = ?', email);
    const wasLocked = !vault.unlocked();
    const relock = () => { if (wasLocked && !h.get('SELECT 1 FROM sessions')) vault.lock(); };
    let who = null;
    if (mode === 'local') {
      // Off unless the owner turned it on; only while the Hub can't be reached; counted per account and address.
      if (!localOn()) throw new HttpError(403, LOCAL_OFF);
      guard(acct, where);
      if (await hub.reachable(hubUrl())) throw new HttpError(409, LOCAL_HUB_UP);
      const okPw = !!user?.local_pw && checkLocalPassword(password, user.local_pw);
      if (!okPw || !vault.unlock(passphrase)) { limiter.fail(acct); limiter.fail(where); relock(); throw new HttpError(401, WRONG); }
      limiter.clear(acct);
      who = user;
    } else {
      // The Hub checks the password and two-step code (with its own limits) before the passphrase is even tried, so
      // only the account's owner can spend that account's passphrase tries.
      guard(where);
      who = await identifyAtHub(user, { email, password, code: body.code ? String(body.code) : undefined });
      if (!who) { limiter.fail(where); throw new HttpError(401, WRONG); }
      const mine = `user:${who.id}`;
      guard(mine);
      if (!vault.unlock(passphrase)) { limiter.fail(mine); relock(); throw new HttpError(401, WRONG); }
      limiter.clear(mine);
    }
    limiter.clear(where);
    lastUse = now();
    h.run('UPDATE vault_users SET last_login = ? WHERE id = ?', iso(now()), who.id);
    const p = h.get('SELECT org_id FROM people WHERE id = ?', who.person_id);
    audit(p.org_id, who.person_id, 'vault_signin', who.id, { mode });
    return c.newSession(who.person_id, secure);
  }, { auth: false, open: true });

  route('POST', '/v1/vault/lock', ({ me, org, secure }) => {
    h.run('DELETE FROM sessions');
    if (c.mode === 'vault') { vault.lock(); c.onVaultLock?.('locked'); }
    audit(org.id, me.id, 'vault_lock', null, null);
    return { ok: true, cookies: [c.sessionCookie('', 0, secure)] };
  });
  route('POST', '/v1/vault/passphrase', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const key = `pass:${me.id}`;
    guard(key);
    const next = V.str(body.next, 'next', { min: 12, max: 500 });
    if (!vault.rekey(V.str(body.current, 'current', { min: 1, max: 500 }), next)) { limiter.fail(key); throw new HttpError(401, 'The current passphrase is wrong.'); }
    limiter.clear(key);
    audit(org.id, me.id, 'vault_passphrase_change', null, null);
    return { ok: true };
  });

  route('GET', '/v1/vault/users', ({ me, org }) => {
    need(me, 'owner', 'payroll');
    return { users: byName(h.all('SELECT v.*, p.name FROM vault_users v JOIN people p ON p.id = v.person_id WHERE p.org_id = ?', org.id)).map((u) => ({ id: u.id, personId: u.person_id, name: u.name, email: u.email, hubLinked: !!u.hub_sub, localPassword: !!u.local_pw, lastLogin: u.last_login })), hubUrl: hubUrl(), localSignIn: localOn(), hubKeyPinned: !!pin() };
  });
  route('POST', '/v1/vault/users', ({ me, org, body }) => {
    need(me, 'owner');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const email = V.str(body.email ?? p.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    if (h.get('SELECT 1 FROM vault_users WHERE email = ?', email)) throw new HttpError(409, 'that email can already sign in');
    if (!p.roles.includes('payroll') && !p.roles.includes('owner')) h.run('UPDATE people SET roles = ? WHERE id = ?', JSON.stringify([...new Set([...p.roles, 'payroll'])]), p.id);
    h.run('INSERT INTO vault_users (id,person_id,email,created_at) VALUES (?,?,?,?)', uid('vu'), p.id, email, iso(now()));
    audit(org.id, me.id, 'vault_user_add', p.id, { email });
    return { ok: true };
  });
  route('POST', '/v1/vault/users/:id/delete', ({ me, org, params }) => {
    need(me, 'owner');
    const u = h.get('SELECT v.* FROM vault_users v JOIN people p ON p.id = v.person_id WHERE v.id = ? AND p.org_id = ?', params.id, org.id);
    if (!u) throw new HttpError(404, 'not found');
    if (u.person_id === me.id) bad('you can’t remove yourself');
    h.run('DELETE FROM vault_users WHERE id = ?', u.id);
    h.run('DELETE FROM sessions WHERE person_id = ?', u.person_id);
    audit(org.id, me.id, 'vault_user_remove', u.person_id, null);
    return { ok: true };
  });
  route('POST', '/v1/vault/local-password', ({ me, org, body }) => {
    const u = h.get('SELECT * FROM vault_users WHERE person_id = ?', me.id);
    if (!u) throw new HttpError(404, 'you don’t have a vault sign-in');
    if (body.password == null) { h.run('UPDATE vault_users SET local_pw = NULL WHERE id = ?', u.id); audit(org.id, me.id, 'vault_local_password_off', u.id, null); return { ok: true, localPassword: false }; }
    if (!localOn()) throw new HttpError(403, LOCAL_OFF);
    const why = checkLocalStrength(V.str(body.password, 'password', { min: 1, max: 300 }), { email: u.email });
    if (why) bad(why);
    h.run('UPDATE vault_users SET local_pw = ? WHERE id = ?', hashLocalPassword(body.password), u.id);
    audit(org.id, me.id, 'vault_local_password', u.id, null);
    return { ok: true, localPassword: true };
  });
  // (The Hub address can't be changed over HTTP: the KeaS app on this computer sets it.)
  route('POST', '/v1/vault/hub-url', () => { throw new HttpError(410, 'The Kea Hub for payroll is set in the KeaS app on this computer.'); });

  // Org-wide payroll settings (each key validated).
  route('GET', '/v1/org/settings', ({ me, org }) => { need(me, 'manager', 'payroll'); return { settings: org.settings, org: { name: org.name, state: org.state, tz: org.tz, payFrequency: org.payFrequency, payPeriodAnchor: org.payPeriodAnchor, futaExempt: org.futaExempt, sutaRate: org.sutaRate }, vault: c.mode === 'vault' ? { idleLockMinutes: idleMinutes() } : null }; });
  route('POST', '/v1/org/settings', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const s = {};
    const num = (v, name, max) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > max) bad(`${name} is out of range`); return x; };
    if (body.mileageRateCents !== undefined) s.mileageRateCents = body.mileageRateCents == null || body.mileageRateCents === '' ? null : Math.round(num(body.mileageRateCents, 'mileageRateCents', 1000));
    if (body.receiptRequiredCents !== undefined) s.receiptRequiredCents = Math.round(num(body.receiptRequiredCents, 'receiptRequiredCents', 1e7));
    if (body.expenseCategories !== undefined) s.expenseCategories = Array.isArray(body.expenseCategories) ? body.expenseCategories.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40) : bad('expenseCategories must be a list');
    if (body.cobra !== undefined) s.cobra = { groupHealthPlan: !!body.cobra?.groupHealthPlan, stateContinuation: !!body.cobra?.stateContinuation };
    if (body.fmla !== undefined) s.fmla = { worksiteEmployees: body.fmla?.worksiteEmployees == null || body.fmla.worksiteEmployees === '' ? null : Math.round(num(body.fmla.worksiteEmployees, 'worksiteEmployees', 1e6)) };
    if (body.aca !== undefined) s.aca = { ale: !!body.aca?.ale };
    // Where people work (a city or county): local rules KeaS knows about, like a city minimum wage, follow it.
    if (body.workCity !== undefined) s.workCity = body.workCity == null || String(body.workCity).trim() === '' ? null : V.str(String(body.workCity).trim(), 'workCity', { max: 60 });
    if (body.offerTemplate !== undefined) s.offerTemplate = body.offerTemplate ? V.str(body.offerTemplate, 'offerTemplate', { max: 20000 }) : null;
    // Pay amounts in managers' reports: off unless the owner turns it on.
    if (body.managersSeePay !== undefined) { need(me, 'owner'); s.managersSeePay = !!body.managersSeePay; }
    if (body.idleLockMinutes !== undefined && c.mode === 'vault') {
      const m = Math.round(num(body.idleLockMinutes, 'idleLockMinutes', IDLE_LOCK_MAX_MIN));
      if (m < 1) bad('idleLockMinutes must be 1 or more');
      vault.setSetting('idleLockMinutes', m);
      s.idleLockMinutes = m;
    }
    const { idleLockMinutes: _idle, ...orgSettings } = s;
    c.saveOrgSettings(org, orgSettings);
    const cols = {};
    if (body.sutaRate !== undefined) cols.suta_rate = num(body.sutaRate, 'sutaRate', 0.2);
    if (body.futaExempt !== undefined) cols.futa_exempt = body.futaExempt ? 1 : 0;
    if (body.name !== undefined) cols.name = V.str(body.name, 'name', { min: 1, max: 120 });
    if (body.state !== undefined) cols.state = V.str(body.state, 'state', { min: 2, max: 2 }).toUpperCase();
    const keys = Object.keys(cols);
    if (keys.length) h.run(`UPDATE orgs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), org.id);
    audit(org.id, me.id, 'org_settings', org.id, { ...s, ...cols, offerTemplate: s.offerTemplate ? '(changed)' : undefined });
    const o = c.loadOrg(org.id);
    return { settings: o.settings };
  });
}
