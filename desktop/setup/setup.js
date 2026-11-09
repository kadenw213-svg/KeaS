// The KeaS window: first-run setup, then the home screen (the server, Get set up, the organization's pay codes and
// roles, the Kea account, Payroll), or a Kea Hub's status while its accounts haven't moved. Plain DOM, no innerHTML: every bit of text is set as text.
'use strict';
const k = window.keas;
const app = document.getElementById('app');
const S = { step: 'welcome', dataDir: '', reach: 'tailscale', drives: [], defaults: {}, config: {}, ts: {}, log: [], busy: false, error: '' };

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

/** A two-step code box (or a backup code instead), for Payroll's "ask every time". */
function codeInput(get, set, { label = 'Code from your authenticator app', autofocus = false } = {}) {
  const backup = !!S.useBackup;
  return [
    h('label', { class: 'field' }, backup ? 'Backup code' : label,
      h('input', { type: 'text', inputmode: backup ? 'text' : 'numeric', autocomplete: backup ? 'off' : 'one-time-code', maxlength: backup ? '11' : '6', placeholder: backup ? 'XXXXX-XXXXX' : '', value: get() || '', autofocus, oninput: (e) => set(e.target.value) })),
    h('p', { class: 'small' }, h('button', { class: 'btn', type: 'button', onclick: () => { S.useBackup = !backup; set(''); render(); } }, backup ? 'Use the code from my app' : 'Use a backup code')),
  ];
}
// ---------- setup: the data folder ----------
const STEPS = ['welcome', 'keac', 'account', 'claim', 'org', 'place', 'reach', 'done'];
const LABELS = { welcome: 'Data folder', keac: 'Kea account server', account: 'Your Kea account', claim: 'This server', org: 'Organization', place: 'Where people work', reach: 'Reachable from anywhere', done: 'Done' };
function go(step) {
  S.step = step; S.error = ''; render(); window.scrollTo(0, 0);
  if (!S.config.setupDone && STEPS.includes(step)) k.setupStep({ step }).catch(() => {});
}
function next() { go(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(S.step) + 1)]); }
function back() { go(STEPS[Math.max(0, STEPS.indexOf(S.step) - 1)]); }
function renderProgress() {
  const el = document.getElementById('progress');
  el.replaceChildren();
  if (S.config.setupDone || !STEPS.includes(S.step)) return;
  const at = STEPS.indexOf(S.step);
  STEPS.forEach((s, i) => el.append(h('li', { class: i === at ? 'on' : i < at ? 'done' : '' }, LABELS[s])));
}
const tzHere = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Denver'; } };

function welcome() {
  const pick = (d) => { const rest = /^[a-z]:\\(.+)$/i.exec(S.dataDir.trim())?.[1]; S.dataDir = `${d.root}${rest || 'KeaS'}`; render(); };
  const onDrive = (d) => S.dataDir.toUpperCase().startsWith(d.root.toUpperCase());
  if (!S.dataDir) S.dataDir = S.defaults.serverData || '';
  return [
    h('h1', null, 'Set up KeaS for your organization'),
    h('p', { class: 'muted' }, 'KeaS runs your organization’s server on this computer: schedules, the time clock, pay codes and Payroll. Your people sign in with their Kea accounts, from Kea on their computers and phones.'),
    h('h2', null, 'Where should the data go?'),
    h('div', { class: 'drives' }, S.drives.map((d) =>
      h('button', { class: `choice drive ${onDrive(d) ? 'on' : ''}`, onclick: () => pick(d) },
        h('b', null, `${d.letter}: ${d.label || 'drive'}`), h('span', { class: 'muted small' }, `${size(d.free)} free of ${size(d.total)}`),
        h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((1 - d.free / d.total) * 100)}%` }))))),
    h('label', { class: 'field' }, 'Folder', h('div', { class: 'row' },
      h('input', { type: 'text', value: S.dataDir, oninput: (e) => (S.dataDir = e.target.value) }),
      h('button', { class: 'btn', onclick: async () => { const p = await call(k.pickFolder, { start: S.dataDir }).catch(fail); if (p) { S.dataDir = p; render(); } } }, 'Choose…'))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', disabled: S.busy || !S.dataDir.trim(), onclick: async () => {
        S.busy = true; S.error = ''; render();
        try {
          const r = await call(k.checkFolder, { dir: S.dataDir });
          S.folderWarning = r.warning || null;
          await call(k.saveSetup, { dataDir: S.dataDir });
          await call(k.start);
          S.busy = false;
          await load();
          if (S.legacy) return;
          go('keac');
        } catch (e) { fail(new Error(`Can’t use that folder: ${e.message}`)); }
      } }, S.busy ? 'Starting…' : 'Next')),
    h('p', { class: 'muted small' }, 'Only drives inside this PC are shown: cloud drives (Google Drive, OneDrive…), network and removable drives can’t hold the server’s data.'),
  ];
}

// ---------- setup: the Kea account server (KeaC), its key checked ----------
function keac() {
  const sv = S.server || {};
  const trusted = sv.keac && sv.keac.trusted > 0;
  const o = S.keacOffer;
  // (The Kea account server everyone uses, filled in; its key is still checked by fingerprint before it's trusted.)
  const url = S.keacUrl ?? (sv.keac && sv.keac.url) ?? S.config.keacUrl ?? 'https://kadensdesktop.tailc64e1d.ts.net';
  return [
    h('h1', null, 'Your Kea account server'),
    h('p', { class: 'muted' }, 'People sign in to this server with their Kea accounts. KeaS checks every sign-in with the Kea account server’s key, so it needs to know which key is the real one: compare its fingerprint with the one in the Kea account server’s Keys screen.'),
    trusted && !o && h('p', { class: 'ok' }, `Trusted: ${sv.keac.url}. `, h('span', { class: 'muted small' }, (sv.keac.keys || []).map((x) => `${x.kid} (${x.status})`).join(', '))),
    form(async () => {
      S.busy = true; S.error = ''; render();
      try { S.keacOffer = await call(k.keacOffer, { url: S.keacUrl ?? url }); S.keacPick = S.keacOffer.suggested; S.busy = false; render(); } catch (e) { fail(e); }
    },
    h('label', { class: 'field' }, 'Address', h('div', { class: 'row' },
      h('input', { type: 'text', value: url, placeholder: 'https://name.tailnet.ts.net', oninput: (e) => (S.keacUrl = e.target.value) }),
      h('button', { class: 'btn', type: 'submit', disabled: S.busy }, S.busy ? 'Checking…' : 'Check its key')))),
    o && h('div', { class: 'panel' },
      h('p', null, h('b', null, 'Its keys now')),
      h('ul', { class: 'steps' }, o.keys.map((x) => h('li', null,
        h('input', { type: 'radio', name: 'kid', checked: S.keacPick === x.kid, onchange: () => { S.keacPick = x.kid; render(); } }),
        h('div', null, h('b', null, `${x.kid} (${x.status})`), x.oldHubKey && h('span', { class: 'tag' }, 'This PC’s own Kea Hub key'),
          h('div', null, h('code', { style: 'font-size:12px;word-break:break-all' }, x.fingerprint)))))),
      h('p', { class: 'muted small' }, 'Trust it only if this fingerprint is the one the Kea account server shows for its current key.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.busy || !S.keacPick, onclick: async () => {
        const x = o.keys.find((y) => y.kid === S.keacPick);
        if (!(await askInPage('Trust this key?', x.fingerprint, 'Trust it'))) return;
        S.busy = true; render();
        try { await call(k.keacPin, { url: o.url, kid: x.kid, fingerprint: x.fingerprint }); S.keacOffer = null; S.busy = false; await load(); go('account'); } catch (e) { fail(e); }
      } }, 'Trust this key'))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: back }, 'Back'),
      h('button', { class: 'btn primary', disabled: !trusted, onclick: next }, 'Next')),
  ];
}

// ---------- setup: signing in with the Kea account (Google or Microsoft, in the browser) ----------
const PROVIDER_LABEL = { google: 'Google', microsoft: 'Microsoft' };
/** The providers this KeaS has a client id for: Google, and Microsoft when it's set up. */
const providerList = () => ['google', 'microsoft'].filter((p) => S.providers && S.providers[p]);
const NOT_SET_UP = 'Google and Microsoft sign-in aren’t set up in this KeaS yet. Add googleClientId (or microsoftClientId) to keas-config.json, then start KeaS again.';
function accountForm(after) {
  const f = S.sf || (S.sf = { code: '' });
  const done = async (p) => { S.busy = true; S.error = ''; render(); try { S.acctStatus = await p; S.acct = S.acctStatus.account; S.sf = null; S.needCode = false; S.busy = false; await after(); } catch (e) { S.busy = false; if (e.data && e.data.totpRequired) { S.needCode = true; S.error = f.code ? e.message : ''; } else { S.needCode = false; S.error = e.message; } render(); } };
  if (S.needCode)
    return h('div', null,
      form(() => done(call(k.accountContinue, { code: f.code })),
        h('p', { class: 'muted small' }, 'This is the owner’s account: it also asks for its two-step code.'),
        h('label', { class: 'field' }, 'Two-step code or backup code', h('input', { type: 'text', autocomplete: 'one-time-code', value: f.code, oninput: (e) => (f.code = e.target.value) })),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.needCode = false; S.sf = null; render(); } }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Signing in…' : 'Sign in'))));
  const list = providerList();
  if (!list.length) return h('p', { class: 'muted small' }, NOT_SET_UP);
  return h('div', null,
    h('div', { class: 'actions' }, list.map((p) => h('button', { class: 'btn primary', disabled: S.busy, onclick: () => done(call(k.accountOauth, { provider: p })) }, S.busy ? 'Waiting for the browser…' : `Continue with ${PROVIDER_LABEL[p]}`))),
    h('p', { class: 'muted small' }, 'Your browser opens to sign in. There’s no Kea password. No Kea account yet? Make one in the Kea app.'));
}
function account() {
  const a = S.acctStatus || {};
  return [
    h('h1', null, 'Sign in with your Kea account'),
    a.signedIn && S.acct ? h('p', { class: 'ok' }, `Signed in as ${S.acct.email}.`) : accountForm(async () => { await load(); go('claim'); }),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: back }, 'Back'), h('button', { class: 'btn primary', disabled: !(a.signedIn && S.acct), onclick: next }, 'Next')),
  ];
}

// ---------- setup: this server, claimed with its setup code ----------
function claim() {
  const sv = S.server || {};
  const signedIn = sv.signedIn;
  return [
    h('h1', null, 'Set up this server'),
    !sv.claimed ? [
      h('p', { class: 'muted' }, 'The first Kea account to set this server up runs it. That can only happen here, on this computer, with its one-time setup code:'),
      h('div', { class: 'panel' }, h('p', { style: 'font:600 24px/1.2 ui-monospace,Consolas,monospace;letter-spacing:3px' }, S.setupCode || '—')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.busy || !S.setupCode, onclick: async () => {
        S.busy = true; S.error = ''; render();
        try { await call(k.serverClaim, { secret: S.setupCode }); S.busy = false; await load(); go('org'); } catch (e) { fail(e); }
      } }, S.busy ? 'Setting it up…' : `Set it up as ${(S.acct && S.acct.email) || 'me'}`)),
    ] : signedIn ? h('p', { class: 'ok' }, sv.me && sv.me.operator ? 'You run this server.' : `Signed in as ${(sv.me && sv.me.email) || ''}.`) : [
      h('p', { class: 'muted' }, 'This server is set up already. Sign in to it with your Kea account.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: S.busy, onclick: async () => {
        S.busy = true; S.error = ''; render();
        try { await call(k.serverSignIn); S.busy = false; await load(); go('org'); } catch (e) { fail(e); }
      } }, 'Sign in to this server')),
    ],
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: back }, 'Back'), h('button', { class: 'btn primary', disabled: !signedIn, onclick: next }, 'Next')),
  ];
}

// ---------- setup: the organization, and where people work ----------
function org() {
  if (!S.orgList) { call(k.checklist).then((cl) => { S.cl = cl; S.orgList = true; render(); }).catch(fail); return [h('p', { class: 'muted' }, 'Checking…')]; }
  const have = S.cl && S.cl.org;
  const f = S.orgForm || (S.orgForm = { name: '', state: '', code: '' });
  return [
    h('h1', null, 'Your organization'),
    have ? h('p', { class: 'ok' }, `${have.name}.`) : form(async () => {
      S.busy = true; S.error = ''; render();
      try { await call(k.orgCreate, { name: f.name, state: f.state || null, tz: tzHere() }); S.busy = false; S.orgList = false; S.cl = null; go('place'); } catch (e) { fail(e); }
    },
    h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: f.name, oninput: (e) => (f.name = e.target.value) })),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy || !f.name.trim() }, 'Create it'))),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: back }, 'Back'), h('button', { class: 'btn primary', disabled: !have, onclick: next }, 'Next')),
  ];
}
function place() {
  if (!S.cl || !S.cl.org) { call(k.checklist).then((cl) => { S.cl = cl; render(); }).catch(fail); return [h('p', { class: 'muted' }, 'Checking…')]; }
  const o = S.cl.org;
  const f = S.placeForm || (S.placeForm = { state: o.state || '', tz: o.tz || tzHere(), periodDays: 14, periodAnchor: '' });
  const zones = TIME_ZONES.includes(f.tz) ? TIME_ZONES : [f.tz, ...TIME_ZONES];
  return [
    h('h1', null, 'Where people work'),
    h('p', { class: 'muted' }, 'The state decides which labor rules (overtime, breaks, paid sick leave) and tax tables apply. KeaS shows a state’s rules as suggestions until they’re checked against the official sources.'),
    form(async () => {
      S.busy = true; S.error = ''; render();
      try {
        const clock = { periodDays: Number(f.periodDays) === 7 ? 7 : 14, ...(f.periodAnchor ? { periodAnchor: f.periodAnchor } : {}) };
        await call(k.orgUpdate, { id: o.id, state: f.state || null, tz: f.tz, settings: { clock } });
        S.busy = false; S.cl = null; go('reach');
      } catch (e) { fail(e); }
    },
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'State', h('select', { onchange: (e) => (f.state = e.target.value) }, h('option', { value: '' }, 'Pick one'), US_STATES.map((x) => h('option', { value: x, selected: f.state === x }, x)))),
      h('label', { class: 'field' }, 'Time zone', h('select', { onchange: (e) => (f.tz = e.target.value) }, zones.map((z) => h('option', { value: z, selected: f.tz === z }, z))))),
    h('details', null, h('summary', null, 'Advanced'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Pay period', h('select', { onchange: (e) => (f.periodDays = Number(e.target.value)) }, h('option', { value: '14', selected: f.periodDays === 14 }, 'Every two weeks'), h('option', { value: '7', selected: f.periodDays === 7 }, 'Every week'))),
        h('label', { class: 'field' }, 'First day of a pay period', h('input', { type: 'date', value: f.periodAnchor, oninput: (e) => (f.periodAnchor = e.target.value) })))),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: back }, 'Back'), h('button', { class: 'btn primary', type: 'submit', disabled: S.busy || !f.state }, 'Save and go on'))),
    S.error && h('div', { class: 'err' }, S.error),
  ];
}

function done() {
  const url = S.publicUrl || S.config.publicUrl || null;
  return [
    h('h1', null, 'All set'),
    h('div', { class: 'panel' },
      h('p', null, h('b', null, 'Your organization’s server is running.')),
      url ? h('p', null, 'Public address: ', h('span', { class: 'url' }, url)) : h('p', { class: 'muted' }, 'Only reachable on this computer.'),
      h('p', null, 'Data: ', h('span', { class: 'url' }, S.config.dataDir), ' ', h('button', { class: 'btn', onclick: () => k.openFolder({ dir: S.config.dataDir }) }, 'Open folder')),
      h('p', { class: 'muted small' }, 'Your people join in Kea with a join link you make on the home screen here (or with a code from Kea, Work, People).')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.boot !== false, onchange: (e) => (S.boot = e.target.checked) }), 'Start KeaS when Windows starts (it waits in the tray and keeps the server running)'),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
      try { await call(k.finish, { startWithWindows: S.boot !== false, theme: document.getElementById('theme').value }); await load(); } catch (e) { fail(e); }
    } }, 'Finish')),
  ];
}

// ---------- a PC that is still the Kea Hub ----------
function legacy() {
  const la = S.legacyAcct;
  if (!la) call(k.legacyStatus).then((v) => { S.legacyAcct = v; render(); }).catch(() => {});
  return [
    h('h1', null, 'Kea Hub'),
    h('div', { class: 'panel' },
      h('p', null, h('b', null, S.legacyMessage)),
      h('p', { class: 'muted small' }, 'Until then this PC keeps running the Kea Hub as before, so Kea keeps working. When the accounts have moved to the Kea account server (the move copies them from this folder), say so here: KeaS then makes this organization’s server from a copy of the Hub’s data, and leaves the Hub’s own files as they were.'),
      form(async () => {
        if (!(await askInPage('Have the Kea accounts moved to your Kea account server?', 'Only once the move has run. After this, Kea apps that still use this address are sent to the Kea account server.', 'They have moved'))) return;
        S.busy = true; S.error = ''; render();
        try { const r = await call(k.legacyMoved, { keacUrl: S.moveUrl || '' }); S.moved = r.upgraded; S.busy = false; await load(); go('keac'); } catch (e) { fail(e); }
      },
      h('label', { class: 'field' }, 'Your Kea account server’s address', h('div', { class: 'row' },
        h('input', { type: 'text', value: S.moveUrl || '', placeholder: 'https://name.tailnet.ts.net', oninput: (e) => (S.moveUrl = e.target.value) }),
        h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'My Kea accounts have moved'))))),
    h('div', { class: 'panel' },
      h('p', null, h('span', { class: `dot ${S.running ? 'ok' : 'bad'}`, style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }), S.running ? 'The Kea Hub is running' : 'Not running'),
      !S.running && h('button', { class: 'btn primary', onclick: async () => { try { await call(k.start); } catch {} await load(); } }, 'Start it'),
      h('p', null, 'Data: ', h('span', { class: 'url' }, S.config.dataDir))),
    h('h2', null, 'Payroll'),
    la && !la.signedIn ? h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Payroll signs in with your Kea Hub account here until the accounts move.'), legacySignIn()) : payrollPanel(),
    updatePanel(),
    S.error && h('div', { class: 'err' }, S.error),
  ];
}
function legacySignIn() {
  const f = S.lf || (S.lf = { email: '', password: '', code: '' });
  return form(async () => {
    S.busy = true; S.error = ''; render();
    try { S.legacyAcct = await call(k.legacyLogin, { email: f.email, password: f.password, code: S.lneedCode ? f.code : undefined }); S.lf = null; S.busy = false; render(); }
    catch (e) { S.busy = false; if (e.data && e.data.totpRequired) S.lneedCode = true; else S.error = e.message; render(); }
  },
  h('label', { class: 'field' }, 'Email', h('input', { type: 'email', value: f.email, oninput: (e) => (f.email = e.target.value) })),
  h('label', { class: 'field' }, 'Password', h('input', { type: 'password', value: f.password, oninput: (e) => (f.password = e.target.value) })),
  S.lneedCode && h('label', { class: 'field' }, 'Two-step code', h('input', { type: 'text', value: f.code, oninput: (e) => (f.code = e.target.value) })),
  h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Sign in'));
}

// ---------- the organization from this PC: pay codes, roles, people waiting ----------
const orgPath = (p = '') => `/v1/orgs/${encodeURIComponent(S.cl.org.id)}${p}`;
const money = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
function loadOrgAdmin() {
  if (S.oaLoading || !S.cl || !S.cl.org) return;
  S.oaLoading = true;
  Promise.all([call(k.orgApi, { path: orgPath('/pay-codes') }), call(k.orgApi, { path: orgPath('/roles') }), call(k.orgApi, { path: orgPath('/members') })])
    .then(([pc, roles, members]) => { S.oa = { pc, roles, members }; S.oaLoading = false; render(); })
    .catch((e) => { S.oaLoading = false; S.oa = { error: e.message }; render(); });
}
async function orgDo(method, p, body) {
  S.busy = true; S.oaError = ''; render();
  try { await call(k.orgApi, { method, path: orgPath(p), body }); S.busy = false; S.oa = null; S.cl = null; loadChecklist(); render(); } catch (e) { S.busy = false; S.oaError = e.message; render(); }
}
function payCodesPanel() {
  const pc = S.oa.pc;
  const f = S.pcForm || (S.pcForm = { name: '', rate: '' });
  const members = (S.oa.members.members || []).filter((m) => m.status !== 'pending');
  return h('div', { class: 'panel', id: 'paycodes' },
    h('h2', { style: 'margin-top:0' }, 'Pay codes'),
    h('p', { class: 'muted small' }, 'A pay code is a job and its rate. Each hour is paid at the code it was worked at, at the rate in effect that day. People see only their own codes.'),
    h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Code'), h('th', null, 'Rate'), h('th', null, 'Coming'), h('th', null, 'People'), h('th', null, '')),
      (pc.codes || []).map((c) => h('tr', null,
        h('td', null, c.name, !c.active && h('span', { class: 'tag' }, 'Off')),
        h('td', null, money(c.rateCents)),
        h('td', { class: 'small' }, (c.upcoming || []).map((u) => `${money(u.rateCents)} from ${u.from}`).join(', ') || '—'),
        h('td', null, String(c.holders || 0)),
        h('td', null, pc.canManage && h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
            const v = window.prompt(`New rate for ${c.name} (dollars an hour)`, (c.rateCents / 100).toFixed(2)); if (!v) return;
            const from = window.prompt('From which date? (YYYY-MM-DD; empty: today)', '') || undefined;
            orgDo('POST', `/pay-codes/${c.id}`, { rate: v, ...(from ? { effectiveFrom: from } : {}) });
          } }, 'Change rate'),
          h('button', { class: 'btn', disabled: S.busy, onclick: () => orgDo('POST', `/pay-codes/${c.id}`, { active: !c.active }) }, c.active ? 'Turn off' : 'Turn on')))))),
    pc.canManage && form(() => orgDo('POST', '/pay-codes', { name: f.name, rate: f.rate }).then(() => { S.pcForm = null; }),
      h('div', { class: 'row' },
        h('input', { type: 'text', placeholder: 'Name (Lifeguard)', value: f.name, oninput: (e) => (f.name = e.target.value) }),
        h('input', { type: 'text', placeholder: 'Rate an hour (15.00)', value: f.rate, oninput: (e) => (f.rate = e.target.value), style: 'max-width:180px' }),
        h('button', { class: 'btn primary', type: 'submit', disabled: S.busy || !f.name.trim() || !f.rate }, 'Add code'))),
    pc.canAssign && (pc.codes || []).some((c) => c.active) && h('div', null,
      h('p', { class: 'small', style: 'margin-top:12px' }, h('b', null, 'Give a code to someone'), ' (their first is their default)'),
      form(() => orgDo('POST', `/members/${encodeURIComponent(S.grant?.aid || '')}/pay-codes`, { codeId: S.grant?.cid, default: !!S.grant?.def }),
        h('div', { class: 'row' },
          h('select', { onchange: (e) => (S.grant = { ...(S.grant || {}), aid: e.target.value }) }, h('option', { value: '' }, 'Person'), members.map((m) => h('option', { value: m.id, selected: S.grant?.aid === m.id }, m.name || m.email || m.id))),
          h('select', { onchange: (e) => (S.grant = { ...(S.grant || {}), cid: e.target.value }) }, h('option', { value: '' }, 'Code'), pc.codes.filter((c) => c.active).map((c) => h('option', { value: c.id, selected: S.grant?.cid === c.id }, c.name))),
          h('label', { class: 'check', style: 'margin:0' }, h('input', { type: 'checkbox', checked: !!S.grant?.def, onchange: (e) => (S.grant = { ...(S.grant || {}), def: e.target.checked }) }), 'Default'),
          h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Give it')))),
    !pc.hasKey && h('p', { class: 'err' }, 'This server has no org data key, so it can’t keep pay rates.'));
}
function rolesPanel() {
  const r = S.oa.roles;
  const f = S.roleForm || (S.roleForm = { name: '', abilities: new Set() });
  const members = (S.oa.members.members || []).filter((m) => m.status !== 'pending');
  const catalog = r.abilities || [];
  return h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, 'Roles'),
    h('p', { class: 'muted small' }, 'A role is a list of what someone may do, for the whole organization or chosen departments. Owner, Admin, Manager and Member are there from the start.'),
    h('ul', { class: 'steps' }, (r.roles || []).map((x) => h('li', null, h('div', { style: 'flex:1' }, h('b', null, x.name), x.template && h('span', { class: 'tag' }, 'Template'),
      h('div', { class: 'muted small' }, `${x.abilities.length} abilities${x.holders != null ? ` · ${x.holders} people` : ''}`)),
      !x.template && h('button', { class: 'btn', disabled: S.busy, onclick: async () => { if (await askInPage(`Delete the role ${x.name}?`, 'People who had it keep their other roles.', 'Delete')) orgDo('POST', `/roles/${x.id}/delete`, {}); } }, 'Delete')))),
    catalog.length > 0 && h('details', null, h('summary', null, 'Make a role'),
      form(() => orgDo('POST', '/roles', { name: f.name, abilities: [...f.abilities] }).then(() => { S.roleForm = null; }),
        h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: f.name, oninput: (e) => (f.name = e.target.value) })),
        h('div', { class: 'cards' }, catalog.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.abilities.has(a.id), onchange: (e) => { if (e.target.checked) f.abilities.add(a.id); else f.abilities.delete(a.id); } }), a.label || a.id))),
        h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Make it'))),
    h('details', null, h('summary', null, 'Give a role'),
      form(() => orgDo('POST', `/members/${encodeURIComponent(S.ra?.aid || '')}/roles`, { roleId: S.ra?.rid, scope: 'org' }),
        h('div', { class: 'row' },
          h('select', { onchange: (e) => (S.ra = { ...(S.ra || {}), aid: e.target.value }) }, h('option', { value: '' }, 'Person'), members.map((m) => h('option', { value: m.id }, m.name || m.email || m.id))),
          h('select', { onchange: (e) => (S.ra = { ...(S.ra || {}), rid: e.target.value }) }, h('option', { value: '' }, 'Role'), (r.roles || []).map((x) => h('option', { value: x.id }, x.name))),
          h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, 'Give it')))));
}
// A join link for Kea (kea://join?s=<this server's address>&c=<code>): people already in the organization (from the
// Kea Hub, say) get it back in Kea as they were; anyone new asks, and is let in under Asking to join.
const joinLinkOf = (url, code) => `kea://join?s=${encodeURIComponent(url)}&c=${encodeURIComponent(code)}`;
function joinPanel() {
  const url = S.config.publicUrl || null;
  const j = S.joinLink;
  return h('div', { class: 'panel', id: 'joinlink' },
    h('h2', { style: 'margin-top:0' }, 'Join link for Kea'),
    h('p', { class: 'muted small' }, 'Send it to your people, and open it yourself on each of your devices. Someone already in the organization (from the Kea Hub too) gets it back in Kea as they were. Anyone new asks to join, and you let them in here or in Kea.'),
    !url && h('p', { class: 'muted small' }, 'This server is reachable only on this computer, so the link works only here. Make it reachable from anywhere first to send it to others.'),
    j ? h('div', null, h('p', null, h('span', { class: 'url' }, j)), h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { navigator.clipboard.writeText(j); S.copied = true; render(); } }, S.copied ? 'Copied' : 'Copy the link'),
      h('button', { class: 'btn', onclick: () => { S.joinLink = null; S.copied = false; render(); } }, 'Done')))
      : h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
        S.busy = true; S.oaError = ''; render();
        try {
          const r = await call(k.orgApi, { method: 'POST', path: orgPath('/codes'), body: { role: 'member', needsApproval: true, label: 'Join link' } });
          S.joinLink = joinLinkOf(url || `http://127.0.0.1:${S.port || 4860}`, r.code.code);
          S.copied = false;
        } catch (e) { S.oaError = e.message; }
        S.busy = false; render();
      } }, 'Make a join link'));
}
function orgAdmin() {
  if (!S.cl || !S.cl.org || !['owner', 'admin'].includes(S.cl.org.role)) return null;
  if (!S.oa) { loadOrgAdmin(); return h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Loading the organization…')); }
  if (S.oa.error) return h('div', { class: 'err' }, S.oa.error);
  return [h('h2', { style: 'margin-top:22px' }, S.cl.org.name), S.oaError && h('div', { class: 'err' }, S.oaError), joinPanel(), payCodesPanel(), rolesPanel(), peoplePanel()];
}
function loadPeople() {
  if (S.peopleLoading) return;
  S.peopleLoading = true;
  call(k.orgPeople).then((v) => { S.people = v; S.peopleLoading = false; render(); }).catch(() => { S.peopleLoading = false; });
}
function peoplePanel() {
  if (!S.people) { loadPeople(); return null; }
  const waiting = S.people.flatMap((o) => o.pending.map((m) => ({ org: o.org, m })));
  if (!waiting.length) return null;
  return h('div', { class: 'panel' }, h('p', null, h('b', null, 'Asking to join')),
    h('ul', { class: 'steps' }, waiting.map(({ org: o, m }) => h('li', null, h('div', { style: 'flex:1' }, h('b', null, m.name || m.email), h('div', { class: 'muted small' }, `${m.email || ''} · ${o.name}`)),
      h('button', { class: 'btn primary', disabled: S.busy, onclick: async () => { try { await call(k.orgApprove, { id: o.id, accountId: m.id, approve: true }); S.people = null; render(); } catch (e) { fail(e); } } }, 'Let in'),
      h('button', { class: 'btn', disabled: S.busy, onclick: async () => { try { await call(k.orgApprove, { id: o.id, accountId: m.id, approve: false }); S.people = null; render(); } catch (e) { fail(e); } } }, 'Decline')))));
}

// ---------- the home screen, after setup ----------
function accountPanel() {
  const a = S.acctStatus || {};
  if (!a.signedIn) return h('div', { class: 'panel' }, h('p', null, h('b', null, 'Sign in with your Kea account')), accountForm(async () => { await load(); }));
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, (S.acct && S.acct.email) || ''), a.reachable === false ? h('span', { class: 'muted small' }, '  (the Kea account server can’t be reached right now; KeaS keeps working)') : null),
    h('button', { class: 'btn', onclick: async () => { try { S.acctStatus = await call(k.accountLogout); S.acct = null; await load(); } catch (e) { fail(e); } } }, 'Sign out'));
}
function home() {
  const c = S.config;
  return [
    h('h1', null, (S.cl && S.cl.org && S.cl.org.name) || 'KeaS'),
    checklistPanel(),
    h('div', { class: 'panel' },
      h('p', null, h('span', { class: `dot ${S.running ? 'ok' : 'bad'}`, style: 'display:inline-block;vertical-align:-4px;margin-right:8px' }), S.running ? 'The server is running' : 'Not running'),
      !S.running && h('div', null,
        S.lastStartError ? h('p', { class: 'err' }, `It didn’t start: ${S.lastStartError}`) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: S.busy, onclick: async () => { S.busy = true; render(); try { await call(k.start); } catch {} S.busy = false; await load().catch(fail); } }, 'Start it'),
          h('button', { class: 'btn', onclick: () => call(k.openLog).catch(fail) }, 'Open log'))),
      c.publicUrl ? h('p', null, 'Public address: ', h('span', { class: 'url' }, c.publicUrl), ' ',
        h('button', { class: 'btn', disabled: S.busy, onclick: async () => {
          if (!(await askInPage('Turn off public access?', 'Nobody outside this computer can reach the server until you make it reachable again here.', 'Turn it off'))) return;
          try { S.busy = true; render(); await call(k.tsFunnelOff); await load(); } catch (e) { fail(e); } finally { S.busy = false; render(); }
        } }, 'Turn off public access'))
        : h('p', null, h('span', { class: 'muted' }, 'Only reachable on this computer. '), h('button', { class: 'btn', onclick: () => { S.reach = 'tailscale'; S.tsChecked = false; S.ts = {}; S.log = []; S.publicUrl = null; go('reachSettings'); } }, 'Make it reachable from anywhere…')),
      h('p', null, 'Data: ', h('span', { class: 'url' }, c.dataDir), ' ', h('button', { class: 'btn', onclick: () => k.openFolder({ dir: c.dataDir }) }, 'Open folder')),
      S.server && S.server.keac && h('p', { class: 'muted small' }, `Kea account server: ${S.server.keac.url || 'not set'}${S.server.keac.keysError ? ` (last check: ${S.server.keac.keysError})` : ''}. Server id ${S.server.serverId}.`),
      h('button', { class: 'btn', onclick: () => { S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; go('settings'); } }, 'Startup and power…')),
    S.folderProblem && h('div', { class: 'err' }, S.folderProblem),
    S.folderWarning && h('div', { class: 'err' }, S.folderWarning),
    orgAdmin(),
    h('h2', { style: 'margin-top:22px' }, 'Your Kea account'),
    accountPanel(),
    h('h2', { id: 'payroll', style: 'margin-top:22px' }, 'Payroll'),
    payrollPanel(),
    updatePanel(),
    S.error && h('div', { class: 'err' }, S.error),
    h('p', { class: 'muted small' }, 'Closing this window keeps the server running in the tray. Quit from the tray icon to stop it.'),
  ];
}

function loadChecklist() {
  if (S.clLoading) return;
  S.clLoading = true;
  call(k.checklist).then((v) => { S.cl = v; S.clLoading = false; if (['home', 'legacy'].includes(S.step) && !S.busy && !typingNow()) render(); }).catch(() => { S.clLoading = false; });
}
const typingNow = () => !!document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
window.addEventListener('focus', () => { if (S.step === 'home') { loadChecklist(); S.people = null; } });
setInterval(() => { if (S.step === 'home' && !document.hidden && S.cl && !S.cl.allSet) loadChecklist(); }, 30_000);
async function stepAction(s) {
  switch (s.action) {
    case 'status': case 'welcome': return go(s.action === 'welcome' ? 'welcome' : 'home');
    case 'startServer': S.busy = true; render(); try { await call(k.start); } catch {} S.busy = false; await load(); return loadChecklist();
    case 'reach': S.reach = 'tailscale'; S.tsChecked = false; S.ts = {}; S.log = []; S.publicUrl = null; return go('reachSettings');
    case 'settings': S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; return go('settings');
    case 'update': { const u = S.update || {}; if (await askInPage(`Restart KeaS now to install ${u.version || 'the update'}?`, '', 'Restart and update')) call(k.installUpdate).catch(fail); return; }
    case 'keac': return go('keac');
    case 'signin': return go('account');
    case 'claim': case 'serverSignIn': return go('claim');
    case 'org': S.orgList = false; return go('org');
    case 'orgEdit': S.placeForm = null; return go('place');
    case 'payCodes': return document.getElementById('paycodes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    case 'move': return go('legacy');
    case 'payroll': return openPay();
    default: return loadChecklist();
  }
}
const ACTION_WORDS = { status: 'Open', welcome: 'Pick it', startServer: 'Start it', reach: 'Set it up', settings: 'Set it up', update: 'Restart and update', keac: 'Check its key', signin: 'Sign in', claim: 'Set it up', serverSignIn: 'Sign in', payroll: 'Open Payroll', org: 'Create it', orgEdit: 'Add it', payCodes: 'Show pay codes', move: 'Open' };
function checklistPanel() {
  const cl = S.cl;
  if (!cl) { loadChecklist(); return h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Checking what’s left to set up…')); }
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
      h('div', { style: 'flex:1' }, h('b', null, s.title), s.optional && h('span', { class: 'tag' }, 'Optional'), s.waiting && h('span', { class: 'tag' }, 'Waiting for an update'), h('div', { class: 'muted small' }, s.text)),
      !s.done && s.action && s.action !== 'recheck' && h('button', { class: 'btn primary', disabled: S.busy, onclick: () => stepAction(s) }, ACTION_WORDS[s.action] || 'Do this'),
      !s.done && s.action === 'recheck' && h('button', { class: 'btn', disabled: S.clLoading, onclick: () => loadChecklist() }, 'Check again')))));
}

const VIEWS = { welcome, keac, account, claim, org, place, reach, reachSettings: reach, done, home, settings, legacy };
const TITLES = { home: 'KeaS', legacy: 'KeaS · Kea Hub', settings: 'KeaS · Startup and power', reachSettings: 'KeaS · Reachable from anywhere' };
function render() {
  renderProgress();
  document.title = TITLES[S.step] || 'KeaS · Set up';
  app.replaceChildren(...[VIEWS[S.step] ? VIEWS[S.step]() : home()].flat(2).filter((x) => x != null && x !== false && x !== ''));
}
async function load() {
  const st = await call(k.state);
  S.config = st.config; S.defaults = st.defaults || {}; S.folderProblem = st.folderProblem || null; S.folderWarning = st.folderWarning || S.folderWarning || null;
  S.running = !!st.running; S.lastStartError = st.lastStartError || null; S.hubExternal = !!st.external;
  S.version = st.version; S.legacy = !!st.legacy; S.legacyMessage = st.legacyMessage; S.server = st.server; S.setupCode = st.setupCode; S.google = !!st.google; S.providers = st.providers || { google: !!st.google, microsoft: false };
  S.startWithWindows = !!st.startWithWindows;
  if (st.account) S.acct = st.account;
  S.update = await call(k.updateState).catch(() => null);
  document.getElementById('theme').value = st.config.theme || 'system';
  applyTheme(st.config.theme || 'system');
  S.acctStatus = S.legacy ? null : await call(k.accountStatus).catch(() => S.acctStatus || null);
  if (S.acctStatus && S.acctStatus.account) S.acct = S.acctStatus.account;
  if (!S.resumed || ['home', 'legacy'].includes(st.view) || S.legacy) {
    S.resumed = true;
    if (!STEPS.includes(S.step) || S.legacy || st.view === 'home' || st.view === 'legacy') S.step = st.view;
    if (st.resume && !st.config.setupDone && !S.legacy && !S.dataDirSet) { S.dataDir = st.resume.dataDir; S.reach = st.resume.reach; S.dataDirSet = true; }
    if (st.resume && st.resume.needsServer && !S.running && !S.legacy) { try { await call(k.start); S.running = true; } catch (e) { S.step = 'welcome'; S.error = `The server didn’t start: ${e.message}`; } }
  }
  if (S.step === 'welcome') S.drives = await call(k.drives).catch(() => []);
  render();
  if (S.step === 'home') loadChecklist();
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
document.getElementById('theme').addEventListener('change', (e) => { applyTheme(e.target.value); k.setTheme({ theme: e.target.value }); });
k.onUpdate((u) => { S.update = u; if (S.step === 'home' || S.step === 'legacy') render(); });
k.onProgress((line) => { S.log.push(line); if (S.step === 'reach' || S.step === 'reachSettings') render(); });
k.onNavigate((nav) => {
  const view = typeof nav === 'string' ? nav : nav && nav.view;
  if (view === 'settings') { if (!S.config.setupDone || S.busy) return; S.bs = null; S.bo = null; S.bootScript = null; S.bootResult = null; go('settings'); }
  else if (view === 'payroll') {
    S.pay = null; S.payError = ''; S.busy = false;
    if (nav.locked) { S.payLocked = nav.locked; S.payForm = null; S.payData = null; }
    if (nav.open && nav.open.need) { S.payForm = nav.open; S.payData = {}; }
    S.step = S.legacy ? 'legacy' : 'home';
    render();
  } else if (view === 'payrollClosed') { S.pay = null; if (S.step === 'home' && !S.busy && !typingNow()) render(); loadChecklist(); }
  else if (view === 'account' && !S.busy) go('account');
});
load().catch(fail);
setInterval(async () => {
  if (S.step !== 'home' || document.hidden || S.busy) return;
  try {
    const st = await call(k.state);
    if (!!st.running !== S.running || (st.lastStartError || null) !== S.lastStartError || st.config.publicUrl !== S.config.publicUrl) {
      S.running = !!st.running; S.lastStartError = st.lastStartError || null; S.config = st.config;
      if (!typingNow()) render();
    }
  } catch {}
}, 15_000);

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
    // (From the server's status page later: only the reachability changes; the server restarts to match.)
    if (S.step === 'reachSettings') await call(k.reachSet, { reach: 'tailscale' });
    else await call(k.saveSetup, { reach: 'tailscale' });
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
      h('h1', null, 'Make the server reachable from anywhere'),
      h('p', { class: 'muted' }, 'So your people can clock in and see their schedules from their phones, anywhere. KeaS installs and sets up Tailscale Funnel: your address stays hidden and no router settings change. The server restarts for a moment.'),
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
    h('p', { class: 'muted' }, 'So your people can clock in and see their schedules from their phones.'),
    h('div', { class: 'cards' },
      opt('tailscale', 'Anywhere, free (Tailscale Funnel)', 'KeaS installs and sets it up. Your home address stays hidden and no router settings change.', 'Recommended'),
      opt('local', 'Only this computer for now', 'Nobody else can reach it. You can make it reachable later from the home screen.')),
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
          if (S.reach === 'local') { await call(k.saveSetup, { reach: 'local' }); await call(k.start); }
          S.busy = false; next();
        } catch (e) { fail(e); }
      } }, 'Next')),
  ];
}

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
    box('bootStart', 'Start the KeaS server when Windows starts, before anyone signs in', 'Recommended: people clock in through it.'),
    box('power', 'Keep this PC awake on AC power', 'So the server doesn’t go to sleep at night.'),
    h('details', { open: !!S.bootAdv, ontoggle: (e) => (S.bootAdv = e.target.open) }, h('summary', null, 'Advanced'),
      h('p', { class: 'muted small' }, `The server runs as a Scheduled Task (${S.bs.taskName}) under your Windows account, with normal rights, whether or not you’re signed in. It doesn’t store your Windows password, so it can’t reach network drives: keep the server’s data on a drive inside this PC.`),
      h('p', { class: 'muted small' }, `What the task runs is kept in ${S.bs.serviceDir}, which only Administrators and you can change. The server’s data folder can only be opened by you, Administrators and Windows itself.`),
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
      S.bs.external ? ' The server running now was started before sign-in.' : ''),
    S.bootResult && h('ul', { class: 'small' }, S.bootResult.steps.map((s) => h('li', { class: s.ok ? 'ok' : 'err' }, `${s.step}: ${s.ok ? 'done' : s.error}`))),
  ].filter(Boolean);
}
function settings() {
  if (!S.bs) { loadBoot().catch(fail); return [h('p', { class: 'muted' }, 'Checking this PC’s settings…')]; }
  const on = S.bs.saved?.installed || S.bs.saved?.powerApplied || S.bs.task?.installed;
  return [
    h('h1', null, 'Startup and power'),
    h('p', { class: 'muted' }, 'Start the KeaS server before anyone signs in, and keep this PC awake for it. Saving asks Windows for permission once.'),
    S.bs.needsUpdate && h('div', { class: 'err' }, 'Starting before sign-in needs to be set up again: it was set up by an earlier version of KeaS, or the permissions on its folder changed. Click Save to move it to a protected folder.'),
    S.bs.folderProblem && h('div', { class: 'err' }, S.bs.folderProblem),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!S.startWithWindows, disabled: S.busy, onchange: async (e) => {
      try { S.startWithWindows = await call(k.setStartWithWindows, { on: e.target.checked }); render(); } catch (err) { fail(err); }
    } }), h('span', null, 'Start KeaS when I sign in to Windows', h('span', { class: 'muted small' }, ' It waits in the tray and runs the server. Changes right away; no permission needed.'))),
    ...bootForm(),
    S.error && h('div', { class: 'err' }, S.error),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: S.busy, onclick: () => { S.step = 'home'; load().catch(fail); } }, 'Back'),
      on && h('button', { class: 'btn', disabled: S.busy, onclick: () => removeBoot() }, 'Turn it all off'),
      h('button', { class: 'btn primary', disabled: S.busy || (!S.bo.bootStart && !S.bo.power), onclick: () => applyBoot() }, S.busy ? 'Saving…' : 'Save')),
  ];
}

/** The nightly install setting as saved (desktop/updates.cjs has the same defaults): { on, from, to }. */
function nightlySaved() {
  const n = (S.config && S.config.nightlyUpdate) || {};
  const hr = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  const from = hr(n.from, 3);
  let to = hr(n.to, 5);
  if (to === from) to = (from + 2) % 24;
  return { on: n.on !== false, from, to };
}
/** "3 and 5 a.m." */
function nightlyHours({ from, to }) {
  const half = (x) => (x < 12 ? 'a.m.' : 'p.m.');
  const num = (x) => String(x % 12 === 0 ? 12 : x % 12);
  return half(from) === half(to) && from < to ? `${num(from)} and ${num(to)} ${half(to)}` : `${num(from)} ${half(from)} and ${num(to)} ${half(to)}`;
}
async function setNightly(change) {
  try {
    const next = { ...nightlySaved(), ...change };
    S.update = await call(k.setNightlyUpdate, next);
    S.config = { ...S.config, nightlyUpdate: next };
    render();
  } catch (e) { fail(e); }
}

/** The Updates panel: the version, what the updater is doing, and the buttons. */
function updatePanel() {
  const u = S.update || { status: 'idle' };
  const busy = u.status === 'checking' || u.status === 'downloading';
  const n = nightlySaved();
  const hourOptions = (sel) => Array.from({ length: 24 }, (_, x) => h('option', { value: String(x), selected: x === sel }, nightlyHours({ from: x, to: x }).split(' and ')[0]));
  const line = {
    idle: '',
    dev: 'Updates work in the installed KeaS.',
    checking: 'Checking for updates…',
    latest: 'KeaS is up to date.',
    downloading: `Downloading KeaS ${u.version || ''}… ${u.percent || 0}%`,
    ready: n.on ? `KeaS ${u.version} is downloaded. Installs tonight between ${nightlyHours(n)}.` : `KeaS ${u.version} is downloaded and ready to install.`,
    error: u.message || 'The update check didn’t work.',
  }[u.status] || '';
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, 'Updates'), h('span', { class: 'muted small' }, `  KeaS ${S.version || ''}`)),
    line && h('p', { class: u.status === 'error' ? 'err' : 'muted small' }, line),
    u.status === 'ready' && h('p', { class: 'muted small' }, S.hubExternal
      ? 'KeaS restarts to install it, and starts the server again by itself. The installer stops the server that started before sign-in too, so KeaS runs the server itself until Windows next starts, when the start-up task runs the new version. The server is offline for about a minute.'
      : 'KeaS restarts to install it and starts the server again by itself; the server is offline for about a minute.'),
    u.status === 'ready' && n.on && h('p', { class: 'muted small' }, 'Not while Payroll is open or in use: then it waits for the next night.'),
    h('div', { class: 'row' },
      u.status === 'ready'
        ? h('button', { class: 'btn primary', onclick: async () => {
          // (Payroll open: restarting locks it and loses whatever isn't saved there.)
          const st = await call(k.state).catch(() => ({}));
          if (!(await askInPage(`Restart KeaS now to install ${u.version}?`, st.payrollOpen ? 'Payroll is open: restarting locks it, and anything not saved there is lost. Save your work first.' : '', 'Install now'))) return;
          try { await call(k.installUpdate); } catch (e) { S.update = { ...u, status: 'error', message: e.message }; render(); }
        } }, 'Install now')
        : h('button', { class: 'btn', disabled: busy || u.status === 'dev', onclick: async () => {
          // (A failed check shows in this panel only, not twice.)
          try { S.update = { status: 'checking' }; render(); S.update = await call(k.checkUpdates); render(); } catch (e) { S.update = { status: 'error', message: e.message }; render(); }
        } }, 'Check for updates')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.on, onchange: (e) => setNightly({ on: e.target.checked }) }), `Install updates by themselves at night (between ${nightlyHours(n)})`),
    h('details', { open: !!S.updAdv, ontoggle: (e) => (S.updAdv = e.target.open) }, h('summary', null, 'Advanced'),
      h('p', { class: 'muted small' }, 'The hours for installing at night (this computer’s time). KeaS looks every few minutes inside them.'),
      h('div', { class: 'row' },
        h('label', null, 'From ', h('select', { onchange: (e) => setNightly({ from: Number(e.target.value) }) }, ...hourOptions(n.from))),
        h('label', null, ' to ', h('select', { onchange: (e) => setNightly({ to: Number(e.target.value) }) }, ...hourOptions(n.to))))));
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
    if (e.data && e.data.need === 'signin') { go('account'); return; }
    S.payError = e.message; render();
  }
}
/** After opening: secrets typed into the forms are dropped from the page. */
function payOpened() { S.payForm = null; S.payData = null; S.payLocked = null; S.pay = null; S.busy = false; render(); setTimeout(loadChecklist, 1500); }
function payrollPanel() {
  const p = S.pay;
  if (!p) { loadPayroll(); return h('div', { class: 'panel' }, h('p', { class: 'muted small' }, 'Loading…')); }
  const intro = h('p', null, 'Pay runs, tax forms and HR records for your organization. Payroll runs only on this computer: SSNs and bank details are encrypted with a passphrase you choose and never leave this computer.');
  if (!p.signedIn)
    return h('div', { class: 'panel' }, intro, h('p', null, h('button', { class: 'btn primary', onclick: () => go('account') }, 'Sign in to use Payroll')));
  const f = S.payForm;
  const d = S.payData || (S.payData = {});
  const field = (label, key, type = 'text', extra = {}) => h('label', { class: 'field' }, label, h('input', { type, value: d[key] || '', oninput: (e) => (d[key] = e.target.value), ...extra }));
  const err = S.payError && h('div', { class: 'err' }, S.payError);
  const cancel = h('button', { class: 'btn', type: 'button', disabled: S.busy, onclick: () => { S.payForm = null; S.payData = null; S.payError = ''; render(); } }, 'Cancel');
  const sendUnlock = async () => {
    S.busy = true; S.payError = ''; render();
    try {
      const r = await call(k.payrollUnlock, { passphrase: d.passphrase, password: S.legacy ? d.password : undefined, provider: S.legacy ? undefined : d.provider || providerList()[0] || 'google', code: f.need === 'code' ? d.code : undefined });
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
    // (Starts from the organization on the KeaS server, when there is one.)
    const o = S.cl && S.cl.org;
    if (o && d.orgName === undefined) { d.orgName = o.name; d.state = d.state || o.state || ''; if (o.tz) d.tz = o.tz; }
    if (!d.tz) d.tz = zone;
    const zones = TIME_ZONES.includes(d.tz) ? TIME_ZONES : [d.tz, ...TIME_ZONES];
    const a = S.acct || {};
    const tables = (p.taxStates || []);
    const confirmKey = !f.ownHub && f.fingerprint;
    body = form(async () => {
      const why = !(d.orgName || '').trim() ? 'Enter the organization’s name.' : !d.state ? 'Pick the state.' : (d.passphrase || '').length < 12 ? 'The passphrase needs 12 or more characters.' : d.passphrase !== d.passphrase2 ? 'The two passphrases don’t match.' : confirmKey && !d.keyOk ? 'Compare the KeaS server’s key fingerprint first.' : '';
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
      h('p', { class: 'small' }, 'KeaS server key fingerprint: ', h('code', null, f.fingerprint)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!d.keyOk, onchange: (e) => { d.keyOk = e.target.checked; render(); } }), 'It matches the one shown on this PC (KeaS there: Payroll, Advanced)')),
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
      h('p', { class: 'muted small' }, S.useBackup ? 'The passphrase is right. Now one of the owner account’s backup codes.' : 'The passphrase is right. Now the owner account’s 6-digit code from its authenticator app.'),
      codeInput(() => d.code, (v) => (d.code = v), { label: 'Code' }),
      err,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Opening…' : 'Open Payroll')));
  } else {
    body = form(sendUnlock,
      h('h3', null, f.askEveryTime ? 'Sign in to Payroll' : 'Unlock Payroll'),
      h('p', { class: 'muted small' }, f.askEveryTime ? `${f.org ? `${f.org}. ` : ''}${S.legacy ? 'Your Kea Hub password and the vault passphrase.' : 'The vault passphrase, then your browser opens to sign in with your Kea account.'}` : `${f.org ? `${f.org}. ` : ''}The vault passphrase. KeaS remembers it until you close KeaS or payroll locks.`),
      f.askEveryTime && S.legacy && field('Kea Hub password', 'password', 'password', { autocomplete: 'current-password' }),
      field('Vault passphrase', 'passphrase', 'password'),
      f.askEveryTime && !S.legacy && providerList().length > 1 && h('label', { class: 'field' }, 'Sign in with', h('select', { onchange: (e) => (d.provider = e.target.value) }, providerList().map((p) => h('option', { value: p, selected: (d.provider || 'google') === p }, PROVIDER_LABEL[p])))),
      f.askEveryTime && !S.legacy && !providerList().length && h('p', { class: 'err' }, NOT_SET_UP),
      err,
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', type: 'submit', disabled: S.busy }, S.busy ? 'Opening…' : f.askEveryTime && !S.legacy ? `Continue with ${PROVIDER_LABEL[d.provider || providerList()[0] || 'google']}` : 'Open Payroll')));
  }
  return h('div', { class: 'panel', id: 'payroll' }, intro, body,
    !f && err,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p.askEveryTime, onchange: async (e) => {
      try { await call(k.payrollAskEveryTime, { on: e.target.checked }); S.pay = null; S.payForm = null; render(); } catch (er) { fail(er); }
    } }), h('span', null, 'Ask for my sign-in every time I open Payroll', h('span', { class: 'muted small' }, ' A fresh Google or Microsoft sign-in and the passphrase, at every open. Off: KeaS uses your Kea sign-in and asks for the passphrase once each time KeaS starts.'))),
    payrollAdvanced());
}

// Payroll settings only this app can change (the payroll page can't): the local password fallback, and accepting the
// KeaS server's signing key after the server was moved or reinstalled.
function payrollAdvanced() {
  return h('details', { open: !!S.payAdv, ontoggle: (e) => { S.payAdv = e.target.open; if (S.payAdv && !S.ps) call(k.payrollSettings).then((v) => { S.ps = v; render(); }).catch(fail); } }, h('summary', null, 'Advanced'),
    !S.ps ? h('p', { class: 'muted small' }, 'Loading…') : [
      h('p', { class: 'muted small' }, `Payroll admins sign in with their Kea account at ${S.ps.hubUrl || '(no KeaS server set)'}, plus the vault passphrase.`),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: S.ps.localSignIn, onchange: async (e) => { try { S.ps = await call(k.payrollLocalSignIn, { on: e.target.checked }); render(); } catch (err) { fail(err); } } }),
        h('span', null, 'Allow a local password while the KeaS server can’t be reached',
          h('span', { class: 'muted small' }, ' Each payroll admin can then set a long local password (16 or more characters) in Payroll. It only works while the server can’t be reached, still needs the vault passphrase, and skips the server’s two-step sign-in, so leave it off unless you need it. Off by default.'))),
      S.ps.exportsDir && h('p', { class: 'muted small' }, `Files Payroll saves (tax form data, bank files, reports) go to ${S.ps.exportsDir}, a folder only your Windows account can open. `,
        h('button', { class: 'btn', onclick: () => call(k.payrollOpenExports).catch(fail) }, 'Open Exports folder')),
      S.ps.folderProblem && h('p', { class: 'err' }, `The payroll folder’s permissions: ${S.ps.folderProblem}`),
      S.ps.ownHubFingerprint && h('p', { class: 'small' }, 'This server’s key fingerprint (payroll on another PC asks you to compare it): ', h('code', {}, S.ps.ownHubFingerprint)),
      h('p', { class: 'muted small' }, 'Payroll trusts the KeaS server’s signing key from when it was set up. If the server’s key changes, sign-in is refused until you check the new key here and accept it. Only do this for your own server.'),
      h('p', null, h('button', { class: 'btn', onclick: async () => { try { S.hubKey = await call(k.payrollHubKey); S.error = ''; S.repinned = ''; render(); } catch (err) { fail(err); } } }, 'Check the KeaS server’s key')),
      S.hubKey && hubKeyPanel(S.hubKey),
      S.repinned && h('p', { class: 'small ok' }, S.repinned),
    ]);
}
/** The server's current key next to the trusted one: the owner compares fingerprints, reads why it might change, then confirms. */
function hubKeyPanel(s) {
  const fp = (t) => h('code', { style: 'font-size:12px;word-break:break-all' }, t || '—');
  if (!s.changed && s.pinned) return h('p', { class: 'small ok' }, 'The KeaS server’s key is the one payroll trusts. Nothing to do. Fingerprint: ', fp(s.current.fingerprint));
  return h('div', { class: 'panel' },
    h('p', null, h('b', null, s.pinned ? 'The KeaS server is offering a different key from the one payroll trusts.' : 'Payroll doesn’t trust a KeaS server key yet.')),
    h('p', { class: 'small' }, 'New key: ', fp(s.current.fingerprint)),
    s.pinned && h('p', { class: 'small' }, `Trusted since ${new Date(s.pinned.at).toLocaleString()}: `, fp(s.pinned.fingerprint)),
    s.localHub && h('p', { class: s.localHub.matches ? 'small ok' : 'err' }, s.localHub.matches ? 'It matches this PC’s own KeaS server key file.' : 'It does NOT match this PC’s own KeaS server key file. Don’t accept it.'),
    h('p', { class: 'small' }, 'A server’s key changes when:'),
    h('ul', { class: 'small' }, ...s.reasons.map((r) => h('li', null, r))),
    h('p', { class: 'small' }, s.warning, ' Compare the new key with the fingerprint shown on this PC before accepting it.'),
    h('p', null, h('button', { class: 'btn', onclick: async () => {
      if (!window.confirm(`Accept the KeaS server key ${s.current.fingerprint}?\n\nOnly if you know why it changed and it matches your Hub.`)) return;
      try { const r = await call(k.payrollRepinHub, { fingerprint: s.current.fingerprint }); S.error = ''; S.hubKey = null; S.repinned = `Accepted the KeaS server’s key ${r.fingerprint}.`; render(); } catch (err) { fail(err); }
    } }, 'Accept this key')));
}

/** A form: Enter submits it (the page never navigates). */
function form(onsubmit, ...kids) {
  return h('form', { onsubmit: (e) => { e.preventDefault(); onsubmit(); } }, ...kids);
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
