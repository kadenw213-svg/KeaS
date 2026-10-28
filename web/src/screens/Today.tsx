import { useEffect, useState } from 'react';
import { LogIn, LogOut, TriangleAlert } from 'lucide-react';
import { useWork, can, bumpWork, listOf, fmtDay, fmtTime, REFRESH_SEC, type Shift } from '../store';
import { api } from '../api';
import { ask, toast, Spinner } from '../ui';

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

export function Today() {
  const { me, people, positions, tick } = useWork();
  const [rows, setRows] = useState<StatusRow[] | null>(null);
  const [mine, setMine] = useState<Shift[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const manager = can(me, 'manager');

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 8);
      const [st, sh, al] = await Promise.all([
        api('GET', '/v1/status/today').catch(() => []),
        api('GET', `/v1/shifts?from=${from.toISOString()}&to=${to.toISOString()}`).catch(() => []),
        manager ? api('GET', '/v1/alerts').catch(() => []) : Promise.resolve([])
      ]);
      if (stop) return;
      setRows(listOf(st, 'shifts'));
      setMine(listOf<Shift>(sh, 'shifts').filter((s) => s.personId === me?.id).sort((a, b) => a.start.localeCompare(b.start)));
      setAlerts(listOf<any>(al, 'alerts').filter((a) => !a.resolved));
    };
    load();
    const t = setInterval(load, REFRESH_SEC * 1000);
    // Phones suspend timers: refresh as soon as the app comes back.
    const vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [tick, me?.id, manager]);

  const myRow = rows?.find((r) => r.personId === me?.id && (r.state === 'clocked_in' || r.state === 'upcoming' || r.state === 'late' || r.state === 'no_show'));
  const clockedIn = rows?.some((r) => r.personId === me?.id && r.state === 'clocked_in');
  const next = mine.find((s) => new Date(s.end) > new Date());
  const name = (id: string | null) => people.find((p) => p.id === id)?.name || 'Open shift';
  const pos = (id?: string) => positions.find((p) => p.id === id)?.name || '';

  const punch = async (type: 'in' | 'out') => {
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
      const r = await api<{ late?: boolean; minutesLate?: number }>('POST', '/v1/punches', { type, restAttested });
      toast(type === 'in' ? (r.late ? `Clocked in (${r.minutesLate} min late).` : 'Clocked in.') : 'Clocked out.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="work-page today-page">
      <h1 className="work-title">Today</h1>
      <section className="work-clock card">
        <div>
          <div className="muted">{clockedIn ? 'You’re clocked in' : 'Your next shift'}</div>
          {next ? (
            <div className="work-next">
              <strong>{fmtDay(next.start)}</strong> · {fmtTime(next.start)}–{fmtTime(next.end)} · {pos(next.positionId)}
            </div>
          ) : (
            <div className="work-next muted">No shifts in the next week.</div>
          )}
          {myRow?.state === 'late' && <div className="work-late">You’re {myRow.minutesLate} min late for this shift.</div>}
        </div>
        <div className="work-clock-bar">
          <button className={`btn work-clock-btn ${clockedIn ? 'out' : 'primary'}`} disabled={busy || !rows} onClick={() => punch(clockedIn ? 'out' : 'in')}>
            {clockedIn ? <LogOut size={22} /> : <LogIn size={22} />}
            {clockedIn ? 'Clock out' : 'Clock in'}
          </button>
        </div>
      </section>

      {manager && (
        <>
          {alerts.length > 0 && (
            <section className="work-alerts" aria-label="Alerts">
              {alerts.map((a, i) => (
                <div key={i} className="work-banner warn">
                  <TriangleAlert size={16} /> {a.message || `${name(a.personId)} is ${a.minutesLate} min late`}
                </div>
              ))}
            </section>
          )}
          <h2 className="work-h2">On the schedule today</h2>
          {!rows ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <p className="muted">Nobody is scheduled today.</p>
          ) : (
            <div className="work-board">
              {rows.map((r) => (
                <div key={r.shiftId} className={`work-board-row st-${r.state}`}>
                  <span className="work-dot" aria-hidden="true" />
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
