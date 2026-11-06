import { useState, type ReactNode } from 'react';
import { Check, Plus } from 'lucide-react';
import { useWork, fmtDay, money, loadWork } from '../store';
import { api } from '../api';
import { act, download, useLoad, Loading, Page, Table, Tabs, Tag, ESign, FormDialog, Form, statusTone, human } from '../kit';

type Tab = 'onboarding' | 'offers' | 'i9' | 'policies' | 'newhire' | 'offboarding';

/** Onboarding (offer, W-4 and state form, I-9, direct deposit, policies, new-hire report) and offboarding. */
export function Onboarding() {
  const [tab, setTab] = useState<Tab>('onboarding');
  return (
    <Page title="Onboarding and offboarding" lead="Forms are signed by typing a name, with the time and a fingerprint of what was signed kept on file. The I-9 document check is done by a person looking at the originals.">
      <Tabs
        tabs={[
          { id: 'onboarding', label: 'New hires' },
          { id: 'offers', label: 'Offer letters' },
          { id: 'i9', label: 'I-9' },
          { id: 'policies', label: 'Policies' },
          { id: 'newhire', label: 'New-hire report' },
          { id: 'offboarding', label: 'Offboarding' }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'onboarding' && <NewHires />}
      {tab === 'offers' && <Offers />}
      {tab === 'i9' && <I9List />}
      {tab === 'policies' && <Policies />}
      {tab === 'newhire' && <NewHireReport />}
      {tab === 'offboarding' && <Offboarding />}
    </Page>
  );
}

function NewHires() {
  const { people } = useWork();
  const { data, reload } = useLoad<any>('/v1/onboarding');
  const [sel, setSel] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  if (sel) return <Checklist personId={sel} back={() => (setSel(null), reload())} />;
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setStart(true)}>
          <Plus size={15} /> Start onboarding
        </button>
      </div>
      <Table
        cols={[
          { key: 'name', label: 'Person' },
          { key: 'hireDate', label: 'Starts', render: (p: any) => (p.hireDate ? fmtDay(p.hireDate) : '—') },
          { key: 'progress', label: 'Done', render: (p: any) => `${p.done} of ${p.total}` },
          { key: 'overdue', label: 'Overdue', render: (p: any) => (p.overdue ? <Tag tone="bad">{p.overdue}</Tag> : '') }
        ]}
        rows={data?.people || []}
        onRow={(p: any) => setSel(p.id)}
        empty="Nobody is being onboarded."
      />
      {start && (
        <FormDialog
          title="Start onboarding"
          onClose={() => setStart(false)}
          fields={[
            { name: 'personId', label: 'Person', type: 'select', required: true, options: people.filter((p) => p.status !== 'terminated').map((p) => ({ value: p.id, label: p.name })) },
            { name: 'startDate', label: 'First day', type: 'date', required: true },
            { name: 'task1', label: 'Extra task', advanced: true },
            { name: 'task2', label: 'Extra task', advanced: true }
          ]}
          onSubmit={async (v) => {
            const r = await act(api<any>('POST', '/v1/onboarding/start', { personId: v.personId, startDate: v.startDate, extraTasks: [v.task1, v.task2].filter(Boolean).map((t) => ({ title: t })) }), 'Onboarding started.');
            if (r) {
              setStart(false);
              setSel(v.personId);
            }
          }}
        />
      )}
    </>
  );
}

function Checklist({ personId, back }: { personId: string; back: () => void }) {
  const { data, error, reload } = useLoad<any>(`/v1/onboarding/${personId}`);
  const [form, setForm] = useState<null | 'w4' | 'state' | 'i9a' | 'i9b' | 'deposit' | string>(null);
  if (!data) return <Loading error={error} />;
  const name = data.person.legalName || data.person.name;
  const today = new Date().toISOString().slice(0, 10);
  const opener: Record<string, string> = { w4: 'w4', state_w4: 'state', i9_section1: 'i9a', i9_section2: 'i9b', deposit: 'deposit', policies: 'policies' };
  const done = () => (setForm(null), reload());
  return (
    <>
      <div className="work-head">
        <h2 className="work-title" style={{ fontSize: 20 }}>
          {data.person.name}
        </h2>
        <button className="btn" onClick={back}>
          All new hires
        </button>
        <button
          className="btn primary"
          disabled={!data.tasks.filter((t: any) => t.kind !== 'new_hire_report').every((t: any) => t.status === 'done')}
          onClick={async () => (await act(api('POST', `/v1/onboarding/${personId}/complete`, {}), 'Onboarding complete.')) && (loadWork(), back())}
        >
          Finish onboarding
        </button>
      </div>
      <ul className="pr-checklist">
        {data.tasks.map((t: any) => (
          <li key={t.id} className={t.status === 'done' ? 'done' : ''}>
            {t.status === 'done' ? <Check size={16} /> : <span style={{ width: 16 }} />}
            <span>{t.title}</span>
            {t.status !== 'done' && opener[t.kind] && (
              <button className="btn sm" onClick={() => setForm(opener[t.kind])}>
                Open
              </button>
            )}
            {t.status !== 'done' && !opener[t.kind] && t.kind !== 'offer' && (
              <button className="btn sm" onClick={async () => (await act(api('POST', `/v1/onboarding/tasks/${t.id}/done`, {}))) && reload()}>
                Mark done
              </button>
            )}
            {t.due && <span className={`pr-due ${t.status !== 'done' && t.due < today ? 'late' : 'muted'}`}>due {fmtDay(t.due)}</span>}
          </li>
        ))}
      </ul>
      {form === 'w4' && (
        <FormDialog
          title="Form W-4 (federal withholding)"
          onClose={() => setForm(null)}
          initial={{ filing: 'single' }}
          fields={[
            { name: 'legalName', label: 'Legal name', required: true },
            { name: 'ssn', label: 'SSN', required: true },
            { name: 'filing', label: 'Step 1(c): filing status', type: 'select', required: true, options: [{ value: 'single', label: 'Single or married filing separately' }, { value: 'married', label: 'Married filing jointly' }, { value: 'hoh', label: 'Head of household' }] },
            { name: 'line1', label: 'Street address' },
            { name: 'city', label: 'City' },
            { name: 'state', label: 'State' },
            { name: 'zip', label: 'ZIP' },
            { name: 'step2', label: 'Step 2(c): multiple jobs box', type: 'checkbox' },
            { name: 'dependentsCredit', label: 'Step 3: dependents credit ($)', type: 'number' },
            { name: 'otherIncome', label: 'Step 4(a): other income ($)', type: 'number', advanced: true },
            { name: 'deductions', label: 'Step 4(b): deductions ($)', type: 'number', advanced: true },
            { name: 'extraWithholding', label: 'Step 4(c): extra withholding each pay ($)', type: 'number', advanced: true },
            { name: 'exempt', label: 'Claims exemption from withholding', type: 'checkbox', advanced: true }
          ]}
          submit="Continue to signing"
          onSubmit={(v) => setForm('sign-w4:' + JSON.stringify(v))}
        />
      )}
      {form?.startsWith('sign-w4:') && (
        <SignDialog
          title="Sign the W-4"
          name={name}
          onClose={() => setForm(null)}
          onSign={async (typedName) => {
            const v = JSON.parse(form.slice(8));
            const data = { ...v, address: v.line1 ? { line1: v.line1, city: v.city, state: v.state, zip: v.zip } : null };
            (await act(api('POST', '/v1/forms/w4', { personId, typedName, consent: true, data }), 'W-4 signed.')) && done();
          }}
        />
      )}
      {form === 'state' && (
        <FormDialog
          title={`State withholding form (${data.stateForm})`}
          onClose={() => setForm(null)}
          fields={[
            { name: 'annualAllowance', label: 'Annual withholding allowance ($; empty = the default for their W-4 status)', type: 'number' },
            { name: 'extraWithholding', label: 'Extra withholding each pay ($)', type: 'number', advanced: true },
            { name: 'exempt', label: 'Claims exemption', type: 'checkbox', advanced: true }
          ]}
          submit="Continue to signing"
          onSubmit={(v) => setForm('sign-state:' + JSON.stringify(v))}
        />
      )}
      {form?.startsWith('sign-state:') && (
        <SignDialog title="Sign the state form" name={name} onClose={() => setForm(null)} onSign={async (typedName) => (await act(api('POST', '/v1/forms/state', { personId, typedName, consent: true, data: JSON.parse(form.slice(11)) }), 'Signed.')) && done()} />
      )}
      {form === 'i9a' && <I9Section1 personId={personId} name={name} onClose={() => setForm(null)} onDone={done} />}
      {form === 'i9b' && <I9Section2 personId={personId} onClose={() => setForm(null)} onDone={done} />}
      {form === 'deposit' && (
        <FormDialog
          title="Direct deposit"
          onClose={() => setForm(null)}
          initial={{ accountType: 'checking' }}
          fields={[
            { name: 'routing', label: 'Routing number', required: true },
            { name: 'account', label: 'Account number', required: true },
            { name: 'accountType', label: 'Type', type: 'select', required: true, options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] }
          ]}
          onSubmit={async (v) => (await act(api('POST', `/v1/people/${personId}/deposit`, v), 'Saved.')) && done()}
        />
      )}
      {form === 'policies' && <PolicyAcks personId={personId} name={name} onClose={() => setForm(null)} onDone={done} pending={data.policies.filter((p: any) => !p.acknowledged)} />}
    </>
  );
}

function SignDialog({ title, name, onClose, onSign, children }: { title: string; name: string; onClose: () => void; onSign: (typed: string) => Promise<unknown>; children?: ReactNode }) {
  return (
    <FormDialog title={title} onClose={onClose} fields={[]} submit="Close" onSubmit={onClose} extra={<>{children}<ESign name={name} onSign={onSign} /></>} />
  );
}

function I9Section1({ personId, name, onClose, onDone }: { personId: string; name: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<any | null>(null);
  if (v)
    return (
      <SignDialog title="Sign I-9 Section 1" name={name} onClose={onClose} onSign={async (typedName) => (await act(api('POST', `/v1/i9/${personId}/section1`, { ...v, typedName, consent: true }), 'Section 1 signed.')) && onDone()}>
        <p className="muted">I attest, under penalty of perjury, that the status I chose is true.</p>
      </SignDialog>
    );
  return (
    <FormDialog
      title="I-9 Section 1 (the employee fills this in)"
      onClose={onClose}
      fields={[
        { name: 'attestation', label: 'I am', type: 'select', required: true, options: [{ value: 'citizen', label: 'A citizen of the United States' }, { value: 'noncitizen_national', label: 'A noncitizen national of the United States' }, { value: 'permanent_resident', label: 'A lawful permanent resident' }, { value: 'authorized_alien', label: 'A noncitizen authorized to work' }] },
        { name: 'uscisNumber', label: 'USCIS / A-Number (if asked)' },
        { name: 'workAuthExpires', label: 'Work authorization ends (if it does)', type: 'date' }
      ]}
      submit="Continue to signing"
      onSubmit={setV}
    />
  );
}

function I9Section2({ personId, onClose, onDone }: { personId: string; onClose: () => void; onDone: () => void }) {
  const { me } = useWork();
  const [v, setV] = useState<any | null>(null);
  if (v)
    return (
      <SignDialog title="Sign I-9 Section 2" name={me?.name || ''} onClose={onClose} onSign={async (typedName) => (await act(api('POST', `/v1/i9/${personId}/section2`, { ...v, typedName, consent: true, examinedOriginals: true }), 'I-9 complete.')) && onDone()}>
        <p className="muted">I attest that I examined the original documents presented, that they appear genuine and relate to the employee.</p>
      </SignDialog>
    );
  return (
    <FormDialog
      title="I-9 Section 2 (you check the original documents in person)"
      onClose={onClose}
      initial={{ list: 'A' }}
      fields={[
        { name: 'list', label: 'Documents presented', type: 'select', required: true, options: [{ value: 'A', label: 'One List A document' }, { value: 'BC', label: 'One List B and one List C document' }] },
        { name: 'title1', label: 'Document title (List A or B)', required: true, placeholder: 'U.S. Passport' },
        { name: 'number1', label: 'Document number' },
        { name: 'expires1', label: 'Expires', type: 'date' },
        { name: 'title2', label: 'List C document title', placeholder: 'Social Security card' },
        { name: 'number2', label: 'List C document number' },
        { name: 'firstDay', label: 'First day of work', type: 'date', advanced: true },
        { name: 'examinerTitle', label: 'Your title', advanced: true },
        { name: 'checked', label: 'I physically examined the original documents', type: 'checkbox', required: true }
      ]}
      submit="Continue to signing"
      onSubmit={(x) => {
        if (!x.checked) return;
        const documents = x.list === 'A' ? [{ list: 'A', title: x.title1, number: x.number1, expires: x.expires1 }] : [{ list: 'B', title: x.title1, number: x.number1, expires: x.expires1 }, { list: 'C', title: x.title2, number: x.number2 }];
        setV({ documents, firstDay: x.firstDay || undefined, examinerTitle: x.examinerTitle || undefined });
      }}
    />
  );
}

function PolicyAcks({ personId, name, pending, onClose, onDone }: { personId: string; name: string; pending: any[]; onClose: () => void; onDone: () => void }) {
  const { data } = useLoad<any>('/v1/policies');
  const p = pending[0] && data?.policies?.find((x: any) => x.id === pending[0].id);
  if (!p) return null;
  return (
    <SignDialog title={`${p.title} (version ${p.version})`} name={name} onClose={onClose} onSign={async (typedName) => (await act(api('POST', `/v1/policies/${p.id}/ack`, { personId, typedName, consent: true }), 'Acknowledged.')) && onDone()}>
      <div className="pr-doc">{p.body}</div>
    </SignDialog>
  );
}

function Offers() {
  const { people, positions } = useWork();
  const { data, reload } = useLoad<any>('/v1/offers');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any | null>(null);
  const nm = (id: string) => people.find((p) => p.id === id)?.name || 'New person';
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Write an offer
        </button>
      </div>
      <Table
        cols={[
          { key: 'personId', label: 'Person', render: (o: any) => nm(o.personId) },
          { key: 'title', label: 'Job' },
          { key: 'rateCents', label: 'Pay', render: (o: any) => `${money(o.rateCents)}${o.kind === 'salary' ? ' a year' : '/h'}` },
          { key: 'startDate', label: 'Starts', render: (o: any) => fmtDay(o.startDate) },
          { key: 'status', label: 'Status', render: (o: any) => <Tag tone={statusTone(o.status)}>{human(o.status)}</Tag> }
        ]}
        rows={data?.offers || []}
        onRow={setOpen}
        empty="No offers yet."
      />
      {adding && (
        <FormDialog
          title="Write an offer"
          onClose={() => setAdding(false)}
          initial={{ kind: 'hourly', body: data?.template }}
          fields={[
            { name: 'personId', label: 'Person (or a new name below)', type: 'select', options: people.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'name', label: 'New person’s name' },
            { name: 'title', label: 'Job title', required: true },
            { name: 'rateCents', label: 'Pay ($)', type: 'money', required: true },
            { name: 'kind', label: 'Paid', type: 'select', required: true, options: [{ value: 'hourly', label: 'Hourly' }, { value: 'salary', label: 'Salary (a year)' }] },
            { name: 'startDate', label: 'Start date', type: 'date', required: true },
            { name: 'positionId', label: 'Position', type: 'select', advanced: true, options: positions.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'email', label: 'New person’s email', advanced: true },
            { name: 'body', label: 'Letter ({{name}}, {{title}}, {{rate}}, {{startDate}} and {{org}} are filled in)', type: 'textarea', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/offers', v), 'Offer written.')) && (setAdding(false), reload(), loadWork())}
        />
      )}
      {open && (
        <FormDialog
          title={`${open.title}: ${nm(open.personId)}`}
          onClose={() => setOpen(null)}
          fields={[]}
          submit="Close"
          onSubmit={() => setOpen(null)}
          extra={
            <>
              <div className="pr-doc">{open.body}</div>
              {open.signature && <p className="muted small">Signed by {open.signature.typedName}, {new Date(open.signature.signedAt).toLocaleString()} · SHA-256 {open.signature.hash.slice(0, 16)}…</p>}
              <div className="pr-row">
                <button type="button" className="btn" onClick={() => download(`/v1/offers/${open.id}/pdf`)}>
                  PDF
                </button>
                {open.status === 'draft' && (
                  <button type="button" className="btn primary" onClick={async () => (await act(api('POST', `/v1/offers/${open.id}/send`), 'Offer ready to sign.')) && (setOpen(null), reload())}>
                    Send
                  </button>
                )}
                {open.status === 'sent' && (
                  <button type="button" className="btn" onClick={async () => (await act(api('POST', `/v1/offers/${open.id}/sign`, { decline: true }), 'Declined.')) && (setOpen(null), reload())}>
                    They declined
                  </button>
                )}
              </div>
              {open.status === 'sent' && <ESign name={nm(open.personId)} label="Accept and sign" onSign={async (typedName) => (await act(api('POST', `/v1/offers/${open.id}/sign`, { typedName, consent: true }), 'Offer accepted.')) && (setOpen(null), reload())} />}
            </>
          }
        />
      )}
    </>
  );
}

function I9List() {
  const { data, error } = useLoad<any>('/v1/i9');
  if (!data) return <Loading error={error} />;
  return (
    <Table
      cols={[
        { key: 'name', label: 'Person' },
        { key: 'status', label: 'Status', render: (p: any) => <Tag tone={p.status === 'complete' ? 'ok' : p.overdue ? 'bad' : 'warn'}>{human(p.status)}</Tag> },
        { key: 'section2Due', label: 'Section 2 due', render: (p: any) => (p.section2Due ? fmtDay(p.section2Due) : '—') },
        { key: 'reverifyDate', label: 'Reverify by', render: (p: any) => (p.reverifyDate ? <span className={p.reverifySoon ? 'pr-due late' : ''}>{fmtDay(p.reverifyDate)}</span> : '—') }
      ]}
      rows={data.people}
    />
  );
}

function Policies() {
  const { data, reload } = useLoad<any>('/v1/policies');
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setEdit({ required: true })}>
          <Plus size={15} /> Add a policy
        </button>
      </div>
      <Table
        cols={[
          { key: 'title', label: 'Policy' },
          { key: 'version', label: 'Version' },
          { key: 'acknowledged', label: 'Signed', render: (p: any) => `${p.acknowledged} of ${p.people}` },
          { key: 'required', label: 'Required', render: (p: any) => (p.required ? 'Yes' : 'No') }
        ]}
        rows={data?.policies || []}
        onRow={setEdit}
      />
      {edit && (
        <FormDialog
          title={edit.id ? edit.title : 'Add a policy'}
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            { name: 'title', label: 'Title', required: true },
            { name: 'body', label: 'Text (changing it makes a new version everyone signs again)', type: 'textarea', required: true },
            { name: 'required', label: 'Everyone must sign it', type: 'checkbox', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/policies', { ...v, id: edit.id }), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </>
  );
}

function NewHireReport() {
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: today });
  const { data, reload } = useLoad<any>(`/v1/new-hire-report?from=${range.from}&to=${range.to}`, [range.from, range.to]);
  return (
    <>
      <p className="muted">Your state’s new-hire registry needs each new employee{data?.deadlineDays ? ` within ${data.deadlineDays} days of hire (from the labor tables)` : ''}. Download the file and upload it to the registry.</p>
      <Form
        fields={[
          { name: 'from', label: 'Hired from', type: 'date', required: true },
          { name: 'to', label: 'Hired to', type: 'date', required: true }
        ]}
        initial={range}
        submit="Show"
        onSubmit={(v) => setRange({ from: v.from, to: v.to })}
      />
      {data?.missing?.length > 0 && <div className="work-banner warn">Missing: {data.missing.map((m: any) => `${m.name} (${m.missing.join(', ')})`).join('; ')}</div>}
      <Table
        cols={[
          { key: 'employeeLastName', label: 'Name', render: (r: any) => `${r.employeeFirstName} ${r.employeeLastName}` },
          { key: 'ssn', label: 'SSN' },
          { key: 'hireDate', label: 'Hired', render: (r: any) => fmtDay(r.hireDate) },
          { key: 'employerName', label: 'Employer' }
        ]}
        rows={data?.rows || []}
        rowKey={(r: any) => r.personId}
        empty="No new hires in these dates."
      />
      <div className="pr-row">
        <button className="btn primary" disabled={!data?.rows?.length} onClick={async () => (await download(`/v1/new-hire-report?from=${range.from}&to=${range.to}&format=csv&mark=1`), reload())}>
          Download for the registry (CSV)
        </button>
      </div>
    </>
  );
}

function Offboarding() {
  const { people } = useWork();
  const { data, reload } = useLoad<any>('/v1/offboarding');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any | null>(null);
  const refresh = (c: any) => (setOpen(c), reload());
  return (
    <>
      <div className="pr-row">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Start offboarding
        </button>
      </div>
      <Table
        cols={[
          { key: 'personName', label: 'Person' },
          { key: 'kind', label: 'Leaving', render: (o: any) => (o.kind === 'voluntary' ? 'Resigned' : 'Let go') },
          { key: 'lastDay', label: 'Last day', render: (o: any) => fmtDay(o.lastDay) },
          { key: 'finalPayDue', label: 'Final pay due', render: (o: any) => fmtDay(o.finalPayDue) },
          { key: 'progress', label: 'Checklist', render: (o: any) => `${o.checklist.filter((x: any) => x.done).length} of ${o.checklist.length}` },
          { key: 'status', label: 'Status', render: (o: any) => <Tag tone={statusTone(o.status)}>{human(o.status)}</Tag> }
        ]}
        rows={data?.cases || []}
        onRow={setOpen}
        empty="Nobody is being offboarded."
      />
      {adding && (
        <FormDialog
          title="Start offboarding"
          onClose={() => setAdding(false)}
          initial={{ kind: 'voluntary' }}
          fields={[
            { name: 'personId', label: 'Person', type: 'select', required: true, options: people.filter((p) => p.status !== 'terminated').map((p) => ({ value: p.id, label: p.name })) },
            { name: 'kind', label: 'Reason', type: 'select', required: true, options: [{ value: 'voluntary', label: 'They resigned' }, { value: 'involuntary', label: 'The employer ended it' }] },
            { name: 'lastDay', label: 'Last day', type: 'date', required: true },
            { name: 'equipment', label: 'Equipment to return (comma-separated)', placeholder: 'Keys, radio, laptop' },
            { name: 'noticeDate', label: 'Notice given on', type: 'date', advanced: true },
            { name: 'access', label: 'Access to remove (comma-separated; empty = the usual list)', advanced: true }
          ]}
          onSubmit={async (v) => {
            const split = (s: string | null) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
            const r = await act(api<any>('POST', '/v1/offboarding', { ...v, equipment: split(v.equipment), access: split(v.access) }), 'Offboarding started.');
            if (r) (setAdding(false), refresh(r.case));
          }}
        />
      )}
      {open && (
        <FormDialog
          title={`${people.find((p) => p.id === open.personId)?.name || 'Offboarding'}: last day ${fmtDay(open.lastDay)}`}
          onClose={() => setOpen(null)}
          fields={[]}
          submit="Close"
          onSubmit={() => setOpen(null)}
          extra={
            <>
              <div className="work-banner">
                Final pay is due {fmtDay(open.finalPayDue)}. {open.finalPayRule?.note || ''}
              </div>
              {open.ptoPayout?.length > 0 && (
                <div className="card">
                  <strong>Time-off payout</strong>
                  {open.ptoPayout.map((x: any) => (
                    <p key={x.policyId} className="small">
                      {x.name}: {x.hours} h · {x.pay ? `paid out ${money(x.cents)}` : 'not paid out'} — <span className="muted">{x.why}</span>
                    </p>
                  ))}
                  {open.status === 'open' && open.ptoPayout.some((x: any) => x.pay && x.cents > 0) && (
                    <button type="button" className="btn sm" onClick={async () => { const r = await act(api<any>('POST', `/v1/offboarding/${open.id}/payout`), 'Added to the next pay run.'); if (r) refresh(r.case); }}>
                      Add the payout to the next pay run
                    </button>
                  )}
                </div>
              )}
              {open.cobra?.applies && <div className="work-banner warn">COBRA: tell the plan administrator by {fmtDay(open.cobra.employerNoticeDue)}.</div>}
              <ul className="pr-checklist">
                {open.checklist.map((x: any) => (
                  <li key={x.key} className={x.done ? 'done' : ''}>
                    <input type="checkbox" checked={x.done} disabled={open.status !== 'open'} onChange={async (e) => { const r = await act(api<any>('POST', `/v1/offboarding/${open.id}/check`, { key: x.key, done: e.target.checked })); if (r) refresh(r.case); }} />
                    <span>{x.label}</span>
                    {x.due && <span className="pr-due muted">by {fmtDay(x.due)}</span>}
                  </li>
                ))}
              </ul>
              {open.status === 'open' && (
                <button type="button" className="btn primary" disabled={open.checklist.some((x: any) => !x.done)} onClick={async () => { const r = await act(api<any>('POST', `/v1/offboarding/${open.id}/complete`, {}), 'Offboarding complete.'); if (r) (refresh(r.case), loadWork()); }}>
                  Finish offboarding
                </button>
              )}
            </>
          }
        />
      )}
    </>
  );
}
