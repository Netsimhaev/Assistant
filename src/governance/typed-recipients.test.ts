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
        instruction: 'תשלחי אל Dana@Example.COM',
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
        instruction: 'תשלחי אל dana@example.com',
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
    // A sanity check on exact equality, not itself what distinguishes it
    // from the forbidden `domainMatches`: that function is anchored on the
    // label boundary too, so it already rejects 'evil-supplier.co.il'
    // against 'supplier.co.il' for the same reason this assertion holds --
    // the character before 'supplier' is '-', never '.'. The test that
    // actually tells exact equality apart from `domainMatches` is the one
    // below ('rejects a subdomain...'), confirmed by mutation in fix round
    // 1: restoring `domainMatches`'s subdomain rule fails only that test.
    // (A version of this comment once claimed deleting the domain-matching
    // branch entirely would leave every prior test green. That was false --
    // it fails 'covers a counterparty the charter already knows, even
    // unnamed in the text' above, which needs this branch to return `true`
    // for exactly this reason.)
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
        instruction: 'תשלחי את המסמך אל dana@example.com',
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

  it('does not authorise a domain glued to a footnote or order number', () => {
    // N1: fix round 1's own \b-anchored regex backtracked on its trailing
    // boundary and produced exactly the C1 failure mode again -- typing
    // `billing@acme.co.il2024` (a real address with a year glued straight
    // onto the TLD, the paste case spec §6 admits) let the regex settle for
    // a match ending at `billing@acme.co`, because a `.` two characters
    // early already satisfied `\b`. Whole-token comparison has no shorter
    // match to settle for: the token either equals the candidate in full or
    // it does not.
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל billing@acme.co.il2024',
        actionClass: 'email.initiate',
        candidates: ['billing@acme.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a domain glued to a trailing underscore-suffixed word', () => {
    // N1's second row: the same backtracking truncation, one character
    // class over -- `dana@example.co.il_new` must not authorise
    // `dana@example.co`, and `dana@sub.example.co.il_` must not authorise
    // `dana@sub.example.co`.
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל dana@example.co.il_new',
        actionClass: 'email.initiate',
        candidates: ['dana@example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
    expect(
      authorisedRecipients({
        instruction: 'תשלחי ל dana@sub.example.co.il_',
        actionClass: 'email.initiate',
        candidates: ['dana@sub.example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a phone number spliced together with dashes', () => {
    // N2's first row: a different separator than the space fix round 1
    // guarded against. `100-521-234-567` is three unrelated numbers, not
    // one -- and it does not start with `0` or `972`, which is what
    // actually excludes it.
    expect(
      authorisedRecipients({
        instruction: 'הזמנה 100-521-234-567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a phone number spliced together with dots', () => {
    // N2's second row.
    expect(
      authorisedRecipients({
        instruction: 'לפי חשבונית 1.521.234.567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a company-registration number sharing a phone number\'s digits', () => {
    // N2's third row: a single, unspliced number with no recognisable phone
    // prefix at all -- `ח.פ.` (company id) is not a phone number's
    // introduction, and `521234567` alone does not start with `0` or `972`.
    expect(
      authorisedRecipients({
        instruction: 'ח.פ. 521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a phone-prefixed run of the wrong overall length', () => {
    // Isolates looksLikePhoneNumber's significant-length clause: this run
    // does start with `0` (the recognised prefix), and its last nine digits
    // are the candidate's, but eleven digits remain after stripping the
    // leading zero -- too many to be a real subscriber number. If this
    // clause were stubbed to always pass, the shared last-nine digits alone
    // would authorise the candidate.
    expect(
      authorisedRecipients({
        instruction: 'מספר לקוח 000521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a phone number bridging more than two separator groups', () => {
    // Isolates looksLikePhoneNumber's separator-group clause on its own:
    // this run has a valid prefix (`0`) and a valid significant length
    // (nine digits), so only the excess of separators -- nine single
    // dashes, not "one glued token, or split by an area code" -- can be
    // rejecting it. If this clause were stubbed to always pass, the digits
    // alone would authorise the candidate.
    expect(
      authorisedRecipients({
        instruction: 'לתשלום 0-5-2-1-2-3-4-5-6-7',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });
});
