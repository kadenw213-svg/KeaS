import { Fragment, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { listOf, fmtDay, money, addDays } from '../store';
import { api } from '../api';
import { ask, toast } from '../ui';
import { act, download, saveText, useLoad, Loading, Stat, Table, Tag, human } from '../kit';

/** The pay run for a period: review every line, then finalize (only on verified tables) and get the bank file. */
export function PayRun() {
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = periodStart ? `?periodStart=${periodStart}` : '';
  const { data: run, error, reload } = useLoad<any>(`/v1/payrun/preview${q}`);
  const { data: hist, reload: reloadHist } = useLoad<any>('/v1/payruns');
  if (!run)
    return (
      <div className="work-page">
        <Loading error={error} />
      </div>
    );
  const lines = listOf(run.lines, 'lines');
  const totals = run.totals || {};
  const ps = run.period.start;

  const finalize = async () => {
    const yes = await ask('Finalize this pay run?', `${money(totals.net)} net pay for ${totals.people} people, pay date ${fmtDay(run.payDate)}. A finalized run can’t be changed; corrections go in the next run.`, [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Finalize', primary: true }
    ]);
    if (yes !== 'ok') return;
    if (await act(api('POST', '/v1/payrun/finalize', { periodStart: ps }), 'Pay run finalized.')) {
      reload();
      reloadHist();
    }
  };
  const bankFile = async () => {
    const r = await act(api<any>('GET', `/v1/payrun/nacha?periodStart=${ps}`));
    if (!r) return;
    saveText(r.filename, r.text);
    if (r.skipped?.length) toast(`No direct deposit for ${r.skipped.map((s: any) => s.name).join(', ')}: pay by check.`);
  };

  return (
    <div className="work-page wide">
      <div className="work-head">
        <h1 className="work-title">Pay run</h1>
        <div className="work-period">
          <button className="icon-btn" aria-label="Previous period" onClick={() => setPeriodStart(addDays(ps, -14))}>
            <ChevronLeft size={18} />
          </button>
          <span>
            {fmtDay(run.period.start)} – {fmtDay(run.period.end)} · pay date {fmtDay(run.payDate)}
          </span>
          <button className="icon-btn" aria-label="Next period" onClick={() => setPeriodStart(addDays(ps, 14))}>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      {run.finalized ? (
        <div className="work-banner">
          <ShieldCheck size={16} /> Finalized {new Date(run.finalized.at).toLocaleString()}. Stubs, the bank file and reports use the stored run.
        </div>
      ) : !run.tablesVerified ? (
        <div className="work-banner danger">
          <ShieldAlert size={16} /> The tax and labor tables haven’t been verified for {run.year} yet, so this pay run can be reviewed but not finalized.
        </div>
      ) : null}
      {groupWarnings(listOf(run.warnings, 'warnings'), lines).map((x, i) => (
        <div key={i} className="work-banner warn">
          <TriangleAlert size={15} /> {x}
        </div>
      ))}
      <div className="work-totals">
        <Stat label="Gross" value={money(totals.gross || 0)} />
        <Stat label="Net pay" value={money(totals.net || 0)} />
        <Stat label="Employer taxes" value={money(totals.employer || 0)} />
        <Stat label="People" value={totals.people ?? lines.length} />
      </div>
      <div className="pr-row">
        {!run.finalized && run.needsApproval && !run.approval && (
          <button className="btn" onClick={async () => (await act(api('POST', '/v1/payrun/submit', { periodStart: ps }), 'Sent for approval.')) && reload()}>
            Send for approval
          </button>
        )}
        {run.approval && <Tag tone={run.approval.status === 'approved' ? 'ok' : 'warn'}>Approval: {human(run.approval.status)}</Tag>}
        {!run.finalized && (
          <button className="btn primary" disabled={!run.canFinalize} title={run.blockers?.join(' ')} onClick={finalize}>
            Finalize pay run
          </button>
        )}
        <button className="btn" onClick={bankFile}>
          Direct-deposit file (NACHA)
        </button>
        <button className="btn" onClick={() => download(`/v1/payrun/gl?periodStart=${ps}&format=csv`)}>
          GL journal (CSV)
        </button>
        <button className="btn" onClick={() => download(`/v1/reports/register?periodStart=${ps}&format=csv`)}>
          Register (CSV)
        </button>
      </div>
      {!run.finalized && run.blockers?.length > 0 && <p className="muted small">Before finalizing: {run.blockers.join(' ')}</p>}
      <p className="muted small">The direct-deposit file is for your own bank: upload it there. KeaS never holds or sends money.</p>
      <details className="pr-advanced" style={{ marginBottom: 14 }}>
        <summary>Tax and labor tables used</summary>
        <Table
          cols={[
            { key: 'name', label: 'Table' },
            { key: 'verified', label: 'Verified for this year', render: (t: any) => (t.missing ? <Tag tone="bad">Missing</Tag> : t.verified ? <Tag tone="ok">Verified</Tag> : <Tag tone="warn">Not verified</Tag>) },
            { key: 'note', label: 'Note' }
          ]}
          rows={run.tables || []}
          rowKey={(t: any) => t.key}
        />
      </details>
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
                    {!l.approved && (l.hours?.regular || 0) + (l.hours?.overtime || 0) > 0 && <span className="work-tag">Not approved</span>}
                    {l.salaried && <span className="work-tag">Salary</span>}
                  </td>
                  <td data-label="Hours">
                    {(Number(l.hours?.regular || 0) + Number(l.hours?.overtime || 0)).toFixed(2)}
                    {l.hours?.overtime ? ` (${Number(l.hours.overtime).toFixed(2)} OT)` : ''}
                  </td>
                  <td data-label="Gross">{money(l.gross)}</td>
                  <td data-label="Withheld">{money(l.withheld)}</td>
                  <td data-label="Net pay">
                    <strong>{money(l.net)}</strong>
                  </td>
                  <td data-label="Employer">{money(l.employerTotal)}</td>
                </tr>
                {isOpen && (
                  <tr className="work-explain">
                    <td colSpan={6}>
                      <div className="pr-grid">
                        <div>
                          <h3 className="work-h2">Earnings</h3>
                          {listOf(l.earnings, 'earnings').map((e: any, i: number) => (
                            <div key={i} className="pr-row" style={{ margin: 0 }}>
                              <span>
                                {e.label}
                                {e.hours ? ` · ${e.hours} h` : ''}
                                {e.taxable === false ? ' · not taxed' : ''}
                              </span>
                              <span style={{ marginLeft: 'auto' }}>{money(e.cents)}</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <h3 className="work-h2">Time off balances</h3>
                          {listOf(l.balances, 'balances').length ? (
                            listOf(l.balances, 'balances').map((b: any) => (
                              <div key={b.policyId} className="pr-row" style={{ margin: 0 }}>
                                <span>
                                  {b.name}
                                  {b.accrued ? ` (+${b.accrued} this period)` : ''}
                                </span>
                                <span style={{ marginLeft: 'auto' }}>{b.hours} h</span>
                              </div>
                            ))
                          ) : (
                            <p className="muted">No time-off policies.</p>
                          )}
                        </div>
                      </div>
                      <ol>
                        {listOf(l.explain, 'explain').map((s: any, i: number) => (
                          <li key={i}>{String(s)}</li>
                        ))}
                      </ol>
                      {[...listOf(l.taxes, 'taxes'), ...listOf(l.employer, 'employer')].map((t: any, i: number) => (
                        <details key={i} className="work-tax">
                          <summary>
                            {t.label}: {money(t.cents)}
                          </summary>
                          <ol>
                            {listOf(t.explain, 'explain').map((s: any, j: number) => (
                              <li key={j}>{String(s)}</li>
                            ))}
                          </ol>
                        </details>
                      ))}
                      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => download(`/v1/payrun/stub?periodStart=${ps}&personId=${l.personId}&format=pdf`)}>
                        Pay stub (PDF)
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <h2 className="work-h2">Finalized runs</h2>
      <Table
        cols={[
          { key: 'periodStart', label: 'Period', render: (r: any) => `${fmtDay(r.periodStart)} – ${fmtDay(r.periodEnd)}` },
          { key: 'payDate', label: 'Pay date', render: (r: any) => fmtDay(r.payDate) },
          { key: 'gross', label: 'Gross', render: (r: any) => money(r.totals.gross) },
          { key: 'net', label: 'Net', render: (r: any) => money(r.totals.net) },
          { key: 'people', label: 'People', render: (r: any) => r.totals.people }
        ]}
        rows={hist?.runs || []}
        onRow={(r: any) => setPeriodStart(r.periodStart)}
        empty="No finalized runs yet."
      />
    </div>
  );
}

/** One line per kind of warning instead of a row per person. The unverified-tables notice is already the red banner. */
function groupWarnings(warnings: any[], lines: any[]): string[] {
  const name = (id: string) => lines.find((l) => l.personId === id)?.name || 'someone';
  const groups = new Map<string, any[]>();
  for (const w of warnings) {
    if (/^unverified/i.test(w.code || '')) continue;
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
