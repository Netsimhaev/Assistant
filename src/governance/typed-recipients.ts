/**
 * Which of a step's recipients an instruction is allowed to authorise.
 *
 * The owner's emphasis is that an instruction is its own approval. The danger
 * is that the recipients in a plan come from a model reading the owner's text:
 * paste a supplier's mail containing an address, add "handle this", and that
 * address would be in the plan. Granting whatever the plan names would let a
 * paste buy authority.
 *
 * Two positive sources, and nothing else:
 *
 *   1. the charter already knows the counterparty, or
 *   2. the owner typed the address or number verbatim in the instruction.
 *
 * The second is the owner's own rule, and it is the right distinction: it
 * separates *the model inferred a destination* from *the boss named one*.
 * Spec §6 records what it does not protect against — it sees that an address
 * is in the text, not who put it there — and the class allowlist below is the
 * hedge the owner chose alongside it.
 */
import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle } from '../domain/policy.js';

/**
 * The classes where a recipient can be authorised by an instruction at all.
 *
 * Named individually, never derived. A class added to the enum tomorrow is
 * excluded until someone puts it here on purpose, and rewriting this as
 * "everything except a purchase" would fail the invariant test that pins it.
 *
 * What is deliberately absent: `purchase.place`, `commitment.make`,
 * `quote.issue` and `discount.grant` — the four where a mistake costs most —
 * plus every class the code never automates regardless.
 *
 * **This gates the whole grant, not only the typed half.** A supplier already
 * on file is exactly who a purchase would go to, so exempting known
 * counterparties here would defeat the restriction at the only moment it
 * matters.
 */
export const TYPED_RECIPIENT_CLASSES: readonly ActionClass[] = [
  'email.reply',
  'email.initiate',
  'whatsapp.reply',
  'whatsapp.initiate',
  'calendar.create',
  'calendar.move',
  'calendar.cancel',
  'doc.deliver',
];

/** Digits only, and the last nine of them. */
function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  // Nine is the length of an Israeli subscriber number without its leading
  // zero, which is what survives both `054-123-4567` and `+972541234567`.
  // Shorter than that is not a phone number, and comparing it would match
  // half the digits in the instruction by accident.
  return digits.length < 9 ? null : digits.slice(-9);
}

function typedInInstruction(candidate: string, instruction: string): boolean {
  const haystack = instruction.toLowerCase();
  if (haystack.includes(candidate.toLowerCase())) return true;

  const wanted = phoneKey(candidate);
  if (wanted === null) return false;

  // Every run of digits and separators in the instruction, compared by the
  // same key. A textual search would miss `054-123-4567` against `0541234567`.
  const runs = instruction.match(/[+\d][\d\s().-]{6,}/g) ?? [];
  return runs.some((run) => phoneKey(run) === wanted);
}

function knownToCharter(
  candidate: string,
  known: PolicyBundle['knownCounterparties'],
): boolean {
  const lower = candidate.toLowerCase();

  const at = lower.lastIndexOf('@');
  if (at !== -1) {
    const domain = lower.slice(at + 1);
    // Anchored on the label boundary, so `evil-supplier.co.il` does not match
    // a known `supplier.co.il`.
    if (
      known.emailDomains.some(
        (d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`),
      )
    ) {
      return true;
    }
  }

  const wanted = phoneKey(candidate);
  if (wanted !== null && known.phones.some((p) => phoneKey(p) === wanted)) return true;

  return known.entityIds.some((id) => id.toLowerCase() === lower);
}

export function authorisedRecipients(input: {
  instruction: string;
  actionClass: ActionClass;
  candidates: string[];
  known: PolicyBundle['knownCounterparties'];
}): string[] {
  if (!TYPED_RECIPIENT_CLASSES.includes(input.actionClass)) return [];

  return input.candidates.filter(
    (candidate) =>
      knownToCharter(candidate, input.known) ||
      typedInInstruction(candidate, input.instruction),
  );
}
