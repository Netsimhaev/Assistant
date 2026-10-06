/**
 * Deciding that a typed instruction is a forget command — and nothing more.
 *
 * This routes; it never decides what is deleted. The owner's text opens the
 * erasure screen pre-filled with whatever can be read out of it with
 * certainty, and everything else is picked from a list of things that really
 * exist (spec §4.1). A model is deliberately not used: classification would
 * make "which screen did my instruction go to" a probabilistic question, and
 * the answer has to be inspectable.
 *
 * The verb must OPEN the text. A supplier's sentence can reach the
 * instruction box by paste, and a verb matched anywhere would make quoting
 * someone a way to trigger the screen.
 */

/**
 * The openings that mean "forget". A positive list, matched at the start.
 *
 * **Exported for one reason: a second verb list now exists, and the two must
 * never share a member.** `CLOSURE_VERBS` (`./closure-command.ts`) means "the
 * instruction is finished" and closes a parked job; this list means "open the
 * erasure screen". A word in both would make the owner's intent depend on
 * which check ran first — and the erasure side is the one with a contact
 * deletion preview behind it. The disjointness test
 * (`closure-command.test.ts`) imports BOTH exported arrays and intersects
 * them, rather than re-typing either: two lists compared against a
 * hand-copied duplicate of one of them is how two lists drift apart while
 * their test stays green.
 */
export const FORGET_VERBS: readonly string[] = ['תשכחי', 'שכחי', 'תמחקי', 'מחקי'];

/**
 * Whole-token email address test, using the same anchoring approach as
 * `typed-recipients.ts`: match only when the entire token is an email shape,
 * never when email-like characters appear in the middle of a longer string.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** `3/9/2026`, `03.09.2026`, `3-9-26` — day first, as Hebrew writes it. */
const DATE_SHAPE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;

export type ForgetCommand =
  | { recognised: false }
  | {
      recognised: true;
      /** Email address extracted from the text, or null if none was present or readable. */
      identifier: string | null;
      /** Date extracted from the text (YYYY-MM-DD format), or null if none was present.
       * The date's existence is verified; an impossible date like 31/02 returns null.
       * Phone anchors come from the owner's choice in a picker, not from text parsing. */
      onDate: string | null;
    };

/**
 * Strips the Hebrew prefix particles and punctuation a token may carry.
 *
 * The two strips are separate on purpose, and only the leading one is
 * conditional. The security property is about an opening quote: a supplier's
 * sentence reaches the instruction box by paste and opens with one, so the
 * verb test must see it. Trailing punctuation carries no such meaning —
 * `תשכחי,` is an ordinary Hebrew opening — and a single `stripQuotes`
 * flag that suppressed both made it unrecognised, sending a sentence that
 * says "forget" to the planner instead of to this screen.
 */
function bareToken(token: string, stripQuotes: boolean = true): string {
  const withoutPrefix = /^[לבמהוכש]-/.test(token) ? token.slice(2) : token;
  const withoutLeading = stripQuotes ? withoutPrefix.replace(/^[('"«]+/, '') : withoutPrefix;
  return withoutLeading.replace(/[)'"»,.;:!?]+$/, '');
}

function readDate(token: string): string | null {
  const match = DATE_SHAPE.exec(token);
  if (match === null) return null;
  const [, dayRaw, monthRaw, yearRaw] = match;
  if (dayRaw === undefined || monthRaw === undefined || yearRaw === undefined) return null;

  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  // Verify the date actually exists: construct it and check it round-trips.
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function readForgetCommand(text: string): ForgetCommand {
  const trimmed = text.trim();
  // Do not strip quotes from the first token when checking for the opening verb.
  // A command cannot open with someone else's quoted words.
  const firstToken = bareToken(trimmed.split(/\s+/)[0] ?? '', false);
  if (!FORGET_VERBS.includes(firstToken)) return { recognised: false };

  let identifier: string | null = null;
  let onDate: string | null = null;

  for (const raw of trimmed.split(/\s+/)) {
    const token = bareToken(raw);
    if (identifier === null && EMAIL_SHAPE.test(token)) {
      identifier = token.toLowerCase();
      continue;
    }
    if (onDate === null) {
      const date = readDate(token);
      if (date !== null) onDate = date;
    }
  }

  return { recognised: true, identifier, onDate };
}
