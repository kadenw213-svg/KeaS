import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useWork, can, money, fmtDay, loadWork } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tag, FormDialog, statusTone, human, type Field } from '../kit';

/** Employees: the payroll profile (job, pay rates, raises, tax setup, SSN, address, direct deposit). */
export function Employees() {
  const { people, positions, me } = useWork();
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const shown = people.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  if (sel) return <Profile id={sel} back={() => setSel(null)} />;
  return (
    <Page
      title="Employees"
      lead="Each person’s job, pay rates, tax setup and direct deposit. SSNs and bank details are stored encrypted in the vault."
      actions={
        can(me, 'payroll') && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add a person
          </button>
        )
      }
    >
      <div className="pr-row">
        <input className="pr-input" placeholder="Search by name" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search" />
      </div>
      <Table
        cols={[
          { key: 'name', label: 'Name' },
          { key: 'positions', label: 'Positions', render: (p: any) => p.positions.map((id: string) => positions.find((x) => x.id === id)?.name || id).join(', ') || '—' },
          { key: 'status', label: 'Status', render: (p: any) => <Tag tone={statusTone(p.status)}>{human(p.status)}</Tag> },
          { key: 'payRateCents', label: 'Base rate', render: (p: any) => (p.payRateCents != null ? `${money(p.payRateCents)}/h` : '—') }
        ]}
        rows={shown as any[]}
        onRow={(p: any) => setSel(p.id)}
      />
      {adding && (
        <FormDialog
          title="Add a person"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'hireDate', label: 'Hire date', type: 'date' },
            { name: 'payRateCents', label: 'Pay rate ($ per hour, or per year for salary)', type: 'money' },
            { name: 'payKind', label: 'Paid', type: 'select', required: true, options: [{ value: 'hourly', label: 'Hourly' }, { value: 'salary', label: 'Salary' }] },
            { name: 'workerType', label: 'Worker type', type: 'select', advanced: true, required: true, options: [{ value: 'employee', label: 'Employee (W-2)' }, { value: 'contractor', label: 'Contractor (1099)' }] },
            { name: 'employeeNumber', label: 'Employee number', advanced: true },
            { name: 'birthdate', label: 'Birth date', type: 'date', advanced: true },
            { name: 'positions', label: 'Positions', type: 'multiselect', advanced: true, options: positions.map((p) => ({ value: p.id, label: p.name })) }
          ]}
          initial={{ payKind: 'hourly', workerType: 'employee' }}
          submit="Add"
          onSubmit={async (v) => {
            const r = await act(api<any>('POST', '/v1/people', { ...v, status: 'active' }), `${v.name} added.`);
            if (r) {
              setAdding(false);
              await loadWork();
              setSel(r.profile.id);
            }
          }}
        />
      )}
    </Page>
  );
}

function Profile({ id, back }: { id: string; back: () => void }) {
  const { positions, people, me } = useWork();
  const { data, error, reload } = useLoad<any>(`/v1/people/${id}/profile`);
  const { data: org } = useLoad<any>('/v1/org-structure');
  const { data: grades } = useLoad<any>('/v1/pay-grades');
  const { data: hol } = useLoad<any>('/v1/holidays');
  const [edit, setEdit] = useState<null | 'basic' | 'job' | 'tax' | 'contact' | 'deposit' | 'rate' | 'raise'>(null);
  const [ssn, setSsn] = useState<string | null>(null);
  if (!data) return <Page title="Employee"><Loading error={error} /></Page>;
  const p = data.profile;
  const deptName = (d: string | null) => org?.departments?.find((x: any) => x.id === d)?.name || '—';
  const opt = (list: any[] = [], label = (x: any) => x.name) => list.map((x) => ({ value: x.id, label: label(x) }));
  const save = (path: string) => async (v: any) => {
    if (await act(api('POST', path, v), 'Saved.')) {
      setEdit(null);
      reload();
      loadWork();
    }
  };
  const posName = (pid: string | null) => (pid ? positions.find((x) => x.id === pid)?.name || pid : 'All positions');
  return (
    <Page
      title={p.name}
      lead={`${human(p.workerType)} · ${human(p.status)}${p.hireDate ? ` · hired ${fmtDay(p.hireDate)}` : ''}`}
      actions={
        <button className="btn" onClick={back}>
          All employees
        </button>
      }
    >
      <div className="pr-grid">
        <Card title="Basics" onEdit={() => setEdit('basic')}>
          <dl className="pr-kv">
            <dt>Legal name</dt>
            <dd>{p.legalName || p.name}</dd>
            <dt>Email</dt>
            <dd>{p.email || '—'}</dd>
            <dt>Employee number</dt>
            <dd>{p.employeeNumber || '—'}</dd>
            <dt>Birth date</dt>
            <dd>{p.birthdate ? fmtDay(p.birthdate) : '—'}</dd>
            <dt>Roles</dt>
            <dd>{p.roles.join(', ')}</dd>
          </dl>
        </Card>
        <Card title="Job" onEdit={() => setEdit('job')}>
          <dl className="pr-kv">
            <dt>Department</dt>
            <dd>{deptName(p.departmentId)}</dd>
            <dt>Legal entity</dt>
            <dd>{org?.entities?.find((e: any) => e.id === p.entityId)?.name || 'Default'}</dd>
            <dt>Manager</dt>
            <dd>{people.find((x) => x.id === p.managerId)?.name || '—'}</dd>
            <dt>Labor split</dt>
            <dd>{p.defaultAllocations?.length ? p.defaultAllocations.map((a: any) => `${deptName(a.departmentId)} ${a.pct}%`).join(', ') : 'All to the department'}</dd>
          </dl>
        </Card>
        <Card title="Tax setup" onEdit={() => setEdit('tax')}>
          <dl className="pr-kv">
            <dt>SSN</dt>
            <dd>
              {ssn || p.ssnMasked || 'Not on file'}{' '}
              {p.ssnMasked && !ssn && (
                <button className="btn sm" onClick={async () => setSsn((await act(api<any>('POST', `/v1/people/${id}/reveal-ssn`)))?.ssn || null)}>
                  Show
                </button>
              )}
            </dd>
            <dt>W-4 filing</dt>
            <dd>{p.w4?.filing ? human(p.w4.filing === 'hoh' ? 'head of household' : p.w4.filing) : '—'}{p.w4?.step2 ? ' · Step 2 checked' : ''}{p.w4?.exempt ? ' · exempt' : ''}</dd>
            <dt>Credits / extra</dt>
            <dd>{p.w4 ? `$${p.w4.dependentsCredit || 0} credits · $${p.w4.extraWithholding || 0} extra` : '—'}</dd>
            <dt>State allowance</dt>
            <dd>{p.coAllowance != null ? `$${p.coAllowance}` : 'Table default'}</dd>
          </dl>
        </Card>
        <Card title="Address and phone" onEdit={() => setEdit('contact')}>
          <p>{p.address ? [p.address.line1, p.address.line2, p.address.city, p.address.state, p.address.zip].filter(Boolean).join(', ') : 'No address'}</p>
          <p className="muted">{p.phone || 'No phone'}</p>
        </Card>
        <Card title="Direct deposit" onEdit={() => setEdit('deposit')}>
          {p.deposit.length ? (
            p.deposit.map((a: any, i: number) => (
              <p key={i}>
                {human(a.accountType)} ••••{a.accountLast4} · routing {a.routing} · {a.amountCents != null ? money(a.amountCents) : a.pct != null ? `${a.pct}%` : 'the rest'}
              </p>
            ))
          ) : (
            <p className="muted">No account: paid by check.</p>
          )}
        </Card>
      </div>
      <div className="work-head">
        <h2 className="work-title" style={{ fontSize: 18 }}>
          Pay rates
        </h2>
        <button className="btn" onClick={() => setEdit('rate')}>
          Add a rate
        </button>
        <button className="btn primary" onClick={() => setEdit('raise')}>
          Request a raise
        </button>
      </div>
      <Table
        cols={[
          { key: 'positionId', label: 'For', render: (r: any) => posName(r.positionId) },
          { key: 'rateCents', label: 'Rate', render: (r: any) => (r.kind === 'salary' ? `${money(r.rateCents)} a year` : `${money(r.rateCents)}/h`) },
          { key: 'effectiveFrom', label: 'From', render: (r: any) => fmtDay(r.effectiveFrom) },
          { key: 'effectiveTo', label: 'To', render: (r: any) => (r.effectiveTo ? fmtDay(r.effectiveTo) : 'Now') },
          { key: 'label', label: 'Note' }
        ]}
        rows={p.rates}
        empty="No rates yet. Add the first one."
      />
      {edit === 'basic' && (
        <FormDialog
          title="Basics"
          onClose={() => setEdit(null)}
          initial={p}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'legalName', label: 'Legal name (for tax forms and signatures)' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'hireDate', label: 'Hire date', type: 'date' },
            { name: 'status', label: 'Status', type: 'select', required: true, options: ['active', 'onboarding', 'leave', 'applicant', 'terminated'].map((s) => ({ value: s, label: human(s) })) },
            { name: 'birthdate', label: 'Birth date', type: 'date', advanced: true },
            { name: 'employeeNumber', label: 'Employee number', advanced: true },
            { name: 'workerType', label: 'Worker type', type: 'select', required: true, advanced: true, options: [{ value: 'employee', label: 'Employee (W-2)' }, { value: 'contractor', label: 'Contractor (1099)' }] },
            { name: 'positions', label: 'Positions', type: 'multiselect', advanced: true, options: positions.map((x) => ({ value: x.id, label: x.name })) },
            { name: 'gradeId', label: 'Pay grade', type: 'select', advanced: true, options: opt(grades?.grades, (g) => `${g.code} ${g.name}`) },
            { name: 'holidayCalendarId', label: 'Holiday calendar', type: 'select', advanced: true, options: opt(hol?.calendars) },
            ...(can(me, 'owner') ? [{ name: 'roles', label: 'Roles', type: 'multiselect', advanced: true, options: ['manager', 'payroll', 'owner'].map((r) => ({ value: r, label: human(r) })) } as Field] : [])
          ]}
          onSubmit={save(`/v1/people/${id}/profile`)}
        />
      )}
      {edit === 'job' && (
        <FormDialog
          title="Job"
          onClose={() => setEdit(null)}
          initial={{ ...p, split2: p.defaultAllocations?.[1]?.departmentId, split2pct: p.defaultAllocations?.[1]?.pct, split1pct: p.defaultAllocations?.[0]?.pct }}
          fields={[
            { name: 'departmentId', label: 'Department', type: 'select', options: opt(org?.departments, (d) => d.name) },
            { name: 'managerId', label: 'Manager', type: 'select', options: people.filter((x) => x.id !== id).map((x) => ({ value: x.id, label: x.name })) },
            { name: 'entityId', label: 'Legal entity (EIN)', type: 'select', advanced: true, options: opt(org?.entities) },
            { name: 'split1pct', label: 'Default split: % to the department above', type: 'number', advanced: true, help: 'Leave empty to charge all labor to the department.' },
            { name: 'split2', label: 'Default split: second department', type: 'select', advanced: true, options: opt(org?.departments) },
            { name: 'split2pct', label: 'Default split: % to the second department', type: 'number', advanced: true }
          ]}
          onSubmit={async (v) => {
            const allocs = v.split1pct && v.split2 ? [{ departmentId: v.departmentId, pct: v.split1pct }, { departmentId: v.split2, pct: v.split2pct }] : [];
            await save(`/v1/people/${id}/job`)({ departmentId: v.departmentId, managerId: v.managerId, entityId: v.entityId, defaultAllocations: allocs });
          }}
        />
      )}
      {edit === 'tax' && (
        <FormDialog
          title="Tax setup"
          onClose={() => setEdit(null)}
          initial={{ ...(p.w4 || {}), filing: p.w4?.filing || 'single', coAllowance: p.coAllowance }}
          fields={[
            { name: 'filing', label: 'W-4 filing status', type: 'select', required: true, options: [{ value: 'single', label: 'Single or married filing separately' }, { value: 'married', label: 'Married filing jointly' }, { value: 'hoh', label: 'Head of household' }] },
            { name: 'step2', label: 'Step 2: multiple jobs box checked', type: 'checkbox' },
            { name: 'dependentsCredit', label: 'Step 3: credits ($ a year)', type: 'number' },
            { name: 'extraWithholding', label: 'Step 4(c): extra withholding ($ each pay)', type: 'number' },
            { name: 'ssn', label: 'SSN (leave empty to keep)', placeholder: '123-45-6789' },
            { name: 'otherIncome', label: 'Step 4(a): other income ($ a year)', type: 'number', advanced: true },
            { name: 'deductions', label: 'Step 4(b): deductions ($ a year)', type: 'number', advanced: true },
            { name: 'exempt', label: 'Exempt from federal withholding', type: 'checkbox', advanced: true },
            { name: 'coAllowance', label: 'State withholding allowance ($ a year; empty = table default)', type: 'number', advanced: true }
          ]}
          onSubmit={async (v) => {
            const { ssn: s, coAllowance, ...w4 } = v;
            await save(`/v1/people/${id}/profile`)({ w4, coAllowance, ...(s ? { pii: { ssn: s } } : {}) });
          }}
        />
      )}
      {edit === 'contact' && (
        <FormDialog
          title="Address and phone"
          onClose={() => setEdit(null)}
          initial={{ ...(p.address || {}), phone: p.phone }}
          fields={[
            { name: 'line1', label: 'Street' },
            { name: 'line2', label: 'Apartment, suite' },
            { name: 'city', label: 'City' },
            { name: 'state', label: 'State' },
            { name: 'zip', label: 'ZIP' },
            { name: 'phone', label: 'Phone' }
          ]}
          onSubmit={async (v) => save(`/v1/people/${id}/profile`)({ pii: { address: { line1: v.line1, line2: v.line2, city: v.city, state: v.state, zip: v.zip }, phone: v.phone } })}
        />
      )}
      {edit === 'deposit' && (
        <FormDialog
          title="Direct deposit"
          onClose={() => setEdit(null)}
          initial={{ accountType: 'checking', accountType2: 'savings' }}
          fields={[
            { name: 'routing', label: 'Routing number', required: true },
            { name: 'account', label: 'Account number', required: true },
            { name: 'accountType', label: 'Account type', type: 'select', required: true, options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] },
            { name: 'routing2', label: 'Second account: routing', advanced: true },
            { name: 'account2', label: 'Second account: number', advanced: true },
            { name: 'accountType2', label: 'Second account: type', type: 'select', advanced: true, required: true, options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] },
            { name: 'amount2', label: 'Second account gets this much each pay', type: 'money', advanced: true, help: 'The first account gets the rest.' }
          ]}
          onSubmit={async (v) => {
            const accounts = [...(v.routing2 && v.account2 ? [{ routing: v.routing2, account: v.account2, accountType: v.accountType2, amountCents: v.amount2 }] : []), { routing: v.routing, account: v.account, accountType: v.accountType }];
            await save(`/v1/people/${id}/deposit`)({ accounts });
          }}
        />
      )}
      {edit === 'rate' && (
        <FormDialog
          title="Add a rate"
          onClose={() => setEdit(null)}
          initial={{ kind: 'hourly', effectiveFrom: p.hireDate || '' }}
          fields={[
            { name: 'rateCents', label: 'Rate ($)', type: 'money', required: true },
            { name: 'kind', label: 'Paid', type: 'select', required: true, options: [{ value: 'hourly', label: 'Hourly' }, { value: 'salary', label: 'Salary (a year)' }] },
            { name: 'positionId', label: 'For position (empty = their base rate)', type: 'select', options: positions.map((x) => ({ value: x.id, label: x.name })) },
            { name: 'effectiveFrom', label: 'From', type: 'date' },
            { name: 'label', label: 'Note', advanced: true }
          ]}
          onSubmit={save(`/v1/people/${id}/rates`)}
        />
      )}
      {edit === 'raise' && (
        <FormDialog
          title="Request a raise"
          onClose={() => setEdit(null)}
          fields={[
            { name: 'newRateCents', label: 'New rate ($)', type: 'money', help: 'Or give a percent under Advanced.' },
            { name: 'effectiveDate', label: 'Effective', type: 'date', required: true, help: 'A past date pays the difference for runs already finalized (retro pay).' },
            { name: 'reason', label: 'Reason' },
            { name: 'percent', label: 'Raise by percent', type: 'number', advanced: true },
            { name: 'positionId', label: 'Only for position', type: 'select', advanced: true, options: positions.map((x) => ({ value: x.id, label: x.name })) }
          ]}
          submit="Send for approval"
          onSubmit={async (v) => {
            const r = await act(api<any>('POST', '/v1/raises', { personId: id, ...v, newRateCents: v.newRateCents ?? undefined, percent: v.newRateCents == null ? v.percent : undefined }), 'Sent for approval.');
            if (r) {
              setEdit(null);
              reload();
            }
          }}
        />
      )}
    </Page>
  );
}

function Card({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="card">
      <div className="pr-row" style={{ margin: 0 }}>
        <strong>{title}</strong>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onEdit}>
          Edit
        </button>
      </div>
      {children}
    </div>
  );
}
