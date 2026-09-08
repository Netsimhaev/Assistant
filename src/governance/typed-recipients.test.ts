import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import { TYPED_RECIPIENT_CLASSES, authorisedRecipients } from './typed-recipients.js';

const NO_ONE_KNOWN = { entityIds: [], emailDomains: [], phones: [], tags: [] };

describe('authorisedRecipients', () => {
  it('covers an address the owner typed verbatim', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה dana@example.com את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('does not cover an address the owner never typed', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('matches an address case-insensitively', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-Dana@Example.COM',
        actionClass: 'email.reply',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('matches a phone written with separators against one written without', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לדנה בוואטסאפ 054-123-4567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['0541234567']);
  });

  it('matches a local phone against the same number in international form', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-054-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['+972541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['+972541234567']);
  });

  it('covers a counterparty the charter already knows, even unnamed in the text', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי לספק את ההזמנה',
        actionClass: 'email.initiate',
        candidates: ['orders@supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual(['orders@supplier.co.il']);
  });

  it('covers nobody at all for a class outside the allowlist, however the address arrived', () => {
    // The ruling this test exists for: the class allowlist gates the whole
    // grant, not only the typed half. A purchase from a supplier already on
    // file is exactly the case where one confirmation is worth most.
    for (const known of [NO_ONE_KNOWN, { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] }]) {
      expect(
        authorisedRecipients({
          instruction: 'תזמיני מ-orders@supplier.co.il חמישים יחידות',
          actionClass: 'purchase.place',
          candidates: ['orders@supplier.co.il'],
          known,
        }),
      ).toEqual([]);
    }
  });

  it('returns only the covered subset when a step reaches several people', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-dana@example.com',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com', 'stranger@elsewhere.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('names its allowlist rather than deriving it, and admits no other class', () => {
    // Written out so a class added to the enum tomorrow is excluded by
    // default, and so rewriting this control as "everything except purchase"
    // fails here immediately.
    expect([...TYPED_RECIPIENT_CLASSES]).toEqual([
      'email.reply',
      'email.initiate',
      'whatsapp.reply',
      'whatsapp.initiate',
      'calendar.create',
      'calendar.move',
      'calendar.cancel',
      'doc.deliver',
    ]);

    const admitted = ActionClass.options.filter((cls) =>
      TYPED_RECIPIENT_CLASSES.includes(cls),
    );
    expect(admitted).toEqual([...TYPED_RECIPIENT_CLASSES]);
  });
});
