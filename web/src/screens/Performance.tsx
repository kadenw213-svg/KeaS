import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useWork, can, fmtDay } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog, ESign, statusTone, human, type Field } from '../kit';

type Tab = 'reviews' | 'goals' | 'checkins';

/** Performance: review cycles (self and manager, shared and acknowledged), goals and check-ins. Nothing is scored for you. */
export function Performance() {
  const [tab, setTab] = useState<Tab>('reviews');
  return (
    <Page title="Performance" lead="Reviews, goals and check-ins are people’s own words and ratings; KeaS never scores anyone automatically.">
      <Tabs tabs={[{ id: 'reviews', label: 'Reviews' }, { id: 'goals', label: 'Goals' }, { id: 'checkins', label: 'Check-ins' }]} value={tab} onChange={setTab} />
      {tab === 'reviews' && <Reviews />}
      {tab === 'goals' && <Goals />}
      {tab === 'checkins' && <Checkins />}
    </Page>
  );
}

function Reviews() {
  const { me, people } = useWork();
  const mgr = can(me, 'manager') || can(me, 'payroll');
  const { data, error, reload } = useLoad<any>('/v1/review-cycles');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any | null>(null);
  if (!data) return <Loading error={error} />;
  const answerFields = (cycle: any, prefix: string): Field[] => cycle.questions.map((q: any) => (q.rating ? { name: `${prefix}${q.id}`, label: `${q.text} (1–5)`, type: 'number' } : { name: `${prefix}${q.id}`, label: q.text, type: 'textarea' }));
  const collect = (cycle: any, v: any, prefix: string) => Object.fromEntries(cycle.questions.map((q: any) => [q.id, v[`${prefix}${q.id}`] ?? '']));
  return (
    <>
      {mgr && (
        <div className="pr-row">
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> Start a review cycle
          </button>
        </div>
      )}
      {data.cycles.map((c: any) => (
        <section className="pr-section" key={c.id}>
          <h2>
            {c.name} <span className="muted small">{fmtDay(c.periodStart)} – {fmtDay(c.periodEnd)}</span>
          </h2>
          <Table
            cols={[
              { key: 'personName', label: 'Person' },
              { key: 'reviewerName', label: 'Reviewer' },
              { key: 'status', label: 'Status', render: (r: any) => <Tag tone={statusTone(r.status)}>{human(r.status)}</Tag> }
            ]}
            rows={c.reviews}
            onRow={(r: any) => setOpen({ cycle: c, review: r })}
            empty="No reviews you can see."
          />
        </section>
      ))}
      {adding && (
        <FormDialog
          title="Start a review cycle"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'name', label: 'Name', required: true, placeholder: 'Spring reviews' },
            { name: 'periodStart', label: 'Covers from', type: 'date', required: true },
            { name: 'periodEnd', label: 'Covers to', type: 'date', required: true },
            { name: 'questions', label: 'Written questions (one per line)', type: 'textarea', required: true },
            { name: 'ratings', label: 'Rated 1–5 (one per line)', type: 'textarea', advanced: true },
            { name: 'personIds', label: 'Only these people (default: everyone active)', type: 'multiselect', advanced: true, options: people.map((p) => ({ value: p.id, label: p.name })) }
          ]}
          initial={{ questions: 'What went well?\nWhat could go better?\nGoals for next period' }}
          onSubmit={async (v) => {
            const questions = [...String(v.questions || '').split('\n').filter(Boolean).map((t) => ({ text: t })), ...String(v.ratings || '').split('\n').filter(Boolean).map((t) => ({ text: t, rating: true }))];
            (await act(api('POST', '/v1/review-cycles', { ...v, questions }), 'Cycle started.')) && (setAdding(false), reload());
          }}
        />
      )}
      {open && (
        <FormDialog
          title={`${open.review.personName}: ${open.cycle.name}`}
          onClose={() => setOpen(null)}
          initial={{
            ...Object.fromEntries(Object.entries(open.review.selfAnswers).map(([k, v]) => [`s${k}`, v])),
            ...Object.fromEntries(Object.entries(open.review.managerAnswers).map(([k, v]) => [`m${k}`, v]))
          }}
          fields={open.review.sharedAt ? [] : open.review.personId === me?.id ? answerFields(open.cycle, 's') : open.review.reviewerId === me?.id || can(me, 'payroll') ? answerFields(open.cycle, 'm') : []}
          submit={open.review.sharedAt ? 'Close' : open.review.personId === me?.id ? 'Save my self-review' : 'Save the review'}
          onSubmit={async (v) => {
            if (open.review.sharedAt) return setOpen(null);
            const self = open.review.personId === me?.id;
            (await act(api('POST', `/v1/reviews/${open.review.id}/${self ? 'self' : 'manager'}`, { answers: collect(open.cycle, v, self ? 's' : 'm') }), 'Saved.')) && (setOpen(null), reload());
          }}
          extra={
            <>
              {open.review.personId !== me?.id && Object.keys(open.review.selfAnswers).length > 0 && (
                <div className="card">
                  <strong>Their self-review</strong>
                  {open.cycle.questions.map((q: any) => (
                    <p key={q.id} className="small">
                      <b>{q.text}</b> {String(open.review.selfAnswers[q.id] ?? '—')}
                    </p>
                  ))}
                </div>
              )}
              {open.review.sharedAt && (
                <div className="card">
                  <strong>The review</strong>
                  {open.cycle.questions.map((q: any) => (
                    <p key={q.id} className="small">
                      <b>{q.text}</b> {String(open.review.managerAnswers[q.id] ?? '—')}
                    </p>
                  ))}
                </div>
              )}
              {open.review.status === 'manager_done' && open.review.reviewerId === me?.id && (
                <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/reviews/${open.review.id}/share`), 'Shared.')) && (setOpen(null), reload())}>
                  Share with {open.review.personName}
                </button>
              )}
              {open.review.status === 'shared' && open.review.personId === me?.id && (
                <ESign name={me?.name || ''} label="Acknowledge" note="Signing says you’ve read the review, not that you agree with it." onSign={async (typedName) => (await act(api('POST', `/v1/reviews/${open.review.id}/acknowledge`, { typedName, consent: true }), 'Acknowledged.')) && (setOpen(null), reload())} />
              )}
            </>
          }
        />
      )}
    </>
  );
}

function Goals() {
  const { me, people } = useWork();
  const mgr = can(me, 'manager') || can(me, 'payroll');
  const { data, reload } = useLoad<any>(`/v1/goals${mgr ? '' : `?personId=${me?.id}`}`);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setEdit({ personId: me?.id, progress: 0, status: 'active' })}>
          <Plus size={15} /> Add a goal
        </button>
      </div>
      <Table
        cols={[
          { key: 'title', label: 'Goal' },
          { key: 'personName', label: 'Person' },
          { key: 'due', label: 'Due', render: (g: any) => (g.due ? fmtDay(g.due) : '—') },
          { key: 'progress', label: 'Progress', render: (g: any) => `${g.progress}%` },
          { key: 'status', label: 'Status', render: (g: any) => <Tag tone={g.status === 'done' ? 'ok' : undefined}>{human(g.status)}</Tag> }
        ]}
        rows={data?.goals || []}
        onRow={setEdit}
        empty="No goals yet."
      />
      {edit && (
        <FormDialog
          title={edit.id ? edit.title : 'Add a goal'}
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            ...(mgr ? [{ name: 'personId', label: 'For', type: 'select' as const, required: true, options: people.map((p) => ({ value: p.id, label: p.name })) }] : []),
            { name: 'title', label: 'Goal', required: true },
            { name: 'due', label: 'Due', type: 'date' },
            { name: 'progress', label: 'Progress (%)', type: 'number' },
            { name: 'status', label: 'Status', type: 'select', required: true, options: ['active', 'done', 'dropped'].map((s) => ({ value: s, label: human(s) })) },
            { name: 'detail', label: 'Details', type: 'textarea', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/goals', { ...v, id: edit.id }), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </>
  );
}

function Checkins() {
  const { me, people } = useWork();
  const mgr = can(me, 'manager') || can(me, 'payroll');
  const { data, reload } = useLoad<any>('/v1/checkins');
  const [adding, setAdding] = useState(false);
  return (
    <>
      {mgr && (
        <div className="pr-row">
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> Record a check-in
          </button>
        </div>
      )}
      <Table
        cols={[
          { key: 'date', label: 'Date', render: (c: any) => fmtDay(c.date) },
          { key: 'personName', label: 'Person' },
          { key: 'managerName', label: 'With' },
          { key: 'notes', label: 'Notes' },
          ...(mgr ? [{ key: 'privateNotes', label: 'Private notes' }] : [])
        ]}
        rows={data?.checkins || []}
        empty="No check-ins yet."
      />
      {adding && (
        <FormDialog
          title="Record a check-in"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'personId', label: 'With', type: 'select', required: true, options: people.filter((p) => p.id !== me?.id).map((p) => ({ value: p.id, label: p.name })) },
            { name: 'date', label: 'Date', type: 'date' },
            { name: 'notes', label: 'Notes (they can see these)', type: 'textarea', required: true },
            { name: 'privateNotes', label: 'Private notes (only you)', type: 'textarea', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/checkins', v), 'Saved.')) && (setAdding(false), reload())}
        />
      )}
    </>
  );
}
