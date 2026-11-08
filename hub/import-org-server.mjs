// One-time import of a KeaS org server's people, positions, shifts, punches, missed-punch requests and timecard
// approvals into an organization on this Kea Hub (org/import.mjs). People are matched to Hub accounts by the account
// their payroll sign-in is linked to, then by email; the report lists everyone it couldn't match. Running it again
// brings in only what's missing.
//
//   node hub/import-org-server.mjs --server <org.db> --org <orgId> [--hub-data <folder>] [--server-org <id>]
//        [--match <serverPersonId>=<accountId> ...] [--by <accountId>] [--dry-run]
//
// The org server's vault passphrase (people's names and emails are sealed): KEAS_VAULT_PASSPHRASE, or the
// .vaultkey file beside its database (development copies only).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb as openHubDb, DATA_DIR } from './db.mjs';
import { hubIdentity } from './orgIdentity.mjs';
import { mountOrg } from '../org/index.mjs';
import { openDb as openServerDb } from '../server/db.mjs';
import { makeVault } from '../server/payroll/vaultstate.mjs';
import { readFileSync } from 'node:fs';

export function runImport({ hubData = DATA_DIR, server, org, serverOrg = null, match = {}, by = 'import', dryRun = false, passphrase = process.env.KEAS_VAULT_PASSPHRASE || null }) {
  if (!server || !existsSync(server)) throw new Error('Name the org server’s database with --server.');
  if (!org) throw new Error('Name the organization to import into with --org (its id is in Kea, Work, or /owner/orgs).');
  const src = openServerDb(server);
  const h = openHubDb(join(hubData, 'hub.db'));
  try {
    const vault = makeVault(src);
    if (!vault.initialized()) throw new Error('That org server database has no vault set up; there is nothing to import.');
    const keyFile = server + '.vaultkey';
    const pass = passphrase || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : null);
    if (!pass || !vault.unlock(pass)) throw new Error('The org server’s vault didn’t open. Set KEAS_VAULT_PASSPHRASE to its passphrase.');
    const getSetting = (k, d) => { const r = h.get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : d; };
    const audit = (actor, action, target, detail, ip) => h.run('INSERT INTO audit (at,actor,action,target,detail,ip) VALUES (?,?,?,?,?,?)', Date.now(), actor, action, target, detail == null ? null : JSON.stringify(detail), ip ?? null);
    const engine = mountOrg({ R: () => {}, h, audit, identity: hubIdentity({ h, now: Date.now, extrasFor: () => ({}), getSetting }) });
    return engine.importServerOrg({ src, orgId: org, serverOrgId: serverOrg, by, match, dryRun });
  } finally {
    src.close();
    h.close();
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const match = {};
  a.forEach((x, i) => { if (x === '--match' && a[i + 1]?.includes('=')) { const [p, acc] = a[i + 1].split('='); match[p] = acc; } });
  try {
    const report = runImport({ hubData: opt('--hub-data') || DATA_DIR, server: opt('--server'), org: opt('--org'), serverOrg: opt('--server-org'), by: opt('--by') || 'import', match, dryRun: a.includes('--dry-run') });
    console.log(JSON.stringify(report, null, 2));
    if (report.people.unmatched.length) console.log(`\n${report.people.unmatched.length} people weren’t matched to a Kea account. Their punches stay on the org server; run this again once they have one, or match them with --match.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
