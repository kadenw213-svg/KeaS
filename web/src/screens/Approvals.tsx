import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useWork, can } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog, statusTone, human } from '../kit';

type Tab = 'mine' | 'requested' | 'all' | 'chains';
const KIND_LABEL: Record<string, string> = { time_off: 'Time off', timecard: 'Timecards', budget: 'Budget changes', raise: 'Raises', payrun: 'Pay runs', expense: 'Expenses', offer: 'Offer letters' };
const stepText = (s: any, people: any[]) => (s.type === 'role' ? `Any ${s.role}` : s.type === 'person' ? people.find((p) => p.id === s.personId)?.name || 'A person' : s.type === 'manager_of' ? 'Their manager' : 'Department head');

/** Approvals: what’s waiting on me, what I asked for, and the configurable chains. */
export function Approvals() {
  const { me } = useWork();
  const admin = can(me, 'manager') || can(me, 'payroll');
  const [tab, setTab] = useState<Tab>('mine');
  return (
    <Page title="Approvals" lead="Time off, timecards, budget changes, raises, pay runs, expenses and offers each follow a chain of steps you set. Nobody approves their own request.">
      <Tabs
        tabs={[
          { id: 'mine', label: 'Waiting on me' },
          { id: 'requested', label: 'I asked for' },
          ...(admin ? [{ id: 'all' as Tab, label: 'All' }, { id: 'chains' as Tab, label: 'Chains' }] : [])
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'chains' ? <Chains /> : <List scope={tab} />}
    </Page>
  );
}

function List({ scope }: { scope: 'mine' | 'requested' | 'all' }) {
  const { people } = useWork();
  const { data, error, reload } = useLoad<any>(`/v1/approvals?scope=${scope}`);
  const [open, setOpen] = useState<any | null>(null);
  const [comment, setComment] = useState('');
  if (!data) return <Loading error={error} />;
  const decide = async (a: any, approve: boolean) => {
    if (await act(api('POST', `/v1/approvals/${a.id}/decide`, { approve, comment: comment || undefined }), approve ? 'Approved.' : 'Declined.')) {
      setOpen(null);
      setComment('');
      reload();
    }
  };
  return (
    <>
      <Table
        cols={[
          { key: 'title', label: 'Request' },
          { key: 'kind', label: 'Kind', render: (a: any) => KIND_LABEL[a.kind] || a.kind },
          { key: 'requestedByName', label: 'Asked by', render: (a: any) => (a.requestedBy === 'system' ? 'Timecards' : a.requestedByName) },
          { key: 'step', label: 'Step', render: (a: any) => `${Math.min(a.stepIndex + 1, a.steps.length)} of ${a.steps.length}` },
          { key: 'status', label: 'Status', render: (a: any) => <Tag tone={statusTone(a.status)}>{human(a.status)}</Tag> }
        ]}
        rows={data.approvals}
        onRow={setOpen}
        empty={scope === 'mine' ? 'Nothing is waiting on you.' : 'Nothing here.'}
      />
      {open && (
        <FormDialog
          title={open.title}
          onClose={() => setOpen(null)}
          fields={[]}
          submit={scope === 'mine' ? 'Approve' : 'Close'}
          onSubmit={() => (scope === 'mine' ? decide(open, true) : setOpen(null))}
          extra={
            <>
              <div className="pr-steps">
                {open.steps.map((s: any, i: number) => (
                  <Tag key={i} tone={i < open.stepIndex ? 'ok' : i === open.stepIndex && open.status === 'pending' ? 'warn' : undefined}>
                    {i + 1}. {stepText(s, people)}
                  </Tag>
                ))}
              </div>
              {open.detail?.warnings?.length > 0 && <div className="work-banner warn">{open.detail.warnings.join(' ')}</div>}
              {open.actions.map((x: any, i: number) => (
                <p key={i} className="muted small">
                  {x.actorName} {x.decision === 'approve' ? 'approved' : 'declined'} step {x.stepIndex + 1} on {new Date(x.at).toLocaleString()}
                  {x.comment ? `: “${x.comment}”` : ''}
                </p>
              ))}
              {scope === 'mine' && (
                <>
                  <label className="pr-field">
                    <span>Comment (optional)</span>
                    <input value={comment} onChange={(e) => setComment(e.target.value)} />
                  </label>
                  <button type="button" className="btn" onClick={() => decide(open, false)}>
                    <X size={15} /> Decline
                  </button>
                </>
              )}
              {scope === 'requested' && open.status === 'pending' && (
                <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/approvals/${open.id}/cancel`), 'Cancelled.')) && (setOpen(null), reload())}>
                  Cancel the request
                </button>
              )}
            </>
          }
        />
      )}
    </>
  );
}

function Chains() {
  const { people, me } = useWork();
  // Only the owner changes who approves what (payroll and managers can see the chains).
  const owner = can(me, 'owner');
  const { data, error, reload } = useLoad<any>('/v1/approval-chains');
  const { data: org } = useLoad<any>('/v1/org-structure');
  const [edit, setEdit] = useState<any | null>(null);
  if (!data) return <Loading error={error} />;
  const stepOptions = [
    { value: 'manager_of', label: 'Their manager' },
    { value: 'department_head', label: 'Department head' },
    { value: 'role:manager', label: 'Any manager' },
    { value: 'role:payroll', label: 'Any payroll admin' },
    { value: 'role:owner', label: 'The owner' },
    ...people.map((p) => ({ value: `person:${p.id}`, label: p.name }))
  ];
  const toStep = (v: string) => (v.startsWith('role:') ? { type: 'role', role: v.slice(5) } : v.startsWith('person:') ? { type: 'person', personId: v.slice(7) } : { type: v });
  const fromStep = (s: any) => (s.type === 'role' ? `role:${s.role}` : s.type === 'person' ? `person:${s.personId}` : s.type);
  return (
    <>
      <p className="muted">Without a chain, each kind uses its default (shown below). A chain can apply to one department or only above an amount; the most specific one wins.</p>
      {owner ? (
        <div className="pr-row">
          <button className="btn primary" onClick={() => setEdit({ kind: 'time_off' })}>
            <Plus size={15} /> Add a chain
          </button>
        </div>
      ) : (
        <p className="muted small">Only the owner changes approval chains.</p>
      )}
      <Table
        cols={[
          { key: 'kind', label: 'For', render: (c: any) => KIND_LABEL[c.kind] },
          { key: 'name', label: 'Name' },
          { key: 'steps', label: 'Steps', render: (c: any) => c.steps.map((s: any) => stepText(s, people)).join(' → ') },
          { key: 'scope', label: 'Applies', render: (c: any) => [c.departmentId && org?.departments?.find((d: any) => d.id === c.departmentId)?.name, c.minAmountCents != null && `from $${(c.minAmountCents / 100).toFixed(0)}`].filter(Boolean).join(', ') || 'Always' },
          { key: 'active', label: 'On', render: (c: any) => (c.active ? <Check size={15} /> : '') }
        ]}
        rows={data.chains}
        onRow={owner ? (c: any) => setEdit(c) : undefined}
        empty="No chains yet: every kind uses its default."
      />
      <h3 className="work-h2">Defaults</h3>
      <dl className="pr-kv">
        {Object.entries(data.defaults).flatMap(([k, steps]: [string, any]) => [<dt key={k}>{KIND_LABEL[k]}</dt>, <dd key={k + '-d'}>{steps.map((s: any) => stepText(s, people)).join(' → ')}</dd>])}
      </dl>
      {edit && (
        <FormDialog
          title={edit.id ? edit.name : 'Add a chain'}
          onClose={() => setEdit(null)}
          initial={{ ...edit, step1: edit.steps?.[0] && fromStep(edit.steps[0]), step2: edit.steps?.[1] && fromStep(edit.steps[1]), step3: edit.steps?.[2] && fromStep(edit.steps[2]), active: edit.active ?? true }}
          fields={[
            { name: 'kind', label: 'For', type: 'select', required: true, options: data.kinds.map((k: string) => ({ value: k, label: KIND_LABEL[k] })) },
            { name: 'name', label: 'Name', required: true },
            { name: 'step1', label: 'Step 1', type: 'select', required: true, options: stepOptions },
            { name: 'step2', label: 'Step 2', type: 'select', options: stepOptions },
            { name: 'step3', label: 'Step 3', type: 'select', options: stepOptions },
            { name: 'departmentId', label: 'Only for this department', type: 'select', advanced: true, options: (org?.departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
            { name: 'minAmountCents', label: 'Only from this amount', type: 'money', advanced: true },
            { name: 'active', label: 'On', type: 'checkbox', advanced: true }
          ]}
          onSubmit={async (v) => {
            const steps = [v.step1, v.step2, v.step3].filter(Boolean).map(toStep);
            if (await act(api('POST', '/v1/approval-chains', { id: edit.id, kind: v.kind, name: v.name, steps, departmentId: v.departmentId, minAmountCents: v.minAmountCents, active: v.active }), 'Saved.')) {
              setEdit(null);
              reload();
            }
          }}
          extra={edit.id && <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/approval-chains/${edit.id}/delete`), 'Removed.')) && (setEdit(null), reload())}>Remove</button>}
        />
      )}
    </>
  );
}
