// A one-time import from a KeaS org server's database (server/db.mjs: people, positions, shifts, punches, missed-punch
// requests and timecard approvals) into an organization of the org engine. People are matched to Kea accounts by
// the Kea account their payroll sign-in is linked to (vault_users.hub_sub), then by email. Only matched people come
// in (with their shifts, punches, requests and approvals); everyone else is listed in the report, and running the
// import again (after they have a Kea account, or with `match`) brings in what's missing without doubling anything.
//
// Pay stays where it is: rates, W-4s, bank details and pay history are never read.
import { randomUUID } from 'node:crypto';
import { localDate } from '../server/lib/time.mjs';

class DryRun extends Error {}
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/**
 * src: the org server's database, opened with its vault unlocked (people's names and emails are sealed).
 * orgId: the engine organization to import into. serverOrgId: which org in src (default: its only one).
 * by: the account id doing it (for the audit and as who granted roles). match: { serverPersonId: accountId } to
 * match people by hand. dryRun: report only, change nothing. Returns the report.
 */
export function importServerOrg(core, { src, orgId, serverOrgId = null, by = 'import', match = {}, dryRun = false, addPunch }) {
  const { h, identity, now } = core;
  const o = core.loadOrg(orgId);
  if (!o) throw new Error('That organization isn’t on this server.');
  const orgs = src.all('SELECT id, name FROM orgs');
  const so = serverOrgId ? orgs.find((x) => x.id === serverOrgId) : orgs.length === 1 ? orgs[0] : null;
  if (!so) throw new Error(serverOrgId ? 'That org isn’t in the server database.' : `The server database has ${orgs.length} orgs; say which one (serverOrgId).`);
  const source = `server:${so.id}`;
  const report = {
    source, from: { orgId: so.id, name: so.name }, to: { orgId: o.id, name: o.name }, dryRun,
    people: { matched: [], unmatched: [], added: 0, alreadyMembers: 0 },
    positions: { matched: 0, created: 0 },
    shifts: { imported: 0, unassigned: 0, already: 0 },
    punches: { imported: 0, notMatched: 0, already: 0 },
    punchRequests: { imported: 0, notMatched: 0, already: 0 },
    timecardApprovals: { imported: 0, notMatched: 0, already: 0 },
  };
  const has = (t) => !!src.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  const mapped = (kind, sid) => h.get('SELECT dst_id FROM org_import_map WHERE org_id = ? AND source = ? AND kind = ? AND src_id = ?', o.id, source, kind, String(sid))?.dst_id ?? null;
  const remember = (kind, sid, did) => h.run('INSERT OR REPLACE INTO org_import_map (org_id,source,kind,src_id,dst_id) VALUES (?,?,?,?,?)', o.id, source, kind, String(sid), String(did));

  const run = () => {
    // ---------- positions: by name, or made ----------
    const pos = new Map();
    for (const p of src.all('SELECT * FROM positions WHERE org_id = ?', so.id)) {
      let pid = mapped('position', p.id);
      if (pid && !h.get('SELECT 1 FROM org_positions WHERE id = ? AND org_id = ?', pid, o.id)) pid = null;
      if (!pid) pid = h.get('SELECT id FROM org_positions WHERE org_id = ? AND lower(name) = lower(?)', o.id, p.name)?.id ?? null;
      if (pid) report.positions.matched++;
      else {
        pid = randomUUID();
        h.run('INSERT INTO org_positions (id,org_id,name,tags) VALUES (?,?,?,?)', pid, o.id, p.name, JSON.stringify(J(p.tags, []).filter((t) => typeof t === 'string').slice(0, 30)));
        report.positions.created++;
      }
      remember('position', p.id, pid);
      pos.set(p.id, pid);
    }

    // ---------- people: by linked Kea account, then email ----------
    const linked = new Map();
    if (has('vault_users')) for (const u of src.all('SELECT person_id, email, hub_sub FROM vault_users')) linked.set(u.person_id, u);
    const people = new Map();
    let payrollRole = null;
    const roleFor = (roles) => {
      if (roles.includes('owner')) return { role: core.templateRole(o.id, 'owner') };
      if (roles.includes('manager')) return { role: core.templateRole(o.id, 'manager') };
      if (roles.includes('payroll')) {
        if (!payrollRole) {
          payrollRole = h.get("SELECT * FROM org_roles WHERE org_id = ? AND name = 'Payroll'", o.id);
          if (!payrollRole) {
            const rid = randomUUID();
            h.run("INSERT INTO org_roles (id,org_id,name,abilities,template,description,created_by,created_at) VALUES (?,?,'Payroll',?,0,?,?,?)", rid, o.id,
              JSON.stringify(['people.view', 'timecards.view', 'timecards.approve', 'clock.self', 'timeoff.request']), 'From the org server’s payroll role', by, now());
            payrollRole = h.get('SELECT * FROM org_roles WHERE id = ?', rid);
          }
        }
        return { role: payrollRole, alsoMember: true };
      }
      return { role: core.templateRole(o.id, 'member') };
    };
    for (const p of src.all('SELECT * FROM people WHERE org_id = ?', so.id)) {
      const u = linked.get(p.id);
      const email = p.email || u?.email || null;
      let aid = match[p.id] ?? null, how = aid ? 'by hand' : null;
      if (!aid && u?.hub_sub && identity.findBySub) { aid = identity.findBySub(u.hub_sub); if (aid) how = 'linked Kea account'; }
      if (!aid && email && identity.findByEmail) { aid = identity.findByEmail(email); if (aid) how = 'email'; }
      if (!aid) { report.people.unmatched.push({ personId: p.id, name: p.name ?? null, email, status: p.status, reason: email ? 'No Kea account with that email' : 'No email' }); continue; }
      people.set(p.id, aid);
      remember('person', p.id, aid);
      report.people.matched.push({ personId: p.id, accountId: aid, name: p.name ?? null, by: how });
      if (core.memberRow(o.id, aid)) { report.people.alreadyMembers++; }
      else {
        h.run("INSERT INTO org_members (org_id,account_id,status,birthdate,joined_at,via_code) VALUES (?,?,'active',?,?,?)", o.id, aid, p.birthdate ?? null, now(), `import:${so.id}`);
        const r = roleFor(J(p.roles, []));
        core.grant(o.id, aid, r.role.id, null, by);
        if (r.alsoMember) core.grant(o.id, aid, core.templateRole(o.id, 'member').id, null, by);
        report.people.added++;
      }
      for (const sp of J(p.positions, [])) if (pos.has(sp)) h.run('INSERT OR IGNORE INTO org_member_positions (org_id,account_id,position_id) VALUES (?,?,?)', o.id, aid, pos.get(sp));
    }

    // ---------- shifts ----------
    const shifts = new Map();
    for (const s of src.all('SELECT * FROM shifts WHERE org_id = ?', so.id)) {
      const already = mapped('shift', s.id);
      if (already) { shifts.set(s.id, already); report.shifts.already++; continue; }
      const pid = pos.get(s.position_id);
      if (!pid) continue;
      const aid = s.person_id ? people.get(s.person_id) ?? null : null;
      const sid = randomUUID();
      const startAt = ms(s.start), endAt = ms(s.end);
      h.run("INSERT INTO org_shifts (id,org_id,account_id,position_id,date,start_at,end_at,status,source,note,created_at) VALUES (?,?,?,?,?,?,?,?,'import',?,?)",
        sid, o.id, aid, pid, localDate(startAt, o.tz), startAt, endAt, s.status === 'published' ? 'published' : 'draft', s.note ?? null, now());
      remember('shift', s.id, sid);
      shifts.set(s.id, sid);
      report.shifts.imported++;
      if (!aid) report.shifts.unassigned++;
    }
    // A shift imported earlier while its person wasn't matched yet: theirs now.
    for (const s of src.all('SELECT id, person_id FROM shifts WHERE org_id = ? AND person_id IS NOT NULL', so.id)) {
      const sid = shifts.get(s.id), aid = people.get(s.person_id);
      if (sid && aid) h.run("UPDATE org_shifts SET account_id = ? WHERE id = ? AND account_id IS NULL AND source = 'import'", aid, sid);
    }

    // ---------- punches (append-only there and here) ----------
    const personIds = [...new Set(src.all('SELECT id FROM people WHERE org_id = ?', so.id).map((r) => r.id))];
    for (const pr of personIds.flatMap((pid) => src.all('SELECT * FROM punches WHERE person_id = ? ORDER BY at', pid))) {
      const aid = people.get(pr.person_id);
      if (!aid) { report.punches.notMatched++; continue; }
      if (mapped('punch', pr.id)) { report.punches.already++; continue; }
      const p = addPunch(o, aid, { shiftId: pr.shift_id ? shifts.get(pr.shift_id) ?? null : null, type: pr.type, at: ms(pr.at), source: `import:${pr.source}`, restAttested: pr.rest_attested == null ? null : !!pr.rest_attested });
      remember('punch', pr.id, p.id);
      report.punches.imported++;
    }
    for (const r of personIds.flatMap((pid) => src.all('SELECT * FROM punch_requests WHERE person_id = ?', pid))) {
      const aid = people.get(r.person_id);
      if (!aid) { report.punchRequests.notMatched++; continue; }
      if (mapped('punch_request', r.id)) { report.punchRequests.already++; continue; }
      const rid = randomUUID();
      h.run('INSERT INTO org_punch_requests (id,org_id,account_id,shift_id,type,at,reason_code,note,status,created_at,decided_by,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        rid, o.id, aid, r.shift_id ? shifts.get(r.shift_id) ?? null : null, r.type, ms(r.at), r.reason_code, r.note ?? null, r.status, ms(r.created_at),
        r.decided_by ? people.get(r.decided_by) ?? `import:${r.decided_by}` : null, r.decided_at ? ms(r.decided_at) : null);
      remember('punch_request', r.id, rid);
      report.punchRequests.imported++;
    }
    for (const a of personIds.flatMap((pid) => src.all('SELECT * FROM timecard_approvals WHERE person_id = ?', pid))) {
      const aid = people.get(a.person_id);
      if (!aid) { report.timecardApprovals.notMatched++; continue; }
      const key = `${a.person_id}:${a.period_start}`;
      if (mapped('timecard_approval', key)) { report.timecardApprovals.already++; continue; }
      h.run('INSERT OR IGNORE INTO org_timecard_approvals (org_id,account_id,period_start,approved_by,at) VALUES (?,?,?,?,?)', o.id, aid, a.period_start, people.get(a.approved_by) ?? `import:${a.approved_by}`, ms(a.at));
      remember('timecard_approval', key, `${aid}:${a.period_start}`);
      report.timecardApprovals.imported++;
    }
    // The org server's pay periods, so timecards line up with the ones already approved there.
    const sorg = src.get('SELECT pay_frequency, pay_period_anchor FROM orgs WHERE id = ?', so.id);
    if (sorg?.pay_period_anchor) {
      const s = J(o.settings, {});
      if (!s.clock?.periodAnchor) {
        s.clock = { ...(s.clock || {}), periodAnchor: sorg.pay_period_anchor, periodDays: sorg.pay_frequency === 'weekly' ? 7 : 14 };
        h.run('UPDATE orgs SET settings = ? WHERE id = ?', JSON.stringify(s), o.id);
        report.payPeriods = { anchor: sorg.pay_period_anchor, days: s.clock.periodDays };
      }
    }
    if (dryRun) throw new DryRun();
  };
  try { core.tx(run); } catch (e) { if (!(e instanceof DryRun)) throw e; }
  if (!dryRun) core.audit(by, 'org.import_server', o.id, { source, people: report.people.matched.length, unmatched: report.people.unmatched.length, shifts: report.shifts.imported, punches: report.punches.imported }, 'local');
  return report;
}
