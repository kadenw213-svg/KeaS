// The page a parent or guardian opens from a member's sign-off link (GET /consent?t=...). It says who is asking and
// what for, and the parent confirms by signing in to Google with the email the member named (the Google button runs
// in the parent's own browser; the Hub checks the token like any other "Verify with Google").
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1f;--muted:#5f6368;--card:#fff;--line:#e3e3e0;--accent:#b8860b;--ok:#137333;--bad:#a50e0e}
@media (prefers-color-scheme:dark){:root{--bg:#131314;--fg:#e3e3e3;--muted:#9aa0a6;--card:#1e1f20;--line:#333537;--accent:#e2b13c;--ok:#81c995;--bad:#f28b82}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 12px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 14px}
ul{padding-left:22px;margin:8px 0}.muted{color:var(--muted)}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
label{display:flex;gap:10px;align-items:flex-start;margin:10px 0}#gbtn{margin-top:14px;min-height:44px}a{color:var(--accent)}`;

/**
 * state: { found, status, expired, memberName, parentEmail, webClientId }. nonce: for the one inline script.
 */
export function consentPage(state, { nonce, token }) {
  let body;
  if (!state.found || state.status === 'revoked' || state.expired) {
    body = `<section><p class="bad">This sign-off link has expired or was replaced.</p><p>Ask for a new link in Kea: Your account → Parent sign-off.</p></section>`;
  } else if (state.status === 'approved') {
    body = `<section><p class="ok">Signed off.</p><p>${esc(state.memberName)} can use Kea’s shared Claude. You can withdraw this at any time by contacting Kea support.</p></section>`;
  } else if (state.status === 'declined') {
    body = `<section><p class="bad">You declined this sign-off.</p><p>${esc(state.memberName)} can still use Kea with their own Claude or without Claude.</p></section>`;
  } else {
    body = `
<section>
  <p><strong>${esc(state.memberName)}</strong> uses Kea, a free study app, and is under 18. They asked you (${esc(state.parentEmail)}) to sign off before they use <strong>Kea’s shared Claude</strong>.</p>
  <p>What that means:</p>
  <ul>
    <li>Kea’s creator’s own Claude (an AI assistant made by Anthropic) does limited work for them, in a queue: setting up their classes from their school’s class site, and writing practice questions.</li>
    <li>While a scan runs, Claude reads their class pages through their own Kea. Their school password never leaves their computer.</li>
    <li>Study material made from a scan is shared with classmates in the same course section. Grades and private work are never shared.</li>
    <li>It’s free. Donations are optional and buy nothing.</li>
  </ul>
  <p class="muted">The full terms are at <a href="/terms#parent-sign-off">/terms</a>. You can withdraw your sign-off at any time by contacting Kea support.</p>
</section>
<section>
  <label><input type="radio" name="choice" value="yes" checked> I’m their parent or guardian, and I agree.</label>
  <label><input type="radio" name="choice" value="no"> I don’t agree.</label>
  ${state.webClientId
    ? `<p class="muted">To confirm it’s you, sign in to Google as ${esc(state.parentEmail)}. Google tells Kea only your email address.</p><div id="gbtn"></div><p id="msg" role="status"></p>`
    : `<p class="muted">To confirm it’s you, open Kea on ${esc(state.memberName)}’s computer: Your account → Parent sign-off → Verify with Google, and sign in to Google as ${esc(state.parentEmail)}.</p>`}
</section>`;
  }
  const script = state.webClientId && state.found && state.status === 'pending' && !state.expired
    ? `<script src="https://accounts.google.com/gsi/client" async nonce="${nonce}"></script>
<script nonce="${nonce}">
(function () {
  var msg = function (t, cls) { var m = document.getElementById('msg'); m.textContent = t; m.className = cls || ''; };
  function done(r) {
    var approve = document.querySelector('input[name=choice]:checked').value === 'yes';
    msg('Checking…');
    fetch('/v1/consent/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(token)}, idToken: r.credential, approve: approve }) })
      .then(function (x) { return x.json().then(function (b) { return { ok: x.ok, b: b }; }); })
      .then(function (x) { if (x.ok) { location.reload(); } else { msg(x.b.error || 'That didn’t work. Try again.', 'bad'); } })
      .catch(function () { msg('Couldn’t reach Kea. Try again.', 'bad'); });
  }
  window.addEventListener('load', function () {
    if (!window.google) return msg('Google sign-in didn’t load. Check your connection and reload the page.', 'bad');
    google.accounts.id.initialize({ client_id: ${JSON.stringify(state.webClientId)}, callback: done, login_hint: ${JSON.stringify(state.parentEmail)}, auto_select: false });
    google.accounts.id.renderButton(document.getElementById('gbtn'), { text: 'continue_with', size: 'large' });
  });
})();
</script>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kea parent sign-off</title><style>${STYLE}</style></head><body><main><h1>Parent or guardian sign-off</h1>${body}</main>${script}</body></html>`;
}

/** The page's Content-Security-Policy: Google's sign-in script and frame only, and calls back to the Hub itself. */
export function consentCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://accounts.google.com/gsi/client`,
    "style-src 'unsafe-inline' https://accounts.google.com/gsi/style",
    'frame-src https://accounts.google.com/gsi/',
    "connect-src 'self' https://accounts.google.com/gsi/",
    "img-src 'self' https://*.googleusercontent.com https://*.gstatic.com",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}
