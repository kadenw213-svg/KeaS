// Payroll and HR for the payroll vault: every module registers its routes on the shared server context.
import { registerVaultAuth } from './vaultauth.mjs';
import { registerApprovals } from './approvals.mjs';
import { registerOrgStructure } from './orgstructure.mjs';
import { registerPayStructure } from './paystructure.mjs';
import { registerLeave } from './leave.mjs';
import { registerRun } from './run.mjs';
import { registerOnboarding } from './onboarding.mjs';
import { registerDocuments } from './documents.mjs';
import { registerReports } from './reports.mjs';
import { registerImport } from './importer.mjs';
import { registerYearEnd } from './yearend.mjs';
import { registerTalent } from './talent.mjs';
import { registerChecklist, payrollChecklist } from './checklist.mjs';

export function registerPayroll(c) {
  /**
   * Nobody changes their own pay, raises, extra earnings, time-off balance or job record (who approves for them) but
   * the owner, and the owner's own changes are marked in the audit trail. Returns true when it's the owner's own.
   */
  c.notSelf = (me, personId, what = 'your own pay') => {
    if (me.id !== personId) return false;
    if (!me.roles.includes('owner')) throw new c.HttpError(403, `You can’t change ${what}. Ask the owner (or another payroll admin) to do it.`);
    return true;
  };
  /** Pay amounts are for payroll and the owner; managers see them only when the owner turns that on. */
  c.seesPay = (me, org) => c.has(me, 'payroll') || !!org.settings?.managersSeePay;
  registerVaultAuth(c);
  registerApprovals(c);
  registerOrgStructure(c);
  registerPayStructure(c);
  registerLeave(c);
  registerRun(c);
  registerOnboarding(c);
  registerDocuments(c);
  registerReports(c);
  registerImport(c);
  registerYearEnd(c);
  registerTalent(c);
  registerChecklist(c);
  // The KeaS app's "Get set up" screen asks for a summary while the vault is open (in this process only).
  if (c.keas) c.keas.checklist = () => {
    if (!c.vault.unlocked()) return null;
    const org = c.h.get('SELECT id FROM orgs LIMIT 1');
    if (!org) return null;
    const r = payrollChecklist(c, c.loadOrg(org.id));
    // (Titles and done/not done only: no names, no pay details leave the vault this way.)
    return { left: r.left, total: r.total, year: r.year, steps: r.steps.map((s) => ({ id: s.id, title: s.title, done: s.done, optional: !!s.optional, blocking: !!s.blocking })) };
  };
}
