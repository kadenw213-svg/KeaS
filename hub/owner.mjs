// Owner tools, run on the KeaS server's own PC. Nothing here is reachable through the server's API.
//   node hub/owner.mjs console <path> [json]  call the owner console, e.g. `console GET /owner/stats`
//   node hub/owner.mjs setup-code             the one-time setup code, while nobody has set up this server
//   node hub/owner.mjs rotate-key             make a new owner key (the old one stops working at once)
//   node hub/owner.mjs server-id              this server's id and key fingerprint (what Kea checks it against)
//   node hub/owner.mjs where                  where the server keeps its data
//
// The owner console never receives the owner key: each call answers a fresh challenge (hub/lib/ownerauth.mjs).
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './db.mjs';
import { ownerFetch } from './lib/ownerauth.mjs';
import { writeSecretFile } from './lib/secureFile.mjs';
import { loadOrCreateKey } from './lib/tokens.mjs';

const port = Number(process.env.KEA_HUB_OWNER_PORT) || 4861;
const base = `http://127.0.0.1:${port}`;
const ownerKey = () => readFileSync(join(DATA_DIR, 'owner.key'), 'utf8').trim();

/** Makes a new owner key file in place of the old one (written next to it, locked down, then swapped in). */
export function rotateOwnerKey(dataDir = DATA_DIR) {
  const file = join(dataDir, 'owner.key');
  const tmp = `${file}.new`;
  rmSync(tmp, { force: true });
  writeSecretFile(tmp, randomBytes(32).toString('hex'));
  renameSync(tmp, file);
  return file;
}

async function main([cmd, ...args]) {
  if (cmd === 'console') {
    const [method, raw, json] = args.length === 1 ? ['GET', args[0]] : args;
    // Accept "owner/stats" too: Git Bash rewrites a leading "/owner/..." into a Windows path.
    const path = '/' + String(raw).replace(/^.*?(owner\/)/, '$1').replace(/^\/+/, '');
    const r = await ownerFetch(base, ownerKey(), method, path, json, { headers: json ? { 'content-type': 'application/json' } : {} });
    console.log(r.status, JSON.stringify(await r.json(), null, 2));
  } else if (cmd === 'setup-code') {
    const f = join(DATA_DIR, 'setup.secret');
    console.log(existsSync(f) ? readFileSync(f, 'utf8').trim() : 'This server is set up already (or hasn’t started yet).');
  } else if (cmd === 'rotate-key') {
    const file = rotateOwnerKey();
    console.log(`New owner key in ${file}. The running server uses it at once; the old key no longer works.`);
  } else if (cmd === 'server-id') {
    const f = join(DATA_DIR, 'server-identity.pem');
    if (!existsSync(f)) { console.log('No server identity yet: start the server once.'); return; }
    const { jwk } = loadOrCreateKey(f);
    console.log(`Server id: ${createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url').slice(0, 22)}`);
    console.log(`Key fingerprint: ${createHash('sha256').update(jwk.x).digest('hex').toUpperCase().match(/.{4}/g).join(' ')}`);
  } else if (cmd === 'where') {
    console.log(DATA_DIR);
  } else {
    console.log('Commands: console [METHOD] <path> [json] | setup-code | rotate-key | server-id | where');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
