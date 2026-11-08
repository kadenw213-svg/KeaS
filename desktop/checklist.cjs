// "Get set up" in the KeaS window: every step between installing KeaS and being good to go, for this person on this
// PC. Each step: done or not, one short sentence, and an action (where the KeaS window takes them to do it). No
// Electron here: main.cjs gathers the facts, this decides the steps, so the logic is tested.
//
// A step is { id, title, done, text, action, optional?, waiting? }. waiting: nobody here can do it (the tax tables are
// checked by the KeaS maintainers and arrive in an update); it never counts as done, but it doesn't keep the list open.
'use strict';

const step = (id, title, done, text, action = null, extra = {}) => ({ id, title, done: !!done, text, action, ...extra });

/**
 * f: {
 *   hub: hub mode (the Hub's PC), config, folderProblem, hubRunning, lastStartError, owner: { exists, owner, totp } | null,
 *   update: { status, version }, account: account.status() result, orgs: [{ id, name, state, role, status }] | null,
 *   orgsError, payroll: { initialized, summary: { left, total, year, steps } | null } | null,
 *   payCodes: { [orgId]: { count, given } | { error } } | undefined (the organizations this person runs)
 * }
 */
function keasSteps(f = {}) {
  const c = f.config || {};
  const steps = [];
  if (f.hub && c.setupDone) {
    steps.push(step('hubFolder', 'The Hub’s data folder', c.dataDir && !f.folderProblem,
      f.folderProblem ? f.folderProblem : `${c.dataDir}.`, 'status'));
    steps.push(step('hubRunning', 'The Hub is running', f.hubRunning,
      f.hubRunning ? 'It answers on this PC.' : f.lastStartError ? `It didn’t start: ${f.lastStartError}` : 'Start it.', 'startHub'));
    steps.push(step('reach', 'Reachable from anywhere', !!c.publicUrl,
      c.publicUrl ? c.publicUrl : 'Only this computer can reach the Hub. Set up Tailscale Funnel so people can sign in from anywhere.', 'reach'));
    steps.push(step('owner', 'Owner account with two-step sign-in', f.owner?.owner && f.owner?.totp,
      f.owner?.owner && f.owner?.totp ? `${f.owner.email || c.ownerEmail}.` : 'The owner account needs two-step sign-in on.', 'signin'));
    steps.push(step('boot', 'Start before sign-in and keep the PC awake', !!c.boot?.installed,
      c.boot?.installed ? 'The Hub starts when Windows starts.' : 'So the Hub comes back by itself after Windows restarts. Windows asks for permission once.', 'settings', { optional: true }));
    steps.push(step('updates', 'KeaS is up to date', f.update?.status !== 'ready',
      f.update?.status === 'ready' ? (f.update.nightly?.on ? `KeaS ${f.update.version} is downloaded. It installs tonight between ${f.update.nightly.hours}, or install it now.` : `KeaS ${f.update.version} is downloaded. Restart to install it.`) : 'KeaS checks for updates by itself.', 'update'));
  }

  const a = f.account || {};
  const me = a.account || null;
  steps.push(step('account', 'Signed in to your Kea account', a.signedIn,
    a.signedIn ? `${me?.email || ''}${a.reachable === false ? ' (the Hub can’t be reached right now)' : ''}.` : 'Sign in, or create an account.', 'signin'));
  if (!a.signedIn) return finish(steps);
  if (me) {
    steps.push(step('email', 'Email verified', me.emailVerified || me.owner,
      me.emailVerified || me.owner ? 'Organizations and payroll can use your account.' : 'Payroll and making an organization need a verified email. In the Kea app: Kea account, Verify with Google. Or ask your manager to verify it.', 'recheck'));
    if (me.terms?.needsAgreement) steps.push(step('terms', 'The Kea terms', false, 'They changed. Read and agree to keep using your account.', 'termsAccept'));
  }

  // The organization on the Kea Hub (schedules, the time clock and members in Kea; payroll's organization details
  // come from here too). Approval by the Hub's owner is how the Hub verifies an organization.
  const orgs = f.orgs || [];
  const mine = orgs.filter((o) => ['owner', 'admin'].includes(o.role));
  const inOrg = (o) => o.memberStatus !== 'pending';
  const org = mine.find((o) => o.status === 'active') || mine[0] || orgs.find((o) => o.status === 'active' && inOrg(o)) || orgs.find(inOrg) || orgs[0] || null;
  if (f.orgs == null) steps.push(step('org', 'Your organization', false, f.orgsError ? `Can’t check right now: ${f.orgsError}` : 'Checking…', 'recheck'));
  else if (org && !inOrg(org)) {
    // Asked to join (a code that needs approval, or an email that isn't verified yet): a manager decides.
    steps.push(step('org', 'Your organization', false, `Request sent to ${org.name}. Your manager approves it. This list checks again by itself.`, 'recheck'));
  } else {
    steps.push(step('org', 'Your organization', !!org,
      org ? `${org.name}${org.role ? ` (you’re ${org.role === 'owner' ? 'the owner' : `a${org.role === 'admin' ? 'n' : ''} ${org.role}`})` : ''}.` : 'Create your organization on the Kea Hub, or join one with a code.', 'org'));
    if (org) {
      steps.push(step('orgApproved', 'Organization approved on the Kea Hub', org.status === 'active',
        org.status === 'active' ? 'The Hub’s owner approved it.' : org.status === 'suspended' ? 'It’s suspended on the Kea Hub. Contact Kea support.' : 'Waiting for the Kea Hub’s owner to approve it. This list checks again by itself.', 'recheck'));
      if (['owner', 'admin'].includes(org.role)) steps.push(step('orgPlace', 'Where people work', !!org.state,
        org.state ? `${org.state}. Payroll asks for the city or county.` : 'Add the state, so the right labor and tax rules apply.', 'orgEdit'));
      // Pay codes: a job's rate (Lifeguard $15). Payroll pays every hour at the code it was worked at.
      const pc = f.payCodes?.[org.id];
      if (['owner', 'admin'].includes(org.role) && org.status === 'active' && pc) {
        steps.push(step('payCodes', 'Pay codes', pc.count > 0 && pc.given > 0,
          pc.error ? `Can’t check right now: ${pc.error}` : !pc.count ? 'Make a pay code for each job and its rate (like Lifeguard, $15 an hour), then give people theirs. Payroll pays every hour at the code it was worked at.'
            : !pc.given ? `${pc.count} pay code${pc.count === 1 ? '' : 's'}, not given to anyone yet. Give each person theirs; their first is their default.` : `${pc.count} pay code${pc.count === 1 ? '' : 's'}, given to people.`,
          'recheck'));
      }
    }
  }

  // Payroll (for whoever runs the organization, or already has a vault here).
  const runsOrg = org && ['owner', 'admin'].includes(org.role);
  const p = f.payroll || {};
  if (runsOrg || p.initialized) {
    steps.push(step('payroll', 'Payroll set up on this computer', p.initialized === true,
      p.initialized ? 'The vault is set up.' : 'Set up the payroll vault with a passphrase.', 'payroll'));
    if (p.initialized) {
      const s = p.summary;
      if (!s) steps.push(step('payrollSteps', 'Payroll ready for a pay run', false, 'Open Payroll to see what’s left.', 'payroll'));
      else {
        const todo = s.steps.filter((x) => !x.done && !x.optional && !x.blocking);
        steps.push(step('payrollSteps', 'Payroll ready for a pay run', !todo.length,
          todo.length ? `${todo.length} left in Payroll: ${todo.map((x) => x.title.toLowerCase()).join(', ')}.` : 'Everything payroll needs is in place.', 'payroll'));
        const tables = s.steps.find((x) => x.blocking);
        if (tables && !tables.done) steps.push(step('tables', `Tax tables checked for ${s.year}`, false,
          'Pay runs can be reviewed but not finalized until the KeaS maintainers check the tables against the official sources and send them in an update. Nothing to do here but keep KeaS updated.', null, { waiting: true }));
      }
    }
  }
  // (The organization, so Payroll's setup can start from its name, state and time zone.)
  return { ...finish(steps), org: org ? { id: org.id, name: org.name, state: org.state || null, tz: org.tz || null, role: org.role, status: org.status } : null };
}

/** { steps, left, allSet }: allSet once every required step is done (a waiting one doesn't hold it up). */
function finish(steps) {
  const left = steps.filter((s) => !s.done && !s.optional && !s.waiting).length;
  return { steps, left, allSet: left === 0, waiting: steps.filter((s) => s.waiting && !s.done).length };
}

module.exports = { keasSteps };
