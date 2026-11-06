// Org structure for payroll: legal entities (EINs), a department tree of any depth, cost centers, labor allocation
// splits (per person by default, per shift or per hour when set) and labor budgets with approvals.
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export const rowToEntity = (r, vault) => ({
  id: r.id, name: r.name, ein: r.ein, state: r.state, address: J(r.address, {}), stateIds: J(r.state_ids, {}), isDefault: !!r.is_default,
  bankSet: !!r.bank_enc, bank: vault && r.bank_enc ? vault.openJson(r.bank_enc) : undefined,
});
export const rowToDept = (r) => ({ id: r.id, parentId: r.parent_id, name: r.name, code: r.code, costCenterId: r.cost_center_id, entityId: r.entity_id, headPersonId: r.head_person_id, location: r.location });
export const rowToCostCenter = (r) => ({ id: r.id, code: r.code, name: r.name, glSegment: r.gl_segment, active: !!r.active });

export const validEin = (v) => /^\d{2}-?\d{7}$/.test(v);

/** Departments as a tree, each with its path ("Aquatics / Lessons / Weekend"). */
export function deptTree(depts) {
  const byId = new Map(depts.map((d) => [d.id, { ...d, children: [] }]));
  const roots = [];
  for (const d of byId.values()) (d.parentId && byId.has(d.parentId) ? byId.get(d.parentId).children : roots).push(d);
  const walk = (list, path, depth) => list.sort((a, b) => a.name.localeCompare(b.name)).forEach((d) => { d.path = [...path, d.name].join(' / '); d.depth = depth; walk(d.children, [...path, d.name], depth + 1); });
  walk(roots, [], 0);
  return roots;
}

/** Check a list of allocation splits: either all percentages (summing to 100) or all minutes. */
export function validateSplits(splits, bad, { allowMinutes = true } = {}) {
  if (!Array.isArray(splits) || splits.length < 1 || splits.length > 20) bad('splits must be a list of 1 to 20 entries');
  const usePct = splits.every((s) => s && s.pct != null);
  const useMin = allowMinutes && splits.every((s) => s && s.minutes != null);
  if (!usePct && !useMin) bad(allowMinutes ? 'give every split a pct, or every split minutes' : 'give every split a pct');
  const out = splits.map((s, i) => {
    const o = { departmentId: s.departmentId || null, costCenterId: s.costCenterId || null, program: s.program ? String(s.program).slice(0, 80) : null };
    if (!o.departmentId && !o.costCenterId && !o.program) bad(`split ${i + 1}: needs a department, cost center or program`);
    if (usePct) { o.pct = Number(s.pct); if (!(o.pct > 0 && o.pct <= 100)) bad(`split ${i + 1}: pct must be between 0 and 100`); }
    else { o.minutes = Math.round(Number(s.minutes)); if (!(o.minutes > 0)) bad(`split ${i + 1}: minutes must be more than 0`); }
    return o;
  });
  if (usePct && Math.abs(out.reduce((a, s) => a + s.pct, 0) - 100) > 0.01) bad('split percentages must add up to 100');
  return out;
}

/**
 * Split `minutes` (and its cost) for one person's shift across departments/cost centers/programs.
 * Order: the shift's own splits, then the person's default allocations, then the person's department.
 * Returns [{ departmentId, costCenterId, program, share }] with shares adding to 1.
 */
export function allocationFor(h, person, shiftId, minutes) {
  const deptCc = (deptId) => (deptId ? h.get('SELECT cost_center_id FROM departments WHERE id = ?', deptId)?.cost_center_id ?? null : null);
  const fallback = [{ departmentId: person.departmentId ?? null, costCenterId: deptCc(person.departmentId), program: null, share: 1 }];
  const fromPct = (list) => list.map((s) => ({ departmentId: s.departmentId, costCenterId: s.costCenterId ?? deptCc(s.departmentId), program: s.program ?? null, share: s.pct / 100 }));
  const defaults = person.defaultAllocations?.length ? fromPct(person.defaultAllocations) : fallback;
  const own = shiftId ? J(h.get('SELECT splits FROM shift_allocations WHERE shift_id = ?', shiftId)?.splits, null) : null;
  if (!own) return defaults;
  if (own[0]?.pct != null) return fromPct(own);
  // Minute splits: anything not covered goes to the defaults.
  const total = Math.max(minutes, 1);
  const used = Math.min(total, own.reduce((a, s) => a + s.minutes, 0));
  const out = own.map((s) => ({ departmentId: s.departmentId, costCenterId: s.costCenterId ?? deptCc(s.departmentId), program: s.program ?? null, share: Math.min(s.minutes, total) / total }));
  const scale = used / total / Math.max(out.reduce((a, s) => a + s.share, 0), 1e-9);
  out.forEach((s) => (s.share *= scale));
  if (used < total) for (const d of defaults) out.push({ ...d, share: d.share * (1 - used / total) });
  return out;
}

export function registerOrgStructure(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, approvals, now, iso } = c;
  const entities = (orgId, withBank = false) => h.all('SELECT * FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC, name', orgId).map((r) => rowToEntity(r, withBank ? vault : null));
  const depts = (orgId) => h.all('SELECT * FROM departments WHERE org_id = ? ORDER BY name', orgId).map(rowToDept);
  const ccs = (orgId) => h.all('SELECT * FROM cost_centers WHERE org_id = ? ORDER BY code', orgId).map(rowToCostCenter);
  const owns = (table, id, orgId) => !!h.get(`SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`, id, orgId);
  const optRef = (table, v, name, orgId) => { if (v == null || v === '') return null; V.id(v, name); if (!owns(table, v, orgId)) bad(`unknown ${name}`); return v; };

  route('GET', '/v1/org-structure', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    const list = depts(org.id);
    const counts = new Map(h.all(`SELECT department_id AS d, COUNT(*) AS n FROM people WHERE org_id = ? AND status = 'active' GROUP BY department_id`, org.id).map((r) => [r.d, r.n]));
    return {
      entities: entities(org.id).map((e) => ({ ...e, bank: undefined })), costCenters: ccs(org.id),
      departments: list.map((d) => ({ ...d, headcount: counts.get(d.id) ?? 0 })), tree: deptTree(list),
      glAccounts: { ...DEFAULT_GL, ...(org.settings.glAccounts || {}) },
    };
  });

  route('POST', '/v1/entities', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('le');
    if (body.id && !owns('legal_entities', id, org.id)) throw new HttpError(404, 'entity not found');
    const name = V.str(body.name, 'name', { min: 1, max: 120 });
    const ein = body.ein ? String(body.ein).trim() : null;
    if (ein && !validEin(ein)) bad('EIN must look like 12-3456789');
    const state = body.state ? V.str(body.state, 'state', { min: 2, max: 2 }).toUpperCase() : org.state;
    const address = body.address && typeof body.address === 'object' ? { line1: String(body.address.line1 || '').slice(0, 120), line2: String(body.address.line2 || '').slice(0, 120), city: String(body.address.city || '').slice(0, 60), state: String(body.address.state || '').slice(0, 2).toUpperCase(), zip: String(body.address.zip || '').slice(0, 10) } : {};
    const stateIds = body.stateIds && typeof body.stateIds === 'object' ? Object.fromEntries(Object.entries(body.stateIds).slice(0, 60).map(([k, v]) => [String(k).slice(0, 2).toUpperCase(), String(v).slice(0, 40)])) : {};
    let bankEnc = body.id ? h.get('SELECT bank_enc FROM legal_entities WHERE id = ?', id).bank_enc : null;
    if (body.bank) bankEnc = vault.sealJson(validateCompanyBank(body.bank, bad));
    const isDefault = body.isDefault === true || !h.get('SELECT 1 FROM legal_entities WHERE org_id = ?', org.id) ? 1 : 0;
    h.tx(() => {
      if (isDefault) h.run('UPDATE legal_entities SET is_default = 0 WHERE org_id = ?', org.id);
      h.run(`INSERT INTO legal_entities (id,org_id,name,ein,state,address,bank_enc,state_ids,is_default) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, ein=excluded.ein, state=excluded.state, address=excluded.address, bank_enc=excluded.bank_enc, state_ids=excluded.state_ids, is_default=MAX(excluded.is_default, legal_entities.is_default)`,
        id, org.id, name, ein, state, JSON.stringify(address), bankEnc, JSON.stringify(stateIds), isDefault);
    });
    audit(org.id, me.id, 'entity_save', id, { name, ein: ein ? 'set' : null, bank: body.bank ? 'changed' : undefined });
    return { entity: entities(org.id).find((e) => e.id === id) };
  });

  route('POST', '/v1/cost-centers', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('cc');
    if (body.id && !owns('cost_centers', id, org.id)) throw new HttpError(404, 'cost center not found');
    const code = V.str(body.code, 'code', { min: 1, max: 30 }), name = V.str(body.name, 'name', { min: 1, max: 100 });
    if (h.get('SELECT 1 FROM cost_centers WHERE org_id = ? AND code = ? AND id != ?', org.id, code, id)) bad('that code is already used');
    const glSegment = V.str(body.glSegment, 'glSegment', { optional: true, max: 40 });
    h.run(`INSERT INTO cost_centers (id,org_id,code,name,gl_segment,active) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, gl_segment=excluded.gl_segment, active=excluded.active`,
      id, org.id, code, name, glSegment, body.active === false ? 0 : 1);
    audit(org.id, me.id, 'cost_center_save', id, { code, name });
    return { costCenter: ccs(org.id).find((x) => x.id === id) };
  });

  route('POST', '/v1/departments', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('dp');
    if (body.id && !owns('departments', id, org.id)) throw new HttpError(404, 'department not found');
    const name = V.str(body.name, 'name', { min: 1, max: 100 });
    const parentId = optRef('departments', body.parentId, 'parentId', org.id);
    // No cycles: walking up from the new parent must never reach this department.
    for (let p = parentId; p; p = h.get('SELECT parent_id FROM departments WHERE id = ?', p)?.parent_id) if (p === id) bad('a department can’t be inside itself');
    const costCenterId = optRef('cost_centers', body.costCenterId, 'costCenterId', org.id);
    const entityId = optRef('legal_entities', body.entityId, 'entityId', org.id);
    const headPersonId = body.headPersonId ? V.id(body.headPersonId, 'headPersonId') : null;
    if (headPersonId && !h.get('SELECT 1 FROM people WHERE id = ? AND org_id = ?', headPersonId, org.id)) bad('unknown headPersonId');
    // A department head approves "department head" steps: only the owner sets one.
    const prevHead = body.id ? h.get('SELECT head_person_id FROM departments WHERE id = ?', id)?.head_person_id ?? null : null;
    if (headPersonId !== prevHead) need(me, 'owner');
    h.run(`INSERT INTO departments (id,org_id,parent_id,name,code,cost_center_id,entity_id,head_person_id,location) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name, code=excluded.code, cost_center_id=excluded.cost_center_id, entity_id=excluded.entity_id, head_person_id=excluded.head_person_id, location=excluded.location`,
      id, org.id, parentId, name, V.str(body.code, 'code', { optional: true, max: 30 }), costCenterId, entityId, headPersonId, V.str(body.location, 'location', { optional: true, max: 120 }));
    audit(org.id, me.id, 'department_save', id, { name, parentId, ...(headPersonId !== prevHead ? { headFrom: prevHead, headTo: headPersonId } : {}) });
    return { department: depts(org.id).find((d) => d.id === id) };
  });
  route('POST', '/v1/departments/:id/delete', ({ me, org, params }) => {
    need(me, 'owner', 'payroll');
    if (!owns('departments', params.id, org.id)) throw new HttpError(404, 'department not found');
    if (h.get('SELECT 1 FROM departments WHERE parent_id = ?', params.id)) throw new HttpError(409, 'move or delete its sub-departments first');
    if (h.get('SELECT 1 FROM people WHERE department_id = ?', params.id)) throw new HttpError(409, 'people are still in this department');
    h.run('DELETE FROM departments WHERE id = ?', params.id);
    audit(org.id, me.id, 'department_delete', params.id, null);
    return { ok: true };
  });

  route('POST', '/v1/org/gl-accounts', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const gl = {};
    for (const k of Object.keys(DEFAULT_GL)) if (body[k] != null) gl[k] = V.str(body[k], k, { min: 1, max: 40 });
    c.saveOrgSettings(org, { glAccounts: { ...(org.settings.glAccounts || {}), ...gl } });
    audit(org.id, me.id, 'gl_accounts_save', org.id, gl);
    return { glAccounts: { ...DEFAULT_GL, ...(org.settings.glAccounts || {}), ...gl } };
  });

  // Who's where: department, entity, manager and default allocations for one person.
  // Managers decide "manager of" approval steps, so only the owner changes who manages whom (and nobody but the owner
  // changes their own job record).
  route('POST', '/v1/people/:id/job', ({ me, org, params, body }) => {
    need(me, 'owner', 'payroll');
    const p = c.getPerson(params.id, org.id);
    c.notSelf(me, p.id, 'your own department or manager');
    const departmentId = body.departmentId === undefined ? p.departmentId : optRef('departments', body.departmentId, 'departmentId', org.id);
    const entityId = body.entityId === undefined ? p.entityId : optRef('legal_entities', body.entityId, 'entityId', org.id);
    let managerId = p.managerId;
    if (body.managerId !== undefined) {
      managerId = body.managerId ? V.id(body.managerId, 'managerId') : null;
      if (managerId === p.id) bad('a person can’t manage themselves');
      if (managerId && !h.get('SELECT 1 FROM people WHERE id = ? AND org_id = ?', managerId, org.id)) bad('unknown managerId');
      if (managerId !== p.managerId) need(me, 'owner');
    }
    const defaultAllocations = body.defaultAllocations === undefined ? p.defaultAllocations : body.defaultAllocations?.length ? validateSplits(body.defaultAllocations, bad, { allowMinutes: false }) : [];
    for (const s of defaultAllocations) { if (s.departmentId) optRef('departments', s.departmentId, 'departmentId', org.id); if (s.costCenterId) optRef('cost_centers', s.costCenterId, 'costCenterId', org.id); }
    h.run('UPDATE people SET department_id = ?, entity_id = ?, manager_id = ?, default_allocations = ? WHERE id = ?', departmentId, entityId, managerId, JSON.stringify(defaultAllocations), p.id);
    audit(org.id, me.id, 'person_job', p.id, { departmentId, entityId, managerId, defaultAllocations });
    if (managerId !== p.managerId) audit(org.id, me.id, 'manager_change', p.id, { from: p.managerId, to: managerId });
    return { person: { id: p.id, departmentId, entityId, managerId, defaultAllocations } };
  });

  // Split one shift (by percentage, or by minutes for hour-level splits).
  route('GET', '/v1/shifts/:id/allocations', ({ me, org, params }) => {
    need(me, 'manager', 'payroll');
    const s = c.getShift(params.id, org.id);
    const own = J(h.get('SELECT splits FROM shift_allocations WHERE shift_id = ?', s.id)?.splits, null);
    const person = s.personId ? c.getPerson(s.personId, org.id) : null;
    const minutes = Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60000);
    return { shiftId: s.id, splits: own, effective: person ? allocationFor(h, person, s.id, minutes) : [] };
  });
  route('POST', '/v1/shifts/:id/allocations', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const s = c.getShift(params.id, org.id);
    if (body.splits == null || (Array.isArray(body.splits) && !body.splits.length)) { h.run('DELETE FROM shift_allocations WHERE shift_id = ?', s.id); audit(org.id, me.id, 'shift_allocation_clear', s.id, null); return { splits: null }; }
    const splits = validateSplits(body.splits, bad);
    const minutes = Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60000);
    if (splits[0].minutes != null && splits.reduce((a, x) => a + x.minutes, 0) > minutes) bad(`the minutes add up to more than the shift (${minutes} min)`);
    for (const x of splits) { if (x.departmentId) optRef('departments', x.departmentId, 'departmentId', org.id); if (x.costCenterId) optRef('cost_centers', x.costCenterId, 'costCenterId', org.id); }
    h.run('INSERT INTO shift_allocations (shift_id, splits) VALUES (?, ?) ON CONFLICT(shift_id) DO UPDATE SET splits = excluded.splits', s.id, JSON.stringify(splits));
    audit(org.id, me.id, 'shift_allocation_save', s.id, { splits });
    return { splits };
  });

  // ---------- budgets (versions, approvals) ----------
  const rowToBudget = (r) => ({ id: r.id, departmentId: r.department_id, costCenterId: r.cost_center_id, periodStart: r.period_start, periodEnd: r.period_end, amountCents: r.amount_cents, version: r.version, label: r.label, status: r.status, approvalId: r.approval_id, createdAt: r.created_at });
  route('GET', '/v1/budgets', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    return { budgets: h.all('SELECT * FROM budgets WHERE org_id = ? ORDER BY period_start DESC, department_id, version DESC', org.id).map(rowToBudget) };
  });
  route('POST', '/v1/budgets', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const departmentId = optRef('departments', body.departmentId, 'departmentId', org.id);
    const costCenterId = optRef('cost_centers', body.costCenterId, 'costCenterId', org.id);
    if (!departmentId && !costCenterId) bad('a budget is for a department or a cost center');
    const periodStart = V.date(body.periodStart, 'periodStart'), periodEnd = V.date(body.periodEnd, 'periodEnd');
    if (periodEnd < periodStart) bad('periodEnd is before periodStart');
    const amountCents = Math.round(Number(body.amountCents));
    if (!(amountCents >= 0)) bad('amountCents must be 0 or more');
    const prev = h.get(`SELECT MAX(version) AS v FROM budgets WHERE org_id = ? AND IFNULL(department_id,'') = IFNULL(?,'') AND IFNULL(cost_center_id,'') = IFNULL(?,'') AND period_start = ?`, org.id, departmentId, costCenterId, periodStart)?.v ?? 0;
    const id = uid('bu');
    h.run(`INSERT INTO budgets (id,org_id,department_id,cost_center_id,period_start,period_end,amount_cents,version,label,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      id, org.id, departmentId, costCenterId, periodStart, periodEnd, amountCents, prev + 1, V.str(body.label, 'label', { optional: true, max: 80 }) ?? (prev ? 'Revised' : 'Original'), me.id, iso(now()));
    const where = departmentId ? h.get('SELECT name FROM departments WHERE id = ?', departmentId).name : h.get('SELECT name FROM cost_centers WHERE id = ?', costCenterId).name;
    const ap = approvals.start({ orgId: org.id, kind: 'budget', targetId: id, requestedBy: me.id, title: `Budget v${prev + 1} for ${where}: $${(amountCents / 100).toFixed(2)}`, amountCents, departmentId, detail: { periodStart, periodEnd } });
    h.run('UPDATE budgets SET approval_id = ? WHERE id = ?', ap.id, id);
    audit(org.id, me.id, 'budget_submit', id, { amountCents, version: prev + 1 });
    return { status: 201, body: { budget: rowToBudget(h.get('SELECT * FROM budgets WHERE id = ?', id)), approval: ap } };
  });
  approvals.on('budget', {
    approved(a) {
      const b = h.get('SELECT * FROM budgets WHERE id = ?', a.targetId);
      h.run(`UPDATE budgets SET status = 'superseded' WHERE org_id = ? AND IFNULL(department_id,'') = IFNULL(?,'') AND IFNULL(cost_center_id,'') = IFNULL(?,'') AND period_start = ? AND status = 'approved'`, b.org_id, b.department_id, b.cost_center_id, b.period_start);
      h.run(`UPDATE budgets SET status = 'approved' WHERE id = ?`, b.id);
    },
    denied(a) { h.run(`UPDATE budgets SET status = 'denied' WHERE id = ?`, a.targetId); },
    cancelled(a) { h.run(`UPDATE budgets SET status = 'cancelled' WHERE id = ?`, a.targetId); },
  });
}

export const DEFAULT_GL = { wagesExpense: '6000', employerTaxExpense: '6100', reimbursementExpense: '6200', taxesPayable: '2100', netPayClearing: '2000' };

export function validateCompanyBank(b, bad) {
  const routing = String(b.originRouting || '').trim(), dest = String(b.destinationRouting || routing).trim();
  if (!/^\d{9}$/.test(routing) || !/^\d{9}$/.test(dest)) bad('routing numbers are 9 digits');
  const companyId = String(b.companyId || '').trim();
  if (!/^[0-9A-Za-z ]{1,10}$/.test(companyId)) bad('company ID is up to 10 letters or digits (often 1 + the EIN)');
  return { name: String(b.name || '').slice(0, 23), companyId, originRouting: routing, destinationRouting: dest, destinationName: String(b.destinationName || '').slice(0, 23), account: b.account ? String(b.account).slice(0, 17) : undefined, api: b.api && typeof b.api === 'object' ? { provider: String(b.api.provider || '').slice(0, 30), keySet: !!b.api.key, key: b.api.key ? String(b.api.key).slice(0, 300) : undefined } : undefined };
}
