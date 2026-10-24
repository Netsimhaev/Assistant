import { describe, expect, it } from 'vitest';
import { ActionClass } from './action.js';
import { AutonomyLevel, TrustLevel } from './trust.js';
import {
  ACTION_CLASS_HE,
  AUTONOMY_LEVEL_HE,
  TRUST_LEVEL_HE,
  actionClassLabel,
  autonomyLevelLabel,
  trustLevelLabel,
} from './labels.js';

const LATIN = /[A-Za-z]/;

describe('Hebrew labels', () => {
  // The records are typed exhaustive, so a missing member is a compile error.
  // These walk the enums' runtime options anyway: a label that is empty, or
  // that quietly repeats the identifier, satisfies the type and still shows
  // the owner English.
  for (const [name, options, labels] of [
    ['ActionClass', ActionClass.options, ACTION_CLASS_HE],
    ['AutonomyLevel', AutonomyLevel.options, AUTONOMY_LEVEL_HE],
    ['TrustLevel', TrustLevel.options, TRUST_LEVEL_HE],
  ] as const) {
    it(`gives every ${name} a Hebrew label with no Latin letters`, () => {
      for (const option of options) {
        const label = (labels as Record<string, string>)[option];
        expect(label, option).toBeDefined();
        expect(label?.trim().length, option).toBeGreaterThan(0);
        expect(label, option).not.toMatch(LATIN);
      }
    });

    it(`never gives two ${name} members the same label`, () => {
      const values = options.map((o) => (labels as Record<string, string>)[o]);
      expect(new Set(values).size).toBe(values.length);
    });
  }

  it('translates a known value read back from the database', () => {
    expect(actionClassLabel('email.initiate')).toBe(ACTION_CLASS_HE['email.initiate']);
    expect(autonomyLevelLabel('approve_required')).toBe(AUTONOMY_LEVEL_HE.approve_required);
    expect(trustLevelLabel('open_web')).toBe(TRUST_LEVEL_HE.open_web);
  });

  // A stored string the enum no longer knows is shown as it is rather than
  // hidden: an empty cell tells the owner less than an unfamiliar word.
  it('shows an unknown stored value as it is', () => {
    expect(actionClassLabel('legacy.thing')).toBe('legacy.thing');
    expect(autonomyLevelLabel('legacy')).toBe('legacy');
    expect(trustLevelLabel('legacy')).toBe('legacy');
  });

  // Own properties only: `constructor` would otherwise resolve to a function
  // on the prototype (the same trap CLAUDE.md records for TOOL_ACTION_CLASS).
  it('does not resolve a prototype key as a label', () => {
    expect(actionClassLabel('constructor')).toBe('constructor');
    expect(autonomyLevelLabel('toString')).toBe('toString');
    expect(trustLevelLabel('__proto__')).toBe('__proto__');
  });
});
