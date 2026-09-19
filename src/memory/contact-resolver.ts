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
import { LEADING_HEBREW_PARTICLE } from '../governance/typed-recipients.js';
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
 * Split on anything that is not a letter or a digit, so punctuation cannot
 * hide a token, and emit every spelling of a Hebrew word that may carry a
 * stack of prefix particles.
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
  for (const raw of text.split(/[^\p{L}\p{N}@._-]+/u)) {
    const token = raw.replace(LEADING_HEBREW_PARTICLE, '').trim().toLowerCase();
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
 * Does the text carry something that distinguishes this contact from someone
 * who shares a name part — the company, or the address?
 */
function distinguished(contact: Contact, tokens: Set<string>, text: string): boolean {
  if (contact.email !== null && tokens.has(contact.email)) return true;
  if (contact.company === null) return false;
  // A company is often several words, so it is matched against the text rather
  // than against single tokens — "בטא לוגיסטיקה" is never one token.
  return text.toLowerCase().includes(contact.company.trim().toLowerCase());
}

export function resolveContacts(text: string, contacts: readonly Contact[]): Resolution {
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
        : matched.filter((contact) => distinguished(contact, tokens, text));

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
