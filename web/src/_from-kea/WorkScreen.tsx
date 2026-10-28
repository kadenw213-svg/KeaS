import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, Clock, LogIn, LogOut, RefreshCw, Users, Wallet, ArrowLeftRight, Check, X, Plus, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { useWork, loadWork, w, WorkError, can, bumpWork, WorkView, Shift, Problem, dayKey, fmtTime, fmtDay, hours, money, weekStart, Person, addDays } from './workStore';
import { api } from '../../lib/api';
import { useSetting } from '../../lib/settings';
import { toast, ask } from '../../store';
import { useAreaOn } from '../../lib/areas';

/** The Work area: today and the time clock, the schedule, timecards, people and pay runs. */
export function WorkScreen() {
  const { status, me, org, view, set, error } = useWork();
  const payrollOn = useAreaOn('payroll');
  useEffect(() => {
    if (status === null) loadWork();
  }, [status]);

  if (status === null) return <div className="center-fill"><div className="spinner" /></div>;
  if (status === 'signedOut') return <SignIn />;
  if (status === 'offline') return <Offline />;

  const nav: { id: WorkView; label: string; icon: JSX.Element; show: boolean }[] = [
    { id: 'today', label: 'Today', icon: <Clock size={17} />, show: true },
    { id: 'schedule', label: 'Schedule', icon: <CalendarDays size={17} />, show: true },
    { id: 'timecards', label: 'Timecards', icon: <ShieldAlert size={17} />, show: true },
    { id: 'people', label: 'People & certifications', icon: <Users size={17} />, show: can(me, 'manager') || can(me, 'payroll') },
    { id: 'pay', label: 'Pay run', icon: <Wallet size={17} />, show: can(me, 'payroll') && payrollOn }
  ];

  return (
    <div className="work">
      <nav className="work-nav">
        <div className="work-org">
          <strong>{org?.name || 'Workplace'}</strong>
          <span className="muted">{me?.name}</span>
        </div>
        {nav
          .filter((n) => n.show)
          .map((n) => (
            <button key={n.id} className={`work-link ${view === n.id ? 'active' : ''}`} onClick={() => set({ view: n.id })}>
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        <div className="work-spacer" />
        <button className="work-link" onClick={() => api.work.signOut().then(() => set({ status: 'signedOut', me: null }))}>
          <LogOut size={17} />
          <span>Sign out</span>
        </button>
      </nav>
      <main className="work-main">
        {error && <div className="work-banner warn">{error}</div>}
        {view === 'today' && <Today />}
        {view === 'schedule' && <Schedule />}
        {view === 'timecards' && <Timecards />}
        {view === 'people' && <People />}
        {view === 'pay' && <PayRun />}
      </main>
    </div>
  );
}

function Offline() {
  return (
    <div className="center-fill work-empty">
      <AlertTriangle size={28} />
      <h2>Can’t reach your workplace’s server</h2>
      <p className="muted">Your schedule and timecards live on your workplace’s Kea server. For this prototype, start it with <code>npm run server:dev</code> in the Kea folder.</p>
      <button className="btn primary" onClick={() => useWork.getState().set({ status: null })}>
        <RefreshCw size={16} /> Try again
      </button>
    </div>
  );
}

/** Prototype sign-in: pick one of the demo org's people. Real accounts come with the server build. */
function SignIn() {
  const [users, setUsers] = useState<Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.work
      .call<Person[]>('GET', '/v1/auth/demo-users')
      .then((r) => (r.ok ? setUsers(r.data) : setErr((r.data as any)?.error || 'The server didn’t answer.')))
      .catch(() => useWork.getState().set({ status: 'offline' }));
  }, []);
  const pick = async (id: string) => {
    try {
      await api.work.demoLogin(id);
      useWork.getState().set({ status: null });
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };
  return (
    <div className="work-signin">
      <h1>Sign in to your workplace</h1>
      <p className="muted">Prototype: this is the demo workplace with made-up people. Pick who to be.</p>
      {err && <div className="work-banner warn">{err}</div>}
      {!users ? (
        <div className="spinner" />
      ) : (
        <div className="work-people-pick">
          {users.map((u) => (
            <button key={u.id} className="work-pick" onClick={() => pick(u.id)}>
              <strong>{u.name}</strong>
              <span className="muted">{u.roles.filter((r) => r !== 'member').join(', ') || 'staff'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Today ---------------- */

interface StatusRow {
  shiftId: string;
  personId: string;
  personName?: string;
  positionId?: string;
  start: string;
  end: string;
  state: 'late' | 'no_show' | 'clocked_in' | 'clocked_out' | 'upcoming';
  arrival?: 'on_time' | 'late' | null;
  minutesLate?: number;
}

const STATE_LABEL: Record<StatusRow['state'], string> = {
  late: 'Late',
  no_show: 'No-show',
  clocked_in: 'Clocked in',
  clocked_out: 'Done',
  upcoming: 'Upcoming'
};

function Today() {
  const { me, people, positions, tick } = useWork();
  const [rows, setRows] = useState<StatusRow[] | null>(null);
  const [mine, setMine] = useState<Shift[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const confirmOut = useSetting<boolean>('work.clockConfirm');
  const refreshSec = useSetting<number>('work.refreshSec');
  const manager = can(me, 'manager');

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 8);
      const [st, sh, al] = await Promise.all([
        w<any>('GET', '/v1/status/today').catch(() => []),
        w<any>('GET', `/v1/shifts?from=${from.toISOString()}&to=${to.toISOString()}`).catch(() => []),
        manager ? w<any>('GET', '/v1/alerts').catch(() => []) : Promise.resolve([])
      ]);
      if (stop) return;
      setRows(listOf(st, 'shifts'));
      setMine(listOf<Shift>(sh, 'shifts').filter((s) => s.personId === me?.id).sort((a, b) => a.start.localeCompare(b.start)));
      setAlerts(listOf<any>(al, 'alerts').filter((a) => !a.resolved));
    };
    load();
    const t = setInterval(load, Math.max(15, refreshSec || 60) * 1000);
    return () => ((stop = true), clearInterval(t));
  }, [tick, me?.id, manager, refreshSec]);

  const myRow = rows?.find((r) => r.personId === me?.id && (r.state === 'clocked_in' || r.state === 'upcoming' || r.state === 'late' || r.state === 'no_show'));
  const clockedIn = rows?.some((r) => r.personId === me?.id && r.state === 'clocked_in');
  const next = mine.find((s) => new Date(s.end) > new Date());
  const name = (id: string | null) => people.find((p) => p.id === id)?.name || 'Open shift';
  const pos = (id?: string) => positions.find((p) => p.id === id)?.name || '';

  const punch = async (type: 'in' | 'out') => {
    if (type === 'out' && confirmOut && (await ask('Clock out now?', '', [{ id: 'no', label: 'Not yet' }, { id: 'yes', label: 'Clock out', primary: true }])) !== 'yes') return;
    let restAttested: boolean | undefined;
    if (type === 'out') {
      const r = await ask('Did you get all of your rest breaks this shift?', 'If you missed any, say so: you’re paid extra for each missed break.', [
        { id: 'cancel', label: 'Cancel' },
        { id: 'missed', label: 'I missed a break' },
        { id: 'yes', label: 'Yes, I got them', primary: true }
      ]);
      if (r === 'cancel') return;
      restAttested = r === 'yes';
    }
    setBusy(true);
    try {
      await w('POST', '/v1/punches', { type, restAttested });
      toast(type === 'in' ? 'Clocked in.' : 'Clocked out.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="work-page">
      <h1 className="work-title">Today</h1>
      <section className="work-clock card">
        <div>
          <div className="muted">Your next shift</div>
          {next ? (
            <div className="work-next">
              <strong>{fmtDay(next.start)}</strong> · {fmtTime(next.start)}–{fmtTime(next.end)} · {pos(next.positionId)}
            </div>
          ) : (
            <div className="work-next muted">No shifts in the next week.</div>
          )}
          {myRow?.state === 'late' && <div className="work-late">You’re {myRow.minutesLate} min late for this shift.</div>}
        </div>
        <button className={`btn work-clock-btn ${clockedIn ? '' : 'primary'}`} disabled={busy} onClick={() => punch(clockedIn ? 'out' : 'in')}>
          {clockedIn ? <LogOut size={20} /> : <LogIn size={20} />}
          {clockedIn ? 'Clock out' : 'Clock in'}
        </button>
      </section>

      {manager && (
        <>
          {alerts.length > 0 && (
            <section className="work-alerts">
              {alerts.map((a, i) => (
                <div key={i} className="work-banner warn">
                  <AlertTriangle size={16} /> {a.message || `${name(a.personId)} is ${a.minutesLate} min late`}
                </div>
              ))}
            </section>
          )}
          <h2 className="work-h2">On the schedule today</h2>
          {!rows ? (
            <div className="spinner" />
          ) : rows.length === 0 ? (
            <p className="muted">Nobody is scheduled today.</p>
          ) : (
            <div className="work-board">
              {rows.map((r) => (
                <div key={r.shiftId} className={`work-board-row st-${r.state}`}>
                  <span className="work-dot" />
                  <strong>{r.personName || name(r.personId)}</strong>
                  <span className="muted">{pos(r.positionId)}</span>
                  <span>
                    {fmtTime(r.start)}–{fmtTime(r.end)}
                  </span>
                  <span className="work-state">
                    {STATE_LABEL[r.state] || r.state}
                    {r.minutesLate && (r.state === 'late' || r.arrival === 'late') ? ` · ${r.minutesLate} min late` : r.arrival === 'on_time' ? ' · on time' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Accept either a bare list or { key: list } from the server. */
function listOf<T = any>(v: any, key: string): T[] {
  return Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : [];
}

/* ---------------- Schedule ---------------- */

function Schedule() {
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
    Promise.all([w<any>('GET', `/v1/shifts?from=${start.toISOString()}&to=${end.toISOString()}`), w<any>('GET', '/v1/swaps').catch(() => [])])
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
  const drafts = shifts?.filter((s) => s.status === 'draft').length || 0;
  const shiftWeek = (n: number) => setStart((s) => {
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
          <button className="icon-btn sm" onClick={() => shiftWeek(-1)} title="Previous week">
            <ChevronLeft size={18} />
          </button>
          <span>Week of {fmtDay(start)}</span>
          <button className="icon-btn sm" onClick={() => shiftWeek(1)} title="Next week">
            <ChevronRight size={18} />
          </button>
        </div>
        {manager && drafts > 0 && (
          <button className="btn primary" onClick={() => act(() => w('POST', '/v1/shifts/publish', { from: start.toISOString(), to: end.toISOString() }), 'Schedule published.')}>
            Publish {drafts} draft shift{drafts === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {swaps.filter((s) => s.status === 'offered' || s.status === 'claimed').length > 0 && (
        <section className="work-swaps card">
          <h2 className="work-h2">Shift swaps</h2>
          {swaps
            .filter((s) => s.status === 'offered' || s.status === 'claimed')
            .map((s) => {
              const sh: Shift | undefined = s.shift || shifts?.find((x) => x.id === s.shiftId);
              return (
                <div key={s.id} className="work-swap">
                  <ArrowLeftRight size={16} />
                  <span>
                    <strong>{name(s.fromPerson ?? s.from_person ?? null)}</strong> {s.status === 'claimed' ? `→ ${name(s.claimant)}` : 'is offering'} {sh ? `${fmtDay(sh.start)} ${fmtTime(sh.start)}–${fmtTime(sh.end)}` : 'a shift'}
                  </span>
                  {s.status === 'offered' && (s.fromPerson ?? s.from_person) !== me?.id && (
                    <button className="btn sm" onClick={() => act(() => w('POST', `/v1/swaps/${s.id}/claim`), 'You asked to take this shift. A manager will approve it.')}>
                      Take it
                    </button>
                  )}
                  {manager && s.status === 'claimed' && (
                    <>
                      <button className="btn sm primary" onClick={() => act(() => w('POST', `/v1/swaps/${s.id}/decide`, { approve: true }), 'Swap approved.')}>
                        <Check size={14} /> Approve
                      </button>
                      <button className="btn sm" onClick={() => act(() => w('POST', `/v1/swaps/${s.id}/decide`, { approve: false }), 'Swap declined.')}>
                        <X size={14} /> Decline
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </section>
      )}

      {!shifts ? (
        <div className="spinner" />
      ) : (
        <div className="work-grid">
          {days.map((d) => {
            const key = dayKey(d);
            const list = shifts.filter((s) => dayKey(new Date(s.start)) === key).sort((a, b) => a.start.localeCompare(b.start));
            return (
              <div key={key} className={`work-day ${key === dayKey(new Date()) ? 'today' : ''}`}>
                <div className="work-day-head">
                  {d.toLocaleDateString([], { weekday: 'short' })} <span className="muted">{d.getDate()}</span>
                </div>
                {list.map((s) => (
                  <div key={s.id} className={`work-shift ${s.status === 'draft' ? 'draft' : ''} ${s.personId === me?.id ? 'mine' : ''} ${!s.personId ? 'open' : ''}`}>
                    <div className="work-shift-time">
                      {fmtTime(s.start)}–{fmtTime(s.end)}
                    </div>
                    <div>{name(s.personId)}</div>
                    <div className="muted">{pos(s.positionId)}</div>
                    {s.status === 'draft' && <span className="work-tag">Draft</span>}
                    {swapOf(s.id) && <span className="work-tag">Swap</span>}
                    {s.personId === me?.id && s.status === 'published' && !swapOf(s.id) && new Date(s.start) > new Date() && (
                      <button className="btn sm work-shift-act" onClick={() => act(() => w('POST', '/v1/swaps', { shiftId: s.id }), 'Shift offered to the team.')}>
                        Offer swap
                      </button>
                    )}
                  </div>
                ))}
                {manager && (
                  <button className="work-add" onClick={() => setAdding(key)}>
                    <Plus size={14} /> Add
                  </button>
                )}
              </div>
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
      w<any>('POST', '/v1/shifts/check', { personId, positionId, start: iso(from), end: endIso() })
        .then((r) => setProblems(listOf(r, 'problems')))
        .catch(() => setProblems(null));
    }, 250);
    return () => clearTimeout(t);
  }, [personId, positionId, from, to]);

  const save = async () => {
    setBusy(true);
    try {
      await w('POST', '/v1/shifts', { positionId, personId: personId || null, start: iso(from), end: endIso(), status: 'draft' });
      toast('Shift added as a draft.');
      bumpWork();
      onClose();
    } catch (e: any) {
      if (e instanceof WorkError && e.problems.length) setProblems(e.problems);
      else toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const blocking = problems?.some((p) => p.blocking);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog work-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add a shift · {fmtDay(new Date(`${day}T12:00`))}</h2>
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
          <div className="work-problems">
            {problems.map((p, i) => (
              <div key={i} className={`work-banner ${p.blocking ? 'danger' : 'warn'}`}>
                <AlertTriangle size={15} /> {p.message}
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
      </div>
    </div>
  );
}

/* ---------------- Timecards ---------------- */

function Timecards() {
  const { me, people, tick } = useWork();
  const manager = can(me, 'manager') || can(me, 'payroll');
  const [personId, setPersonId] = useState(me?.id || '');
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [card, setCard] = useState<any | null>(null);
  const [requests, setRequests] = useState<any[]>([]);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setCard(null);
    w<any>('GET', `/v1/timecards?personId=${encodeURIComponent(personId)}${periodStart ? `&periodStart=${periodStart}` : ''}`)
      .then(setCard)
      .catch((e) => (toast(e.message), setCard({ error: e.message })));
    w<any>('GET', '/v1/punch-requests')
      .then((r) => setRequests(listOf(r, 'requests')))
      .catch(() => setRequests([]));
  }, [personId, periodStart, tick]);

  const decide = async (id: string, approve: boolean) => {
    try {
      await w('POST', `/v1/punch-requests/${id}/decide`, { approve });
      toast(approve ? 'Punch added to the timecard.' : 'Request declined.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const approve = async () => {
    try {
      await w('POST', '/v1/timecards/approve', { personId, periodStart: card?.period?.start });
      toast('Timecard approved and locked.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const pending = requests.filter((r) => r.status === 'pending');
  const name = (id: string) => people.find((p) => p.id === id)?.name || 'Someone';

  return (
    <div className="work-page">
      <div className="work-head">
        <h1 className="work-title">Timecards</h1>
        {manager && (
          <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn" onClick={() => setAsking(true)}>
          Fix a missed punch
        </button>
      </div>

      {manager && pending.length > 0 && (
        <section className="card work-requests">
          <h2 className="work-h2">Punch fixes waiting for you</h2>
          {pending.map((r) => (
            <div key={r.id} className="work-swap">
              <span>
                <strong>{name(r.personId)}</strong> wants to add a clock-{r.type} at {fmtDay(r.at)} {fmtTime(r.at)} · {reasonLabel(r.reasonCode)}
                {r.note ? ` · “${r.note}”` : ''}
              </span>
              <button className="btn sm primary" onClick={() => decide(r.id, true)}>
                <Check size={14} /> Approve
              </button>
              <button className="btn sm" onClick={() => decide(r.id, false)}>
                <X size={14} /> Decline
              </button>
            </div>
          ))}
        </section>
      )}

      {!card ? (
        <div className="spinner" />
      ) : card.error ? null : (
        <>
          <div className="work-period muted">
            <button className="icon-btn sm" title="Previous pay period" onClick={() => card.period?.start && setPeriodStart(addDays(card.period.start, -14))}>
              <ChevronLeft size={16} />
            </button>
            Pay period {card.period?.start ? fmtDay(card.period.start) : ''} – {card.period?.end ? fmtDay(card.period.end) : ''}
            <button className="icon-btn sm" title="Next pay period" onClick={() => card.period?.start && setPeriodStart(addDays(card.period.start, 14))}>
              <ChevronRight size={16} />
            </button>
            {card.approved && <span className="work-tag ok">Approved</span>}
          </div>
          <div className="work-totals">
            <div className="card">
              <span className="muted">Regular</span>
              <strong>{hours(card.totals?.regularMin || 0)}</strong>
            </div>
            <div className="card">
              <span className="muted">Overtime</span>
              <strong>{hours(card.totals?.overtimeMin || 0)}</strong>
            </div>
            <div className="card">
              <span className="muted">Missed-break pay</span>
              <strong>{card.totals?.restPremiumMin || 0} min</strong>
            </div>
            <div className="card">
              <span className="muted">Late / fixes</span>
              <strong>
                {card.lateCount ?? 0} / {card.editCount ?? 0}
              </strong>
            </div>
          </div>
          {listOf(card.flags, 'flags').length > 0 && (
            <div className="work-flags">
              {listOf(card.flags, 'flags').map((f: any, i: number) => (
                <div key={i} className="work-banner warn">
                  <AlertTriangle size={15} /> {f.message || f.code}
                </div>
              ))}
            </div>
          )}
          <table className="work-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Punches</th>
                <th>Worked</th>
                <th>Overtime</th>
              </tr>
            </thead>
            <tbody>
              {listOf(card.days, 'days').map((d: any) => (
                <tr key={d.date}>
                  <td>{fmtDay(d.date + 'T12:00')}</td>
                  <td>{(d.punches || []).map((p: any) => `${p.type === 'in' ? 'In' : 'Out'} ${fmtTime(p.at)}${p.source?.startsWith('request') ? ' (fixed)' : ''}`).join(' · ') || '—'}</td>
                  <td>{hours(d.workedMin || 0)}</td>
                  <td>{d.overtimeMin ? hours(d.overtimeMin) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {can(me, 'manager') && !card.approved && (
            <button className="btn primary" onClick={approve}>
              Approve this timecard
            </button>
          )}
        </>
      )}
      {asking && <MissedPunch onClose={() => setAsking(false)} />}
    </div>
  );
}

const REASONS: [string, string][] = [
  ['forgot', 'Forgot to clock'],
  ['device', 'Phone or kiosk problem'],
  ['early_late_fix', 'Wrong time recorded'],
  ['other', 'Something else']
];
const reasonLabel = (c: string) => REASONS.find((r) => r[0] === c)?.[1] || c;

function MissedPunch({ onClose }: { onClose: () => void }) {
  const me = useWork((s) => s.me);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [shiftId, setShiftId] = useState('');
  useEffect(() => {
    const from = new Date(Date.now() - 3 * 86400e3);
    w<any>('GET', `/v1/shifts?from=${from.toISOString()}&to=${new Date().toISOString()}`)
      .then((r) => {
        const mine = listOf<Shift>(r, 'shifts').filter((s) => s.personId === me?.id && new Date(s.start) < new Date()).sort((a, b) => b.start.localeCompare(a.start));
        setShifts(mine);
        if (mine[0]) {
          setShiftId(mine[0].id);
          setDate(dayKey(new Date(mine[0].start)));
        }
      })
      .catch(() => setShifts([]));
  }, [me?.id]);
  const [type, setType] = useState<'in' | 'out'>('in');
  const [date, setDate] = useState(dayKey(new Date()));
  const [time, setTime] = useState('09:00');
  const [reasonCode, setReason] = useState('forgot');
  const [note, setNote] = useState('');
  const send = async () => {
    try {
      await w('POST', '/v1/punch-requests', { shiftId, type, at: new Date(`${date}T${time}`).toISOString(), reasonCode, note });
      toast('Sent to your manager.');
      bumpWork();
      onClose();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog work-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Fix a missed punch</h2>
        <p className="muted">Your manager approves it, and the change is kept on record with your reason.</p>
        <label>
          Shift
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            {shifts.length === 0 && <option value="">No shifts in the last 3 days</option>}
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {fmtDay(s.start)} · {fmtTime(s.start)}–{fmtTime(s.end)}
              </option>
            ))}
          </select>
        </label>
        <div className="work-row">
          <label>
            Missed
            <select value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="in">Clock in</option>
              <option value="out">Clock out</option>
            </select>
          </label>
          <label>
            Day
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <label>
          Why
          <select value={reasonCode} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note (optional)
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!shiftId} onClick={send}>
            Send to manager
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- People ---------------- */

function People() {
  const { people, positions, certTypes } = useWork();
  const now = Date.now();
  const soon = now + 30 * 86400e3;
  return (
    <div className="work-page wide">
      <h1 className="work-title">People & certifications</h1>
      <p className="muted">Certification types are set by your workplace. Someone whose required certification has run out can’t be put on that position’s shifts.</p>
      <table className="work-table">
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
              <td>
                {p.name}
                {p.minor && <span className="work-tag">Minor · {p.age}</span>}
              </td>
              <td>{p.positions.map((id) => positions.find((x) => x.id === id)?.name || id).join(', ')}</td>
              {certTypes.map((c) => {
                const cert = p.certs?.find((x) => x.typeId === c.id);
                const t = cert ? new Date(cert.expires).getTime() : 0;
                const cls = !cert ? 'none' : t < now ? 'expired' : t < soon ? 'soon' : 'ok';
                return (
                  <td key={c.id} className={`work-cert ${cls}`}>
                    {!cert ? '—' : t < now ? `Expired ${fmtDay(cert.expires)}` : fmtDay(cert.expires)}
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

/* ---------------- Pay run ---------------- */

function PayRun() {
  const [run, setRun] = useState<any | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nacha, setNacha] = useState<string | null>(null);
  useEffect(() => {
    w<any>('GET', '/v1/payrun/preview')
      .then(setRun)
      .catch((e) => setRun({ error: e.message }));
  }, []);
  if (!run) return <div className="spinner" />;
  if (run.error) return <div className="work-page"><div className="work-banner warn">{run.error}</div></div>;
  const lines = listOf(run.lines, 'lines');
  const cents = (v: any) => (typeof v === 'number' ? v : v?.cents ?? 0);
  const sumTax = (t: any) => Object.values(t || {}).reduce((a: number, v: any) => a + cents(v), 0);

  return (
    <div className="work-page wide">
      <div className="work-head">
        <h1 className="work-title">Pay run</h1>
        <span className="muted">
          {run.period?.start ? fmtDay(run.period.start) : ''} – {run.period?.end ? fmtDay(run.period.end) : ''}
        </span>
      </div>
      {run.unverified && (
        <div className="work-banner danger">
          <ShieldAlert size={16} /> Prototype estimates. The tax tables used here haven’t been verified for this year, so this pay run can’t be finalized. Check every number before using it.
        </div>
      )}
      {groupWarnings(listOf(run.warnings, 'warnings'), lines).map((x, i) => (
        <div key={i} className="work-banner warn">
          <AlertTriangle size={15} /> {x}
        </div>
      ))}
      <table className="work-table pay">
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
          {lines.map((l: any) => (
            <>
              <tr key={l.personId} className="work-pay-row" onClick={() => setOpen(open === l.personId ? null : l.personId)}>
                <td>{l.name}</td>
                <td>{(Number(l.hours?.regular || 0) + Number(l.hours?.overtime || 0)).toFixed(2)}{l.hours?.overtime ? ` (${Number(l.hours.overtime).toFixed(2)} OT)` : ''}</td>
                <td>{money(cents(l.gross))}</td>
                <td>{money(sumTax(l.taxes))}</td>
                <td>
                  <strong>{money(cents(l.net))}</strong>
                </td>
                <td>{money(sumTax(l.employer))}</td>
              </tr>
              {open === l.personId && (
                <tr key={l.personId + ':x'} className="work-explain">
                  <td colSpan={6}>
                    <ol>
                      {listOf(l.explain, 'explain').map((s: any, i: number) => (
                        <li key={i}>{typeof s === 'string' ? s : s.text || JSON.stringify(s)}</li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
      <div className="work-head">
        <button className="btn" disabled title="Finalizing needs verified tax tables for this year.">
          Finalize pay run
        </button>
        <button className="btn" onClick={() => w<any>('GET', '/v1/payrun/nacha').then((r) => setNacha(r.text || '')).catch((e) => toast(e.message))}>
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
 * One line per kind of warning ("9 timecards aren't approved yet: …") instead of a row per person.
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
