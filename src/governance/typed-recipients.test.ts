import { describe, expect, it } from 'vitest';
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
    // fails here immediately. This one assertion is what does the work: it
    // pins the full, exact membership of the allowlist. (A second assertion
    // used to sit here re-deriving the list from `ActionClass.options` and
    // comparing it back — but `.filter` preserves the enum's own order, not
    // the allowlist's declared order, so that assertion was really pinning
    // list ORDER against the enum, not "admits no other class" as its
    // comment claimed. Content is already fully covered by the array
    // equality above; TypeScript's `readonly ActionClass[]` annotation is
    // what already guarantees every entry here is a real enum member.)
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
  });

  it('covers a known phone number even with nothing typed about it', () => {
    expect(
      authorisedRecipients({
        instruction: 'תזכירי לי מחר בבוקר',
        actionClass: 'whatsapp.initiate',
        candidates: ['0501234567'],
        known: { ...NO_ONE_KNOWN, phones: ['0501234567'] },
      }),
    ).toEqual(['0501234567']);
  });

  it('covers a known entity id even with nothing typed about it', () => {
    expect(
      authorisedRecipients({
        instruction: 'תזכירי לי מחר בבוקר',
        actionClass: 'email.initiate',
        candidates: ['cust-42'],
        known: { ...NO_ONE_KNOWN, entityIds: ['cust-42'] },
      }),
    ).toEqual(['cust-42']);
  });

  it('rejects a lookalike domain against a known one', () => {
    // Pins the ruling half of C2 that the passing suite never exercised:
    // delete the domain-matching branch entirely and every prior test still
    // stays green, because none of them ever supplied a candidate whose
    // domain should have been rejected.
    expect(
      authorisedRecipients({
        instruction: 'תשלחי הצעה',
        actionClass: 'email.initiate',
        candidates: ['orders@evil-supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual([]);
  });

  it('rejects a subdomain of a known domain, not only a lookalike', () => {
    // The other half of C2's ruling: `knownCounterparties` compares by exact
    // equality, never `domainMatches`'s label-boundary subdomain rule. A
    // charter entry for `supplier.co.il` does not vouch for
    // `mail.supplier.co.il` — that domain could belong to a mail platform
    // hosting mail for every one of its customers at once.
    expect(
      authorisedRecipients({
        instruction: 'תשלחי הצעה',
        actionClass: 'email.initiate',
        candidates: ['orders@mail.supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual([]);
  });

  it('covers a calendar recipient typed verbatim', () => {
    expect(
      authorisedRecipients({
        instruction: 'תקבעי פגישה עם dana@example.com',
        actionClass: 'calendar.create',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('covers a doc.deliver recipient typed verbatim', () => {
    expect(
      authorisedRecipients({
        instruction: 'תשלחי את המסמך ל-dana@example.com',
        actionClass: 'doc.deliver',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('does not authorise an address that is merely a prefix of the one typed', () => {
    // C1: the owner typed the full `dana@example.co.il`; an injected plan
    // step names the shorter `dana@example.co`, a domain an attacker can
    // register outright. A substring search cannot tell these apart; exact
    // comparison against the fully-extracted address can.
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל-dana@example.co.il',
        actionClass: 'email.initiate',
        candidates: ['dana@example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a local-part that is merely a suffix of the one typed', () => {
    // Same ruling, the other axis: the instruction says `noreply@example.com`;
    // a plan step proposes `reply@example.com`. `noreply` contains `reply` as
    // a substring, but the owner never typed that address.
    expect(
      authorisedRecipients({
        instruction: 'אל תשיבי — זה noreply@example.com',
        actionClass: 'email.initiate',
        candidates: ['reply@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a phone number synthesised from unrelated digit groups', () => {
    // I1: several unrelated numbers, space-separated in pasted text, must
    // not concatenate into one run whose last nine digits happen to equal a
    // real phone number's. No phone number appears in this instruction at
    // all.
    expect(
      authorisedRecipients({
        instruction: 'הזמנות: 100 200 521 234 567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a short numeric candidate via the text path', () => {
    // C1's numeric row: a candidate too short to be a phone number must be
    // rejected on length alone, never authorised because it also happens to
    // appear as a substring of some unrelated longer number in the text.
    expect(
      authorisedRecipients({
        instruction: 'לפי הזמנה מספר 12345',
        actionClass: 'whatsapp.initiate',
        candidates: ['12345'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });
});
