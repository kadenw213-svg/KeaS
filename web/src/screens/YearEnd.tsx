import { useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { useWork, money, fmtDay } from '../store';
import { api } from '../api';
import { act, download, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog } from '../kit';

type Tab = 'w2' | '1099' | 'aca';
const thisYear = new Date().getFullYear();

/** Year-end: W-2 and 1099-NEC data (CSV for filing, PDF summaries) and ACA 1095-C monthly codes. */
export function YearEnd() {
  const [tab, setTab] = useState<Tab>('w2');
  const [year, setYear] = useState(String(new Date().getMonth() < 6 ? thisYear - 1 : thisYear));
  return (
    <Page title="Year-end forms" lead="Built from finalized pay runs plus amounts imported from your old system. KeaS prepares the data; you file it.">
      <Tabs tabs={[{ id: 'w2', label: 'W-2' }, { id: '1099', label: '1099-NEC' }, { id: 'aca', label: 'ACA 1095-C' }]} value={tab} onChange={setTab} />
      <div className="pr-row">
        <select className="pr-input" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Tax year">
          {[0, 1, 2, 3].map((n) => (
            <option key={n}>{thisYear - n}</option>
          ))}
        </select>
      </div>
      {tab === 'w2' && <W2 year={year} />}
      {tab === '1099' && <Ten99 year={year} />}
      {tab === 'aca' && <Aca year={year} />}
    </Page>
  );
}

function W2({ year }: { year: string }) {
  const { data, error } = useLoad<any>(`/v1/yearend/w2?year=${year}`, [year]);
  if (!data) return <Loading error={error} />;
  return (
    <>
      {!data.tablesVerified && <div className="work-banner warn">The {year} tax tables aren’t verified, so these amounts come only from runs finalized on verified tables and imported amounts.</div>}
      <p className="muted small">{data.note}</p>
      <div className="pr-row">
        <button className="btn" onClick={() => download(`/v1/yearend/w2?year=${year}&format=csv`)}>
          <Download size={15} /> Data for filing (CSV)
        </button>
        <button className="btn" onClick={() => download(`/v1/yearend/w2?year=${year}&format=pdf`)}>
          <Download size={15} /> Employee summaries (PDF)
        </button>
      </div>
      <Table
        cols={[
          { key: 'name', label: 'Employee', render: (r: any) => <>{r.name} {r.problems.length > 0 && <Tag tone="warn">{r.problems.join(', ')}</Tag>}</> },
          { key: 'box1', label: '1 Wages', money: true },
          { key: 'box2', label: '2 Federal tax', money: true },
          { key: 'box4', label: '4 SS tax', money: true },
          { key: 'box6', label: '6 Medicare tax', money: true },
          { key: 'box17', label: '17 State tax', money: true },
          { key: 'pdf', label: '', render: (r: any) => <button className="btn sm" onClick={() => download(`/v1/yearend/w2?year=${year}&personId=${r.personId}&format=pdf`)}>PDF</button> }
        ]}
        rows={data.rows}
        rowKey={(r: any) => `${r.personId}-${r.employer.entityId}`}
        empty="No wages for this year."
      />
    </>
  );
}

function Ten99({ year }: { year: string }) {
  const { people } = useWork();
  const { data, error, reload } = useLoad<any>(`/v1/yearend/1099?year=${year}`, [year]);
  const pays = useLoad<any>(`/v1/contractor-payments?year=${year}`, [year]);
  const [adding, setAdding] = useState(false);
  if (!data) return <Loading error={error} />;
  const contractors = people;
  return (
    <>
      {data.note && <p className="muted small">{data.note}</p>}
      {data.threshold != null && <p className="muted small">Reporting threshold from the tax tables: {money(data.threshold)}.</p>}
      <div className="pr-row">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Record a contractor payment
        </button>
        <button className="btn" onClick={() => download(`/v1/yearend/1099?year=${year}&format=csv`)}>
          <Download size={15} /> CSV
        </button>
        <button className="btn" onClick={() => download(`/v1/yearend/1099?year=${year}&format=pdf`)}>
          <Download size={15} /> PDF
        </button>
      </div>
      <Table
        cols={[
          { key: 'name', label: 'Contractor' },
          { key: 'tin', label: 'TIN', render: (r: any) => r.tin || <Tag tone="warn">Missing</Tag> },
          { key: 'box1', label: 'Box 1', money: true },
          { key: 'meetsThreshold', label: 'Needs a 1099', render: (r: any) => (r.meetsThreshold == null ? '—' : r.meetsThreshold ? 'Yes' : 'No') }
        ]}
        rows={data.rows}
        rowKey={(r: any) => r.personId}
        empty="No contractor payments this year. Contractors are people whose worker type is Contractor."
      />
      <h2 className="work-h2">Payments</h2>
      <Table cols={[{ key: 'name', label: 'Contractor' }, { key: 'date', label: 'Date', render: (r: any) => fmtDay(r.date) }, { key: 'cents', label: 'Amount', money: true }, { key: 'memo', label: 'Memo' }]} rows={pays.data?.payments || []} />
      {adding && (
        <FormDialog
          title="Record a contractor payment"
          onClose={() => setAdding(false)}
          fields={[
            { name: 'personId', label: 'Contractor', type: 'select', required: true, options: contractors.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'date', label: 'Paid on', type: 'date', required: true },
            { name: 'cents', label: 'Amount', type: 'money', required: true },
            { name: 'memo', label: 'Memo', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/contractor-payments', v), 'Recorded.')) && (setAdding(false), reload(), pays.reload())}
        />
      )}
    </>
  );
}

function Aca({ year }: { year: string }) {
  const { data, error, reload } = useLoad<any>(`/v1/yearend/aca?year=${year}`, [year]);
  const [edit, setEdit] = useState<any | null>(null);
  if (!data) return <Loading error={error} />;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (
    <>
      <p className="muted small">{data.note}{data.fullTimeMonthlyHours ? ` Full-time: ${data.fullTimeMonthlyHours}+ hours in a month.` : ''}</p>
      {data.ale === false && <div className="work-banner">Your org settings say you aren’t an applicable large employer, so 1095-C forms may not apply.</div>}
      <button className="btn" onClick={() => download(`/v1/yearend/aca?year=${year}&format=csv`)}>
        <Download size={15} /> CSV
      </button>
      <Table
        cols={[
          { key: 'name', label: 'Employee' },
          { key: 'ft', label: 'Full-time months', render: (r: any) => r.fullTimeMonths },
          { key: 'codes', label: 'Line 14 / 16 by month', render: (r: any) => r.months.map((m: any) => `${M[m.month - 1]} ${m.line14}${m.line16 ? '/' + m.line16 : ''}`).join(' · ') }
        ]}
        rows={data.rows}
        rowKey={(r: any) => r.personId}
        onRow={setEdit}
      />
      {edit && (
        <FormDialog
          title={`${edit.name}: offers of coverage`}
          onClose={() => setEdit(null)}
          initial={{ offerCode: edit.months[0].line14, contributionCents: edit.months[0].line15, safeHarbor: edit.months[0].line16 }}
          fields={[
            { name: 'offerCode', label: 'Line 14 offer code (all months)', placeholder: '1E' },
            { name: 'contributionCents', label: 'Line 15 employee share, lowest-cost self-only ($ a month)', type: 'money' },
            { name: 'safeHarbor', label: 'Line 16 code (all months)', placeholder: '2C', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/yearend/aca/months', { personId: edit.personId, year: Number(year), months: edit.months.map((m: any) => ({ month: m.month, offerCode: v.offerCode, contributionCents: v.contributionCents, safeHarbor: v.safeHarbor })) }), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </>
  );
}
