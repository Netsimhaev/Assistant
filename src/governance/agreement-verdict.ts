/**
 * Shadow mode: did the owner's edit of a proposed reply mean "she was right"?
 *
 * Pure comparison, no DB. An edit counts as agreement only when it is a light
 * touch: the recipient set is unchanged, every number and every date word is
 * unchanged, and at most `MAX_EDITED_WORDS` words differ. Checks run
 * cheapest-and-most-decisive first: state, recipient, numbers, dates, words.
 *
 * Unknown states are never permissive and never counted.
 */
import { LEADING_HEBREW_PARTICLE } from './typed-recipients.js';
import { readEmails } from '../policy/facts.js';
import { stripBidiControls } from '../util/bidi.js';

export type AgreementVerdict = 'right' | 'wrong' | 'not_counted';
export type WrongReason = 'recipient' | 'number' | 'date' | 'too_many_words' | 'denied';

export const MAX_EDITED_WORDS = 3;

const DATE_WORDS: ReadonlySet<string> = new Set([
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת',
  'היום', 'מחר', 'מחרתיים', 'אתמול',
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט',
  'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
  'תשרי', 'חשוון', 'כסלו', 'טבת', 'שבט', 'אדר', 'ניסן', 'אייר', 'סיוון', 'תמוז', 'אלול',
]);
// The month "אב" is left out on purpose: it is also the common word "father".

/** Day-letter forms: `ג'` as in "יום ג'". */
const GERESH = /['׳’‘]/gu;
const DAY_LETTER = /^[א-ו]['׳’‘]$/u;
const PARTICLE_LETTERS = new Set(['ל', 'ב', 'מ', 'ה', 'ו', 'כ', 'ש']);
const MAX_PARTICLE_LAYERS = 3;

/**
 * `LEADING_HEBREW_PARTICLE` covers only the hyphenated form (`ב-שלישי`); owners
 * write the glued form (`בשלישי`), so for date words only we peel glued
 * particle letters ourselves, and only accept the result if it is a date word.
 */
function dateWordOf(token: string): string | null {
  if (DAY_LETTER.test(token)) return token.replace(GERESH, "'");
  let candidate = token.replace(LEADING_HEBREW_PARTICLE, '');
  for (let layer = 0; layer <= MAX_PARTICLE_LAYERS; layer += 1) {
    if (DATE_WORDS.has(candidate)) return candidate;
    const first = candidate[0];
    if (first === undefined || !PARTICLE_LETTERS.has(first)) return null;
    candidate = candidate.slice(1);
  }
  return null;
}

function tokenise(text: string): string[] {
  return stripBidiControls(text)
    .split(/\s+/u)
    .map((raw) => {
      const core = raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'׳’‘]+$/u, '');
      // A trailing geresh belongs to a day letter only; elsewhere it is punctuation.
      return DAY_LETTER.test(core) ? core : core.replace(/['׳’‘]+$/u, '');
    })
    .filter((token) => token !== '');
}

function textOf(input: Record<string, unknown>): string {
  const part = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value : '';
  };
  return `${part('subject')}\n${part('body')}`;
}

/** Digit runs IN ORDER: swapped amounts or day/month (12/11 vs 11/12) are a change. */
function numbersOf(text: string): string[] {
  return (stripBidiControls(text).replace(/(?<=\d),(?=\d)/gu, '').match(/\d+/gu) ?? []);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function wordDistance(a: readonly string[], b: readonly string[]): number {
  if (Math.abs(a.length - b.length) > MAX_EDITED_WORDS) return MAX_EDITED_WORDS + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function recipientSet(input: Record<string, unknown>): string[] {
  return [...new Set(readEmails(input).map((email) => email.toLowerCase()))].sort();
}

export function agreementVerdict(input: {
  state: string;
  proposed: Record<string, unknown>;
  edited: Record<string, unknown> | null;
}): { verdict: AgreementVerdict; reason: WrongReason | null } {
  const right = { verdict: 'right', reason: null } as const;
  switch (input.state) {
    case 'approved':
      return right;
    case 'denied':
      return { verdict: 'wrong', reason: 'denied' };
    case 'approved_with_edit':
      break;
    default:
      return { verdict: 'not_counted', reason: null };
  }
  if (input.edited === null) return right;

  if (!sameList(recipientSet(input.proposed), recipientSet(input.edited))) {
    return { verdict: 'wrong', reason: 'recipient' };
  }

  const before = textOf(input.proposed);
  const after = textOf(input.edited);
  if (!sameList(numbersOf(before), numbersOf(after))) {
    return { verdict: 'wrong', reason: 'number' };
  }

  const beforeTokens = tokenise(before);
  const afterTokens = tokenise(after);
  const dates = (tokens: string[]): string[] =>
    tokens.flatMap((t) => {
      const d = dateWordOf(t);
      return d === null ? [] : [d];
    }).sort();
  if (!sameList(dates(beforeTokens), dates(afterTokens))) {
    return { verdict: 'wrong', reason: 'date' };
  }

  if (wordDistance(beforeTokens, afterTokens) > MAX_EDITED_WORDS) {
    return { verdict: 'wrong', reason: 'too_many_words' };
  }
  return right;
}
