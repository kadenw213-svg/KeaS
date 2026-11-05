// Owner tools, run on the Hub's own PC. Nothing here is reachable through the Hub's API.
//   node hub/owner.mjs make-owner <email>     the account must exist (sign up in Kea or KeaS first)
//   node hub/owner.mjs console <path> [json]  call the owner console, e.g. `console GET /owner/stats`
//   node hub/owner.mjs publish-terms [file]   publish edited terms (hub/terms/terms.json); everyone re-agrees
//   node hub/owner.mjs where                  where the Hub keeps its data
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, DATA_DIR } from './db.mjs';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'make-owner') {
  const email = String(args[0] || '').trim().toLowerCase();
  if (!email) { console.error('Usage: node hub/owner.mjs make-owner <email>'); process.exit(1); }
  const h = openDb(join(DATA_DIR, 'hub.db'));
  const a = h.get('SELECT * FROM accounts WHERE email = ?', email);
  if (!a) { console.error(`No account for ${email}. Create it in Kea or KeaS first.`); process.exit(1); }
  h.run("UPDATE accounts SET role = 'owner', can_host = 1, email_verified = 1, verified_by = 'owner', identity_verified = 1, updated_at = ? WHERE id = ?", Date.now(), a.id);
  h.run('INSERT INTO audit (at,actor,action,target,ip) VALUES (?,?,?,?,?)', Date.now(), 'local-cli', 'owner.make_owner', a.id, 'local');
  console.log(`${email} is now the Hub owner.`);
  if (!a.totp_enabled) console.log('Next: turn on two-step sign-in for this account (Settings → Security). The owner account can’t turn it off again.');
  h.close();
} else if (cmd === 'console') {
  const [method, raw, json] = args.length === 1 ? ['GET', args[0]] : args;
  // Accept "owner/stats" too: Git Bash rewrites a leading "/owner/..." into a Windows path.
  const path = '/' + String(raw).replace(/^.*?(owner\/)/, '$1').replace(/^\/+/, '');
  const key = readFileSync(join(DATA_DIR, 'owner.key'), 'utf8').trim();
  const port = Number(process.env.KEA_HUB_OWNER_PORT) || 4861;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-kea-owner-key': key, 'content-type': 'application/json' }, body: json });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
} else if (cmd === 'publish-terms') {
  // Edit hub/terms/terms.json (keep each section's id the same when you only change its wording; give new sections
  // new ids), then run this. Everyone has to agree again before they can use the Hub; the apps show only what changed.
  const file = args[0] || new URL('./terms/terms.json', import.meta.url);
  const key = readFileSync(join(DATA_DIR, 'owner.key'), 'utf8').trim();
  const port = Number(process.env.KEA_HUB_OWNER_PORT) || 4861;
  const r = await fetch(`http://127.0.0.1:${port}/owner/terms`, { method: 'POST', headers: { 'x-kea-owner-key': key, 'content-type': 'application/json' }, body: readFileSync(file, 'utf8') });
  const j = await r.json();
  if (!r.ok) { console.error(j.error); process.exit(1); }
  console.log(j.published ? `Published terms version ${j.n}. Everyone will be asked to agree again.` : `Nothing changed; version ${j.n} is still current.`);
} else if (cmd === 'where') {
  console.log(DATA_DIR);
} else {
  console.log('Commands: make-owner <email> | publish-terms [file] | console [METHOD] <path> [json] | where');
}
