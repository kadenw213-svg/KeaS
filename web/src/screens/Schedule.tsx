import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Check, ChevronLeft, ChevronRight, Plus, TriangleAlert, X } from 'lucide-react';
import { useWork, can, bumpWork, listOf, dayKey, fmtDay, fmtTime, weekStart, type Shift } from '../store';
import { api, ApiError, type Problem } from '../api';
import { Dialog, Spinner, toast } from '../ui';

export function Schedule() {
  const { me, people, positions, tick } = useWork();
  const [start, setStart] = useState(() => weekStart());
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [swaps, setSwaps] = useState<any[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const manager = can(me, 'manager');
  const end = useMemo(() => {
    const e = new Date(start);
    e.setDate(e.getDate() + 7);
    return e;
  }, [start]);

  useEffect(() => {
    setShifts(null);
    Promise.all([api('GET', `/v1/shifts?from=${start.toISOString()}&to=${end.toISOString()}`), api('GET', '/v1/swaps').catch(() => [])])
      .then(([s, sw]) => (setShifts(listOf(s, 'shifts')), setSwaps(listOf(sw, 'swaps'))))
      .catch((e) => (toast(e.message), setShifts([])));
  }, [start, end, tick]);

  const days = [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const name = (id: string | null) => (id ? people.find((p) => p.id === id)?.name || 'Someone' : 'Open shift');
  const pos = (id: string) => positions.find((p) => p.id === id)?.name || '';
  const swapOf = (id: string) => swaps.find((s) => s.shiftId === id && (s.status === 'offered' || s.status === 'claimed'));
  const openSwaps = swaps.filter((s) => s.status === 'offered' || s.status === 'claimed');
  const drafts = shifts?.filter((s) => s.status === 'draft').length || 0;
  const today = dayKey(new Date());
  const shiftWeek = (n: number) =>
    setStart((s) => {
      const d = new Date(s);
      d.setDate(d.getDate() + 7 * n);
      return d;
    });

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    }
  };

  return (
    <div className="work-page wide">
      <div className="work-head">
        <h1 className="work-title">Schedule</h1>
        <div className="work-week">
          <button className="icon-btn" onClick={() => shiftWeek(-1)} aria-label="Previous week" title="Previous week">
            <ChevronLeft size={20} />
          </button>
          <span>Week of {fmtDay(start)}</span>
          <button className="icon-btn" onClick={() => shiftWeek(1)} aria-label="Next week" title="Next week">
            <ChevronRight size={20} />
          </button>
        </div>
        {manager && drafts > 0 && (
          // The server takes plain dates (first and last day of the week).
          <button className="btn primary" onClick={() => act(() => api('POST', '/v1/shifts/publish', { from: dayKey(days[0]), to: dayKey(days[6]) }), 'Schedule published.')}>
            Publish {drafts} draft shift{drafts === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {openSwaps.length > 0 && (
        <section className="work-swaps card">
          <h2 className="work-h2">Shift swaps</h2>
          {openSwaps.map((s) => {
            const sh: Shift | undefined = s.shift || shifts?.find((x) => x.id === s.shiftId);
            return (
              <div key={s.id} className="work-swap">
                <ArrowLeftRight size={16} />
                <span>
                  <strong>{s.fromName || name(s.fromPerson ?? null)}</strong> {s.status === 'claimed' ? `→ ${s.claimantName || name(s.claimant)}` : 'is offering'}{' '}
                  {sh ? `${fmtDay(sh.start)} ${fmtTime(sh.start)}–${fmtTime(sh.end)}` : 'a shift'}
                </span>
                <div className="work-swap-acts">
                  {s.status === 'offered' && s.fromPerson !== me?.id && (
                    <button className="btn sm" onClick={() => act(() => api('POST', `/v1/swaps/${s.id}/claim`), 'You asked to take this shift. A manager will approve it.')}>
                      Take it
                    </button>
                  )}
                  {manager && s.status === 'claimed' && (
                    <>
                      <button className="btn sm primary" onClick={() => act(() => api('POST', `/v1/swaps/${s.id}/decide`, { approve: true }), 'Swap approved.')}>
                        <Check size={14} /> Approve
                      </button>
                      <button className="btn sm" onClick={() => act(() => api('POST', `/v1/swaps/${s.id}/decide`, { approve: false }), 'Swap declined.')}>
                        <X size={14} /> Decline
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {!shifts ? (
        <Spinner />
      ) : (
        <div className="work-grid">
          {days.map((d) => {
            const key = dayKey(d);
            const list = shifts.filter((s) => dayKey(new Date(s.start)) === key).sort((a, b) => a.start.localeCompare(b.start));
            return (
              <section key={key} className={`work-day ${key === today ? 'today' : ''}`} aria-label={fmtDay(d)}>
                <div className="work-day-head">
                  <span className="work-day-short">
                    {d.toLocaleDateString([], { weekday: 'short' })} <span className="muted">{d.getDate()}</span>
                  </span>
                  <span className="work-day-long">{d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                  {key === today && <span className="work-tag ok">Today</span>}
                </div>
                {list.length === 0 && <div className="work-day-empty muted">No shifts</div>}
                {list.map((s) => (
                  <div key={s.id} className={`work-shift ${s.status === 'draft' ? 'draft' : ''} ${s.personId === me?.id ? 'mine' : ''} ${!s.personId ? 'open' : ''}`}>
                    <div className="work-shift-time">
                      {fmtTime(s.start)}–{fmtTime(s.end)}
                    </div>
                    <div>{s.personName || name(s.personId)}</div>
                    <div className="muted">{s.positionName || pos(s.positionId)}</div>
                    {s.status === 'draft' && <span className="work-tag">Draft</span>}
                    {swapOf(s.id) && <span className="work-tag">Swap</span>}
                    {s.personId === me?.id && s.status === 'published' && !swapOf(s.id) && new Date(s.start) > new Date() && (
                      <button className="btn sm work-shift-act" onClick={() => act(() => api('POST', '/v1/swaps', { shiftId: s.id }), 'Shift offered to the team.')}>
                        Offer swap
                      </button>
                    )}
                  </div>
                ))}
                {manager && (
                  <button className="work-add" onClick={() => setAdding(key)} aria-label={`Add a shift on ${fmtDay(d)}`}>
                    <Plus size={14} /> Add
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {adding && <AddShift day={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function AddShift({ day, onClose }: { day: string; onClose: () => void }) {
  const { people, positions } = useWork();
  const [positionId, setPositionId] = useState(positions[0]?.id || '');
  const [personId, setPersonId] = useState('');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('14:00');
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const iso = (t: string) => new Date(`${day}T${t}`).toISOString();
  const endIso = () => {
    const e = new Date(`${day}T${to}`);
    if (to <= from) e.setDate(e.getDate() + 1);
    return e.toISOString();
  };
  // Check the person against the shift as it's filled in.
  useEffect(() => {
    setProblems(null);
    if (!personId || !positionId) return;
    const t = setTimeout(() => {
      api('POST', '/v1/shifts/check', { personId, positionId, start: iso(from), end: endIso() })
        .then((r) => setProblems(listOf(r, 'problems')))
        .catch(() => setProblems(null));
    }, 250);
    return () => clearTimeout(t);
  }, [personId, positionId, from, to]);

  const save = async () => {
    setBusy(true);
    try {
      await api('POST', '/v1/shifts', { positionId, personId: personId || null, start: iso(from), end: endIso(), status: 'draft' });
      toast('Shift added as a draft.');
      bumpWork();
      onClose();
    } catch (e: any) {
      if (e instanceof ApiError && e.problems.length) setProblems(e.problems);
      else toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const blocking = problems?.some((p) => p.blocking);

  return (
    <Dialog title={`Add a shift · ${fmtDay(day)}`} onClose={onClose} className="work-modal">
      <label>
        Position
        <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="work-row">
        <label>
          From
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <label>
        Who
        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Leave open (anyone can pick it up)</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.minor ? ` (minor, ${p.age})` : ''}
            </option>
          ))}
        </select>
      </label>
      {problems && problems.length > 0 && (
        <div className="work-problems" aria-live="polite">
          {problems.map((p, i) => (
            <div key={i} className={`work-banner ${p.blocking ? 'danger' : 'warn'}`}>
              <TriangleAlert size={15} /> {p.message}
            </div>
          ))}
        </div>
      )}
      {problems && problems.length === 0 && personId && <div className="work-ok">No problems with this assignment.</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !!blocking} onClick={save} title={blocking ? 'Fix the problems above first.' : ''}>
          Add shift
        </button>
      </div>
    </Dialog>
  );
}
