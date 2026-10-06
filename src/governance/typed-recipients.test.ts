import { describe, expect, it } from 'vitest';
import {
  TYPED_RECIPIENT_CLASSES,
  authorisedRecipients,
  recipientsOnlyInRecording,
} from './typed-recipients.js';

const NO_ONE_KNOWN = { entityIds: [], emailDomains: [], phones: [], tags: [] };

describe('authorisedRecipients', () => {
  it('covers an address the owner typed verbatim', () => {
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
          textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
        instruction: 'הזמנות: 100 200 521 234 567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a short numeric candidate via the text path', () => {
    // C1's numeric row: a numeric candidate must be judged as a phone
    // number, never authorised because it also happens to appear as a
    // substring of some unrelated number in the text. (What rejects `12345`
    // today is the prefix rule, not a length floor -- it starts with `1`,
    // so it names no phone number at all. An earlier version of this
    // comment said "rejected on length alone", which was true of round 1's
    // nine-digit floor and is not true of the rule that replaced it.)
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
        instruction: 'תשלחי ל dana@example.co.il_new',
        actionClass: 'email.initiate',
        candidates: ['dana@example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי ל dana@sub.example.co.il_',
        actionClass: 'email.initiate',
        candidates: ['dana@sub.example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('strips a leading Hebrew particle glued to the address, then still requires the whole remainder', () => {
    // Round 3: `ל-dana@example.com` (no space) is not an edge case, it is
    // how "to Dana" is ordinarily written in Hebrew. The owner should not
    // have to phrase around their own language's grammar to have a typed
    // address recognised.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי ל-dana@example.com',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('does not authorise a shorter domain via a particle-glued address with a footnote', () => {
    // Pins the interaction between the two rules rather than assuming it:
    // stripping the leading `ל-` particle is not a licence to also drop
    // whatever glued suffix follows the domain. `ל-dana@example.co.il2`
    // strips to `dana@example.co.il2` -- one token, tested whole -- and
    // exact equality is what rejects it. `EMAIL_SHAPE` is deliberately
    // loose (its domain half accepts a trailing digit, mirroring
    // `mail.ts`), so the stripped token PASSES the shape test here; "not
    // shaped like an address" is not a live possibility for this input and
    // an earlier version of this comment was wrong to hedge that it was.
    // The source docblock in typed-recipients.ts already says this
    // correctly.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי ל-dana@example.co.il2',
        actionClass: 'email.initiate',
        candidates: ['dana@example.co'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('strips exactly the seven named particles and no other Hebrew letter', () => {
    // Pinned the way `TYPED_RECIPIENT_CLASSES` is pinned: both sides
    // enumerated, so a mutation that widens the character class is caught
    // wherever it widens. Sampling one rejected letter (this test used to
    // try only `נ`) survives any mutation that adds a different letter.
    //
    // Accepted: ל ב מ ה ו כ ש (to / in / from / the / and / as / that).
    // Rejected: every other letter of the alphabet. Both lists are written
    // out rather than derived from the pattern, so the pattern cannot
    // define its own test.
    const particles = ['ל', 'ב', 'מ', 'ה', 'ו', 'כ', 'ש'];
    const notParticles = [
      'א', 'ג', 'ד', 'ז', 'ח', 'ט', 'י', 'נ',
      'ס', 'ע', 'פ', 'צ', 'ק', 'ר', 'ת',
    ];
    const ask = (instruction: string): string[] =>
      authorisedRecipients({
        textOrigin: 'typed',
        instruction,
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      });

    for (const letter of particles) {
      // Both join marks: ASCII hyphen-minus and the Hebrew maqaf (U+05BE).
      expect(ask(`תשלחי ${letter}-dana@example.com`)).toEqual(['dana@example.com']);
      expect(ask(`תשלחי ${letter}־dana@example.com`)).toEqual(['dana@example.com']);
    }
    for (const letter of notParticles) {
      expect(ask(`תשלחי ${letter}-dana@example.com`)).toEqual([]);
      expect(ask(`תשלחי ${letter}־dana@example.com`)).toEqual([]);
    }
    // A particle needs its join mark: glued straight onto the address with
    // no hyphen or maqaf, nothing is stripped and the token does not match.
    for (const letter of particles) {
      expect(ask(`תשלחי ${letter}dana@example.com`)).toEqual([]);
    }
  });

  it('does not authorise a phone number spliced together with dashes', () => {
    // N2's first row: a different separator than the space fix round 1
    // guarded against. `100-521-234-567` is three unrelated numbers, not
    // one -- and it does not start with `0` or `972`, which is what
    // actually excludes it.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
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
        textOrigin: 'typed',
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
        textOrigin: 'typed',
        instruction: 'ח.פ. 521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('anchors the key to the prefix rather than slicing it off the tail', () => {
    // The core of R1. This run starts with the recognised `0` prefix and
    // ENDS with the candidate's nine digits, which is precisely what the
    // old last-nine key looked at. Anchoring to the prefix instead makes
    // the run's key `00521234567` -- everything after the leading zero --
    // which is not the candidate's `521234567`, so the two do not compare
    // equal. (This test does NOT isolate the 8-or-9 length rule: with that
    // rule removed the two keys still differ and the rejection still
    // stands. The test below isolates it.)
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'מספר לקוח 000521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not authorise a digit string of no phone number length, even typed verbatim', () => {
    // Isolates the 8-or-9 rule, which needs BOTH sides to be the same
    // string to be the only thing deciding: candidate and instruction carry
    // an identical twelve-digit figure behind a `0`, so the keys would be
    // equal and the candidate authorised if the length rule were dropped.
    // Eleven digits after the prefix is neither a mobile nor a landline, so
    // this figure names no phone number and authorises nobody -- a customer
    // number the owner typed is still not a recipient.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'מספר לקוח 000521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['000521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('authorises an Israeli landline typed in local form', () => {
    // R2: `03-1234567` is a real Tel Aviv landline and has EIGHT significant
    // digits after the leading `0`, not nine. The round-2 rule demanded nine
    // or ten and so refused every landline in the country -- a false
    // negative that makes the feature useless to the owner it is for.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תתקשרי ל-03-1234567 ותאשרי את הפגישה',
        actionClass: 'whatsapp.initiate',
        candidates: ['031234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['031234567']);
  });

  it('gives one landline the same key in local and international form', () => {
    // R2, the other half: prefix-anchoring is what makes `03-1234567` and
    // `+972-3-1234567` reduce to the same eight significant digits
    // (`31234567`). The old last-nine rule sliced `031234567` off one and
    // `231234567` off the other, so a landline never matched its own
    // international spelling.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תתקשרי ל-03-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['+972-3-1234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['+972-3-1234567']);
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תתקשרי ל-+972-3-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['031234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['031234567']);
  });

  it('authorises a mobile written with a country code and three separator groups', () => {
    // R2: `+972-54-123-4567` and `+972 54 123 4567` are both ordinary ways
    // to write a mobile, and both carry three separator groups -- refused
    // outright by round 2's `<= 2` cap. The cap is gone; prefix-anchoring
    // plus the 8-or-9 rule bounds the run instead.
    for (const instruction of [
      'תשלחי הודעה ל-+972-54-123-4567',
      'תשלחי הודעה ל-+972 54 123 4567',
    ]) {
      expect(
        authorisedRecipients({
          textOrigin: 'typed',
          instruction,
          actionClass: 'whatsapp.initiate',
          candidates: ['0541234567'],
          known: NO_ONE_KNOWN,
        }),
      ).toEqual(['0541234567']);
    }
  });

  it('authorises a number written with a country code and a trunk zero', () => {
    // Round 5, A: `+972 054-123-4567` is a very common way to write the
    // number -- the trunk zero of the local form left in place after the
    // country code. Counting it as significant makes ten digits and the
    // 8-or-9 rule refuses the whole number.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי הודעה ל-+972 054-123-4567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['0541234567']);
  });

  it('gives one landline the same key with and without a trunk zero after the country code', () => {
    // Round 5, A's second symptom: without stripping the trunk zero,
    // `+972-0-3-1234567` keys to `031234567` while `03-1234567` keys to
    // `31234567`, so two spellings of one landline stop matching each
    // other -- the exact failure prefix-anchoring was introduced to fix,
    // one digit further left. Both directions asserted.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תתקשרי ל-+972-0-3-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['03-1234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['03-1234567']);
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תתקשרי ל-03-1234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['+972-0-3-1234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['+972-0-3-1234567']);
  });

  it('bridges a non-breaking space inside a number', () => {
    // Round 5, B: a number copied out of a web page or a Word document
    // carries U+00A0 between its groups, not U+0020. Bridging U+0020 alone
    // split `054 123 4567` into three runs and refused a number the owner
    // did type. The tab-and-newline test below stays closed either way --
    // those are cell and line boundaries, never separators inside one
    // number -- so exactly two space characters bridge and no more.
    //
    // The non-breaking spaces are written as `\u00A0` escapes on purpose: a
    // literal U+00A0 in source is invisible, and an editor normalising it
    // to a plain space would quietly turn this into a duplicate of the
    // spaced-groups test above -- still green, testing nothing.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי הודעה ל-054\u00A0123\u00A04567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['0541234567']);
  });

  it('does not authorise a number whose significant digits are one too many', () => {
    // R1: `יתרה 00 521234567` is a balance figure and a reference number,
    // not a phone number. Under the old rule the run's LAST NINE digits
    // were the key, so the unrelated leading `0` fell off the front and the
    // splice matched. The key is now anchored to the prefix: the digits
    // after the leading `0` are `0521234567`, ten of them, which is not a
    // subscriber number and does not equal the candidate's `521234567`.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'יתרה 00 521234567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0521234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('does not bridge a tab or a newline into one phone number', () => {
    // R1's pasted-table row: two columns of a spreadsheet -- a company-id
    // label, a `0`, and a reference number -- must not be read as one
    // number because the whitespace between the cells happens to match
    // `\s`. A phone number is written with plain spaces, never across a
    // line break or a tab stop, so the run only bridges U+0020.
    for (const instruction of ['ח.פ.\t0\t521234567', 'ח.פ.\n0\n521234567']) {
      expect(
        authorisedRecipients({
          textOrigin: 'typed',
          instruction,
          actionClass: 'whatsapp.initiate',
          candidates: ['0521234567'],
          known: NO_ONE_KNOWN,
        }),
      ).toEqual([]);
    }
  });

  it('records the residual: separators between a prefix and the digits still authorise', () => {
    // NOT a desired behaviour -- a recorded gap, so nobody reads the tests
    // above as proof the splice class is closed. Every string here reduces,
    // once non-digits are stripped, to exactly `0521234567` or its
    // international spelling. No rule that also has to accept
    // `054-123-4567` and `+972 54 123 4567` can tell them apart, because
    // after separator-stripping they are the same digits. What the module
    // now guarantees is narrower and honest: the instruction must contain
    // the target number's own digits behind a recognised prefix. (Round 5
    // widened this by one spelling: the trunk-zero strip after `972` means
    // `972 0521234567` reduces here too, where it used to be one digit too
    // long. Same class, same reason -- those digits are the number.) If a later
    // round narrows this further, this test is the one to update -- and
    // deleting it without narrowing anything hides the gap again.
    for (const instruction of [
      'סעיף 0-521234567',
      'שורה 0 521234567 בקובץ',
      'פריט (0) 521234567',
      'קוד 972 521234567',
      'קוד 972 0521234567',
      'פריט 05 21234567',
      'לתשלום 0-5-2-1-2-3-4-5-6-7',
    ]) {
      expect(
        authorisedRecipients({
          textOrigin: 'typed',
          instruction,
          actionClass: 'whatsapp.initiate',
          candidates: ['0521234567'],
          known: NO_ONE_KNOWN,
        }),
      ).toEqual(['0521234567']);
    }
  });

  it('does not authorise a candidate that is neither an address nor a phone number', () => {
    // R3: `EMAIL_SHAPE` is the only thing standing between a candidate that
    // merely APPEARS in the owner's text and authorisation. `candidates`
    // carries entity ids (see the known-entity-id test above), so without
    // the whole-token shape test, `cust-42` would be authorised purely
    // because those seven characters occur in the instruction -- including
    // when the instruction is quoting text somebody else wrote. Remove the
    // `EMAIL_SHAPE` filter from `emailAddressesIn` and this test fails; no
    // other test in this file does.
    expect(
      authorisedRecipients({
        textOrigin: 'typed',
        instruction: 'תשלחי הצעה ללקוח cust-42 לפי מה שסיכמנו',
        actionClass: 'email.initiate',
        candidates: ['cust-42'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  // A test named 'does not authorise a phone number bridging more than two
  // separator groups' used to sit here, pinning round 2's `<= 2` cap on
  // `0-5-2-1-2-3-4-5-6-7`. The cap is gone -- it refused
  // `+972-54-123-4567` and `+972 54 123 4567`, both ordinary spellings of a
  // mobile (see the test for them above) -- so its string moved into
  // 'records the residual: ...', where it is now correctly recorded as
  // authorised rather than silently dropped.
});

/**
 * The origin rule (owner's decision 2, 05/10/2026).
 *
 * A voice note's text is produced by a third-party transcription provider's
 * model. Nobody typed it, and the verbatim arm's whole claim is "the owner
 * typed this address himself" — so a mistranscription, or a compromised
 * provider, could otherwise name a recipient and buy them a standing
 * authorisation with no approval card. Authority is never derivable from
 * content; a transcript is content.
 *
 * Both directions are pinned here, because over-tightening is a real failure
 * too: the owner's rule is that a clear transcript authorises the ACTION, and
 * only an address, name or number appearing **only in a recording** needs his
 * explicit word.
 */
describe('authorisedRecipients and where the instruction came from', () => {
  const SPOKEN = 'תשלחי ל-dana@example.com את ההצעה';

  it('does not authorise an address that appears only in a transcript', () => {
    // The same instruction, the same class, the same candidate as the very
    // first test in this file — which authorises it. The ONLY difference is
    // the origin, so this pair is the whole control: drop the origin check
    // from `authorisedRecipients` and this test goes red while that one
    // stays green.
    expect(
      authorisedRecipients({
        textOrigin: 'transcribed',
        instruction: SPOKEN,
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('still authorises a counterparty the charter knows, however the instruction arrived', () => {
    // The charter arm survives a recording on purpose: that authority comes
    // from the owner's signature on the charter, not from what he typed
    // today. Gate the whole filter on the origin instead of just the
    // verbatim arm and this goes red — over-tightening is caught here, not
    // only under-tightening.
    expect(
      authorisedRecipients({
        textOrigin: 'transcribed',
        instruction: 'תשלחי לספק את ההזמנה',
        actionClass: 'email.initiate',
        candidates: ['orders@supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual(['orders@supplier.co.il']);
  });

  it('does not authorise a phone number that appears only in a transcript', () => {
    // The phone pathway is a separate branch of `appearsVerbatimIn` with its
    // own prefix-anchored key, so it needs its own control: a fix applied to
    // the address arm alone would leave the number arm open, and a WhatsApp
    // step's recipient is a number.
    expect(
      authorisedRecipients({
        textOrigin: 'transcribed',
        instruction: 'תשלחי לה וואטסאפ ל-054-123-4567',
        actionClass: 'whatsapp.initiate',
        candidates: ['0541234567'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });
});

/**
 * `recipientsOnlyInRecording` — the counterfactual the owner's sentence is
 * built from: who typing WOULD have authorised, and did not, because of the
 * recording specifically.
 *
 * It exists so the note can be TRUE. A note that fires when nothing was
 * withheld, or that blames the recording for something another rule stopped,
 * is how a real notice stops being read.
 */
describe('recipientsOnlyInRecording', () => {
  it('names the address a recording withheld', () => {
    expect(
      recipientsOnlyInRecording({
        textOrigin: 'transcribed',
        instruction: 'תשלחי ל-dana@example.com את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual(['dana@example.com']);
  });

  it('names nobody for a typed instruction, because nothing was withheld', () => {
    expect(
      recipientsOnlyInRecording({
        textOrigin: 'typed',
        instruction: 'תשלחי ל-dana@example.com את ההצעה',
        actionClass: 'email.initiate',
        candidates: ['dana@example.com'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  it('names nobody the charter already knows, because they were authorised anyway', () => {
    expect(
      recipientsOnlyInRecording({
        textOrigin: 'transcribed',
        instruction: 'תשלחי ל-orders@supplier.co.il את ההזמנה',
        actionClass: 'email.initiate',
        candidates: ['orders@supplier.co.il'],
        known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
      }),
    ).toEqual([]);
  });

  it('names nobody for a class an instruction could never authorise anyway', () => {
    // `purchase.place` is outside `TYPED_RECIPIENT_CLASSES`, so typing the
    // address would not have authorised it either. Naming the recording as
    // the reason would be a lie about which rule stopped it — the owner
    // would go looking for a transcription problem that is not there.
    expect(
      recipientsOnlyInRecording({
        textOrigin: 'transcribed',
        instruction: 'תזמיני מ-orders@supplier.co.il חמישים יחידות',
        actionClass: 'purchase.place',
        candidates: ['orders@supplier.co.il'],
        known: NO_ONE_KNOWN,
      }),
    ).toEqual([]);
  });

  /**
   * The relationship between the two exported functions, asserted directly
   * rather than left to two sets of examples that could drift apart: what a
   * recording withholds is exactly what typing would have added. Both
   * functions read the same two private predicates, and this is what fails
   * if one of them grows a rule the other does not have.
   */
  it('is exactly what typing would have added, for every candidate', () => {
    const shared = {
      instruction: 'תשלחי ל-dana@example.com ול-orders@supplier.co.il ול-054-123-4567',
      actionClass: 'email.initiate' as const,
      candidates: ['dana@example.com', 'orders@supplier.co.il', 'stranger@elsewhere.com'],
      known: { ...NO_ONE_KNOWN, emailDomains: ['supplier.co.il'] },
    };

    const typed = authorisedRecipients({ ...shared, textOrigin: 'typed' });
    const spoken = authorisedRecipients({ ...shared, textOrigin: 'transcribed' });
    const withheld = recipientsOnlyInRecording({ ...shared, textOrigin: 'transcribed' });

    expect(withheld).toEqual(typed.filter((recipient) => !spoken.includes(recipient)));
    // And the example is not a degenerate one: typing really did authorise
    // more than the recording did, so the assertion above is comparing two
    // different sets rather than two empty ones.
    expect(typed).toEqual(['dana@example.com', 'orders@supplier.co.il']);
    expect(spoken).toEqual(['orders@supplier.co.il']);
    expect(withheld).toEqual(['dana@example.com']);
  });
});
