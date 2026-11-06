// KeaS first-run setup (and the status screen afterwards). Plain DOM, no innerHTML: every bit of text is set as text.
'use strict';
const k = window.keas;
const app = document.getElementById('app');
const S = { step: 'welcome', role: 'hub', dataDir: '', storageDir: '', quotaGb: 5, reach: 'tailscale', drives: [], defaults: {}, config: {}, ts: {}, log: [], busy: false, error: '', owner: null, totp: null, terms: null, agreed: new Set(), totpDone: false };

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (key === 'class') el.className = v;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), v);
    else if (key === 'value') el.value = v;
    else if (key === 'checked') el.checked = !!v;
    // (Set through the DOM: the page's CSP blocks style attributes in markup.)
    else if (key === 'style') el.style.cssText = v;
    else el.setAttribute(key, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const gb = (b) => `${(b / 1024 ** 3).toFixed(b > 1024 ** 4 ? 0 : 1)} GB`;
const size = (b) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : gb(b));
async function call(fn, arg) {
  const r = await fn(arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function fail(e) { S.error = String(e.message || e); S.busy = false; render(); }

const STEPS = { hub: ['welcome', 'storage', 'reach', 'owner', 'boot', 'done'], org: ['welcome', 'storage', 'reach', 'done'], join: ['welcome'] };
const LABELS = { welcome: 'Start', storage: 'Where data goes', reach: 'Reachable from anywhere', owner: 'Your owner account', boot: 'Start before sign-in', done: 'Done' };
function go(step) { S.step = step; S.error = ''; render(); window.scrollTo(0, 0); }
function next() { const list = STEPS[S.role || 'hub']; go(list[list.indexOf(S.step) + 1]); }
function back() { const list = STEPS[S.role || 'hub']; go(list[Math.max(0, list.indexOf(S.step) - 1)]); }

function renderProgress() {
  const el = document.getElementById('progress');
  el.replaceChildren();
  if (S.step === 'status' || S.step === 'settings') return;
  const list = STEPS[S.role || 'hub'];
  const at = list.indexOf(S.step);
  list.forEach((s, i) => el.append(h('li', { class: i === at ? 'on' : i < at ? 'done' : '' }, LABELS[s])));
}

// ---------- steps ----------
function welcome() {
  const choice = (role, title, text, tag) =>
    h('button', { class: `choice ${S.role === role ? 'on' : ''}`, onclick: () => { S.role = role; render(); } }, h('b', null, title, tag && h('span', { class: 'tag' }, tag)), h('span', { class: 'muted' }, text));
  return [
    h('h1', null, 'Set up a Kea Hub on this computer'),
    h('p', { class: 'muted' }, 'A Kea Hub is the server Kea accounts, classes, study groups and Kea storage live on. This makes a new Hub of your own on this computer.'),
    h('div', { class: 'cards' },
      choice('hub', 'Run a Kea Hub', 'Accounts with two-step sign-in, classes and invite codes, study leaderboards, Kea storage and sync, and Kea’s shared Claude.'),
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.role !== 'hub', onclick: () => { S.dataDir = S.dataDir || S.defaults.hubData; go('storage'); } }, 'Next')),
  ];
}

function storage() {
  const name = S.role === 'hub' ? 'Kea Hub' : 'KeaS Server';
  const pick = (d) => { S.dataDir = `${d.root}${name}`; S.storageDir = ''; render(); };
  const onDrive = (d) => S.dataDir.toUpperCase().startsWith(d.root.toUpperCase());
  return [
    h('h1', null, 'Where should the data go?'),
    h('p', { class: 'muted' }, S.role === 'hub'
      ? 'Accounts, classes, study progress and everyone’s Kea storage are kept here. Pick a big drive: Kea data is mostly text, so even a few TB holds a lot of people.'
      : 'Your organization’s schedules, punches and records are kept here.'),
    h('div', { class: 'drives' }, S.drives.map((d) =>
      h('button', { class: `choice drive ${onDrive(d) ? 'on' : ''}`, onclick: () => pick(d) },
        h('b', null, `${d.letter}: drive`), h('span', { class: 'muted small' }, `${size(d.free)} free of ${size(d.total)}`),
        h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((1 - d.free / d.total) * 100)}%` }))))),
    h('label', { class: 'field' }, 'Folder', h('div', { class: 'row' },
      h('input', { type: 'text', value: S.dataDir, oninput: (e) => (S.dataDir = e.target.value) }),
      h('button', { class: 'btn', onclick: async () => { const p = await call(k.pickFolder, { start: S.dataDir }).catch(fail); if (p) { S.dataDir = p; render(); } } }, 'Choose…'))),
    S.role === 'hub' && h('details', null, h('summary', null, 'Advanced'),
      h('label', { class: 'field' }, 'Standard Kea storage for each account (GB)', h('input', { type: 'number', min: '1', max: '100000', value: String(S.quotaGb), oninput: (e) => (S.quotaGb = Number(e.target.value) || 5) })),
      h('p', { class: 'muted small' }, 'Supporters get 25 GB, and you can give any account more later from the owner console. A limit keeps one person from filling the whole drive.'),
      h('label', { class: 'field' }, 'Keep account files in a different folder (optional)', h('div', { class: 'row' },
        h('input', { type: 'text', value: S.storageDir, placeholder: `${S.dataDir}\\storage`, oninput: (e) => (S.storageDir = e.target.value) }),
        h('button', { class: 'btn', onclick: async () => { const p = await call(k.pickFolder, { start: S.storageDir || S.dataDir }).catch(fail); if (p) { S.storageDir = p; render(); } } }, 'Choose…')))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: back }, 'Back'),
      h('button', { class: 'btn primary', disabled: S.busy || !S.dataDir.trim(), onclick: async () => {
        S.busy = true; render();
        try { await call(k.checkFolder, { dir: S.dataDir }); S.busy = false; go('reach'); } catch (e) { fail(new Error(`Can’t use that folder: ${e.message}`)); }
      } }, 'Next')),
  ];
}

const TS_STEPS = [
  ['install', 'Install Tailscale', 'Free. Windows asks once for permission.'],
  ['login', 'Sign in to Tailscale', 'Your browser opens. Any Google, Microsoft or GitHub account works.'],
  ['funnel', 'Turn on Funnel', 'Gives this computer a public https address. The first time, Tailscale asks you to allow it in the browser.'],
];
function tsDone(id) {
  const t = S.ts;
  return id === 'install' ? !!t.installed : id === 'login' ? !!t.loggedIn : !!t.funnel;
}
async function setUpTailscale() {
  S.busy = true; S.error = ''; S.log = []; render();
  try {
    await call(k.saveSetup, { role: S.role, dataDir: S.dataDir, storageDir: S.storageDir, quotaGb: S.quotaGb, reach: 'tailscale' });
    await call(k.start);
    S.running = 'install'; render();
    if (!(await call(k.tsStatus)).installed) await call(k.tsInstall);
    S.ts = await call(k.tsStatus); S.running = 'login'; render();
    if (!S.ts.loggedIn) await call(k.tsLogin);
    S.ts = await call(k.tsStatus); S.running = 'funnel'; render();
    if (!S.ts.funnel) S.ts = await call(k.tsFunnel);
    S.ts = await call(k.tsStatus);
    S.publicUrl = S.ts.url;
    S.running = null; S.busy = false; render();
  } catch (e) { S.running = null; fail(e); }
}
function reach() {
  const opt = (v, title, text, tag) => h('button', { class: `choice ${S.reach === v ? 'on' : ''}`, disabled: S.busy, onclick: () => { S.reach = v; render(); } }, h('b', null, title, tag && h('span', { class: 'tag' }, tag)), h('span', { class: 'muted' }, text));
  const allDone = S.reach === 'local' || TS_STEPS.every(([id]) => tsDone(id));
  return [
    h('h1', null, 'Make it reachable from anywhere'),
    h('p', { class: 'muted' }, S.role === 'hub' ? 'So people can sign in to Kea from their own homes and phones.' : 'So your staff can clock in and see schedules from their phones.'),
    h('div', { class: 'cards' },
      opt('tailscale', 'Anywhere, free (Tailscale Funnel)', 'KeaS installs and sets it up. Your home address stays hidden and no router settings change.', 'Recommended'),
      opt('local', 'Only this computer', 'For trying KeaS out. Nobody else can reach it.')),
    S.reach === 'tailscale' && h('div', { class: 'panel' },
      h('ul', { class: 'steps' }, TS_STEPS.map(([id, title, text]) =>
        h('li', null, h('span', { class: `dot ${tsDone(id) ? 'ok' : S.running === id ? 'run' : ''}` }), h('div', null, h('b', null, title), h('div', { class: 'muted small' }, text))))),
      S.publicUrl && h('p', { class: 'ok', style: 'margin-top:12px' }, 'Your public address: ', h('span', { class: 'url' }, S.publicUrl)),
      S.log.length > 0 && h('div', { class: 'log' }, S.log.slice(-40).join('\n')),
      !allDone && h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.busy, onclick: setUpTailscale }, S.busy ? 'Setting up…' : 'Set it up'))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: back }, 'Back'),
      h('button', { class: 'btn primary', disabled: S.busy || !allDone, onclick: async () => {
        S.busy = true; render();
        try {
          if (S.reach === 'local') { await call(k.saveSetup, { role: S.role, dataDir: S.dataDir, storageDir: S.storageDir, quotaGb: S.quotaGb, reach: 'local' }); await call(k.start); }
          S.busy = false; next();
        } catch (e) { fail(e); }
      } }, 'Next')),
  ];
}

function sectionBody(body) {
  const out = []; let list = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', null, line.slice(2))); }
    else { list = null; if (line.trim()) out.push(h('p', null, line)); }
  }
  return out;
}
function owner() {
  if (!S.terms) { call(k.terms).then((t) => { S.terms = t.terms; render(); }).catch(fail); return [h('p', { class: 'muted' }, 'Getting the terms…')]; }
  if (S.totp && !S.totpDone)
    return [
      h('h1', null, 'Turn on two-step sign-in'),
      h('p', { class: 'muted' }, 'The owner account controls the whole Hub, so it always needs a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). In the app, add an account by entering this key:'),
      h('div', { class: 'secret' }, S.totp.secret.replace(/(.{4})/g, '$1 ').trim()),
      h('p', { class: 'muted small', style: 'margin-top:8px' }, `Account: ${S.owner.email} · Issuer: Kea · Time-based`),
      h('label', { class: 'field' }, 'The 6-digit code it shows', h('input', { type: 'text', id: 'code', inputmode: 'numeric', maxlength: '6', value: S.code || '', oninput: (e) => (S.code = e.target.value) })),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.busy, onclick: async () => {
        // (Read before re-rendering: render() rebuilds the inputs.)
        const code = S.code || '';
        S.busy = true; render();
        try { await call(k.ownerTotp, { code }); S.totpDone = true; S.busy = false; next(); } catch (e) { fail(e); }
      } }, 'Turn it on')),
    ];
  const all = S.terms.sections.every((s) => S.agreed.has(s.id));
  const f = S.form || (S.form = { name: '', email: '', password: '' });
  return [
    h('h1', null, 'Your owner account'),
    h('p', { class: 'muted' }, 'This is your own Kea account, the same one you sign in to Kea with, made the owner of this Hub. If you already have one on this Hub, use the same email and password.'),
    h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: f.name, oninput: (e) => (f.name = e.target.value) })),
    h('label', { class: 'field' }, 'Email', h('input', { type: 'email', value: f.email, oninput: (e) => (f.email = e.target.value) })),
    h('label', { class: 'field' }, 'Password (10+ characters; a few random words works well)', h('input', { type: 'password', value: f.password, oninput: (e) => (f.password = e.target.value) })),
    h('h2', { style: 'margin-top:18px' }, `${S.terms.title} · version ${S.terms.version}`),
    h('p', { class: 'muted small' }, 'Like every Kea account, yours agrees to each section. You can change these terms later; everyone then agrees again, seeing only what changed.'),
    h('div', { class: 'terms' }, S.terms.sections.map((s) =>
      h('div', { class: `term ${S.agreed.has(s.id) ? 'agreed' : ''}` }, h('h3', null, s.title), sectionBody(s.body),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.agreed.has(s.id), onchange: (e) => { e.target.checked ? S.agreed.add(s.id) : S.agreed.delete(s.id); render(); } }), 'I agree to this section')))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: back }, 'Back'),
      h('button', { class: 'btn primary', disabled: S.busy || !all || !f.name.trim() || !f.email.trim() || f.password.length < 10, onclick: async () => {
        S.busy = true; render();
        try {
          const r = await call(k.ownerCreate, { name: f.name, email: f.email, password: f.password, termsVersion: S.terms.version, termsSections: S.terms.sections.map((s) => s.id) });
          S.owner = r; S.totp = r.totp; S.busy = false;
          if (!r.totp) { S.totpDone = true; next(); } else render();
        } catch (e) { fail(e); }
      } }, 'Agree and create')),
  ];
}

// ---------- start before sign-in, and power (a setup step, and the settings page later) ----------
const BOOT_ADV = [
  ['neverSleepAC', 'Never sleep on AC power', 'Sleep stops the Hub. On battery, Windows still sleeps as usual.'],
  ['neverHibernateAC', 'Never hibernate on AC power', ''],
  ['wakeTimersAC', 'Allow wake timers on AC power', 'Lets Windows wake the PC for scheduled tasks and updates.'],
  ['disksNeverOffAC', 'Keep drives from turning off on AC power', 'A drive that has spun down makes the first request after a quiet spell slow.'],
  ['runOnBattery', 'Keep the Hub running on battery', 'For a laptop or a PC on a battery backup (UPS).'],
  ['restartOnFailure', 'Restart the Hub if it stops with an error', ''],
];
const BOOT_NUM = [
  ['delaySeconds', 'Wait after Windows starts (seconds)', 0, 3600, 'So the network and Tailscale are up first.'],
  ['restartCount', 'Restart tries', 1, 999, ''],
  ['restartMinutes', 'Minutes between restart tries', 1, 1440, ''],
];
const POWER_NAMES = { standby: 'Sleep after', hibernate: 'Hibernate after', wake: 'Wake timers', disk: 'Turn off drives after' };
function powerValue(key, v) {
  if (v == null) return 'unknown';
  if (key === 'wake') return ['Off', 'On', 'Important ones only'][v] ?? String(v);
  if (v === 0) return 'Never';
  return v % 60 === 0 ? `${v / 60} min` : `${v} s`;
}
async function loadBoot() {
  S.bs = await call(k.bootStatus);
  if (!S.bo) S.bo = { ...S.bs.options };
  render();
}
async function applyBoot({ dryRun = false, after } = {}) {
  S.busy = true; S.error = ''; S.bootResult = null; render();
  try {
    const r = await call(k.bootApply, { options: S.bo, dryRun });
    if (dryRun) S.bootScript = r.script;
    else { S.bootResult = r; S.bs = r.status; S.bootScript = null; }
    S.busy = false;
    if (!dryRun && r.ok && after) after(); else render();
  } catch (e) { fail(e); }
}
async function removeBoot({ dryRun = false } = {}) {
  S.busy = true; S.error = ''; S.bootResult = null; render();
  try {
    const r = await call(k.bootRemove, { dryRun });
    if (dryRun) S.bootScript = r.script;
    else { S.bootResult = r; S.bs = r.status; S.bootScript = null; }
    S.busy = false; render();
  } catch (e) { fail(e); }
}
function bootForm() {
  const o = S.bo;
  const box = (key, label, hint, disabled) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: o[key], disabled: disabled || S.busy, onchange: (e) => { o[key] = e.target.checked; render(); } }),
    h('span', null, label, hint && h('span', { class: 'muted small' }, ` ${hint}`)));
  const t = S.bs.task || {};
  const p = S.bs.power?.values || {};
  const prev = S.bs.saved?.powerApplied ? S.bs.saved.previous?.values : null;
  return [
    box('bootStart', 'Start the Kea Hub when Windows starts, before anyone signs in', 'Recommended for the PC the Hub lives on.'),
    box('power', 'Keep this PC awake on AC power', 'So the Hub doesn’t go to sleep at night.'),
    h('details', { open: !!S.bootAdv, ontoggle: (e) => (S.bootAdv = e.target.open) }, h('summary', null, 'Advanced'),
      h('p', { class: 'muted small' }, `The Hub runs as a Scheduled Task (${S.bs.taskName}) under your Windows account, with highest privileges, whether or not you’re signed in. It doesn’t store your Windows password, so it can’t reach network drives: keep the Hub’s data on a drive inside this PC.`),
      BOOT_ADV.map(([key, label, hint]) => box(key, label, hint, (key === 'runOnBattery' || key === 'restartOnFailure' ? !o.bootStart : !o.power))),
      BOOT_NUM.map(([key, label, min, max, hint]) => h('label', { class: 'field' }, label,
        h('input', { type: 'number', min: String(min), max: String(max), value: String(o[key]), disabled: !o.bootStart || S.busy, oninput: (e) => (o[key] = Number(e.target.value)) }),
        hint && h('span', { class: 'muted small' }, hint))),
      h('h3', null, 'Power settings now (on AC power)'),
      h('ul', { class: 'small' }, Object.keys(POWER_NAMES).map((key) => h('li', null, `${POWER_NAMES[key]}: ${powerValue(key, p[key])}`,
        prev && prev[key] != null && prev[key] !== p[key] ? h('span', { class: 'muted' }, ` (before KeaS: ${powerValue(key, prev[key])})`) : null))),
      h('p', null, h('button', { class: 'btn', disabled: S.busy, onclick: () => applyBoot({ dryRun: true }) }, 'Show what it runs'),
        ' ', (S.bs.saved?.installed || S.bs.saved?.powerApplied) && h('button', { class: 'btn', disabled: S.busy, onclick: () => removeBoot({ dryRun: true }) }, 'Show what turning it off runs')),
      S.bootScript && h('div', { class: 'log' }, S.bootScript)),
    h('div', { class: 'panel' },
      h('p', null, h('b', null, 'After a power cut')),
      h('p', { class: 'muted small' }, S.bs.note)),
    h('p', { class: 'small' }, h('span', { class: `dot ${t.installed ? 'ok' : ''}`, style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }),
      t.installed ? `Starts before sign-in: on${t.state ? ` (task ${t.state.toLowerCase()}${t.lastResult ? `, last result ${t.lastResult}` : ''})` : ''}.` : 'Starts before sign-in: off.',
      S.bs.external ? ' The Hub running now was started before sign-in.' : ''),
    S.bootResult && h('ul', { class: 'small' }, S.bootResult.steps.map((s) => h('li', { class: s.ok ? 'ok' : 'err' }, `${s.step}: ${s.ok ? 'done' : s.error}`))),
  ].filter(Boolean);
}
function boot() {
  if (!S.bs) { loadBoot().catch(fail); return [h('p', { class: 'muted' }, 'Checking this PC’s settings…')]; }
  const nothing = !S.bo.bootStart && !S.bo.power;
  return [
    h('h1', null, 'Start before sign-in'),
    h('p', { class: 'muted' }, 'So the Hub is there for everyone even after Windows restarts for an update, without you signing in, and so the PC doesn’t fall asleep. Windows asks once for permission. You can turn this off any time from the tray icon or the settings page, and the power settings go back to how they were.'),
    ...bootForm(),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: back }, 'Back'),
      h('button', { class: 'btn', disabled: S.busy, onclick: next }, 'Skip'),
      h('button', { class: 'btn primary', disabled: S.busy || nothing, onclick: () => applyBoot({ after: next }) }, S.busy ? 'Setting up…' : 'Set it up')),
  ];
}
function settings() {
  if (!S.bs) { loadBoot().catch(fail); return [h('p', { class: 'muted' }, 'Checking this PC’s settings…')]; }
  const on = S.bs.saved?.installed || S.bs.saved?.powerApplied || S.bs.task?.installed;
  return [
    h('h1', null, 'Startup and power'),
    h('p', { class: 'muted' }, 'Start the Kea Hub before anyone signs in, and keep this PC awake for it. Saving asks Windows for permission once.'),
    ...bootForm(),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: () => load().catch(fail) }, 'Back'),
      on && h('button', { class: 'btn', disabled: S.busy, onclick: () => removeBoot() }, 'Turn it all off'),
      h('button', { class: 'btn primary', disabled: S.busy || (!S.bo.bootStart && !S.bo.power), onclick: () => applyBoot() }, S.busy ? 'Saving…' : 'Save')),
  ];
}

function done() {
  const url = S.publicUrl || S.config.publicUrl || null;
  return [
    h('h1', null, 'All set'),
    h('div', { class: 'panel' },
      h('p', null, h('b', null, S.role === 'hub' ? 'The Kea Hub is running.' : 'Your organization’s server is running.')),
      url ? h('p', null, 'Public address: ', h('span', { class: 'url' }, url)) : h('p', { class: 'muted' }, 'Only reachable on this computer.'),
      h('p', null, 'Data: ', h('span', { class: 'url' }, S.dataDir), ' ', h('button', { class: 'btn', onclick: () => k.openFolder({ dir: S.dataDir }) }, 'Open folder')),
      S.role === 'hub' && h('p', { class: 'muted small' }, 'Kea on this computer now signs in to this Hub.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'boot', checked: S.boot !== false, onchange: (e) => (S.boot = e.target.checked) }), 'Start KeaS when Windows starts (it waits in the tray and keeps the server running)'),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
      try { await call(k.finish, { startWithWindows: S.boot !== false, theme: document.getElementById('theme').value }); await load(); } catch (e) { fail(e); }
    } }, 'Finish')),
  ];
}

function status() {
  const c = S.config;
  return [
    h('h1', null, c.role === 'hub' ? 'Kea Hub' : 'KeaS server'),
    h('div', { class: 'panel' },
      h('p', null, h('span', { class: `dot ${S.running ? 'ok' : 'bad'}`, style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }), S.running ? 'Running' : 'Not running'),
      c.publicUrl ? h('p', null, 'Public address: ', h('span', { class: 'url' }, c.publicUrl)) : h('p', { class: 'muted' }, 'Only reachable on this computer.'),
      h('p', null, 'Data: ', h('span', { class: 'url' }, c.dataDir), ' ', h('button', { class: 'btn', onclick: () => k.openFolder({ dir: c.dataDir }) }, 'Open folder')),
      c.role === 'hub' && h('p', { class: 'muted small' }, `Each account gets ${c.quotaGb || 5} GB of Kea storage. Owner: ${c.ownerEmail || 'not set'}.`)),
    c.role === 'hub' && h('div', { class: 'panel' },
      h('p', null, h('b', null, 'Startup and power')),
      h('p', { class: 'muted small' }, c.boot?.installed ? 'The Hub starts when Windows starts, before anyone signs in.' : 'The Hub starts when you sign in to Windows.',
        c.boot?.powerApplied ? ' This PC stays awake on AC power.' : '', S.hubExternal ? ' The Hub running now was started before sign-in.' : ''),
      h('button', { class: 'btn', onclick: () => { S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; go('settings'); } }, 'Change…')),
    c.role === 'hub' && c.publicUrl && h('p', null, h('button', { class: 'btn', onclick: () => k.openExternal({ url: `${c.publicUrl}/terms` }) }, 'Open the terms page')),
    h('h2', { style: 'margin-top:22px' }, 'Payroll'),
    h('div', { class: 'panel' },
      h('p', null, 'Pay runs, tax forms and HR records for your organization. Payroll runs only on this computer: SSNs and bank details are encrypted with a passphrase you choose and never go to the Hub.'),
      h('p', null, h('button', { class: 'btn primary', onclick: async () => { try { await call(k.openPayroll); } catch (e) { fail(e); } } }, 'Open Payroll'))),
    S.error && h('div', { class: 'err' }, S.error),
    h('p', { class: 'muted small' }, 'Closing this window keeps the server running in the tray. Quit from the tray icon to stop it.'),
  ];
}

const VIEWS = { welcome, storage, reach, owner, boot, done, status, settings };
function render() {
  renderProgress();
  app.replaceChildren(...VIEWS[S.step]().filter((x) => x != null && x !== false && x !== ''));
}

async function load() {
  const st = await call(k.state);
  S.config = st.config; S.defaults = st.defaults;
  S.running = st.running.hub || st.running.org;
  S.hubExternal = !!st.running.hubExternal;
  document.getElementById('theme').value = st.config.theme || 'system';
  applyTheme(st.config.theme || 'system');
  if (st.config.setupDone) { S.role = st.config.role; S.step = 'status'; }
  S.drives = await call(k.drives).catch(() => []);
  render();
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
document.getElementById('theme').addEventListener('change', (e) => { applyTheme(e.target.value); k.setTheme({ theme: e.target.value }); });
k.onProgress((line) => { S.log.push(line); if (S.step === 'reach') render(); });
// The tray's "Power settings…" opens the settings page (once setup is done).
k.onNavigate((view) => {
  if (view !== 'settings' || !S.config.setupDone || S.busy) return;
  S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null;
  go('settings');
});
load().catch(fail);
