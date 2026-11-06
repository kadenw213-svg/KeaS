import { useState } from 'react';
import { loadWork } from '../store';
import { api } from '../api';
import { act, Page, Table, Tag } from '../kit';

const KINDS = [
  { id: 'employees', label: 'People', help: 'Names, contact, hire dates, pay rates, W-4 filing status, SSNs, addresses, bank accounts and departments.' },
  { id: 'ytd', label: 'Year-to-date amounts', help: 'Gross pay and taxes so far this year, so wage-base limits and W-2s are right when you switch mid-year.' },
  { id: 'pto', label: 'Time-off balances', help: 'One row per person and policy, with the hours available. Policy names must match yours.' },
  { id: 'hours', label: 'Hours worked', help: 'A date and hours (or in and out times) per row; they become timecards for approval and pay.' }
];
const SOURCES = [
  { id: 'gusto', label: 'Gusto' },
  { id: 'adp', label: 'ADP' },
  { id: 'paychex', label: 'Paychex' },
  { id: 'quickbooks', label: 'QuickBooks' },
  { id: 'other', label: 'Another spreadsheet' }
];

/** Import from another payroll system's CSV exports: check the column matches, preview, then import. */
export function Import() {
  const [kind, setKind] = useState('employees');
  const [source, setSource] = useState('gusto');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<any | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any | null>(null);
  const reset = () => (setPreview(null), setResult(null));
  const doPreview = async (m?: Record<string, string>) => {
    const r = await act(api<any>('POST', '/v1/import/preview', { kind, source, csv, mapping: m }));
    if (r) (setPreview(r), setMapping(r.mapping), setResult(null));
  };
  const k = KINDS.find((x) => x.id === kind)!;
  return (
    <Page title="Import" lead="Switching to KeaS, even mid-year: export CSV files from your old payroll system and bring them in. You see every row before anything is saved.">
      <div className="pr-grid">
        <label className="pr-field">
          <span>What</span>
          <select value={kind} onChange={(e) => (setKind(e.target.value), reset())}>
            {KINDS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <span className="muted small">{k.help}</span>
        </label>
        <label className="pr-field">
          <span>From</span>
          <select value={source} onChange={(e) => (setSource(e.target.value), reset())}>
            {SOURCES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pr-field">
          <span>CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              setCsv(await f.text());
              reset();
            }}
          />
        </label>
        {(kind === 'ytd' || kind === 'pto') && (
          <>
            {kind === 'ytd' && (
              <label className="pr-field">
                <span>Tax year</span>
                <input value={year} onChange={(e) => setYear(e.target.value)} />
              </label>
            )}
            <label className="pr-field">
              <span>Amounts as of</span>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          </>
        )}
      </div>
      <div className="pr-row">
        <button className="btn primary" disabled={!csv} onClick={() => doPreview()}>
          Preview {fileName}
        </button>
      </div>
      {preview && (
        <>
          <h2 className="work-h2">Columns</h2>
          <p className="muted small">KeaS matched these columns by name. Change any that are wrong, then preview again.</p>
          <div className="pr-grid">
            {preview.fields.map((f: string) => (
              <label key={f} className="pr-field">
                <span>{f}</span>
                <select value={mapping[f] || ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}>
                  <option value="">(not in the file)</option>
                  {preview.headers.map((hd: string) => (
                    <option key={hd}>{hd}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="pr-row">
            <button className="btn" onClick={() => doPreview(mapping)}>
              Preview again
            </button>
            <span className="muted">
              {preview.count} rows · {preview.matched} match people already here · {preview.withProblems} with problems
            </span>
          </div>
          <Table
            cols={[
              { key: 'name', label: 'Person', render: (r: any) => <>{r.name || r.employeeNumber || r.email} {r.match ? <Tag>Existing</Tag> : kind === 'employees' ? <Tag tone="ok">New</Tag> : <Tag tone="bad">No match</Tag>}</> },
              ...(kind === 'employees'
                ? [{ key: 'hireDate', label: 'Hired' }, { key: 'payRate', label: 'Rate', money: true }, { key: 'ssn', label: 'SSN' }, { key: 'account', label: 'Bank' }]
                : kind === 'ytd'
                  ? [{ key: 'gross', label: 'Gross', render: (r: any) => (r.amounts?.gross != null ? (r.amounts.gross / 100).toFixed(2) : '—') }, { key: 'fit', label: 'Federal tax', render: (r: any) => (r.amounts?.federal_income != null ? (r.amounts.federal_income / 100).toFixed(2) : '—') }]
                  : kind === 'pto'
                    ? [{ key: 'policy', label: 'Policy' }, { key: 'hours', label: 'Hours' }]
                    : [{ key: 'date', label: 'Date' }, { key: 'hours', label: 'Hours' }, { key: 'start', label: 'In' }, { key: 'end', label: 'Out' }]),
              { key: 'problems', label: 'Problems', render: (r: any) => r.problems.join('; ') || '—' }
            ]}
            rows={preview.rows}
            rowKey={(_: any, i) => String(i)}
          />
          <button
            className="btn primary"
            onClick={async () => {
              const r = await act(api<any>('POST', '/v1/import/commit', { kind, source, csv, mapping, year: Number(year), asOf }), 'Imported.');
              if (r) (setResult(r), loadWork());
            }}
          >
            Import {preview.count} rows
          </button>
        </>
      )}
      {result && (
        <div className="card" style={{ marginTop: 14 }}>
          <strong>
            {result.created} added · {result.updated} updated · {result.skipped} skipped
          </strong>
          {result.errors.map((e: any, i: number) => (
            <p key={i} className="small muted">
              Row {e.row}: {e.problems.join('; ')}
            </p>
          ))}
        </div>
      )}
    </Page>
  );
}
