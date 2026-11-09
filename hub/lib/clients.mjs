// Which Kea app a request comes from, whether it's too old for this server, and the newest versions of the apps
// (docs/protocol.md section 0, "Versions"). The same file is KeaC's server/lib/clients.mjs and KeaS's hub/lib/clients.mjs: keep them the same.
//
// Apps say who they are in one header: `X-Kea-Client: <app>/<version>` (`Kea-Client` is read too), e.g. `Kea/0.85.0`,
// `Kea-Phone/0.85.0`, `KeaS/0.9.0`. A request without it, or without a version (the phone before 0.85 sent
// "Kea for Android"), is served exactly as before: only an app that says it is older than the minimum is turned away.

/** The protocol this server speaks. Raised only for a break no older app can follow (docs/DEVELOPING.md). */
export const PROTOCOL = 1;

/** The oldest version of each app this server still serves (an app below it gets 426 with where to update). */
export const MIN_CLIENTS = Object.freeze({ kea: '0.80.0', keaPhone: '0.80.0', keas: '0.6.0' });

/** Where each app updates from (the phone's APK is attached to Kea's releases). */
export const UPDATE_URLS = Object.freeze({
  kea: 'https://github.com/kadenw213-svg/kea/releases/latest',
  keaPhone: 'https://github.com/kadenw213-svg/kea/releases/latest',
  keas: 'https://github.com/kadenw213-svg/KeaS/releases/latest',
});

/** The public feeds the newest versions are read from (electron-updater's latest.yml on each app's latest release). */
export const RELEASE_FEEDS = Object.freeze({
  kea: 'https://github.com/kadenw213-svg/kea/releases/latest/download/latest.yml',
  keas: 'https://github.com/kadenw213-svg/KeaS/releases/latest/download/latest.yml',
});

const NAMES = { kea: 'kea', 'kea-pc': 'kea', 'kea-phone': 'keaPhone', keas: 'keas', keac: 'keac' };
const SEMVER = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$/;

/** A plain x.y.z (a leading v and any -pre/+build dropped), or null. */
export function cleanVersion(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** Compares two versions: negative, 0 or positive. Anything unreadable counts as 0.0.0. */
export function compareVersions(a, b) {
  const pa = (cleanVersion(a) ?? '0.0.0').split('.').map(Number);
  const pb = (cleanVersion(b) ?? '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The app and version a request says it comes from: { app: 'kea' | 'keaPhone' | 'keas' | 'keac' | null, version: 'x.y.z' | null }.
 * `headers` is a Node request's headers (lower-case names) or a plain string.
 */
export function clientOf(headers) {
  const raw = typeof headers === 'string' ? headers : String(headers?.['x-kea-client'] ?? headers?.['kea-client'] ?? '');
  // (What the phone sent before it said its version.)
  if (/^\s*kea for android\b/i.test(raw)) return { app: 'keaPhone', version: null };
  // "<name>/<version> <anything else>" or just "<name>".
  const m = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*(?:\/\s*(\S{1,60}))?(?:\s.*)?$/.exec(raw.slice(0, 200));
  if (!m) return { app: null, version: null };
  const app = NAMES[m[1].trim().toLowerCase()] ?? null;
  return { app, version: app ? cleanVersion(m[2]) : null };
}

/**
 * Whether the client is too old for `minClients`: null (fine, or it didn't say), or { app, version, minVersion }.
 * Only an app that names itself and its version can be too old.
 */
export function tooOld(client, minClients = MIN_CLIENTS) {
  if (!client?.app || !client.version) return null;
  const min = cleanVersion(minClients?.[client.app]);
  if (!min || compareVersions(client.version, min) >= 0) return null;
  return { app: client.app, version: client.version, minVersion: min };
}

/** What a too-old app is told, in its own words. `server`: 'keac' (the Kea account server) or 'keas'. */
export function tooOldMessage(app, server = 'keac') {
  if (app === 'keas') return 'Update KeaS to keep signing people in with their Kea accounts.';
  if (app === 'keac') return 'Update KeaC to keep using this server.';
  return server === 'keas' ? 'Update Kea to keep using this organization’s server.' : 'Update Kea to keep using your Kea account.';
}

/** The 426 body for a too-old client. */
export function tooOldBody(old, server = 'keac', updateUrls = UPDATE_URLS) {
  return { error: tooOldMessage(old.app, server), upgradeRequired: true, app: old.app, version: old.version, minVersion: old.minVersion, updateUrl: updateUrls[old.app] ?? null };
}

/** Each app's minimum: the defaults, then the server's option, then the owner's setting (each only where it's a version). */
export function mergeMins(...layers) {
  const out = { ...MIN_CLIENTS };
  for (const l of layers) for (const k of Object.keys(MIN_CLIENTS)) { const v = cleanVersion(l?.[k]); if (v) out[k] = v; }
  return out;
}

/** The newer of two versions (either may be null). */
export const newer = (a, b) => { const x = cleanVersion(a), y = cleanVersion(b); return !x ? y : !y ? x : compareVersions(x, y) >= 0 ? x : y; };

/** The version in an electron-updater latest.yml, or null. */
export function versionFromFeed(text) {
  const m = /^version:\s*['"]?([^'"\s]+)/m.exec(String(text ?? ''));
  return m ? cleanVersion(m[1]) : null;
}

/**
 * Keeps the newest released version of each app, read from the public release feeds now and every `everyMs`
 * (6 hours). A feed that can't be read keeps the last version found. `feeds: null` reads nothing (tests, and a
 * server run without a network). `latest()` is { kea, keas } (strings or null) plus `checkedAt` and `error`.
 */
export function releaseWatcher({ feeds = RELEASE_FEEDS, fetchImpl = globalThis.fetch, everyMs = 6 * 3600_000, timeoutMs = 15_000, now = () => Date.now() } = {}) {
  const found = { kea: null, keas: null };
  let checkedAt = null, error = null, timer = null, running = null;
  async function refresh() {
    if (!feeds) return latest();
    if (running) return running;
    running = (async () => {
      const errors = [];
      for (const [app, url] of Object.entries(feeds)) {
        if (!url) continue;
        try {
          const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/yaml, text/plain, */*' } });
          if (!r.ok) throw new Error(`${r.status}`);
          const v = versionFromFeed(await r.text());
          if (!v) throw new Error('no version in the feed');
          found[app] = newer(found[app], v);
        } catch (e) { errors.push(`${app}: ${e?.message || e}`); }
      }
      checkedAt = now();
      error = errors.length ? errors.join('; ') : null;
      return latest();
    })().finally(() => { running = null; });
    return running;
  }
  function latest() { return { ...found, checkedAt, error }; }
  if (feeds) {
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), everyMs);
    timer.unref?.();
  }
  return { latest, refresh, stop: () => clearInterval(timer) };
}
