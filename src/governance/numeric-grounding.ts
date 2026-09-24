/**
 * The cheapest hallucination detector in this codebase, and it costs zero
 * tokens: every number a draft states must trace to a number the
 * deterministic extraction of the source document actually carries. This
 * runs against that extraction — never against what a model said about the
 * document — so it catches a model inventing a figure the source never
 * mentions.
 *
 * **A false positive here does not block a send.** The verdict this feeds
 * appears on the approval card the owner already sees; nothing — not a send,
 * not a job closing — is conditioned on it. But it is not harmless: a
 * control that lights up when nothing happened teaches an owner to click
 * past it, and then it catches nothing when it matters. So the check below
 * is narrowed on purpose, not left maximally paranoid.
 *
 * **Excluded, positively, not by magnitude:** a digit run immediately
 * adjacent to `/`, `-` or `:` in the ORIGINAL text — the shape of a date, a
 * time, a phone number, or a numeric range. A magnitude threshold would have
 * thrown away small real amounts too (`500` looks exactly like a phone
 * fragment by size alone); an adjacency rule does not, and "what character
 * sits next to it" is checkable and explainable in a way "probably not a
 * quantity" is not.
 *
 * **What this does NOT catch, and never will by design:** a number that
 * reaches the draft embedded in a date or a DIGIT-SHAPED identifier is not
 * checked at all — a hallucinated invoice number shaped like `2024-99999`
 * passes silently. (A LETTER-prefixed identifier like `ORDER-12345` is a
 * different, narrower failure — see the known limits below.) Telling "this
 * is an amount" from "this is an id" is exactly the judgement call the
 * adjacency rule refuses to make; it only ever asks what character is
 * touching the digits.
 *
 * **Known limits, left as limits, not bugs to rediscover later:**
 * - European decimal formatting (`11.988,00` meaning eleven thousand, nine
 *   hundred eighty-eight) tokenises into two separate runs — `11.988` read
 *   as a decimal, and `00` — and matches nothing sensible against `11988`.
 *   Low-probability in this market; not worth code today.
 * - Leading zeros are not stripped while trailing decimal zeros are, so
 *   `052` and `52` compare unequal. Same call.
 * - A hyphen preceded by a LETTER, as in an identifier like `ORDER-12345`,
 *   reads as a leading sign on `12345` rather than as separator noise: the
 *   sign/separator rule below only asks whether the character before the
 *   hyphen is a *digit*, not whether the hyphen sits inside an identifier.
 *   Narrowed for Hebrew (fix round 3, item 1; corrected in round 4; a stacked
 *   particle chain restored in round 5 — see `numbersIn`'s own docblock for
 *   all three): a hyphen preceded by a CHAIN of up to three Hebrew PREFIX
 *   PARTICLES (`ל`/`ב`/`מ`/`ה`/`ו`/`כ`/`ש` — `LEADING_HEBREW_PARTICLE`,
 *   `typed-recipients.ts`) that itself sits at a word boundary is a glued-on
 *   prefix, never a sign — `ו-950`, `ב-11,988`, `ל-7.5`, and stacked forms
 *   like `מה-5,000` ("from the") and `כשה-2024` ("when the") are the ordinary
 *   Hebrew way to write these, not negative numbers. A hyphen preceded by any
 *   OTHER letter (`ORDER-12345`), or by a chain of these seven letters that
 *   is ITSELF preceded by a letter (`הנחה-500`, `יתרה-1,200`), still misreads
 *   as a sign. `סה"כ-500` is a recorded exception that still misreads
 *   positive either way. A short word spelled ENTIRELY from these seven
 *   letters (`שלב`, "stage") is mechanically indistinguishable from a genuine
 *   three-deep stack and is now also read as a prefix — a known trade-off,
 *   not an oversight.
 * - Two genuine amounts either side of a slash, as in `שולם 5,000/10,000`,
 *   are both dropped by the `/`-adjacency rule — the same rule that
 *   correctly drops a date. An adjacency rule cannot tell "date" from "two
 *   real numbers separated by a slash" because it never looks past the one
 *   character touching the digits; this is the cost of the narrowing
 *   above, not a bug to fix separately from it.
 */
import { LEADING_HEBREW_PARTICLE } from './typed-recipients.js';

/**
 * How many stacked Hebrew prefix particles `hasHebrewParticlePrefix` peels
 * before requiring a genuine word boundary — see `numbersIn`'s own docblock,
 * fix round 5's item 1, for the corpus this is checked against (a genuine
 * three-deep stack, `כשה`) and the known trade-off it accepts (a short word
 * spelled entirely from these seven letters, `שלב`, is now indistinguishable
 * from one). Not the same value as `contact-resolver.ts`'s own
 * `MAX_PARTICLE_LAYERS` (2) — that cap was chosen for NAME prefixes, whose
 * own docblock states "three does not occur in practice"; it does occur here.
 */
const MAX_LEADING_PARTICLE_LAYERS = 3;

/**
 * Whether `ch` is one of the seven Hebrew prefix particle letters — tested
 * through the shared `LEADING_HEBREW_PARTICLE` itself, with a synthetic dash
 * appended so its own `[-־]` half always matches, rather than a THIRD
 * hand-kept copy of the same seven-letter class alongside that constant and
 * `contact-resolver.ts`'s private `GLUED_PARTICLE`.
 */
function isHebrewParticleLetter(ch: string | undefined): boolean {
  return ch !== undefined && LEADING_HEBREW_PARTICLE.test(`${ch}-`);
}

/**
 * Whether the dash at `dashIndex` is immediately preceded by a chain of one
 * to `MAX_LEADING_PARTICLE_LAYERS` Hebrew prefix particle letters that itself
 * sits at a genuine word boundary (string start, or a non-letter). See
 * `numbersIn`'s own docblock (fix round 5, item 1) for the reasoning, the
 * corpus, and the known trade-off.
 */
function hasHebrewParticlePrefix(text: string, dashIndex: number): boolean {
  let p = dashIndex - 1;
  let layers = 0;
  while (layers < MAX_LEADING_PARTICLE_LAYERS && p >= 0 && isHebrewParticleLetter(text[p])) {
    p -= 1;
    layers += 1;
  }
  if (layers === 0) return false;
  return p < 0 || !/\p{L}/u.test(text[p] as string);
}

/** Digit runs with optional thousands separators and a decimal tail. */
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Strip thousands separators and trailing decimal zeros so `11,988.00` and
 * `11988` compare equal. Comparing raw strings would report every correctly
 * copied amount as a hallucination — the separators and the currency
 * formatting around a number are not part of its value. `raw` never carries
 * a sign; that is applied by the caller, which is the only place that has
 * seen the surrounding text.
 */
function normaliseNumber(raw: string): string {
  let normalised = raw.replace(/,/g, '');
  if (normalised.includes('.')) {
    normalised = normalised.replace(/0+$/, '').replace(/\.$/, '');
  }
  return normalised;
}

/**
 * Every digit run in `text`, normalised, minus the ones adjacent to `/`,
 * `-` or `:` — dates, times, phone numbers and ranges — and with a leading
 * minus sign carried through when it is one.
 *
 * The sign/separator split on `-` is the one place this function has to
 * read two different things off the same character: `-500` and `500-` are
 * both negative amounts (the money this whole check exists for — a draft
 * that turns a credit into a debit must not silently ground; `500-` is the
 * standard Israeli and spreadsheet way of writing a negative balance),
 * while `10-20` and `050-1234567` are a range and a phone number, where
 * the `-` belongs to neither digit run on either side of it — and
 * `100-A`, a model or lot code, is a third shape where the `-` belongs to
 * an identifier and the number must be dropped, not signed.
 *
 * The two sides are checked differently, and that is a real asymmetry, not
 * an oversight: a trailing sign can only be followed by whitespace,
 * punctuation, or the end of the string — nothing glues a letter or a
 * digit to the far side of a genuine trailing minus — so the trailing
 * check treats BOTH a digit and a letter past the dash as proof the `-`
 * belongs to something else and drops the run. The leading check only
 * tests for a digit before the dash; a leading `-` preceded by a letter
 * still misreads as a sign (`ORDER-12345` — the known limit documented
 * above), UNLESS that letter is a Hebrew prefix particle (below) — fixing
 * the general letter case is a separate, symmetric change to the leading
 * side that this round's fix — closing the trailing-side regression only —
 * did not make.
 *
 * **Fix round 3, item 1 — a Hebrew prefix particle glued onto the dash is a
 * PREFIX, never a sign.** `ו-950`, `ב-11,988`, `ל-7.5` are the ordinary
 * Hebrew way to write "and 950", "for 11,988", "to 7.5" — not `-950`,
 * `-11988`, `-7.5`. Before this fix every one of those normalised to a
 * negative number, matched nothing in the source (which carries the
 * unsigned form), and landed on the owner's card as ungrounded on an
 * ordinary business letter — the exact false-positive shape this module's
 * own docblock warns teaches an owner to click past the control, and a far
 * more common trigger than the spreadsheet-JSON regression round 2 closed.
 * `LEADING_HEBREW_PARTICLE` (`typed-recipients.ts`) is the shared,
 * one-definition source for the particle letters — reused here, not
 * duplicated, the same way `contact-resolver.ts` already reuses it.
 *
 * **Fix round 4, item 1 — round 3's version of this rule introduced a false
 * NEGATIVE on money, and is corrected below.** `LEADING_HEBREW_PARTICLE` is
 * `/^[לבמהוכש][-־]/`, and its home callers apply it to a
 * WHITESPACE-SPLIT TOKEN, where `^` means "this word begins with a
 * particle". Round 3 applied it to `text.slice(start - 2, start)` — a
 * two-character window cut from the middle of running text — so `^`
 * anchored to that artificial cut, and what was actually enforced was only
 * "the single character before the dash is one of these seven letters",
 * with no check of what precedes THAT letter. Seven of twenty-two letters
 * include `ה`, the most common word-final letter in Hebrew: `הנחה-500`,
 * `יתרה-1,200`, `עמלה`, `הוצאה`, `הכנסה`, `חובה` and `הלואה` all end in it,
 * and `סה"כ` ends in `כ`. **Correction — round 5, item 2: what round 3's code
 * actually produced for `הנחה-500` was the UNSIGNED `500`, positive, and that
 * MATCHED a source carrying `500`** — a false wording stood here for one
 * round claiming the opposite (`-500`, "matched nothing"), which cannot be
 * true simultaneously with "silently grounded" one sentence later; those are
 * opposite outcomes, and the parenthetical asserting `הנחה-500` means
 * "positive" was itself the ground truth this fix's job is to preserve, not
 * a fact about round 3's (wrong) output. The real defect: `הנחה-500 ש"ח` (a
 * discount of 500, POSITIVE) read as the unsigned `500` and grounded against
 * a source carrying `500` — the credit/debit inversion this module tracks
 * signs specifically to catch passed SILENTLY. Measured (not merely argued)
 * by the reviewer transpiling and running the round-3 code. The claim that
 * stood here — "no check of what precedes the particle is needed... nothing
 * this rule does is worse than what it replaces" — was false in exactly the
 * direction this module cares about, and is removed rather than left to
 * mislead the next reader.
 *
 * **The round-4 fix: the particle itself must not be preceded by a letter**
 * — i.e. it must sit at an actual word start, the same condition `^`
 * enforces for `LEADING_HEBREW_PARTICLE`'s own token-based callers, checked
 * here by hand because there is no isolated token to anchor `^` against.
 *
 * **Fix round 5, item 1 — round 4's single-letter boundary check rejected a
 * STACKED particle, the fourth regression in this rule and the exact mirror
 * of round 4's own bug, in the opposite direction.** Hebrew stacks prefix
 * particles, and this codebase already knows it — `contact-resolver.ts`'s
 * `MAX_PARTICLE_LAYERS = 2` peels `ולדני` as ו + ל + דני. Round 4 looked back
 * exactly ONE letter from the particle adjacent to the dash, so a genuine
 * two- or three-deep stack — `מה-5,000` (מ + ה, "from the 5,000"),
 * `שב-11,988` (ש + ב), `וה-1,200` (ו + ה), `ול-950` (ו + ל), `כשה-2024`
 * (כ + ש + ה) — found a LETTER immediately behind its outermost particle
 * (another particle) and was rejected, exactly as if it were `ORDER-12345`.
 * These constructions ("from the", "and for", "and the", "when the") are
 * considerably more common in ordinary Hebrew business text than a bare word
 * ending in a single particle letter with a glued minus — measured as six
 * flipped pairs, all previously grounding correctly, all reading as a false
 * NEGATIVE (ungrounded) under round 4.
 *
 * **The fix: peel the whole chain of particle letters, up to
 * `MAX_LEADING_PARTICLE_LAYERS`, then require the character before the
 * WHOLE CHAIN to be a non-letter** — `hasHebrewParticlePrefix` below.
 * `contact-resolver.ts` caps its own peel at 2 particle-shaped LETTERS
 * ("three does not occur in practice" — for NAME prefixes); the corpus this
 * rule is checked against includes a genuine three-deep stack (`כשה`), so the
 * cap here is 3, not the same value reused from that unrelated constant.
 *
 * **A stated limit of the cap itself, recorded rather than fixed: a FOUR-deep
 * stack falls back to a sign.** `וכשה-2024` (ו + כ + ש + ה) and `ולכשה-`
 * peel three layers, exhaust `MAX_LEADING_PARTICLE_LAYERS`, and then find a
 * letter — the fourth particle itself — in front of the chain, so
 * `hasHebrewParticlePrefix` returns `false` and the run is signed. The
 * DIRECTION is the part worth writing down: exceeding the cap can only ever
 * ADD a sign (a false ungrounded — the noisy, visible direction), never
 * suppress one. Raising the cap could therefore only trade that noise for
 * more of the `שלב` collision below; it can never silently ground a
 * credit/debit inversion, which is the failure this whole rule exists to
 * avoid.
 *
 * **A known, accepted trade-off this fix introduces:** a short word spelled
 * ENTIRELY from these seven letters is mechanically indistinguishable from a
 * genuine stack of the same length — `שלב` ("stage") is ש + ל + ב, all three
 * particle letters, exactly the shape of the genuine stack `כשה`. No
 * character-level rule can tell them apart without a dictionary. Before this
 * round, `שלב-2` read as the documented sign case `-2` (round 4's single-
 * letter check happened to reject it, for the same reason it wrongly
 * rejected `מה-5,000`); after this round, peeling the full three-letter
 * chain reaches the string boundary the same way `כשה-2024` does, and
 * `שלב-2` now reads as the unsigned `2` too. Accepted because the
 * constructions this fix restores are common and the collision is narrow and
 * rare — the same trade-off calculus `contact-resolver.ts`'s own docblock
 * already makes for its false-match risk on `הרמה`/`רמה`.
 *
 * **One case knowingly NOT covered, recorded rather than fixed:** `סה"כ-500`
 * still reads positive either way. The character before the particle chain's
 * head (`כ`) is `"` (a quotation mark), which is not a letter, so the
 * boundary check passes and the rule fires — `סה"כ` is itself an
 * abbreviation ending in a particle letter, and this rule cannot distinguish
 * "the last letter of a word" from "a genuine prefix particle" any further
 * than "is a letter immediately before the chain". A known limit, not
 * silently swallowed: this sentence is here so the next reader does not have
 * to rediscover it.
 *
 * **The maqaf alternative in `LEADING_HEBREW_PARTICLE` (`[-־]`) is DEAD
 * CODE here.** The branch below only runs when `prevChar === '-'` (an ASCII
 * hyphen) — `LEADING_HEBREW_PARTICLE.test(...)` is reached only on that
 * branch, so its `־` (U+05BE MAQAF) alternative can never be the character
 * that matched. `ו־950`, written with a maqaf instead of a hyphen, is
 * therefore NOT handled by this rule at all. **Correction: an earlier wording
 * here concluded from that it "still reads as `-950`", and that was backwards.**
 * `NUMBER_PATTERN` carries no sign of its own, and `sign` is set ONLY inside
 * the `prevChar === '-'` branch or the trailing `nextChar === '-'` one — a
 * maqaf enters neither — so `ו־950` reads as the UNSIGNED `950`, which is the
 * same answer the rule itself would have produced. What the dead alternative
 * actually costs is the mirror case: a genuine minus written as a maqaf
 * (`־950`) is not read as a sign either. Neither is fixed here — both are
 * recorded so the code does not read as though it covers a case it does not.
 */
function numbersIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const prevChar = start > 0 ? text[start - 1] : undefined;
    const nextChar = end < text.length ? text[end] : undefined;

    // Adjacent to '/' or ':' on either side — a date or a time, never a
    // quantity someone typed as an amount.
    if (prevChar === '/' || prevChar === ':' || nextChar === '/' || nextChar === ':') continue;

    let sign = '';
    if (prevChar === '-') {
      const charBeforeDash = start > 1 ? text[start - 2] : undefined;
      const dashSeparatesTwoRuns = charBeforeDash !== undefined && /\d/.test(charBeforeDash);
      if (dashSeparatesTwoRuns) continue; // e.g. "10-20", "050-1234567" — noise on both sides
      // "ו-950", "מה-5,000" and friends: a chain of one to three glued-on
      // Hebrew prefix particles is not part of the number's own text, so the
      // run stays UNSIGNED — `sign` is simply never set to '-' here. See
      // `numbersIn`'s own docblock (fix round 5, item 1) for why the chain
      // must be peeled rather than checked one letter at a time, the corpus
      // this is checked against, and the known trade-off it accepts.
      const hebrewPrefix = hasHebrewParticlePrefix(text, start - 1);
      if (!hebrewPrefix) sign = '-'; // leading sign, e.g. "-500"
    }
    if (nextChar === '-') {
      const charAfterDash = end + 1 < text.length ? text[end + 1] : undefined;
      // A digit past the dash means a range or a phone number ("1500-2000",
      // "050-1234567"); a LETTER past the dash means an identifier suffix
      // ("100-A", a model or lot code) — a genuine trailing sign is never
      // followed by either, only by whitespace, punctuation, or the end of
      // the string.
      const dashHasTokenAfter = charAfterDash !== undefined && /[\p{L}\p{N}]/u.test(charAfterDash);
      if (dashHasTokenAfter) continue;
      sign = '-'; // trailing sign, e.g. "500-" — the standard Israeli/spreadsheet negative
    }

    tokens.push(sign + normaliseNumber(match[0]));
  }
  return tokens;
}

/**
 * Numbers in `draft` that no entry in `sources` carries, each returned in
 * its normalised form (not the draft's original formatting).
 *
 * An empty `sources` list means nothing was extracted from the document —
 * not that the document carries no numbers. A false positive here still
 * costs trust even though it does not block a send (see the module
 * docblock), and reporting every number as ungrounded when there is nothing
 * to compare against would fire loudest exactly when the check knows least.
 * So an empty source list grounds everything.
 */
export function ungroundedNumbers(draft: string, sources: readonly string[]): string[] {
  if (sources.length === 0) return [];

  const grounded = new Set<string>();
  for (const source of sources) {
    for (const num of numbersIn(source)) grounded.add(num);
  }

  const ungrounded: string[] = [];
  for (const num of numbersIn(draft)) {
    if (!grounded.has(num)) ungrounded.push(num);
  }
  return ungrounded;
}
