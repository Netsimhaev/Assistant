import { describe, expect, it } from 'vitest';
import type { Contact } from './contacts.js';
import { resolveContacts } from './contact-resolver.js';

const RONIT: Contact = {
  subjectKeys: ['ronit-cohen-beta-log', 'ronit@beta-log.example'],
  name: 'רונית כהן',
  company: 'בטא לוגיסטיקה',
  email: 'ronit@beta-log.example',
};

const RONIT_TWO: Contact = {
  subjectKeys: ['ronit-levi-gamma'],
  name: 'רונית לוי',
  company: 'גמא הרמה',
  email: 'ronit@gamma-lift.example',
};

const DANI: Contact = {
  subjectKeys: ['dani-cohen-delta'],
  name: 'דני כהן',
  company: 'דלתא',
  email: 'dani@delta.example',
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
});
