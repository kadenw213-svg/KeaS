// What the org engine needs from the server it runs in, with plain defaults: the error class its router turns into
// an HTTP answer, input checks, rate limits, and file answers. The Kea Hub passes its own (hub/index.mjs).
export class OrgHttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

const TIME_MIN = Date.UTC(2000, 0, 1), TIME_MAX = Date.UTC(2100, 0, 1);

/** Input checks like the Kea Hub's (hub/index.mjs V), for a host that has none of its own. */
export function makeValidators(HttpError = OrgHttpError) {
  const bad = (m) => { throw new HttpError(400, m); };
  const V = {
    str(v, name, { optional = false, max = 500, min = 0 } = {}) {
      if ((v == null || v === '') && optional) return null;
      if (typeof v !== 'string') bad(`${name} must be text.`);
      const t = v.trim();
      if (t.length < min || t.length > max) bad(`${name} must be ${min}-${max} characters.`);
      return t;
    },
    int(v, name, { optional = false, min = -Infinity, max = Infinity } = {}) {
      if (v == null && optional) return null;
      if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}.`);
      return v;
    },
    bool(v, name, { optional = false } = {}) { if (v == null && optional) return null; if (typeof v !== 'boolean') bad(`${name} must be true or false.`); return v; },
    enum(v, name, list, { optional = false } = {}) { if (v == null && optional) return null; if (!list.includes(v)) bad(`${name} must be one of: ${list.join(', ')}.`); return v; },
    time(v, name) {
      const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 64 ? Date.parse(v) : NaN;
      if (!Number.isInteger(t) || t < TIME_MIN || t > TIME_MAX) bad(`${name} must be a date and time between 2000 and 2100.`);
      return t;
    },
    name(v, label, { optional = false, min = 1, max = 60 } = {}) {
      if ((v == null || v === '') && optional) return null;
      if (typeof v !== 'string') bad(`${label} must be text.`);
      // eslint-disable-next-line no-control-regex
      const t = v.normalize('NFC').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
      if (!t && optional) return null;
      const n = [...t].length;
      if (n < min || n > max) bad(`${label} must be ${min}-${max} characters.`);
      return t;
    },
    url(v, name) {
      const s = V.str(v, name, { optional: true, max: 500 });
      if (s == null) return null;
      let u; try { u = new URL(s); } catch { bad(`${name} must be a full https:// link.`); }
      if (u.protocol !== 'https:') bad(`${name} must be a full https:// link.`);
      return u.toString();
    },
    obj(v) { if (v == null) return {}; if (typeof v !== 'object' || Array.isArray(v)) bad('Body must be a JSON object.'); return v; },
  };
  return V;
}

export const defaultNormCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
