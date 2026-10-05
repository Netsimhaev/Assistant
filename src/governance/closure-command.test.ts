import { describe, expect, it } from 'vitest';
import {
  isClosureCommand,
  CLOSURE_VERBS,
  MAX_CLOSURE_TOKENS,
  SUGGESTED_CLOSURE_VERB,
} from './closure-command.js';
import { FORGET_VERBS } from './forget-command.js';
import { readForgetCommand } from './forget-command.js';

describe('isClosureCommand', () => {
  it('recognises every verb on the list, on its own', () => {
    for (const verb of CLOSURE_VERBS) {
      expect(isClosureCommand(verb), verb).toBe(true);
    }
  });

  it('recognises a short closure with a courtesy word after it', () => {
    expect(isClosureCommand('סגרנו תודה')).toBe(true);
    expect(isClosureCommand('זהו, תודה רבה')).toBe(true);
    expect(isClosureCommand('עזבי את זה')).toBe(true);
  });

  it('strips a leading vav, because that is how a Hebrew sentence continues', () => {
    expect(isClosureCommand('וסגרנו')).toBe(true);
    expect(isClosureCommand('וזהו, תודה')).toBe(true);
  });

  it('strips trailing punctuation, which carries no meaning', () => {
    expect(isClosureCommand('סגרנו.')).toBe(true);
    expect(isClosureCommand('סיימנו!')).toBe(true);
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
   * The bound itself, derived from the constant rather than from a
   * hand-counted array: this asserts that the MECHANISM holds at whatever
   * the bound is set to, and stays real evidence if the number changes. The
   * test above is the one that pins the number's actual VALUE, by naming a
   * real sentence that must not be read as a closure.
   *
   * (An earlier version hard-coded four tokens and guarded with
   * `expect(tooLong.length).toBeGreaterThan(MAX_CLOSURE_TOKENS)`. Under a
   * mutation that raised the bound, that guard failed first — a mechanical
   * failure about the fixture, not evidence about the code.)
   */
  it('refuses a message one token longer than the bound, and accepts one at it', () => {
    const atBound = ['סגרנו', ...Array(MAX_CLOSURE_TOKENS - 1).fill('זה')];
    const overBound = ['סגרנו', ...Array(MAX_CLOSURE_TOKENS).fill('זה')];
    expect(atBound).toHaveLength(MAX_CLOSURE_TOKENS);
    expect(isClosureCommand(atBound.join(' '))).toBe(true);
    expect(isClosureCommand(overBound.join(' '))).toBe(false);
  });

  it('refuses an ordinary instruction and an empty message', () => {
    expect(isClosureCommand('תשלחי לדנה את ההצעה')).toBe(false);
    expect(isClosureCommand('')).toBe(false);
    expect(isClosureCommand('   ')).toBe(false);
  });

  /**
   * Cancel verbs are excluded on purpose: "תבטלי את הפגישה עם דנה" is a
   * genuine new instruction (a calendar action), and admitting the verb
   * would route it to closure instead of to the planner. Asserted as
   * behaviour rather than as a comment, so a future edit that adds a cancel
   * verb to the list fails here.
   */
  it('does not treat a cancellation as a closure', () => {
    expect(isClosureCommand('תבטלי את הפגישה')).toBe(false);
    expect(isClosureCommand('בטלי')).toBe(false);
    expect(isClosureCommand('ביטול')).toBe(false);
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
   * re-typed here. A hand-copied duplicate is exactly how two lists drift
   * apart while the test that compares them stays green.
   */
  it('share no member at all', () => {
    const shared = CLOSURE_VERBS.filter((verb) => FORGET_VERBS.includes(verb));
    expect(shared).toEqual([]);
    // Paired positive check: both lists are actually populated, so the
    // intersection above is empty because they are disjoint and not because
    // one of them was emptied or an import silently resolved to `undefined`.
    expect(CLOSURE_VERBS.length).toBeGreaterThan(0);
    expect(FORGET_VERBS.length).toBeGreaterThan(0);
  });

  /**
   * The behavioural half of the same property, through the two real
   * recognisers rather than their word lists: no message is both. This is
   * what a shared member would actually cost, and it would still catch a
   * collision introduced through the token/particle handling rather than
   * through the lists themselves.
   */
  it('never both recognise the same message', () => {
    for (const verb of [...CLOSURE_VERBS, ...FORGET_VERBS]) {
      const message = `${verb} מזה`;
      const both = isClosureCommand(message) && readForgetCommand(message).recognised;
      expect(both, message).toBe(false);
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
    expect(CLOSURE_VERBS).toContain(SUGGESTED_CLOSURE_VERB);
    expect(isClosureCommand(SUGGESTED_CLOSURE_VERB)).toBe(true);
  });
});
