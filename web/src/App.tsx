import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3, Briefcase, CalendarDays, CalendarOff, CheckSquare, Clock, FileClock, FileText, Lock, LogOut, Network, Receipt, RefreshCw, Settings, Target, TriangleAlert, Upload, UserPlus, Users, Wallet, CalendarCheck2
} from 'lucide-react';
import { useWork, loadWork, can, go, signOut, type WorkView, type Person } from './store';
import { api, ApiError } from './api';
import { AskHost, Spinner, Toasts } from './ui';
import { APP_ICON, APP_NAME } from './brand';
import { Form, type Field } from './kit';
import { Today } from './screens/Today';
import { Schedule } from './screens/Schedule';
import { Timecards } from './screens/Timecards';
import { People } from './screens/People';
import { PayRun } from './screens/PayRun';
import { Employees } from './screens/Employees';
import { OrgSetup } from './screens/OrgSetup';
import { TimeOff } from './screens/TimeOff';
import { Approvals } from './screens/Approvals';
import { Onboarding } from './screens/Onboarding';
import { Expenses } from './screens/Expenses';
import { Documents } from './screens/Documents';
import { Reports } from './screens/Reports';
import { Import } from './screens/Import';
import { YearEnd } from './screens/YearEnd';
import { Hiring } from './screens/Hiring';
import { Performance } from './screens/Performance';
import { VaultSettings } from './screens/VaultSettings';

export function App() {
  return (
    <>
      <Work />
      <Toasts />
      <AskHost />
    </>
  );
}

interface NavItem {
  id: WorkView;
  label: string;
  short: string;
  icon: ReactNode;
  show: boolean;
  group?: string;
}

/** The app: the workforce screens on the org server, and payroll and HR in the payroll vault. */
function Work() {
  const { status, me, org, view, error, mode } = useWork();
  useEffect(() => {
    if (status === null) loadWork();
  }, [status]);

  if (status === null)
    return (
      <div className="center-fill">
        <Spinner />
      </div>
    );
  if (status === 'signedOut') return mode === 'vault' ? <VaultGate /> : <SignIn />;
  if (status === 'offline') return <Offline />;

  const vault = mode === 'vault';
  const pay = can(me, 'payroll'),
    mgr = can(me, 'manager') || pay;
  const P = 'Payroll and HR',
    S = 'Setup and reports';
  const nav: NavItem[] = [
    { id: 'today', label: 'Today', short: 'Today', icon: <Clock size={20} />, show: !vault },
    { id: 'schedule', label: 'Schedule', short: 'Schedule', icon: <CalendarDays size={20} />, show: !vault },
    { id: 'timecards', label: 'Timecards', short: 'Timecards', icon: <FileClock size={20} />, show: true },
    { id: 'people', label: 'People & certifications', short: 'People', icon: <Users size={20} />, show: !vault && mgr },
    { id: 'pay', label: 'Pay run', short: 'Pay', icon: <Wallet size={20} />, show: pay, group: P },
    { id: 'employees', label: 'Employees', short: 'Staff', icon: <Users size={20} />, show: pay, group: P },
    { id: 'approvals', label: 'Approvals', short: 'Approve', icon: <CheckSquare size={20} />, show: true, group: P },
    { id: 'timeoff', label: 'Time off and leave', short: 'Time off', icon: <CalendarOff size={20} />, show: true, group: P },
    { id: 'onboarding', label: 'Onboarding and offboarding', short: 'Onboard', icon: <UserPlus size={20} />, show: pay, group: P },
    { id: 'expenses', label: 'Expenses', short: 'Expenses', icon: <Receipt size={20} />, show: true, group: P },
    { id: 'documents', label: 'Documents', short: 'Docs', icon: <FileText size={20} />, show: pay, group: P },
    { id: 'reports', label: 'Reports', short: 'Reports', icon: <BarChart3 size={20} />, show: mgr, group: S },
    { id: 'yearend', label: 'Year-end forms', short: 'Year-end', icon: <CalendarCheck2 size={20} />, show: pay, group: S },
    { id: 'org', label: 'Org and pay setup', short: 'Setup', icon: <Network size={20} />, show: mgr, group: S },
    { id: 'import', label: 'Import', short: 'Import', icon: <Upload size={20} />, show: pay, group: S },
    { id: 'hiring', label: 'Hiring', short: 'Hiring', icon: <Briefcase size={20} />, show: mgr, group: S },
    { id: 'performance', label: 'Performance', short: 'Reviews', icon: <Target size={20} />, show: true, group: S },
    { id: 'settings', label: vault ? 'Vault and settings' : 'Payroll settings', short: 'Settings', icon: <Settings size={20} />, show: pay, group: S }
  ];
  const shown = nav.filter((n) => n.show);
  const fallback: WorkView = vault ? (pay ? 'pay' : 'timecards') : 'today';
  const current = shown.some((n) => n.id === view) ? view : fallback;
  const lock = async () => {
    try {
      await api('POST', '/v1/vault/lock');
    } catch {
      /* the server also locks when it stops */
    }
    useWork.getState().set({ status: null, me: null });
  };

  return (
    <div className="work">
      <header className="work-topbar">
        <img src={APP_ICON} alt="" width={28} height={28} />
        <div className="work-topbar-text">
          <strong>{org?.name || 'Workplace'}</strong>
          <span className="muted">{me?.name}</span>
        </div>
        <button className="icon-btn" onClick={vault ? lock : signOut} aria-label={vault ? 'Lock the vault' : 'Sign out'} title={vault ? 'Lock the vault' : 'Sign out'}>
          {vault ? <Lock size={20} /> : <LogOut size={20} />}
        </button>
      </header>
      <nav className="work-nav" aria-label="Main">
        <div className="work-org">
          <div className="work-brand">
            <img src={APP_ICON} alt="" width={24} height={24} />
            <span>{vault ? `${APP_NAME} Payroll` : APP_NAME}</span>
          </div>
          <strong>{org?.name || 'Workplace'}</strong>
          <span className="muted">{me?.name}</span>
        </div>
        {shown.map((n, i) => (
          <NavLink key={n.id} n={n} current={current} groupStart={!!n.group && n.group !== shown[i - 1]?.group} />
        ))}
        <div className="work-spacer" />
        {vault ? (
          <button className="work-link work-signout" onClick={lock}>
            <Lock size={20} />
            <span>Lock the vault</span>
          </button>
        ) : (
          <button className="work-link work-signout" onClick={signOut}>
            <LogOut size={20} />
            <span>Sign out</span>
          </button>
        )}
      </nav>
      <main className="work-main">
        {error && <div className="work-banner warn">{error}</div>}
        {current === 'today' && <Today />}
        {current === 'schedule' && <Schedule />}
        {current === 'timecards' && <Timecards />}
        {current === 'people' && <People />}
        {current === 'pay' && <PayRun />}
        {current === 'employees' && <Employees />}
        {current === 'org' && <OrgSetup />}
        {current === 'timeoff' && <TimeOff />}
        {current === 'approvals' && <Approvals />}
        {current === 'onboarding' && <Onboarding />}
        {current === 'expenses' && <Expenses />}
        {current === 'documents' && <Documents />}
        {current === 'reports' && <Reports />}
        {current === 'import' && <Import />}
        {current === 'yearend' && <YearEnd />}
        {current === 'hiring' && <Hiring />}
        {current === 'performance' && <Performance />}
        {current === 'settings' && <VaultSettings />}
      </main>
    </div>
  );
}

function NavLink({ n, current, groupStart }: { n: NavItem; current: WorkView; groupStart: boolean }) {
  return (
    <>
      {groupStart && <div className="pr-nav-group">{n.group}</div>}
      <button className={`work-link ${current === n.id ? 'active' : ''}`} aria-current={current === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
        {n.icon}
        <span className="work-link-long">{n.label}</span>
        <span className="work-link-short">{n.short}</span>
      </button>
    </>
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

/** The payroll vault: first-time setup, then sign-in with the Kea Hub account and the vault passphrase. */
function VaultGate() {
  const { vault } = useWork();
  return (
    <div className="pr-signin">
      <div className="work-brand big">
        <img src={APP_ICON} alt="" width={40} height={40} />
        <span>{APP_NAME} Payroll</span>
      </div>
      {vault?.initialized ? <VaultSignIn /> : <VaultSetup />}
    </div>
  );
}

const TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

/** The one-time setup token the KeaS app put in this window's address; kept for reloads, and taken out of the address. */
function setupToken(): string {
  const key = 'keas-vault-setup';
  const m = /^#setup=([\w-]+)$/.exec(location.hash);
  try {
    if (m) {
      sessionStorage.setItem(key, m[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return m?.[1] ?? sessionStorage.getItem(key) ?? '';
  } catch {
    return m?.[1] ?? '';
  }
}

function VaultSetup() {
  const { vault } = useWork();
  const [local, setLocal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [token] = useState(setupToken);
  // A Hub on another PC: the owner compares its key with the one on that PC before any password goes to it.
  const [hubKey, setHubKey] = useState<{ ownHub: boolean; fingerprint: string } | null>(null);
  useEffect(() => {
    if (!vault?.hubUrl) return;
    api<{ ownHub: boolean; fingerprint: string }>('GET', `/v1/vault/setup-hub-key?token=${encodeURIComponent(token)}`)
      .then(setHubKey)
      .catch(() => setHubKey(null));
  }, [vault?.hubUrl, token]);
  const confirmKey = !local && !!hubKey && !hubKey.ownHub;
  const fields: Field[] = [
    ...(confirmKey ? [{ name: 'hubKeyOk', label: 'This fingerprint matches the one shown on the Hub’s PC', type: 'checkbox', required: true } as Field] : []),
    { name: 'orgName', label: 'Organization', required: true },
    { name: 'state', label: 'State (two letters)', required: true, placeholder: 'CO' },
    { name: 'tz', label: 'Time zone', type: 'select', required: true, options: TIME_ZONES.map((z) => ({ value: z, label: z.split('/')[1].replace('_', ' ') })) },
    { name: 'name', label: 'Your name', required: true },
    { name: 'email', label: local ? 'Your email' : 'Your Kea Hub email', type: 'email', required: true },
    { name: 'password', label: local ? 'A local password (16+ characters; a few unrelated words work well)' : 'Your Kea Hub password', type: 'password', required: true },
    { name: 'passphrase', label: 'Vault passphrase (12+ characters)', type: 'password', required: true, help: 'Encrypts SSNs, bank details and documents. It can’t be recovered if it’s lost, so keep it somewhere safe.' },
    { name: 'passphrase2', label: 'Vault passphrase again', type: 'password', required: true },
    // (The code last, so it doesn't run out while the passphrases are typed.)
    ...(!local ? [{ name: 'code', label: 'Two-step code (if you use one)', placeholder: '123456' } as Field] : []),
    ...(!local && vault?.localSignIn ? [{ name: 'localPassword', label: 'Local password for when the Hub can’t be reached (16+ characters)', type: 'password', advanced: true, help: 'Only works while the Kea Hub can’t be reached, and still needs the vault passphrase.' } as Field] : []),
    { name: 'payPeriodAnchor', label: 'First day of a pay period', type: 'date', advanced: true, help: 'Biweekly periods count from this day. Default: this week’s Sunday.' },
    { name: 'futaExempt', label: '501(c)(3): exempt from FUTA', type: 'checkbox', advanced: true },
    { name: 'sutaRate', label: 'State unemployment rate (for example 0.0305)', type: 'number', step: '0.0001', advanced: true }
  ];
  return (
    <>
      <h1>Set up payroll on this computer</h1>
      <p className="muted">Payroll keeps SSNs, bank details, tax forms and pay runs on this computer only, encrypted with a passphrase you choose. None of it goes to the Hub.</p>
      <p className="muted small">Kea Hub: {vault?.hubUrl || 'not set'} (set in the KeaS app on this computer).</p>
      {vault?.localSignIn && (
        <label className="pr-check">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> Use a local account (only while the Kea Hub can’t be reached)
        </label>
      )}
      {confirmKey && (
        <p className="muted small">
          Kea Hub key fingerprint: <code>{hubKey?.fingerprint}</code>. On the Hub’s PC, run <code>node hub/owner.mjs key-fingerprint</code> or open KeaS (Payroll, Advanced) and compare.
        </p>
      )}
      {err && <div className="work-banner warn">{err}</div>}
      <Form
        key={`${local}-${confirmKey}`}
        fields={fields}
        initial={{ tz: 'America/Denver' }}
        submit="Set up payroll"
        onSubmit={async (v) => {
          setErr(null);
          if (v.passphrase !== v.passphrase2) return setErr('The two passphrases don’t match.');
          if (confirmKey && !v.hubKeyOk) return setErr('Compare the Kea Hub’s key fingerprint first.');
          try {
            await api('POST', '/v1/vault/setup', {
              setupToken: token,
              passphrase: v.passphrase,
              org: { name: v.orgName, state: String(v.state || '').toUpperCase(), tz: v.tz, payPeriodAnchor: v.payPeriodAnchor || undefined, futaExempt: !!v.futaExempt, sutaRate: v.sutaRate ?? undefined },
              admin: { name: v.name, email: v.email },
              signIn: local ? { mode: 'local', password: v.password } : { mode: 'hub', password: v.password, code: v.code || undefined, localPassword: v.localPassword || undefined, hubKeyFingerprint: confirmKey ? hubKey?.fingerprint : undefined }
            });
            useWork.getState().set({ status: null, error: null });
          } catch (e: any) {
            setErr(e instanceof ApiError && e.status === 503 ? `${e.message} Check that the Kea Hub is running.` : e.message);
          }
        }}
      />
    </>
  );
}

function VaultSignIn() {
  const { vault } = useWork();
  const [local, setLocal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fields: Field[] = [
    { name: 'email', label: local ? 'Email' : 'Kea Hub email', type: 'email', required: true },
    { name: 'password', label: local ? 'Local password' : 'Kea Hub password', type: 'password', required: true },
    { name: 'passphrase', label: 'Vault passphrase', type: 'password', required: true },
    // (The code last, so it doesn't run out while the passphrase is typed.)
    ...(!local ? [{ name: 'code', label: 'Two-step code (if you use one)' } as Field] : [])
  ];
  return (
    <>
      <h1>Sign in to payroll</h1>
      <p className="muted">{vault?.org ? `${vault.org}. ` : ''}Sign in with your Kea Hub account and the vault passphrase.</p>
      {err && <div className="work-banner warn">{err}</div>}
      <Form
        key={String(local)}
        fields={fields}
        submit="Sign in"
        onSubmit={async (v) => {
          setErr(null);
          try {
            await api('POST', '/v1/vault/signin', { mode: local ? 'local' : 'hub', email: v.email, password: v.password, code: v.code || undefined, passphrase: v.passphrase }, { quiet401: true });
            useWork.getState().set({ status: null, error: null });
          } catch (e: any) {
            const msg = e?.message || String(e);
            if (e instanceof ApiError && e.status === 503 && vault?.localAccounts) {
              setErr(`${msg} You can sign in with your local account instead.`);
              setLocal(true);
            } else setErr(msg);
          }
        }}
      />
      {vault?.localAccounts && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setLocal(!local)}>
          {local ? 'Use my Kea Hub account' : 'The Hub can’t be reached: use my local account'}
        </button>
      )}
    </>
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
