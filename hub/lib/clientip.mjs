// Which address a request came from, for the per-IP limits and the sign-in lockouts.
//
// The Hub listens on 127.0.0.1 only; the internet reaches it through a tunnel on the same PC, so the socket address is
// always the tunnel's (loopback). The tunnel says who the client was in a header, and the Hub trusts that header only
// when it was told which one to read (`ipHeader`, KEA_HUB_IP_HEADER). The KeaS desktop sets it when it turned on
// Tailscale Funnel.
//
// What Tailscale Funnel sends (tailscale/ipn/ipnlocal/serve.go, addProxyForwardedHeaders and
// addTailscaleIdentityHeaders, checked 2026-11):
//   - X-Forwarded-For: REPLACED (Header.Set, not appended) with the address that connected to Funnel, so it holds one
//     entry. If some path ever appended instead, the proxy's entry would still be the last one, so only the LAST entry
//     is used; anything before it came from the client and can be faked.
//   - X-Forwarded-Proto: "https" (TLS ends at Funnel); X-Forwarded-Host: the public host name.
//   - Tailscale-Funnel-Request: "?1" on requests that came in through Funnel (incoming copies are deleted first).
//     Tailscale-User-* identity headers are only for tailnet (Serve) requests, never for Funnel ones.
// Behind Cloudflare Tunnel, use 'cf-connecting-ip' (one value, set by Cloudflare).
//
// A value that isn't a plain IP address (garbage, "unknown", a host name, an address with a port) is ignored and the
// socket address is used instead, marked `shared` so the limits know many people may be behind it.
import { isIP } from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (a) => LOOPBACK.has(String(a)) || /^127\./.test(String(a)) || /^::ffff:127\./.test(String(a));

/** A plain IPv4 or IPv6 address, normalized (IPv4-mapped IPv6 to IPv4, lower case), or null. */
export function cleanIp(v) {
  let s = String(v ?? '').trim();
  if (!s || s.length > 64) return null;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) s = m[1];
  if (s.includes('%')) return null; // zone ids never come from a proxy
  const kind = isIP(s);
  if (!kind) return null;
  return kind === 6 ? s.toLowerCase() : s;
}

/**
 * The key the limits count against: an IPv4 address as is, an IPv6 address by its /64 (one home or phone gets a whole
 * /64, so counting single IPv6 addresses would let one person look like billions).
 */
export function ipBucket(ip) {
  if (isIP(ip) !== 6) return ip;
  const full = expand6(ip);
  return full ? `${full.slice(0, 4).join(':')}::/64` : ip;
}
function expand6(ip) {
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail != null ? (tail ? tail.split(':') : []) : null;
  if (b == null) return a.length === 8 ? a.map((x) => x.padStart(4, '0')) : null;
  const fill = 8 - a.length - b.length;
  if (fill < 0) return null;
  return [...a, ...Array(fill).fill('0'), ...b].map((x) => x.padStart(4, '0'));
}

/**
 * Where a request came from: { ip, shared, forwardedUntrusted }.
 *   shared: the address can stand for many people (the tunnel's own loopback address), so per-IP limits on it are
 *     raised rather than letting a few requests lock everyone out.
 *   forwardedUntrusted: the request carries proxy headers but no ipHeader is configured (a setup mistake to warn about).
 */
export function clientAddress(headers, socketAddress, ipHeader) {
  const sock = cleanIp(socketAddress) ?? 'unknown';
  const proxied = headers['x-forwarded-for'] != null || headers['tailscale-funnel-request'] != null || headers['cf-connecting-ip'] != null;
  if (ipHeader) {
    const name = String(ipHeader).toLowerCase();
    // X-Forwarded-For is what Tailscale Funnel sets, but any local program can send it too. It counts only on requests
    // Funnel marked as its own (Tailscale-Funnel-Request: ?1, which Funnel strips from incoming requests and sets).
    // Another header (cf-connecting-ip, or a proxy the owner configured) is trusted as configured.
    const trusted = name !== 'x-forwarded-for' || String(headers['tailscale-funnel-request'] ?? '').trim() === '?1';
    const v = trusted ? headers[name] : null;
    if (v != null) {
      const parts = String(v).split(',');
      const ip = cleanIp(parts[parts.length - 1]);
      if (ip) return { ip, shared: false, forwardedUntrusted: false };
    }
    return { ip: sock, shared: isLoopback(sock), forwardedUntrusted: false };
  }
  return { ip: sock, shared: proxied && isLoopback(sock), forwardedUntrusted: proxied };
}
