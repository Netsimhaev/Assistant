/**
 * Deciding that the owner just said an instruction is finished — and nothing
 * more.
 *
 * The owner's own rule, in his words: "הוראה לא יכולה להיסגר עד שהבוס לא
 * אומר שהמשימה נסגרת (במילים שלו) או שהעוזרת האישית מודיעה על 'בוצע',
 * 'נכשל' או משהו שקשור לסוף משימה." One half of that — the assistant
 * announcing an outcome — is `whatsapp-report.ts`. This module is the other
 * half: the owner saying it himself.
 *
 * **A fixed verb list, never a model.** Same shape and same reasoning as
 * `./forget-command.ts`: letting a model classify would make "did my
 * instruction just get closed" a probabilistic question, and the answer has
 * to be inspectable. It joins the list this project already keeps for the
 * same reason — the forget command's verbs, the standing authorisation
 * matching the bytes of the instruction, `EntityRef` with no branch that can
 * carry an address, and `resolveContacts` matching against a table rather
 * than asking a model who "רונית" is.
 *
 * **Disjoint from `FORGET_VERBS`, and that is enforced, not merely intended.**
 * "תשכחי מזה" already opens the erasure screen from the dashboard's
 * instruction box (`handleInstructPost`, `src/dashboard/server.ts`), and a
 * closure list sharing any of those four verbs would make the same four words
 * mean two different things depending on which check ran first — with a
 * contact-deletion preview behind one of them. `closure-command.test.ts`
 * intersects the two exported arrays.
 *
 * **Two positive conditions, not one, and the second is what keeps a real
 * instruction out.** The verb must OPEN the message (the same anchoring
 * `readForgetCommand` uses, and for the same reason: a supplier's sentence
 * can reach this door by paste or by quotation, and a verb matched anywhere
 * would make quoting someone a way to close the owner's own work), AND the
 * whole message must be at most `MAX_CLOSURE_TOKENS` tokens long. Without the
 * second condition, "סגרנו על 500 שקל, תשלחי לדנה חוזה" — an opening that
 * means "we agreed", followed by a genuine instruction — would be read as a
 * closure and the instruction inside it would never be planned. A message
 * that goes on to ask for something is longer than three tokens.
 *
 * **The cost of that condition, stated: a long closure is missed.** "סגרנו
 * את העניין הזה סופית" is five tokens and is not recognised. That is the
 * safe direction and it is the direction the owner's own rule points: an
 * unrecognised closure leaves the instruction OPEN, which is exactly what he
 * said should happen until one side says clearly that it is closed, and he
 * can say "סגרנו" on its own. The unsafe direction — closing something he
 * did not mean to close, or swallowing an instruction — is what the token
 * bound buys.
 */

/**
 * The openings that mean "this is finished". A positive list, matched at the
 * start of the message, and deliberately small.
 *
 * **What is NOT here, and why.** Cancel verbs — `תבטלי`, `בטלי`, `ביטול` —
 * were considered and rejected: "תבטלי את הפגישה עם דנה" is a genuine new
 * instruction (a calendar action), and admitting the verb would route it to
 * closure instead of to the planner. The same test excludes anything that can
 * plausibly open a request. Every member here is a statement about work
 * already discussed, not a thing to go and do.
 *
 * Exported so the disjointness test can intersect it with `FORGET_VERBS`
 * rather than re-type either list.
 */
export const CLOSURE_VERBS: readonly string[] = [
  'סגרנו',
  'סגור',
  'סיימנו',
  'סיימתי',
  'זהו',
  'עזבי',
  'תעזבי',
];

/**
 * How many whitespace-separated tokens a closure may be, in total.
 *
 * Three covers every natural short form — "סגרנו", "סגרנו תודה", "זהו, תודה
 * רבה", "עזבי את זה" — and excludes a sentence that opens with a closure
 * word and then asks for something. See the module docblock for the cost.
 */
export const MAX_CLOSURE_TOKENS = 3;

/**
 * The verb the assistant itself offers when it needs the owner to close
 * something ("או לכתוב לי 'סגרנו'", `whatsapp-routing.ts`).
 *
 * Exported from here, not spelled out at the call site, so prose cannot
 * suggest a word this parser would then reject — a test asserts it is a real
 * member of `CLOSURE_VERBS`. Telling the owner to type a word that does
 * nothing is exactly the dead-end the ambiguity refusal exists to avoid.
 */
export const SUGGESTED_CLOSURE_VERB = 'סגרנו';

/**
 * Strips what a closure token may legitimately carry, and nothing else.
 *
 * The punctuation strip is `bareToken`'s (`./forget-command.ts`) — trailing
 * punctuation carries no meaning ("סגרנו," is an ordinary Hebrew opening),
 * and the leading quote is NOT stripped, because the security property is
 * precisely that a quoted sentence must not close anything.
 *
 * **Only `ו` is stripped as an attached prefix, never the whole particle
 * family.** "וסגרנו" and "וזהו" are how a Hebrew sentence continues, so the
 * conjunction has to come off. The other particles in
 * `LEADING_HEBREW_PARTICLE` (`./typed-recipients.ts`) do not attach to a
 * verb in this position — "לסגרנו" and "בזהו" are not Hebrew — so stripping
 * them could only ever turn a non-closure into a closure, which is the
 * direction this file refuses to move in. The hyphen form (`ל-סגרנו`) is
 * excluded for the same reason: nothing legitimately writes it.
 */
function bareClosureToken(token: string): string {
  const withoutVav = token.length > 1 && token.startsWith('ו') ? token.slice(1) : token;
  return withoutVav.replace(/[)'"»,.;:!?]+$/, '');
}

/**
 * True when the owner just said, in his own words, that the open instruction
 * is finished.
 *
 * Carries no payload: unlike `readForgetCommand`, there is nothing to extract
 * — a closure says "what is open is done", and WHICH instruction is open is
 * derived from the record (`pendingQuestions`), never parsed out of this
 * text. Parsing a target here would be this module deciding what gets closed,
 * which is the same mistake as a tool that decides what gets erased.
 */
export function isClosureCommand(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0 || tokens.length > MAX_CLOSURE_TOKENS) return false;
  const first = tokens[0];
  if (first === undefined) return false;
  return CLOSURE_VERBS.includes(bareClosureToken(first));
}
