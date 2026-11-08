import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useWork, can, fmtDay } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog, statusTone, human } from '../kit';

type Tab = 'balances' | 'requests' | 'policies' | 'holidays' | 'leave';

/** Time off and leave: balances, requests (through approvals), accrual policies, holiday calendars, FMLA and state leave. */
export function TimeOff() {
  const { me } = useWork();
  const admin = can(me, 'payroll'), mgr = can(me, 'manager') || admin;
  const [tab, setTab] = useState<Tab>('requests');
  return (
    <Page title="Time off and leave" lead="Balances come from each policy’s accrual rules. Requests go through the time-off approval chain; protected leave never counts against attendance.">
      <Tabs
        tabs={[
          { id: 'requests', label: 'Requests' },
          { id: 'balances', label: 'Balances' },
          ...(admin ? [{ id: 'policies' as Tab, label: 'Policies' }, { id: 'holidays' as Tab, label: 'Holidays' }] : []),
          ...(mgr ? [{ id: 'leave' as Tab, label: 'FMLA and state leave' }] : [])
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'requests' && <Requests />}
      {tab === 'balances' && <Balances />}
      {tab === 'policies' && <Policies />}
      {tab === 'holidays' && <Holidays />}
      {tab === 'leave' && <Leave />}
    </Page>
  );
}

function Requests() {
  const { me, people } = useWork();
  const mgr = can(me, 'manager') || can(me, 'payroll');
  const { data, reload } = useLoad<any>('/v1/time-off');
  const { data: bal } = useLoad<any>(`/v1/pto/balances${mgr ? '' : `?personId=${me?.id}`}`);
  const { data: cases } = useLoad<any>(mgr ? '/v1/leave-cases' : null);
  const [adding, setAdding] = useState(false);
  const policies = bal?.people?.[0]?.balances || [];
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Request time off
        </button>
      </div>
      <Table
        cols={[
          { key: 'personName', label: 'Person' },
          { key: 'policyName', label: 'Type' },
          { key: 'dates', label: 'Dates', render: (r: any) => `${fmtDay(r.startDate)}${r.endDate !== r.startDate ? ' – ' + fmtDay(r.endDate) : ''}` },
          { key: 'hours', label: 'Hours' },
          { key: 'status', label: 'Status', render: (r: any) => <Tag tone={statusTone(r.status)}>{human(r.status)}</Tag> },
          {
            key: 'act',
            label: '',
            render: (r: any) =>
              ['pending', 'approved'].includes(r.status) && (r.personId === me?.id || mgr) ? (
                <button className="btn sm" onClick={async (e) => (e.stopPropagation(), (await act(api('POST', `/v1/time-off/${r.id}/cancel`), 'Cancelled.')) && reload())}>
                  Cancel
                </button>
              ) : null
          }
        ]}
        rows={data?.requests || []}
        empty="No time-off requests."
      />
      {adding && (
        <FormDialog
          title="Request time off"
          onClose={() => setAdding(false)}
          initial={{ personId: me?.id }}
          fields={[
            ...(mgr ? [{ name: 'personId', label: 'For', type: 'select' as const, required: true, options: people.map((p) => ({ value: p.id, label: p.name })) }] : []),
            { name: 'policyId', label: 'Type', type: 'select', required: true, options: policies.map((b: any) => ({ value: b.policyId, label: `${b.name} (${b.hours} h)` })) },
            { name: 'startDate', label: 'From', type: 'date', required: true },
            { name: 'endDate', label: 'To', type: 'date' },
            { name: 'hours', label: 'Hours', type: 'number', required: true },
            { name: 'note', label: 'Note', advanced: true },
            ...(mgr ? [{ name: 'leaveCaseId', label: 'Part of a leave case', type: 'select' as const, advanced: true, options: (cases?.cases || []).filter((c: any) => c.status === 'open').map((c: any) => ({ value: c.id, label: `${c.personName}: ${c.law}` })) }] : [])
          ]}
          submit="Send for approval"
          onSubmit={async (v) => (await act(api('POST', '/v1/time-off', v), 'Sent for approval.')) && (setAdding(false), reload())}
        />
      )}
    </>
  );
}

function Balances() {
  const { me } = useWork();
  const mgr = can(me, 'manager') || can(me, 'payroll');
  const { data, error, reload } = useLoad<any>(`/v1/pto/balances${mgr ? '' : `?personId=${me?.id}`}`);
  const [adj, setAdj] = useState<any | null>(null);
  if (!data) return <Loading error={error} />;
  const names = [...new Set(data.people.flatMap((p: any) => p.balances.map((b: any) => b.name)))] as string[];
  return (
    <>
      <Table
        cols={[
          { key: 'name', label: 'Person' },
          ...names.map((n) => ({ key: n, label: n, render: (p: any) => { const b = p.balances.find((x: any) => x.name === n); return b ? `${b.hours} h${b.pending ? ` (${b.pending} pending)` : ''}` : '—'; } }))
        ]}
        rows={data.people}
        onRow={can(me, 'payroll') ? (p: any) => setAdj(p) : undefined}
      />
      {adj && (
        <FormDialog
          title={`Adjust ${adj.name}’s balance`}
          onClose={() => setAdj(null)}
          fields={[
            { name: 'policyId', label: 'Policy', type: 'select', required: true, options: adj.balances.map((b: any) => ({ value: b.policyId, label: `${b.name} (${b.hours} h)` })) },
            { name: 'hours', label: 'Hours to add (negative to take away)', type: 'number', required: true },
            { name: 'note', label: 'Why', required: true },
            { name: 'date', label: 'Date', type: 'date', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/pto/adjust', { ...v, personId: adj.id }), 'Balance adjusted.')) && (setAdj(null), reload())}
        />
      )}
    </>
  );
}

function Policies() {
  const { data, reload } = useLoad<any>('/v1/pto/policies');
  const [edit, setEdit] = useState<any | null>(null);
  const describe = (p: any) =>
    p.method === 'per_hour_worked' ? `${p.accrueHours} h per ${p.perHours} h worked` : p.method === 'per_period' ? `${p.perPeriodHours} h each pay period` : p.method === 'annual_grant' ? `${p.annualHours} h each year` : 'Set by hand';
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setEdit({ method: 'per_hour_worked', kind: 'pto', payoutOnTerm: 'state_rule', paid: true, autoEnroll: true, active: true })}>
          <Plus size={15} /> Add a policy
        </button>
        {data?.suggested && (
          <button className="btn" title={data.suggested.why} onClick={() => setEdit({ ...data.suggested })}>
            Start from the state sick-leave rule
          </button>
        )}
      </div>
      {edit?.needsChecking && (
        <p className="muted small">
          Suggested from the law where people work: {edit.why} {(edit.notes || []).join(' ')}
        </p>
      )}
      <Table
        cols={[
          { key: 'name', label: 'Policy' },
          { key: 'accrual', label: 'Accrual', render: describe },
          { key: 'capHours', label: 'Balance cap', render: (p: any) => (p.capHours != null ? `${p.capHours} h` : '—') },
          { key: 'enrolled', label: 'People' },
          { key: 'protected', label: 'Protected', render: (p: any) => (p.protected ? 'Yes' : '') }
        ]}
        rows={data?.policies || []}
        onRow={(p: any) => setEdit(p)}
      />
      {edit && (
        <FormDialog
          title={edit.id ? edit.name : 'Add a policy'}
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'kind', label: 'Kind', type: 'select', required: true, options: ['pto', 'vacation', 'sick', 'personal', 'other'].map((k) => ({ value: k, label: human(k) })) },
            { name: 'method', label: 'Accrues', type: 'select', required: true, options: [{ value: 'per_hour_worked', label: 'Per hour worked' }, { value: 'per_period', label: 'Each pay period' }, { value: 'annual_grant', label: 'Once a year' }, { value: 'none', label: 'Set by hand' }] },
            { name: 'accrueHours', label: 'Hours earned…', type: 'number', step: '0.01' },
            { name: 'perHours', label: '…per hours worked', type: 'number' },
            { name: 'perPeriodHours', label: 'Hours each pay period', type: 'number', step: '0.01' },
            { name: 'annualHours', label: 'Hours each year', type: 'number' },
            { name: 'capHours', label: 'Balance cap (hours)', type: 'number', advanced: true },
            { name: 'annualMaxHours', label: 'Most hours earned in a year', type: 'number', advanced: true },
            { name: 'carryoverMax', label: 'Most hours carried into a new year', type: 'number', advanced: true },
            { name: 'waitingDays', label: 'Waiting period (days after hire)', type: 'number', advanced: true },
            { name: 'payoutOnTerm', label: 'Paid out when someone leaves', type: 'select', required: true, advanced: true, options: [{ value: 'state_rule', label: 'As the state requires' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }] },
            { name: 'allowNegative', label: 'Allow a negative balance', type: 'checkbox', advanced: true },
            { name: 'protected', label: 'Protected leave (never counts against attendance)', type: 'checkbox', advanced: true },
            { name: 'paid', label: 'Paid', type: 'checkbox', advanced: true },
            { name: 'autoEnroll', label: 'Everyone is in this policy', type: 'checkbox', advanced: true },
            { name: 'active', label: 'Active', type: 'checkbox', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/pto/policies', { ...v, id: edit.id }), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </>
  );
}

function Holidays() {
  const { data, reload } = useLoad<any>('/v1/holidays');
  const [edit, setEdit] = useState<any | null>(null);
  const [cal, setCal] = useState(false);
  return (
    <>
      <div className="pr-row">
        <button className="btn" onClick={() => setCal(true)}>
          <Plus size={15} /> Add a calendar
        </button>
      </div>
      {(data?.calendars || []).map((c: any) => (
        <section className="pr-section" key={c.id}>
          <div className="work-head">
            <h2 className="work-title" style={{ fontSize: 18 }}>
              {c.name} {c.isDefault && <Tag tone="ok">Default</Tag>}
            </h2>
            <button className="btn" onClick={() => setEdit({ calendarId: c.id, paidHours: 8, premiumMultiplier: 1 })}>
              Add a holiday
            </button>
          </div>
          <Table
            cols={[
              { key: 'date', label: 'Date', render: (h: any) => fmtDay(h.date) },
              { key: 'name', label: 'Holiday' },
              { key: 'paidHours', label: 'Paid hours' },
              { key: 'premiumMultiplier', label: 'If worked', render: (h: any) => (h.premiumMultiplier > 1 ? `x${h.premiumMultiplier}` : 'Regular pay') }
            ]}
            rows={c.holidays}
            onRow={(h: any) => setEdit({ ...h, calendarId: c.id })}
          />
        </section>
      ))}
      {cal && (
        <FormDialog
          title="Add a holiday calendar"
          onClose={() => setCal(false)}
          fields={[{ name: 'name', label: 'Name', required: true }, { name: 'isDefault', label: 'Default for everyone', type: 'checkbox' }]}
          onSubmit={async (v) => (await act(api('POST', '/v1/holiday-calendars', v), 'Saved.')) && (setCal(false), reload())}
        />
      )}
      {edit && (
        <FormDialog
          title="Holiday"
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'date', label: 'Date', type: 'date', required: true },
            { name: 'paidHours', label: 'Paid hours for hourly staff', type: 'number' },
            { name: 'premiumMultiplier', label: 'Pay multiplier if worked', type: 'number', step: '0.25', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/holidays', { ...v, id: edit.id, calendarId: edit.calendarId }), 'Saved.')) && (setEdit(null), reload())}
          extra={edit.id && <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/holidays/${edit.id}/delete`), 'Removed.')) && (setEdit(null), reload())}>Remove</button>}
        />
      )}
    </>
  );
}

function Leave() {
  const { people } = useWork();
  const { data, reload } = useLoad<any>('/v1/leave-cases');
  const { data: laws } = useLoad<any>('/v1/leave/laws');
  const [adding, setAdding] = useState(false);
  const [elig, setElig] = useState<any | null>(null);
  const [usage, setUsage] = useState<any | null>(null);
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Open a leave case
        </button>
      </div>
      <Table
        cols={[
          { key: 'personName', label: 'Person' },
          { key: 'law', label: 'Law' },
          { key: 'reason', label: 'Reason' },
          { key: 'startDate', label: 'From', render: (c: any) => fmtDay(c.startDate) },
          { key: 'used', label: 'Used / entitled', render: (c: any) => `${c.usedHours} / ${c.entitlementHours} h` },
          { key: 'status', label: 'Status', render: (c: any) => <Tag tone={statusTone(c.status)}>{human(c.status)}</Tag> }
        ]}
        rows={data?.cases || []}
        onRow={(c: any) => setUsage(c)}
        empty="No leave cases."
      />
      {adding && (
        <FormDialog
          title="Open a leave case"
          onClose={() => (setAdding(false), setElig(null))}
          fields={[
            { name: 'personId', label: 'Person', type: 'select', required: true, options: people.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'law', label: 'Law', type: 'select', required: true, options: (laws?.laws || []).map((l: any) => ({ value: l.law, label: l.law })) },
            { name: 'reason', label: 'Reason', required: true },
            { name: 'startDate', label: 'Starts', type: 'date', required: true },
            { name: 'endDate', label: 'Ends (if known)', type: 'date' },
            { name: 'intermittent', label: 'Intermittent', type: 'checkbox', advanced: true },
            { name: 'usualWeeklyHours', label: 'Usual hours a week', type: 'number', advanced: true },
            { name: 'entitlementHours', label: 'Entitlement (hours; empty = from the law)', type: 'number', advanced: true },
            { name: 'notes', label: 'Notes', type: 'textarea', advanced: true }
          ]}
          submit={elig ? 'Open the case' : 'Check eligibility'}
          extra={elig && (
            <div className="card">
              <strong>Eligibility facts</strong>
              <ul>
                {(elig.checks || []).map((c: any, i: number) => (
                  <li key={i}>{c.met ? '✓' : '✗'} {c.label} ({c.value})</li>
                ))}
              </ul>
              <p className="muted small">{elig.note}</p>
            </div>
          )}
          onSubmit={async (v) => {
            if (!elig) {
              const r = await act(api<any>('POST', '/v1/leave/eligibility', { personId: v.personId, law: v.law, asOf: v.startDate }));
              if (r) setElig(r.eligibility);
              return;
            }
            if (await act(api('POST', '/v1/leave-cases', v), 'Leave case opened.')) {
              setAdding(false);
              setElig(null);
              reload();
            }
          }}
        />
      )}
      {usage && (
        <FormDialog
          title={`${usage.personName}: ${usage.law}`}
          onClose={() => setUsage(null)}
          fields={[
            { name: 'date', label: 'Date', type: 'date', required: true },
            { name: 'hours', label: 'Hours of leave', type: 'number', required: true },
            { name: 'note', label: 'Note', advanced: true }
          ]}
          submit="Record leave used"
          extra={usage.status === 'open' && <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/leave-cases/${usage.id}/close`, {}), 'Closed.')) && (setUsage(null), reload())}>Close the case</button>}
          onSubmit={async (v) => (await act(api('POST', `/v1/leave-cases/${usage.id}/usage`, v), 'Recorded.')) && (setUsage(null), reload())}
        />
      )}
    </>
  );
}
