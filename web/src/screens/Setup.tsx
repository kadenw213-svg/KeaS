import { CheckCircle2, Circle, ExternalLink, ShieldAlert } from 'lucide-react';
import { go, useWork, type WorkView } from '../store';
import { useLoad, Loading, Page, Tag } from '../kit';

/**
 * Get set up: everything that would stop a pay run, as steps. Each says if it's done, in one sentence, with a button
 * straight to where it's fixed. The list checks itself again whenever this screen is shown.
 */
export function Setup() {
  const { tick } = useWork();
  const { data, error } = useLoad<any>(`/v1/setup/checklist?t=${tick}`);
  if (!data) return <Page title="Get set up"><Loading error={error} /></Page>;
  const left = data.left;
  const open = (f: any) => f && go(f.view as WorkView, { personId: f.personId, edit: f.edit, team: f.team, periodStart: f.periodStart });
  return (
    <Page title="Get set up" lead={left ? `${left} of ${data.total} steps left before a pay run can go through.` : 'All set: payroll has everything it needs.'}>
      {!left && (
        <p>
          <button className="btn primary" onClick={() => go('pay')}>
            Go to the pay run
          </button>
        </p>
      )}
      <ol className="pr-checklist">
        {data.steps.map((s: any) => (
          <li key={s.id} className={`card pr-step ${s.done ? 'done' : ''}`}>
            <div className="pr-step-head">
              {s.done ? <CheckCircle2 size={20} className="ok" /> : s.blocking ? <ShieldAlert size={20} /> : <Circle size={20} />}
              <strong>{s.title}</strong>
              {s.optional && <Tag>Optional</Tag>}
              {s.fix && !s.done && (
                <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => open(s.fix)}>
                  Fix this
                </button>
              )}
              {s.fix && s.done && (
                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => open(s.fix)}>
                  Open
                </button>
              )}
            </div>
            <p className="muted">{s.text}</p>
            {s.rules && (
              <ul className="small">
                {s.rules.map((r: any) => (
                  <li key={r.name}>
                    {r.name}
                    {r.note ? `: ${r.note}` : ''} {r.have ? (r.verified ? <Tag tone="ok">Checked</Tag> : <Tag tone="warn">Not checked yet</Tag>) : <Tag tone="bad">KeaS doesn’t have this</Tag>}
                  </li>
                ))}
              </ul>
            )}
            {s.people?.length > 0 && (
              <ul className="small">
                {s.people.map((p: any) => (
                  <li key={p.personId}>
                    {p.name}: needs {p.needs.join(', ')}{' '}
                    <button className="btn sm" onClick={() => go('employees', { personId: p.personId, edit: p.edit })}>
                      Fix
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {s.sources?.length > 0 && !s.done && (
              <details className="small">
                <summary>The official sources</summary>
                <ul>
                  {s.sources.map((x: any, i: number) => (
                    <li key={i}>
                      <a href={x.url} target="_blank" rel="noreferrer">
                        {x.title} <ExternalLink size={12} />
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ol>
    </Page>
  );
}
