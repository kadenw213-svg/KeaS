import { useWork, fmtDay } from '../store';

export function People() {
  const { people, positions, certTypes } = useWork();
  const now = Date.now();
  const soon = now + 30 * 86400e3;
  return (
    <div className="work-page wide">
      <h1 className="work-title">People & certifications</h1>
      <p className="muted work-lead">Certification types are set by your workplace. Someone whose required certification has run out can’t be put on that position’s shifts.</p>
      <table className="work-table stack">
        <thead>
          <tr>
            <th>Name</th>
            <th>Positions</th>
            {certTypes.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id}>
              <td data-label="Name" className="stack-title">
                {p.name}
                {p.minor && <span className="work-tag">Minor · {p.age}</span>}
              </td>
              <td data-label="Positions">{p.positions.map((id) => positions.find((x) => x.id === id)?.name || id).join(', ') || '—'}</td>
              {certTypes.map((c) => {
                const cert = p.certs?.find((x) => x.typeId === c.id);
                const t = cert ? new Date(`${cert.expires}T23:59`).getTime() : 0;
                const cls = !cert ? 'none' : t < now ? 'expired' : t < soon ? 'soon' : 'ok';
                return (
                  <td key={c.id} data-label={c.name} className={`work-cert ${cls}`}>
                    {!cert ? '—' : t < now ? `Expired ${fmtDay(cert.expires)}` : t < soon ? `Expires ${fmtDay(cert.expires)}` : fmtDay(cert.expires)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
