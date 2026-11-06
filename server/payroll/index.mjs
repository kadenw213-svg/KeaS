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
