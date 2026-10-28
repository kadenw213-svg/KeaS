// The KeaS server lives on the same origin as this app. The session is an HttpOnly cookie the
// server sets at sign-in; every request carries X-KeaS: 1 so the server can tell it came from this page.

export interface Problem {
  code: string;
  message: string;
  blocking: boolean;
}

/** A server error that carries the problems the server found (for example a blocked shift). status 0 = offline. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public problems: Problem[] = []
  ) {
    super(message);
  }
}

let onSignedOut: () => void = () => {};
let onOffline: () => void = () => {};
/** The store registers what to do when the session ends or the server can't be reached. */
export function onSessionEvents(h: { signedOut: () => void; offline: () => void }) {
  onSignedOut = h.signedOut;
  onOffline = h.offline;
}

export async function api<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-KeaS': '1', accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    onOffline();
    throw new ApiError('Can’t reach your workplace’s server.', 0);
  }
  let data: any = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (r.status === 401 && !opts.quiet401) onSignedOut();
  if (!r.ok) throw new ApiError(data?.error || `The server said no (${r.status}).`, r.status, data?.problems || []);
  return data as T;
}
