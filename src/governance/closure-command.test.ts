import { describe, expect, it } from 'vitest';
import {
  isClosureCommand,
  CLOSURE_VERBS,
  CLOSURE_VERB_WORDS,
  MAX_CLOSURE_TOKENS,
  SUGGESTED_CLOSURE_VERB,
} from './closure-command.js';
import { FORGET_VERBS, readForgetCommand } from './forget-command.js';

/** The verbs that carry the multi-token allowance, and the ones that do not. */
const WITH_ALLOWANCE = CLOSURE_VERBS.filter((v) => !v.aloneOnly).map((v) => v.verb);
const ALONE_ONLY = CLOSURE_VERBS.filter((v) => v.aloneOnly).map((v) => v.verb);

describe('isClosureCommand', () => {
  it('recognises every verb on the list, on its own', () => {
    for (const verb of CLOSURE_VERB_WORDS) {
      expect(isClosureCommand(verb), verb).toBe(true);
    }
  });

  it('recognises a short closure with a courtesy word after it', () => {
    expect(isClosureCommand('סגרנו תודה')).toBe(true);
    expect(isClosureCommand('סיימנו עם זה')).toBe(true);
  });

  it('strips a leading vav, because that is how a Hebrew sentence continues', () => {
    expect(isClosureCommand('וסגרנו')).toBe(true);
    expect(isClosureCommand('וזהו')).toBe(true);
  });

  it('strips trailing punctuation, which carries no meaning', () => {
    expect(isClosureCommand('סגרנו.')).toBe(true);
    expect(isClosureCommand('סיימנו!')).toBe(true);
    expect(isClosureCommand('זהו,')).toBe(true);
  });

  /**
   * The security property, and the same one `readForgetCommand` carries: a
   * supplier's sentence reaches this door by paste or by quotation, and a
   * verb matched anywhere — or behind an opening quote — would make quoting
   * someone a way to close the owner's own work.
   */
  it('refuses a closure word that is quoted, or that does not open the message', () => {
    expect(isClosureCommand('"סגרנו" כך הוא אמר')).toBe(false);
    expect(isClosureCommand('הוא כתב לי «זהו»')).toBe(false);
    expect(isClosureCommand('תשלחי לדנה שסגרנו')).toBe(false);
  });

  /**
   * The condition that keeps a real instruction out — see the module
   * docblock. "סגרנו על X" means "we agreed on X" and can open a genuine
   * request; without the token bound the request inside it would be read as
   * a closure and never planned.
   */
  it('refuses a message that opens with a closure word and then asks for something', () => {
    expect(isClosureCommand('סגרנו על 500 שקל, תשלחי לדנה חוזה')).toBe(false);
    expect(isClosureCommand('סיימנו עם הספק הקודם ועכשיו תתקשרי לחדש')).toBe(false);
  });

  /**
   * The bound's MECHANISM, derived from the constant so it stays real
   * evidence whatever the number is set to: exactly at the bound passes, one
   * token over fails.
   *
   * (An earlier version hard-coded four tokens and guarded with
   * `expect(tooLong.length).toBeGreaterThan(MAX_CLOSURE_TOKENS)`. Under a
   * mutation that raised the bound, that guard failed first — a mechanical
   * failure about the fixture, not evidence about the code.)
   */
  it('refuses a message one token longer than the bound, and accepts one at it', () => {
    for (const verb of WITH_ALLOWANCE) {
      const atBound = [verb, ...Array(MAX_CLOSURE_TOKENS - 1).fill('זה')];
      const overBound = [verb, ...Array(MAX_CLOSURE_TOKENS).fill('זה')];
      expect(atBound).toHaveLength(MAX_CLOSURE_TOKENS);
      expect(isClosureCommand(atBound.join(' ')), verb).toBe(true);
      expect(isClosureCommand(overBound.join(' ')), verb).toBe(false);
    }
  });

  /**
   * **The bound's VALUE, pinned — fix round 1, Minor 4.** The mechanism test
   * above passes at any bound, and the "asks for something" test above it
   * uses seven-token sentences, so a bound of 4, 5 or 6 used to pass every
   * test in this file. A limit nothing pins can drift to permissive without a
   * single red, and this is the third appearance of that class on this
   * branch.
   *
   * Two assertions, because each catches something the other does not: the
   * exact value (so any change is a deliberate one that has to come here and
   * reconsider the sentence below), and a real four-token message that must
   * not close an open question — "we agreed a price with Dana" is a statement
   * with content, and a message with content beyond the closure word is not
   * a closure.
   */
  it('keeps the bound at three, so a four-token message with real content never closes anything', () => {
    // Behaviour first, deliberately: under a mutation that raises the bound,
    // the assertion that fires must be one about what the code DOES, not one
    // about what a constant equals. A failure on the constant alone would be
    // a statement about the fixture, which this branch has already learned
    // not to accept as evidence.
    expect(isClosureCommand('סגרנו מחיר עם דנה')).toBe(false);
    expect(isClosureCommand('סיימנו את העבודה אצלו')).toBe(false);
    // And then the value, so a change has to come here and reconsider the
    // two sentences above rather than drift past them.
    expect(MAX_CLOSURE_TOKENS).toBe(3);
  });

  /**
   * **Fix round 1, Important 1 — this task's own defect class, caught
   * re-entering through its own fix.** Closure is tested BEFORE the answer
   * route (it has to be: an aged-out question is still open and must stay
   * closable), so a verb that can precede an answer would close the question
   * instead of answering it, and the answer would go nowhere — exactly the
   * failure this task exists to end.
   */
  it('does not let a closure word that can precede an answer swallow the answer', () => {
    expect(isClosureCommand('זהו, רונית כהן')).toBe(false);
    expect(isClosureCommand('זהו רונית כהן')).toBe(false);
    // And the verb still closes on its own, which is what it is for.
    expect(isClosureCommand('זהו')).toBe(true);
  });

  /**
   * **Fix round 1, Important 2.** `עזבי`/`תעזבי` are cancel verbs, and this
   * module's docblock states the rule that cancel verbs are excluded because
   * they are real instructions. A genuine cancellation read as a closure is
   * never planned, and the owner is told "הכול כבר סגור מהצד שלי" — a false
   * reassurance about work nobody did.
   */
  it('does not read a cancellation as a closure, however short', () => {
    expect(isClosureCommand('תעזבי את הפגישה')).toBe(false);
    expect(isClosureCommand('עזבי את דנה')).toBe(false);
    // Alone it is a closure — "drop it" with nothing to drop but the open
    // question itself.
    expect(isClosureCommand('תעזבי')).toBe(true);
  });

  /**
   * The general form of the two tests above, over the data rather than over
   * three hand-picked examples: every `aloneOnly` verb closes alone and
   * refuses anything after it, whatever that is. A fourth such verb added to
   * the list is covered the day it is added.
   */
  it('closes on an aloneOnly verb only as the whole message', () => {
    for (const verb of ALONE_ONLY) {
      expect(isClosureCommand(verb), verb).toBe(true);
      expect(isClosureCommand(`${verb} משהו`), verb).toBe(false);
    }
    // Paired positive check: the group is populated, so the loop above is
    // not vacuously green.
    expect(ALONE_ONLY.length).toBeGreaterThan(0);
    expect(WITH_ALLOWANCE.length).toBeGreaterThan(0);
  });

  it('refuses an ordinary instruction and an empty message', () => {
    expect(isClosureCommand('תשלחי לדנה את ההצעה')).toBe(false);
    expect(isClosureCommand('')).toBe(false);
    expect(isClosureCommand('   ')).toBe(false);
  });

  /**
   * `תבטלי`/`בטלי`/`ביטול` are not on the list at all — not even as
   * `aloneOnly` members — because the bare forms are close enough to a real
   * calendar instruction that admitting them buys nothing a safer closure
   * word does not already buy. Asserted as behaviour so a future edit that
   * adds one fails here.
   */
  it('does not treat a cancellation verb as a closure word at all', () => {
    expect(isClosureCommand('תבטלי את הפגישה')).toBe(false);
    expect(isClosureCommand('בטלי')).toBe(false);
    expect(isClosureCommand('ביטול')).toBe(false);
  });

  /**
   * Fix round 1, Minor 5. `src/util/bidi.ts` is the single owner of this
   * character class and `instructionSnippet` on the other side of the channel
   * already strips it; a closure word wrapped in direction marks must not
   * quietly stop being one.
   */
  it('recognises a closure word wrapped in directionality controls', () => {
    expect(isClosureCommand('‫סגרנו‬')).toBe(true);
    expect(isClosureCommand('‏זהו')).toBe(true);
    // And the strip cannot manufacture a closure from something else: it
    // removes characters, never inserts a token.
    expect(isClosureCommand('‫תשלחי לדנה‬')).toBe(false);
  });
});

describe('the closure list and the forget list', () => {
  /**
   * **The collision this test exists for is serious, not theoretical.**
   * "תשכחי מזה" already opens the erasure screen from the dashboard's
   * instruction box, which previews a contact deletion. A closure list
   * sharing any of those four verbs would make the same four words mean two
   * different things depending on which check ran first.
   *
   * Both arrays are imported from the modules that own them — never
   * re-typed here, and `CLOSURE_VERB_WORDS` is itself `.map`ped from
   * `CLOSURE_VERBS` rather than written out a second time. A hand-copied
   * duplicate is exactly how two lists drift apart while the test that
   * compares them stays green.
   */
  it('share no member at all', () => {
    const shared = CLOSURE_VERB_WORDS.filter((verb) => FORGET_VERBS.includes(verb));
    expect(shared).toEqual([]);
    // Paired positive check: both lists are actually populated, so the
    // intersection above is empty because they are disjoint and not because
    // one of them was emptied or an import silently resolved to `undefined`.
    expect(CLOSURE_VERB_WORDS.length).toBeGreaterThan(0);
    expect(FORGET_VERBS.length).toBeGreaterThan(0);
    // And the derived word list really covers the structured one.
    expect(CLOSURE_VERB_WORDS).toHaveLength(CLOSURE_VERBS.length);
  });

  /**
   * The behavioural half of the same property, through the two real
   * recognisers rather than their word lists: no message is both. This is
   * what a shared member would actually cost, and it would still catch a
   * collision introduced through the token/particle handling rather than
   * through the lists themselves.
   */
  it('never both recognise the same message', () => {
    for (const verb of [...CLOSURE_VERB_WORDS, ...FORGET_VERBS]) {
      for (const message of [verb, `${verb} מזה`]) {
        const both = isClosureCommand(message) && readForgetCommand(message).recognised;
        expect(both, message).toBe(false);
      }
    }
    // And the one the owner's own report named: a forget command stays a
    // forget command and closes nothing.
    expect(isClosureCommand('תשכחי מזה')).toBe(false);
    expect(readForgetCommand('תשכחי מזה').recognised).toBe(true);
  });

  /**
   * The assistant tells the owner to type this word when it needs him to
   * close something (`whatsapp-routing.ts`'s ambiguity refusal and stale
   * notice). Prose that suggests a word the parser rejects is a dead end
   * dressed as an exit.
   */
  it('suggests a verb the recogniser actually accepts', () => {
    expect(CLOSURE_VERB_WORDS).toContain(SUGGESTED_CLOSURE_VERB);
    expect(isClosureCommand(SUGGESTED_CLOSURE_VERB)).toBe(true);
  });
});
