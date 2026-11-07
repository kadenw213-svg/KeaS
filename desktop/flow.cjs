// Which screen KeaS opens on, and where an unfinished Hub setup picks up again (no Electron here, so it's tested).
'use strict';

const WIZARD = ['welcome', 'storage', 'reach', 'owner', 'boot', 'done'];
// Steps that need the Hub running (it's started again when setup resumes at one of them).
const NEEDS_HUB = new Set(['reach', 'owner', 'boot', 'done']);

/** Saved wizard progress: a known step, or the start. */
function resumeStep(config = {}) {
  if (config.setupDone) return 'status';
  const s = config.setupStep;
  if (!WIZARD.includes(s)) return 'welcome';
  // Nothing saved for the data folder yet: everything after it needs one.
  if (s !== 'welcome' && !config.dataDir) return 'storage';
  return s;
}

/**
 * What an unfinished setup already chose, so the wizard shows it again (instead of the defaults, which would quietly
 * set up a second Hub in another folder).
 */
function resumeChoices(config = {}, defaults = {}) {
  return {
    step: resumeStep(config),
    dataDir: config.dataDir || defaults.hubData || '',
    storageDir: config.storageDir && config.dataDir && config.storageDir.toLowerCase() !== `${config.dataDir}\\storage`.toLowerCase() ? config.storageDir : '',
    quotaGb: Number(config.quotaGb) || 5,
    reach: config.dataDir ? (config.tailscale ? 'tailscale' : 'local') : 'tailscale',
    needsHub: NEEDS_HUB.has(resumeStep(config)) && !!config.dataDir,
  };
}

/** The step before this one. Back never leaves the wizard or goes past the start. */
function stepBack(step) {
  const i = WIZARD.indexOf(step);
  return i <= 0 ? 'welcome' : WIZARD[i - 1];
}
function stepNext(step) {
  const i = WIZARD.indexOf(step);
  return i < 0 ? 'welcome' : WIZARD[Math.min(WIZARD.length - 1, i + 1)];
}

module.exports = { WIZARD, resumeStep, resumeChoices, stepBack, stepNext };
