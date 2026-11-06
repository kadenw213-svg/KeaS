// The owner console's sign-in: challenge and response, so the owner key itself never goes over the wire.
//
// Anything on this PC could be listening on the owner port while the Hub is down (another Windows account can bind
// 127.0.0.1:4861 first). Sending the raw key there would hand it over. Instead:
//   1. the client GETs /owner/nonce (a random, single-use value that expires after a minute);
//   2. it sends the request with  X-Kea-Owner-Auth: <nonce>.<HMAC-SHA256(key, message)>
//      where message = "kea-owner-v1\n<nonce>\n<METHOD>\n<path and query>\n<sha256 of the body, hex>".
// An impostor learns only an HMAC for one request it already saw, which it can't use at the real Hub (the nonce came
// from the impostor, and each nonce works once). The HMAC also ties the answer to that exact method, path and body.
//   3. the Hub's answer carries  X-Kea-Owner-Reply: HMAC-SHA256(key, "kea-owner-reply-v1\n<nonce>\n<client challenge>\n
//      <status>\n<METHOD>\n<path and query>\n<sha256 of the answer>"), so a program squatting on the port can't feed the
//      client made-up answers (fake jobs, say). The client's own random challenge goes in X-Kea-Owner-Challenge, so an
//      old answer can't be replayed either. A sign-in that failed gets no such header: nothing vouches for its text.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OWNER_AUTH_HEADER = 'x-kea-owner-auth';
export const NONCE_TTL_MS = 60_000;
const NONCE_MAX = 2000;
const NONCE_MAX_PER_SOURCE = 512;
export const OWNER_REPLY_HEADER = 'x-kea-owner-reply';
export const OWNER_CHALLENGE_HEADER = 'x-kea-owner-challenge';
const CHALLENGE = /^[0-9a-f]{32,128}$/;
/** The Hub's proof of one answer. */
export const ownerReplyMac = (key, nonce, challenge, status, method, path, body) => createHmac('sha256', Buffer.from(String(key).trim(), 'utf8')).update(`kea-owner-reply-v1\n${nonce}\n${CHALLENGE.test(String(challenge || '')) ? challenge : ''}\n${status}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`).digest('hex');
export class OwnerReplyError extends Error { constructor() { super('The answer on the owner console’s port didn’t come from your Kea Hub (it couldn’t prove it holds the owner key). Another program may be on that port. Nothing was accepted from it.'); this.name = 'OwnerReplyError'; } }

const toBuf = (body) => (body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body), 'utf8'));
export const bodyHash = (body) => createHash('sha256').update(toBuf(body)).digest('hex');
export const ownerMessage = (nonce, method, path, body) => `kea-owner-v1\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`;
export const ownerMac = (key, nonce, method, path, body) => createHmac('sha256', Buffer.from(String(key).trim(), 'utf8')).update(ownerMessage(nonce, method, path, body)).digest('hex');
/** The header value for one request. */
export const ownerSign = (key, nonce, method, path, body) => `${nonce}.${ownerMac(key, nonce, method, path, body)}`;

/** The Hub's side: hands out nonces and checks answers. `nowFn` for tests. */
export function ownerNonces(nowFn = () => Date.now()) {
  const nonces = new Map(); // nonce -> { exp, source }, oldest first
  const perSource = new Map();
  const drop = (n) => {
    const e = nonces.get(n);
    if (!e) return;
    nonces.delete(n);
    const c = (perSource.get(e.source) || 1) - 1;
    if (c > 0) perSource.set(e.source, c); else perSource.delete(e.source);
  };
  const sweep = () => {
    const t = nowFn();
    for (const [n, e] of nonces) if (e.exp <= t) drop(n);
    while (nonces.size >= NONCE_MAX) drop(nonces.keys().next().value);
  };
  return {
    /** A new nonce for this caller: one asking for many pushes out its own oldest first. */
    issue(source = '') {
      sweep();
      if ((perSource.get(source) || 0) >= NONCE_MAX_PER_SOURCE) for (const [k, e] of nonces) if (e.source === source) { drop(k); break; }
      const n = randomBytes(16).toString('hex');
      nonces.set(n, { exp: nowFn() + NONCE_TTL_MS, source });
      perSource.set(source, (perSource.get(source) || 0) + 1);
      return n;
    },
    /** Parses the header and uses up its nonce. Returns { nonce, mac } or null (unknown, expired or malformed). */
    take(header) {
      const m = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(header || ''));
      if (!m) return null;
      const e = nonces.get(m[1]);
      drop(m[1]);
      if (!e || e.exp <= nowFn()) return null;
      return { nonce: m[1], mac: m[2] };
    },
    /** True when `mac` is right for this request. */
    check(key, taken, method, path, body) {
      const want = Buffer.from(ownerMac(key, taken.nonce, method, path, body), 'hex');
      const got = Buffer.from(taken.mac, 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    },
    size: () => nonces.size,
    sizeFor: (source = '') => perSource.get(source) || 0,
  };
}

/**
 * A client call to the owner console: gets a nonce, sends the signed request, and checks the answer really came from
 * the Hub (throws OwnerReplyError if not). A failed sign-in (401) comes back unproved, as a failure to act on and
 * nothing more. `body` may be an object (sent as JSON), a string or a Buffer. Returns a Response.
 */
export async function ownerFetch(base, key, method, path, body, opts = {}) {
  const first = await ownerCall(base, key, method, path, body, opts);
  // (Flooding the console with challenges can push ours out in the moment before it's used: one more try.)
  if (first.status !== 401) return first;
  const why = await first.clone().json().catch(() => null);
  return /fresh challenge/.test(String(why?.error)) ? ownerCall(base, key, method, path, body, opts) : first;
}
async function ownerCall(base, key, method, path, body, { fetchFn = fetch, headers = {} } = {}) {
  const nr = await fetchFn(`${base}/owner/nonce`);
  if (!nr.ok) throw new Error(`The owner console didn’t give a challenge (${nr.status}).`);
  const { nonce } = await nr.json();
  const data = body == null ? undefined : Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  const u = new URL(path, base);
  const signed = ownerSign(key, nonce, method, u.pathname + u.search, data);
  const challenge = randomBytes(16).toString('hex');
  const r = await fetchFn(u.toString(), {
    method,
    headers: { ...(data !== undefined && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers, [OWNER_AUTH_HEADER]: signed, [OWNER_CHALLENGE_HEADER]: challenge },
    body: data,
  });
  const proof = r.headers.get(OWNER_REPLY_HEADER);
  if (r.status === 401 && !proof) return r;
  const answer = Buffer.from(await r.arrayBuffer());
  const want = Buffer.from(ownerReplyMac(key, nonce, challenge, r.status, method, u.pathname + u.search, answer), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(String(proof)) ? proof : '', 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new OwnerReplyError();
  return new Response(answer, { status: r.status, headers: r.headers });
}
