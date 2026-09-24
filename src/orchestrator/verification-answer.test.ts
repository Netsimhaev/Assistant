import { describe, expect, it } from 'vitest';
import { composeVerificationAnswer } from './verification-answer.js';
import type { Reading } from '../domain/reading.js';

function reading(over: Partial<Reading> = {}): Reading {
  return {
    summary: 'הספק מבקש אישור להצעת מחיר ומבקש תשובה עד יום חמישי.',
    findings: [
      { label: 'תווית-שלא-אמורה-להגיע', value: 'ערך-בדיקה', sourceRef: { ordinal: 0, locator: null } },
    ],
    intents: [
      {
        intent: 'reply_to_sender',
        subject: { kind: 'sender' },
        sourceRef: { ordinal: 0, locator: 'נא אישורכם' },
        note: 'הערה-שלא-אמורה-להגיע',
      },
    ],
    unreadable: [],
    ...over,
  };
}

describe('composeVerificationAnswer', () => {
  it('carries the summary and the inferred intent names, and nothing else', () => {
    const answer = composeVerificationAnswer(reading());
    expect(answer).toContain('הספק מבקש אישור להצעת מחיר');
    expect(answer).toContain('reply_to_sender');
    // The locator, the note, and the finding label are document-derived or
    // model-authored free text and add nothing the summary does not already
    // carry; none of them may travel.
    expect(answer).not.toContain('נא אישורכם');
    expect(answer).not.toContain('הערה-שלא-אמורה-להגיע');
    expect(answer).not.toContain('תווית-שלא-אמורה-להגיע');
  });

  it('is deterministic: the same reading with intents in a different order composes identically', () => {
    const a = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'pay_or_purchase', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
        ],
      }),
    );
    const b = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
          { intent: 'pay_or_purchase', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it('lists a repeated intent once', () => {
    const answer = composeVerificationAnswer(
      reading({
        intents: [
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' },
          { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 1, locator: null }, note: '' },
        ],
      }),
    );
    expect(answer.match(/reply_to_sender/g)).toHaveLength(1);
  });

  it('does not truncate — the single cap lives in verifyDraft, which records it', () => {
    const long = 'א'.repeat(9000);
    expect(composeVerificationAnswer(reading({ summary: long }))).toContain(long);
  });
});
