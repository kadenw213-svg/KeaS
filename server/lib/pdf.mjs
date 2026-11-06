// A small PDF writer (no dependencies): Letter pages of text lines in Helvetica, paginated automatically.
// lines: [{ text, size = 10, bold = false, gap = 0, mono = false, right = null }] where `right` is text right-aligned on the same line.

const ascii = (s) => String(s ?? '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
  .replace(/[^\x20-\x7e]/g, '?');
const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
// Rough Helvetica width (average glyph ~0.5em; digits 0.556em) for right alignment.
const width = (s, size, mono) => ascii(s).length * size * (mono ? 0.6 : 0.52);

export function simplePdf({ title = 'Document', lines = [] }) {
  const W = 612, H = 792, M = 50;
  const pages = [[]];
  let y = H - M;
  for (const l of lines) {
    const size = l.size || 10;
    const step = size * 1.35 + (l.gap || 0);
    if (y - step < M) { pages.push([]); y = H - M; }
    y -= step;
    const font = l.mono ? 'F3' : l.bold ? 'F2' : 'F1';
    const page = pages.at(-1);
    if (l.text) page.push(`BT /${font} ${size} Tf ${M} ${y.toFixed(2)} Td (${esc(l.text)}) Tj ET`);
    if (l.right != null) page.push(`BT /${font} ${size} Tf ${(W - M - width(l.right, size, l.mono)).toFixed(2)} ${y.toFixed(2)} Td (${esc(l.right)}) Tj ET`);
    if (l.rule) page.push(`${M} ${(y - 4).toFixed(2)} m ${W - M} ${(y - 4).toFixed(2)} l 0.5 w S`);
  }
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((ops, i) => {
    const content = [...ops, `BT /F1 8 Tf ${M} 30 Td (${esc(`${title} - page ${i + 1} of ${pages.length}`)}) Tj ET`].join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(title)}) /Producer (KeaS) >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
