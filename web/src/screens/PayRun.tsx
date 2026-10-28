import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ShieldAlert, TriangleAlert } from 'lucide-react';
import { listOf, fmtDay, money } from '../store';
import { api } from '../api';
import { Spinner, toast } from '../ui';

export function PayRun() {
  const [run, setRun] = useState<any | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nacha, setNacha] = useState<string | null>(null);
  useEffect(() => {
    api('GET', '/v1/payrun/preview')
      .then(setRun)
      .catch((e) => setRun({ error: e.message }));
  }, []);
  if (!run)
    return (
      <div className="work-page">
        <Spinner />
      </div>
    );
  if (run.error)
    return (
      <div className="work-page">
        <div className="work-banner warn">{run.error}</div>
      </div>
    );
  const lines = listOf(run.lines, 'lines');
  const cents = (v: any) => (typeof v === 'number' ? v : v?.cents ?? 0);
  const sumTax = (t: any) => Object.values(t || {}).reduce((a: number, v: any) => a + cents(v), 0);
  const totals = run.totals || {};

  return (
    <div className="work-page wide">
      <div className="work-head">
        <h1 className="work-title">Pay run</h1>
        <span className="muted">
          {run.period?.start ? fmtDay(run.period.start) : ''} – {run.period?.end ? fmtDay(run.period.end) : ''}
          {run.payDate ? ` · pay date ${fmtDay(run.payDate)}` : ''}
        </span>
      </div>
      {/* Always shown: these numbers are prototype estimates no matter what the server says. */}
      <div className="work-banner danger">
        <ShieldAlert size={16} /> Prototype estimates. The tax and labor tables used here haven’t been verified, so this pay run can’t be finalized. Check every number before using it.
      </div>
      {groupWarnings(listOf(run.warnings, 'warnings'), lines).map((x, i) => (
        <div key={i} className="work-banner warn">
          <TriangleAlert size={15} /> {x}
        </div>
      ))}
      <div className="work-totals">
        <div className="card">
          <span className="muted">Gross</span>
          <strong>{money(totals.gross || 0)}</strong>
        </div>
        <div className="card">
          <span className="muted">Net pay</span>
          <strong>{money(totals.net || 0)}</strong>
        </div>
        <div className="card">
          <span className="muted">Employer taxes</span>
          <strong>{money(totals.employer || 0)}</strong>
        </div>
        <div className="card">
          <span className="muted">People</span>
          <strong>{totals.people ?? lines.length}</strong>
        </div>
      </div>
      <p className="muted work-lead">Tap a person to see how each amount was worked out.</p>
      <table className="work-table stack pay">
        <thead>
          <tr>
            <th>Person</th>
            <th>Hours</th>
            <th>Gross</th>
            <th>Taxes withheld</th>
            <th>Net pay</th>
            <th>Employer taxes</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any) => {
            const isOpen = open === l.personId;
            return (
              <Fragment key={l.personId}>
                <tr
                  className={`work-pay-row ${isOpen ? 'open' : ''}`}
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : l.personId)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(isOpen ? null : l.personId))}
                >
                  <td data-label="Person" className="stack-title">
                    <ChevronDown size={15} className="work-chev" aria-hidden="true" />
                    {l.name}
                    {!l.approved && <span className="work-tag">Not approved</span>}
                  </td>
                  <td data-label="Hours">
                    {(Number(l.hours?.regular || 0) + Number(l.hours?.overtime || 0)).toFixed(2)}
                    {l.hours?.overtime ? ` (${Number(l.hours.overtime).toFixed(2)} OT)` : ''}
                  </td>
                  <td data-label="Gross">{money(cents(l.gross))}</td>
                  <td data-label="Withheld">{money(sumTax(l.taxes))}</td>
                  <td data-label="Net pay">
                    <strong>{money(cents(l.net))}</strong>
                  </td>
                  <td data-label="Employer">{money(sumTax(l.employer))}</td>
                </tr>
                {isOpen && (
                  <tr className="work-explain">
                    <td colSpan={6}>
                      <ol>
                        {listOf(l.explain, 'explain').map((s: any, i: number) => (
                          <li key={i}>{typeof s === 'string' ? s : s.text || JSON.stringify(s)}</li>
                        ))}
                      </ol>
                      {[...listOf(l.taxes, 'taxes'), ...listOf(l.employer, 'employer')].map((t: any) => (
                        <details key={t.label} className="work-tax">
                          <summary>
                            {t.label}: {money(cents(t))}
                          </summary>
                          <ol>
                            {listOf(t.explain, 'explain').map((s: any, i: number) => (
                              <li key={i}>{String(s)}</li>
                            ))}
                          </ol>
                        </details>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="work-head work-pay-acts">
        <button className="btn" disabled title="Finalizing needs verified tax tables.">
          Finalize pay run
        </button>
        <button
          className="btn"
          onClick={() =>
            api('GET', '/v1/payrun/nacha')
              .then((r) => setNacha(r.text || ''))
              .catch((e) => toast(e.message))
          }
        >
          Show sample direct-deposit file
        </button>
      </div>
      {nacha !== null && (
        <div className="card">
          <p className="muted">A sample NACHA file with made-up bank numbers. It is never sent anywhere; in a real pay run the admin uploads it to the workplace’s own bank.</p>
          <pre className="work-nacha">{nacha}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * One line per kind of warning ("Timecard not approved for 9 people: …") instead of a row per person.
 * The prototype notice is already the red banner, so its duplicate is dropped.
 */
function groupWarnings(warnings: any[], lines: any[]): string[] {
  const name = (id: string) => lines.find((l) => l.personId === id)?.name || 'someone';
  const groups = new Map<string, any[]>();
  for (const w of warnings) {
    if (/^(unverified|prototype)/i.test(w.code || '')) continue;
    const key = w.personId ? w.code || w.message : w.message || w.code;
    groups.set(key, [...(groups.get(key) || []), w]);
  }
  const out: string[] = [];
  for (const [, list] of groups) {
    if (list.length === 1 || !list[0].personId) {
      out.push(list[0].message || String(list[0].code));
      continue;
    }
    const who = list.map((w) => name(w.personId));
    const shown = who.length > 4 ? who.slice(0, 4).join(', ') + ` and ${who.length - 4} more` : who.join(', ');
    const what = (list[0].message || '').replace(/^[^:]+:\s*/, '');
    out.push(`${what.charAt(0).toUpperCase() + what.slice(1)} for ${list.length} people: ${shown}.`);
  }
  return out;
}
