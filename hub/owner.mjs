// Owner tools, run on the Hub's own PC. Nothing here is reachable through the Hub's API.
//   node hub/owner.mjs make-owner <email>     the account must exist (sign up in Kea or KeaS first); turns on its
//                                             two-step sign-in here if it isn't on yet (owner powers need it)
//   node hub/owner.mjs console <path> [json]  call the owner console, e.g. `console GET /owner/stats`
//   node hub/owner.mjs publish-terms [file]   publish edited terms (hub/terms/terms.json); everyone re-agrees
//   node hub/owner.mjs rotate-key             make a new owner key (the old one stops working at once)
//   node hub/owner.mjs where                  where the Hub keeps its data
//
// The owner console never receives the owner key: each call answers a fresh challenge (hub/lib/ownerauth.mjs).
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { openDb, DATA_DIR } from './db.mjs';
import { ownerFetch } from './lib/ownerauth.mjs';
import { writeSecretFile } from './lib/secureFile.mjs';
import { loadOrCreateKey } from './lib/tokens.mjs';
import { newSecret, checkCode, otpauthUri, totpKeyFrom, sealSecret } from './lib/totp.mjs';

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

/** Turns on two-step sign-in for an account here, on the Hub's PC: shows the secret, then checks a code typed back. */
async function enrollTotp(h, a) {
  const secret = newSecret();
  console.log('\nThe Hub owner account must use two-step sign-in. Add this to your authenticator app:');
  console.log(`  secret: ${secret}`);
  console.log(`  link:   ${otpauthUri(secret, a.email)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let i = 0; i < 3; i++) {
      const code = (await rl.question('Then type the 6-digit code it shows: ')).trim();
      const step = checkCode(secret, code, Date.now(), -1);
      if (step != null) {
        const key = loadOrCreateKey(join(DATA_DIR, 'hub-signing-key.pem'));
        h.run('UPDATE accounts SET totp_secret = ?, totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?', sealSecret(totpKeyFrom(key.privateKey), secret, a.id), step, Date.now(), a.id);
        h.run('INSERT INTO audit (at,actor,action,target,ip) VALUES (?,?,?,?,?)', Date.now(), 'local-cli', 'account.totp_on', a.id, 'local');
        return true;
      }
      console.log('That code is wrong. Check the time on your phone and try the newest code.');
    }
  } finally { rl.close(); }
  return false;
}

async function main([cmd, ...args]) {
  if (cmd === 'make-owner') {
    const email = String(args[0] || '').trim().toLowerCase();
    if (!email) { console.error('Usage: node hub/owner.mjs make-owner <email>'); process.exit(1); }
    const h = openDb(join(DATA_DIR, 'hub.db'));
    const a = h.get('SELECT * FROM accounts WHERE email = ?', email);
    if (!a) { console.error(`No account for ${email}. Create it in Kea or KeaS first.`); process.exit(1); }
    // Two-step sign-in first: without it, owner powers stay off (here and in the apps).
    if (!a.totp_enabled && !(await enrollTotp(h, a))) { console.error('Two-step sign-in wasn’t turned on, so the account wasn’t made the owner. Run this again.'); h.close(); process.exit(1); }
    h.run("UPDATE accounts SET role = 'owner', can_host = 1, email_verified = 1, verified_by = 'owner', identity_verified = 1, updated_at = ? WHERE id = ?", Date.now(), a.id);
    h.run('INSERT INTO audit (at,actor,action,target,ip) VALUES (?,?,?,?,?)', Date.now(), 'local-cli', 'owner.make_owner', a.id, 'local');
    console.log(`${email} is now the Hub owner, with two-step sign-in on (it can’t be turned off for the owner).`);
    h.close();
  } else if (cmd === 'console') {
    const [method, raw, json] = args.length === 1 ? ['GET', args[0]] : args;
    // Accept "owner/stats" too: Git Bash rewrites a leading "/owner/..." into a Windows path.
    const path = '/' + String(raw).replace(/^.*?(owner\/)/, '$1').replace(/^\/+/, '');
    const r = await ownerFetch(base, ownerKey(), method, path, json, { headers: json ? { 'content-type': 'application/json' } : {} });
    console.log(r.status, JSON.stringify(await r.json(), null, 2));
  } else if (cmd === 'publish-terms') {
    // Edit hub/terms/terms.json (keep each section's id the same when you only change its wording; give new sections
    // new ids), then run this. Everyone has to agree again before they can use the Hub; the apps show only what changed.
    const file = args[0] || new URL('./terms/terms.json', import.meta.url);
    const r = await ownerFetch(base, ownerKey(), 'POST', '/owner/terms', readFileSync(file, 'utf8'), { headers: { 'content-type': 'application/json' } });
    const j = await r.json();
    if (!r.ok) { console.error(j.error); process.exit(1); }
    console.log(j.published ? `Published terms version ${j.n}. Everyone will be asked to agree again.` : `Nothing changed; version ${j.n} is still current.`);
  } else if (cmd === 'rotate-key') {
    const file = rotateOwnerKey();
    console.log(`New owner key in ${file}. The running Hub uses it at once; the old key no longer works.`);
  } else if (cmd === 'where') {
    console.log(DATA_DIR);
  } else {
    console.log('Commands: make-owner <email> | publish-terms [file] | console [METHOD] <path> [json] | rotate-key | where');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
