import { describe, expect, it } from 'vitest';
import { INTENT_MEANING, IntentName, Intent, Reading } from './reading.js';

const SOURCE = { ordinal: 0, locator: null };

function reading(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'חוזה התקשרות עם ספק, תקופת התחייבות שנתיים.',
    findings: [{ label: 'תקופת התחייבות', value: '24 חודשים', sourceRef: SOURCE }],
    intents: [{ intent: 'flag_for_owner', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
    unreadable: [],
    ...overrides,
  };
}

describe('Reading', () => {
  it('accepts a well-formed reading', () => {
    const parsed = Reading.safeParse(reading());
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty intents array, because absence is not a decision', () => {
    const parsed = Reading.safeParse(reading({ intents: [] }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown intent name', () => {
    const parsed = Reading.safeParse(
      reading({ intents: [{ intent: 'wire_the_money', subject: { kind: 'sender' }, sourceRef: SOURCE }] }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects __proto__ as an entityId', () => {
    const parsed = Reading.safeParse(
      reading({
        intents: [
          { intent: 'contact_counterparty', subject: { kind: 'entity', entityId: '__proto__' }, sourceRef: SOURCE },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts an unresolved subject, which describes but does not address', () => {
    const parsed = Intent.safeParse({
      intent: 'contact_counterparty',
      subject: { kind: 'unresolved', describedAs: 'רואה החשבון' },
      sourceRef: SOURCE,
    });
    expect(parsed.success).toBe(true);
  });

  it('has no way to express a raw address in a subject', () => {
    // An address arriving as an entityId is stored as an opaque key, never
    // used as a destination — but the discriminated union has no branch that
    // takes a free-text address at all, and that is the property under test.
    const parsed = Intent.safeParse({
      intent: 'contact_counterparty',
      subject: { kind: 'address', email: 'attacker@example.com' },
      sourceRef: SOURCE,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the intent registry', () => {
  it('explains exactly the intents the enum declares', () => {
    expect(Object.keys(INTENT_MEANING).sort()).toEqual([...IntentName.options].sort());
  });

  it('gives every intent a non-empty Hebrew meaning', () => {
    for (const [name, meaning] of Object.entries(INTENT_MEANING)) {
      expect(meaning.trim(), `${name} has no meaning`).not.toBe('');
    }
  });
});
