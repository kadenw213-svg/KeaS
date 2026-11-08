// Which screen KeaS opens on, and where an unfinished setup picks up again (no Electron here, so it's tested).
//
// Setup, on every PC: the data folder (welcome) -> the Kea account server, its key checked (keac) -> sign in with
// the Kea account (account) -> set up this server with its setup code (claim) -> the organization (org) -> where
// people work and its local rules (place) -> reachable from anywhere (reach) -> done, then the "Get set up" list.
// A PC that is still a Kea Hub (KeaS 0.5, accounts not moved to KeaC) opens on its status screen instead.
'use strict';

const WIZARD = ['welcome', 'keac', 'account', 'claim', 'org', 'place', 'reach', 'done'];
// Steps that need the KeaS server running (it's started again when setup resumes at one of them).
const NEEDS_SERVER = new Set(['keac', 'account', 'claim', 'org', 'place', 'reach', 'done']);

/** Saved wizard progress: a known step, or the start. */
function resumeStep(config = {}) {
  if (config.setupDone) return 'home';
  const s = config.setupStep;
  if (!WIZARD.includes(s)) return 'welcome';
  // Nothing saved for the data folder yet: everything after it needs one.
  if (s !== 'welcome' && !config.dataDir) return 'welcome';
  return s;
}
/** What an unfinished setup already chose, so the wizard shows it again. */
function resumeChoices(config = {}, defaults = {}) {
  const step = resumeStep(config);
  return {
    step,
    dataDir: config.dataDir || defaults.serverData || '',
    reach: config.dataDir ? (config.tailscale ? 'tailscale' : 'local') : 'tailscale',
    needsServer: NEEDS_SERVER.has(step) && !!config.dataDir,
  };
}
/** The step before this one. Back never leaves the wizard or goes past the start. */
function stepBack(step) { const i = WIZARD.indexOf(step); return i <= 0 ? 'welcome' : WIZARD[i - 1]; }
function stepNext(step) { const i = WIZARD.indexOf(step); return i < 0 ? 'welcome' : WIZARD[Math.min(WIZARD.length - 1, i + 1)]; }
/** The first screen: a Kea Hub's status, the home screen, or where setup stopped. */
function firstView({ legacy = false, config = {} } = {}) {
  if (legacy && config.dataDir) return 'legacy';
  return config.setupDone ? 'home' : resumeStep(config);
}
/** Starting with Windows: on for a set-up server unless turned off (people clock in through it). */
function startWithWindows(config = {}) {
  if (typeof config.startWithWindows === 'boolean') return config.startWithWindows;
  return !!config.setupDone;
}

module.exports = { WIZARD, resumeStep, resumeChoices, stepBack, stepNext, firstView, startWithWindows };
