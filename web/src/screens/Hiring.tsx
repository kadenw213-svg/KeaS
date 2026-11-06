import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useWork, money, go, loadWork } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tag, FormDialog, statusTone, human } from '../kit';

const STAGES = ['applied', 'screen', 'interview', 'offer', 'rejected', 'withdrawn'];

/** Hiring: job posts, candidates by stage, interviews and feedback, and turning a candidate into a new hire. */
export function Hiring() {
  const { positions } = useWork();
  const { data, error, reload } = useLoad<any>('/v1/jobs');
  const { data: org } = useLoad<any>('/v1/org-structure');
  const [job, setJob] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  if (job) return <Candidates job={job} back={() => (setJob(null), reload())} />;
  return (
    <Page
      title="Hiring"
      lead="Post a job, track each candidate through the stages, then hire: the candidate becomes a person ready for an offer letter and onboarding."
      actions={
        <button className="btn primary" onClick={() => setEdit({ status: 'open' })}>
          <Plus size={15} /> Post a job
        </button>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : (
        <Table
          cols={[
            { key: 'title', label: 'Job' },
            { key: 'pay', label: 'Pay', render: (j: any) => (j.payMinCents ? `${money(j.payMinCents)}${j.payMaxCents ? ' – ' + money(j.payMaxCents) : ''}` : '—') },
            { key: 'counts', label: 'Candidates', render: (j: any) => Object.entries(j.counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'None yet' },
            { key: 'status', label: 'Status', render: (j: any) => <Tag tone={statusTone(j.status)}>{human(j.status)}</Tag> },
            { key: 'edit', label: '', render: (j: any) => <button className="btn sm" onClick={(e) => (e.stopPropagation(), setEdit({ ...j, questions: j.questions.join('\n') }))}>Edit</button> }
          ]}
          rows={data.jobs}
          onRow={setJob}
          empty="No jobs posted."
        />
      )}
      {edit && (
        <FormDialog
          title={edit.id ? edit.title : 'Post a job'}
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            { name: 'title', label: 'Title', required: true },
            { name: 'description', label: 'Description', type: 'textarea' },
            { name: 'payMinCents', label: 'Pay from', type: 'money' },
            { name: 'payMaxCents', label: 'Pay to', type: 'money' },
            { name: 'status', label: 'Status', type: 'select', required: true, options: ['draft', 'open', 'closed'].map((s) => ({ value: s, label: human(s) })) },
            { name: 'positionId', label: 'Position', type: 'select', advanced: true, options: positions.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'departmentId', label: 'Department', type: 'select', advanced: true, options: (org?.departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
            { name: 'questions', label: 'Application questions (one per line)', type: 'textarea', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/jobs', { ...v, id: edit.id, questions: String(v.questions || '').split('\n').filter(Boolean) }), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </Page>
  );
}

function Candidates({ job, back }: { job: any; back: () => void }) {
  const { people } = useWork();
  const { data, error, reload } = useLoad<any>(`/v1/jobs/${job.id}/candidates`);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any | null>(null);
  const [form, setForm] = useState<null | 'interview' | 'note' | { feedback: string }>(null);
  return (
    <Page
      title={job.title}
      actions={
        <>
          <button className="btn" onClick={back}>
            All jobs
          </button>
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> Add a candidate
          </button>
        </>
      }
    >
      {!data ? (
        <Loading error={error} />
      ) : (
        <Table
          cols={[
            { key: 'name', label: 'Candidate' },
            { key: 'email', label: 'Email' },
            { key: 'stage', label: 'Stage', render: (c: any) => <Tag tone={statusTone(c.stage)}>{human(c.stage)}</Tag> },
            { key: 'interviews', label: 'Interviews', render: (c: any) => c.interviews.length }
          ]}
          rows={data.candidates}
          onRow={setOpen}
          empty="No candidates yet."
        />
      )}
      {adding && (
        <FormDialog
          title="Add a candidate"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'phone', label: 'Phone' },
            ...job.questions.map((q: string, i: number) => ({ name: `q${i}`, label: q, advanced: true }))
          ]}
          onSubmit={async (v) => {
            const answers = Object.fromEntries(job.questions.map((q: string, i: number) => [q, v[`q${i}`] || '']));
            (await act(api('POST', `/v1/jobs/${job.id}/candidates`, { name: v.name, email: v.email, phone: v.phone, answers }), 'Added.')) && (setAdding(false), reload());
          }}
        />
      )}
      {open && !form && (
        <FormDialog
          title={open.name}
          onClose={() => setOpen(null)}
          fields={[]}
          submit="Close"
          onSubmit={() => setOpen(null)}
          extra={
            <>
              <dl className="pr-kv">
                {Object.entries(open.answers).flatMap(([q, a]) => [<dt key={q}>{q}</dt>, <dd key={q + '-a'}>{String(a) || '—'}</dd>])}
              </dl>
              <div className="pr-row">
                <span className="muted">Stage:</span>
                {STAGES.map((s) => (
                  <button key={s} type="button" className={`btn sm ${open.stage === s ? 'primary' : ''}`} onClick={async () => { const r = await act(api<any>('POST', `/v1/candidates/${open.id}/stage`, { stage: s })); if (r) (setOpen({ ...open, stage: s }), reload()); }}>
                    {human(s)}
                  </button>
                ))}
              </div>
              {open.interviews.map((iv: any) => (
                <div key={iv.id} className="card">
                  <strong>Interview {new Date(iv.at).toLocaleString()}</strong> <span className="muted">with {iv.interviewers.map((x: any) => x.name).join(', ')}{iv.location ? ` · ${iv.location}` : ''}</span>
                  {iv.feedback.map((f: any, i: number) => (
                    <p key={i} className="small">{f.byName}: {human(f.recommendation)}{f.notes ? ` — ${f.notes}` : ''}</p>
                  ))}
                  <button type="button" className="btn sm" onClick={() => setForm({ feedback: iv.id })}>Add feedback</button>
                </div>
              ))}
              {open.notes.map((n: any, i: number) => (
                <p key={i} className="small muted">{people.find((p) => p.id === n.by)?.name}: {n.text}</p>
              ))}
              <div className="pr-row">
                <button type="button" className="btn" onClick={() => setForm('interview')}>Schedule an interview</button>
                <button type="button" className="btn" onClick={() => setForm('note')}>Add a note</button>
                {!open.personId && (
                  <button type="button" className="btn primary" onClick={async () => { const r = await act(api<any>('POST', `/v1/candidates/${open.id}/hire`), `${open.name} hired: write the offer letter next.`); if (r) (await loadWork(), go('onboarding')); }}>
                    Hire
                  </button>
                )}
              </div>
            </>
          }
        />
      )}
      {open && form === 'interview' && (
        <FormDialog
          title={`Interview ${open.name}`}
          onClose={() => setForm(null)}
          fields={[
            { name: 'at', label: 'When', type: 'text', required: true, placeholder: '2030-02-01T15:00', help: 'Date and time' },
            { name: 'minutes', label: 'Minutes', type: 'number' },
            { name: 'location', label: 'Where (or a meeting link)' },
            { name: 'interviewers', label: 'Interviewers', type: 'multiselect', advanced: true, options: people.map((p) => ({ value: p.id, label: p.name })) }
          ]}
          onSubmit={async (v) => (await act(api('POST', `/v1/candidates/${open.id}/interviews`, { ...v, at: new Date(v.at).toISOString(), interviewers: v.interviewers?.length ? v.interviewers : undefined }), 'Scheduled.')) && (setForm(null), setOpen(null), reload())}
        />
      )}
      {open && form === 'note' && (
        <FormDialog title="Add a note" onClose={() => setForm(null)} fields={[{ name: 'text', label: 'Note', type: 'textarea', required: true }]} onSubmit={async (v) => (await act(api('POST', `/v1/candidates/${open.id}/notes`, v), 'Saved.')) && (setForm(null), setOpen(null), reload())} />
      )}
      {open && form && typeof form === 'object' && (
        <FormDialog
          title="Interview feedback"
          onClose={() => setForm(null)}
          fields={[
            { name: 'recommendation', label: 'Recommendation', type: 'select', required: true, options: [{ value: 'strong_yes', label: 'Strong yes' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'strong_no', label: 'Strong no' }] },
            { name: 'notes', label: 'Notes', type: 'textarea' }
          ]}
          onSubmit={async (v) => (await act(api('POST', `/v1/interviews/${form.feedback}/feedback`, v), 'Saved.')) && (setForm(null), setOpen(null), reload())}
        />
      )}
    </Page>
  );
}
