import { useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { money } from '../store';
import { api } from '../api';
import { act, download, useLoad, Loading, Page, Table, Tabs, Stat, FormDialog } from '../kit';

type Tab = 'register' | 'tax' | 'labor' | 'custom';
const thisYear = new Date().getFullYear();

/** Reports: payroll register, tax liability, labor distribution with budgets, and a custom report builder. */
export function Reports() {
  const [tab, setTab] = useState<Tab>('register');
  const [range, setRange] = useState({ year: String(thisYear), quarter: '' });
  const q = `year=${range.year}${range.quarter ? `&quarter=${range.quarter}` : ''}`;
  return (
    <Page title="Reports" lead="From finalized pay runs. Download any of them as CSV.">
      <Tabs
        tabs={[
          { id: 'register', label: 'Payroll register' },
          { id: 'tax', label: 'Tax liability' },
          { id: 'labor', label: 'Labor distribution' },
          { id: 'custom', label: 'Build a report' }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab !== 'custom' && (
        <div className="pr-row">
          <select className="pr-input" value={range.year} onChange={(e) => setRange({ ...range, year: e.target.value })} aria-label="Year">
            {[0, 1, 2, 3].map((n) => (
              <option key={n}>{thisYear - n}</option>
            ))}
          </select>
          <select className="pr-input" value={range.quarter} onChange={(e) => setRange({ ...range, quarter: e.target.value })} aria-label="Quarter">
            <option value="">Whole year</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                Quarter {n}
              </option>
            ))}
          </select>
        </div>
      )}
      {tab === 'register' && <Register q={q} />}
      {tab === 'tax' && <TaxLiability q={q} />}
      {tab === 'labor' && <Labor q={q} />}
      {tab === 'custom' && <Builder />}
    </Page>
  );
}

function Register({ q }: { q: string }) {
  const { data, error } = useLoad<any>(`/v1/reports/register?${q}`, [q]);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="work-totals">
        <Stat label="Gross" value={money(data.totals.gross || 0)} />
        <Stat label="Withheld" value={money(data.totals.withheld || 0)} />
        <Stat label="Net" value={money(data.totals.net || 0)} />
        <Stat label="Employer taxes" value={money(data.totals.employerTotal || 0)} />
      </div>
      <button className="btn" onClick={() => download(`/v1/reports/register?${q}&format=csv`)}>
        <Download size={15} /> CSV
      </button>
      <Table
        cols={[
          { key: 'payDate', label: 'Pay date' },
          { key: 'name', label: 'Person' },
          { key: 'department', label: 'Department' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'withheld', label: 'Withheld', money: true },
          { key: 'net', label: 'Net', money: true },
          { key: 'employerTotal', label: 'Employer', money: true }
        ]}
        rows={data.rows}
        rowKey={(r: any, i) => `${r.payDate}-${r.personId}-${i}`}
        empty="No finalized pay runs in this range."
      />
    </>
  );
}

function TaxLiability({ q }: { q: string }) {
  const { data, error } = useLoad<any>(`/v1/reports/tax-liability?${q}`, [q]);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <p className="muted">{data.note}</p>
      <button className="btn" onClick={() => download(`/v1/reports/tax-liability?${q}&format=csv`)}>
        <Download size={15} /> CSV
      </button>
      <Table
        cols={[
          { key: 'label', label: 'Tax' },
          { key: 'employee', label: 'Withheld', money: true },
          { key: 'employer', label: 'Employer', money: true },
          { key: 'total', label: 'Total', money: true }
        ]}
        rows={data.rows}
        rowKey={(r: any) => r.code}
        empty="No finalized pay runs in this range."
      />
      <h2 className="work-h2">By pay date</h2>
      <Table cols={[{ key: 'payDate', label: 'Pay date' }, { key: 'employee', label: 'Withheld', money: true }, { key: 'employer', label: 'Employer', money: true }]} rows={data.byPayDate} rowKey={(r: any) => r.payDate} />
    </>
  );
}

function Labor({ q }: { q: string }) {
  const { data, error } = useLoad<any>(`/v1/reports/labor-distribution?${q}`, [q]);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <button className="btn" onClick={() => download(`/v1/reports/labor-distribution?${q}&format=csv`)}>
        <Download size={15} /> CSV
      </button>
      <Table
        cols={[
          { key: 'department', label: 'Department' },
          { key: 'costCenter', label: 'Cost center' },
          { key: 'program', label: 'Program' },
          { key: 'hours', label: 'Hours' },
          { key: 'cost', label: 'Cost', money: true },
          { key: 'budget', label: 'Budget', money: true },
          { key: 'variance', label: 'Left in budget', render: (r: any) => (r.variance == null ? '—' : <span style={{ color: r.variance < 0 ? 'var(--danger)' : undefined }}>{money(r.variance)}</span>) }
        ]}
        rows={data.rows}
        rowKey={(r: any, i) => `${r.departmentId}-${r.costCenterId}-${r.program}-${i}`}
        empty="No finalized pay runs in this range."
      />
    </>
  );
}

function Builder() {
  const { data: meta, error } = useLoad<any>('/v1/reports/fields');
  const { data: saved, reload } = useLoad<any>('/v1/reports/saved');
  const [spec, setSpec] = useState<any>({ dataset: 'people', fields: ['name', 'department', 'status'], filters: [], groupBy: [] });
  const [result, setResult] = useState<any | null>(null);
  const [naming, setNaming] = useState(false);
  if (!meta) return <Loading error={error} />;
  const ds = meta.datasets[spec.dataset];
  const fields = Object.keys(ds.fields);
  const set = (p: any) => (setSpec({ ...spec, ...p }), setResult(null));
  const run = async () => setResult(await act(api<any>('POST', '/v1/reports/run', spec)));
  return (
    <>
      <div className="pr-grid">
        <label className="pr-field">
          <span>Data</span>
          <select value={spec.dataset} onChange={(e) => set({ dataset: e.target.value, fields: Object.keys(meta.datasets[e.target.value].fields).slice(0, 4), filters: [], groupBy: [] })}>
            {Object.entries(meta.datasets).map(([k, d]: [string, any]) => (
              <option key={k} value={k}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {['pay', 'time'].includes(spec.dataset) && (
          <>
            <label className="pr-field">
              <span>From</span>
              <input type="date" value={spec.from || ''} onChange={(e) => set({ from: e.target.value || undefined })} />
            </label>
            <label className="pr-field">
              <span>To</span>
              <input type="date" value={spec.to || ''} onChange={(e) => set({ to: e.target.value || undefined })} />
            </label>
          </>
        )}
        <label className="pr-field">
          <span>Group by</span>
          <select value={spec.groupBy[0] || ''} onChange={(e) => set({ groupBy: e.target.value ? [e.target.value] : [] })}>
            <option value="">No grouping</option>
            {fields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="pr-field">
        <span>Fields</span>
        <div className="pr-multi">
          {fields.map((f) => (
            <label key={f} className="pr-check">
              <input type="checkbox" checked={spec.fields.includes(f)} onChange={(e) => set({ fields: e.target.checked ? [...spec.fields, f] : spec.fields.filter((x: string) => x !== f) })} /> {f}
            </label>
          ))}
        </div>
      </div>
      <h3 className="work-h2">Filters</h3>
      {spec.filters.map((f: any, i: number) => (
        <div className="pr-row" key={i}>
          <select className="pr-input" value={f.field} onChange={(e) => set({ filters: spec.filters.map((x: any, j: number) => (j === i ? { ...x, field: e.target.value } : x)) })}>
            {fields.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <select className="pr-input" value={f.op} onChange={(e) => set({ filters: spec.filters.map((x: any, j: number) => (j === i ? { ...x, op: e.target.value } : x)) })}>
            {meta.ops.map((o: string) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input className="pr-input" value={f.value} placeholder={ds.fields[f.field] === 'money' ? 'dollars' : 'value'} onChange={(e) => set({ filters: spec.filters.map((x: any, j: number) => (j === i ? { ...x, value: e.target.value } : x)) })} />
          <button className="icon-btn" aria-label="Remove filter" onClick={() => set({ filters: spec.filters.filter((_: any, j: number) => j !== i) })}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <div className="pr-row">
        <button className="btn" onClick={() => set({ filters: [...spec.filters, { field: fields[0], op: 'eq', value: '' }] })}>
          <Plus size={15} /> Add a filter
        </button>
        <button className="btn primary" onClick={run}>
          Run
        </button>
        <button className="btn" onClick={() => download('/v1/reports/run', { ...spec, format: 'csv' })}>
          <Download size={15} /> CSV
        </button>
        <button className="btn" onClick={() => setNaming(true)}>
          Save
        </button>
      </div>
      {saved?.reports?.length > 0 && (
        <div className="pr-row">
          <span className="muted">Saved:</span>
          {saved.reports.map((r: any) => (
            <button key={r.id} className="btn sm" onClick={() => (setSpec({ filters: [], groupBy: [], ...r.spec }), setResult(null))}>
              {r.name}
            </button>
          ))}
        </div>
      )}
      {naming && (
        <FormDialog
          title="Save this report"
          onClose={() => setNaming(false)}
          fields={[{ name: 'name', label: 'Name', required: true }]}
          onSubmit={async (v) => (await act(api('POST', '/v1/reports/saved', { name: v.name, spec }), 'Saved.')) && (setNaming(false), reload())}
        />
      )}
      {result && (
        <Table
          cols={result.columns.map((c: string) => ({ key: c, label: c, money: result.types[c] === 'money' }))}
          rows={result.rows}
          rowKey={(_: any, i) => String(i)}
          empty="No rows match."
        />
      )}
    </>
  );
}
