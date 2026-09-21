/**
 * From a name in an instruction to the keys that person's memories sit under.
 *
 * Deterministic, and that is the load-bearing choice rather than a preference
 * (spec §3). Whoever lets a model decide who "רונית" is has let it decide who
 * receives an email, eventually — and this codebase refuses that everywhere
 * else: the forget-command reader carries a fixed verb list, the standing
 * authorisation matches the instruction's own bytes, and `EntityRef` was built
 * with no branch that can carry an address.
 *
 * **This does not decide who may be written to** (spec §9). Finding who was
 * meant and being allowed to contact them are different questions, and merging
 * them is how a convenience becomes a bypass.
 */
import {
  LEADING_HEBREW_PARTICLE,
  TRAILING_PUNCTUATION,
} from '../governance/typed-recipients.js';
import type { Contact } from './contacts.js';

export interface Ambiguity {
  /** The name part that fitted more than one person — what the owner wrote. */
  token: string;
  candidates: Contact[];
}

export interface Resolution {
  /** Keys to recall by. Empty when nothing was recognised. */
  subjects: string[];
  /** Non-empty only when the instruction must stop and ask (spec §6). */
  ambiguities: Ambiguity[];
}

/** The particle letters that glue onto a Hebrew word: ל, ב, מ, ה, ו, כ, ש. */
const GLUED_PARTICLE = /^[לבמהוכש]/u;

/** How many stacked particles are peeled. `ולדני` needs two; three does not occur in practice. */
const MAX_PARTICLE_LAYERS = 2;

/**
 * The words of the text, in the order they were written: split on anything
 * that is not a letter or a digit, lowercased, with sentence punctuation
 * taken off the end of each one.
 *
 * The split class deliberately KEEPS `.` (and `@`, `_`, `-`) inside a word so
 * an address survives as one word, and that had a cost: `תשיבי לרונית.`
 * produced `רונית.`, which equals no contact's name, so an ordinary Hebrew
 * sentence resolved nobody — and returned empty subjects and empty
 * ambiguities, the exact shape of "nobody by that name". The failure was
 * indistinguishable from correct behaviour, with nothing in any log. So
 * `TRAILING_PUNCTUATION` — the shared expression `emailAddressesIn` already
 * strips for the same reason — is applied here. It only ever removes
 * characters from the END of a word, so the address form the split class was
 * written to protect is untouched when it ends the word and correctly
 * cleaned when a full stop follows it: `ronit@beta-log.example.` →
 * `ronit@beta-log.example`. Note that `,`, `?` and `!` were never affected —
 * they are split characters already; `.` and `-` are the ones the split
 * class keeps, and they are why this is needed.
 *
 * A LIST, not a set, and that is what `distinguished` needs: a company name
 * is matched as a contiguous run of these words, which requires their order.
 * `tokensOf` builds the match set for names on top of this. The leading
 * particle is stripped there rather than here, because the two readers want
 * different things from it — see `distinguished`.
 */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}@._-]+/u)) {
    const word = raw.replace(TRAILING_PUNCTUATION, '').trim().toLowerCase();
    if (word !== '') words.push(word);
  }
  return words;
}

/**
 * Every spelling of a word in the text that a contact's name could be
 * written as, including the forms that carry a stack of prefix particles.
 *
 * The shared `LEADING_HEBREW_PARTICLE` handles the hyphenated form only
 * (`ל-רונית`) — preflight checked it against the glued form and found
 * `לרונית` passes through untouched, which is the way every owner actually
 * writes it. So the raw token is kept AND, when it begins with a particle
 * letter, each successive remainder is added beside it, peeled one letter at
 * a time up to `MAX_PARTICLE_LAYERS`: Hebrew stacks particles (`ולדני` is
 * ו + ל + דני), and a single strip reaches `לדני` but never the name — a
 * gap this module's own test suite caught (`resolves two different people
 * named in one instruction`), not a case reasoned out in advance. Two layers
 * were chosen as the cap after checking them against `ולדני`, `לרונית`,
 * `הרמה` and `מלכה`: two reaches every stacked form in that set, and each
 * further layer only ever adds more candidate tokens, never removes one.
 *
 * Adding a candidate token can only ever create a match against a contact
 * whose name part equals it exactly, so the residual risk is narrow: a contact
 * named `רמה` would match the word `הרמה`. That feeds memory scope only and
 * never authorisation (spec §9), so the cost of the rare false match is
 * recalling the wrong person's preferences, not writing to the wrong person.
 * The `length < 4` floor on each peel keeps this from ever producing a
 * two-letter fragment, where that false-match risk would stop being rare.
 */
function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of wordsOf(text)) {
    const token = word.replace(LEADING_HEBREW_PARTICLE, '');
    if (token === '') continue;
    out.add(token);

    // Hebrew stacks particles: `ולדני` is ו + ל + דני, and stripping one layer
    // reaches `לדני` but never `דני`. Two layers cover the constructions that
    // actually occur; the cap is deliberate, because every extra layer adds
    // candidate tokens that can only ever match a name equal to one of them.
    let rest = token;
    for (let layer = 0; layer < MAX_PARTICLE_LAYERS; layer += 1) {
      if (!GLUED_PARTICLE.test(rest) || rest.length < 4) break;
      rest = rest.slice(1);
      out.add(rest);
    }
  }
  return out;
}

/**
 * Every distinct way this contact's name may be written: the whole name and
 * each part, de-duplicated.
 *
 * A one-word name makes `full` and its only part the same string. Without
 * de-duplication that contact was pushed into its own bucket in
 * `resolveContacts` twice, `matched.length === 1` came out false, and a
 * single contact was reported as an ambiguity against herself. The dedupe
 * only removes repeats of the *same* contact's own spellings — it never
 * merges two different contacts, so two people who share a one-word name
 * still land in the same bucket as two separate entries and still ask.
 */
function namePartsOf(contact: Contact): string[] {
  const full = contact.name.trim().toLowerCase();
  const parts = full.split(/\s+/).filter((part) => part !== '');
  return [...new Set([full, ...parts])];
}

/**
 * Does `sequence` sit in `words` starting exactly at `start`, compared whole
 * word to whole word?
 *
 * An empty sequence sits anywhere, which is why the one caller that can be
 * handed an empty one — `containsSequence` — refuses it before asking.
 */
function sequenceAt(
  words: readonly string[],
  sequence: readonly string[],
  start: number,
): boolean {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    const wanted = sequence[offset];
    const actual = words[start + offset];
    // A positive comparison: both positions must hold the same string. Two
    // `undefined`s cannot be read as equal, even though every caller's loop
    // bound already means neither can occur.
    if (wanted === undefined || actual === undefined || wanted !== actual) return false;
  }
  return true;
}

/**
 * Is `sequence` a contiguous run of `words`, compared whole word to whole
 * word?
 *
 * An empty sequence matches nothing: "the company name has no words in it"
 * must never read as "every text contains it".
 */
function containsSequence(words: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0) return false;

  for (let start = 0; start + sequence.length <= words.length; start += 1) {
    if (sequenceAt(words, sequence, start)) return true;
  }
  return false;
}

/**
 * Is the company a contiguous run of `words`, allowing ONE Hebrew particle
 * glued onto the first word of that run — and only when the company has two
 * or more words?
 *
 * The exact match comes first and needs no explanation. The peel is what the
 * live run forced: asked "which רונית?", the owner answers
 * `רונית מבטא לוגיסטיקה`, and Hebrew glues the particle onto the FIRST word
 * of a noun phrase, so `מבטא` is simply how `בטא לוגיסטיקה` is written after
 * "from". Three of five measured phrasings failed this way
 * (`רונית מבטא לוגיסטיקה`, `הכוונה לבטא לוגיסטיקה`, `מדלתא דפוס`) — every
 * failure a particle on the first word, and every one of them the ordinary
 * way a person writes the answer.
 *
 * **The two-word floor is the whole safety argument, not a detail.** The
 * words AFTER the peeled one are the anchor: `לוגיסטיקה` and `דפוס` must
 * still match exactly, so the peel can only ever confirm a company the text
 * already almost spells out. A ONE-word company has no anchor at all, and
 * matching it through a peel is precisely the accident an earlier review
 * measured and removed — the company `הרמה` claimed by the ordinary Hebrew
 * word `להרמה` in "צריך להרמה של המשטח", naming the wrong person with no
 * question asked.
 *
 * **The residual cost, stated rather than hidden:** a one-word company that
 * the owner writes with a particle (`מגמא` for the company `גמא`) still does
 * not narrow, and she asks again instead. That is the chosen direction: this
 * module asks when it is unsure everywhere else, and an extra question costs
 * the owner one line of typing, while a confident wrong identity costs them
 * the wrong person's memory with nothing on screen saying so.
 *
 * Exactly one particle letter is peeled, never a stack. `tokensOf` peels up
 * to `MAX_PARTICLE_LAYERS` for names because `ולדני` genuinely occurs; a
 * company name is preceded by one preposition, not two, and each extra layer
 * only widens what can match.
 */
function containsCompany(words: readonly string[], company: readonly string[]): boolean {
  if (containsSequence(words, company)) return true;

  // Positive condition: two or more words, so the words after the peeled one
  // anchor the match. See this function's docblock.
  if (company.length < 2) return false;

  const head = company[0];
  if (head === undefined) return false;
  const tail = company.slice(1);

  for (let start = 0; start + company.length <= words.length; start += 1) {
    const first = words[start];
    if (first === undefined) continue;
    if (!GLUED_PARTICLE.test(first)) continue;
    if (first.slice(1) !== head) continue;
    if (sequenceAt(words, tail, start + 1)) return true;
  }
  return false;
}

/**
 * Does the text carry something that distinguishes this contact from someone
 * who shares a name part — the company, or the address?
 *
 * A company is often several words ("בטא לוגיסטיקה" is never one token), and
 * this used to answer that by asking whether the whole text `includes` the
 * company as a raw substring. Measured, that resolved the wrong person with
 * no question asked: the company `דלתא` matched inside `בדלתאות`, and `הרמה`
 * inside `להרמה של המשטח`. Names match whole-token precisely so that a
 * looser comparison cannot start naming the wrong person, and the tie-break
 * was reintroducing exactly that one field over — with a worse outcome,
 * because narrowing to one candidate replaces a question the owner would
 * have answered with a confident wrong identity.
 *
 * So the company is matched as a **contiguous run of whole words**, which
 * keeps the multi-word case the substring match was there for and drops the
 * "inside a longer word" class outright.
 *
 * The particle peel that `tokensOf` applies to names is still NOT applied
 * wholesale here — `containsCompany` peels one particle off the FIRST word
 * of the run and only when the company has two or more words, so the words
 * after it anchor the match. That is what lets the owner's natural answer
 * (`רונית מבטא לוגיסטיקה`) narrow while `להרמה` still cannot claim the
 * one-word company `הרמה`. The full argument, and the residual cost that
 * remains, are in `containsCompany`'s own docblock.
 */
function distinguished(contact: Contact, tokens: Set<string>, words: readonly string[]): boolean {
  if (contact.email !== null && tokens.has(contact.email)) return true;
  if (contact.company === null) return false;
  return containsCompany(words, wordsOf(contact.company));
}

export function resolveContacts(text: string, contacts: readonly Contact[]): Resolution {
  const words = wordsOf(text);
  const tokens = tokensOf(text);

  // Group by the name part that matched, so "רונית ודני" resolves both while
  // two people called רונית raise one question about one word.
  const byToken = new Map<string, Contact[]>();
  for (const contact of contacts) {
    for (const part of namePartsOf(contact)) {
      if (!tokens.has(part)) continue;
      const bucket = byToken.get(part) ?? [];
      bucket.push(contact);
      byToken.set(part, bucket);
    }
  }

  const subjects = new Set<string>();
  const ambiguities: Ambiguity[] = [];

  for (const [token, matched] of byToken) {
    const chosen =
      matched.length === 1
        ? matched
        : matched.filter((contact) => distinguished(contact, tokens, words));

    if (chosen.length === 1) {
      for (const key of chosen[0]?.subjectKeys ?? []) subjects.add(key);
      continue;
    }

    // Either nothing narrowed it, or the narrowing left several. Both ask.
    // "We could not narrow it down" is never "take the first one".
    ambiguities.push({ token, candidates: matched });
  }

  return { subjects: [...subjects], ambiguities };
}
