// The payroll guard for org routes on the Kea Hub: payroll details (SSNs, bank details, pay runs) are refused
// anywhere in a request body, because they stay in the payroll vault on the payroll admin's own PC.
//
// Keys are compared after NFKC normalization (fullwidth and other compatibility forms), with common Cyrillic and
// Greek look-alike letters folded to Latin ("ѕѕn" is "ssn"), split into words ("bankAccount" -> "bank account", so
// "assigned" or "className" never match), and also with everything but letters and digits removed ("s.s.n",
// "S_S_N"). String values are checked for things shaped like an SSN (123-45-6789, 123456789) and a bank routing
// number next to an account number. The whole body is walked (no depth limit), and a body with more than MAX_NODES
// keys and values is refused outright rather than half-checked.
export const MAX_NODES = 20_000;
export const PAYROLL_MESSAGE = "Payroll details (SSNs, bank accounts, pay runs) stay in the payroll vault on the payroll admin's PC. They are never stored on the Kea Hub.";

const PAYROLL_WORDS = /\b(ssns?|itin|iban|swift|paychecks?|social security( numbers?)?|tax ids?|routing( numbers?)?|bank (accounts?|details|numbers?|info)|account numbers?|acct (no|num|numbers?)|w ?4s?|direct deposits?|pay runs?|payruns?|wages?|salary|salaries|pay ?rates?|hourly (rates?|wages?|pay))\b/;
// The same, written with no spaces or punctuation at all (the whole key, so "classname" never matches "ssn").
const SQUASHED = new Set([
  'ssn', 'ssns', 'itin', 'iban', 'swift', 'swiftcode', 'paycheck', 'paychecks', 'socialsecurity', 'socialsecuritynumber', 'socialsecuritynumbers',
  'socialsecurityno', 'taxid', 'taxids', 'routing', 'routingnumber', 'routingnumbers', 'routingno', 'aba', 'abanumber', 'bankaccount', 'bankaccounts',
  'bankaccountnumber', 'bankdetails', 'banknumber', 'bankinfo', 'accountnumber', 'accountnumbers', 'acctno', 'acctnum', 'acctnumber',
  'w4', 'w4s', 'directdeposit', 'directdeposits', 'payrun', 'payruns',
  'wage', 'wages', 'salary', 'salaries', 'payrate', 'payrates', 'payratecents', 'hourlyrate', 'hourlywage', 'hourlypay',
]);
// Cyrillic and Greek letters that look like Latin ones.
const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ս: 'u', ո: 'n', һ: 'h',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', Ү: 'Y',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ς: 's', ω: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};
const fold = (s) => String(s).normalize('NFKC').replace(/[̀-ͯ​-‏⁠﻿]/g, '').replace(/[^\u0000-\u007f]/g, (c) => LOOKALIKE[c] ?? c);
/** A key as words: "bankAccount" -> "bank account". */
export const keyWords = (k) => fold(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
export const payrollKey = (k) => {
  const words = keyWords(k);
  return PAYROLL_WORDS.test(words) || SQUASHED.has(words.replace(/ /g, ''));
};

// 123-45-6789, 123 45 6789 or 123456789 (nine digits on their own). Not a ZIP+4 (80202-1234) or a phone number.
const SSN = /(?<![\d-])(\d{3}-\d{2}-\d{4}|\d{3} \d{2} \d{4}|\d{9})(?![\d-])/;
/** An ABA routing number (nine digits with a valid check digit) followed closely by a 4-17 digit account number. */
const ROUTING_THEN_ACCOUNT = /(?<!\d)(\d{9})(?!\d)\D{1,40}?(?<!\d)(\d{4,17})(?!\d)/g;
const abaOk = (r) => {
  const d = [...r].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
};
// The Hub's own record ids: about 1 in 100 random UUIDs holds nine digits in a row between letters, which isn't an SSN.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export function payrollValue(v) {
  const s = fold(v).replace(/[‐-―−]/g, '-').replace(UUID, ' ');
  if (SSN.test(s)) return true;
  for (const m of s.matchAll(ROUTING_THEN_ACCOUNT)) if (abaOk(m[1])) return true;
  return false;
}

/** Throws `refuse()`'s error when the body holds payroll details, or is too big to check. */
export function checkNoPayroll(body, refuse, tooBig) {
  if (!body || typeof body !== 'object') return;
  const stack = [body];
  let nodes = 0;
  while (stack.length) {
    const v = stack.pop();
    if (++nodes > MAX_NODES) tooBig();
    if (typeof v === 'string') { if (payrollValue(v)) refuse(); continue; }
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    for (const [k, x] of Object.entries(v)) {
      if (++nodes > MAX_NODES) tooBig();
      if (payrollKey(k)) refuse();
      stack.push(x);
    }
  }
}
