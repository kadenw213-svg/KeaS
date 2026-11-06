// Approvals engine: configurable chains of steps for time off, timecards, budgets, raises, pay runs, expenses and offers.
// A step is { type: 'role', role } | { type: 'person', personId } | { type: 'manager_of' } | { type: 'department_head' }.
// Nobody approves their own request or one about themselves (the owner can, and it's recorded).

export const APPROVAL_KINDS = ['time_off', 'timecard', 'budget', 'raise', 'payrun', 'expense', 'offer'];
export const DEFAULT_STEPS = {
  time_off: [{ type: 'manager_of' }],
  timecard: [{ type: 'role', role: 'manager' }],
  budget: [{ type: 'role', role: 'owner' }],
  raise: [{ type: 'manager_of' }, { type: 'role', role: 'payroll' }],
  payrun: [{ type: 'role', role: 'payroll' }],
  expense: [{ type: 'manager_of' }],
  offer: [{ type: 'role', role: 'owner' }],
};
const STEP_TYPES = ['role', 'person', 'manager_of', 'department_head'];
const ROLES = ['manager', 'payroll', 'owner'];

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export const rowToApproval = (r) => r && ({
  id: r.id, kind: r.kind, targetId: r.target_id, requestedBy: r.requested_by, subjectPersonId: r.subject_person_id, title: r.title,
  detail: J(r.detail, null), amountCents: r.amount_cents, chainId: r.chain_id, steps: J(r.steps, []), stepIndex: r.step_index,
  status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
});
const rowToChain = (r) => ({ id: r.id, kind: r.kind, name: r.name, steps: J(r.steps, []), minAmountCents: r.min_amount_cents, departmentId: r.department_id, active: !!r.active });

export function validateSteps(steps, bad) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) bad('steps must be a list of 1 to 8 steps');
  return steps.map((s, i) => {
    if (!s || !STEP_TYPES.includes(s.type)) bad(`step ${i + 1}: type must be one of ${STEP_TYPES.join(', ')}`);
    if (s.type === 'role' && !ROLES.includes(s.role)) bad(`step ${i + 1}: role must be one of ${ROLES.join(', ')}`);
    if (s.type === 'person' && (typeof s.personId !== 'string' || !s.personId)) bad(`step ${i + 1}: personId is required`);
    return s.type === 'role' ? { type: 'role', role: s.role } : s.type === 'person' ? { type: 'person', personId: s.personId } : { type: s.type };
  });
}

export function makeApprovals({ h, now, iso, uid, audit, HttpError }) {
  const hooks = new Map(); // kind -> { approved(req, actor), denied(req, actor) }
  const person = (id) => (id ? h.get('SELECT id, roles, manager_id, department_id FROM people WHERE id = ?', id) : null);
  const rolesOf = (p) => J(p?.roles, []);
  const hasRole = (p, role) => rolesOf(p).includes('owner') || rolesOf(p).includes(role);

  /** Who may act on this step (null = anyone with the fallback role 'manager'). */
  function resolve(step, req) {
    if (step.type === 'person') return { personId: step.personId };
    if (step.type === 'role') return { role: step.role };
    const subject = person(req.subject_person_id ?? req.subjectPersonId);
    if (step.type === 'manager_of' && subject?.manager_id) return { personId: subject.manager_id };
    if (subject?.department_id) {
      let d = h.get('SELECT * FROM departments WHERE id = ?', subject.department_id);
      while (d && !d.head_person_id && d.parent_id) d = h.get('SELECT * FROM departments WHERE id = ?', d.parent_id);
      if (d?.head_person_id && d.head_person_id !== subject.id) return { personId: d.head_person_id };
    }
    return { role: 'manager' };
  }

  function canAct(actorRow, reqRow) {
    if (reqRow.status !== 'pending') return false;
    const isOwner = rolesOf(actorRow).includes('owner');
    if (!isOwner && (actorRow.id === reqRow.requested_by || actorRow.id === reqRow.subject_person_id)) return false;
    const steps = J(reqRow.steps, []);
    const who = resolve(steps[reqRow.step_index], reqRow);
    if (isOwner) return true;
    return who.personId ? who.personId === actorRow.id : hasRole(actorRow, who.role);
  }

  function chainFor(orgId, kind, { amountCents = null, departmentId = null } = {}) {
    const rows = h.all('SELECT * FROM approval_chains WHERE org_id = ? AND kind = ? AND active = 1', orgId, kind)
      .filter((c) => (c.department_id == null || c.department_id === departmentId) && (c.min_amount_cents == null || (amountCents ?? 0) >= c.min_amount_cents));
    rows.sort((a, b) => (b.department_id ? 1 : 0) - (a.department_id ? 1 : 0) || (b.min_amount_cents ?? -1) - (a.min_amount_cents ?? -1));
    return rows[0] || null;
  }

  const api = {
    hooks,
    on(kind, fns) { hooks.set(kind, fns); },
    configured: (orgId, kind) => !!h.get('SELECT 1 FROM approval_chains WHERE org_id = ? AND kind = ? AND active = 1', orgId, kind),
    get: (id) => rowToApproval(h.get('SELECT * FROM approval_requests WHERE id = ?', id)),
    find: (orgId, kind, targetId) => rowToApproval(h.get(`SELECT * FROM approval_requests WHERE org_id = ? AND kind = ? AND target_id = ? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1`, orgId, kind, targetId)),
    start({ orgId, kind, targetId, requestedBy, subjectPersonId = null, title, detail = null, amountCents = null, departmentId = null }) {
      const chain = chainFor(orgId, kind, { amountCents, departmentId });
      const steps = chain ? J(chain.steps, []) : DEFAULT_STEPS[kind];
      const id = uid('ap');
      h.run(`INSERT INTO approval_requests (id,org_id,kind,target_id,requested_by,subject_person_id,title,detail,amount_cents,chain_id,steps,step_index,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'pending',?)`, id, orgId, kind, targetId, requestedBy, subjectPersonId, title, JSON.stringify(detail), amountCents, chain?.id ?? null, JSON.stringify(steps), iso(now()));
      audit(orgId, requestedBy, 'approval_start', id, { kind, targetId });
      return api.get(id);
    },
    canAct(actorId, id) { const a = person(actorId), r = h.get('SELECT * FROM approval_requests WHERE id = ?', id); return !!(a && r && canAct(a, r)); },
    decide(id, actorId, approve, comment = null) {
      const r = h.get('SELECT * FROM approval_requests WHERE id = ?', id);
      if (!r) throw new HttpError(404, 'approval not found');
      if (r.status !== 'pending') throw new HttpError(409, `already ${r.status}`);
      const actor = person(actorId);
      if (!canAct(actor, r)) throw new HttpError(403, 'this step isn’t yours to approve');
      const steps = J(r.steps, []);
      let out;
      h.tx(() => {
        h.run('INSERT INTO approval_actions (request_id,step_index,actor,decision,comment,at) VALUES (?,?,?,?,?,?)', id, r.step_index, actorId, approve ? 'approve' : 'deny', comment, iso(now()));
        if (!approve) h.run(`UPDATE approval_requests SET status = 'denied', decided_at = ? WHERE id = ?`, iso(now()), id);
        else if (r.step_index + 1 >= steps.length) h.run(`UPDATE approval_requests SET status = 'approved', step_index = ?, decided_at = ? WHERE id = ?`, steps.length, iso(now()), id);
        else h.run('UPDATE approval_requests SET step_index = ? WHERE id = ?', r.step_index + 1, id);
        out = api.get(id);
        const hook = hooks.get(r.kind);
        if (out.status === 'approved') hook?.approved?.(out, actorId);
        if (out.status === 'denied') hook?.denied?.(out, actorId);
      });
      audit(r.org_id, actorId, approve ? 'approval_approve' : 'approval_deny', id, { kind: r.kind, step: r.step_index, comment });
      return out;
    },
    cancel(id, actorId) {
      const r = h.get('SELECT * FROM approval_requests WHERE id = ?', id);
      if (!r) throw new HttpError(404, 'approval not found');
      if (r.status !== 'pending') throw new HttpError(409, `already ${r.status}`);
      const actor = person(actorId);
      if (r.requested_by !== actorId && !rolesOf(actor).includes('owner')) throw new HttpError(403, 'only the requester can cancel');
      h.run(`UPDATE approval_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`, iso(now()), id);
      hooks.get(r.kind)?.cancelled?.(api.get(id), actorId);
      return api.get(id);
    },
    pendingFor(orgId, actorId) {
      const a = person(actorId);
      return h.all(`SELECT * FROM approval_requests WHERE org_id = ? AND status = 'pending' ORDER BY created_at`, orgId).filter((r) => canAct(a, r)).map(rowToApproval);
    },
    actions: (id) => h.all('SELECT * FROM approval_actions WHERE request_id = ? ORDER BY id', id).map((x) => ({ stepIndex: x.step_index, actor: x.actor, decision: x.decision, comment: x.comment, at: x.at })),
    whoFor(req) { const r = h.get('SELECT * FROM approval_requests WHERE id = ?', req.id); return r.status === 'pending' ? resolve(J(r.steps, [])[r.step_index], r) : null; },
    chains: (orgId) => h.all('SELECT * FROM approval_chains WHERE org_id = ? ORDER BY kind, name', orgId).map(rowToChain),
  };
  return api;
}

export function registerApprovals(c) {
  const { h, route, V, bad, need, HttpError, approvals, uid, audit } = c;
  const nameOf = (id) => h.get('SELECT name FROM people WHERE id = ?', id)?.name ?? id;
  const out = (a) => {
    const who = approvals.whoFor(a);
    return { ...a, requestedByName: nameOf(a.requestedBy), subjectName: a.subjectPersonId ? nameOf(a.subjectPersonId) : null, waitingOn: who ? (who.personId ? { personId: who.personId, name: nameOf(who.personId) } : { role: who.role }) : null, actions: approvals.actions(a.id).map((x) => ({ ...x, actorName: nameOf(x.actor) })) };
  };

  route('GET', '/v1/approvals', ({ me, org, query }) => {
    const scope = V.enum(query.scope ?? 'mine', 'scope', ['mine', 'requested', 'all']);
    let rows;
    if (scope === 'mine') rows = approvals.pendingFor(org.id, me.id);
    else if (scope === 'requested') rows = h.all('SELECT * FROM approval_requests WHERE org_id = ? AND requested_by = ? ORDER BY created_at DESC LIMIT 200', org.id, me.id).map((r) => approvals.get(r.id));
    else { need(me, 'manager', 'payroll'); rows = h.all('SELECT * FROM approval_requests WHERE org_id = ? ORDER BY created_at DESC LIMIT 300', org.id).map((r) => approvals.get(r.id)); }
    return { approvals: rows.map(out) };
  });
  route('GET', '/v1/approvals/:id', ({ me, org, params }) => {
    const a = approvals.get(params.id);
    if (!a || h.get('SELECT org_id FROM approval_requests WHERE id = ?', a.id).org_id !== org.id) throw new HttpError(404, 'approval not found');
    if (a.requestedBy !== me.id && a.subjectPersonId !== me.id && !approvals.canAct(me.id, a.id)) need(me, 'manager', 'payroll');
    return { approval: out(a) };
  });
  route('POST', '/v1/approvals/:id/decide', ({ me, org, params, body }) => {
    const a = approvals.get(params.id);
    if (!a || h.get('SELECT org_id FROM approval_requests WHERE id = ?', a.id).org_id !== org.id) throw new HttpError(404, 'approval not found');
    return { approval: out(approvals.decide(a.id, me.id, V.bool(body.approve, 'approve'), V.str(body.comment, 'comment', { optional: true, max: 1000 }))) };
  });
  route('POST', '/v1/approvals/:id/cancel', ({ me, org, params }) => {
    const a = approvals.get(params.id);
    if (!a || h.get('SELECT org_id FROM approval_requests WHERE id = ?', a.id).org_id !== org.id) throw new HttpError(404, 'approval not found');
    return { approval: out(approvals.cancel(a.id, me.id)) };
  });

  route('GET', '/v1/approval-chains', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    return { chains: approvals.chains(org.id), kinds: APPROVAL_KINDS, defaults: DEFAULT_STEPS };
  });
  route('POST', '/v1/approval-chains', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const kind = V.enum(body.kind, 'kind', APPROVAL_KINDS);
    const name = V.str(body.name, 'name', { min: 1, max: 100 });
    const steps = validateSteps(body.steps, bad);
    for (const s of steps) if (s.type === 'person' && !h.get('SELECT 1 FROM people WHERE id = ? AND org_id = ?', s.personId, org.id)) bad('unknown person in steps');
    const minAmountCents = body.minAmountCents == null ? null : Math.round(Number(body.minAmountCents));
    if (minAmountCents != null && !(minAmountCents >= 0)) bad('minAmountCents must be 0 or more');
    const departmentId = body.departmentId ? V.id(body.departmentId, 'departmentId') : null;
    const active = body.active === false ? 0 : 1;
    const id = body.id ? V.id(body.id, 'id') : uid('ch');
    if (body.id && !h.get('SELECT 1 FROM approval_chains WHERE id = ? AND org_id = ?', id, org.id)) throw new HttpError(404, 'chain not found');
    h.run(`INSERT INTO approval_chains (id,org_id,kind,name,steps,min_amount_cents,department_id,active) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, steps = excluded.steps, min_amount_cents = excluded.min_amount_cents, department_id = excluded.department_id, active = excluded.active`,
      id, org.id, kind, name, JSON.stringify(steps), minAmountCents, departmentId, active);
    audit(org.id, me.id, 'approval_chain_save', id, { kind, steps });
    return { chain: approvals.chains(org.id).find((x) => x.id === id) };
  });
  route('POST', '/v1/approval-chains/:id/delete', ({ me, org, params }) => {
    need(me, 'owner', 'payroll');
    h.run('DELETE FROM approval_chains WHERE id = ? AND org_id = ?', params.id, org.id);
    audit(org.id, me.id, 'approval_chain_delete', params.id, null);
    return { ok: true };
  });
}
