import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, TriangleAlert, X } from 'lucide-react';
import { useWork, can, bumpWork, listOf, addDays, dayKey, fmtDay, fmtTime, hours, type Shift } from '../store';
import { api } from '../api';
import { Dialog, Spinner, toast } from '../ui';

export function Timecards() {
  const { me, people, tick } = useWork();
  const manager = can(me, 'manager') || can(me, 'payroll');
  const [personId, setPersonId] = useState(me?.id || '');
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [card, setCard] = useState<any | null>(null);
  const [requests, setRequests] = useState<any[]>([]);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setCard(null);
    api('GET', `/v1/timecards?personId=${encodeURIComponent(personId)}${periodStart ? `&periodStart=${periodStart}` : ''}`)
      .then(setCard)
      .catch((e) => (toast(e.message), setCard({ error: e.message })));
    api('GET', '/v1/punch-requests')
      .then((r) => setRequests(listOf(r, 'requests')))
      .catch(() => setRequests([]));
  }, [personId, periodStart, tick]);

  const decide = async (id: string, approve: boolean) => {
    try {
      await api('POST', `/v1/punch-requests/${id}/decide`, { approve });
      toast(approve ? 'Punch added to the timecard.' : 'Request declined.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const approve = async () => {
    try {
      await api('POST', '/v1/timecards/approve', { personId, periodStart: card?.period?.start });
      toast('Timecard approved and locked.');
      bumpWork();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const pending = requests.filter((r) => r.status === 'pending');
  const mineWaiting = pending.filter((r) => r.personId === me?.id);
  const name = (id: string) => people.find((p) => p.id === id)?.name || 'Someone';
  const flags = listOf(card?.flags, 'flags');

  return (
    <div className="work-page">
      <div className="work-head">
        <h1 className="work-title">Timecards</h1>
        {manager && (
          <select value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Whose timecard">
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

      {can(me, 'manager') && pending.length > 0 && (
        <section className="card work-requests">
          <h2 className="work-h2">Punch fixes waiting for you</h2>
          {pending.map((r) => (
            <div key={r.id} className="work-swap">
              <span>
                <strong>{r.personName || name(r.personId)}</strong> wants to add a clock-{r.type} at {fmtDay(r.at)} {fmtTime(r.at)} · {reasonLabel(r.reasonCode)}
                {r.note ? ` · “${r.note}”` : ''}
              </span>
              <div className="work-swap-acts">
                <button className="btn sm primary" onClick={() => decide(r.id, true)}>
                  <Check size={14} /> Approve
                </button>
                <button className="btn sm" onClick={() => decide(r.id, false)}>
                  <X size={14} /> Decline
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      {!can(me, 'manager') && mineWaiting.length > 0 && (
        <div className="work-banner">
          {mineWaiting.length} punch fix{mineWaiting.length === 1 ? '' : 'es'} waiting for your manager.
        </div>
      )}

      {!card ? (
        <Spinner />
      ) : card.error ? null : (
        <>
          <div className="work-period muted">
            <button className="icon-btn" aria-label="Previous pay period" title="Previous pay period" onClick={() => card.period?.start && setPeriodStart(addDays(card.period.start, -14))}>
              <ChevronLeft size={20} />
            </button>
            <span>
              Pay period {card.period?.start ? fmtDay(card.period.start) : ''} – {card.period?.end ? fmtDay(card.period.end) : ''}
            </span>
            <button className="icon-btn" aria-label="Next pay period" title="Next pay period" onClick={() => card.period?.start && setPeriodStart(addDays(card.period.start, 14))}>
              <ChevronRight size={20} />
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
          {flags.length > 0 && (
            <div className="work-flags">
              {flags.map((f: any, i: number) => (
                <div key={i} className="work-banner warn">
                  <TriangleAlert size={15} /> {f.message || f.code}
                </div>
              ))}
            </div>
          )}
          <table className="work-table stack">
            <thead>
              <tr>
                <th>Day</th>
                <th>Punches</th>
                <th>Worked</th>
                <th>Overtime</th>
              </tr>
            </thead>
            <tbody>
              {listOf(card.days, 'days').map((d: any) => {
                const punches = (d.punches || []).map((p: any) => `${p.type === 'in' ? 'In' : 'Out'} ${fmtTime(p.at)}${p.source?.startsWith('request') ? ' (fixed)' : ''}`).join(' · ');
                return (
                  <tr key={d.date} className={!punches && !d.workedMin ? 'empty' : ''}>
                    <td data-label="Day" className="stack-title">
                      {fmtDay(d.date)}
                    </td>
                    <td data-label="Punches">{punches || '—'}</td>
                    <td data-label="Worked">{hours(d.workedMin || 0)}</td>
                    <td data-label="Overtime">{d.overtimeMin ? hours(d.overtimeMin) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {can(me, 'manager') && !card.approved && personId !== me?.id && (
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
  const [type, setType] = useState<'in' | 'out'>('in');
  const [date, setDate] = useState(dayKey(new Date()));
  const [time, setTime] = useState('09:00');
  const [reasonCode, setReason] = useState('forgot');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const from = new Date(Date.now() - 3 * 86400e3);
    api('GET', `/v1/shifts?from=${from.toISOString()}&to=${new Date().toISOString()}`)
      .then((r) => {
        const mine = listOf<Shift>(r, 'shifts')
          .filter((s) => s.personId === me?.id && new Date(s.start) < new Date())
          .sort((a, b) => b.start.localeCompare(a.start));
        setShifts(mine);
        if (mine[0]) {
          setShiftId(mine[0].id);
          setDate(dayKey(new Date(mine[0].start)));
        }
      })
      .catch(() => setShifts([]));
  }, [me?.id]);
  const send = async () => {
    setBusy(true);
    try {
      await api('POST', '/v1/punch-requests', { shiftId, type, at: new Date(`${date}T${time}`).toISOString(), reasonCode, note: note || undefined });
      toast('Sent to your manager.');
      bumpWork();
      onClose();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Fix a missed punch" onClose={onClose} className="work-modal">
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
          <select value={type} onChange={(e) => setType(e.target.value as 'in' | 'out')}>
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
        Note {reasonCode === 'other' ? '(required)' : '(optional)'}
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!shiftId || busy || (reasonCode === 'other' && !note.trim())} onClick={send}>
          Send to manager
        </button>
      </div>
    </Dialog>
  );
}
