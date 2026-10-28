import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNacha, abaCheckDigit, isValidRouting } from '../../server/lib/nacha.mjs';

const r = (p8) => p8 + abaCheckDigit(p8);

test('ABA check digit', () => {
  assert.equal(abaCheckDigit('01100001'), '5'); // textbook example 011000015
  assert.ok(isValidRouting(r('99000001')));
  assert.ok(!isValidRouting('99000001' + ((+abaCheckDigit('99000001') + 1) % 10)));
});

test('sample PPD file is well formed', () => {
  const entries = [
    { name: 'Alex Sample', id: 'p1', routing: r('99100001'), account: '12345', amountCents: 123456, accountType: 'checking' },
    { name: 'Blair Sample', id: 'p2', routing: r('99100002'), account: '67890', amountCents: 50000, accountType: 'savings' },
    { name: 'Casey Sample', id: 'p3', routing: r('99100003'), account: '555', amountCents: 1, accountType: 'checking' },
  ];
  const f = buildNacha({ company: { name: 'DEMO', id: '1999999999', originRouting: r('99000001'), destinationRouting: r('99000002'), destinationName: 'FAKE BANK' }, entries, effectiveDate: new Date('2026-10-30T12:00:00Z'), now: new Date('2026-10-27T15:00:00Z') });
  const lines = f.text.trimEnd().split('\n');
  for (const l of lines) assert.equal(l.length, 94);
  assert.equal(lines.length % 10, 0);
  assert.deepEqual(lines.slice(0, 2).map((l) => l[0]), ['1', '5']);
  assert.equal(lines[1].slice(50, 53), 'PPD');
  assert.ok(lines[1].slice(53, 63).startsWith('PAYROLL'));
  const six = lines.filter((l) => l[0] === '6');
  assert.equal(six.length, 3);
  assert.equal(six[1].slice(1, 3), '32');
  const hash = six.reduce((s, l) => s + Number(l.slice(3, 11)), 0) % 1e10;
  const total = six.reduce((s, l) => s + Number(l.slice(29, 39)), 0);
  const eight = lines.find((l) => l[0] === '8');
  const nineIdx = lines.findIndex((l) => l[0] === '9');
  const nine = lines[nineIdx];
  assert.equal(Number(eight.slice(4, 10)), 3);
  assert.equal(Number(eight.slice(10, 20)), hash);
  assert.equal(Number(eight.slice(32, 44)), total);
  assert.equal(Number(nine.slice(1, 7)), 1);
  assert.equal(Number(nine.slice(7, 13)), lines.length / 10);
  assert.equal(Number(nine.slice(13, 21)), 3);
  assert.equal(Number(nine.slice(21, 31)), hash);
  assert.equal(Number(nine.slice(43, 55)), total);
  assert.equal(total, 173457);
  assert.ok(lines.slice(nineIdx + 1).every((l) => l === '9'.repeat(94)));
});
