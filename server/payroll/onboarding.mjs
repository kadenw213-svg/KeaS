// Onboarding and offboarding: offer letters, e-signed W-4 and state withholding forms, the I-9 checklist (the document
// check stays human), policy acknowledgments, direct-deposit setup, the new-hire report, and the offboarding checklist
// with the final-pay deadline (from the labor tables), PTO payout, COBRA reminder, equipment return and access removal.
// E-signatures are a typed name + consent + timestamp + SHA-256 of the signed content.
import { sha256, canonical } from '../lib/vault.mjs';
import { addDays, weekday } from '../lib/time.mjs';
import { toCsv } from '../lib/csv.mjs';
import { simplePdf } from '../lib/pdf.mjs';
import { validateW4, cleanAddress, validSsn, rateFor } from './paystructure.mjs';
import { policiesFor, balance } from './leave.mjs';

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const addBusinessDays = (d, n) => { let x = d; while (n > 0) { x = addDays(x, 1); if (weekday(x) !== 0 && weekday(x) !== 6) n--; } return x; };

export function registerOnboarding(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, vault, approvals, now, iso, today } = c;
  const signedContent = new Map(); // doc_kind -> (docId) => content that was signed
  c.signedContent = signedContent;

  /** Record an e-signature; the typed name must match the person's legal name (or name). */
  function esign({ org, person, docKind, docId, content, typedName, consent, signer = person, witnessedBy = null, method = 'in_person' }) {
    if (consent !== true) bad('tick the box agreeing to sign electronically');
    const expect = signer.legalName || signer.name;
    if (norm(typedName) !== norm(expect)) bad(`type the name exactly as “${expect}” to sign`);
    const signedAt = iso(now());
    const hash = sha256(canonical({ docKind, docId, content, typedName: String(typedName).trim(), signedAt, personId: signer.id }));
    const id = uid('sig');
    h.run('INSERT INTO signatures (id,org_id,person_id,doc_kind,doc_id,typed_name,signed_at,content_hash,witnessed_by,method) VALUES (?,?,?,?,?,?,?,?,?,?)', id, org.id, signer.id, docKind, docId, String(typedName).trim(), signedAt, hash, witnessedBy, method);
    audit(org.id, witnessedBy || signer.id, 'esign', id, { docKind, docId, personId: signer.id });
    return { id, signedAt, hash };
  }
  c.esign = esign;
  const sigOut = (id) => { const s = id && h.get('SELECT * FROM signatures WHERE id = ?', id); return s ? { id: s.id, typedName: s.typed_name, signedAt: s.signed_at, hash: s.content_hash, method: s.method, witnessedBy: s.witnessed_by } : null; };
  c.sigOut = sigOut;

  route('GET', '/v1/signatures/:id/verify', ({ me, org, params }) => {
    need(me, 'payroll');
    const s = h.get('SELECT * FROM signatures WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!s) throw new HttpError(404, 'signature not found');
    const get = signedContent.get(s.doc_kind);
    if (!get) return { signature: sigOut(s.id), checked: false, reason: 'no content check for this kind of document' };
    const content = get(s.doc_id);
    const hash = sha256(canonical({ docKind: s.doc_kind, docId: s.doc_id, content, typedName: s.typed_name, signedAt: s.signed_at, personId: s.person_id }));
    return { signature: sigOut(s.id), checked: true, valid: hash === s.content_hash };
  });

  // ---------- tasks ----------
  const TASKS = { offer: 'Offer letter signed', w4: 'Federal W-4', state_w4: 'State withholding form', i9_section1: 'I-9 Section 1 (employee)', i9_section2: 'I-9 Section 2 (document check)', deposit: 'Direct deposit', policies: 'Policy acknowledgments', new_hire_report: 'New-hire report filed' };
  const rowToTask = (t) => ({ id: t.id, personId: t.person_id, kind: t.kind, title: t.title, due: t.due, status: t.status, doneBy: t.done_by, doneAt: t.done_at, ref: t.ref });
  c.markTask = (personId, kind, by = 'system', ref = null) => h.run(`UPDATE onboarding_tasks SET status = 'done', done_by = ?, done_at = ?, ref = COALESCE(?, ref) WHERE person_id = ? AND kind = ? AND status = 'open'`, by, iso(now()), ref, personId, kind);
  const stateForm = (org) => c.tablesFor(org.state, Number(today(org).slice(0, 4))).state?.withholdingForm ?? null;

  route('POST', '/v1/onboarding/start', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const startDate = V.date(body.startDate ?? p.hireDate ?? today(org), 'startDate');
    if (h.get(`SELECT 1 FROM onboarding_tasks WHERE person_id = ? AND status = 'open'`, p.id)) throw new HttpError(409, 'onboarding is already under way');
    const rules = c.rulesFor(org);
    const nhDays = rules.newHire?.reportDays ?? null;
    const list = [
      h.get('SELECT 1 FROM offers WHERE person_id = ?', p.id) && ['offer', startDate],
      ['w4', startDate],
      stateForm(org) && ['state_w4', startDate],
      ['i9_section1', startDate],
      ['i9_section2', addBusinessDays(startDate, 3)],
      ['deposit', startDate],
      h.get('SELECT 1 FROM policies WHERE org_id = ? AND required = 1', org.id) && ['policies', startDate],
      ['new_hire_report', nhDays != null ? addDays(startDate, nhDays) : null],
    ].filter(Boolean);
    for (const t of Array.isArray(body.extraTasks) ? body.extraTasks.slice(0, 20) : []) list.push(['custom', V.date(t.due, 'due', { optional: true }), V.str(t.title, 'task title', { min: 1, max: 120 })]);
    h.tx(() => {
      for (const [kind, due, title] of list) h.run('INSERT INTO onboarding_tasks (id,org_id,person_id,kind,title,due,status) VALUES (?,?,?,?,?,?,?)', uid('tk'), org.id, p.id, kind, title || (kind === 'state_w4' ? `State withholding form (${stateForm(org)})` : TASKS[kind]), due, 'open');
      h.run(`UPDATE people SET hire_date = COALESCE(hire_date, ?), status = CASE WHEN status IN ('applicant') THEN 'onboarding' ELSE status END WHERE id = ?`, startDate, p.id);
      for (const pol of h.all('SELECT id FROM pto_policies WHERE org_id = ? AND auto_enroll = 1 AND active = 1', org.id)) h.run('INSERT OR IGNORE INTO pto_enrollments (person_id, policy_id, start_date) VALUES (?,?,?)', p.id, pol.id, startDate);
      // Things already done before onboarding started count.
      if (h.get(`SELECT 1 FROM offers WHERE person_id = ? AND status = 'accepted'`, p.id)) c.markTask(p.id, 'offer');
      if (vault.openJson(h.get('SELECT deposit FROM people WHERE id = ?', p.id).deposit)) c.markTask(p.id, 'deposit');
    });
    audit(org.id, me.id, 'onboarding_start', p.id, { startDate });
    return { status: 201, body: onboardingOf(org, p.id) };
  });

  function onboardingOf(org, personId) {
    const p = c.getPerson(personId, org.id);
    const tasks = h.all('SELECT * FROM onboarding_tasks WHERE person_id = ? ORDER BY due IS NULL, due, title', p.id).map(rowToTask);
    const i9 = h.get('SELECT * FROM i9_records WHERE person_id = ?', p.id);
    const policies = h.all('SELECT * FROM policies WHERE org_id = ? AND required = 1 ORDER BY title', org.id).map((x) => ({ id: x.id, title: x.title, version: x.version, acknowledged: !!h.get('SELECT 1 FROM policy_acks WHERE policy_id = ? AND version = ? AND person_id = ?', x.id, x.version, p.id) }));
    const forms = h.all('SELECT id, kind, signature_id, created_at, superseded_at FROM form_submissions WHERE person_id = ? ORDER BY created_at DESC', p.id).map((f) => ({ id: f.id, kind: f.kind, signature: sigOut(f.signature_id), createdAt: f.created_at, current: !f.superseded_at }));
    const offers = h.all('SELECT * FROM offers WHERE person_id = ? ORDER BY created_at DESC', p.id).map(rowToOffer);
    return { person: { id: p.id, name: p.name, legalName: p.legalName, status: p.status, hireDate: p.hireDate }, tasks, i9: i9 ? i9Out(i9) : null, policies, forms, offers, stateForm: stateForm(org), done: tasks.length > 0 && tasks.every((t) => t.status === 'done') };
  }
  route('GET', '/v1/onboarding', ({ me, org }) => {
    need(me, 'payroll');
    const ids = h.all(`SELECT DISTINCT person_id FROM onboarding_tasks WHERE org_id = ? AND person_id IN (SELECT person_id FROM onboarding_tasks WHERE status = 'open')`, org.id).map((r) => r.person_id);
    const t = today(org);
    return { people: ids.map((id) => { const o = onboardingOf(org, id); return { ...o.person, total: o.tasks.length, done: o.tasks.filter((x) => x.status === 'done').length, overdue: o.tasks.filter((x) => x.status === 'open' && x.due && x.due < t).length }; }) };
  });
  route('GET', '/v1/onboarding/:personId', ({ me, org, params }) => { if (params.personId !== me.id) need(me, 'payroll'); return onboardingOf(org, params.personId); });
  route('POST', '/v1/onboarding/tasks/:id/done', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const t = h.get('SELECT * FROM onboarding_tasks WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!t) throw new HttpError(404, 'task not found');
    const done = body.done !== false;
    h.run('UPDATE onboarding_tasks SET status = ?, done_by = ?, done_at = ? WHERE id = ?', done ? 'done' : 'open', done ? me.id : null, done ? iso(now()) : null, t.id);
    audit(org.id, me.id, done ? 'task_done' : 'task_reopen', t.id, { kind: t.kind, personId: t.person_id });
    return onboardingOf(org, t.person_id);
  });
  route('POST', '/v1/onboarding/:personId/complete', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const o = onboardingOf(org, params.personId);
    const open = o.tasks.filter((t) => t.status === 'open' && t.kind !== 'new_hire_report');
    if (open.length && !(body.force === true && String(body.reason || '').trim().length >= 3)) throw new HttpError(409, `Still open: ${open.map((t) => t.title).join(', ')}`, { open });
    h.run(`UPDATE people SET status = 'active' WHERE id = ?`, params.personId);
    audit(org.id, me.id, 'onboarding_complete', params.personId, { forced: !!open.length, reason: body.reason ?? null });
    return onboardingOf(org, params.personId);
  });

  // ---------- offers ----------
  const rowToOffer = (r) => ({ id: r.id, personId: r.person_id, title: r.title, positionId: r.position_id, kind: r.kind, rateCents: r.rate_cents, startDate: r.start_date, body: r.body, status: r.status, signature: sigOut(r.signature_id), approvalId: r.approval_id, createdAt: r.created_at });
  const DEFAULT_OFFER = 'Dear {{name}},\n\n{{org}} is pleased to offer you the position of {{title}}, starting {{startDate}}, at {{rate}}.\n\nThis offer depends on completing the hiring paperwork, including the Form I-9.\n\nTo accept, sign below.';
  const fill = (tpl, v) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
  const offerContent = (o) => ({ title: o.title, positionId: o.position_id, kind: o.kind, rateCents: o.rate_cents, startDate: o.start_date, body: o.body });
  signedContent.set('offer', (id) => offerContent(h.get('SELECT * FROM offers WHERE id = ?', id)));
  route('GET', '/v1/offers', ({ me, org }) => { need(me, 'payroll'); return { offers: h.all('SELECT * FROM offers WHERE org_id = ? ORDER BY created_at DESC', org.id).map(rowToOffer), template: org.settings.offerTemplate || DEFAULT_OFFER }; });
  route('POST', '/v1/offers', ({ me, org, body }) => {
    need(me, 'payroll');
    let p = body.personId ? c.getPerson(V.id(body.personId, 'personId'), org.id) : null;
    if (!p) p = c.createPerson(org, me, { name: V.str(body.name, 'name', { min: 1, max: 120 }), email: body.email ?? null, status: 'applicant' });
    const kind = V.enum(body.kind ?? 'hourly', 'kind', ['hourly', 'salary']);
    const rateCents = Math.round(Number(body.rateCents));
    if (!(rateCents > 0)) bad('rateCents must be more than 0');
    const startDate = V.date(body.startDate, 'startDate');
    const title = V.str(body.title, 'title', { min: 1, max: 120 });
    const positionId = body.positionId ? V.id(body.positionId, 'positionId') : null;
    const rate = kind === 'salary' ? `$${(rateCents / 100).toLocaleString('en-US')} a year` : `$${(rateCents / 100).toFixed(2)} an hour`;
    const text = fill(V.str(body.body, 'body', { optional: true, max: 20000 }) || org.settings.offerTemplate || DEFAULT_OFFER, { name: p.name, org: org.name, title, startDate, rate });
    const id = uid('of');
    h.run(`INSERT INTO offers (id,org_id,person_id,title,position_id,kind,rate_cents,start_date,body,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)`, id, org.id, p.id, title, positionId, kind, rateCents, startDate, text, me.id, iso(now()));
    audit(org.id, me.id, 'offer_create', id, { personId: p.id });
    return { status: 201, body: { offer: rowToOffer(h.get('SELECT * FROM offers WHERE id = ?', id)) } };
  });
  route('POST', '/v1/offers/:id/send', ({ me, org, params }) => {
    need(me, 'payroll');
    const o = h.get('SELECT * FROM offers WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!o) throw new HttpError(404, 'offer not found');
    if (o.status !== 'draft') throw new HttpError(409, `offer is ${o.status}`);
    if (approvals.configured(org.id, 'offer')) {
      const p = c.getPerson(o.person_id, org.id);
      const ap = approvals.start({ orgId: org.id, kind: 'offer', targetId: o.id, requestedBy: me.id, subjectPersonId: o.person_id, amountCents: o.rate_cents, title: `Offer for ${p.name}: ${o.title}` });
      h.run(`UPDATE offers SET status = 'pending_approval', approval_id = ? WHERE id = ?`, ap.id, o.id);
    } else h.run(`UPDATE offers SET status = 'sent' WHERE id = ?`, o.id);
    audit(org.id, me.id, 'offer_send', o.id, null);
    return { offer: rowToOffer(h.get('SELECT * FROM offers WHERE id = ?', o.id)) };
  });
  approvals.on('offer', {
    approved: (a) => h.run(`UPDATE offers SET status = 'sent' WHERE id = ?`, a.targetId),
    denied: (a) => h.run(`UPDATE offers SET status = 'draft' WHERE id = ?`, a.targetId),
    cancelled: (a) => h.run(`UPDATE offers SET status = 'draft' WHERE id = ?`, a.targetId),
  });
  route('POST', '/v1/offers/:id/sign', ({ me, org, params, body }) => {
    const o = h.get('SELECT * FROM offers WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!o) throw new HttpError(404, 'offer not found');
    if (o.person_id !== me.id) need(me, 'payroll');
    if (o.status !== 'sent') throw new HttpError(409, `offer is ${o.status}`);
    const p = c.getPerson(o.person_id, org.id);
    if (body.decline === true) { h.run(`UPDATE offers SET status = 'declined' WHERE id = ?`, o.id); audit(org.id, me.id, 'offer_decline', o.id, null); return { offer: rowToOffer(h.get('SELECT * FROM offers WHERE id = ?', o.id)) }; }
    h.tx(() => {
      const sig = esign({ org, person: p, docKind: 'offer', docId: o.id, content: offerContent(o), typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
      h.run(`UPDATE offers SET status = 'accepted', signature_id = ? WHERE id = ?`, sig.id, o.id);
      h.run(`UPDATE people SET hire_date = COALESCE(hire_date, ?), status = CASE WHEN status = 'applicant' THEN 'onboarding' ELSE status END, positions = CASE WHEN ? IS NULL OR positions LIKE ? THEN positions ELSE json_insert(positions, '$[#]', ?) END WHERE id = ?`, o.start_date, o.position_id, `%"${o.position_id}"%`, o.position_id, p.id);
      if (!h.get('SELECT 1 FROM pay_rates WHERE person_id = ? AND position_id IS ?', p.id, o.position_id)) {
        h.run('INSERT INTO pay_rates (id,person_id,position_id,kind,rate_cents,effective_from,label,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid('rt'), p.id, o.kind === 'salary' ? null : o.position_id, o.kind, o.rate_cents, o.start_date, 'Offer', me.id, iso(now()));
        if (o.kind === 'hourly' && !h.get('SELECT pay_rate_cents FROM people WHERE id = ?', p.id).pay_rate_cents) h.run('UPDATE people SET pay_rate_cents = ? WHERE id = ?', o.rate_cents, p.id);
      }
      c.markTask(p.id, 'offer', me.id, o.id);
    });
    return { offer: rowToOffer(h.get('SELECT * FROM offers WHERE id = ?', o.id)) };
  });
  route('GET', '/v1/offers/:id/pdf', ({ me, org, params }) => {
    const o = h.get('SELECT * FROM offers WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!o) throw new HttpError(404, 'offer not found');
    if (o.person_id !== me.id) need(me, 'payroll');
    const s = sigOut(o.signature_id);
    const lines = [{ text: org.name, size: 16, bold: true }, { text: o.title, size: 12, gap: 6 }, ...o.body.split('\n').map((t) => ({ text: t }))];
    if (s) lines.push({ text: `Signed electronically by ${s.typedName} at ${s.signedAt}`, gap: 12, bold: true }, { text: `SHA-256 ${s.hash}`, size: 7, mono: true });
    return { raw: { type: 'application/pdf', filename: `offer-${o.id}.pdf`, body: simplePdf({ title: `Offer - ${o.title}`, lines }) } };
  });

  // ---------- withholding forms (W-4 and the state form) ----------
  signedContent.set('form', (id) => vault.openJson(h.get('SELECT data_enc FROM form_submissions WHERE id = ?', id)?.data_enc));
  function submitForm(org, me, p, kind, data, body) {
    const id = uid('fm');
    h.tx(() => {
      const sig = esign({ org, person: p, docKind: 'form', docId: id, content: data, typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
      h.run(`UPDATE form_submissions SET superseded_at = ? WHERE person_id = ? AND kind = ? AND superseded_at IS NULL`, iso(now()), p.id, kind);
      h.run('INSERT INTO form_submissions (id,org_id,person_id,kind,data_enc,signature_id,created_at) VALUES (?,?,?,?,?,?,?)', id, org.id, p.id, kind, vault.sealJson(data), sig.id, iso(now()));
    });
    return id;
  }
  route('POST', '/v1/forms/w4', ({ me, org, body }) => {
    const personId = V.id(body.personId ?? me.id, 'personId');
    if (personId !== me.id) need(me, 'payroll');
    const p = c.getPerson(personId, org.id);
    const d = body.data || {};
    const w4 = validateW4(d, bad);
    if (d.ssn != null && d.ssn !== '' && !validSsn(d.ssn)) bad('that SSN isn’t valid');
    const data = { ...w4, legalName: d.legalName ? String(d.legalName).slice(0, 120) : p.legalName || p.name, address: d.address ? cleanAddress(d.address) : null, ssn: d.ssn ? String(d.ssn).replace(/\D/g, '') : null, year: Number(today(org).slice(0, 4)) };
    const id = submitForm(org, me, p, 'w4', data, body);
    const sets = c.applyProfile(p, { w4, legalName: data.legalName, pii: { ...(data.ssn ? { ssn: data.ssn } : {}), ...(data.address ? { address: data.address } : {}) } }, me, org);
    c.writePersonSets(p.id, sets);
    c.markTask(p.id, 'w4', me.id, id);
    audit(org.id, me.id, 'form_w4', p.id, { id });
    return { status: 201, body: { id } };
  });
  route('POST', '/v1/forms/state', ({ me, org, body }) => {
    const personId = V.id(body.personId ?? me.id, 'personId');
    if (personId !== me.id) need(me, 'payroll');
    const p = c.getPerson(personId, org.id);
    const form = stateForm(org);
    if (!form) bad(`there’s no state withholding form for ${org.state} in the tax tables`);
    const d = body.data || {};
    const allowance = d.annualAllowance == null || d.annualAllowance === '' ? null : Number(d.annualAllowance);
    if (allowance != null && !(allowance >= 0 && allowance < 1e7)) bad('annualAllowance must be a dollar amount');
    const data = { form, state: org.state, annualAllowance: allowance, extraWithholding: Number(d.extraWithholding) || 0, exempt: !!d.exempt };
    const id = submitForm(org, me, p, 'state_w4', data, body);
    if (org.state === 'CO' || c.tablesFor(org.state, Number(today(org).slice(0, 4))).state?.incomeTax?.annualAllowance) h.run('UPDATE people SET co_allowance = ? WHERE id = ?', allowance, p.id);
    c.markTask(p.id, 'state_w4', me.id, id);
    audit(org.id, me.id, 'form_state', p.id, { id, form });
    return { status: 201, body: { id } };
  });
  route('GET', '/v1/forms/:id', ({ me, org, params }) => {
    const f = h.get('SELECT * FROM form_submissions WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!f) throw new HttpError(404, 'form not found');
    if (f.person_id !== me.id) need(me, 'payroll');
    const data = vault.openJson(f.data_enc);
    if (data?.ssn) data.ssn = `***-**-${data.ssn.slice(5)}`;
    audit(org.id, me.id, 'form_view', f.id, null);
    return { form: { id: f.id, kind: f.kind, personId: f.person_id, data, signature: sigOut(f.signature_id), createdAt: f.created_at, current: !f.superseded_at } };
  });

  // ---------- I-9 ----------
  const i9Out = (r) => ({ personId: r.person_id, status: r.status, section1: sigOut(r.section1_signature_id), section1At: r.section1_at, section2By: r.section2_by, section2At: r.section2_at, reverifyDate: r.reverify_date });
  const STATUSES = ['citizen', 'noncitizen_national', 'permanent_resident', 'authorized_alien'];
  route('GET', '/v1/i9', ({ me, org }) => {
    need(me, 'payroll');
    const t = today(org);
    const people = h.all(`SELECT id, name, hire_date, status FROM people WHERE org_id = ? AND worker_type = 'employee' AND status != 'terminated' ORDER BY name`, org.id);
    return {
      people: people.map((p) => {
        const r = h.get('SELECT * FROM i9_records WHERE person_id = ?', p.id);
        const s2due = p.hire_date ? addBusinessDays(p.hire_date, 3) : null;
        return { id: p.id, name: p.name, hireDate: p.hire_date, ...(r ? i9Out(r) : { status: 'not_started' }), section1Due: p.hire_date, section2Due: s2due, overdue: (!r || r.status !== 'complete') && s2due != null && s2due < t, reverifySoon: !!(r?.reverify_date && r.reverify_date <= addDays(t, 90)) };
      }),
    };
  });
  signedContent.set('i9_section1', (personId) => vault.openJson(h.get(`SELECT data_enc FROM form_submissions WHERE person_id = ? AND kind = 'i9_section1' ORDER BY created_at DESC LIMIT 1`, personId)?.data_enc));
  route('POST', '/v1/i9/:personId/section1', ({ me, org, params, body }) => {
    if (params.personId !== me.id) need(me, 'payroll');
    const p = c.getPerson(params.personId, org.id);
    const status = V.enum(body.attestation, 'attestation', STATUSES);
    const data = { attestation: status, uscisNumber: body.uscisNumber ? String(body.uscisNumber).slice(0, 20) : null, workAuthExpires: V.date(body.workAuthExpires, 'workAuthExpires', { optional: true }) };
    if (status === 'authorized_alien' && !data.workAuthExpires) bad('an authorized alien’s work authorization end date is needed (or N/A for some, enter the date on the document)');
    if (['permanent_resident', 'authorized_alien'].includes(status) && !data.uscisNumber) bad('the USCIS / A-Number is needed for this status');
    h.tx(() => {
      const fid = uid('fm');
      const sig = esign({ org, person: p, docKind: 'i9_section1', docId: p.id, content: data, typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
      h.run('INSERT INTO form_submissions (id,org_id,person_id,kind,data_enc,signature_id,created_at) VALUES (?,?,?,?,?,?,?)', fid, org.id, p.id, 'i9_section1', vault.sealJson(data), sig.id, iso(now()));
      h.run(`INSERT INTO i9_records (person_id, section1_signature_id, section1_at, reverify_date, status) VALUES (?,?,?,?, 'section1_done')
        ON CONFLICT(person_id) DO UPDATE SET section1_signature_id = excluded.section1_signature_id, section1_at = excluded.section1_at, reverify_date = excluded.reverify_date, status = CASE WHEN i9_records.status = 'complete' THEN 'complete' ELSE 'section1_done' END`, p.id, sig.id, iso(now()), data.workAuthExpires);
      c.markTask(p.id, 'i9_section1', me.id);
    });
    return { i9: i9Out(h.get('SELECT * FROM i9_records WHERE person_id = ?', p.id)) };
  });
  route('POST', '/v1/i9/:personId/section2', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(params.personId, org.id);
    const r = h.get('SELECT * FROM i9_records WHERE person_id = ?', p.id);
    if (!r?.section1_signature_id) throw new HttpError(409, 'the employee completes Section 1 first');
    if (body.examinedOriginals !== true) bad('confirm you physically examined the original documents');
    const docs = (Array.isArray(body.documents) ? body.documents : []).map((d, i) => ({ list: V.enum(d.list, `document ${i + 1} list`, ['A', 'B', 'C']), title: V.str(d.title, `document ${i + 1} title`, { min: 2, max: 120 }), issuingAuthority: String(d.issuingAuthority || '').slice(0, 120), number: String(d.number || '').slice(0, 40), expires: V.date(d.expires, `document ${i + 1} expiry`, { optional: true }) }));
    const lists = docs.map((d) => d.list).sort().join('');
    if (lists !== 'A' && lists !== 'BC') bad('give one List A document, or one List B and one List C document');
    const firstDay = V.date(body.firstDay ?? p.hireDate, 'firstDay');
    const examiner = c.getPerson(me.id, org.id);
    h.tx(() => {
      const data = { documents: docs, firstDay, examinerTitle: String(body.examinerTitle || '').slice(0, 80) };
      const sig = esign({ org, person: p, signer: examiner, docKind: 'i9_section2', docId: p.id, content: data, typedName: body.typedName, consent: body.consent, method: 'employer' });
      h.run(`UPDATE i9_records SET section2_enc = ?, section2_by = ?, section2_at = ?, status = 'complete', reverify_date = COALESCE(?, reverify_date) WHERE person_id = ?`, vault.sealJson({ ...data, signatureId: sig.id }), me.id, iso(now()), docs.find((d) => d.list === 'A' || d.list === 'C')?.expires && body.reverify === true ? docs.find((d) => d.list === 'A' || d.list === 'C').expires : null, p.id);
      c.markTask(p.id, 'i9_section2', me.id);
    });
    return { i9: i9Out(h.get('SELECT * FROM i9_records WHERE person_id = ?', p.id)) };
  });

  // ---------- policies ----------
  const rowToPol = (r) => ({ id: r.id, title: r.title, body: r.body, version: r.version, required: !!r.required, updatedAt: r.updated_at });
  signedContent.set('policy', (key) => { const [id, v] = key.split('@'); const r = h.get('SELECT * FROM policies WHERE id = ?', id); return r && Number(v) === r.version ? { title: r.title, body: r.body, version: r.version } : null; });
  route('GET', '/v1/policies', ({ me, org }) => {
    const rows = h.all('SELECT * FROM policies WHERE org_id = ? ORDER BY title', org.id).map(rowToPol);
    const active = h.get(`SELECT COUNT(*) AS n FROM people WHERE org_id = ? AND status IN ('active','onboarding','leave')`, org.id).n;
    return { policies: rows.map((p) => ({ ...p, acknowledged: h.get('SELECT COUNT(*) AS n FROM policy_acks WHERE policy_id = ? AND version = ?', p.id, p.version).n, people: active, mine: !!h.get('SELECT 1 FROM policy_acks WHERE policy_id = ? AND version = ? AND person_id = ?', p.id, p.version, me.id) })) };
  });
  route('POST', '/v1/policies', ({ me, org, body }) => {
    need(me, 'owner', 'payroll');
    const title = V.str(body.title, 'title', { min: 1, max: 120 }), text = V.str(body.body, 'body', { min: 1, max: 100000 });
    const required = body.required === false ? 0 : 1;
    if (body.id) {
      const cur = h.get('SELECT * FROM policies WHERE id = ? AND org_id = ?', body.id, org.id);
      if (!cur) throw new HttpError(404, 'policy not found');
      const version = cur.body !== text || cur.title !== title ? cur.version + 1 : cur.version;
      h.run('UPDATE policies SET title = ?, body = ?, version = ?, required = ?, updated_at = ? WHERE id = ?', title, text, version, required, iso(now()), cur.id);
      audit(org.id, me.id, 'policy_update', cur.id, { version });
      return { policy: rowToPol(h.get('SELECT * FROM policies WHERE id = ?', cur.id)) };
    }
    const id = uid('po');
    h.run('INSERT INTO policies (id,org_id,title,body,version,required,updated_at) VALUES (?,?,?,?,1,?,?)', id, org.id, title, text, required, iso(now()));
    audit(org.id, me.id, 'policy_create', id, null);
    return { status: 201, body: { policy: rowToPol(h.get('SELECT * FROM policies WHERE id = ?', id)) } };
  });
  route('POST', '/v1/policies/:id/ack', ({ me, org, params, body }) => {
    const pol = h.get('SELECT * FROM policies WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!pol) throw new HttpError(404, 'policy not found');
    const personId = V.id(body.personId ?? me.id, 'personId');
    if (personId !== me.id) need(me, 'payroll');
    const p = c.getPerson(personId, org.id);
    if (h.get('SELECT 1 FROM policy_acks WHERE policy_id = ? AND version = ? AND person_id = ?', pol.id, pol.version, p.id)) throw new HttpError(409, 'already acknowledged');
    h.tx(() => {
      const sig = esign({ org, person: p, docKind: 'policy', docId: `${pol.id}@${pol.version}`, content: { title: pol.title, body: pol.body, version: pol.version }, typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
      h.run('INSERT INTO policy_acks (policy_id, version, person_id, signature_id) VALUES (?,?,?,?)', pol.id, pol.version, p.id, sig.id);
      const left = h.get(`SELECT COUNT(*) AS n FROM policies x WHERE x.org_id = ? AND x.required = 1 AND NOT EXISTS (SELECT 1 FROM policy_acks a WHERE a.policy_id = x.id AND a.version = x.version AND a.person_id = ?)`, org.id, p.id).n;
      if (!left) c.markTask(p.id, 'policies', me.id);
    });
    return { ok: true };
  });

  // ---------- new-hire report (for the state's new-hire registry) ----------
  route('GET', '/v1/new-hire-report', ({ me, org, query }) => {
    need(me, 'payroll');
    const from = V.date(query.from ?? addDays(today(org), -30), 'from'), to = V.date(query.to ?? today(org), 'to');
    const ents = new Map(h.all('SELECT * FROM legal_entities WHERE org_id = ?', org.id).map((e) => [e.id, e]));
    const defEnt = h.get('SELECT * FROM legal_entities WHERE org_id = ? ORDER BY is_default DESC LIMIT 1', org.id);
    const rows = h.all(`SELECT id FROM people WHERE org_id = ? AND worker_type = 'employee' AND hire_date >= ? AND hire_date <= ? ORDER BY hire_date`, org.id, from, to).map((r) => c.getPerson(r.id, org.id))
      .filter((p) => !query.entityId || (p.entityId || defEnt?.id) === query.entityId)
      .map((p) => {
        const pii = vault.openJson(p.piiRaw) || {}, e = ents.get(p.entityId) || defEnt, ea = J(e?.address, {});
        const [first, ...rest] = (p.legalName || p.name).split(' ');
        return { employeeFirstName: first, employeeLastName: rest.join(' '), ssn: pii.ssn || '', address1: pii.address?.line1 || '', address2: pii.address?.line2 || '', city: pii.address?.city || '', state: pii.address?.state || '', zip: pii.address?.zip || '', birthDate: p.birthdate || '', hireDate: p.hireDate, workState: e?.state || org.state, employerName: e?.name || org.name, employerFein: (e?.ein || '').replace(/\D/g, ''), employerAddress1: ea.line1 || '', employerCity: ea.city || '', employerState: ea.state || '', employerZip: ea.zip || '', personId: p.id };
      });
    const missing = rows.filter((r) => !r.ssn || !r.address1 || !r.employerFein).map((r) => ({ personId: r.personId, name: `${r.employeeFirstName} ${r.employeeLastName}`, missing: [!r.ssn && 'SSN', !r.address1 && 'address', !r.employerFein && 'employer FEIN'].filter(Boolean) }));
    audit(org.id, me.id, 'new_hire_report', `${from}..${to}`, { rows: rows.length, format: query.format || 'json' });
    if (query.mark === '1') for (const r of rows) c.markTask(r.personId, 'new_hire_report', me.id);
    if (query.format === 'csv') {
      const headers = Object.keys(rows[0] || { employeeFirstName: '' }).filter((k) => k !== 'personId');
      return { raw: { type: 'text/csv; charset=utf-8', filename: `new-hires-${from}-to-${to}.csv`, body: toCsv(headers, rows) } };
    }
    return { from, to, count: rows.length, missing, rows: rows.map((r) => ({ ...r, ssn: r.ssn ? `***-**-${r.ssn.slice(5)}` : '' })), deadlineDays: c.rulesFor(org).newHire?.reportDays ?? null };
  });

  // ---------- offboarding ----------
  const rowToOff = (r) => ({ id: r.id, personId: r.person_id, kind: r.kind, lastDay: r.last_day, noticeDate: r.notice_date, finalPayDue: r.final_pay_due, finalPayRule: J(r.final_pay_rule, null), ptoPayout: J(r.pto_payout, null), cobra: J(r.cobra, null), checklist: J(r.checklist, []), status: r.status, createdAt: r.created_at, completedAt: r.completed_at });
  /** Final pay due date from the labor tables' rule for this kind of separation. */
  function finalPay(org, kind, lastDay, noticeDate) {
    const rules = c.rulesFor(org);
    const r = rules.finalPay?.[kind] ?? null;
    const nextPayday = () => { const p = c.periodOf(org, lastDay); return addDays(p.end, 6); };
    if (!r) return { due: nextPayday(), rule: { source: 'none', note: `No final-pay rule for ${org.state} in the labor tables; the next regular payday is shown. Check the state’s rule.` } };
    let due;
    if (r.rule === 'immediate') due = lastDay;
    else if (r.rule === 'next_payday') due = nextPayday();
    else if (r.rule === 'days') due = r.businessDays ? addBusinessDays(lastDay, r.days) : addDays(lastDay, r.days);
    else if (r.rule === 'earlier_of_next_payday_or_days') { const a = nextPayday(), b = addDays(lastDay, r.days); due = a < b ? a : b; }
    else due = nextPayday();
    if (r.noticeShortensTo != null && noticeDate && kind === 'voluntary') { /* rule-specific; noted only */ }
    return { due, rule: { ...r, jurisdiction: rules.jurisdiction } };
  }
  function ptoPlan(org, p) {
    const rules = c.rulesFor(org);
    const req = rules.ptoPayout || null;
    const base = rateFor(h, p, null, today(org));
    const ppy = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }[org.payFrequency] || 26;
    const hourly = base?.kind === 'salary' ? Math.round(base.cents / 2080) : base?.cents ?? 0;
    return policiesFor(h, p).map((pol) => {
      const hours = balance(h, p.id, pol.id);
      const pay = pol.payoutOnTerm === 'always' || (pol.payoutOnTerm === 'state_rule' && !!req?.required && (req.kinds || ['pto', 'vacation']).includes(pol.kind));
      return { policyId: pol.id, name: pol.name, kind: pol.kind, hours, pay, why: pol.payoutOnTerm === 'state_rule' ? (req ? req.note || (req.required ? 'State rule: earned vacation is paid out' : 'State rule: no payout required') : 'No state payout rule in the tables') : `Policy: ${pol.payoutOnTerm}`, rateCents: hourly, cents: pay && hours > 0 ? Math.round(hours * hourly) : 0 };
    }).map((x) => ({ ...x, ppy }));
  }
  route('GET', '/v1/offboarding', ({ me, org }) => {
    need(me, 'payroll');
    const nm = new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', org.id).map((r) => [r.id, r.name]));
    return { cases: h.all('SELECT * FROM offboarding WHERE org_id = ? ORDER BY created_at DESC', org.id).map(rowToOff).map((o) => ({ ...o, personName: nm.get(o.personId) })) };
  });
  route('POST', '/v1/offboarding', ({ me, org, body }) => {
    need(me, 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    if (h.get(`SELECT 1 FROM offboarding WHERE person_id = ? AND status = 'open'`, p.id)) throw new HttpError(409, 'already being offboarded');
    const kind = V.enum(body.kind, 'kind', ['voluntary', 'involuntary']);
    const lastDay = V.date(body.lastDay, 'lastDay');
    const noticeDate = V.date(body.noticeDate ?? today(org), 'noticeDate');
    const fp = finalPay(org, kind, lastDay, noticeDate);
    const pto = ptoPlan(org, p);
    const rules = c.rulesFor(org);
    const cobraRule = rules.cobra || null;
    const employees = h.get(`SELECT COUNT(*) AS n FROM people WHERE org_id = ? AND status IN ('active','leave') AND worker_type = 'employee'`, org.id).n;
    const plan = org.settings.cobra?.groupHealthPlan === true;
    const cobra = plan && cobraRule ? { applies: employees >= (cobraRule.minEmployees ?? 0) || org.settings.cobra?.stateContinuation === true, employerNoticeDue: addDays(lastDay, cobraRule.employerNoticeDays ?? 30), note: cobraRule.note || null } : { applies: false, note: plan ? 'No COBRA rule in the labor tables.' : 'No group health plan set in org settings.' };
    const t = (key, label, due = null) => ({ key, label, due, done: false, by: null, at: null });
    const checklist = [
      t('final_timecard', 'Final timecard approved', lastDay),
      t('final_pay', `Final pay issued (due ${fp.due})`, fp.due),
      pto.some((x) => x.pay && x.hours > 0) && t('pto_payout', 'PTO payout added to final pay', fp.due),
      cobra.applies && t('cobra', `COBRA: notify the plan administrator (due ${cobra.employerNoticeDue})`, cobra.employerNoticeDue),
      ...(Array.isArray(body.equipment) ? body.equipment : []).slice(0, 30).map((x, i) => t(`equipment_${i}`, `Returned: ${String(x).slice(0, 80)}`, lastDay)),
      ...((Array.isArray(body.access) && body.access.length ? body.access : ['KeaS sign-in', 'Kea Hub org membership', 'Building keys and codes', 'Email and other accounts']).slice(0, 30).map((x, i) => t(`access_${i}`, `Access removed: ${String(x).slice(0, 80)}`, lastDay))),
      t('exit_docs', 'Exit paperwork filed'),
    ].filter(Boolean);
    const id = uid('ob');
    h.run(`INSERT INTO offboarding (id,org_id,person_id,kind,last_day,notice_date,final_pay_due,final_pay_rule,pto_payout,cobra,checklist,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
      id, org.id, p.id, kind, lastDay, noticeDate, fp.due, JSON.stringify(fp.rule), JSON.stringify(pto), JSON.stringify(cobra), JSON.stringify(checklist), me.id, iso(now()));
    h.run('UPDATE people SET term_date = ? WHERE id = ?', lastDay, p.id);
    audit(org.id, me.id, 'offboarding_start', id, { personId: p.id, kind, lastDay, finalPayDue: fp.due });
    return { status: 201, body: { case: rowToOff(h.get('SELECT * FROM offboarding WHERE id = ?', id)) } };
  });
  const getOff = (id, orgId) => { const r = h.get('SELECT * FROM offboarding WHERE id = ? AND org_id = ?', id, orgId); if (!r) throw new HttpError(404, 'offboarding not found'); return r; };
  route('POST', '/v1/offboarding/:id/check', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const r = getOff(params.id, org.id);
    const list = J(r.checklist, []);
    const item = list.find((x) => x.key === body.key);
    if (!item) bad('unknown checklist item');
    item.done = body.done !== false; item.by = item.done ? me.id : null; item.at = item.done ? iso(now()) : null;
    h.run('UPDATE offboarding SET checklist = ? WHERE id = ?', JSON.stringify(list), r.id);
    audit(org.id, me.id, 'offboarding_check', r.id, { key: item.key, done: item.done });
    return { case: rowToOff(h.get('SELECT * FROM offboarding WHERE id = ?', r.id)) };
  });
  route('POST', '/v1/offboarding/:id/payout', ({ me, org, params }) => {
    need(me, 'payroll');
    const r = getOff(params.id, org.id);
    if (h.get(`SELECT 1 FROM extra_earnings WHERE source = ?`, `offboarding:${r.id}`)) throw new HttpError(409, 'the payout is already added');
    const p = c.getPerson(r.person_id, org.id);
    const plan = ptoPlan(org, p).filter((x) => x.pay && x.hours > 0 && x.cents > 0);
    if (!plan.length) throw new HttpError(409, 'nothing to pay out');
    h.tx(() => {
      for (const x of plan) {
        h.run(`INSERT INTO extra_earnings (id,org_id,person_id,code,label,cents,hours,taxable,source,detail,status,created_at) VALUES (?,?,?,?,?,?,?,1,?,?,'pending',?)`, uid('ee'), org.id, p.id, 'pto_payout', `${x.name} payout`, x.cents, x.hours, `offboarding:${r.id}`, JSON.stringify(x), iso(now()));
        h.run(`INSERT INTO pto_ledger (person_id,policy_id,date,hours,kind,ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, p.id, x.policyId, r.last_day, -x.hours, 'payout', `payout:${r.id}`, 'Paid out at separation', me.id, iso(now()));
      }
      const list = J(r.checklist, []);
      const item = list.find((i) => i.key === 'pto_payout');
      if (item) { item.done = true; item.by = me.id; item.at = iso(now()); h.run('UPDATE offboarding SET checklist = ?, pto_payout = ? WHERE id = ?', JSON.stringify(list), JSON.stringify(plan), r.id); }
    });
    audit(org.id, me.id, 'pto_payout', r.id, { cents: plan.reduce((a, x) => a + x.cents, 0) });
    return { case: rowToOff(h.get('SELECT * FROM offboarding WHERE id = ?', r.id)) };
  });
  route('POST', '/v1/offboarding/:id/complete', ({ me, org, params, body }) => {
    need(me, 'payroll');
    const r = getOff(params.id, org.id);
    const open = J(r.checklist, []).filter((x) => !x.done);
    if (open.length && !(body.force === true && String(body.reason || '').trim().length >= 3)) throw new HttpError(409, `Still open: ${open.map((x) => x.label).join(', ')}`, { open });
    h.tx(() => {
      h.run(`UPDATE offboarding SET status = 'complete', completed_at = ? WHERE id = ?`, iso(now()), r.id);
      h.run(`UPDATE people SET status = 'terminated', term_date = ? WHERE id = ?`, r.last_day, r.person_id);
      h.run('DELETE FROM sessions WHERE person_id = ?', r.person_id);
      h.run('DELETE FROM vault_users WHERE person_id = ?', r.person_id);
    });
    audit(org.id, me.id, 'offboarding_complete', r.id, { forced: !!open.length, reason: body.reason ?? null });
    return { case: rowToOff(h.get('SELECT * FROM offboarding WHERE id = ?', r.id)) };
  });
}
