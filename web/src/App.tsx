import { useEffect, useState, type ReactNode } from 'react';
import { CalendarDays, Clock, FileClock, LogOut, RefreshCw, TriangleAlert, Users, Wallet } from 'lucide-react';
import { useWork, loadWork, can, go, signOut, type WorkView, type Person } from './store';
import { api } from './api';
import { AskHost, Spinner, Toasts } from './ui';
import { APP_ICON, APP_NAME } from './brand';
import { Today } from './screens/Today';
import { Schedule } from './screens/Schedule';
import { Timecards } from './screens/Timecards';
import { People } from './screens/People';
import { PayRun } from './screens/PayRun';

export function App() {
  return (
    <>
      <Work />
      <Toasts />
      <AskHost />
    </>
  );
}

/** The app: today and the time clock, the schedule, timecards, people and pay runs. */
function Work() {
  const { status, me, org, view, error } = useWork();
  useEffect(() => {
    if (status === null) loadWork();
  }, [status]);

  if (status === null)
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    );
  if (status === 'signedOut') return <SignIn />;
  if (status === 'offline') return <Offline />;

  const nav: { id: WorkView; label: string; short: string; icon: ReactNode; show: boolean }[] = [
    { id: 'today', label: 'Today', short: 'Today', icon: <Clock size={20} />, show: true },
    { id: 'schedule', label: 'Schedule', short: 'Schedule', icon: <CalendarDays size={20} />, show: true },
    { id: 'timecards', label: 'Timecards', short: 'Timecards', icon: <FileClock size={20} />, show: true },
    { id: 'people', label: 'People & certifications', short: 'People', icon: <Users size={20} />, show: can(me, 'manager') || can(me, 'payroll') },
    { id: 'pay', label: 'Pay run', short: 'Pay', icon: <Wallet size={20} />, show: can(me, 'payroll') }
  ];
  const shown = nav.filter((n) => n.show);
  const current = shown.some((n) => n.id === view) ? view : 'today';

  return (
    <div className="work">
      <header className="work-topbar">
        <img src={APP_ICON} alt="" width={28} height={28} />
        <div className="work-topbar-text">
          <strong>{org?.name || 'Workplace'}</strong>
          <span className="muted">{me?.name}</span>
        </div>
        <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={20} />
        </button>
      </header>
      <nav className="work-nav" aria-label="Main">
        <div className="work-org">
          <div className="work-brand">
            <img src={APP_ICON} alt="" width={24} height={24} />
            <span>{APP_NAME}</span>
          </div>
          <strong>{org?.name || 'Workplace'}</strong>
          <span className="muted">{me?.name}</span>
        </div>
        {shown.map((n) => (
          <button key={n.id} className={`work-link ${current === n.id ? 'active' : ''}`} aria-current={current === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
            {n.icon}
            <span className="work-link-long">{n.label}</span>
            <span className="work-link-short">{n.short}</span>
          </button>
        ))}
        <div className="work-spacer" />
        <button className="work-link work-signout" onClick={signOut}>
          <LogOut size={20} />
          <span>Sign out</span>
        </button>
      </nav>
      <main className="work-main">
        {error && <div className="work-banner warn">{error}</div>}
        {current === 'today' && <Today />}
        {current === 'schedule' && <Schedule />}
        {current === 'timecards' && <Timecards />}
        {current === 'people' && <People />}
        {current === 'pay' && <PayRun />}
      </main>
    </div>
  );
}

function Offline() {
  return (
    <div className="center-fill work-empty">
      <TriangleAlert size={28} />
      <h2>Can’t reach your workplace’s server</h2>
      <p className="muted">Your schedule and timecards live on your workplace’s KeaS server. Check your connection, or ask whoever runs it.</p>
      <button className="btn primary" onClick={() => useWork.getState().set({ status: null })}>
        <RefreshCw size={16} /> Try again
      </button>
    </div>
  );
}

/** Sign-in for the development workplace: pick one of its people. */
function SignIn() {
  const [users, setUsers] = useState<Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api<Person[]>('GET', '/v1/auth/demo-users')
      .then(setUsers)
      .catch((e) => setErr(e.message));
  }, []);
  const pick = async (id: string) => {
    setBusy(id);
    try {
      await api('POST', '/v1/auth/demo-login', { personId: id });
      useWork.getState().set({ status: null, error: null });
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(null);
    }
  };
  const role = (u: Person) => u.roles.filter((r) => r !== 'member').join(', ') || 'staff';
  return (
    <div className="work-signin">
      <div className="work-brand big">
        <img src={APP_ICON} alt="" width={40} height={40} />
        <span>{APP_NAME}</span>
      </div>
      <h1>Sign in</h1>
      <p className="muted">Pick who to be. Managers see the live board and approvals; payroll sees the pay run.</p>
      {err && <div className="work-banner warn">{err}</div>}
      {!users ? (
        !err && <Spinner />
      ) : (
        <div className="work-people-pick">
          {users.map((u) => (
            <button key={u.id} className="work-pick" disabled={!!busy} onClick={() => pick(u.id)}>
              <strong>{u.name}</strong>
              <span className="muted">{busy === u.id ? 'Signing in…' : role(u)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
