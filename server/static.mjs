// Serves the built web app (web/dist) from the org server: same origin as /v1, so the session cookie just works.
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

export const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Headers every response carries (API and static). */
export const securityHeaders = () => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Files whose name never changes between builds: always revalidate.
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

function send(req, res, status, headers, body) {
  res.writeHead(status, { ...securityHeaders(), ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const notFound = (req, res) => send(req, res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Not found');

/** Resolve a URL path to a regular file strictly inside root, or null. */
function fileUnder(root, rel) {
  const full = resolve(root, '.' + rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try { return statSync(full).isFile() ? full : null; } catch { return null; }
}

export function serveStatic(req, res, webDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method not allowed');
  }
  const root = resolve(webDir);
  // Look at the raw path, before URL normalisation hides any "..".
  const raw = String(req.url || '/').split('?')[0].split('#')[0];
  let path;
  try { path = decodeURIComponent(raw); } catch { return notFound(req, res); }
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').some((seg) => seg === '..' || seg === '.')) return notFound(req, res);

  const index = fileUnder(root, '/index.html');
  if (!index) {
    return send(req, res, 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'The KeaS web app is not built yet. Run "npm run web:build" and reload.');
  }
  let file = path === '/' ? index : fileUnder(root, path);
  let servedPath = path === '/' ? '/index.html' : path;
  // Client routes (no file extension) get the app; a missing file with an extension is a real 404.
  if (!file) {
    if (extname(path) || path.startsWith('/assets/')) return notFound(req, res);
    file = index;
    servedPath = '/index.html';
  }
  const ext = extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const cache = NO_CACHE.has(servedPath) ? 'no-cache' : servedPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  const headers = { 'content-type': type, 'cache-control': cache };
  if (ext === '.html' || ext === '.svg') headers['content-security-policy'] = CSP;
  if (servedPath === '/sw.js') headers['service-worker-allowed'] = '/';
  return send(req, res, 200, headers, readFileSync(file));
}
