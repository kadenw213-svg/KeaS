// Versioned terms. Each published version is immutable; sections have stable ids, so a new version can be compared
// with the one a person agreed to and only the added, changed and removed sections shown.

/** Validates a terms document: { title, label, summary, sections: [{ id, title, body }] }. Returns a clean copy. */
export function checkTerms(doc) {
  const err = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!doc || typeof doc !== 'object') err('Terms must be a JSON object.');
  const str = (v, name, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) err(`${name} must be text (1-${max} characters).`); return v.trim(); };
  if (!Array.isArray(doc.sections) || doc.sections.length < 1 || doc.sections.length > 200) err('Terms need 1-200 sections.');
  const ids = new Set();
  const sections = doc.sections.map((s, i) => {
    const id = str(s?.id, `Section ${i + 1} id`, 60);
    if (!/^[a-z0-9-]+$/.test(id)) err(`Section id "${id}" may only use a-z, 0-9 and dashes.`);
    if (ids.has(id)) err(`Section id "${id}" is used twice.`);
    ids.add(id);
    return { id, title: str(s.title, `Section ${id} title`, 200), body: str(s.body, `Section ${id} text`, 20000) };
  });
  return { title: str(doc.title ?? 'Kea Terms of Use', 'Title', 200), label: str(doc.label ?? new Date().toISOString().slice(0, 10), 'Label', 60), summary: typeof doc.summary === 'string' ? doc.summary.trim().slice(0, 2000) : '', sections };
}

export const sameSections = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What changed from `before` to `after` (arrays of sections). */
export function diffTerms(before, after) {
  const old = new Map((before || []).map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const added = [], changed = [], removed = [];
  for (const s of after) {
    const o = old.get(s.id);
    if (!o) added.push(s);
    else if (o.title !== s.title || o.body !== s.body) changed.push({ id: s.id, title: s.title, before: o, after: s });
  }
  for (const s of before || []) if (!now.has(s.id)) removed.push({ id: s.id, title: s.title });
  return { added, changed, removed };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Section text -> HTML: lines starting "- " become lists, other lines paragraphs. */
export function bodyHtml(body) {
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; } };
  for (const line of String(body).split('\n')) {
    if (line.startsWith('- ')) list.push(line.slice(2));
    else { flush(); if (line.trim()) out.push(`<p>${esc(line)}</p>`); }
  }
  flush();
  return out.join('');
}

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1f;--muted:#5f6368;--card:#fff;--line:#e3e3e0;--add:#e6f4ea;--addfg:#137333;--chg:#fef7e0;--chgfg:#8a5a00;--del:#fce8e6;--delfg:#a50e0e;--accent:#b8860b}
@media (prefers-color-scheme:dark){:root{--bg:#131314;--fg:#e3e3e3;--muted:#9aa0a6;--card:#1e1f20;--line:#333537;--add:#0f2e1a;--addfg:#81c995;--chg:#2e2410;--chgfg:#fdd663;--del:#3a1513;--delfg:#f28b82;--accent:#e2b13c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:0 0 8px}
.meta{color:var(--muted);margin:0 0 24px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 14px}
ul{padding-left:22px;margin:8px 0}p{margin:8px 0}.tag{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;margin-bottom:8px}
.added{background:var(--add);color:var(--addfg)}.changed{background:var(--chg);color:var(--chgfg)}.removed{background:var(--del);color:var(--delfg)}
details{margin-top:10px;color:var(--muted)}nav a{color:var(--accent);margin-right:16px}nav{margin-bottom:20px}.summary{border-left:3px solid var(--accent);padding-left:12px}`;

export function termsPage(version, { since = null, diff = null, versions = [] } = {}) {
  const date = new Date(version.published_at).toISOString().slice(0, 10);
  const nav = `<nav><a href="?">Full terms</a>${versions.length > 1 ? versions.filter((v) => v.n < version.n).slice(-1).map((v) => `<a href="?since=${v.n}">Only what changed since version ${v.n}</a>`).join('') : ''}</nav>`;
  let main;
  if (diff) {
    const n = diff.added.length + diff.changed.length + diff.removed.length;
    main = `<p class="meta">Changes from version ${since} to version ${version.n}: ${n} section${n === 1 ? '' : 's'}.</p>` +
      (version.summary ? `<p class="summary">${esc(version.summary)}</p>` : '') +
      diff.added.map((s) => `<section><span class="tag added">New</span><h2>${esc(s.title)}</h2>${bodyHtml(s.body)}</section>`).join('') +
      diff.changed.map((c) => `<section><span class="tag changed">Changed</span><h2>${esc(c.title)}</h2>${bodyHtml(c.after.body)}<details><summary>What it said before</summary>${bodyHtml(c.before.body)}</details></section>`).join('') +
      diff.removed.map((s) => `<section><span class="tag removed">Removed</span><h2>${esc(s.title)}</h2></section>`).join('') +
      (n === 0 ? '<section><p>No sections changed.</p></section>' : '');
  } else {
    main = (version.summary ? `<p class="summary">${esc(version.summary)}</p>` : '') +
      version.sections.map((s) => `<section id="${esc(s.id)}"><h2>${esc(s.title)}</h2>${bodyHtml(s.body)}</section>`).join('');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kea Terms</title><style>${STYLE}</style></head><body><main><h1>${esc(version.title)}</h1><p class="meta">Version ${version.n} · ${esc(version.label)} · published ${date}</p>${nav}${main}</main></body></html>`;
}
