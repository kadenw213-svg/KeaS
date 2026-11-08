// Who people are comes from the sign-in system the org engine runs under, through an identity adapter. On a KeaS
// server that is KeaC passes (passIdentity below): people are Kea account ids, with the name and email their last pass
// carried. The engine keeps only account ids.
//
// An adapter is an object with:
//   who(me)            -> { id, name, email, emailVerified, superuser }  the signed-in caller, from what the host's
//                         router hands each route as ctx.me. superuser: the operator of the whole server (the Kea Hub's
//                         owner), who may make organizations without waiting and verify anyone's email.
//   profiles(ids)      -> Map(id -> { name, email, emailVerified, extras?(where, { phone }) })  for people in lists.
// and, optionally:
//   findByEmail(email) -> account id or null           (the one-time import from an org server)
//   findBySub(sub)     -> account id or null           (the same, by the Kea account id the server saw at sign-in)
//   orgPolicy(who)     -> { allowed: true } | { allowed: false, message }, plus autoApprove: bool, for making an org
//   verifyEmail(accountId, { by, orgId }) -> { already, verifiedBy }   (a manager vouching for someone's email)

/** An adapter over a fixed list of people (tests, tools, or a host that keeps its own profiles). */
export function staticIdentity(people = []) {
  const byId = new Map(people.map((p) => [p.id, { ...p }]));
  return {
    add(p) { byId.set(p.id, { ...p }); },
    who: (me) => {
      const p = byId.get(me?.id) ?? me;
      return { id: p.id, name: p.name ?? '', email: p.email ?? null, emailVerified: !!p.emailVerified, superuser: !!p.superuser };
    },
    profiles: (ids) => new Map(ids.filter((i) => byId.has(i)).map((i) => [i, byId.get(i)])),
    findByEmail: (email) => [...byId.values()].find((p) => p.email && p.email.toLowerCase() === String(email || '').toLowerCase())?.id ?? null,
    findBySub: (sub) => (byId.has(sub) ? sub : null),
    orgPolicy: () => ({ allowed: true, autoApprove: true }),
  };
}

/**
 * People from KeaC passes (docs/protocol.md section 2). The host keeps one row per Kea account that signed in with a
 * pass, in `keas_members` (id = the Kea account id, the pass's sub; email and name from the newest pass), and says who
 * runs the server (operatorId(): the account that claimed it at setup). Every pass carries ev: true, so every member's
 * email is verified by KeaC. Organizations are made by the operator; anyone else only when the operator allows it
 * (settings 'orgs': { anyoneCreates, autoApprove }).
 */
export function passIdentity({ h, operatorId = () => null, getSetting = () => ({}) }) {
  const out = (r) => ({ name: r.name || r.email || '', email: r.email ?? null, emailVerified: true });
  return {
    who: (me) => ({ id: me.id, name: me.name || me.email || '', email: me.email ?? null, emailVerified: true, superuser: !!me.id && me.id === operatorId() }),
    profiles(ids) {
      const m = new Map();
      for (let i = 0; i < ids.length; i += 500)
        for (const r of h.all('SELECT id, email, name FROM keas_members WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids.slice(i, i + 500)))) m.set(r.id, out(r));
      return m;
    },
    findByEmail: (email) => (email ? h.get('SELECT id FROM keas_members WHERE email = ?', String(email).trim().toLowerCase())?.id ?? null : null),
    findBySub: (sub) => (sub ? h.get('SELECT id FROM keas_members WHERE id = ?', String(sub))?.id ?? null : null),
    orgPolicy(who) {
      if (who.superuser) return { allowed: true, autoApprove: true };
      const s = getSetting('orgs', {}) || {};
      if (s.anyoneCreates === true) return { allowed: true, autoApprove: s.autoApprove === true };
      return { allowed: false, message: 'Organizations on this KeaS server are made by whoever runs it. Ask them, or join yours with a code.' };
    },
  };
}
