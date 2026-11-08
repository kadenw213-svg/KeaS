// Names people pick (display names, leaderboard nicknames, organization and class titles): cleaned before they are
// stored, and a few names that would pass for Kea itself, or for the Hub's owner, kept for the owner.
//
// Cleaning: Unicode NFC; control characters (Cc) become spaces; format characters (Cf: bidi overrides and isolates,
// zero-width space/joiners, soft hyphen, BOM) and other invisible fillers are removed; runs of combining marks are
// cut to three; whitespace is collapsed. The length is counted after that.
//
// Reserved names are compared by a "skeleton": compatibility-decomposed (full-width and styled letters become plain),
// accents dropped, lower-cased, look-alikes folded to Latin (confusables.mjs, generated from Unicode's confusables data:
// Cyrillic, Greek, Armenian, Cherokee, Lisu, small capitals, IPA and more; then 0/1/3/5, rn, vv here), and everything
// that isn't a letter or digit removed. So "K e a", "Ｋｅａ", "Кеа" and "Kea" with a zero-width space all match "Kea".
import { CONFUSABLES } from './confusables.mjs';

const INVISIBLE = new RegExp(`[${[0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2800, 0x3164, 0xffa0].map((c) => String.fromCodePoint(c)).join('')}]`, 'gu');

const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');

/** The cleaned text (may be empty). */
export function cleanText(v) {
  return String(v ?? '')
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .replace(INVISIBLE, '')
    .replace(LINE_SEPARATORS, ' ')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

const FOLD = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'l', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h', 'ӏ': 'l',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'l', 'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ζ': 'z', 'ω': 'w',
  // Digits and marks that pass for letters
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '|': 'l', '!': 'l', '@': 'a', '$': 's', 'i': 'l', 'ı': 'l',
};

/** A name with its look-alikes folded, punctuation and spaces still in it. */
function folded(v) {
  const s = cleanText(v).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  return [...[...s].map((c) => CONFUSABLES.get(c) ?? c).join('')].map((c) => FOLD[c] ?? c).join('');
}
const wordsOf = (s) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/rn/g, 'm').replace(/vv/g, 'w'));
/** The words of a name in comparison form. */
const skeletonWords = (v) => wordsOf(folded(v));
/** The comparison form of a name (see the top of this file). */
export const skeleton = (v) => skeletonWords(v).join('');

/** Names only the Hub's owner may use (besides the owner's own display name). */
export const RESERVED = ['Kea', 'Kea Hub', 'Kea Support', 'KeaS', 'Hidden', 'Owner', 'Admin'];
// The word "Kea" next to one of these, in either order, passes for Kea staff: "Kea Support Team", "The Kea Hub",
// "Security - Kea", "Kea Trust and Safety".
const STAFF_WORDS = ['Hub', 'Owner', 'Security', 'Support', 'Moderator', 'Mod', 'Billing', 'Admin', 'Administrator', 'Team', 'Staff', 'Official', 'System', 'Help', 'Helpdesk', 'Trust', 'Safety'];
const KEA = skeleton('Kea');
const STAFF_JOINED = new Set(STAFF_WORDS.flatMap((w) => [KEA + skeleton(w), skeleton(w) + KEA]));
// Small words that don't separate them: "Team of Kea", "Kea's Support".
const FILLERS = new Set(['the', 'of', 'for', 'and', 'at', 's'].map(skeleton));
// After a colon, these read as a message from the service: "Notice: account suspended".
const NOTICE_WORDS = new Set(['Account', 'Accounts', 'Security', 'Support', 'Verify', 'Verification', 'Alert', 'Notice', 'Warning', 'Billing', 'Password', 'Login', 'Signin', 'Admin', 'Official', 'Suspended', 'Locked', 'Urgent', 'Payment'].map(skeleton));
// ":" and the characters that pass for it. (NFKD has already made the full-width one plain.)
const COLON = /[:\u02d0\u02f8\u0589\u05c3\u0703\u0704\u16ec\u1803\u1809\u205a\u2236\ua4fd\ua789\ufe13\ufe55]/u;

/** True when `name` would pass for Kea, Kea staff, a hidden entry, or the owner (`ownerNames`: their display names). */
export function isReservedName(name, ownerNames = []) {
  const s = skeleton(name);
  if (!s) return false;
  if (RESERVED.some((r) => skeleton(r) === s)) return true;
  // (Whole words only, so "Mikea Hubert" is fine but "The Kea_Support team" and "K e a Hub" aren't.)
  const words = skeletonWords(name).filter((w) => !FILLERS.has(w));
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= words.length; j++) if (STAFF_JOINED.has(words.slice(i, j).join(''))) return true;
  // "Kea:" anywhere, or a colon followed by account or security wording.
  const pieces = folded(name).split(COLON);
  for (let i = 0; i < pieces.length - 1; i++) if (wordsOf(pieces[i]).at(-1) === KEA || wordsOf(pieces[i]).join('').endsWith(KEA) && wordsOf(pieces[i]).every((w) => w.length === 1)) return true;
  if (pieces.slice(1).some((p) => wordsOf(p).some((w) => NOTICE_WORDS.has(w)))) return true;
  return ownerNames.some((o) => o && skeleton(o) === s);
}
