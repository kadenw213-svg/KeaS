import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';

/* ---------- toasts ---------- */

interface Toast {
  id: number;
  text: string;
}
const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));
let nextId = 1;

/** A short message at the bottom of the screen (announced to screen readers). */
export function toast(text: string) {
  const id = nextId++;
  useToasts.setState((s) => ({ list: [...s.list.slice(-2), { id, text }] }));
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), 4200);
}

export function Toasts() {
  const list = useToasts((s) => s.list);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- dialogs ---------- */

/** A modal: a centred card on wide screens, a bottom sheet on phones. Escape or the scrim closes it. */
export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') || el?.querySelector<HTMLElement>('select, input, button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), select, input, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const [a, b] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === a) (e.preventDefault(), b.focus());
        else if (!e.shiftKey && document.activeElement === b) (e.preventDefault(), a.focus());
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

interface AskButton {
  id: string;
  label: string;
  primary?: boolean;
}
interface AskState {
  q: { title: string; body: string; buttons: AskButton[]; resolve: (id: string) => void } | null;
}
const useAsk = create<AskState>(() => ({ q: null }));

/** Ask a question with a few buttons; resolves to the chosen button's id ('cancel' when dismissed). */
export function ask(title: string, body: string, buttons: AskButton[]): Promise<string> {
  return new Promise((resolve) => useAsk.setState({ q: { title, body, buttons, resolve } }));
}

export function AskHost() {
  const q = useAsk((s) => s.q);
  if (!q) return null;
  const done = (id: string) => {
    useAsk.setState({ q: null });
    q.resolve(id);
  };
  return (
    <Dialog title={q.title} onClose={() => done('cancel')} className="ask">
      {q.body && <p className="muted">{q.body}</p>}
      <div className="dialog-actions">
        {q.buttons.map((b) => (
          <button key={b.id} className={`btn ${b.primary ? 'primary' : ''}`} data-autofocus={b.primary ? '' : undefined} onClick={() => done(b.id)}>
            {b.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export const Spinner = () => <div className="spinner" role="progressbar" aria-label="Loading" />;
