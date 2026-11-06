// The owner console's sign-in: challenge and response, so the owner key itself never goes over the wire.
//
// Anything on this PC could be listening on the owner port while the Hub is down (another Windows account can bind
// 127.0.0.1:4861 first). Sending the raw key there would hand it over. Instead:
//   1. the client GETs /owner/nonce (a random, single-use value that expires after a minute);
//   2. it sends the request with  X-Kea-Owner-Auth: <nonce>.<HMAC-SHA256(key, message)>
//      where message = "kea-owner-v1\n<nonce>\n<METHOD>\n<path and query>\n<sha256 of the body, hex>".
// An impostor learns only an HMAC for one request it already saw, which it can't use at the real Hub (the nonce came
// from the impostor, and each nonce works once). The HMAC also ties the answer to that exact method, path and body.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OWNER_AUTH_HEADER = 'x-kea-owner-auth';
export const NONCE_TTL_MS = 60_000;
const NONCE_MAX = 2000;

const toBuf = (body) => (body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body), 'utf8'));
export const bodyHash = (body) => createHash('sha256').update(toBuf(body)).digest('hex');
export const ownerMessage = (nonce, method, path, body) => `kea-owner-v1\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`;
export const ownerMac = (key, nonce, method, path, body) => createHmac('sha256', Buffer.from(String(key).trim(), 'utf8')).update(ownerMessage(nonce, method, path, body)).digest('hex');
/** The header value for one request. */
export const ownerSign = (key, nonce, method, path, body) => `${nonce}.${ownerMac(key, nonce, method, path, body)}`;

/** The Hub's side: hands out nonces and checks answers. `nowFn` for tests. */
export function ownerNonces(nowFn = () => Date.now()) {
  const nonces = new Map(); // nonce -> expires at
  const sweep = () => {
    const t = nowFn();
    for (const [n, exp] of nonces) if (exp <= t) nonces.delete(n);
    while (nonces.size >= NONCE_MAX) nonces.delete(nonces.keys().next().value);
  };
  return {
    issue() {
      sweep();
      const n = randomBytes(16).toString('hex');
      nonces.set(n, nowFn() + NONCE_TTL_MS);
      return n;
    },
    /** Parses the header and uses up its nonce. Returns { nonce, mac } or null (unknown, expired or malformed). */
    take(header) {
      const m = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(header || ''));
      if (!m) return null;
      const exp = nonces.get(m[1]);
      nonces.delete(m[1]);
      if (!exp || exp <= nowFn()) return null;
      return { nonce: m[1], mac: m[2] };
    },
    /** True when `mac` is right for this request. */
    check(key, taken, method, path, body) {
      const want = Buffer.from(ownerMac(key, taken.nonce, method, path, body), 'hex');
      const got = Buffer.from(taken.mac, 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    },
    size: () => nonces.size,
  };
}

/**
 * A client call to the owner console: gets a nonce, then sends the signed request. `body` may be an object (sent as
 * JSON), a string or a Buffer. Returns the fetch Response.
 */
export async function ownerFetch(base, key, method, path, body, { fetchFn = fetch, headers = {} } = {}) {
  const nr = await fetchFn(`${base}/owner/nonce`);
  if (!nr.ok) throw new Error(`The owner console didn’t give a challenge (${nr.status}).`);
  const { nonce } = await nr.json();
  const data = body == null ? undefined : Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  const u = new URL(path, base);
  const signed = ownerSign(key, nonce, method, u.pathname + u.search, data);
  return fetchFn(u.toString(), {
    method,
    headers: { ...(data !== undefined && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers, [OWNER_AUTH_HEADER]: signed },
    body: data,
  });
}
