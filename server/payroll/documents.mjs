// Employee documents: a per-person file cabinet (files sealed in the vault), e-signing, retention rules with legal holds,
// and expenses (receipts, mileage, approval, reimbursement through payroll).
import { createHash } from 'node:crypto';
import { addDays } from '../lib/time.mjs';

const MAX_FILE = 8 * 1024 * 1024;
export const DOC_CATEGORIES = ['offer', 'tax_form', 'i9', 'policy', 'receipt', 'review', 'medical', 'contract', 'certification', 'other'];
const yearsAfter = (date, years) => { if (!date || years == null) return null; const d = new Date(date + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Math.round(years * 12)); return d.toISOString().slice(0, 10); };

export function registerDocuments(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, approvals, now, iso, today } = c;
  const rules = (orgId) => h.all('SELECT * FROM retention_rules WHERE org_id = ? ORDER BY category', orgId).map((r) => ({ id: r.id, category: r.category, yearsAfterCreated: r.years_after_created, yearsAfterTermination: r.years_after_termination, note: r.note }));
  /** Keep-until date: the later of "years after the document" and "years after the person left" (null = keep). */
  function retainUntil(d, orgId) {
    const r = h.get('SELECT * FROM retention_rules WHERE org_id = ? AND category = ?', orgId, d.category);
    if (d.retain_until) return d.retain_until;
    if (!r) return null;
    const term = d.person_id ? h.get('SELECT term_date, status FROM people WHERE id = ?', d.person_id) : null;
    const a = yearsAfter(d.created_at.slice(0, 10), r.years_after_created);
    if (r.years_after_termination != null && !(term?.status === 'terminated' && term.term_date)) return null; // still employed: keep
    const b = term?.term_date ? yearsAfter(term.term_date, r.years_after_termination) : null;
    return [a, b].filter(Boolean).sort().at(-1) ?? null;
  }
  const out = (d, orgId) => ({ id: d.id, personId: d.person_id, category: d.category, title: d.title, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, uploadedBy: d.uploaded_by, createdAt: d.created_at, retainUntil: retainUntil(d, orgId), legalHold: !!d.legal_hold, needsSignature: !!d.needs_signature, signature: c.sigOut(d.signature_id) });
  c.signedContent.set('document', (id) => { const d = h.get('SELECT sha256, title FROM documents WHERE id = ?', id); return d ? { sha256: d.sha256, title: d.title } : null; });

  /** Store a file (base64) in the vault; returns the document id. */
  function store(org, me, { personId = null, category, title, filename, mime, contentBase64, needsSignature = false }) {
    if (typeof contentBase64 !== 'string' || !contentBase64) bad('contentBase64 is required');
    const buf = Buffer.from(contentBase64, 'base64');
    if (!buf.length) bad('the file is empty');
    if (buf.length > MAX_FILE) bad('files can be up to 8 MB');
    const id = uid('doc');
    h.run(`INSERT INTO documents (id,org_id,person_id,category,title,filename,mime,size,sha256,content_enc,uploaded_by,created_at,needs_signature) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, org.id, personId, V.enum(category, 'category', DOC_CATEGORIES), V.str(title, 'title', { min: 1, max: 160 }), V.str(filename, 'filename', { min: 1, max: 200 }).replace(/[\\/:*?"<>|]/g, '_'),
      /^[\w.+-]+\/[\w.+-]+$/.test(mime || '') ? mime : 'application/octet-stream', buf.length, createHash('sha256').update(buf).digest('hex'), vault.sealJson(buf.toString('base64')), me.id, iso(now()), needsSignature ? 1 : 0);
    audit(org.id, me.id, 'document_upload', id, { personId, category, size: buf.length });
    return id;
  }
  c.storeDocument = store;
  // Lists and checks read every column but the (sealed) file itself, so a list never opens every file.
  const META = 'id, org_id, person_id, category, title, filename, mime, size, sha256, uploaded_by, created_at, retain_until, legal_hold, signature_id, needs_signature';
  const getDoc = (id, orgId, { content = false } = {}) => { const d = h.get(`SELECT ${content ? '*' : META} FROM documents WHERE id = ? AND org_id = ?`, id, orgId); if (!d) throw new HttpError(404, 'document not found'); return d; };

  route('GET', '/v1/documents', ({ me, org, query }) => {
    const personId = query.personId || null;
    if (personId !== me.id) need(me, 'payroll');
    const rows = personId ? h.all(`SELECT ${META} FROM documents WHERE org_id = ? AND person_id = ? ORDER BY created_at DESC`, org.id, personId) : h.all(`SELECT ${META} FROM documents WHERE org_id = ? ORDER BY created_at DESC LIMIT 1000`, org.id);
    return { documents: rows.map((d) => out(d, org.id)), categories: DOC_CATEGORIES };
  });
  route('POST', '/v1/documents', ({ me, org, body }) => {
    const personId = body.personId ? V.id(body.personId, 'personId') : null;
    if (personId !== me.id) need(me, 'payroll');
    if (personId) c.getPerson(personId, org.id);
    const id = store(org, me, { ...body, personId });
    return { status: 201, body: { document: out(getDoc(id, org.id), org.id) } };
  }, { maxBody: 12 * 1024 * 1024 });
  route('GET', '/v1/documents/:id/download', ({ me, org, params }) => {
    const d = getDoc(params.id, org.id, { content: true });
    if (d.person_id !== me.id) need(me, 'payroll');
    audit(org.id, me.id, 'document_download', d.id, null);
    return { raw: { type: d.mime, filename: d.filename, body: Buffer.from(vault.openJson(d.content_enc), 'base64') } };
  });
  route('POST', '/v1/documents/:id/sign', ({ me, org, params, body }) => {
    const d = getDoc(params.id, org.id);
    if (!d.person_id) bad('only a person’s document can be signed');
    if (d.person_id !== me.id) need(me, 'payroll');
    if (d.signature_id) throw new HttpError(409, 'already signed');
    const p = c.getPerson(d.person_id, org.id);
    const sig = c.esign({ org, person: p, docKind: 'document', docId: d.id, content: { sha256: d.sha256, title: d.title }, typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
    h.run('UPDATE documents SET signature_id = ?, needs_signature = 0 WHERE id = ?', sig.id, d.id);
    return { document: out(getDoc(d.id, org.id), org.id) };
  });
  route('POST', '/v1/documents/:id/hold', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const d = getDoc(params.id, org.id);
    h.run('UPDATE documents SET legal_hold = ? WHERE id = ?', body.hold === false ? 0 : 1, d.id);
    audit(org.id, me.id, body.hold === false ? 'document_hold_release' : 'document_hold', d.id, { reason: body.reason ?? null });
    return { document: out(getDoc(d.id, org.id), org.id) };
  });
  route('GET', '/v1/documents/purge-due', ({ me, org }) => {
    need(me, 'payroll');
    const t = today(org);
    return { documents: h.all(`SELECT ${META} FROM documents WHERE org_id = ? AND legal_hold = 0`, org.id).map((d) => out(d, org.id)).filter((d) => d.retainUntil && d.retainUntil < t) };
  });
  route('POST', '/v1/documents/purge', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const t = today(org);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 1000) : [];
    let n = 0;
    for (const id of ids) {
      const d = h.get(`SELECT ${META} FROM documents WHERE id = ? AND org_id = ?`, id, org.id);
      const until = d && retainUntil(d, org.id);
      if (!d || d.legal_hold || !until || until >= t) continue;
      h.run('DELETE FROM documents WHERE id = ?', id);
      audit(org.id, me.id, 'document_purge', id, { category: d.category, personId: d.person_id, retainUntil: until });
      n++;
    }
    return { purged: n };
  });

  route('GET', '/v1/retention-rules', ({ me, org }) => { need(me, 'payroll'); return { rules: rules(org.id), tableDefaults: c.rulesFor(org).retention || [] }; });
  route('POST', '/v1/retention-rules', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const category = V.enum(body.category, 'category', DOC_CATEGORIES);
    const n = (v, name) => (v == null || v === '' ? null : Number(v) >= 0 && Number(v) <= 100 ? Number(v) : bad(`${name} must be 0-100 years`));
    const a = n(body.yearsAfterCreated, 'yearsAfterCreated'), b = n(body.yearsAfterTermination, 'yearsAfterTermination');
    const id = h.get('SELECT id FROM retention_rules WHERE org_id = ? AND category = ?', org.id, category)?.id ?? uid('rr');
    if (a == null && b == null) h.run('DELETE FROM retention_rules WHERE id = ?', id);
    else h.run(`INSERT INTO retention_rules (id,org_id,category,years_after_created,years_after_termination,note) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET years_after_created = excluded.years_after_created, years_after_termination = excluded.years_after_termination, note = excluded.note`, id, org.id, category, a, b, V.str(body.note, 'note', { optional: true, max: 300 }));
    audit(org.id, me.id, 'retention_rule', category, { a, b });
    return { rules: rules(org.id) };
  });
  route('POST', '/v1/retention-rules/defaults', ({ me, org }) => {
    need(me, 'owner', 'payroll');
    for (const r of c.rulesFor(org).retention || []) {
      if (!DOC_CATEGORIES.includes(r.category) || h.get('SELECT 1 FROM retention_rules WHERE org_id = ? AND category = ?', org.id, r.category)) continue;
      h.run('INSERT INTO retention_rules (id,org_id,category,years_after_created,years_after_termination,note) VALUES (?,?,?,?,?,?)', uid('rr'), org.id, r.category, r.yearsAfterCreated ?? null, r.yearsAfterTermination ?? null, r.note ?? null);
    }
    return { rules: rules(org.id) };
  });

  // ---------- expenses ----------
  const rowToExp = (r) => ({ id: r.id, personId: r.person_id, date: r.date, kind: r.kind, category: r.category, description: r.description, amountCents: r.amount_cents, miles: r.miles, rateCentsPerMile: r.rate_cents_per_mile, receiptId: r.receipt_id, status: r.status, approvalId: r.approval_id, earningId: r.earning_id, createdAt: r.created_at });
  const getExp = (id, orgId) => { const r = h.get('SELECT * FROM expenses WHERE id = ? AND org_id = ?', id, orgId); if (!r) throw new HttpError(404, 'expense not found'); return r; };
  route('GET', '/v1/expenses', ({ me, org, query }) => {
    let rows = h.all('SELECT * FROM expenses WHERE org_id = ? ORDER BY date DESC, created_at DESC LIMIT 1000', org.id).map(rowToExp);
    if (!c.has(me, 'manager', 'payroll')) rows = rows.filter((r) => r.personId === me.id);
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    const nm = new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', org.id).map((r) => [r.id, r.name]));
    return { expenses: rows.map((r) => ({ ...r, personName: nm.get(r.personId) })), mileageRateCents: org.settings.mileageRateCents ?? null, categories: org.settings.expenseCategories || ['Mileage', 'Meals', 'Supplies', 'Travel', 'Training', 'Other'] };
  });
  route('POST', '/v1/expenses', ({ me, org, body }) => {
    const personId = body.personId ? V.id(body.personId, 'personId') : me.id;
    if (personId !== me.id) need(me, 'payroll');
    const p = c.getPerson(personId, org.id);
    const kind = V.enum(body.kind ?? 'receipt', 'kind', ['receipt', 'mileage']);
    let amount, miles = null, rate = null;
    if (kind === 'mileage') {
      rate = org.settings.mileageRateCents;
      if (!(rate > 0)) bad('set the mileage rate in the expense settings first');
      miles = Number(body.miles);
      if (!(miles > 0 && miles < 100000)) bad('miles must be more than 0');
      amount = Math.round(miles * rate);
    } else {
      amount = Math.round(Number(body.amountCents));
      if (!(amount > 0 && amount < 1e8)) bad('amountCents must be more than 0');
    }
    const id = uid('ex');
    h.tx(() => {
      const receiptId = body.receipt ? store(org, me, { personId: p.id, category: 'receipt', title: `Receipt ${V.date(body.date, 'date')}`, filename: body.receipt.filename || 'receipt', mime: body.receipt.mime, contentBase64: body.receipt.contentBase64 }) : null;
      h.run(`INSERT INTO expenses (id,org_id,person_id,date,kind,category,description,amount_cents,miles,rate_cents_per_mile,receipt_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
        id, org.id, p.id, V.date(body.date, 'date'), kind, V.str(body.category ?? (kind === 'mileage' ? 'Mileage' : 'Other'), 'category', { min: 1, max: 60 }), V.str(body.description, 'description', { optional: true, max: 500 }), amount, miles, rate, receiptId, iso(now()));
    });
    audit(org.id, me.id, 'expense_create', id, { personId: p.id, amount });
    return { status: 201, body: { expense: rowToExp(getExp(id, org.id)) } };
  }, { maxBody: 12 * 1024 * 1024 });
  route('POST', '/v1/expenses/:id/submit', ({ me, org, params }) => {
    const e = getExp(params.id, org.id);
    if (e.person_id !== me.id) need(me, 'payroll');
    if (e.status !== 'draft') throw new HttpError(409, `expense is ${e.status}`);
    if (e.kind === 'receipt' && !e.receipt_id && e.amount_cents >= (org.settings.receiptRequiredCents ?? 7500)) throw new HttpError(409, 'attach a receipt for this amount');
    const p = c.getPerson(e.person_id, org.id);
    const ap = approvals.start({ orgId: org.id, kind: 'expense', targetId: e.id, requestedBy: me.id, subjectPersonId: p.id, departmentId: p.departmentId, amountCents: e.amount_cents, title: `${p.name}: ${e.category} $${(e.amount_cents / 100).toFixed(2)} (${e.date})` });
    h.run(`UPDATE expenses SET status = 'submitted', approval_id = ? WHERE id = ?`, ap.id, e.id);
    return { expense: rowToExp(getExp(e.id, org.id)), approval: ap };
  });
  route('POST', '/v1/expenses/:id/delete', ({ me, org, params }) => {
    const e = getExp(params.id, org.id);
    if (e.person_id !== me.id) need(me, 'payroll');
    if (e.status !== 'draft') throw new HttpError(409, 'only drafts can be deleted');
    h.run('DELETE FROM expenses WHERE id = ?', e.id);
    return { ok: true };
  });
  approvals.on('expense', {
    approved(a) {
      const e = h.get('SELECT * FROM expenses WHERE id = ?', a.targetId);
      const eid = uid('ee');
      h.run(`INSERT INTO extra_earnings (id,org_id,person_id,code,label,cents,taxable,source,status,created_at) VALUES (?,?,?,?,?,?,0,?,'pending',?)`, eid, e.org_id, e.person_id, 'reimbursement', `Reimbursement: ${e.category} (${e.date})`, e.amount_cents, `expense:${e.id}`, iso(now()));
      h.run(`UPDATE expenses SET status = 'approved', earning_id = ? WHERE id = ?`, eid, e.id);
    },
    denied: (a) => h.run(`UPDATE expenses SET status = 'denied' WHERE id = ?`, a.targetId),
    cancelled: (a) => h.run(`UPDATE expenses SET status = 'draft', approval_id = NULL WHERE id = ?`, a.targetId),
  });
}
