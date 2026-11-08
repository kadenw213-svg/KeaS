// Who people are comes from the sign-in system the org engine runs under, through an identity adapter. Today that is
// the Kea Hub's accounts (hub/orgIdentity.mjs); later it can be KeaC passes. The engine keeps only account ids.
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
