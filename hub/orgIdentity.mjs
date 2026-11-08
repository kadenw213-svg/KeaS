// The org engine's identity adapter for the Kea Hub (org/identity.mjs): people are Hub accounts. Later the same engine
// gets its people from KeaC passes instead, with another adapter.
export function hubIdentity({ h, now, extrasFor, getSetting }) {
  const COLS = 'id, display_name, email, email_verified, verified_by, phone, phone_visibility, supporter_until';
  const profile = (a) => ({
    name: a.display_name, email: a.email, emailVerified: !!a.email_verified,
    // What a member list may show besides a name: the supporter badge, and the phone where its owner allowed it.
    extras: (where, opts) => extrasFor(a, where, opts),
  });
  return {
    who: (me) => ({ id: me.id, name: me.display_name, email: me.email, emailVerified: !!me.email_verified, superuser: me.role === 'owner' }),
    profiles(ids) {
      const out = new Map();
      if (!ids.length) return out;
      for (let i = 0; i < ids.length; i += 500)
        for (const a of h.all(`SELECT ${COLS} FROM accounts WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids.slice(i, i + 500)))) out.set(a.id, profile(a));
      return out;
    },
    findByEmail: (email) => (email ? h.get('SELECT id FROM accounts WHERE email = ?', String(email).trim().toLowerCase())?.id ?? null : null),
    // (A Hub sign-in's sub is the account id.)
    findBySub: (sub) => (sub ? h.get('SELECT id FROM accounts WHERE id = ?', String(sub))?.id ?? null : null),
    orgPolicy: (who) => (who.emailVerified || who.superuser
      ? { allowed: true, autoApprove: who.superuser || getSetting('orgs', {}).autoApprove === true }
      : { allowed: false, message: 'Verify your email first (Settings > Account > Verify with Google, or ask the Kea Hub’s owner), then create the organization.' }),
    verifyEmail(accountId, { by }) {
      const a = h.get('SELECT id, email, email_verified, verified_by FROM accounts WHERE id = ?', accountId);
      if (!a) return null;
      if (a.email_verified) return { already: true, verifiedBy: a.verified_by, email: a.email };
      h.run('UPDATE accounts SET email_verified = 1, verified_by = ?, updated_at = ? WHERE id = ? AND email_verified = 0', by, now(), a.id);
      return { already: false, verifiedBy: by, email: a.email };
    },
  };
}
