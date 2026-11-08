// "Get set up" for payroll: everything that would stop a pay run, or make one wrong, as steps. Each step says whether
// it's done, in one short sentence, and where it's fixed (a screen, and sometimes a person's card). The checks are the
// same ones the pay run uses (run.mjs: blockers and warnings), so nothing stops a pay run that this list didn't name.
//
// Tax tables are never marked verified here: that step says what verification needs and who does it.
import { addDays } from '../lib/time.mjs';
import { localMinimumWage } from '../lib/rules.mjs';
import { depositAccounts } from './paystructure.mjs';
import { suggestSickPolicy } from './leave.mjs';

const step = (id, title, done, text, fix = null, extra = {}) => ({ id, title, done: !!done, text, fix, ...extra });

/** The steps for one organization. c: the payroll context (index.mjs); everything here only reads. */
export function payrollChecklist(c, org) {
  const { h, vault } = c;
  const period = c.lastCompleted(org);
  const year = Number(addDays(period.end, 6).slice(0, 4));
  const T = c.tablesFor(org.state, year);
  const rules = c.rulesFor(org);
  const s = org.settings || {};
  const steps = [];

  // 1. The organization and where people work.
  const placeKnown = s.workCity !== undefined;
  steps.push(step('org', 'Organization details', org.name && org.state && org.tz && placeKnown,
    !org.state ? 'Add the state where people work.' : !placeKnown ? 'Add the city or county where people work, so local rules can apply.' : `${org.name}, ${s.workCity ? `${s.workCity}, ` : ''}${org.state}.`,
    { view: 'settings' }));

  // 2. The rules for that place: which KeaS has, and which it doesn't.
  const have = T.list.map((t) => ({ name: t.name, have: !t.missing, verified: !!t.verified }));
  const local = localMinimumWage(rules, s.workCity);
  const places = (rules?.minimumWage?.localOverrides || []).map((o) => o.place);
  const rulesList = [
    ...have,
    { name: 'Minimum wage', have: rules?.minimumWage?.standard != null, verified: false, note: rules?.minimumWage?.standard != null ? `$${rules.minimumWage.standard.toFixed(2)} an hour${local ? ` (${local.place})` : ''}` : null },
    { name: 'Overtime', have: !!rules?.overtime, verified: false, note: rules?.overtime ? `over ${rules.overtime.weeklyHours} h a week${rules.overtime.dailyHours ? ` or ${rules.overtime.dailyHours} h a day` : ''}` : null },
    { name: 'Double time', have: !!rules?.overtime?.doubleTime, verified: false, note: rules?.overtime?.doubleTime ? `over ${rules.overtime.doubleTime.dailyHours} h a day${rules.overtime.doubleTime.seventhDayAfterHours != null ? `, and over ${rules.overtime.doubleTime.seventhDayAfterHours} h on a seventh day in a row` : ''}` : null },
    { name: 'Paid sick leave', have: !!rules?.sickLeave, verified: false, note: rules?.sickLeave ? `1 h per ${rules.sickLeave.accrueHoursPer} h worked${rules.sickLeave.cap != null ? `, up to ${rules.sickLeave.cap} h` : ''}` : null },
  ];
  // Every labor file is a suggestion until checked against its sources (verifiedFor stays null in the code).
  const laborFiles = T.list.filter((t) => t.key.startsWith('labor:') && !t.missing).map((t) => ({ name: t.name, verified: !!t.verified, note: t.verified ? `Checked for ${year}.` : 'Not verified: a suggestion until it’s checked against the official sources.' }));
  for (const f of laborFiles) rulesList.push({ name: f.name, have: true, verified: f.verified, note: f.note, labor: true });
  const missing = have.filter((t) => !t.have).map((t) => t.name);
  const cityNote = s.workCity && !local ? ` KeaS has no ${s.workCity} rules${places.length ? ` (it knows ${places.join(', ')})` : ''}: check whether your city or county has its own minimum wage or leave rules.` : '';
  steps.push(step('rules', `Rules for ${T.state?.label || org.state || 'your state'}`, org.state && !missing.length,
    missing.length ? `KeaS doesn’t have: ${missing.join(', ')}. Those taxes aren’t worked out for you.${cityNote}` : `KeaS has the federal and ${org.state} tables.${cityNote}`,
    { view: 'settings' }, { rules: rulesList }));

  // 3. The tables checked for the pay year (never done by anyone in the app: see the text).
  const sources = [...(T.us?.source || []), ...(T.state?.source || [])].map((x) => ({ title: x.title, url: x.url }));
  const laborSources = [...(rules?.source || [])].map((x) => ({ title: x.title, url: x.url }));
  const laborUnverified = laborFiles.filter((f) => !f.verified).map((f) => f.name);
  steps.push(step('verified', `Tax tables and labor rules checked for ${year}`, T.verified,
    T.verified ? `The ${year} tables are checked against the official sources.`
      : `A pay run can be reviewed but not finalized until the ${year} federal and ${org.state || 'state'} tables are checked line by line against the official sources (the IRS’s Publication 15-T, the state’s withholding guide)${laborUnverified.length ? `, and the labor rules (${laborUnverified.join(', ')}: overtime, double time, sick leave) against the labor department’s` : ''}. The KeaS maintainers do that check and send the checked tables in a KeaS update; nobody can mark a table checked inside KeaS. Keep KeaS updated.`,
    null, { blocking: true, sources: [...sources, ...laborSources], laborUnverified }));

  // 4. The employer: legal name, EIN and the company bank account (the bank file needs it).
  const ent = h.get('SELECT * FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC LIMIT 1', org.id);
  const bank = (ent?.bank_enc && vault.openJson(ent.bank_enc)) || vault.openJson(org.bankRaw) || {};
  steps.push(step('employer', 'Employer details', ent?.ein && bank.originRouting,
    !ent ? 'Add the employer: legal name, EIN and address.' : !ent.ein ? `Add the EIN for ${ent.name}.` : !bank.originRouting ? 'Add the company bank details (the direct-deposit file needs them).' : `${ent.name}, EIN ${ent.ein}.`,
    { view: 'org' }));

  // 5. State unemployment: the rate the state assigned (0 means no SUTA is worked out).
  if (T.state?.suta || T.state?.sutaWageBase) steps.push(step('suta', 'State unemployment rate', Number(org.sutaRate) > 0,
    Number(org.sutaRate) > 0 ? `${(Number(org.sutaRate) * 100).toFixed(2)}%.` : 'Add the unemployment rate your state assigned you (it’s on the state’s rate notice).', { view: 'settings' }));

  // 6. People, and what payroll needs for each.
  const people = h.all(`SELECT id FROM people WHERE org_id = ? AND status IN ('active','leave') AND worker_type = 'employee' ORDER BY name`, org.id).map((r) => c.getPerson(r.id, org.id));
  // (Someone paid by pay codes in the org engine has their rates there.)
  const hasRate = (p) => p.payRateCents != null || !!h.get('SELECT 1 FROM pay_rates WHERE person_id = ?', p.id) || c.engine?.defaultRateOf(p, period) != null;
  // (The payroll admin is on the list from setup; until they get a pay rate they aren't counted as someone paid.)
  const paid = people.filter((p) => hasRate(p) || !(p.roles || []).includes('owner'));
  steps.push(step('people', 'Employees added', paid.length > 0, paid.length ? `${paid.length} ${paid.length === 1 ? 'person' : 'people'} on payroll.` : 'Add the people you pay (or import them).', { view: 'employees' }));
  const gaps = [];
  for (const p of paid) {
    const need = [];
    if (!hasRate(p)) need.push(['a pay rate', 'rate']);
    if (!p.w4?.filing && !p.w4?.exempt) need.push(['a W-4', 'tax']);
    if (!vault.openJson(p.piiRaw)?.ssn) need.push(['an SSN', 'tax']);
    if (need.length) gaps.push({ personId: p.id, name: p.name, needs: need.map((n) => n[0]), edit: need[0][1] });
  }
  const noDeposit = paid.filter((p) => !depositAccounts(vault.openJson(p.depositRaw)).length).length;
  steps.push(step('employeeInfo', 'What payroll needs for each person', paid.length && !gaps.length,
    !paid.length ? 'Add people first.' : gaps.length ? `${gaps.length} ${gaps.length === 1 ? 'person needs' : 'people need'} details: ${gaps.slice(0, 3).map((g) => `${g.name} (${g.needs.join(', ')})`).join('; ')}${gaps.length > 3 ? '…' : ''}.` : `Pay rate, W-4 and SSN for everyone.${noDeposit ? ` ${noDeposit} paid by check (no direct deposit).` : ''}`,
    gaps.length ? { view: 'employees', personId: gaps[0].personId, edit: gaps[0].edit } : { view: 'employees' }, { people: gaps }));

  // 6b. Paid sick leave: a policy, suggested from the law where people work (the owner checks and edits it).
  const sickSuggestion = suggestSickPolicy(rules);
  const sickPolicies = h.get("SELECT COUNT(*) AS n FROM pto_policies WHERE org_id = ? AND kind = 'sick' AND active = 1", org.id).n;
  if (sickSuggestion) steps.push(step('sickLeave', 'Paid sick leave policy', sickPolicies > 0,
    sickPolicies ? `${sickPolicies} sick leave polic${sickPolicies === 1 ? 'y' : 'ies'}. Check ${sickPolicies === 1 ? 'it' : 'them'} against the law: ${sickSuggestion.why}`
      : `${org.state} law: ${sickSuggestion.why} KeaS suggests a policy from that; check it (the tables aren’t verified, and limits often depend on how many people you employ), then save it.`,
    { view: 'timeoff', tab: 'policies', suggest: 'sick' }, { suggestion: sickSuggestion }));
  else steps.push(step('sickLeave', 'Paid sick leave policy', true, `KeaS has no paid sick leave law for ${org.state || 'your state'}. You can add a policy of your own under Time off.`, { view: 'timeoff', tab: 'policies' }, { optional: true }));

  // 7. Who approves: timecards need someone other than the person (a manager, or the owner).
  const managers = people.filter((p) => (p.roles || []).includes('manager')).length;
  const chains = h.get('SELECT COUNT(*) AS n FROM approval_chains WHERE org_id = ? AND active = 1', org.id)?.n || 0;
  steps.push(step('approvers', 'Who approves', managers > 0 || chains > 0,
    managers || chains ? `${managers} manager${managers === 1 ? '' : 's'}${chains ? `, ${chains} approval chain${chains === 1 ? '' : 's'}` : ''}. Nobody approves their own.` : 'Only you (the owner) can approve timecards now. Give someone the manager role, or set approval chains.',
    { view: 'approvals' }, { optional: true }));

  // 8. This pay run's timecards approved (the pay run can't be finalized without them).
  const unapproved = paid.filter((p) => { const tc = c.computeTimecard(org, p, period); return !tc.approved && (tc.totals?.workedMin || 0) > 0; });
  steps.push(step('timecards', 'Timecards approved for this pay run', !unapproved.length,
    unapproved.length ? `${unapproved.length} not approved for ${period.start} to ${period.end}.` : `Nothing waiting for ${period.start} to ${period.end}.`,
    { view: 'timecards', team: true, periodStart: period.start }));

  const required = steps.filter((x) => !x.optional);
  return { year, period, steps, left: required.filter((x) => !x.done).length, total: required.length };
}

export function registerChecklist(c) {
  c.route('GET', '/v1/setup/checklist', async ({ me, org }) => {
    c.need(me, 'owner', 'payroll');
    // (The engine's hours for the timecard step; the list still answers when the organization server can't.)
    let engineError = null;
    try { await c.loadEngine?.(org, c.lastCompleted(org)); } catch (e) { engineError = e.message; }
    const out = payrollChecklist(c, org);
    return engineError ? { ...out, engineError } : out;
  });
}
