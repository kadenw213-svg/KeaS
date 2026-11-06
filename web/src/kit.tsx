// Building blocks for the payroll and HR screens: loading data, forms (simple fields up front, every other option
// under Advanced), tables that stack on phones, tabs, downloads and the e-signature box.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { Dialog, Spinner, toast } from './ui';
import { money } from './store';

/** GET a path and keep the result; `reload()` fetches again. A null path loads nothing. */
export function useLoad<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api<T>('GET', path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, reload };
}

/** Run an action, show a toast, and return the result (or null after showing the error). */
export async function act<T = any>(p: Promise<T>, ok?: string): Promise<T | null> {
  try {
    const r = await p;
    if (ok) toast(ok);
    return r;
  } catch (e: any) {
    toast(e instanceof ApiError ? e.message : String(e?.message || e));
    return null;
  }
}

/** Fetch a file from the server (CSV, PDF, NACHA) and save it. */
export async function download(path: string, body?: unknown) {
  try {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-KeaS': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error(j?.error || `The server said no (${r.status}).`);
    }
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'download';
    // A file with something to be careful about (full SSNs): say so.
    const warning = r.headers.get('x-keas-warning');
    if (warning) toast(decodeURIComponent(warning));
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e: any) {
    toast(e.message);
  }
}
/** Save text the page already has. */
export function saveText(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export function Page({ title, lead, actions, children, wide = true }: { title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`work-page ${wide ? 'wide' : ''}`}>
      <div className="work-head">
        <h1 className="work-title">{title}</h1>
        {actions}
      </div>
      {lead && <p className="muted work-lead">{lead}</p>}
      {children}
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <div className="work-banner warn">{error}</div> : <Spinner />;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="pr-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`pr-tab ${value === t.id ? 'on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count ? <span className="pr-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface Col<R> {
  key: string;
  label: string;
  render?: (r: R) => ReactNode;
  money?: boolean;
}
export function Table<R extends Record<string, any>>({ cols, rows, empty = 'Nothing here yet.', onRow, rowKey }: { cols: Col<R>[]; rows: R[]; empty?: string; onRow?: (r: R) => void; rowKey?: (r: R, i: number) => string }) {
  if (!rows.length) return <p className="muted pr-empty">{empty}</p>;
  return (
    <table className="work-table stack pr-table">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={c.money ? 'num' : ''}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={rowKey ? rowKey(r, i) : r.id ?? i} className={onRow ? 'pr-click' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
            {cols.map((c, j) => (
              <td key={c.key} data-label={c.label} className={`${j === 0 ? 'stack-title' : ''} ${c.money ? 'num' : ''}`}>
                {c.render ? c.render(r) : c.money ? (r[c.key] == null ? '—' : money(r[c.key])) : r[c.key] == null || r[c.key] === '' ? '—' : String(r[c.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type FieldType = 'text' | 'email' | 'password' | 'number' | 'money' | 'date' | 'time' | 'select' | 'textarea' | 'checkbox' | 'multiselect';
export interface Field {
  name: string;
  label: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
  advanced?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
  step?: string;
}
type Values = Record<string, any>;

/** money fields hold dollars while editing and become cents on submit. */
function toForm(fields: Field[], initial: Values) {
  const v: Values = {};
  for (const f of fields) {
    const x = initial[f.name];
    v[f.name] = f.type === 'money' ? (x == null || x === '' ? '' : (Number(x) / 100).toFixed(2)) : f.type === 'checkbox' ? !!x : f.type === 'multiselect' ? (Array.isArray(x) ? x : []) : x ?? '';
  }
  return v;
}
function fromForm(fields: Field[], v: Values) {
  const out: Values = {};
  for (const f of fields) {
    const x = v[f.name];
    if (f.type === 'money') out[f.name] = x === '' || x == null ? null : Math.round(Number(String(x).replace(/[$,]/g, '')) * 100);
    else if (f.type === 'number') out[f.name] = x === '' || x == null ? null : Number(x);
    else if (f.type === 'checkbox' || f.type === 'multiselect') out[f.name] = x;
    else out[f.name] = x === '' ? null : x;
  }
  return out;
}

export function FieldInput({ f, value, set }: { f: Field; value: any; set: (v: any) => void }) {
  const id = `f-${f.name}`;
  if (f.type === 'checkbox')
    return (
      <label className="pr-check">
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} /> {f.label}
        {f.help && <span className="muted small"> {f.help}</span>}
      </label>
    );
  return (
    <label className="pr-field" htmlFor={id}>
      <span>
        {f.label}
        {f.required ? ' *' : ''}
      </span>
      {f.type === 'select' ? (
        <select id={id} value={value ?? ''} onChange={(e) => set(e.target.value)}>
          {!f.required && <option value="">—</option>}
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.type === 'multiselect' ? (
        <div className="pr-multi">
          {f.options?.map((o) => (
            <label key={o.value} className="pr-check">
              <input type="checkbox" checked={(value || []).includes(o.value)} onChange={(e) => set(e.target.checked ? [...(value || []), o.value] : (value || []).filter((x: string) => x !== o.value))} /> {o.label}
            </label>
          ))}
        </div>
      ) : f.type === 'textarea' ? (
        <textarea id={id} value={value ?? ''} placeholder={f.placeholder} rows={6} onChange={(e) => set(e.target.value)} />
      ) : (
        <input
          id={id}
          type={f.type === 'money' ? 'text' : f.type || 'text'}
          inputMode={f.type === 'money' || f.type === 'number' ? 'decimal' : undefined}
          step={f.step}
          value={value ?? ''}
          placeholder={f.type === 'money' ? f.placeholder || '0.00' : f.placeholder}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {f.help && <span className="muted small">{f.help}</span>}
    </label>
  );
}

/** A form: the simple fields, then an Advanced section with every other option. */
export function Form({ fields, initial = {}, submit = 'Save', onSubmit, onCancel, extra }: { fields: Field[]; initial?: Values; submit?: string; onSubmit: (v: Values) => Promise<unknown> | unknown; onCancel?: () => void; extra?: ReactNode }) {
  const [v, setV] = useState<Values>(() => toForm(fields, initial));
  const [busy, setBusy] = useState(false);
  const basic = fields.filter((f) => !f.advanced), adv = fields.filter((f) => f.advanced);
  const set = (name: string) => (x: any) => setV((o) => ({ ...o, [name]: x }));
  const missing = fields.some((f) => f.required && (v[f.name] === '' || v[f.name] == null));
  return (
    <form
      className="pr-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(fromForm(fields, v));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="pr-fields">
        {basic.map((f) => (
          <FieldInput key={f.name} f={f} value={v[f.name]} set={set(f.name)} />
        ))}
      </div>
      {adv.length > 0 && (
        <details className="pr-advanced">
          <summary>Advanced</summary>
          <div className="pr-fields">
            {adv.map((f) => (
              <FieldInput key={f.name} f={f} value={v[f.name]} set={set(f.name)} />
            ))}
          </div>
        </details>
      )}
      {extra}
      <div className="dialog-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || missing}>
          {busy ? 'Saving…' : submit}
        </button>
      </div>
    </form>
  );
}

export function FormDialog(props: { title: string; onClose: () => void } & Parameters<typeof Form>[0]) {
  const { title, onClose, ...rest } = props;
  return (
    <Dialog title={title} onClose={onClose} className="work-modal pr-dialog">
      <Form {...rest} onCancel={onClose} />
    </Dialog>
  );
}

/** Typed-name e-signature: the name must match, plus consent; the server records time and a SHA-256 hash. */
export function ESign({ name, label = 'Sign', onSign, note }: { name: string; label?: string; onSign: (typedName: string) => Promise<unknown>; note?: string }) {
  const [typed, setTyped] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="pr-sign">
      <p className="muted small">{note || `To sign, type ${name}’s full name exactly as shown. KeaS records the time and a fingerprint (SHA-256) of what was signed.`}</p>
      <label className="pr-field">
        <span>Type the full name: {name}</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      <label className="pr-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree to sign this electronically, and my typed name is my signature.
      </label>
      <button
        className="btn primary"
        disabled={!consent || !typed.trim() || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSign(typed);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Signing…' : label}
      </button>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return <span className={`work-tag ${tone || ''}`}>{children}</span>;
}

export const statusTone = (s: string): 'ok' | 'warn' | 'bad' | undefined =>
  ['approved', 'done', 'complete', 'accepted', 'reimbursed', 'active', 'shared', 'acknowledged', 'hired', 'finalized', 'paid'].includes(s) ? 'ok' : ['denied', 'declined', 'cancelled', 'rejected', 'terminated'].includes(s) ? 'bad' : ['pending', 'submitted', 'open', 'sent', 'pending_approval', 'onboarding'].includes(s) ? 'warn' : undefined;

export const human = (s: string) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const dollars = (cents: number | null | undefined) => (cents == null ? '—' : money(cents));
