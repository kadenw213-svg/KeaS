import { create } from 'zustand';
import { api, onSessionEvents } from './api';

export type WorkView =
  | 'today' | 'schedule' | 'timecards' | 'people' | 'pay'
  | 'setup' | 'employees' | 'org' | 'timeoff' | 'approvals' | 'onboarding' | 'expenses' | 'documents' | 'reports' | 'import' | 'yearend' | 'hiring' | 'performance' | 'settings';
export const VIEWS: WorkView[] = ['today', 'schedule', 'timecards', 'people', 'pay', 'setup', 'employees', 'org', 'timeoff', 'approvals', 'onboarding', 'expenses', 'documents', 'reports', 'import', 'yearend', 'hiring', 'performance', 'settings'];

export interface Person {
  id: string;
  name: string;
  roles: string[];
  positions: string[];
  status?: string;
  minor?: boolean;
  age?: number;
  certs?: { typeId: string; expires: string; expired?: boolean }[];
}
export interface Org {
  id: string;
  name: string;
  state?: string;
  tz?: string;
  lateThresholdMin?: number;
}
export interface Position {
  id: string;
  name: string;
}
export interface CertType {
  id: string;
  name: string;
  issuer?: string;
  validityMonths?: number;
  requiredForPositions?: string[];
}
export interface Shift {
  id: string;
  positionId: string;
  personId: string | null;
  personName?: string | null;
  positionName?: string | null;
  start: string;
  end: string;
  status: 'draft' | 'published';
}

/** How often Today refreshes the live board (seconds). */
export const REFRESH_SEC = 60;

interface WorkState {
  view: WorkView;
  me: Person | null;
  org: Org | null;
  people: Person[];
  positions: Position[];
  certTypes: CertType[];
  /** null = not checked yet; 'offline' = the server can't be reached; 'signedOut' = no session. */
  status: null | 'ready' | 'offline' | 'signedOut';
  /** 'vault' = the payroll vault on the payroll admin's PC; 'org' = the workforce server. */
  mode: 'vault' | 'org' | null;
  vault: { initialized: boolean; locked: boolean; hubUrl: string | null; org: string | null; localAccounts: boolean; localSignIn?: boolean } | null;
  error: string | null;
  tick: number;
  focus: Focus | null;
  set(p: Partial<WorkState>): void;
}

const viewFromPath = (): WorkView => {
  const v = location.pathname.replace(/^\/+|\/+$/g, '');
  // (Payroll opens on Get set up; it leads to the pay run once everything's done.)
  if (v === 'payroll') return 'setup';
  return VIEWS.includes(v as WorkView) ? (v as WorkView) : 'today';
};

export const useWork = create<WorkState>((set) => ({
  view: viewFromPath(),
  me: null,
  org: null,
  people: [],
  positions: [],
  certTypes: [],
  status: null,
  mode: null,
  vault: null,
  error: null,
  tick: 0,
  focus: null,
  set: (p) => set(p)
}));

onSessionEvents({
  signedOut: () => useWork.getState().set({ status: 'signedOut', me: null }),
  offline: () => useWork.getState().set({ status: 'offline' })
});

/** Switch view and keep the address bar in step, so reload and back work. */
export function go(view: WorkView, focus: Focus | null = null) {
  if (location.pathname !== '/' + view) history.pushState(null, '', '/' + view);
  useWork.getState().set({ view, focus });
}
/** Where a link points inside a screen: a person's profile card, or a pay period. The screen takes it once. */
export interface Focus {
  personId?: string;
  edit?: 'tax' | 'deposit' | 'rate' | 'basic';
  periodStart?: string;
  team?: boolean;
}
export function takeFocus(): Focus | null {
  const f = useWork.getState().focus;
  if (f) useWork.getState().set({ focus: null });
  return f;
}
window.addEventListener('popstate', () => useWork.getState().set({ view: viewFromPath() }));

/** Load who I am and my workplace (a 401 means there's no session yet). */
export async function loadWork() {
  const st = useWork.getState();
  try {
    const v = await api<any>('GET', '/v1/vault/status');
    st.set({ mode: v.mode, vault: v });
    if (v.mode === 'vault' && (!v.initialized || v.locked)) {
      st.set({ status: 'signedOut' });
      return;
    }
  } catch {
    if (useWork.getState().status === 'offline') return;
  }
  try {
    const me = await api<{ person: Person; org: Org }>('GET', '/v1/me');
    const o = await api<{ org: Org; positions: Position[]; certTypes: CertType[]; people: Person[] }>('GET', '/v1/org');
    st.set({ me: me.person, org: o.org, positions: o.positions, certTypes: o.certTypes, people: o.people, status: 'ready', error: null });
  } catch (e: any) {
    const now = useWork.getState().status;
    if (now !== 'signedOut' && now !== 'offline') st.set({ status: 'ready', error: e?.message || String(e) });
  }
}

export async function signOut() {
  try {
    await api('POST', '/v1/auth/logout', undefined, { quiet401: true });
  } catch {
    /* the cookie is cleared by the server; if it's unreachable we still show sign-in */
  }
  useWork.getState().set({ status: 'signedOut', me: null, people: [], error: null });
}

export const bumpWork = () => useWork.getState().set({ tick: useWork.getState().tick + 1 });

export const can = (me: Person | null, role: 'manager' | 'payroll' | 'owner') => !!me && (me.roles.includes(role) || me.roles.includes('owner'));

/** Accept either a bare list or { key: list } from the server. */
export function listOf<T = any>(v: any, key: string): T[] {
  return Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : [];
}

// Date helpers shared by the screens (local time).
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** A plain date ("2026-10-25") is a day in the workplace's calendar, not midnight UTC. */
export const asDate = (v: string | Date) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00`) : new Date(v));
export const fmtDay = (iso: string | Date) => asDate(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
/** Move a plain date by some days. */
export const addDays = (d: string, n: number) => {
  const x = asDate(d);
  x.setDate(x.getDate() + n);
  return dayKey(x);
};
export const hours = (min: number) => `${(min / 60).toFixed(2).replace(/\.?0+$/, '')} h`;
export const money = (cents: number) => (cents / 100).toLocaleString([], { style: 'currency', currency: 'USD' });
export function weekStart(d = new Date()) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay());
  return s;
}
