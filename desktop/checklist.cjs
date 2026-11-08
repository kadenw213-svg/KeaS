// "Get set up" in the KeaS window: one list from installing KeaS to the first pay run, checked again each time. The
// KeaS server's steps (data folder, running, the Kea account server, signing in, the organization and where it works,
// pay codes, reaching it from anywhere, start before sign-in, updates) and then Payroll's own steps one by one (from
// the vault's checklist, server/payroll/checklist.mjs, as it said the last time Payroll was open). No Electron here:
// main.cjs gathers the facts, this decides the steps, so the logic is tested.
//
// A step is { id, title, done, text, action, optional?, waiting? }. waiting: nobody here can do it (the tax tables are
// checked by the KeaS maintainers and arrive in an update); it never counts as done, but it doesn't keep the list open.
'use strict';

const step = (id, title, done, text, action = null, extra = {}) => ({ id, title, done: !!done, text, action, ...extra });

/**
 * f: {
 *   config, folderProblem, running, lastStartError, update: { status, version, nightly },
 *   legacy: true while this PC is still the Kea Hub (its accounts not moved to KeaC),
 *   keac: { url, trusted, keysError } (the KeaS server's view of KeaC), account: account.status() (KeaC),
 *   server: { claimed, signedIn, operator }, orgs: [{ id, name, state, tz, role, status, memberStatus }] | null, orgsError,
 *   payCodes: { [orgId]: { count, given } | { error } }, payroll: { initialized, summary: { year, steps } | null } | null
 * }
 */
function keasSteps(f = {}) {
  const c = f.config || {};
  const steps = [];
  steps.push(step('folder', 'The data folder', c.dataDir && !f.folderProblem, f.folderProblem ? f.folderProblem : c.dataDir ? `${c.dataDir}.` : 'Pick where the data goes.', c.dataDir ? 'status' : 'welcome'));
  steps.push(step('running', 'The KeaS server is running', f.running,
    f.running ? 'It answers on this PC.' : f.lastStartError ? `It didn’t start: ${f.lastStartError}` : 'Start it.', 'startServer'));
  if (f.legacy) {
    // A Kea Hub (KeaS 0.5) whose accounts are still here: it keeps serving Kea until they've moved to KeaC.
    steps.push(step('move', 'Move the Kea accounts to your Kea account server', false, 'Your Kea accounts are still here. Move them to your Kea account server, then this PC becomes your organization’s server.', 'move'));
    steps.push(updatesStep(f));
    return finish(steps);
  }
  const k = f.keac || {};
  steps.push(step('keac', 'Your Kea account server is trusted', !!k.url && k.trusted > 0,
    !k.url ? 'Enter its address and check its key.' : k.trusted > 0 ? `${k.url}${k.keysError ? ` (not reachable right now: ${k.keysError})` : ''}.` : 'Check its key’s fingerprint against the one in its Keys screen, then trust it.', 'keac'));
  const a = f.account || {};
  steps.push(step('account', 'Signed in with your Kea account', a.signedIn, a.signedIn ? `${a.account?.email || ''}${a.reachable === false ? ' (the Kea account server can’t be reached right now)' : ''}.` : 'Sign in with the Kea account you use in Kea.', 'signin'));
  const s = f.server || {};
  steps.push(step('server', 'This server is set up', s.claimed && s.signedIn,
    !s.claimed ? 'Set it up with the setup code shown on this PC.' : s.signedIn ? (s.operator ? 'You run it.' : 'Signed in.') : 'Sign in to it with your Kea account.', s.claimed ? 'serverSignIn' : 'claim'));
  if (!a.signedIn || !s.signedIn) { steps.push(reachStep(c)); steps.push(updatesStep(f)); return finish(steps); }

  const orgs = f.orgs || [];
  const mine = orgs.filter((o) => ['owner', 'admin'].includes(o.role));
  const inOrg = (o) => o.memberStatus !== 'pending';
  const org = mine.find((o) => o.status === 'active') || mine[0] || orgs.find((o) => o.status === 'active' && inOrg(o)) || orgs.find(inOrg) || orgs[0] || null;
  if (f.orgs == null) steps.push(step('org', 'Your organization', false, f.orgsError ? `Can’t check right now: ${f.orgsError}` : 'Checking…', 'recheck'));
  else if (org && !inOrg(org)) steps.push(step('org', 'Your organization', false, `Request sent to ${org.name}. A manager approves it. This list checks again by itself.`, 'recheck'));
  else {
    steps.push(step('org', 'Your organization', !!org,
      org ? `${org.name}${org.role ? ` (you’re ${org.role === 'owner' ? 'the owner' : `a${org.role === 'admin' ? 'n' : ''} ${org.role}`})` : ''}.` : 'Create your organization.', 'org'));
    if (org && ['owner', 'admin'].includes(org.role)) {
      steps.push(step('orgPlace', 'Where people work', !!org.state,
        org.state ? `${org.state}, ${org.tz || 'time zone not set'}. The labor rules for ${org.state} are suggestions until they’re checked.` : 'Add the state and time zone, so the right labor and tax rules apply.', 'orgEdit'));
      const pc = f.payCodes?.[org.id];
      if (org.status === 'active' && pc) {
        steps.push(step('payCodes', 'Pay codes', pc.count > 0 && pc.given > 0,
          pc.error ? `Can’t check right now: ${pc.error}` : !pc.count ? 'Make a pay code for each job and its rate (like Lifeguard, $15 an hour), then give people theirs. Payroll pays every hour at the code it was worked at.'
            : !pc.given ? `${pc.count} pay code${pc.count === 1 ? '' : 's'}, not given to anyone yet. Give each person theirs; their first is their default.` : `${pc.count} pay code${pc.count === 1 ? '' : 's'}, given to people.`,
          'payCodes'));
      }
    }
  }
  steps.push(reachStep(c));
  steps.push(step('boot', 'Start before sign-in and keep the PC awake', !!c.boot?.installed,
    c.boot?.installed ? 'The server starts when Windows starts.' : 'So the server comes back by itself after Windows restarts. Windows asks for permission once.', 'settings', { optional: true }));
  steps.push(updatesStep(f));

  // Payroll (for whoever runs the organization, or already has a vault here), its own steps one by one.
  const runsOrg = org && ['owner', 'admin'].includes(org.role);
  const p = f.payroll || {};
  if (runsOrg || p.initialized) {
    steps.push(step('payroll', 'Payroll set up on this computer', p.initialized === true, p.initialized ? 'The vault is set up.' : 'Set up the payroll vault with a passphrase.', 'payroll'));
    if (p.initialized) {
      const sum = p.summary;
      if (!sum) steps.push(step('payroll.open', 'Payroll’s own steps', false, 'Open Payroll once to see what’s left there.', 'payroll'));
      else for (const x of sum.steps || []) {
        if (x.blocking) {
          if (!x.done) steps.push(step(`payroll.${x.id}`, `Tax tables checked for ${sum.year}`, false, 'Pay runs can be reviewed but not finalized until the KeaS maintainers check the tables against the official sources and send them in an update. Nothing to do here but keep KeaS updated.', null, { waiting: true }));
          continue;
        }
        steps.push(step(`payroll.${x.id}`, x.title, x.done, x.text || (x.done ? 'Done.' : 'In Payroll.'), 'payroll', x.optional ? { optional: true } : {}));
      }
    }
  }
  return { ...finish(steps), org: org ? { id: org.id, name: org.name, state: org.state || null, tz: org.tz || null, role: org.role, status: org.status } : null };
}
const reachStep = (c) => step('reach', 'Reachable from anywhere', !!c.publicUrl,
  c.publicUrl ? c.publicUrl : 'Only this computer can reach the server. Set up Tailscale Funnel so people can clock in and see schedules from anywhere.', 'reach');
const updatesStep = (f) => step('updates', 'KeaS is up to date', f.update?.status !== 'ready',
  f.update?.status === 'ready' ? (f.update.nightly?.on ? `KeaS ${f.update.version} is downloaded. It installs tonight between ${f.update.nightly.hours}, or install it now.` : `KeaS ${f.update.version} is downloaded. Restart to install it.`) : 'KeaS checks for updates by itself.', 'update');

/** { steps, left, allSet }: allSet once every required step is done (a waiting one doesn't hold it up). */
function finish(steps) {
  const left = steps.filter((s) => !s.done && !s.optional && !s.waiting).length;
  return { steps, left, allSet: left === 0, waiting: steps.filter((s) => s.waiting && !s.done).length };
}

module.exports = { keasSteps };
