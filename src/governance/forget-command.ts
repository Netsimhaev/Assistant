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

/** The openings that mean "forget". A positive list, matched at the start. */
const FORGET_VERBS: readonly string[] = ['תשכחי', 'שכחי', 'תמחקי', 'מחקי'];

/**
 * Same shape as `typed-recipients.ts` uses: a whole-token test, not a scan
 * for something address-like inside a longer run of characters.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** `3/9/2026`, `03.09.2026`, `3-9-26` — day first, as Hebrew writes it. */
const DATE_SHAPE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;

export type ForgetCommand =
  | { recognised: false }
  | { recognised: true; identifier: string | null; onDate: string | null };

/** Strips the Hebrew prefix particles and punctuation a token may carry. */
function bareToken(token: string): string {
  const withoutPrefix = /^[לבמהוכש]-/.test(token) ? token.slice(2) : token;
  return withoutPrefix.replace(/^[('"«]+/, '').replace(/[)'"»,.;:!?]+$/, '');
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

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function readForgetCommand(text: string): ForgetCommand {
  const trimmed = text.trim();
  const firstToken = bareToken(trimmed.split(/\s+/)[0] ?? '');
  if (!FORGET_VERBS.includes(firstToken)) return { recognised: false };

  let identifier: string | null = null;
  let onDate: string | null = null;

  for (const raw of trimmed.split(/[\s ]+/)) {
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
