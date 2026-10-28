// Sample NACHA PPD credit file builder. Output is text for display only - it is never transmitted anywhere.

const A = (s, n) => String(s ?? '').toUpperCase().replace(/[^ -~]/g, '').slice(0, n).padEnd(n, ' ');
const N = (v, n) => { const s = String(Math.max(0, Math.round(+v || 0))); if (s.length > n) throw new Error(`numeric field overflow (${n})`); return s.padStart(n, '0'); };
const yymmdd = (d) => d.toISOString().slice(2, 10).replace(/-/g, '');

/** ABA check digit for an 8-digit routing prefix (weights 3,7,1). */
export function abaCheckDigit(first8) {
  const w = [3, 7, 1, 3, 7, 1, 3, 7];
  const s = [...first8].reduce((sum, ch, i) => sum + Number(ch) * w[i], 0);
  return String((10 - (s % 10)) % 10);
}
export const isValidRouting = (r) => /^\d{9}$/.test(r) && abaCheckDigit(r.slice(0, 8)) === r[8];

/**
 * entries: [{name, id, routing (9 digits), account, amountCents, accountType:'checking'|'savings'}]
 * company: {name, id (10 chars), originRouting (9 digits), destinationRouting, destinationName}
 */
export function buildNacha({ company, entries, effectiveDate, now = new Date(), batchNumber = 1 }) {
  const odfi = company.originRouting.slice(0, 8);
  const lines = [];
  lines.push('1' + '01' + ' ' + N(company.destinationRouting, 9) + ' ' + N(company.originRouting, 9) + yymmdd(now) + now.toISOString().slice(11, 16).replace(':', '') + 'A' + '094' + '10' + '1' + A(company.destinationName, 23) + A(company.name, 23) + A('SAMPLE', 8));
  lines.push('5' + '220' + A(company.name, 16) + A('SAMPLE ONLY', 20) + A(company.id, 10) + 'PPD' + A('PAYROLL', 10) + A(yymmdd(effectiveDate), 6) + yymmdd(effectiveDate) + '   ' + '1' + odfi + N(batchNumber, 7));
  let hash = 0, credit = 0, seq = 0;
  for (const e of entries) {
    if (!isValidRouting(e.routing)) throw new Error(`bad routing number for ${e.name}`);
    seq++;
    hash += Number(e.routing.slice(0, 8));
    credit += e.amountCents;
    const tc = e.accountType === 'savings' ? '32' : '22';
    lines.push('6' + tc + e.routing.slice(0, 8) + e.routing[8] + A(e.account, 17) + N(e.amountCents, 10) + A(e.id, 15) + A(e.name, 22) + '  ' + '0' + odfi + N(seq, 7));
  }
  const hash10 = N(hash % 1e10, 10);
  lines.push('8' + '220' + N(seq, 6) + hash10 + N(0, 12) + N(credit, 12) + A(company.id, 10) + ' '.repeat(19) + ' '.repeat(6) + odfi + N(batchNumber, 7));
  const recordsBeforePad = lines.length + 1;
  const blocks = Math.ceil(recordsBeforePad / 10);
  lines.push('9' + N(1, 6) + N(blocks, 6) + N(seq, 8) + hash10 + N(0, 12) + N(credit, 12) + ' '.repeat(39));
  while (lines.length % 10) lines.push('9'.repeat(94));
  for (const l of lines) if (l.length !== 94) throw new Error(`NACHA record length ${l.length}`);
  return { text: lines.join('\n') + '\n', entryCount: seq, totalCreditCents: credit, entryHash: hash10, blockCount: blocks };
}
