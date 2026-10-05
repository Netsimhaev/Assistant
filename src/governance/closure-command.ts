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
 * message must be within the token allowance **that verb itself carries**.
 * Without the second condition, "סגרנו על 500 שקל, תשלחי לדנה חוזה" — an
 * opening that means "we agreed", followed by a genuine instruction — would
 * be read as a closure and the instruction inside it would never be planned.
 *
 * **The allowance is per verb, not one number for all of them**, and that is
 * fix round 1's Important 1 and 2: four verbs carry up to
 * `MAX_CLOSURE_TOKENS` tokens, and three (`זהו`, `עזבי`, `תעזבי`) close only
 * as the ENTIRE message, because each of those can legitimately begin a
 * sentence that is not a closure — an answer ("זהו, רונית כהן") or a
 * cancellation ("תעזבי את הפגישה"). `ClosureVerb.aloneOnly` carries the
 * distinction in the data; see its own docblock for what each case cost.
 *
 * **The cost of the bound, stated: a long closure is missed.** "סגרנו את
 * העניין הזה סופית" is five tokens and is not recognised. That is the safe
 * direction and it is the direction the owner's own rule points: an
 * unrecognised closure leaves the instruction OPEN, which is exactly what he
 * said should happen until one side says clearly that it is closed, and he
 * can say "סגרנו" on its own. The unsafe direction — closing something he
 * did not mean to close, or swallowing an instruction or an answer — is what
 * the bound buys.
 */
import { stripBidiControls } from '../util/bidi.js';

/**
 * A closure verb, and how much may follow it.
 *
 * **`aloneOnly` is this task's own defect class, caught re-entering through
 * its own fix (fix round 1, Important 1 and 2).** Three of these verbs can
 * legitimately BEGIN a sentence that is not a closure:
 *
 *   - `זהו, רונית כהן` — "that's it, Ronit Cohen" — is an ANSWER to a
 *     clarifying question. Closure is tested before the answer route (it has
 *     to be: an aged-out question is still open and must stay closable), so
 *     under a flat three-token bound that message closed the question instead
 *     of answering it, and the answer went nowhere. That is exactly the
 *     failure this whole task exists to end, re-entered one layer up.
 *   - `תעזבי את הפגישה` / `עזבי את זה עם דנה` — these are CANCEL verbs, and
 *     this file's own docblock states the rule that cancel verbs are excluded
 *     because they are real instructions. A genuine cancellation read as a
 *     closure is never planned, and the owner is told "הכול כבר סגור מהצד
 *     שלי" — a false reassurance about work nobody did.
 *
 * The distinction lives HERE, in the data, rather than in a condition
 * somewhere else that decides which verbs are which: a reader of this list
 * can see which verbs carry the allowance and which do not, and adding a verb
 * forces an answer to the question rather than inheriting one silently.
 *
 * `aloneOnly: false` is what makes "סגרנו תודה" and "סיימנו עם זה" work —
 * those four verbs cannot plausibly open a request or precede an answer.
 */
export interface ClosureVerb {
  readonly verb: string;
  /**
   * `true` when the verb closes ONLY as the entire message (one token). A
   * verb that can precede an answer, or open a cancellation, must not carry
   * the multi-token allowance.
   */
  readonly aloneOnly: boolean;
}

/**
 * The openings that mean "this is finished". A positive list, matched at the
 * start of the message, and deliberately small.
 *
 * **What is NOT here, and why.** `תבטלי`, `בטלי` and `ביטול` were considered
 * and rejected outright, not even as `aloneOnly` members: "תבטלי את הפגישה עם
 * דנה" is a genuine new instruction (a calendar action), and the bare forms
 * are close enough to it that admitting them buys nothing a closure word
 * without that hazard does not already buy. `עזבי`/`תעזבי` are the same
 * class and are admitted only as whole messages, for the reason
 * `ClosureVerb.aloneOnly` gives.
 *
 * Exported so the disjointness test can intersect it with `FORGET_VERBS`
 * rather than re-type either list.
 */
export const CLOSURE_VERBS: readonly ClosureVerb[] = [
  { verb: 'סגרנו', aloneOnly: false },
  { verb: 'סגור', aloneOnly: false },
  { verb: 'סיימנו', aloneOnly: false },
  { verb: 'סיימתי', aloneOnly: false },
  // Can precede an answer: "זהו, רונית כהן".
  { verb: 'זהו', aloneOnly: true },
  // Cancel verbs: "תעזבי את הפגישה" is an instruction, not a closure.
  { verb: 'עזבי', aloneOnly: true },
  { verb: 'תעזבי', aloneOnly: true },
];

/**
 * Just the words, derived from the list above with `.map` so the two cannot
 * drift. The disjointness test against `FORGET_VERBS` compares words, and a
 * second hand-written array of them is how two lists come apart while the
 * test that compares them stays green.
 */
export const CLOSURE_VERB_WORDS: readonly string[] = CLOSURE_VERBS.map((v) => v.verb);

/**
 * How many whitespace-separated tokens a closure may be, in total — for a
 * verb that carries the allowance at all (`aloneOnly: false`).
 *
 * Three covers every natural short form — "סגרנו", "סגרנו תודה", "סיימנו עם
 * זה" — and excludes a sentence that opens with a closure word and then asks
 * for something. The VALUE is pinned by a test, not only the mechanism: a
 * bound of four would let "סגרנו מחיר עם דנה" close an open question, and a
 * limit nothing pins can drift to permissive without a single red (fix round
 * 1, Minor 4). See the module docblock for the cost of the bound existing at
 * all.
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
 *
 * **Directionality controls are stripped first** (fix round 1, Minor 5).
 * `src/util/bidi.ts` is the single owner of that character class, and
 * `instructionSnippet` on the other side of this channel already uses it; a
 * closure word wrapped in direction marks must not quietly stop being one,
 * and a non-closure must not be able to hide a closure word's shape behind
 * them either. The strip removes characters only — it cannot create a token
 * that was not there.
 */
export function isClosureCommand(text: string): boolean {
  const tokens = stripBidiControls(text)
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
  const first = tokens[0];
  if (first === undefined) return false;

  const bare = bareClosureToken(first);
  const match = CLOSURE_VERBS.find((candidate) => candidate.verb === bare);
  if (match === undefined) return false;

  // The allowance comes from the verb itself, never from a condition here.
  return tokens.length <= (match.aloneOnly ? 1 : MAX_CLOSURE_TOKENS);
}
