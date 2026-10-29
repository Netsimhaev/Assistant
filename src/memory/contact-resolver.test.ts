import { describe, expect, it } from 'vitest';
import type { Contact } from './contacts.js';
import { resolveContacts } from './contact-resolver.js';

const RONIT: Contact = {
  subjectKeys: ['ronit-cohen-beta-log', 'ronit@beta-log.example'],
  provenance: 'boss',
  name: 'רונית כהן',
  company: 'בטא לוגיסטיקה',
  email: 'ronit@beta-log.example',
};

const RONIT_TWO: Contact = {
  subjectKeys: ['ronit-levi-gamma'],
  provenance: 'boss',
  name: 'רונית לוי',
  company: 'גמא הרמה',
  email: 'ronit@gamma-lift.example',
};

const DANI: Contact = {
  subjectKeys: ['dani-cohen-delta'],
  provenance: 'boss',
  name: 'דני כהן',
  company: 'דלתא',
  email: 'dani@delta.example',
};

const RONIT_ONLY: Contact = {
  subjectKeys: ['ronit-solo'],
  provenance: 'boss',
  name: 'רונית',
  company: null,
  email: 'ronit@solo.example',
};

const RONIT_ONLY_TWO: Contact = {
  subjectKeys: ['ronit-solo-two'],
  provenance: 'boss',
  name: 'רונית',
  company: null,
  email: 'ronit2@solo.example',
};

describe('resolving a name to an identity', () => {
  it('resolves a first name to every key that person has', () => {
    const result = resolveContacts('תשיבי לרונית על ההצעה', [RONIT]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'ronit@beta-log.example']),
    );
  });

  /**
   * The owner's correction: a surname is a name like any other. One Cohen
   * resolves; several Cohens ask. There is no separate rule.
   */
  it('resolves a surname when it fits exactly one person', () => {
    const result = resolveContacts('תשיבי לכהן', [RONIT]);

    expect(result.subjects).toContain('ronit-cohen-beta-log');
    expect(result.ambiguities).toEqual([]);
  });

  /**
   * Both spellings. Preflight found the shared expression handles only the
   * hyphenated form, so the glued form — the one people actually write — is
   * the case that must be proven.
   */
  it('strips a leading Hebrew particle, glued or hyphenated', () => {
    expect(resolveContacts('תשיבי לרונית', [RONIT]).subjects).toContain('ronit-cohen-beta-log');
    expect(resolveContacts('תשיבי ל-רונית', [RONIT]).subjects).toContain('ronit-cohen-beta-log');
    expect(resolveContacts('מרונית הגיע עדכון', [RONIT]).subjects).toContain(
      'ronit-cohen-beta-log',
    );
  });

  /**
   * THE control. A looser comparison is how the resolver starts naming the
   * wrong person, and this codebase has watched exactly that happen when a
   * match was relaxed elsewhere.
   */
  it('matches a whole token and never a substring', () => {
    expect(resolveContacts('תשיבי לרוניתה', [RONIT]).subjects).toEqual([]);
    expect(resolveContacts('תשיבי לדן', [DANI]).subjects).toEqual([]);
  });

  it('asks when a name fits more than one person', () => {
    const result = resolveContacts('תשיבי לרונית', [RONIT, RONIT_TWO]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.token).toBe('רונית');
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });

  it('asks when a surname fits more than one person', () => {
    const result = resolveContacts('תשיבי לכהן', [RONIT, DANI]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
  });

  /**
   * The answer arrives as more text on the same instruction, so narrowing is
   * the same matcher run again — no second mechanism, no stored state.
   */
  it('narrows to one when the text also names the company', () => {
    const result = resolveContacts('תשיבי לרונית\n\nבטא לוגיסטיקה', [RONIT, RONIT_TWO]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-cohen-beta-log');
  });

  it('narrows to one when the text also names the address', () => {
    const result = resolveContacts('תשיבי לרונית\n\nronit@gamma-lift.example', [RONIT, RONIT_TWO]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-levi-gamma');
  });

  /**
   * "We could not narrow it down" must never become "take the first one".
   */
  it('still asks when the answer narrows to nobody', () => {
    const result = resolveContacts('תשיבי לרונית\n\nאני לא זוכר', [RONIT, RONIT_TWO]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
  });

  /**
   * `ולדני` is two stacked particles — ו and ל — on `דני`. Peeling one layer
   * reaches `לדני` and never the name, which is why the strip loops.
   */
  it('resolves two different people named in one instruction', () => {
    const result = resolveContacts('תשיבי לרונית ולדני', [RONIT, DANI]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'dani-cohen-delta']),
    );
  });

  it('returns nothing for a name nobody carries', () => {
    expect(resolveContacts('תשיבי למוטי', [RONIT, DANI])).toEqual({
      subjects: [],
      ambiguities: [],
    });
  });

  it('returns nothing when there are no contacts at all', () => {
    expect(resolveContacts('תשיבי לרונית', [])).toEqual({ subjects: [], ambiguities: [] });
  });

  /**
   * A one-word name must not collide with itself: `namePartsOf` used to
   * return the full name twice (once as `full`, once as its only "part"),
   * so a single contact was pushed into the same bucket twice and reported
   * as an ambiguity between herself and herself.
   */
  it('resolves a single one-word name silently, with no self-ambiguity', () => {
    const result = resolveContacts('תשיבי לרונית', [RONIT_ONLY]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(expect.arrayContaining(['ronit-solo']));
  });

  /**
   * Two different people who both happen to be named with the same single
   * word must still raise a real ambiguity with exactly two candidates —
   * de-duplicating a contact's own name parts must never merge two people.
   */
  it('still asks when two different people share one one-word name', () => {
    const result = resolveContacts('תשיבי לרונית', [RONIT_ONLY, RONIT_ONLY_TWO]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });
});

/**
 * F1. `tokensOf` keeps `.` inside a token so an address survives whole, and
 * the cost was that ordinary sentence punctuation became part of the name:
 * `תשיבי לרונית.` produced the token `רונית.`, which equals no contact's
 * name. The failure returned empty subjects AND empty ambiguities — the
 * same shape as "nobody by that name" — so it looked exactly like correct
 * behaviour while the feature was inert for the commonest way a Hebrew
 * sentence ends.
 */
describe('a name ending a sentence', () => {
  it('resolves a name followed by a full stop', () => {
    const result = resolveContacts('תשיבי לרונית.', [RONIT]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-cohen-beta-log');
  });

  it('resolves a name followed by a comma', () => {
    const result = resolveContacts('תשיבי לרונית, ותודה', [RONIT]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-cohen-beta-log');
  });

  it('resolves a name followed by a question mark', () => {
    const result = resolveContacts('ענית לרונית?', [RONIT]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toContain('ronit-cohen-beta-log');
  });

  /**
   * The address form is what the `.`-keeping split existed to protect, so
   * the strip must not cost it: an address is still one whole token, and an
   * address ending the sentence still narrows a real ambiguity — the second
   * is the case the review measured, where an answer typed with a full stop
   * left the owner with no memory and (before F2) no explanation.
   */
  it('keeps an address whole, with or without a trailing full stop', () => {
    const plain = resolveContacts('תשיבי לרונית\n\nronit@gamma-lift.example', [RONIT, RONIT_TWO]);
    expect(plain.ambiguities).toEqual([]);
    expect(plain.subjects).toContain('ronit-levi-gamma');

    const stopped = resolveContacts('תשיבי לרונית\n\nronit@gamma-lift.example.', [
      RONIT,
      RONIT_TWO,
    ]);
    expect(stopped.ambiguities).toEqual([]);
    expect(stopped.subjects).toContain('ronit-levi-gamma');
  });
});

/**
 * F5. Names match whole-token because "a looser comparison is how the
 * resolver starts naming the wrong person", and the company tie-break used
 * `text.includes(company)` — reintroducing exactly that, one field over.
 * Both cases below were measured against the module: each resolved ONE
 * candidate silently, which is a confident wrong identity rather than a
 * question. A company is usually several words, so the answer is a match on
 * a sequence of whole tokens, not a raw substring.
 */
describe('narrowing by company', () => {
  const RONIT_LIFT: Contact = {
    subjectKeys: ['ronit-cohen-lift'],
    provenance: 'boss',
    name: 'רונית כהן',
    company: 'הרמה',
    email: null,
  };

  const RONIT_BETA: Contact = {
    subjectKeys: ['ronit-levi-beta'],
    provenance: 'boss',
    name: 'רונית לוי',
    company: 'בטא לוגיסטיקה',
    email: null,
  };

  const DANA_DELTA: Contact = {
    subjectKeys: ['dana-delta'],
    provenance: 'boss',
    name: 'דנה',
    company: 'דלתא',
    email: null,
  };

  const DANA_OMEGA: Contact = {
    subjectKeys: ['dana-omega'],
    provenance: 'boss',
    name: 'דנה',
    company: 'אומגה',
    email: null,
  };

  it('does not narrow on a company that only appears inside another word', () => {
    const result = resolveContacts('תשיבי לדנה שנמצאת בדלתאות', [DANA_DELTA, DANA_OMEGA]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });

  /**
   * `הרמה` is a whole word of the company's name and `להרמה` is an ordinary
   * Hebrew word that merely contains it. The particle peel is not applied on
   * this side on purpose — it would turn `להרמה` back into `הרמה` and
   * restore the very match this test refuses.
   */
  it('does not narrow on a company carrying a glued particle in the text', () => {
    const result = resolveContacts('תשיבי לרונית בקשר להרמה של המשטח', [RONIT_LIFT, RONIT_BETA]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });

  /**
   * The legitimate case the tie-break exists for, and the reason it cannot
   * simply reuse the single-token name rule: a real company name is several
   * words, so it is matched as a contiguous run of whole tokens.
   */
  it('narrows to one when the text names a real multi-word company', () => {
    const result = resolveContacts('תשיבי לרונית\n\nבטא לוגיסטיקה', [RONIT_LIFT, RONIT_BETA]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(['ronit-levi-beta']);
  });

  it('narrows on a multi-word company that ends the sentence', () => {
    const result = resolveContacts('תשיבי לרונית מחברת בטא לוגיסטיקה.', [RONIT_LIFT, RONIT_BETA]);

    expect(result.ambiguities).toEqual([]);
    expect(result.subjects).toEqual(['ronit-levi-beta']);
  });
});

/**
 * The live run's finding, and the most valuable thing it produced. When the
 * assistant asks "which רונית?", the owner's most natural answer is
 * `רונית מבטא לוגיסטיקה` — Hebrew glues the particle onto the FIRST word of
 * the company's name — and three of the five phrasings measured did not
 * narrow at all. A question whose natural answer does not work is worse than
 * no question.
 *
 * The rule under test: peel a leading particle off the first word of the
 * company run ONLY, require every remaining word to match exactly, and allow
 * it only for a company of two or more words — the remaining words are the
 * anchor, and a one-word company matched through a peel has none. The two
 * cases at the bottom are the ones that anchor buys: they must still ask.
 */
describe('narrowing by a company the owner wrote with a particle', () => {
  const RONIT_BETA: Contact = {
    subjectKeys: ['ronit-levi-beta'],
    provenance: 'boss',
    name: 'רונית לוי',
    company: 'בטא לוגיסטיקה',
    email: null,
  };

  const RONIT_DELTA: Contact = {
    subjectKeys: ['ronit-barak-delta'],
    provenance: 'boss',
    name: 'רונית ברק',
    company: 'דלתא דפוס',
    email: null,
  };

  const NARROWS: ReadonlyArray<readonly [string, string]> = [
    ['רונית מבטא לוגיסטיקה', 'ronit-levi-beta'],
    ['רונית בטא לוגיסטיקה', 'ronit-levi-beta'],
    ['רונית של בטא לוגיסטיקה', 'ronit-levi-beta'],
    ['הכוונה לבטא לוגיסטיקה', 'ronit-levi-beta'],
    ['מדלתא דפוס', 'ronit-barak-delta'],
  ];

  for (const [answer, expected] of NARROWS) {
    it(`narrows on the answer "${answer}"`, () => {
      const result = resolveContacts(`תשיבי לרונית\n\n${answer}`, [RONIT_BETA, RONIT_DELTA]);

      expect(result.ambiguities).toEqual([]);
      expect(result.subjects).toEqual([expected]);
    });
  }

  /**
   * The anchor, stated as a test. `הרמה` is one word, so a peel would let
   * the ordinary Hebrew word `להרמה` name a person — the exact accident an
   * earlier review measured and fixed. A one-word company keeps asking.
   */
  it('still asks for a one-word company carrying a particle in the text', () => {
    const RONIT_LIFT: Contact = {
      subjectKeys: ['ronit-cohen-lift'],
      provenance: 'boss',
      name: 'רונית כהן',
      company: 'הרמה',
      email: null,
    };

    const result = resolveContacts('תשיבי לרונית, צריך להרמה של המשטח', [
      RONIT_LIFT,
      RONIT_BETA,
    ]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.candidates).toHaveLength(2);
  });

  /** The substring class stays dead: `דלתא` inside `בדלתאות` is not a match. */
  it('still asks when the company only appears inside a longer word', () => {
    const DANA_DELTA: Contact = {
      subjectKeys: ['dana-delta'],
      provenance: 'boss',
      name: 'דנה',
      company: 'דלתא',
      email: null,
    };
    const DANA_OMEGA: Contact = {
      subjectKeys: ['dana-omega'],
      provenance: 'boss',
      name: 'דנה',
      company: 'אומגה',
      email: null,
    };

    const result = resolveContacts('תשיבי לדנה שנמצאת בדלתאות', [DANA_DELTA, DANA_OMEGA]);

    expect(result.subjects).toEqual([]);
    expect(result.ambiguities).toHaveLength(1);
  });
});
