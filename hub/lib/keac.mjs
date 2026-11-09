// KeaC passes (docs/protocol.md section 2): how a Kea account signs in to this KeaS server without KeaS ever seeing a
// password. Kea asks KeaC (the Kea account server) for a pass naming this server's id; KeaS checks it here and then
// makes its own session (hub/index.mjs).
//
// What a pass must be: JWT-shaped, alg EdDSA, a kid in its header naming one of KeaC's keys, signed by that key, with
//   { iss: 'kea', aud: 'keas:<this server id>', sub, email, name, ev: true, iat, exp }   (iat and exp in seconds)
// exp in the future, iat not more than 2 minutes in the future, a lifetime of at most 8 days (KeaC's are 7), and sub
// not on KeaC's revocation list.
//
// KeaC's keys: the trusted ones (KEAC_KEYS below, the host's keacKeys, and the key the owner confirmed in the KeaS app,
// trust on first use, or the old Hub's own key after a move), plus the list from <KeaC>/v1/keys, fetched at start and
// every 6 hours and taken only when it still has a trusted key in it (that's how rotations are followed). The last list that came back good is kept (in the settings table), so KeaS keeps checking
// passes while KeaC can't be reached. A pass whose kid isn't known yet makes one early refresh (at most once a minute):
// KeaC publishes a key as 'next' at least 7 days before it signs with it, so this only matters after a long outage.
//
// Revocation: <KeaC>/v1/revoked?since=<ms> every hour (what changed since a minute before KeaC's own `now` of the
// last answer, so one revoked in that same moment isn't missed), and the
// whole list (no since; full: true) at start and once a day, which replaces the one kept here (accounts KeaC let back
// in drop off only with the full list). Sessions of listed accounts end at once (onRevoked). When KeaC can't be
// reached nothing changes: sessions and the last lists stay as they were.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * KeaC's address. Not known yet: the owner's KeaC gets its Tailscale address when it's set up. Until then KeaS is told
 * it with KEAC_URL (or the KeaS app's settings), and without one it checks passes against the built-in keys only.
 */
export const KEAC_URL = null;
/**
 * KeaC's current public key, built in (a JWK: { kty: 'OKP', crv: 'Ed25519', x, kid }). Filled in when KeaC's first key
 * is published; until then it comes from KEAC_KEY (the JWK as JSON) or the host's keacKeys.
 */
export const KEAC_KEYS = [];

export const PASS_ISS = 'kea';
export const SKEW_S = 120;
export const MAX_PASS_S = 8 * 86400;
const HOUR = 3600_000;
export const KEYS_EVERY_MS = 6 * HOUR;
export const REVOKED_EVERY_MS = HOUR;
export const FULL_EVERY_MS = 24 * HOUR;
const KID_REFRESH_MS = 60_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
// A phone number as KeaC sends it in a pass: + and 8 to 15 digits (E.164).
const PHONE = /^\+[1-9]\d{7,14}$/;
/** A key's fingerprint as people compare it (KeaC's Keys screen, `node server/owner.mjs key-fingerprint`): SHA-256 of x, in groups of four. */
export const keyFingerprint = (k) => createHash('sha256').update(String(k.x)).digest('hex').toUpperCase().match(/.{4}/g).join(' ');

export class PassError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}
const MESSAGES = {
  format: 'That isn’t a Kea pass.',
  key: 'This pass wasn’t signed by a Kea account key this server knows. Try again in a minute; if it keeps happening, update KeaS.',
  signature: 'This pass didn’t check out.',
  iss: 'This pass isn’t from Kea accounts.',
  aud: 'This pass is for a different KeaS server. Ask Kea for a pass for this one.',
  expired: 'This pass has expired. Kea gets a new one by itself when it’s online.',
  future: 'This pass was issued in the future. Check the clock on this PC.',
  lifetime: 'This pass lasts longer than Kea passes do.',
  claims: 'This pass is missing who it’s for.',
  revoked: 'This Kea account can’t sign in here.',
};
const fail = (reason) => { throw new PassError(reason, MESSAGES[reason]); };

const okp = (k) => !!k && typeof k === 'object' && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.x);
/** A key list as this module keeps it: [{ kty, crv, x, kid, status }], only Ed25519 keys with a kid. */
export function cleanKeys(list, { status = true } = {}) {
  return (Array.isArray(list) ? list : []).filter((k) => okp(k) && typeof k.kid === 'string' && ID.test(k.kid) && (!status || ['current', 'next', 'retired'].includes(k.status ?? 'current')))
    .map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, status: k.status ?? 'current' }));
}
/** The keys from KEAC_KEY (a JWK, or a list of them, as JSON), or []. */
export function envKeys(v = process.env.KEAC_KEY) {
  if (!v) return [];
  try { const j = JSON.parse(v); return cleanKeys(Array.isArray(j) ? j : [j], { status: false }); } catch { return []; }
}

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
/** The pass's header kid, or null. */
export function passKid(token) { try { const k = part(String(token).split('.')[0]).kid; return typeof k === 'string' ? k : null; } catch { return null; } }

/**
 * Checks a pass against `keys` (pure; no revocation): its payload, or throws PassError with the reason.
 */
export function checkPass(token, keys, { aud, nowMs = Date.now() }) {
  const parts = String(token ?? '').split('.');
  if (typeof token !== 'string' || token.length > 8192 || parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) fail('format');
  let head, p;
  try { head = part(parts[0]); p = part(parts[1]); } catch { fail('format'); }
  if (!head || head.alg !== 'EdDSA' || typeof head.kid !== 'string' || !p || typeof p !== 'object') fail('format');
  const jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) fail('key');
  let good = false;
  try { good = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch {}
  if (!good) fail('signature');
  if (p.iss !== PASS_ISS) fail('iss');
  if (p.aud !== aud) fail('aud');
  const t = nowMs / 1000;
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= t) fail('expired');
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat) || p.iat > t + SKEW_S) fail('future');
  if (p.exp - p.iat > MAX_PASS_S) fail('lifetime');
  if (typeof p.sub !== 'string' || !ID.test(p.sub) || p.ev !== true || (p.email != null && typeof p.email !== 'string') || (p.name != null && typeof p.name !== 'string')) fail('claims');
  // phone: when the person shares it with anyone (KeaC leaves it out otherwise); E.164, else ignored. phoneOrgs and
  // phoneClassmates: who with (each exactly true, or not shared there).
  const phone = typeof p.phone === 'string' && PHONE.test(p.phone) ? p.phone : null;
  return {
    sub: p.sub, email: p.email ? String(p.email).trim().toLowerCase().slice(0, 254) : null, name: p.name ? String(p.name).slice(0, 120) : '',
    phone, phoneOrgs: !!phone && p.phoneOrgs === true, phoneClassmates: !!phone && p.phoneClassmates === true, iat: p.iat, exp: p.exp, kid: head.kid,
  };
}

/**
 * KeaC as this server sees it: its keys, its revocation list, and pass checks.
 * url(): KeaC's address now (null: none set). builtIn: the built-in keys. store: { get(k, d), set(k, v) } for the last
 * good key list and the revocation cursor. revoked: { set(ids), add(ids), has(id), count() } (a table in the host).
 * onRevoked(ids): accounts just listed (their sessions end).
 */
export function createKeac({ url = () => KEAC_URL, builtIn = KEAC_KEYS, store, revoked, onRevoked = () => {}, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 8000, log = () => {}, client = null }) {
  // (Every request says which KeaS it is: `X-Kea-Client: KeaS/<version>`, docs/protocol.md section 0.)
  const headers = { accept: 'application/json', ...(client ? { 'x-kea-client': client } : {}) };
  const st = {
    keysAt: store.get('keac.keysAt', null), keysError: null, keysTriedAt: 0,
    revokedAt: store.get('keac.revokedAt', null), fullAt: store.get('keac.fullAt', null), since: store.get('keac.since', 0), revokedError: null,
    // KeaC said this KeaS is too old (426): { error, minVersion, updateUrl, at }, until it answers normally again.
    updateRequired: null,
  };
  /** Notes KeaC's 426 (too old), or that it answered normally again. */
  async function noteAnswer(r) {
    if (r.status === 426) {
      let j = {};
      try { j = await r.clone().json(); } catch {}
      st.updateRequired = { error: String(j.error || 'Update KeaS to keep signing people in with their Kea accounts.'), minVersion: j.minVersion ?? null, updateUrl: j.updateUrl ?? null, at: now() };
      log(st.updateRequired.error);
    } else if (r.ok) st.updateRequired = null;
  }
  let fetched = cleanKeys(store.get('keac.keys', []));
  const base = () => { const u = url(); return u ? String(u).replace(/\/+$/, '') : null; };
  const anchors = () => cleanKeys(typeof builtIn === 'function' ? builtIn() : builtIn, { status: false });
  const keys = () => {
    const out = [...fetched];
    for (const k of anchors()) if (!out.some((x) => x.kid === k.kid)) out.push(k);
    return out;
  };
  const same = (a, b) => a.kid === b.kid && a.x === b.x;
  async function getJson(path) {
    const b = base();
    if (!b) throw new Error('No Kea account server (KEAC_URL) is set.');
    const r = await fetchImpl(b + path, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers });
    await noteAnswer(r);
    if (r.status === 426) throw new Error(st.updateRequired.error);
    if (!r.ok) throw new Error(`The Kea account server said ${r.status}.`);
    return r.json();
  }

  /** Fetches KeaC's key list. A bad or missing answer keeps the last good list. True when it got a list. */
  let keysBusy = null;
  function refreshKeys() {
    return (keysBusy ||= (async () => {
      st.keysTriedAt = now();
      try {
        const j = await getJson('/v1/keys');
        const list = cleanKeys(j?.keys);
        if (!list.length) throw new Error('The Kea account server listed no keys.');
        // A new list is taken only when it still has a key this server trusts (KeaC publishes the next key well before
        // it signs with it, and keeps the old one listed for a while), so whoever answers at the address can't swap in
        // keys of their own. With no trusted key at all, nothing is taken: the owner confirms one first (pin).
        const trusted = keys();
        if (!trusted.length) throw new Error('No Kea account server key is trusted yet. Confirm its fingerprint in the KeaS app first.');
        if (!list.some((k) => trusted.some((t) => same(k, t)))) throw new Error('The Kea account server’s key list has none of the keys this server trusts, so it wasn’t taken. If the Kea account server was set up again, confirm its new key in the KeaS app.');
        fetched = list;
        st.keysAt = now(); st.keysError = null;
        store.set('keac.keys', list); store.set('keac.keysAt', st.keysAt);
        return true;
      } catch (e) { st.keysError = e.message; log(`keac keys: ${e.message}`); return false; }
    })().finally(() => { keysBusy = null; }));
  }

  /** Asks KeaC who's revoked: the whole list (full) or what changed since the last answer. True when it answered. */
  let revBusy = null;
  function pollRevoked({ full = false } = {}) {
    return (revBusy ||= (async () => {
      try {
        const whole = full || !st.since;
        const j = await getJson(whole ? '/v1/revoked' : `/v1/revoked?since=${encodeURIComponent(Math.max(1, st.since - 60_000))}`);
        const ids = (Array.isArray(j?.ids) ? j.ids : []).filter((x) => typeof x === 'string' && ID.test(x));
        if (typeof j?.now !== 'number') throw new Error('The Kea account server’s revocation list had no time.');
        const fresh = ids.filter((x) => !revoked.has(x));
        if (j.full === true) { revoked.set(ids); st.fullAt = now(); store.set('keac.fullAt', st.fullAt); }
        else revoked.add(ids);
        st.since = j.now; st.revokedAt = now(); st.revokedError = null;
        store.set('keac.since', st.since); store.set('keac.revokedAt', st.revokedAt);
        if (fresh.length) onRevoked(fresh);
        return true;
      } catch (e) { st.revokedError = e.message; log(`keac revoked: ${e.message}`); return false; }
    })().finally(() => { revBusy = null; }));
  }

  /** The hourly and daily checks: due ones run now. */
  async function tick() {
    const t = now();
    if (!st.keysAt || t - st.keysAt >= KEYS_EVERY_MS) await refreshKeys();
    if (!st.fullAt || t - st.fullAt >= FULL_EVERY_MS) await pollRevoked({ full: true });
    else if (!st.revokedAt || t - st.revokedAt >= REVOKED_EVERY_MS) await pollRevoked();
  }
  let timer = null;
  return {
    keys,
    refreshKeys, pollRevoked, tick,
    /** Starts the checks: now (not awaited), then every few minutes it looks at what's due. */
    start({ everyMs = 5 * 60_000 } = {}) {
      // (At start the keys are always fetched again, and the revocation list checked.)
      st.keysAt = null; st.revokedAt = null;
      const run = () => tick().catch((e) => log(`keac: ${e.message}`));
      run();
      timer = setInterval(run, everyMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    /** A pass for `aud`, checked: { sub, email, name, iat, exp, kid }, or throws PassError. */
    async verify(token, { aud }) {
      const kid = passKid(token);
      // (Keys being fetched right now, as at start: wait for them.)
      if (kid && !(fetched.length ? fetched : anchors()).some((k) => k.kid === kid) && keysBusy) await keysBusy;
      if (kid &&!keys().some((k) => k.kid === kid) && base() && now() - st.keysTriedAt > KID_REFRESH_MS) await refreshKeys();
      // (Passes check against KeaC's published list once there is one, so a key KeaC stopped listing stops working;
      // the trusted keys alone only until the first list came.)
      const p = checkPass(token, fetched.length ? fetched : anchors(), { aud, nowMs: now() });
      if (revoked.has(p.sub)) fail('revoked');
      return p;
    },
    /** KeaC's keys as it lists them now, with fingerprints, for the owner to compare with KeaC's Keys screen. */
    async offer(url = base()) {
      if (!url) throw new Error('Enter the Kea account server’s address first.');
      const r = await fetchImpl(String(url).replace(/\/+$/, '') + '/v1/keys', { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers });
      await noteAnswer(r);
      if (r.status === 426) throw new Error(st.updateRequired.error);
      if (!r.ok) throw new Error(`The Kea account server said ${r.status}.`);
      return cleanKeys((await r.json())?.keys).map((k) => ({ ...k, fingerprint: keyFingerprint(k) }));
    },
    /** After `anchors` changed (a key pinned): take the fetched list again. */
    reset() { fetched = []; st.keysAt = null; store.set('keac.keys', []); },
    status: () => ({
      url: base(), keys: keys().map((k) => ({ kid: k.kid, status: k.status, fingerprint: keyFingerprint(k) })), trusted: anchors().length,
      keysAt: st.keysAt, keysError: st.keysError, revokedAt: st.revokedAt, fullAt: st.fullAt, revokedError: st.revokedError, revoked: revoked.count(),
      updateRequired: st.updateRequired,
    }),
  };
}
