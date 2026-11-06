// Setting up and signing in to the payroll vault: the payroll admin's Kea Hub account (or a local account when the Hub
// can't be reached) plus the vault passphrase, which unlocks the encrypted data for this run of the server.
import { hashLocalPassword, checkLocalPassword } from '../lib/vault.mjs';
import { HubUnreachable, HubRefused } from './hub.mjs';
import { addDays, weekStartOf } from '../lib/time.mjs';

export function registerVaultAuth(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, hub, now, iso } = c;
  const hubUrl = () => vault.setting('hubUrl', c.defaultHubUrl || null);
  const fails = { n: 0, until: 0 };
  const guard = () => { if (now() < fails.until) throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil((fails.until - now()) / 1000)} seconds.`); };
  const failed = () => { fails.n++; if (fails.n >= 5) fails.until = now() + Math.min(15 * 60000, 30000 * 2 ** (fails.n - 5)); };

  route('GET', '/v1/vault/status', () => ({
    mode: c.mode, initialized: vault.initialized(), locked: !vault.unlocked(), hubUrl: hubUrl(),
    org: vault.initialized() ? h.get('SELECT name FROM orgs LIMIT 1')?.name ?? null : null,
    localAccounts: !!h.get('SELECT 1 FROM vault_users WHERE local_pw IS NOT NULL'),
  }), { auth: false, open: true });

  /** Check the person at the Hub (or locally); returns the vault user row or throws. */
  async function identify(user, { mode, email, password, code }) {
    if (mode === 'local') {
      if (!user?.local_pw || !checkLocalPassword(password, user.local_pw)) return null;
      return user;
    }
    let who;
    try { who = await hub.signIn(hubUrl(), { email, password, code }); }
    catch (e) {
      if (e instanceof HubUnreachable) throw new HttpError(503, e.message, { hubUnreachable: true, localAvailable: !!user?.local_pw });
      if (e instanceof HubRefused) { if (e.status === 401 || e.status === 403) return null; throw new HttpError(e.status === 429 ? 429 : 400, e.message, { hub: true }); }
      throw e;
    }
    if (!user || who.email !== user.email || (user.hub_sub && user.hub_sub !== who.sub)) return null;
    if (!user.hub_sub) h.run('UPDATE vault_users SET hub_sub = ? WHERE id = ?', who.sub, user.id);
    return user;
  }

  route('POST', '/v1/vault/setup', async ({ body, secure }) => {
    if (c.mode !== 'vault') throw new HttpError(404, 'not found');
    if (vault.initialized()) throw new HttpError(409, 'This vault is already set up. Sign in instead.');
    const passphrase = V.str(body.passphrase, 'passphrase', { min: 12, max: 500 });
    const o = body.org || {}, a = body.admin || {}, s = body.signIn || {};
    const email = V.str(a.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    const name = V.str(a.name, 'name', { min: 1, max: 120 });
    const state = V.str(o.state, 'state', { min: 2, max: 2 }).toUpperCase();
    const tz = V.str(o.tz ?? 'America/Denver', 'tz', { min: 3, max: 60 });
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { bad('unknown time zone'); }
    const mode = V.enum(s.mode ?? 'hub', 'signIn.mode', ['hub', 'local']);
    if (body.hubUrl) vault.setSetting('hubUrl', V.str(body.hubUrl, 'hubUrl', { max: 300 }));
    let hubSub = null, localPw = null;
    if (mode === 'hub') {
      try { const who = await hub.signIn(hubUrl(), { email, password: s.password, code: s.code }); if (who.email !== email) bad('That Kea Hub account has a different email.'); hubSub = who.sub; }
      catch (e) { if (e instanceof HubUnreachable) throw new HttpError(503, e.message, { hubUnreachable: true }); if (e instanceof HubRefused) throw new HttpError(401, e.message); throw e; }
      if (s.localPassword) localPw = hashLocalPassword(V.str(s.localPassword, 'localPassword', { min: 10, max: 300 }));
    } else localPw = hashLocalPassword(V.str(s.password, 'password', { min: 10, max: 300 }));
    vault.create(passphrase);
    const orgId = uid('org'), pid = uid('p');
    const today = new Date(now()).toISOString().slice(0, 10);
    const anchor = o.payPeriodAnchor ? V.date(o.payPeriodAnchor, 'payPeriodAnchor') : weekStartOf(today, 0);
    h.tx(() => {
      h.run(`INSERT INTO orgs (id,name,state,tz,pay_frequency,pay_period_anchor,futa_exempt,suta_rate,bank,settings) VALUES (?,?,?,?,?,?,?,?,?,?)`, orgId, V.str(o.name, 'org name', { min: 1, max: 120 }), state, tz, 'biweekly', anchor, o.futaExempt ? 1 : 0, Number(o.sutaRate) || 0, '{}', '{}');
      h.run(`INSERT INTO people (id,org_id,name,email,roles,positions,status,w4,ytd_wages_cents,hire_date) VALUES (?,?,?,?,?,?,?,?,0,?)`, pid, orgId, name, email, '["member","owner","payroll"]', '[]', 'active', '{}', null);
      h.run('INSERT INTO vault_users (id,person_id,email,hub_sub,local_pw,created_at) VALUES (?,?,?,?,?,?)', uid('vu'), pid, email, hubSub, localPw, iso(now()));
    });
    audit(orgId, pid, 'vault_setup', orgId, { mode });
    return c.newSession(pid, secure);
  }, { auth: false, open: true });

  route('POST', '/v1/vault/signin', async ({ body, secure }) => {
    if (c.mode !== 'vault') throw new HttpError(404, 'not found');
    if (!vault.initialized()) throw new HttpError(409, 'Set up the vault first.');
    guard();
    const email = V.str(body.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    const mode = V.enum(body.mode ?? 'hub', 'mode', ['hub', 'local']);
    const wasLocked = !vault.unlocked();
    if (!vault.unlock(V.str(body.passphrase, 'passphrase', { min: 1, max: 500 }))) { failed(); throw new HttpError(401, 'Wrong email, password or vault passphrase.'); }
    const user = h.get('SELECT * FROM vault_users WHERE email = ?', email);
    let ok = null;
    try { ok = await identify(user, { mode, email, password: String(body.password ?? ''), code: body.code ? String(body.code) : undefined }); }
    catch (e) { if (wasLocked && !h.get('SELECT 1 FROM sessions')) vault.lock(); throw e; }
    if (!ok) { failed(); if (wasLocked && !h.get('SELECT 1 FROM sessions')) vault.lock(); throw new HttpError(401, 'Wrong email, password or vault passphrase.'); }
    fails.n = 0; fails.until = 0;
    h.run('UPDATE vault_users SET last_login = ? WHERE id = ?', iso(now()), user.id);
    const p = h.get('SELECT org_id FROM people WHERE id = ?', user.person_id);
    audit(p.org_id, user.person_id, 'vault_signin', user.id, { mode });
    return c.newSession(user.person_id, secure);
  }, { auth: false, open: true });

  route('POST', '/v1/vault/lock', ({ me, org, secure }) => {
    h.run('DELETE FROM sessions');
    if (c.mode === 'vault') vault.lock();
    audit(org.id, me.id, 'vault_lock', null, null);
    return { ok: true, cookies: [c.sessionCookie('', 0, secure)] };
  });
  route('POST', '/v1/vault/passphrase', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const next = V.str(body.next, 'next', { min: 12, max: 500 });
    if (!vault.rekey(V.str(body.current, 'current', { min: 1, max: 500 }), next)) { failed(); throw new HttpError(401, 'The current passphrase is wrong.'); }
    audit(org.id, me.id, 'vault_passphrase_change', null, null);
    return { ok: true };
  });

  route('GET', '/v1/vault/users', ({ me, org }) => {
    need(me, 'owner', 'payroll');
    return { users: h.all('SELECT v.*, p.name FROM vault_users v JOIN people p ON p.id = v.person_id WHERE p.org_id = ? ORDER BY p.name', org.id).map((u) => ({ id: u.id, personId: u.person_id, name: u.name, email: u.email, hubLinked: !!u.hub_sub, localPassword: !!u.local_pw, lastLogin: u.last_login })), hubUrl: hubUrl() };
  });
  route('POST', '/v1/vault/users', ({ me, org, body }) => {
    need(me, 'owner');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const email = V.str(body.email ?? p.email, 'email', { min: 3, max: 200 }).trim().toLowerCase();
    if (h.get('SELECT 1 FROM vault_users WHERE email = ?', email)) throw new HttpError(409, 'that email can already sign in');
    if (!p.roles.includes('payroll') && !p.roles.includes('owner')) h.run('UPDATE people SET roles = ? WHERE id = ?', JSON.stringify([...new Set([...p.roles, 'payroll'])]), p.id);
    h.run('INSERT INTO vault_users (id,person_id,email,created_at) VALUES (?,?,?,?)', uid('vu'), p.id, email, iso(now()));
    audit(org.id, me.id, 'vault_user_add', p.id, { email });
    return { ok: true };
  });
  route('POST', '/v1/vault/users/:id/delete', ({ me, org, params }) => {
    need(me, 'owner');
    const u = h.get('SELECT v.* FROM vault_users v JOIN people p ON p.id = v.person_id WHERE v.id = ? AND p.org_id = ?', params.id, org.id);
    if (!u) throw new HttpError(404, 'not found');
    if (u.person_id === me.id) bad('you can’t remove yourself');
    h.run('DELETE FROM vault_users WHERE id = ?', u.id);
    h.run('DELETE FROM sessions WHERE person_id = ?', u.person_id);
    audit(org.id, me.id, 'vault_user_remove', u.person_id, null);
    return { ok: true };
  });
  route('POST', '/v1/vault/local-password', ({ me, org, body }) => {
    const u = h.get('SELECT * FROM vault_users WHERE person_id = ?', me.id);
    if (!u) throw new HttpError(404, 'you don’t have a vault sign-in');
    if (body.password == null) { h.run('UPDATE vault_users SET local_pw = NULL WHERE id = ?', u.id); return { ok: true, localPassword: false }; }
    h.run('UPDATE vault_users SET local_pw = ? WHERE id = ?', hashLocalPassword(V.str(body.password, 'password', { min: 10, max: 300 })), u.id);
    audit(org.id, me.id, 'vault_local_password', u.id, null);
    return { ok: true, localPassword: true };
  });
  route('POST', '/v1/vault/hub-url', ({ me, org, body }) => {
    need(me, 'owner');
    const url = V.str(body.hubUrl, 'hubUrl', { max: 300 }).trim();
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) bad('the Hub address starts with https://');
    vault.setSetting('hubUrl', url || null);
    audit(org.id, me.id, 'vault_hub_url', null, { url });
    return { hubUrl: hubUrl() };
  });

  // Org-wide payroll settings (each key validated).
  route('GET', '/v1/org/settings', ({ me, org }) => { need(me, 'manager', 'payroll'); return { settings: org.settings, org: { name: org.name, state: org.state, tz: org.tz, payFrequency: org.payFrequency, payPeriodAnchor: org.payPeriodAnchor, futaExempt: org.futaExempt, sutaRate: org.sutaRate } }; });
  route('POST', '/v1/org/settings', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const s = {};
    const num = (v, name, max) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > max) bad(`${name} is out of range`); return x; };
    if (body.mileageRateCents !== undefined) s.mileageRateCents = body.mileageRateCents == null || body.mileageRateCents === '' ? null : Math.round(num(body.mileageRateCents, 'mileageRateCents', 1000));
    if (body.receiptRequiredCents !== undefined) s.receiptRequiredCents = Math.round(num(body.receiptRequiredCents, 'receiptRequiredCents', 1e7));
    if (body.expenseCategories !== undefined) s.expenseCategories = Array.isArray(body.expenseCategories) ? body.expenseCategories.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40) : bad('expenseCategories must be a list');
    if (body.cobra !== undefined) s.cobra = { groupHealthPlan: !!body.cobra?.groupHealthPlan, stateContinuation: !!body.cobra?.stateContinuation };
    if (body.fmla !== undefined) s.fmla = { worksiteEmployees: body.fmla?.worksiteEmployees == null || body.fmla.worksiteEmployees === '' ? null : Math.round(num(body.fmla.worksiteEmployees, 'worksiteEmployees', 1e6)) };
    if (body.aca !== undefined) s.aca = { ale: !!body.aca?.ale };
    if (body.offerTemplate !== undefined) s.offerTemplate = body.offerTemplate ? V.str(body.offerTemplate, 'offerTemplate', { max: 20000 }) : null;
    c.saveOrgSettings(org, s);
    const cols = {};
    if (body.sutaRate !== undefined) cols.suta_rate = num(body.sutaRate, 'sutaRate', 0.2);
    if (body.futaExempt !== undefined) cols.futa_exempt = body.futaExempt ? 1 : 0;
    if (body.name !== undefined) cols.name = V.str(body.name, 'name', { min: 1, max: 120 });
    if (body.state !== undefined) cols.state = V.str(body.state, 'state', { min: 2, max: 2 }).toUpperCase();
    const keys = Object.keys(cols);
    if (keys.length) h.run(`UPDATE orgs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), org.id);
    audit(org.id, me.id, 'org_settings', org.id, { ...s, ...cols, offerTemplate: s.offerTemplate ? '(changed)' : undefined });
    const o = c.loadOrg(org.id);
    return { settings: o.settings };
  });
}
