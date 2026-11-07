// The Hub owner's account during setup (no Electron here, so it can be tested with a real Hub).
//
// The account is made through the Hub like anyone's (with the terms), then made owner right here, on this PC, which is
// the only place that can happen. Setup can be closed or restarted at any point, so this also has to work for an
// owner who already exists: one whose two-step sign-in is already on signs in with a code (or the owner step just
// says it's done), and one whose two-step setup was cut off simply gets a new key.
const crypto = require('crypto');

/** A Hub error that keeps what the Hub said (totpRequired, field, ...), so the setup page can show the right step. */
class HubError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || null; }
}

/** call(path, init, token): a JSON request to this PC's own Hub that throws HubError. */
function localCaller(base, fetchImpl = fetch) {
  return async (p, init = {}, token) => {
    let r;
    try {
      r = await fetchImpl(`${base}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    } catch { throw new HubError('The Kea Hub on this PC isn’t answering. Restart KeaS and try again.', 0); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const { error, ...data } = j; throw new HubError(error || `The Kea Hub said ${r.status}.`, r.status, data); }
    return j;
  };
}

/** Where the owner step stands: { email, exists, owner, totp }. Nothing set yet: null. */
function ownerState(db, email) {
  if (!email) return null;
  const a = db.get('SELECT email, role, totp_enabled FROM accounts WHERE email = ?', String(email).trim().toLowerCase());
  if (!a) return { email, exists: false, owner: false, totp: false };
  return { email: a.email, exists: true, owner: a.role === 'owner', totp: !!a.totp_enabled };
}
/** The owner step has nothing left to do: the owner exists and has two-step sign-in on. */
const ownerDone = (s) => !!(s && s.exists && s.owner && s.totp);

/**
 * Makes (or signs in) the owner account and makes it owner. Returns { email, token, totp } where totp is the new
 * two-step key to set up ({ secret, uri }), or null when two-step sign-in is already on. An account with two-step
 * sign-in on needs `code`; without it this throws a HubError with data.totpRequired.
 */
async function createOwner({ db, call, name, email, password, code, termsVersion, termsSections, now = Date.now }) {
  const mail = String(email || '').trim().toLowerCase();
  const existing = db.get('SELECT id FROM accounts WHERE email = ?', mail);
  // Registering never returns a session (the Hub answers the same for new and existing emails), so a new account
  // is made first and then signed in like an existing one. A brand-new account has no two-step sign-in yet.
  if (!existing) await call('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: mail, password, displayName: name, age13: true, termsVersion, termsSections }) });
  const token = (await call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: mail, password, ...(code ? { code: String(code).trim() } : {}) }) })).token;
  if (!token) throw new HubError('The Hub didn’t sign the owner account in. Check the password and try again.', 401);
  const a = db.get('SELECT * FROM accounts WHERE email = ?', mail);
  // Made owner, and every other sign-in of the account ends (one made earlier with only the password mustn't carry
  // owner powers). The one just made stays: it's KeaS's own, and it passed two-step if two-step is on (if not,
  // turning two-step on next marks it as passed).
  db.tx(() => {
    db.run("UPDATE accounts SET role = 'owner', can_host = 1, email_verified = 1, verified_by = 'owner', identity_verified = 1, updated_at = ? WHERE id = ?", now(), a.id);
    const ended = Number(db.run('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?', a.id, crypto.createHash('sha256').update(token).digest('hex')).changes);
    db.run('INSERT INTO audit (at,actor,action,target,detail,ip) VALUES (?,?,?,?,?,?)', now(), 'keas-setup', 'owner.make_owner', a.id, JSON.stringify({ sessionsEnded: ended }), 'local');
  });
  // The owner must use two-step sign-in. (Already on: nothing to set up.) Setting it up needs the password again: a
  // session alone can't change how an account signs in.
  const totp = a.totp_enabled ? null : await call('/v1/me/totp/setup', { method: 'POST', body: JSON.stringify({ password }) }, token);
  return { email: a.email, token, totp: totp ? { secret: totp.secret, uri: totp.uri } : null };
}

module.exports = { HubError, localCaller, ownerState, ownerDone, createOwner };
