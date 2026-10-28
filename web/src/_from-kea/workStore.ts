import { create } from 'zustand';
import { useTabs } from '../../store';
import { api } from '../../lib/api';
import { noteUsing } from '../../lib/areas';

export type WorkView = 'today' | 'schedule' | 'timecards' | 'people' | 'pay';

export interface Person {
  id: string;
  name: string;
  roles: string[];
  positions: string[];
  minor?: boolean;
  age?: number;
  certs?: { typeId: string; expires: string }[];
}
export interface Org {
  id: string;
  name: string;
  state?: string;
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
  start: string;
  end: string;
  status: 'draft' | 'published';
}
export interface Problem {
  code: string;
  message: string;
  blocking: boolean;
}

interface WorkState {
  view: WorkView;
  me: Person | null;
  org: Org | null;
  people: Person[];
  positions: Position[];
  certTypes: CertType[];
  /** null = not checked yet; 'offline' = the server can't be reached; 'signedOut' = no session. */
  status: null | 'ready' | 'offline' | 'signedOut';
  error: string | null;
  tick: number;
  set(p: Partial<WorkState>): void;
}

export const useWork = create<WorkState>((set) => ({
  view: 'today',
  me: null,
  org: null,
  people: [],
  positions: [],
  certTypes: [],
  status: null,
  error: null,
  tick: 0,
  set: (p) => set(p)
}));

/** A server error that carries the problems the server found (for example a blocked shift). */
export class WorkError extends Error {
  constructor(
    message: string,
    public status: number,
    public problems: Problem[] = []
  ) {
    super(message);
  }
}

/** Call the work server; errors come back as WorkError with the server's message. */
export async function w<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let r;
  try {
    r = await api.work.call<any>(method, path, body);
  } catch (e: any) {
    useWork.getState().set({ status: 'offline' });
    throw new WorkError(e?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Can’t reach the work server.', 0);
  }
  if (r.status === 401) useWork.getState().set({ status: 'signedOut', me: null });
  if (!r.ok) throw new WorkError(r.data?.error || `The server said no (${r.status}).`, r.status, r.data?.problems || []);
  return r.data as T;
}

/** Load who I am and my workplace. */
export async function loadWork() {
  const st = useWork.getState();
  try {
    const session = await api.work.session();
    if (!session) return st.set({ status: 'signedOut', me: null });
    const me = await w<{ person: Person; org: Org }>('GET', '/v1/me');
    const o = await w<{ org: Org; positions: Position[]; certTypes: CertType[]; people: Person[] }>('GET', '/v1/org');
    st.set({ me: me.person, org: o.org, positions: o.positions, certTypes: o.certTypes, people: o.people, status: 'ready', error: null });
    // Belonging to a workplace turns the Work area on.
    noteUsing('work');
    if (me.person.roles.includes('payroll')) noteUsing('payroll');
  } catch (e: any) {
    if (useWork.getState().status !== 'signedOut') st.set({ status: e?.status === 0 ? 'offline' : 'ready', error: e?.message || String(e) });
  }
}

export const bumpWork = () => useWork.getState().set({ tick: useWork.getState().tick + 1 });

export const can = (me: Person | null, role: 'manager' | 'payroll' | 'owner') => !!me && (me.roles.includes(role) || me.roles.includes('owner'));

/** Open the Work tab (one per window) at a view. */
export function openWork(view?: WorkView) {
  if (view) useWork.getState().set({ view });
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'work');
  if (existing) tabs.setActive(existing.id);
  else tabs.addTab({ kind: 'work', name: 'Work', path: null, data: null });
}

// Date helpers shared by the work screens (local time).
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
