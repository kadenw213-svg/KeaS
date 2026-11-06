// Hiring (job posts, candidates, interviews, hire -> person and offer) and performance (review cycles, goals, check-ins).
// Nothing is scored automatically: reviews and interview feedback are people's own words and ratings.
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export const STAGES = ['applied', 'screen', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

export function registerTalent(c) {
  const { h, route, V, bad, need, HttpError, uid, audit, now, iso, today } = c;
  const nm = (orgId) => new Map(h.all('SELECT id, name FROM people WHERE org_id = ?', orgId).map((r) => [r.id, r.name]));

  // ---------- jobs and candidates ----------
  const rowToJob = (r) => ({ id: r.id, title: r.title, positionId: r.position_id, departmentId: r.department_id, description: r.description, payMinCents: r.pay_min_cents, payMaxCents: r.pay_max_cents, status: r.status, questions: J(r.questions, []), createdAt: r.created_at });
  const rowToCand = (r) => ({ id: r.id, jobId: r.job_id, name: r.name, email: r.email, phone: r.phone, answers: J(r.answers, {}), stage: r.stage, notes: J(r.notes, []), personId: r.person_id, createdAt: r.created_at });
  route('GET', '/v1/jobs', ({ me, org }) => {
    need(me, 'manager', 'payroll');
    return { jobs: h.all('SELECT * FROM job_posts WHERE org_id = ? ORDER BY created_at DESC', org.id).map(rowToJob).map((j) => ({ ...j, counts: Object.fromEntries(h.all('SELECT stage, COUNT(*) AS n FROM candidates WHERE job_id = ? GROUP BY stage', j.id).map((r) => [r.stage, r.n])) })) };
  });
  route('POST', '/v1/jobs', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const id = body.id ? V.id(body.id, 'id') : uid('job');
    const questions = Array.isArray(body.questions) ? body.questions.slice(0, 30).map((q) => String(q).slice(0, 300)).filter(Boolean) : [];
    const money = (v) => (v == null || v === '' ? null : Math.round(Number(v)));
    h.run(`INSERT INTO job_posts (id,org_id,title,position_id,department_id,description,pay_min_cents,pay_max_cents,status,questions,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, position_id=excluded.position_id, department_id=excluded.department_id, description=excluded.description, pay_min_cents=excluded.pay_min_cents, pay_max_cents=excluded.pay_max_cents, status=excluded.status, questions=excluded.questions`,
      id, org.id, V.str(body.title, 'title', { min: 1, max: 120 }), body.positionId || null, body.departmentId || null, V.str(body.description ?? '', 'description', { max: 20000 }), money(body.payMinCents), money(body.payMaxCents), V.enum(body.status ?? 'open', 'status', ['draft', 'open', 'closed']), JSON.stringify(questions), iso(now()));
    audit(org.id, me.id, 'job_save', id, null);
    return { job: rowToJob(h.get('SELECT * FROM job_posts WHERE id = ?', id)) };
  });
  route('GET', '/v1/jobs/:id/candidates', ({ me, org, params }) => {
    need(me, 'manager', 'payroll');
    if (!h.get('SELECT 1 FROM job_posts WHERE id = ? AND org_id = ?', params.id, org.id)) throw new HttpError(404, 'job not found');
    const names = nm(org.id);
    return { candidates: h.all('SELECT * FROM candidates WHERE job_id = ? ORDER BY created_at', params.id).map(rowToCand).map((x) => ({ ...x, interviews: h.all('SELECT * FROM interviews WHERE candidate_id = ? ORDER BY at', x.id).map((i) => ({ id: i.id, at: i.at, minutes: i.minutes, location: i.location, interviewers: J(i.interviewers, []).map((p) => ({ id: p, name: names.get(p) })), feedback: J(i.feedback, []).map((f) => ({ ...f, byName: names.get(f.by) })) })) })) };
  });
  route('POST', '/v1/jobs/:id/candidates', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const job = h.get('SELECT * FROM job_posts WHERE id = ? AND org_id = ?', params.id, org.id);
    if (!job) throw new HttpError(404, 'job not found');
    const answers = body.answers && typeof body.answers === 'object' ? Object.fromEntries(Object.entries(body.answers).slice(0, 30).map(([k, v]) => [String(k).slice(0, 300), String(v).slice(0, 5000)])) : {};
    const id = uid('cand');
    h.run('INSERT INTO candidates (id,org_id,job_id,name,email,phone,answers,stage,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, org.id, job.id, V.str(body.name, 'name', { min: 1, max: 120 }), V.str(body.email, 'email', { optional: true, max: 200 }), V.str(body.phone, 'phone', { optional: true, max: 40 }), JSON.stringify(answers), 'applied', '[]', iso(now()));
    audit(org.id, me.id, 'candidate_add', id, { jobId: job.id });
    return { status: 201, body: { candidate: rowToCand(h.get('SELECT * FROM candidates WHERE id = ?', id)) } };
  });
  const getCand = (id, orgId) => { const r = h.get('SELECT * FROM candidates WHERE id = ? AND org_id = ?', id, orgId); if (!r) throw new HttpError(404, 'candidate not found'); return r; };
  route('POST', '/v1/candidates/:id/stage', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const cd = getCand(params.id, org.id);
    const stage = V.enum(body.stage, 'stage', STAGES.filter((s) => s !== 'hired'));
    h.run('UPDATE candidates SET stage = ? WHERE id = ?', stage, cd.id);
    audit(org.id, me.id, 'candidate_stage', cd.id, { stage });
    return { candidate: rowToCand(getCand(cd.id, org.id)) };
  });
  route('POST', '/v1/candidates/:id/notes', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const cd = getCand(params.id, org.id);
    const notes = [...J(cd.notes, []), { by: me.id, at: iso(now()), text: V.str(body.text, 'text', { min: 1, max: 5000 }) }];
    h.run('UPDATE candidates SET notes = ? WHERE id = ?', JSON.stringify(notes), cd.id);
    return { candidate: rowToCand(getCand(cd.id, org.id)) };
  });
  route('POST', '/v1/candidates/:id/interviews', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const cd = getCand(params.id, org.id);
    const interviewers = (Array.isArray(body.interviewers) ? body.interviewers : [me.id]).filter((p) => h.get('SELECT 1 FROM people WHERE id = ? AND org_id = ?', p, org.id));
    const id = uid('iv');
    h.run('INSERT INTO interviews (id,candidate_id,at,minutes,interviewers,location,feedback) VALUES (?,?,?,?,?,?,?)', id, cd.id, V.iso(body.at, 'at'), Math.max(5, Math.min(480, Math.round(Number(body.minutes) || 30))), JSON.stringify(interviewers), V.str(body.location, 'location', { optional: true, max: 300 }), '[]');
    if (cd.stage === 'applied' || cd.stage === 'screen') h.run(`UPDATE candidates SET stage = 'interview' WHERE id = ?`, cd.id);
    audit(org.id, me.id, 'interview_schedule', id, { candidateId: cd.id });
    return { status: 201, body: { id } };
  });
  route('POST', '/v1/interviews/:id/feedback', ({ me, org, params, body }) => {
    need(me, 'manager', 'payroll');
    const iv = h.get('SELECT i.* FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.id = ? AND c.org_id = ?', params.id, org.id);
    if (!iv) throw new HttpError(404, 'interview not found');
    const fb = [...J(iv.feedback, []).filter((f) => f.by !== me.id), { by: me.id, at: iso(now()), recommendation: V.enum(body.recommendation, 'recommendation', ['strong_yes', 'yes', 'no', 'strong_no']), notes: V.str(body.notes, 'notes', { optional: true, max: 5000 }) }];
    h.run('UPDATE interviews SET feedback = ? WHERE id = ?', JSON.stringify(fb), iv.id);
    return { ok: true };
  });
  // Hire: the candidate becomes a person (applicant) ready for an offer and onboarding.
  route('POST', '/v1/candidates/:id/hire', ({ me, org, params }) => {
    need(me, 'payroll');
    const cd = getCand(params.id, org.id);
    if (cd.person_id) throw new HttpError(409, 'already hired');
    const job = h.get('SELECT * FROM job_posts WHERE id = ?', cd.job_id);
    const p = c.createPerson(org, me, { name: cd.name, email: cd.email, status: 'applicant', positions: job.position_id ? [job.position_id] : undefined, pii: cd.phone ? { phone: cd.phone } : undefined });
    if (job.department_id) h.run('UPDATE people SET department_id = ? WHERE id = ?', job.department_id, p.id);
    h.run(`UPDATE candidates SET stage = 'hired', person_id = ? WHERE id = ?`, p.id, cd.id);
    audit(org.id, me.id, 'candidate_hire', cd.id, { personId: p.id });
    return { personId: p.id, jobTitle: job.title, positionId: job.position_id };
  });

  // ---------- performance ----------
  const rowToReview = (r) => ({ id: r.id, cycleId: r.cycle_id, personId: r.person_id, reviewerId: r.reviewer_id, selfAnswers: J(r.self_answers, {}), managerAnswers: J(r.manager_answers, {}), status: r.status, sharedAt: r.shared_at, acknowledged: c.sigOut(r.acknowledged_signature_id) });
  const canSee = (me, r) => r.person_id === me.id || r.reviewer_id === me.id || c.has(me, 'payroll');
  route('GET', '/v1/review-cycles', ({ me, org }) => {
    const names = nm(org.id);
    return {
      cycles: h.all('SELECT * FROM review_cycles WHERE org_id = ? ORDER BY period_end DESC', org.id).map((x) => ({
        id: x.id, name: x.name, periodStart: x.period_start, periodEnd: x.period_end, questions: J(x.questions, []), status: x.status,
        reviews: h.all('SELECT * FROM reviews WHERE cycle_id = ?', x.id).filter((r) => canSee(me, r)).map(rowToReview).map((r) => ({ ...r, personName: names.get(r.personId), reviewerName: names.get(r.reviewerId), managerAnswers: r.personId === me.id && !r.sharedAt ? {} : r.managerAnswers })),
      })),
    };
  });
  route('POST', '/v1/review-cycles', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const questions = (Array.isArray(body.questions) ? body.questions : []).map((q) => ({ id: uid('q'), text: String(q.text ?? q).slice(0, 300), rating: !!q.rating })).filter((q) => q.text);
    if (!questions.length) bad('add at least one question');
    const id = uid('cy');
    const people = (Array.isArray(body.personIds) && body.personIds.length ? body.personIds : h.all(`SELECT id FROM people WHERE org_id = ? AND status = 'active' AND worker_type = 'employee'`, org.id).map((r) => r.id));
    h.tx(() => {
      h.run('INSERT INTO review_cycles (id,org_id,name,period_start,period_end,questions,status,created_at) VALUES (?,?,?,?,?,?,?,?)', id, org.id, V.str(body.name, 'name', { min: 1, max: 100 }), V.date(body.periodStart, 'periodStart'), V.date(body.periodEnd, 'periodEnd'), JSON.stringify(questions), 'open', iso(now()));
      for (const pid of people) {
        const p = h.get('SELECT id, manager_id FROM people WHERE id = ? AND org_id = ?', pid, org.id);
        if (p) h.run('INSERT INTO reviews (id,cycle_id,person_id,reviewer_id) VALUES (?,?,?,?)', uid('rv'), id, p.id, p.manager_id && p.manager_id !== p.id ? p.manager_id : me.id);
      }
    });
    audit(org.id, me.id, 'review_cycle_create', id, { people: people.length });
    return { status: 201, body: { id } };
  });
  const getReview = (id, orgId) => { const r = h.get('SELECT r.* FROM reviews r JOIN review_cycles c ON c.id = r.cycle_id WHERE r.id = ? AND c.org_id = ?', id, orgId); if (!r) throw new HttpError(404, 'review not found'); return r; };
  const cleanAnswers = (a) => (a && typeof a === 'object' ? Object.fromEntries(Object.entries(a).slice(0, 50).map(([k, v]) => [String(k).slice(0, 40), typeof v === 'number' ? Math.max(1, Math.min(5, Math.round(v))) : String(v).slice(0, 10000)])) : {});
  route('POST', '/v1/reviews/:id/self', ({ me, org, params, body }) => {
    const r = getReview(params.id, org.id);
    if (r.person_id !== me.id) need(me, 'payroll');
    if (r.shared_at) throw new HttpError(409, 'this review has been shared');
    h.run(`UPDATE reviews SET self_answers = ?, status = CASE WHEN status = 'open' THEN 'self_done' ELSE status END WHERE id = ?`, JSON.stringify(cleanAnswers(body.answers)), r.id);
    return { review: rowToReview(getReview(r.id, org.id)) };
  });
  route('POST', '/v1/reviews/:id/manager', ({ me, org, params, body }) => {
    const r = getReview(params.id, org.id);
    if (r.reviewer_id !== me.id) need(me, 'payroll');
    if (r.person_id === me.id) throw new HttpError(403, 'you can’t write your own manager review');
    if (r.shared_at) throw new HttpError(409, 'this review has been shared');
    h.run(`UPDATE reviews SET manager_answers = ?, status = 'manager_done' WHERE id = ?`, JSON.stringify(cleanAnswers(body.answers)), r.id);
    return { review: rowToReview(getReview(r.id, org.id)) };
  });
  route('POST', '/v1/reviews/:id/share', ({ me, org, params }) => {
    const r = getReview(params.id, org.id);
    if (r.reviewer_id !== me.id) need(me, 'payroll');
    if (r.status !== 'manager_done') throw new HttpError(409, 'finish the manager review first');
    h.run(`UPDATE reviews SET status = 'shared', shared_at = ? WHERE id = ?`, iso(now()), r.id);
    audit(org.id, me.id, 'review_share', r.id, null);
    return { review: rowToReview(getReview(r.id, org.id)) };
  });
  c.signedContent.set('review', (id) => { const r = h.get('SELECT self_answers, manager_answers, shared_at FROM reviews WHERE id = ?', id); return r && { self: J(r.self_answers, {}), manager: J(r.manager_answers, {}), sharedAt: r.shared_at }; });
  route('POST', '/v1/reviews/:id/acknowledge', ({ me, org, params, body }) => {
    const r = getReview(params.id, org.id);
    if (r.person_id !== me.id) need(me, 'payroll');
    if (r.status !== 'shared') throw new HttpError(409, 'the review hasn’t been shared yet');
    const p = c.getPerson(r.person_id, org.id);
    const sig = c.esign({ org, person: p, docKind: 'review', docId: r.id, content: { self: J(r.self_answers, {}), manager: J(r.manager_answers, {}), sharedAt: r.shared_at }, typedName: body.typedName, consent: body.consent, witnessedBy: me.id === p.id ? null : me.id });
    h.run(`UPDATE reviews SET acknowledged_signature_id = ?, status = 'acknowledged' WHERE id = ?`, sig.id, r.id);
    return { review: rowToReview(getReview(r.id, org.id)) };
  });

  const rowToGoal = (r) => ({ id: r.id, personId: r.person_id, title: r.title, detail: r.detail, due: r.due, progress: r.progress, status: r.status, createdAt: r.created_at });
  route('GET', '/v1/goals', ({ me, org, query }) => {
    const pid = query.personId || null;
    if (pid !== me.id) need(me, 'manager', 'payroll');
    const rows = pid ? h.all('SELECT * FROM goals WHERE org_id = ? AND person_id = ? ORDER BY due IS NULL, due', org.id, pid) : h.all('SELECT * FROM goals WHERE org_id = ? ORDER BY due IS NULL, due LIMIT 1000', org.id);
    const names = nm(org.id);
    return { goals: rows.map(rowToGoal).map((g) => ({ ...g, personName: names.get(g.personId) })) };
  });
  route('POST', '/v1/goals', ({ me, org, body }) => {
    const pid = V.id(body.personId ?? me.id, 'personId');
    if (pid !== me.id) need(me, 'manager', 'payroll');
    c.getPerson(pid, org.id);
    const id = body.id ? V.id(body.id, 'id') : uid('gl');
    h.run(`INSERT INTO goals (id,org_id,person_id,title,detail,due,progress,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, detail=excluded.detail, due=excluded.due, progress=excluded.progress, status=excluded.status`,
      id, org.id, pid, V.str(body.title, 'title', { min: 1, max: 200 }), V.str(body.detail, 'detail', { optional: true, max: 5000 }), V.date(body.due, 'due', { optional: true }), Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0))), V.enum(body.status ?? 'active', 'status', ['active', 'done', 'dropped']), me.id, iso(now()));
    return { goal: rowToGoal(h.get('SELECT * FROM goals WHERE id = ?', id)) };
  });
  route('GET', '/v1/checkins', ({ me, org, query }) => {
    const pid = query.personId || null;
    const names = nm(org.id);
    let rows = h.all('SELECT * FROM checkins WHERE org_id = ? ORDER BY date DESC LIMIT 1000', org.id);
    if (pid) rows = rows.filter((r) => r.person_id === pid);
    rows = rows.filter((r) => r.person_id === me.id || r.manager_id === me.id || c.has(me, 'payroll'));
    return { checkins: rows.map((r) => ({ id: r.id, personId: r.person_id, personName: names.get(r.person_id), managerId: r.manager_id, managerName: names.get(r.manager_id), date: r.date, notes: r.notes, privateNotes: r.manager_id === me.id ? r.private_notes : undefined })) };
  });
  route('POST', '/v1/checkins', ({ me, org, body }) => {
    need(me, 'manager', 'payroll');
    const p = c.getPerson(V.id(body.personId, 'personId'), org.id);
    const id = uid('ci');
    h.run('INSERT INTO checkins (id,org_id,person_id,manager_id,date,notes,private_notes,created_at) VALUES (?,?,?,?,?,?,?,?)', id, org.id, p.id, me.id, V.date(body.date ?? today(org), 'date'), V.str(body.notes, 'notes', { min: 1, max: 10000 }), V.str(body.privateNotes, 'privateNotes', { optional: true, max: 10000 }), iso(now()));
    return { status: 201, body: { id } };
  });
}
