import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useWork, money, fmtDay } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog, statusTone, human, type Field } from '../kit';

type Tab = 'structure' | 'pay' | 'budgets';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Org and pay setup: legal entities, the department tree, cost centers, GL accounts, differentials, grades, budgets. */
export function OrgSetup() {
  const [tab, setTab] = useState<Tab>('structure');
  return (
    <Page title="Org and pay setup" lead="How your organization is set up for payroll: who the employer is, where labor is charged, and how pay is structured.">
      <Tabs
        tabs={[
          { id: 'structure', label: 'Structure' },
          { id: 'pay', label: 'Pay structure' },
          { id: 'budgets', label: 'Budgets' }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'structure' && <Structure />}
      {tab === 'pay' && <PayStructure />}
      {tab === 'budgets' && <Budgets />}
    </Page>
  );
}

function Structure() {
  const { people } = useWork();
  const { data, error, reload } = useLoad<any>('/v1/org-structure');
  const [edit, setEdit] = useState<null | { kind: 'entity' | 'dept' | 'cc' | 'gl'; row?: any }>(null);
  if (!data) return <Loading error={error} />;
  const opt = (l: any[], f = (x: any) => x.name) => l.map((x) => ({ value: x.id, label: f(x) }));
  const done = async (p: Promise<any>) => (await act(p, 'Saved.')) && (setEdit(null), reload());
  const Tree = ({ nodes }: { nodes: any[] }) => (
    <ul className="pr-tree">
      {nodes.map((d) => (
        <li key={d.id}>
          <div>
            <strong>{d.name}</strong>
            {d.code && <span className="muted">{d.code}</span>}
            <span className="muted small">{data.departments.find((x: any) => x.id === d.id)?.headcount ?? 0} people</span>
            {d.costCenterId && <Tag>{data.costCenters.find((c: any) => c.id === d.costCenterId)?.code}</Tag>}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ kind: 'dept', row: d })}>
              Edit
            </button>
            <button className="btn sm" onClick={() => setEdit({ kind: 'dept', row: { parentId: d.id } })}>
              Add inside
            </button>
          </div>
          {d.children.length > 0 && <Tree nodes={d.children} />}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>Legal entities</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'entity' })}>
            <Plus size={15} /> Add an entity
          </button>
        </div>
        <Table
          cols={[
            { key: 'name', label: 'Name', render: (e: any) => <>{e.name} {e.isDefault && <Tag tone="ok">Default</Tag>}</> },
            { key: 'ein', label: 'EIN' },
            { key: 'state', label: 'State' },
            { key: 'bankSet', label: 'Company bank', render: (e: any) => (e.bankSet ? 'Set' : '—') }
          ]}
          rows={data.entities}
          onRow={(e: any) => setEdit({ kind: 'entity', row: e })}
          empty="No legal entities yet. Add your employer (name and EIN)."
        />
      </section>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>Departments</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'dept', row: {} })}>
            <Plus size={15} /> Add a department
          </button>
        </div>
        {data.tree.length ? <Tree nodes={data.tree} /> : <p className="muted">No departments yet.</p>}
      </section>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>Cost centers</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'cc' })}>
            <Plus size={15} /> Add a cost center
          </button>
        </div>
        <Table cols={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'glSegment', label: 'GL segment' }]} rows={data.costCenters} onRow={(c: any) => setEdit({ kind: 'cc', row: c })} />
      </section>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>GL accounts</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'gl' })}>
            Edit
          </button>
        </div>
        <dl className="pr-kv">
          {Object.entries(data.glAccounts).flatMap(([k, v]) => [
            <dt key={k}>{human(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</dt>,
            <dd key={k + '-v'}>{String(v)}</dd>
          ])}
        </dl>
      </section>
      {edit?.kind === 'entity' && (
        <FormDialog
          title={edit.row ? 'Legal entity' : 'Add a legal entity'}
          onClose={() => setEdit(null)}
          initial={{ ...(edit.row || {}), ...(edit.row?.address || {}) }}
          fields={[
            { name: 'name', label: 'Legal name', required: true },
            { name: 'ein', label: 'EIN', placeholder: '12-3456789' },
            { name: 'state', label: 'State' },
            { name: 'isDefault', label: 'Default employer for new people', type: 'checkbox' },
            { name: 'line1', label: 'Street', advanced: true },
            { name: 'city', label: 'City', advanced: true },
            { name: 'addrState', label: 'Address state', advanced: true },
            { name: 'zip', label: 'ZIP', advanced: true },
            { name: 'stateId', label: 'State withholding account number', advanced: true },
            { name: 'bankName', label: 'Company name on bank file', advanced: true },
            { name: 'companyId', label: 'Bank company ID (often 1 + EIN)', advanced: true },
            { name: 'originRouting', label: 'Your bank’s routing number', advanced: true },
            { name: 'destinationName', label: 'Your bank’s name', advanced: true }
          ]}
          onSubmit={(v) =>
            done(
              api('POST', '/v1/entities', {
                id: edit.row?.id,
                name: v.name,
                ein: v.ein,
                state: v.state,
                isDefault: v.isDefault,
                address: { line1: v.line1, city: v.city, state: v.addrState, zip: v.zip },
                stateIds: v.stateId ? { [String(v.state || '').toUpperCase()]: v.stateId } : undefined,
                bank: v.originRouting ? { name: v.bankName || v.name, companyId: v.companyId, originRouting: v.originRouting, destinationName: v.destinationName } : undefined
              })
            )
          }
        />
      )}
      {edit?.kind === 'dept' && (
        <FormDialog
          title={edit.row?.id ? 'Department' : 'Add a department'}
          onClose={() => setEdit(null)}
          initial={edit.row || {}}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'parentId', label: 'Inside', type: 'select', options: opt(data.departments.filter((d: any) => d.id !== edit.row?.id)) },
            { name: 'headPersonId', label: 'Head (approves for this department)', type: 'select', options: people.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'code', label: 'Code', advanced: true },
            { name: 'costCenterId', label: 'Cost center', type: 'select', advanced: true, options: opt(data.costCenters, (c) => `${c.code} ${c.name}`) },
            { name: 'entityId', label: 'Legal entity', type: 'select', advanced: true, options: opt(data.entities) },
            { name: 'location', label: 'Location', advanced: true }
          ]}
          onSubmit={(v) => done(api('POST', '/v1/departments', { ...v, id: edit.row?.id }))}
          extra={
            edit.row?.id && (
              <button type="button" className="btn" onClick={() => done(api('POST', `/v1/departments/${edit.row.id}/delete`))}>
                Delete department
              </button>
            )
          }
        />
      )}
      {edit?.kind === 'cc' && (
        <FormDialog
          title="Cost center"
          onClose={() => setEdit(null)}
          initial={edit.row || {}}
          fields={[
            { name: 'code', label: 'Code', required: true },
            { name: 'name', label: 'Name', required: true },
            { name: 'glSegment', label: 'GL segment', advanced: true }
          ]}
          onSubmit={(v) => done(api('POST', '/v1/cost-centers', { ...v, id: edit.row?.id }))}
        />
      )}
      {edit?.kind === 'gl' && (
        <FormDialog
          title="GL accounts"
          onClose={() => setEdit(null)}
          initial={data.glAccounts}
          fields={Object.keys(data.glAccounts).map((k): Field => ({ name: k, label: human(k.replace(/([A-Z])/g, ' $1').toLowerCase()), required: true }))}
          onSubmit={(v) => done(api('POST', '/v1/org/gl-accounts', v))}
        />
      )}
    </>
  );
}

function PayStructure() {
  const { positions } = useWork();
  const diffs = useLoad<any>('/v1/differentials');
  const grades = useLoad<any>('/v1/pay-grades');
  const raises = useLoad<any>('/v1/raises');
  const [edit, setEdit] = useState<null | { kind: 'diff' | 'grade'; row?: any }>(null);
  const done = async (p: Promise<any>) => (await act(p, 'Saved.')) && (setEdit(null), diffs.reload(), grades.reload());
  return (
    <>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>Shift differentials</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'diff' })}>
            <Plus size={15} /> Add
          </button>
        </div>
        {!diffs.data ? (
          <Loading error={diffs.error} />
        ) : (
          <Table
            cols={[
              { key: 'name', label: 'Name' },
              { key: 'amount', label: 'Extra', render: (d: any) => (d.kind === 'percent' ? `${d.amount}%` : `${money(d.amount)}/h`) },
              { key: 'when', label: 'When', render: (d: any) => `${d.days.map((x: number) => DAYS[x]).join(' ')} ${hhmm(d.startMin)}–${hhmm(d.endMin)}` },
              { key: 'active', label: 'On', render: (d: any) => (d.active ? 'Yes' : 'No') }
            ]}
            rows={diffs.data.differentials}
            onRow={(d: any) => setEdit({ kind: 'diff', row: d })}
            empty="No differentials. Add one for nights, weekends or a position."
          />
        )}
      </section>
      <section className="pr-section">
        <div className="work-head">
          <h2 className="work-title" style={{ fontSize: 18 }}>Pay grades and bands</h2>
          <button className="btn" onClick={() => setEdit({ kind: 'grade' })}>
            <Plus size={15} /> Add
          </button>
        </div>
        {!grades.data ? (
          <Loading error={grades.error} />
        ) : (
          <Table
            cols={[
              { key: 'code', label: 'Grade', render: (g: any) => `${g.code} ${g.name}` },
              { key: 'band', label: 'Band', render: (g: any) => `${money(g.minCents)} – ${money(g.maxCents)}${g.kind === 'salary' ? ' a year' : '/h'}` },
              { key: 'people', label: 'People', render: (g: any) => g.people.map((p: any) => `${p.name}${p.position !== 'within' ? ` (${p.position})` : ''}`).join(', ') || '—' }
            ]}
            rows={grades.data.grades}
            onRow={(g: any) => setEdit({ kind: 'grade', row: g })}
          />
        )}
      </section>
      <section className="pr-section">
        <h2 className="work-title" style={{ fontSize: 18 }}>Raises</h2>
        <p className="muted small">Request a raise from an employee’s page. Approved raises with a past date add retro pay to the next run.</p>
        <Table
          cols={[
            { key: 'personName', label: 'Person' },
            { key: 'change', label: 'Change', render: (r: any) => `${r.oldRateCents != null ? money(r.oldRateCents) + ' → ' : ''}${money(r.newRateCents)}` },
            { key: 'effectiveDate', label: 'Effective', render: (r: any) => fmtDay(r.effectiveDate) },
            { key: 'status', label: 'Status', render: (r: any) => <Tag tone={statusTone(r.status)}>{human(r.status)}</Tag> },
            { key: 'retroCents', label: 'Retro pay', render: (r: any) => (r.retroCents ? money(r.retroCents) : '—') }
          ]}
          rows={raises.data?.raises || []}
        />
      </section>
      {edit?.kind === 'diff' && (
        <FormDialog
          title="Shift differential"
          onClose={() => setEdit(null)}
          initial={edit.row ? { ...edit.row, amount: edit.row.kind === 'per_hour' ? edit.row.amount : edit.row.amount, start: hhmm(edit.row.startMin), end: hhmm(edit.row.endMin), days: edit.row.days.map(String) } : { kind: 'per_hour', days: ['0', '1', '2', '3', '4', '5', '6'], start: '22:00', end: '06:00', active: true }}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'kind', label: 'Extra pay as', type: 'select', required: true, options: [{ value: 'per_hour', label: 'Cents per hour' }, { value: 'percent', label: 'Percent of the rate' }] },
            { name: 'amount', label: 'Amount (cents per hour, or percent)', type: 'number', required: true },
            { name: 'start', label: 'From', type: 'time' },
            { name: 'end', label: 'To', type: 'time', help: 'An end before the start runs past midnight.' },
            { name: 'days', label: 'Days', type: 'multiselect', advanced: true, options: DAYS.map((d, i) => ({ value: String(i), label: d })) },
            { name: 'positionIds', label: 'Only these positions', type: 'multiselect', advanced: true, options: positions.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'active', label: 'On', type: 'checkbox', advanced: true }
          ]}
          onSubmit={(v) => done(api('POST', '/v1/differentials', { ...v, id: edit.row?.id, days: (v.days || []).map(Number) }))}
        />
      )}
      {edit?.kind === 'grade' && (
        <FormDialog
          title="Pay grade"
          onClose={() => setEdit(null)}
          initial={edit.row || { kind: 'hourly' }}
          fields={[
            { name: 'code', label: 'Code', required: true },
            { name: 'name', label: 'Name', required: true },
            { name: 'minCents', label: 'Band minimum', type: 'money', required: true },
            { name: 'maxCents', label: 'Band maximum', type: 'money', required: true },
            { name: 'midCents', label: 'Midpoint', type: 'money', advanced: true },
            { name: 'kind', label: 'Band is', type: 'select', advanced: true, required: true, options: [{ value: 'hourly', label: 'Per hour' }, { value: 'salary', label: 'A year' }] }
          ]}
          onSubmit={(v) => done(api('POST', '/v1/pay-grades', { ...v, id: edit.row?.id }))}
        />
      )}
    </>
  );
}

function Budgets() {
  const { data, reload } = useLoad<any>('/v1/budgets');
  const { data: org } = useLoad<any>('/v1/org-structure');
  const [adding, setAdding] = useState(false);
  const dn = (id: string) => org?.departments?.find((d: any) => d.id === id)?.name || org?.costCenters?.find((c: any) => c.id === id)?.name || '—';
  return (
    <>
      <div className="work-head">
        <p className="muted" style={{ margin: 0, flex: 1 }}>Labor budgets per department or cost center. Each change is a new version that goes through approval; reports compare the approved version with actual cost.</p>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> New budget version
        </button>
      </div>
      <Table
        cols={[
          { key: 'for', label: 'For', render: (b: any) => dn(b.departmentId || b.costCenterId) },
          { key: 'period', label: 'Period', render: (b: any) => `${fmtDay(b.periodStart)} – ${fmtDay(b.periodEnd)}` },
          { key: 'amountCents', label: 'Amount', money: true },
          { key: 'version', label: 'Version', render: (b: any) => `v${b.version} ${b.label || ''}` },
          { key: 'status', label: 'Status', render: (b: any) => <Tag tone={statusTone(b.status)}>{human(b.status)}</Tag> }
        ]}
        rows={data?.budgets || []}
        empty="No budgets yet."
      />
      {adding && (
        <FormDialog
          title="New budget version"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'departmentId', label: 'Department', type: 'select', options: (org?.departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
            { name: 'periodStart', label: 'From', type: 'date', required: true },
            { name: 'periodEnd', label: 'To', type: 'date', required: true },
            { name: 'amountCents', label: 'Labor budget', type: 'money', required: true },
            { name: 'costCenterId', label: 'Or a cost center', type: 'select', advanced: true, options: (org?.costCenters || []).map((c: any) => ({ value: c.id, label: `${c.code} ${c.name}` })) },
            { name: 'label', label: 'Label', advanced: true, placeholder: 'Original, Revised…' }
          ]}
          submit="Send for approval"
          onSubmit={async (v) => (await act(api('POST', '/v1/budgets', v), 'Sent for approval.')) && (setAdding(false), reload())}
        />
      )}
    </>
  );
}
