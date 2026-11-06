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
}
