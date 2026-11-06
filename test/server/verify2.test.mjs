// Regression tests from the second verification pass: what a pay-run approval covers, the bank file of a finalized run,
// new rates next to position rates (by hand and by import), the columns sealed last, and claiming an empty vault.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sign as edSign } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/index.mjs';
import { openDb } from '../../server/db.mjs';
import { makeVault } from '../../server/payroll/vaultstate.mjs';
import { isSealed } from '../../server/lib/vault.mjs';
import { keyFingerprint } from '../../server/payroll/hub.mjs';
import { loadOrCreateKey, signToken } from '../../hub/lib/tokens.mjs';

const SHARED = fileURLToPath(new URL('../../shared/', import.meta.url));
let dir, app, base, owner, pay, pr;
async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (personId) => (await call('POST', '/v1/auth/demo-login', null, { personId })).body.token;
const imp = async (rows) => (await call('POST', '/v1/import/commit', pay, { kind: 'employees', csv: rows.map((r) => r.join(',')).join('\n') })).body;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keas-verify2-'));
  // Tables marked verified for the preview's year, in a temp copy only.
  const probe = createApp({ dbFile: join(dir, 'probe.db'), log: false, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await probe.listen(0)}`;
  const year = (await call('GET', '/v1/payrun/preview', await login('p03'))).body.year;
  await probe.close();
  const d = join(dir, 'tables');
  cpSync(SHARED, d, { recursive: true });
  for (const code of ['US', 'CO']) {
    const t = JSON.parse(readFileSync(join(d, 'tax', `${code}-2026.json`), 'utf8'));
    writeFileSync(join(d, 'tax', `${code}-${year}.json`), JSON.stringify({ ...t, year, verified: true }));
    const l = JSON.parse(readFileSync(join(d, 'labor', `${code}.json`), 'utf8'));
    writeFileSync(join(d, 'labor', `${code}.json`), JSON.stringify({ ...l, verifiedFor: year }));
  }
  app = createApp({ dbFile: join(dir, 'org.db'), log: false, sharedDir: d, devKeyFile: true, demo: true });
  base = `http://127.0.0.1:${await app.listen(0)}`;
  owner = await login('p01');
  pay = await login('p03');
  pr = (await call('GET', '/v1/payrun/preview', pay)).body;
});
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test('HIGH: deposit accounts are part of what a pay run approval covers, and a finalized run’s bank file never reads today’s accounts', async () => {
  const period = pr.period.start;
  await call('POST', '/v1/approval-chains', owner, { kind: 'payrun', name: 'Owner signs pay runs', steps: [{ type: 'role', role: 'owner' }] });
  for (const l of pr.lines) await call('POST', '/v1/timecards/approve', owner, { personId: l.personId, periodStart: period });
  assert.equal((await call('POST', '/v1/entities', owner, { name: 'Victim Org LLC', ein: '12-3456789', bank: { name: 'Victim Org', companyId: '1234567890', originRouting: '011000015', destinationRouting: '011000015' } })).status < 300, true);
  for (const l of pr.lines) await call('POST', `/v1/people/${l.personId}/deposit`, owner, { routing: '011000015', account: `1111${l.personId}` });
  const victim = pr.lines.find((l) => l.personId !== 'p03' && l.net > 0).personId;

  const sub = await call('POST', '/v1/payrun/submit', pay, { periodStart: period });
  assert.equal((await call('POST', `/v1/approvals/${sub.body.approval.id}/decide`, owner, { approve: true })).status, 200);

  // No bank file before the approved run is finalized.
  assert.equal((await call('GET', `/v1/payrun/nacha?periodStart=${period}`, pay)).status, 409);
  // The preview itself never carries full account numbers.
  const preview = await call('GET', `/v1/payrun/preview?periodStart=${period}`, pay);
  assert.ok(!JSON.stringify(preview.body).includes(`1111${victim}`));

  // Redirecting a coworker's pay after approval: finalizing is refused until it's approved again.
  assert.equal((await call('POST', `/v1/people/${victim}/deposit`, pay, { routing: '011000015', account: '666666666' })).status, 200);
  const after1 = (await call('GET', `/v1/payrun/preview?periodStart=${period}`, pay)).body;
  assert.equal(after1.canFinalize, false);
  assert.equal(after1.approval.changedSinceApproval, true);
  assert.equal((await call('POST', '/v1/payrun/finalize', pay, { periodStart: period })).status, 409);

  // Putting the approved account back restores the approved run, which finalizes.
  await call('POST', `/v1/people/${victim}/deposit`, owner, { routing: '011000015', account: `1111${victim}` });
  assert.equal((await call('POST', '/v1/payrun/finalize', pay, { periodStart: period })).status, 201);

  // Changing the account afterwards doesn't change this run's file.
  await call('POST', `/v1/people/${victim}/deposit`, pay, { routing: '011000015', account: '777777777' });
  const file = await call('GET', `/v1/payrun/nacha?periodStart=${period}`, pay);
  assert.equal(file.status, 200);
  assert.equal(file.body.finalized, true);
  assert.ok(file.body.text.includes(`1111${victim}`.toUpperCase()));
  assert.ok(!file.body.text.includes('777777777') && !file.body.text.includes('666666666'));

  // The destinations are sealed with the line.
  const raw = new DatabaseSync(join(dir, 'org.db'), { readOnly: true });
  try {
    for (const r of raw.prepare('SELECT deposits FROM payrun_lines').all()) assert.ok(isSealed(r.deposits));
  } finally { raw.close(); }

  // A run finalized before destinations were stored is skipped, never paid from today's accounts.
  app.h.rawWrites(() => app.h.run('UPDATE payrun_lines SET deposits = NULL WHERE person_id = ?', victim));
  const legacy = await call('GET', `/v1/payrun/nacha?periodStart=${period}`, pay);
  assert.ok(legacy.body.skipped.some((s) => s.personId === victim));
  assert.ok(!legacy.body.text.includes('777777777'));
});

test('MED-LOW: a new default rate next to position rates: higher or back-dated goes to the raise approval, by hand and by import', async () => {
  const person = async (name, email) => {
    const id = (await call('POST', '/v1/people', owner, { name, hireDate: '2024-01-01', status: 'active', email, positions: ['pos-lg'] })).body.profile.id;
    assert.equal((await call('POST', `/v1/people/${id}/rates`, owner, { positionId: 'pos-lg', rateCents: 1500, effectiveFrom: '2024-01-01' })).status, 201);
    return id;
  };
  const rates = (id) => app.h.all('SELECT position_id, rate_cents FROM pay_rates WHERE person_id = ?', id).map((x) => ({ ...x }));
  const today = new Date().toISOString().slice(0, 10);

  const a = await person('Pos Only', 'posonly@x.test');
  const direct = await call('POST', `/v1/people/${a}/rates`, pay, { rateCents: 9000, effectiveFrom: today });
  assert.equal(direct.status, 202);
  assert.equal(direct.body.needsApproval, true);
  assert.equal((await call('POST', `/v1/people/${a}/rates`, pay, { rateCents: 1400, effectiveFrom: '2024-01-01' })).status, 202, 'back-dated');
  assert.deepEqual(rates(a), [{ position_id: 'pos-lg', rate_cents: 1500 }]);
  // Lower and not back-dated: nothing to approve.
  assert.equal((await call('POST', `/v1/people/${a}/rates`, pay, { rateCents: 1400, effectiveFrom: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) })).status, 201);

  const b = await person('Pos Two', 'postwo@x.test');
  const r = await imp([['name', 'email', 'pay rate', 'hire date'], ['Pos Two', 'postwo@x.test', '90.00', '2020-01-01']]);
  assert.equal(r.raises, 1);
  assert.deepEqual(rates(b), [{ position_id: 'pos-lg', rate_cents: 1500 }]);
  assert.equal(app.h.get('SELECT pay_rate_cents FROM people WHERE id = ?', b).pay_rate_cents, null, 'nothing paid at the imported rate meanwhile');
  assert.ok(app.h.all('SELECT new_rate_cents FROM raises WHERE person_id = ?', b).some((x) => x.new_rate_cents === 9000));

  // The owner's import still applies directly.
  const c = await person('Pos Three', 'posthree@x.test');
  const o = (await call('POST', '/v1/import/commit', owner, { kind: 'employees', csv: 'name,email,pay rate\nPos Three,posthree@x.test,90.00' })).body;
  assert.equal(o.raises, 0);
  assert.ok(rates(c).some((x) => x.position_id === null && x.rate_cents === 9000));

  // An hourly rate can't pass as lower than a salary because of its unit.
  const s = (await call('POST', '/v1/people', owner, { name: 'Sal Aried', payRateCents: 6000000, payKind: 'salary', hireDate: '2024-01-01', status: 'active', positions: ['pos-lg'] })).body.profile.id;
  assert.equal((await call('POST', `/v1/people/${s}/rates`, pay, { positionId: 'pos-hg', kind: 'hourly', rateCents: 5999999, effectiveFrom: today })).status, 202);
});

test('LOW: names, expense amounts and notes are sealed in the file; the app still lists people by name', async () => {
  const e = await call('POST', '/v1/expenses', owner, { personId: 'p05', date: pr.period.start, amountCents: 4242, description: 'needle-expense-text' });
  assert.equal(e.status, 201);
  assert.equal(e.body.expense.amountCents, 4242);
  assert.equal(e.body.expense.description, 'needle-expense-text');
  const raw = new DatabaseSync(join(dir, 'org.db'), { readOnly: true });
  try {
    for (const r of raw.prepare('SELECT name FROM people').all()) assert.ok(isSealed(r.name));
    for (const r of raw.prepare('SELECT amount_cents, description FROM expenses').all()) { assert.ok(isSealed(r.amount_cents)); assert.ok(isSealed(r.description)); }
    for (const r of raw.prepare('SELECT reason FROM raises WHERE reason IS NOT NULL').all()) assert.ok(isSealed(r.reason));
  } finally { raw.close(); }
  const names = (await call('GET', '/v1/payrun/preview', pay)).body.lines.map((l) => l.name);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test('LOW: a vault from before those columns were sealed has their plaintext sealed at its next unlock', () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-verify2-up-'));
  const file = join(d, 'old.db');
  const PASS = 'summer camp payroll vault';
  try {
    let h = openDb(file);
    let v = makeVault(h);
    v.create(PASS);
    h.run(`INSERT INTO orgs (id,name,state,tz,pay_period_anchor) VALUES ('o','Org','CO','America/Denver','2026-01-04')`);
    h.run(`INSERT INTO people (id,org_id,name) VALUES ('p','o','Old Plain Name')`);
    h.run(`INSERT INTO expenses (id,org_id,person_id,date,kind,category,description,amount_cents,created_at) VALUES ('e','o','p','2026-01-05','receipt','Food','Old plain note',1234,'2026-01-05')`);
    h.rawWrites(() => {
      h.db.prepare(`UPDATE people SET name = 'Old Plain Name' WHERE id = 'p'`).run();
      h.db.prepare(`UPDATE expenses SET description = 'Old plain note', amount_cents = 1234 WHERE id = 'e'`).run();
      h.db.prepare(`DELETE FROM vault_meta WHERE k = 'sealed_columns'`).run(); // an older KeaS's list didn't name them
    });
    v.lock();
    h.close();

    h = openDb(file);
    v = makeVault(h);
    assert.equal(v.unlock(PASS), true);
    const row = h.db.prepare(`SELECT p.name, e.description, e.amount_cents FROM people p, expenses e`).get();
    for (const x of Object.values(row)) assert.ok(isSealed(x));
    assert.equal(h.get(`SELECT id, name FROM people`).name, 'Old Plain Name');
    assert.equal(h.get(`SELECT id, amount_cents FROM expenses`).amount_cents, 1234);
    // Once sealed, a planted plain value is refused rather than sealed.
    h.rawWrites(() => h.db.prepare(`UPDATE people SET name = 'Planted'`).run());
    assert.throws(() => h.get('SELECT id, name FROM people'), /sealed/);
    h.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('LOW: only the app’s payroll window can claim an empty vault, and a Hub on another PC gets no password until its key is confirmed', async () => {
  const d = mkdtempSync(join(tmpdir(), 'keas-verify2-setup-'));
  const key = loadOrCreateKey(join(d, 'hub.key')), other = loadOrCreateKey(join(d, 'other.key'));
  let signer = key;
  const seen = [];
  const hub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const b = body ? JSON.parse(body) : {};
      seen.push(req.url);
      if (req.url === '/v1/keys') return send(200, { keys: [signer.jwk] });
      if (req.url.startsWith('/v1/identity?')) {
        const n = new URL(req.url, 'http://x').searchParams.get('nonce');
        return send(200, { kid: signer.kid, sig: edSign(null, Buffer.from(`kea-hub-identity:v1:${n}`), signer.privateKey).toString('base64url') });
      }
      if (req.url === '/v1/auth/login') return send(200, { token: 'hub-session' });
      if (req.url === '/v1/auth/token') {
        const t = Math.floor(Date.now() / 1000);
        return send(200, { token: signToken(signer, { iss: 'kea-hub', sub: 'acct', aud: b.aud, iat: t, exp: t + 300, email: 'pat@example.org', name: 'Pat', ev: true, jti: 'x' }) });
      }
      send(200, { ok: true });
    });
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  const hubUrl = `http://127.0.0.1:${hub.address().port}`;
  const a = createApp({ dbFile: join(d, 'v.db'), log: false, vault: true, hubUrl });
  const b = `http://127.0.0.1:${await a.listen(0)}`;
  const post = async (extra, signIn = {}) => {
    const r = await fetch(`${b}/v1/vault/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'summer camp payroll vault', org: { name: 'Camp', state: 'TX' }, admin: { name: 'Pat', email: 'pat@example.org' }, signIn: { password: 'secret', ...signIn }, ...extra }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    assert.ok(a.setupToken && a.setupToken.length >= 32, 'a token is made when none is given');
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ setupToken: 'guess' })).status, 403);
    assert.equal((await fetch(`${b}/v1/vault/setup-hub-key?token=guess`)).status, 403);
    assert.ok(!seen.includes('/v1/auth/login'));

    // With the token, the fingerprint must be confirmed first, and must be the key the Hub still holds.
    const noFp = await post({ setupToken: a.setupToken });
    assert.equal(noFp.status, 409);
    assert.equal(noFp.body.confirmHubKey, true);
    const shown = await (await fetch(`${b}/v1/vault/setup-hub-key?token=${a.setupToken}`)).json();
    assert.equal(shown.ownHub, false);
    assert.equal(shown.fingerprint, keyFingerprint([key.jwk]));
    signer = other; // another program takes the Hub's address after the owner compared the fingerprint
    assert.equal((await post({ setupToken: a.setupToken }, { hubKeyFingerprint: shown.fingerprint })).status, 409);
    assert.ok(!seen.includes('/v1/auth/login'), 'no password reached it');
    assert.equal(a.vault.initialized(), false);

    signer = key;
    const ok = await post({ setupToken: a.setupToken }, { hubKeyFingerprint: shown.fingerprint });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(a.vault.initialized(), true);
  } finally { await a.close(); hub.close(); rmSync(d, { recursive: true, force: true }); }
});
