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
  if (!r.ok) { const e = new Error(r.error); e.status = r.status; e.data = r.data || {}; throw e; }
  return r.value;
}
function fail(e) { S.error = String(e.message || e); S.busy = false; render(); }

const STEPS = { hub: ['welcome', 'storage', 'reach', 'owner', 'boot', 'done'], org: ['welcome', 'storage', 'reach', 'done'], join: ['welcome'] };
const LABELS = { welcome: 'Start', storage: 'Where data goes', reach: 'Reachable from anywhere', owner: 'Your owner account', boot: 'Start before sign-in', done: 'Done' };
function go(step) {
  S.step = step; S.error = ''; render(); window.scrollTo(0, 0);
  // Setup remembers where it got to, so a restart picks up here.
  if (S.hub && !S.config.setupDone && STEPS.hub.includes(step)) k.setupStep({ step }).catch(() => {});
}
function next() { const list = STEPS[S.role || 'hub']; go(list[list.indexOf(S.step) + 1]); }
function back() { const list = STEPS[S.role || 'hub']; go(list[Math.max(0, list.indexOf(S.step) - 1)]); }

function renderProgress() {
  const el = document.getElementById('progress');
  el.replaceChildren();
  if (!S.hub || !STEPS.hub.includes(S.step)) return;
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
  // (Another drive keeps the folder name typed so far; only the drive letter changes.)
  const pick = (d) => { const rest = /^[a-z]:\\(.+)$/i.exec(S.dataDir.trim())?.[1]; S.dataDir = `${d.root}${rest || name}`; S.storageDir = ''; render(); };
  const onDrive = (d) => S.dataDir.toUpperCase().startsWith(d.root.toUpperCase());
  return [
    h('h1', null, 'Where should the data go?'),
    h('p', { class: 'muted' }, S.role === 'hub'
      ? 'Accounts, classes, study progress and everyone’s Kea storage are kept here. Pick a big drive: Kea data is mostly text, so even a few TB holds a lot of people.'
      : 'Your organization’s schedules, punches and records are kept here.'),
    h('div', { class: 'drives' }, S.drives.map((d) =>
      h('button', { class: `choice drive ${onDrive(d) ? 'on' : ''}`, onclick: () => pick(d) },
        h('b', null, `${d.letter}: ${d.label || 'drive'}`), h('span', { class: 'muted small' }, `${size(d.free)} free of ${size(d.total)}`),
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
        S.busy = true; S.error = ''; render();
        try { const r = await call(k.checkFolder, { dir: S.dataDir }); S.folderWarning = r.warning || null; S.busy = false; go('reach'); } catch (e) { fail(new Error(`Can’t use that folder: ${e.message}`)); }
      } }, S.busy ? 'Checking…' : 'Next')),
    h('p', { class: 'muted small' }, 'Only drives inside this PC are shown: cloud drives (Google Drive, OneDrive…), network and removable drives can’t hold the Hub’s data.'),
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
    // (From the Hub's status page later: only the reachability changes; the Hub restarts to match.)
    if (S.step === 'reachSettings') await call(k.reachSet, { reach: 'tailscale' });
    else await call(k.saveSetup, { role: S.role, dataDir: S.dataDir, storageDir: S.storageDir, quotaGb: S.quotaGb, reach: 'tailscale' });
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
  const later = S.step === 'reachSettings';
  // What's already done in Tailscale (installed, signed in, Funnel on), so the dots start out right.
  if (S.reach === 'tailscale' && !S.tsChecked && !S.busy) {
    S.tsChecked = true;
    call(k.tsStatus).then((t) => { S.ts = t; if (t.url && t.funnel) S.publicUrl = t.url; render(); }).catch(() => {});
  }
  const opt = (v, title, text, tag) => h('button', { class: `choice ${S.reach === v ? 'on' : ''}`, disabled: S.busy, onclick: () => { S.reach = v; render(); } }, h('b', null, title, tag && h('span', { class: 'tag' }, tag)), h('span', { class: 'muted' }, text));
  const allDone = S.reach === 'local' || TS_STEPS.every(([id]) => tsDone(id));
  if (later)
    return [
      h('h1', null, 'Make the Hub reachable from anywhere'),
      h('p', { class: 'muted' }, 'So people can sign in to Kea from their own homes and phones. KeaS installs and sets up Tailscale Funnel: your home address stays hidden and no router settings change. The Hub restarts for a moment.'),
      h('div', { class: 'panel' },
        h('ul', { class: 'steps' }, TS_STEPS.map(([id, title, text]) =>
          h('li', null, h('span', { class: `dot ${tsDone(id) ? 'ok' : S.running === id ? 'run' : ''}` }), h('div', null, h('b', null, title), h('div', { class: 'muted small' }, text))))),
        S.publicUrl && h('p', { class: 'ok', style: 'margin-top:12px' }, 'Your public address: ', h('span', { class: 'url' }, S.publicUrl)),
        S.log.length > 0 && h('div', { class: 'log' }, S.log.slice(-40).join('\n'))),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', disabled: S.busy, onclick: () => load().catch(fail) }, allDone ? 'Done' : 'Back'),
        !allDone && h('button', { class: 'btn primary', disabled: S.busy, onclick: setUpTailscale }, S.busy ? 'Setting up…' : 'Set it up')),
    ];
  return [
    h('h1', null, 'Make it reachable from anywhere'),
    S.folderWarning && h('div', { class: 'err' }, S.folderWarning),
    h('p', { class: 'muted' }, S.role === 'hub' ? 'So people can sign in to Kea from their own homes and phones.' : 'So your staff can clock in and see schedules from their phones.'),
    h('div', { class: 'cards' },
      opt('tailscale', 'Anywhere, free (Tailscale Funnel)', 'KeaS installs and sets it up. Your home address stays hidden and no router settings change.', 'Recommended'),
      opt('local', 'Only this computer for now', 'Nobody else can reach it. You can make it reachable later from the Hub’s status page.')),
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

/**
 * A QR code of the two-step key (the otpauth:// address the Hub gave), drawn right here: nothing is sent anywhere.
 * (vendor/qrcode-generator-1.4.4.js, MIT, by Kazuhiko Arase.)
 */
function qrImage(uri) {
  if (!uri || typeof window.qrcode !== 'function') return null;
  try {
    const q = window.qrcode(0, 'M');
    q.addData(uri);
    q.make();
    return h('img', { class: 'qr', alt: 'QR code for your authenticator app', src: q.createDataURL(6, 2) });
  } catch { return null; }
}
function sectionBody(body) {
  const out = []; let list = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', null, line.slice(2))); }
    else { list = null; if (line.trim()) out.push(h('p', null, line)); }
  }
  return out;
}
/** The two-step code box, with "Use a backup code" for someone without their phone. get/set: the value. */
function codeInput(get, set, { label = 'Code from your authenticator app', autofocus = false } = {}) {
  const backup = !!S.useBackup;
  return [
    h('label', { class: 'field' }, backup ? 'Backup code' : label,
      h('input', { type: 'text', inputmode: backup ? 'text' : 'numeric', autocomplete: backup ? 'off' : 'one-time-code', maxlength: backup ? '11' : '6', placeholder: backup ? 'XXXXX-XXXXX' : '', value: get() || '', autofocus, oninput: (e) => set(e.target.value) })),
    h('p', { class: 'small' }, h('button', { class: 'btn', type: 'button', onclick: () => { S.useBackup = !backup; set(''); render(); } }, backup ? 'Use the code from my app' : 'Use a backup code')),
  ];
}
/** New backup codes, shown once: Copy, Save as text, and "I saved these" before going on. */
function codesScreen({ title, intro, onDone }) {
  const codes = S.backupCodes || [];
  return [
    h('h1', null, title),
    h('p', { class: 'muted' }, intro),
    h('div', { class: 'panel' }, h('ol', { class: 'codes' }, codes.map((c) => h('li', null, h('code', null, c))))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        try { await navigator.clipboard.writeText(codes.join('\n')); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select the codes to copy them'; }
      } }, 'Copy'),
      h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        try { if (await call(k.saveCodes)) e.target.textContent = 'Saved'; } catch (err) { fail(err); }
      } }, 'Save as text…')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!S.codesSaved, onchange: (e) => {
      S.codesSaved = e.target.checked;
      const b = document.getElementById('codesNext'); if (b) b.disabled = !S.codesSaved;
    } }), 'I saved these'),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', id: 'codesNext', disabled: !S.codesSaved, onclick: async () => {
      await call(k.codesDone).catch(() => {});
      S.backupCodes = null; S.codesSaved = false; S.error = '';
      onDone();
    } }, 'Continue')),
  ];
}
const CODES_INTRO = 'If you lose your phone, each of these signs you in once instead of the code from your authenticator app. They’re shown only now. Keep them somewhere safe, away from this PC.';
/** New backup codes for the signed-in account, from the account panel. */
function codesView() {
  if (!S.backupCodes) return [h('p', { class: 'muted' }, 'No new backup codes.'), h('button', { class: 'btn', onclick: () => go(S.hub ? 'status' : 'home') }, 'Back')];
  return codesScreen({ title: 'Your new backup codes', intro: `${CODES_INTRO} Your old ones don’t work any more.`, onDone: () => { refreshAccount(); go(S.hub ? 'status' : 'home'); } });
}
function owner() {
  if (S.backupCodes) return codesScreen({ title: 'Save your backup codes', intro: CODES_INTRO, onDone: () => { S.ownerState = undefined; next(); } });
  // Where the owner step stands (an owner made before a restart, maybe with two-step sign-in already on).
  if (S.ownerState === undefined) {
    S.ownerState = null;
    call(k.ownerState).then((o) => { S.ownerState = o; render(); }).catch(() => {});
  }
  const o = S.ownerState;
  if (o && o.exists && o.owner && o.totp)
    return [
      h('h1', null, 'Your owner account'),
      h('div', { class: 'panel' },
        h('p', null, h('span', { class: 'dot ok', style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }), h('b', null, o.email), ' is the owner of this Hub.'),
        h('p', { class: 'muted small' }, 'Two-step sign-in is on. Nothing more to do here.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: back }, 'Back'),
        h('button', { class: 'btn primary', onclick: next }, 'Next')),
    ];
  if (!S.terms) { call(k.terms).then((t) => { S.terms = t.terms; render(); }).catch(fail); return [h('p', { class: 'muted' }, 'Getting the terms…')]; }
  if (S.totp && !S.totpDone)
    return [
      h('h1', null, 'Turn on two-step sign-in'),
      h('p', { class: 'muted' }, 'The owner account controls the whole Hub, so it always needs a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). In the app, scan this code, or add an account by entering the key:'),
      qrImage(S.totp.uri),
      h('div', { class: 'row' },
        h('div', { class: 'secret' }, S.totp.secret.replace(/(.{4})/g, '$1 ').trim()),
        h('button', { class: 'btn', type: 'button', onclick: async (e) => {
          try { await navigator.clipboard.writeText(S.totp.secret); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select the key to copy it'; }
        } }, 'Copy key')),
      h('p', { class: 'muted small', style: 'margin-top:8px' }, `Account: ${S.owner.email} · Issuer: Kea · Time-based`),
      form(async () => {
        // (Read before re-rendering: render() rebuilds the inputs.)
        const code = S.code || '';
        S.busy = true; render();
        try {
          await call(k.ownerTotp, { code });
          S.totpDone = true; S.busy = false;
          // (The Hub made backup codes: shown once before going on. A Hub without them goes straight on.)
          const codes = await call(k.ownerBackupCodes).catch(() => []);
          if (codes && codes.length) { S.backupCodes = codes; S.codesSaved = false; render(); }
          else { S.ownerState = undefined; next(); }
        } catch (e) { fail(e); }
      },
      h('label', { class: 'field' }, 'The 6-digit code it shows', h('input', { type: 'text', id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', value: S.code || '', oninput: (e) => (S.code = e.target.value) })),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' },
        // (Back to the account form: signing in again there gives a new key, so nothing is ever stuck.)
        h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.totp = null; S.code = ''; S.error = ''; render(); } }, 'Back'),
        h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Turn it on'))),
    ];
  const all = S.terms.sections.every((s) => S.agreed.has(s.id));
  const f = S.form || (S.form = { name: '', email: (o && o.email) || '', password: '', code: '' });
  return [
    h('h1', null, 'Your owner account'),
    h('p', { class: 'muted' }, 'This is your own Kea account, the same one you sign in to Kea with, made the owner of this Hub. If you already have one on this Hub, use the same email and password.'),
    h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: f.name, oninput: (e) => (f.name = e.target.value) })),
    h('label', { class: 'field' }, 'Email', h('input', { type: 'email', value: f.email, oninput: (e) => (f.email = e.target.value) })),
    h('label', { class: 'field' }, 'Password (10+ characters; a few random words works well)', h('input', { type: 'password', value: f.password, oninput: (e) => (f.password = e.target.value) })),
    // This account already has two-step sign-in on (the Hub asked for a code).
    S.needCode && h('div', null, codeInput(() => f.code, (v) => (f.code = v), { label: 'Two-step code from your authenticator app' })),
    h('h2', { style: 'margin-top:18px' }, `${S.terms.title} · version ${S.terms.version}`),
    h('p', { class: 'muted small' }, 'Like every Kea account, yours agrees to each section. You can change these terms later; everyone then agrees again, seeing only what changed.'),
    // (You wrote these terms: one box agrees to all of them. Everyone else ticks each section.)
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, onchange: (e) => {
      for (const s of S.terms.sections) { if (e.target.checked) S.agreed.add(s.id); else S.agreed.delete(s.id); }
      render();
    } }), h('b', null, 'I agree to all sections')),
    termsBox(S.terms.sections, S.agreed, 'agreeCreate'),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: back }, 'Back'),
      h('button', { class: 'btn primary', id: 'agreeCreate', disabled: S.busy || !all, onclick: async () => {
        const why = !f.name.trim() ? 'Enter your name.' : !f.email.trim() ? 'Enter your email.' : f.password.length < 10 ? 'The password needs 10 or more characters.' : '';
        if (why) { S.error = why; render(); return; }
        S.busy = true; render();
        try {
          const r = await call(k.ownerCreate, { name: f.name, email: f.email, password: f.password, code: S.needCode ? f.code : undefined, termsVersion: S.terms.version, termsSections: S.terms.sections.map((s) => s.id) });
          S.owner = r; S.totp = r.totp; S.busy = false; S.needCode = false; f.code = '';
          if (!r.totp) { S.totpDone = true; S.ownerState = undefined; next(); } else render();
        } catch (e) {
          if (e.data && e.data.totpRequired) { S.needCode = true; f.code = ''; }
          fail(e);
        }
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
      h('p', { class: 'muted small' }, `The Hub runs as a Scheduled Task (${S.bs.taskName}) under your Windows account, with normal rights, whether or not you’re signed in. It doesn’t store your Windows password, so it can’t reach network drives: keep the Hub’s data on a drive inside this PC.`),
      h('p', { class: 'muted small' }, `What the task runs is kept in ${S.bs.serviceDir}, which only Administrators and you can change. The Hub’s data folder can only be opened by you, Administrators and Windows itself.`),
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
    S.bs.needsUpdate && h('div', { class: 'err' }, 'Starting before sign-in needs to be set up again: it was set up by an earlier version of KeaS, or the permissions on its folder changed. Click Save to move it to a protected folder.'),
    S.bs.folderProblem && h('div', { class: 'err' }, S.bs.folderProblem),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!S.startWithWindows, disabled: S.busy, onchange: async (e) => {
      try { S.startWithWindows = await call(k.setStartWithWindows, { on: e.target.checked }); render(); } catch (err) { fail(err); }
    } }), h('span', null, 'Start KeaS when I sign in to Windows', h('span', { class: 'muted small' }, ' It waits in the tray and runs the Hub. Changes right away; no permission needed.'))),
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

/** The Updates panel: the version, what the updater is doing, and the buttons. */
function updatePanel() {
  const u = S.update || { status: 'idle' };
  const busy = u.status === 'checking' || u.status === 'downloading';
  const line = {
    idle: '',
    dev: 'Updates work in the installed KeaS.',
    checking: 'Checking for updates…',
    latest: 'KeaS is up to date.',
    downloading: `Downloading KeaS ${u.version || ''}… ${u.percent || 0}%`,
    ready: `KeaS ${u.version} is downloaded and ready to install.`,
    error: u.message || 'The update check didn’t work.',
  }[u.status] || '';
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, 'Updates'), h('span', { class: 'muted small' }, `  KeaS ${S.version || ''}`)),
    line && h('p', { class: u.status === 'error' ? 'err' : 'muted small' }, line),
    u.status === 'ready' && h('p', { class: 'muted small' }, S.hubExternal
      ? 'KeaS restarts to install it. The Hub started before sign-in keeps running and moves to the new version the next time Windows starts.'
      : 'KeaS restarts to install it, and the Hub is offline for about a minute.'),
    h('div', { class: 'row' },
      u.status === 'ready'
        ? h('button', { class: 'btn primary', onclick: async () => {
          // (Payroll open: restarting locks it and loses whatever isn't saved there.)
          const st = await call(k.state).catch(() => ({}));
          if (!(await askInPage(`Restart KeaS now to install ${u.version}?`, st.payrollOpen ? 'Payroll is open: restarting locks it, and anything not saved there is lost. Save your work first.' : '', 'Restart and update'))) return;
          try { await call(k.installUpdate); } catch (e) { S.update = { ...u, status: 'error', message: e.message }; render(); }
        } }, 'Restart and update')
        : h('button', { class: 'btn', disabled: busy || u.status === 'dev', onclick: async () => {
          // (A failed check shows in this panel only, not twice.)
          try { S.update = { status: 'checking' }; render(); S.update = await call(k.checkUpdates); render(); } catch (e) { S.update = { status: 'error', message: e.message }; render(); }
        } }, 'Check for updates')));
}

function status() {
  const c = S.config;
  return [
    h('h1', null, c.role === 'hub' ? 'Kea Hub' : 'KeaS server'),
    checklistPanel(),
    h('div', { class: 'panel' },
      h('p', null, h('span', { class: `dot ${S.running ? 'ok' : 'bad'}`, style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }), S.running ? 'Running' : 'Not running'),
      // Why it didn't start, and what to do about it.
      !S.running && h('div', null,
        S.lastStartError ? h('p', { class: 'err' }, `It didn’t start: ${S.lastStartError}`) : h('p', { class: 'muted small' }, 'Start it here. If it doesn’t start, the log says why.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: S.busy, onclick: async () => {
            S.busy = true; S.error = ''; render();
            try { await call(k.start); } catch {}
            S.busy = false; await load().catch(fail);
          } }, S.busy ? 'Starting…' : S.lastStartError ? 'Try again' : 'Start the Hub'),
          h('button', { class: 'btn', onclick: () => call(k.openLog).catch(fail) }, 'Open log'))),
      c.publicUrl ? h('p', null, 'Public address: ', h('span', { class: 'url' }, c.publicUrl), ' ',
        h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
          if (!(await askInPage('Turn off public access?', 'Nobody outside this computer can reach the Hub until you make it reachable again here.', 'Turn it off'))) return;
          try { S.busy = true; render(); await call(k.tsFunnelOff); await load(); } catch (e) { fail(e); } finally { S.busy = false; render(); }
        } }, 'Turn off public access'))
        : h('p', null, h('span', { class: 'muted' }, 'Only reachable on this computer. '),
          c.role === 'hub' && h('button', { class: 'btn', disabled: S.busy, onclick: () => { S.reach = 'tailscale'; S.tsChecked = false; S.ts = {}; S.log = []; S.publicUrl = null; go('reachSettings'); } }, 'Make it reachable from anywhere…')),
      h('p', null, 'Data: ', h('span', { class: 'url' }, c.dataDir), ' ', h('button', { class: 'btn', onclick: () => k.openFolder({ dir: c.dataDir }) }, 'Open folder')),
      c.role === 'hub' && h('p', { class: 'muted small' }, `Each account gets ${c.quotaGb || 5} GB of Kea storage. Owner: ${c.ownerEmail || 'not set'}.`)),
    c.role === 'hub' && h('div', { class: 'panel' },
      h('p', null, h('b', null, 'Startup and power')),
      h('p', { class: 'muted small' }, c.boot?.installed ? 'The Hub starts when Windows starts, before anyone signs in.' : S.startWithWindows ? 'The Hub starts when you sign in to Windows (KeaS starts then).' : 'The Hub runs while KeaS is open. KeaS doesn’t start with Windows.',
        c.boot?.powerApplied ? ' This PC stays awake on AC power.' : '', S.hubExternal ? ' The Hub running now was started before sign-in.' : ''),
      h('button', { class: 'btn', onclick: () => { S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; go('settings'); } }, 'Change…')),
    c.role === 'hub' && c.publicUrl && h('p', null, h('button', { class: 'btn', onclick: () => k.openExternal({ url: `${c.publicUrl}/terms` }) }, 'Open the terms page')),
    c.role === 'hub' && c.boot?.installed && (c.boot.layout !== 2 || c.boot.repair) && h('div', { class: 'err' }, 'Starting the Hub before sign-in needs to be set up again, so what it runs is kept in a protected folder. ', h('button', { class: 'btn', onclick: () => { S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; go('settings'); } }, 'Set it up again')),
    S.folderProblem && h('div', { class: 'err' }, S.folderProblem),
    S.folderWarning && h('div', { class: 'err' }, S.folderWarning),
    updatePanel(),
    h('h2', { style: 'margin-top:22px' }, 'Your Kea account'),
    accountPanel(),
    c.role === 'hub' && ownerVerifyPanel(),
    peoplePanel(),
    h('h2', { style: 'margin-top:22px' }, 'Payroll'),
    payrollPanel(),
    S.error && h('div', { class: 'err' }, S.error),
    h('p', { class: 'muted small' }, 'Closing this window keeps the server running in the tray. Quit from the tray icon to stop it.'),
  ];
}

// ---------- Payroll: opened with the signed-in Kea account; the passphrase asked once per run ----------
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
function loadPayroll() {
  if (S.payLoading) return;
  S.payLoading = true;
  call(k.payrollStatus).then((v) => { S.pay = v; S.payLoading = false; render(); }).catch((e) => { S.payLoading = false; S.pay = { error: e.message }; render(); });
}
async function openPay() {
  S.busy = true; S.payError = ''; render();
  try {
    const r = await call(k.openPayroll);
    S.busy = false;
    if (r.opened) { S.payForm = null; S.payLocked = null; S.pay = null; } else { S.payForm = r; S.payData = S.payData || {}; }
    render();
    // (Opened from the checklist at the top: bring the form it asks for into view.)
    if (!r.opened) document.getElementById('payroll')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    S.busy = false;
    if (e.data && e.data.need === 'signin') { go('signin'); return; }
    S.payError = e.message; render();
  }
}
/** After opening: secrets typed into the forms are dropped from the page. */
function payOpened() { S.payForm = null; S.payData = null; S.payLocked = null; S.pay = null; S.busy = false; render(); setTimeout(loadChecklist, 1500); }
function payrollPanel() {
  const p = S.pay;
  if (!p) { loadPayroll(); return h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Loading…')); }
  const intro = h('p', null, 'Pay runs, tax forms and HR records for your organization. Payroll runs only on this computer: SSNs and bank details are encrypted with a passphrase you choose and never go to the Hub.');
  if (!p.signedIn)
    return h('div', { class: 'panel' }, intro, h('p', null, h('button', { class: 'btn primary', onclick: () => go('signin') }, 'Sign in to use Payroll')));
  const f = S.payForm;
  const d = S.payData || (S.payData = {});
  const field = (label, key, type = 'text', extra = {}) => h('label', { class: 'field' }, label, h('input', { type, value: d[key] || '', oninput: (e) => (d[key] = e.target.value), ...extra }));
  const err = S.payError && h('div', { class: 'err' }, S.payError);
  const cancel = h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.payForm = null; S.payData = null; S.payError = ''; render(); } }, 'Cancel');
  const sendUnlock = async () => {
    S.busy = true; S.payError = ''; render();
    try {
      const r = await call(k.payrollUnlock, { passphrase: d.passphrase, password: d.password, code: f.need === 'code' ? d.code : undefined });
      if (r.need === 'code') { S.payForm = { ...f, need: 'code' }; d.code = ''; S.busy = false; render(); return; }
      payOpened();
    } catch (e) {
      S.busy = false;
      if (f.need === 'code') d.code = '';
      if (e.data && e.data.passphrase && f.need === 'code') { S.payForm = { ...f, need: 'unlock' }; d.passphrase = ''; }
      S.payError = e.message; render();
    }
  };
  let body;
  if (!f) {
    body = [
      S.payLocked && h('p', { class: 'muted small' }, S.payLocked === 'idle' ? 'Payroll locked itself after a quiet spell. Open it again with the passphrase.' : 'Payroll is locked. Open it again with the passphrase.'),
      p.folderProblem && h('p', { class: 'err' }, `The payroll folder’s permissions: ${p.folderProblem}`),
      h('p', null, h('button', { class: 'btn primary', disabled: S.busy, onclick: openPay }, p.open ? 'Show Payroll' : 'Open Payroll'),
        p.remembered && !p.open ? h('span', { class: 'muted small' }, '  The passphrase is remembered until KeaS closes or payroll locks.') : null),
    ];
  } else if (f.need === 'setup') {
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Denver'; } })();
    // (Starts from the organization on the Kea Hub, when there is one.)
    const o = S.cl && S.cl.org;
    if (o && d.orgName === undefined) { d.orgName = o.name; d.state = d.state || o.state || ''; if (o.tz) d.tz = o.tz; }
    if (!d.tz) d.tz = zone;
    const zones = TIME_ZONES.includes(d.tz) ? TIME_ZONES : [d.tz, ...TIME_ZONES];
    const a = S.acct || {};
    const tables = (p.taxStates || []);
    const confirmKey = !f.ownHub && f.fingerprint;
    body = form(async () => {
      const why = !(d.orgName || '').trim() ? 'Enter the organization’s name.' : !d.state ? 'Pick the state.' : (d.passphrase || '').length < 12 ? 'The passphrase needs 12 or more characters.' : d.passphrase !== d.passphrase2 ? 'The two passphrases don’t match.' : confirmKey && !d.keyOk ? 'Compare the Kea Hub’s key fingerprint first.' : '';
      if (why) { S.payError = why; render(); return; }
      S.busy = true; S.payError = ''; render();
      try {
        await call(k.payrollSetup, { passphrase: d.passphrase, hubKeyFingerprint: confirmKey ? f.fingerprint : undefined, org: { name: d.orgName, state: d.state, tz: d.tz, workCity: d.workCity || undefined, payPeriodAnchor: d.anchor || undefined, futaExempt: !!d.futa, sutaRate: d.suta ? Number(d.suta) : undefined } });
        payOpened();
      } catch (e) { S.busy = false; S.payError = e.message; render(); }
    },
    h('h3', null, 'Set up payroll on this computer'),
    h('p', { class: 'muted small' }, `Payroll admin: ${a.name || ''} ${a.email ? `(${a.email})` : ''}, your Kea account.`),
    field('Organization', 'orgName'),
    h('label', { class: 'field' }, 'State', h('select', { onchange: (e) => (d.state = e.target.value) },
      h('option', { value: '' }, 'Pick a state'),
      US_STATES.map((s) => h('option', { value: s, selected: d.state === s }, tables.includes(s) ? `${s} (state tax tables included)` : s)))),
    d.state && !tables.includes(d.state) && h('p', { class: 'muted small' }, `KeaS doesn’t have ${d.state} tax tables yet, so state taxes aren’t worked out for you.`),
    field('City or county where people work', 'workCity'),
    h('label', { class: 'field' }, 'Time zone', h('select', { onchange: (e) => (d.tz = e.target.value) }, zones.map((z) => h('option', { value: z, selected: d.tz === z }, z.replace('_', ' '))))),
    field('Vault passphrase (12+ characters)', 'passphrase', 'password', { autocomplete: 'new-password' }),
    field('Vault passphrase again', 'passphrase2', 'password', { autocomplete: 'new-password' }),
    h('p', { class: 'muted small' }, 'It encrypts SSNs, bank details and documents. It can’t be recovered if it’s lost, so keep it somewhere safe. KeaS asks for it once each time you start KeaS.'),
    confirmKey && h('div', { class: 'panel' },
      h('p', { class: 'small' }, 'Kea Hub key fingerprint: ', h('code', null, f.fingerprint)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!d.keyOk, onchange: (e) => { d.keyOk = e.target.checked; render(); } }), 'It matches the one shown on the Hub’s PC (KeaS there: Payroll, Advanced)')),
    h('details', null, h('summary', null, 'Advanced'),
      field('First day of a pay period', 'anchor', 'date'),
      h('p', { class: 'muted small' }, 'Biweekly periods count from this day. Empty: this week’s Sunday.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!d.futa, onchange: (e) => (d.futa = e.target.checked) }), '501(c)(3): exempt from FUTA'),
      field('State unemployment rate (for example 0.0305)', 'suta', 'number', { step: '0.0001', min: '0', max: '0.2' })),
    err,
    h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Setting up…' : 'Set up payroll')));
  } else if (f.need === 'code') {
    body = form(sendUnlock,
      h('h3', null, 'Two-step sign-in'),
      h('p', { class: 'muted small' }, S.useBackup ? 'The passphrase is right. Now one of your backup codes.' : 'The passphrase is right. Now the 6-digit code from your authenticator app.'),
      codeInput(() => d.code, (v) => (d.code = v), { label: 'Code' }),
      err,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Opening…' : 'Open Payroll')));
  } else {
    body = form(sendUnlock,
      h('h3', null, f.askEveryTime ? 'Sign in to Payroll' : 'Unlock Payroll'),
      h('p', { class: 'muted small' }, f.askEveryTime ? `${f.org ? `${f.org}. ` : ''}Your Kea password and the vault passphrase. A two-step code comes next if your account uses one.` : `${f.org ? `${f.org}. ` : ''}The vault passphrase. KeaS remembers it until you close KeaS or payroll locks.`),
      f.askEveryTime && field('Kea password', 'password', 'password', { autocomplete: 'current-password' }),
      field('Vault passphrase', 'passphrase', 'password'),
      err,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Opening…' : 'Open Payroll')));
  }
  return h('div', { class: 'panel', id: 'payroll' }, intro, body,
    !f && err,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p.askEveryTime, onchange: async (e) => {
      try { await call(k.payrollAskEveryTime, { on: e.target.checked }); S.pay = null; S.payForm = null; render(); } catch (er) { fail(er); }
    } }), h('span', null, 'Ask for my sign-in every time I open Payroll', h('span', { class: 'muted small' }, ' Your Kea password, the passphrase and the two-step code, at every open. Off: KeaS uses your Kea sign-in and asks for the passphrase once each time KeaS starts.'))),
    payrollAdvanced());
}

// Payroll settings only this app can change (the payroll page can't): the local password fallback, and accepting the
// Kea Hub's signing key after the Hub was moved or reinstalled.
function payrollAdvanced() {
  return h('details', { open: !!S.payAdv, ontoggle: (e) => { S.payAdv = e.target.open; if (S.payAdv && !S.ps) call(k.payrollSettings).then((v) => { S.ps = v; render(); }).catch(fail); } }, h('summary', null, 'Advanced'),
    !S.ps ? h('p', { class: 'muted small' }, 'Loading…') : [
      h('p', { class: 'muted small' }, `Payroll admins sign in with their Kea Hub account at ${S.ps.hubUrl || '(no Kea Hub set)'}, plus the vault passphrase.`),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: S.ps.localSignIn, onchange: async (e) => { try { S.ps = await call(k.payrollLocalSignIn, { on: e.target.checked }); render(); } catch (err) { fail(err); } } }),
        h('span', null, 'Allow a local password while the Kea Hub can’t be reached',
          h('span', { class: 'muted small' }, ' Each payroll admin can then set a long local password (16 or more characters) in Payroll. It only works while the Hub can’t be reached, still needs the vault passphrase, and skips the Hub’s two-step sign-in, so leave it off unless you need it. Off by default.'))),
      S.ps.exportsDir && h('p', { class: 'muted small' }, `Files Payroll saves (tax form data, bank files, reports) go to ${S.ps.exportsDir}, a folder only your Windows account can open. `,
        h('button', { class: 'btn', onclick: () => call(k.payrollOpenExports).catch(fail) }, 'Open Exports folder')),
      S.ps.folderProblem && h('p', { class: 'err' }, `The payroll folder’s permissions: ${S.ps.folderProblem}`),
      S.ps.ownHubFingerprint && h('p', { class: 'small' }, 'This Hub’s key fingerprint (payroll on another PC asks you to compare it): ', h('code', {}, S.ps.ownHubFingerprint)),
      h('p', { class: 'muted small' }, 'Payroll trusts the Kea Hub’s signing key from when it was set up. If the Hub’s key changes, sign-in is refused until you check the new key here and accept it. Only do this for your own Hub.'),
      h('p', null, h('button', { class: 'btn', onclick: async () => { try { S.hubKey = await call(k.payrollHubKey); S.error = ''; S.repinned = ''; render(); } catch (err) { fail(err); } } }, 'Check the Kea Hub’s key')),
      S.hubKey && hubKeyPanel(S.hubKey),
      S.repinned && h('p', { class: 'small ok' }, S.repinned),
    ]);
}
/** The Hub's current key next to the trusted one: the owner compares fingerprints, reads why it might change, then confirms. */
function hubKeyPanel(s) {
  const fp = (t) => h('code', { style: 'font-size:12px;word-break:break-all' }, t || '—');
  if (!s.changed && s.pinned) return h('p', { class: 'small ok' }, 'The Kea Hub’s key is the one payroll trusts. Nothing to do. Fingerprint: ', fp(s.current.fingerprint));
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, s.pinned ? 'The Kea Hub is offering a different key from the one payroll trusts.' : 'Payroll doesn’t trust a Kea Hub key yet.')),
    h('p', { class: 'small' }, 'New key: ', fp(s.current.fingerprint)),
    s.pinned && h('p', { class: 'small' }, `Trusted since ${new Date(s.pinned.at).toLocaleString()}: `, fp(s.pinned.fingerprint)),
    s.localHub && h('p', { class: s.localHub.matches ? 'small ok' : 'err' }, s.localHub.matches ? 'It matches this PC’s own Kea Hub key file.' : 'It does NOT match this PC’s own Kea Hub key file. Don’t accept it.'),
    h('p', { class: 'small' }, 'A Hub’s key changes when:'),
    h('ul', { class: 'small' }, ...s.reasons.map((r) => h('li', null, r))),
    h('p', { class: 'small' }, s.warning, ' Compare the new key with the fingerprint shown on the Hub’s PC before accepting it.'),
    h('p', null, h('button', { class: 'btn', onclick: async () => {
      if (!window.confirm(`Accept the Kea Hub key ${s.current.fingerprint}?\n\nOnly if you know why it changed and it matches your Hub.`)) return;
      try { const r = await call(k.payrollRepinHub, { fingerprint: s.current.fingerprint }); S.error = ''; S.hubKey = null; S.repinned = `Accepted the Kea Hub’s key ${r.fingerprint}.`; render(); } catch (err) { fail(err); }
    } }, 'Accept this key')));
}

// ---------- the Kea account: sign in or create one (everyone), then the home screen ----------
/** A form: Enter submits it (the page never navigates). */
function form(onsubmit, ...kids) {
  return h('form', { onsubmit: (e) => { e.preventDefault(); onsubmit(); } }, ...kids);
}
/**
 * The terms, one section at a time, each ticked. Ticking only changes that section and the button (no re-render),
 * so the box stays where it was scrolled to.
 */
function termsBox(sections, agreed, buttonId) {
  const sync = () => { const b = document.getElementById(buttonId); if (b) b.disabled = S.busy || !sections.every((s) => agreed.has(s.id)) || (b.dataset.extra === 'off'); };
  return h('div', { class: 'terms' }, sections.map((s) => {
    const box = h('div', { class: `term ${agreed.has(s.id) ? 'agreed' : ''}` }, h('h3', null, s.title), sectionBody(s.body));
    box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: agreed.has(s.id), onchange: (e) => {
      if (e.target.checked) agreed.add(s.id); else agreed.delete(s.id);
      box.classList.toggle('agreed', e.target.checked);
      sync();
    } }), 'I agree to this section'));
    return box;
  }));
}
/** Advanced: the Hub address (shown openly while the Hub can't be reached: a wrong address is the usual reason). */
function hubAddress() {
  const a = S.acctStatus || {};
  const v = S.hubUrlInput ?? (a.custom ? a.url : '');
  return h('details', { open: !!S.hubAdv || a.reachable === false, ontoggle: (e) => (S.hubAdv = e.target.open) }, h('summary', null, 'Advanced'),
    a.reachable === false && h('p', { class: 'err' }, `Can’t reach the Kea Hub at ${a.url}.`),
    form(async () => {
      S.busy = true; S.error = ''; render();
      try { S.acctStatus = await call(k.accountSetUrl, { url: S.hubUrlInput ?? '' }); S.hubUrlInput = null; S.busy = false; render(); } catch (e) { fail(e); }
    },
    h('label', { class: 'field' }, 'Hub address', h('div', { class: 'row' },
      h('input', { type: 'text', value: v, placeholder: a.defaultUrl || 'http://127.0.0.1:4860', oninput: (e) => (S.hubUrlInput = e.target.value) }),
      h('button', { class: 'btn', type: 'submit', disabled: S.busy }, 'Use this address'))),
    h('p', { class: 'muted small' }, `Empty: the standard address (${a.defaultUrl || 'http://127.0.0.1:4860'}). It must start with https://, except for a Hub on this computer.`)));
}
function signedInNow(st) {
  S.acctStatus = st; S.acct = st.account; S.busy = false; S.sf = null; S.cf = null; S.signStep = null; S.error = ''; S.signupAgreed = null; S.useBackup = false; S.op = null;
  // (load() picks the screen: home, or the Hub's status on the Hub's PC.)
  load().catch(fail);
}
function signin() {
  const f = S.sf || (S.sf = { email: '', password: '', code: '' });
  const send = async () => {
    S.busy = true; S.error = ''; render();
    try { signedInNow(await call(k.accountLogin, { email: f.email, password: f.password, code: S.signStep === 'code' ? f.code : undefined })); }
    catch (e) {
      if (e.data && e.data.totpRequired && S.signStep !== 'code') { S.signStep = 'code'; S.busy = false; S.error = ''; render(); return; }
      f.code = '';
      fail(e);
    }
  };
  if (S.signStep === 'code')
    return [
      h('h1', null, 'Two-step sign-in'),
      h('p', { class: 'muted' }, S.useBackup ? `Enter one of your backup codes for ${f.email}. Each one works once.` : `Enter the 6-digit code from your authenticator app for ${f.email}.`),
      form(send,
        codeInput(() => f.code, (v) => (f.code = v), { label: 'Code', autofocus: true }),
        S.error && h('div', { class: 'err' }, S.error),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.signStep = null; f.code = ''; S.error = ''; render(); } }, 'Back'),
          h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Signing in…' : 'Sign in'))),
    ];
  return [
    h('h1', null, 'Sign in to Kea'),
    h('p', { class: 'muted' }, 'Use your Kea account, the same one you use in the Kea app.'),
    form(send,
      h('label', { class: 'field' }, 'Email', h('input', { type: 'email', autocomplete: 'username', value: f.email, oninput: (e) => (f.email = e.target.value) })),
      h('label', { class: 'field' }, 'Password', h('input', { type: 'password', autocomplete: 'current-password', value: f.password, oninput: (e) => (f.password = e.target.value) })),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' },
        S.hub && S.config.setupDone && h('button', { class: 'btn', type: 'button', onclick: () => go('status') }, 'Back'),
        h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.error = ''; S.step = 'signup'; render(); } }, 'Create an account'),
        h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Signing in…' : 'Sign in'))),
    h('p', { class: 'muted small' }, 'Forgot your password? Reset it in the Kea app (Kea account, Forgot password).'),
    hubAddress(),
  ];
}
function signup() {
  const f = S.cf || (S.cf = { name: '', email: '', password: '', age13: false, part: 'details' });
  if (f.part === 'terms') {
    if (!S.acctTerms) { call(k.accountTerms).then((t) => { S.acctTerms = t.terms; render(); }).catch((e) => { f.part = 'details'; fail(e); }); return [h('p', { class: 'muted' }, 'Getting the terms…')]; }
    const t = S.acctTerms;
    const agreed = S.signupAgreed || (S.signupAgreed = new Set());
    return [
      h('h1', null, 'The Kea terms'),
      h('p', { class: 'muted' }, `${t.title} · version ${t.version}. Read each section and tick it.`),
      termsBox(t.sections, agreed, 'create'),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', disabled: S.busy, onclick: () => { f.part = 'details'; S.error = ''; render(); } }, 'Back'),
        h('button', { class: 'btn primary', id: 'create', disabled: S.busy || !t.sections.every((s) => agreed.has(s.id)), onclick: async () => {
          S.busy = true; S.error = ''; render();
          try { signedInNow(await call(k.accountRegister, { name: f.name, email: f.email, password: f.password, age13: f.age13, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) })); }
          catch (e) {
            if (e.data && e.data.termsVersion) { S.acctTerms = null; S.signupAgreed = null; }
            if ((e.data && e.data.field) || e.status === 409) f.part = 'details';
            if (e.data && e.data.exists) { S.step = 'signin'; S.sf = { email: f.email, password: '', code: '' }; }
            fail(e);
          }
        } }, S.busy ? 'Creating…' : 'Agree and create my account')),
    ];
  }
  const ok = f.name.trim() && f.email.trim() && f.password.length >= 10 && f.age13;
  return [
    h('h1', null, 'Create a Kea account'),
    h('p', { class: 'muted' }, 'One account for Kea and KeaS.'),
    form(() => {
      // (Checked now, not when the screen was drawn: the fields change without redrawing it.)
      const why = !f.name.trim() ? 'Enter your name.' : !f.email.trim() ? 'Enter your email.' : f.password.length < 10 ? 'The password needs 10 or more characters.' : !f.age13 ? 'Kea accounts are for people 13 and older.' : '';
      S.error = why;
      if (!why) f.part = 'terms';
      render();
    },
      h('label', { class: 'field' }, 'Name', h('input', { type: 'text', placeholder: 'What people see', value: f.name, oninput: (e) => { f.name = e.target.value; syncNext(); } })),
      h('label', { class: 'field' }, 'Email', h('input', { type: 'email', autocomplete: 'username', value: f.email, oninput: (e) => { f.email = e.target.value; syncNext(); } })),
      h('label', { class: 'field' }, 'Password (10+ characters; a few random words works well)', h('input', { type: 'password', autocomplete: 'new-password', value: f.password, oninput: (e) => { f.password = e.target.value; syncNext(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.age13, onchange: (e) => { f.age13 = e.target.checked; syncNext(); } }), 'I’m 13 or older'),
      S.error && h('div', { class: 'err' }, S.error),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { S.error = ''; S.step = 'signin'; render(); } }, 'I have an account'),
        h('button', { class: 'btn primary', type: 'submit', id: 'next', disabled: !ok }, 'Next: the terms'))),
    hubAddress(),
  ];
  function syncNext() { const b = document.getElementById('next'); if (b) b.disabled = !(f.name.trim() && f.email.trim() && f.password.length >= 10 && f.age13); }
}
/** New terms to agree to (the Hub changed them since this account last agreed). */
function termsAccept() {
  if (!S.acctTerms) { call(k.accountTerms).then((t) => { S.acctTerms = t.terms; render(); }).catch(fail); return [h('p', { class: 'muted' }, 'Getting the terms…')]; }
  const t = S.acctTerms;
  const agreed = S.acceptAgreed || (S.acceptAgreed = new Set());
  return [
    h('h1', null, 'The Kea terms changed'),
    h('p', { class: 'muted' }, `${t.title} · version ${t.version}. Read each section and tick it to keep using your Kea account.`),
    termsBox(t.sections, agreed, 'accept'),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => go(S.hub ? 'status' : 'home') }, 'Not now'),
      h('button', { class: 'btn primary', id: 'accept', disabled: S.busy || !t.sections.every((s) => agreed.has(s.id)), onclick: async () => {
        S.busy = true; render();
        try { S.acctStatus = await call(k.accountAcceptTerms, { termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }); S.acctTerms = null; S.acceptAgreed = null; S.busy = false; go(S.hub ? 'status' : 'home'); } catch (e) { fail(e); }
      } }, 'Agree')),
  ];
}
/** Who KeaS is signed in as (the home screen, and the Hub's status screen). */
function accountPanel() {
  const st = S.acctStatus;
  const a = (st && st.account) || S.acct;
  if (!a || (st && !st.signedIn))
    return h('div', { class: 'panel' },
      h('p', null, h('b', null, 'Your Kea account')),
      h('p', { class: 'muted small' }, 'Sign in to use Payroll with your Kea account.'),
      h('button', { class: 'btn primary', onclick: () => { S.error = ''; go('signin'); } }, 'Sign in'));
  const needsTerms = a.terms && a.terms.needsAgreement;
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, a.name || a.email), a.name ? h('span', { class: 'muted' }, `  ${a.email}`) : null),
    h('p', { class: 'muted small' }, `Kea Hub: ${(st && st.url) || a.hub || ''}`, st && st.reachable === false ? ' · can’t be reached right now' : '', a.totpEnabled ? ' · two-step sign-in on' : ''),
    needsTerms && h('p', { class: 'err' }, 'The Kea terms changed. ', h('button', { class: 'btn', onclick: () => { S.acctTerms = null; go('termsAccept'); } }, 'Read and agree')),
    a.totpEnabled && backupCodesPart(a),
    h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
      if (!(await askInPage('Sign out of your Kea account on this PC?', S.payrollOpen ? 'Payroll locks too.' : ''))) return;
      try { S.acctStatus = await call(k.accountLogout); S.acct = null; go(S.hub ? 'status' : 'signin'); } catch (e) { fail(e); }
    } }, 'Sign out'));
}
/** Two-step backup codes: how many are left, and making new ones (the password and a code from the app). */
function backupCodesPart(a) {
  const left = a.backupCodesLeft;
  const f = S.bcForm;
  if (!f)
    return h('p', { class: 'muted small' }, left == null ? 'Backup codes: ' : `Backup codes: ${left} left. `,
      h('button', { class: 'btn', onclick: () => { S.bcForm = { password: '', code: '' }; S.bcError = ''; render(); } }, left === 0 ? 'Make backup codes' : 'New backup codes'));
  return form(async () => {
    S.busy = true; S.bcError = ''; render();
    try {
      S.backupCodes = await call(k.accountBackupCodes, { password: f.password, code: f.code });
      S.codesSaved = false; S.bcForm = null; S.busy = false; go('codes');
    } catch (e) { S.busy = false; f.code = ''; S.bcError = e.message; render(); }
  },
  h('p', { class: 'small' }, 'New backup codes. The old ones stop working.'),
  h('label', { class: 'field' }, 'Kea password', h('input', { type: 'password', autocomplete: 'current-password', value: f.password, oninput: (e) => (f.password = e.target.value) })),
  h('label', { class: 'field' }, 'Code from your authenticator app', h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', value: f.code, oninput: (e) => (f.code = e.target.value) })),
  S.bcError && h('div', { class: 'err' }, S.bcError),
  h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.bcForm = null; S.bcError = ''; render(); } }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Make new codes')));
}
// ---------- People asking to join (an unverified email always asks), and verifying emails ----------
function loadPeople() {
  if (S.opLoading) return;
  S.opLoading = true;
  call(k.orgPeople).then((v) => { S.op = v; S.opLoading = false; if (['home', 'status'].includes(S.step) && !S.busy && !typingNow()) render(); })
    .catch((e) => { S.opLoading = false; S.op = { error: e.message }; });
}
async function personAction(fn, arg, done) {
  S.busy = true; S.opError = ''; S.opOk = ''; render();
  try { await call(fn, arg); S.opOk = done; } catch (e) { S.opError = e.message; }
  S.busy = false; S.op = null; loadPeople(); render();
}
function peoplePanel() {
  const st = S.acctStatus;
  if (!st || !st.signedIn) return null;
  if (!S.op) { loadPeople(); return null; }
  if (S.op.error || !S.op.some((g) => g.pending.length || g.unverified.length)) return S.opOk ? h('p', { class: 'ok small' }, S.opOk) : null;
  const who = (m) => h('div', { style: 'flex:1' }, h('b', null, m.name), !m.emailVerified && h('span', { class: 'tag' }, 'Email not verified'), h('div', { class: 'muted small' }, m.email || ''));
  const verifyBtn = (g, m) => !m.emailVerified && h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
    if (!(await askInPage(`Verify ${m.email || m.name}?`, 'Only if you know this email address really is theirs. It counts everywhere on the Kea Hub, payroll too.', 'Verify'))) return;
    personAction(k.orgVerifyEmail, { id: g.org.id, accountId: m.id }, `${m.name}’s email is verified.`);
  } }, 'Verify email');
  return h('div', null,
    h('h2', { style: 'margin-top:22px' }, 'People'),
    S.op.map((g) => (g.pending.length || g.unverified.length) && h('div', { class: 'panel' },
      h('p', null, h('b', null, g.org.name)),
      g.pending.length > 0 && h('p', { class: 'small' }, h('b', null, 'Asking to join. '), h('span', { class: 'muted' }, 'Someone whose email isn’t verified can still join once you approve it.')),
      h('ul', { class: 'steps' }, g.pending.map((m) => h('li', null, who(m),
        verifyBtn(g, m),
        h('button', { class: 'btn', disabled: S.busy, onclick: () => personAction(k.orgApprove, { id: g.org.id, accountId: m.id, approve: false }, `Declined ${m.name}.`) }, 'Decline'),
        h('button', { class: 'btn primary', disabled: S.busy, onclick: () => personAction(k.orgApprove, { id: g.org.id, accountId: m.id, approve: true }, `${m.name} is in.`) }, 'Approve')))),
      g.unverified.length > 0 && h('p', { class: 'small', style: g.pending.length ? 'margin-top:18px' : '' }, h('b', null, 'Email not verified. '), h('span', { class: 'muted' }, 'Payroll needs a verified email.')),
      h('ul', { class: 'steps' }, g.unverified.map((m) => h('li', null, who(m), verifyBtn(g, m)))))),
    S.opOk && h('p', { class: 'ok small' }, S.opOk),
    S.opError && h('div', { class: 'err' }, S.opError));
}
/** The Hub's owner, on the Hub's PC: verify any account's email by hand. */
function ownerVerifyPanel() {
  const f = S.vf || (S.vf = { email: '' });
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, 'Verify someone’s email')),
    h('p', { class: 'muted small' }, 'For someone who can’t use Verify with Google (an Outlook or school email). Only when you know the address is theirs.'),
    form(async () => {
      S.busy = true; S.vfMsg = ''; S.vfErr = ''; render();
      try { const r = await call(k.ownerVerifyEmail, { email: f.email }); S.vfMsg = `${r.email} is verified.`; f.email = ''; } catch (e) { S.vfErr = e.message; }
      S.busy = false; render();
    },
    h('div', { class: 'row' },
      h('input', { type: 'email', placeholder: 'Their email', value: f.email, oninput: (e) => (f.email = e.target.value), style: 'max-width:300px' }),
      h('button', { class: 'btn', type: 'submit', disabled: S.busy }, 'Verify'))),
    S.vfMsg && h('p', { class: 'ok small' }, S.vfMsg),
    S.vfErr && h('div', { class: 'err' }, S.vfErr));
}
// ---------- Get set up: every step until this person is good to go (desktop/checklist.cjs decides the steps) ----------
function loadChecklist() {
  if (S.clLoading) return;
  S.clLoading = true;
  call(k.checklist).then((v) => { S.cl = v; S.clLoading = false; if (['home', 'status'].includes(S.step) && !S.busy && !typingNow()) render(); }).catch(() => { S.clLoading = false; });
}
const typingNow = () => !!document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
// (Each step checks itself again when KeaS comes back to the front, and every half minute while the list is open.)
window.addEventListener('focus', () => { if (['home', 'status'].includes(S.step)) { loadChecklist(); S.op = null; loadPeople(); } });
setInterval(() => { if (['home', 'status'].includes(S.step) && !document.hidden && S.cl && !S.cl.allSet) loadChecklist(); }, 30_000);
const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
/** Where each step's button takes the person. */
async function stepAction(s) {
  S.clOpen = s.id;
  switch (s.action) {
    case 'status': return go('status');
    case 'startHub': S.busy = true; render(); try { await call(k.start); } catch {} S.busy = false; await load(); return loadChecklist();
    case 'reach': S.reach = 'tailscale'; S.tsChecked = false; S.ts = {}; S.log = []; S.publicUrl = null; return go('reachSettings');
    case 'settings': S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; return go('settings');
    case 'update': { const u = S.update || {}; if (await askInPage(`Restart KeaS now to install ${u.version || 'the update'}?`, '', 'Restart and update')) call(k.installUpdate).catch(fail); return; }
    case 'signin': return go('signin');
    case 'termsAccept': S.acctTerms = null; return go('termsAccept');
    case 'payroll': return openPay();
    case 'org': case 'orgEdit': S.orgForm = S.orgForm || { name: '', state: '', code: '' }; return render();
    default: return loadChecklist();
  }
}
/** Create or join the organization, or set where people work (inside its step). */
function orgForm(s) {
  const f = S.orgForm;
  const err = S.orgError && h('div', { class: 'err' }, S.orgError);
  const done = async (p) => { S.busy = true; S.orgError = ''; render(); try { await p; S.orgForm = null; S.busy = false; loadChecklist(); render(); } catch (e) { S.busy = false; S.orgError = e.message; render(); } };
  const stateSel = h('select', { onchange: (e) => (f.state = e.target.value) }, h('option', { value: '' }, 'State where people work'), STATES.map((x) => h('option', { value: x, selected: f.state === x }, x)));
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Denver'; } })();
  if (s.action === 'orgEdit')
    return form(() => done(call(k.orgUpdate, { id: S.cl.org.id, state: f.state })), h('div', { class: 'row' }, stateSel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Save')), err);
  return h('div', null,
    form(() => done(call(k.orgCreate, { name: f.name, state: f.state, tz })),
      h('label', { class: 'field' }, 'Organization name', h('input', { type: 'text', value: f.name, oninput: (e) => (f.name = e.target.value) })),
      h('div', { class: 'row' }, stateSel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Create it'))),
    h('p', { class: 'muted small' }, 'The Kea Hub’s owner approves new organizations. Or join one with the code someone gave you:'),
    form(() => done(call(k.orgJoin, { code: f.code })),
      h('div', { class: 'row' }, h('input', { type: 'text', placeholder: 'Join code', value: f.code, oninput: (e) => (f.code = e.target.value), style: 'max-width:260px' }), h('button', { class: 'btn', type: 'submit', disabled: S.busy }, 'Join'))),
    err);
}
function checklistPanel() {
  const cl = S.cl;
  if (!cl) { loadChecklist(); return h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Checking what’s left to set up…')); }
  // All set: one small line, with a way back to the steps.
  if (cl.allSet && !S.clShow)
    return h('p', { class: 'ok small' }, h('span', { class: 'dot ok', style: 'display:inline-block;vertical-align:-5px;margin-right:8px' }),
      cl.waiting ? 'All set. Tax tables are waiting for a KeaS update. ' : 'All set. ',
      h('button', { class: 'btn', onclick: () => { S.clShow = true; render(); } }, 'Show setup steps'));
  return h('div', { class: 'panel' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0' }, cl.allSet ? 'Setup steps' : `Get set up: ${cl.left} step${cl.left === 1 ? '' : 's'} left`),
      h('div', { class: 'row' },
        h('button', { class: 'btn', disabled: S.clLoading, onclick: () => loadChecklist() }, S.clLoading ? 'Checking…' : 'Check again'),
        cl.allSet && h('button', { class: 'btn', onclick: () => { S.clShow = false; render(); } }, 'Hide'))),
    h('ul', { class: 'steps', style: 'margin-top:12px' }, cl.steps.map((s) => h('li', null,
      h('span', { class: `dot ${s.done ? 'ok' : s.waiting ? 'run-static' : ''}` }),
      h('div', { style: 'flex:1' },
        h('b', null, s.title), s.optional && h('span', { class: 'tag' }, 'Optional'), s.waiting && h('span', { class: 'tag' }, 'Waiting for an update'),
        h('div', { class: 'muted small' }, s.text),
        !s.done && S.orgForm && (s.action === 'org' || s.action === 'orgEdit') && orgForm(s)),
      !s.done && s.action && s.action !== 'recheck' && !(S.orgForm && (s.action === 'org' || s.action === 'orgEdit')) && h('button', { class: 'btn primary', disabled: S.busy, onclick: () => stepAction(s) }, ACTION_WORDS[s.action] || 'Do this'),
      !s.done && s.action === 'recheck' && h('button', { class: 'btn', disabled: S.clLoading, onclick: () => loadChecklist() }, 'Check again')))));
}
const ACTION_WORDS = { status: 'Open', startHub: 'Start the Hub', reach: 'Set it up', settings: 'Set it up', update: 'Restart and update', signin: 'Sign in', termsAccept: 'Read and agree', payroll: 'Open Payroll', org: 'Create or join', orgEdit: 'Add the state' };

/** The home screen for everyone who isn't running the Hub. */
function home() {
  return [
    h('h1', null, 'KeaS'),
    checklistPanel(),
    accountPanel(),
    peoplePanel(),
    h('h2', { style: 'margin-top:22px' }, 'Payroll'),
    payrollPanel(),
    h('h2', { style: 'margin-top:22px' }, 'Settings'),
    h('div', { class: 'panel' },
      h('label', { class: 'check', style: 'margin-top:0' }, h('input', { type: 'checkbox', checked: !!S.startWithWindows, onchange: async (e) => {
        try { S.startWithWindows = await call(k.setStartWithWindows, { on: e.target.checked }); render(); } catch (err) { fail(err); }
      } }), h('span', null, 'Start KeaS when I sign in to Windows', h('span', { class: 'muted small' }, ' It waits in the tray. Off unless you turn it on.')))),
    updatePanel(),
    S.error && h('div', { class: 'err' }, S.error),
  ];
}
/** A yes/no question inside the page (instead of the browser's own dialog). */
function askInPage(title, text, yes = 'OK') {
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog', { class: 'ask' },
      h('p', null, h('b', null, title)), text && h('p', { class: 'muted small' }, text),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => done(true) }, yes)));
    dlg.addEventListener('cancel', () => done(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

const VIEWS = { codes: codesView, welcome, storage, reach, reachSettings: reach, owner, boot, done, status, settings, signin, signup, termsAccept, home };
const TITLES = { reachSettings: 'KeaS ? Reachable from anywhere', status: 'KeaS · Kea Hub', settings: 'KeaS · Startup and power', signin: 'KeaS · Sign in', signup: 'KeaS · Create an account', termsAccept: 'KeaS · Kea terms', home: 'KeaS', codes: 'KeaS · Backup codes' };
function render() {
  renderProgress();
  document.title = TITLES[S.step] || 'KeaS · Set up the Kea Hub';
  app.replaceChildren(...VIEWS[S.step]().filter((x) => x != null && x !== false && x !== ''));
}

async function load() {
  const st = await call(k.state);
  S.config = st.config; S.defaults = st.defaults; S.folderProblem = st.folderProblem || null; S.folderWarning = st.folderWarning || S.folderWarning || null;
  S.running = st.running.hub || st.running.org;
  S.lastStartError = st.lastStartError || null;
  S.hubExternal = !!st.running.hubExternal;
  S.version = st.version;
  S.update = await call(k.updateState).catch(() => null);
  document.getElementById('theme').value = st.config.theme || 'system';
  applyTheme(st.config.theme || 'system');
  S.hub = !!st.hub;
  S.startWithWindows = !!st.startWithWindows;
  if (st.account) S.acct = st.account;
  if (!S.hub) {
    // Not the Hub's PC: the Kea account's home, or signing in. (No Hub setup here.)
    S.step = st.view;
    S.drives = [];
    render();
    refreshAccount();
    if (S.step === 'home') loadChecklist();
    return;
  }
  if (st.config.setupDone) { S.role = st.config.role; S.step = 'status'; refreshAccount(); loadChecklist(); }
  else if (!S.resumed && st.resume) {
    // An unfinished setup: back where it stopped, with what was already chosen.
    S.resumed = true;
    const r = st.resume;
    Object.assign(S, { step: r.step, dataDir: r.dataDir, storageDir: r.storageDir, quotaGb: r.quotaGb, reach: r.reach });
    if (r.needsHub && !S.running) {
      try { await call(k.start); S.running = true; } catch (e) { S.step = 'storage'; S.error = `The Hub didn’t start: ${e.message}`; }
    }
  }
  S.drives = await call(k.drives).catch(() => []);
  render();
}
/** What the Hub says about this sign-in now (it may have ended elsewhere, or the terms changed). */
function refreshAccount() {
  call(k.accountStatus).then((a) => {
    S.acctStatus = a;
    S.acct = a.account || (a.signedIn ? S.acct : null);
    if (!a.signedIn && S.step === 'home') S.step = 'signin';
    if (['home', 'status', 'signin'].includes(S.step) && !S.busy) render();
  }).catch(() => {});
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
document.getElementById('theme').addEventListener('change', (e) => { applyTheme(e.target.value); k.setTheme({ theme: e.target.value }); });
k.onUpdate((u) => { S.update = u; if (S.step === 'status') render(); });
k.onProgress((line) => { S.log.push(line); if (S.step === 'reach' || S.step === 'reachSettings') render(); });
// The tray (and Payroll) can send the window to a screen: Startup and power, the Payroll panel, or sign-in.
k.onNavigate((nav) => {
  const view = typeof nav === 'string' ? nav : nav && nav.view;
  if (view === 'settings') {
    if (!S.hub || !S.config.setupDone || S.busy) return;
    S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null;
    go('settings');
  } else if (view === 'payroll') {
    S.pay = null; S.payError = ''; S.busy = false;
    if (nav.locked) { S.payLocked = nav.locked; S.payForm = null; S.payData = null; }
    if (nav.open && nav.open.need) { S.payForm = nav.open; S.payData = {}; }
    S.step = S.hub && S.config.setupDone ? 'status' : S.acct ? 'home' : 'signin';
    render();
  } else if (view === 'payrollClosed') {
    S.pay = null;
    if (['home', 'status'].includes(S.step) && !S.busy && !typingNow()) render();
    loadChecklist();
  } else if (view === 'signin' && !S.busy) { S.error = ''; go('signin'); }
});
load().catch(fail);
// The Hub's status page stays current by itself (while the window is shown and nothing is being typed or run).
setInterval(async () => {
  if (S.step !== 'status' || document.hidden || S.busy) return;
  try {
    const st = await call(k.state);
    const running = st.running.hub || st.running.org;
    if (running !== S.running || (st.lastStartError || null) !== S.lastStartError || st.config.publicUrl !== S.config.publicUrl) {
      S.running = running; S.lastStartError = st.lastStartError || null; S.config = st.config; S.hubExternal = !!st.running.hubExternal;
      if (!document.activeElement || !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) render();
    }
  } catch {}
}, 15_000);
