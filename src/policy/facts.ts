import type { DataClass } from '../domain/charter.js';
import type { ActionFacts } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { extractAddressCandidate } from '../util/address.js';
import { canonicalHash } from '../util/canonical.js';
import { classifyAction, isOutbound, refineActionClass } from './classify.js';

export interface FactsContext {
  /** Lowest trust in the job's causal chain, stamped by the gateway. */
  provenance: TrustLevel;
  chainDepth: number;
  /**
   * Tags carried by the resolved counterparty, used by narrowed rules.
   *
   * Required, and deliberately not defaulted. Every caller omitted it while it
   * was optional, so it was permanently `[]` — which silently disabled every
   * tag-narrowed `forbidden` rule and the whole `doNotContact.tags` bucket. A
   * caller with no resolver must now write `[]` on purpose, which is a
   * different statement from never having looked.
   */
  counterpartyTags: string[];
  /**
   * Set this only when `provenance` above was reduced over the causal chain
   * of the action about to run — see `ActionFacts.provenanceChainDerived`
   * (`src/domain/policy.ts`) for the three things a caller must be able to
   * guarantee before writing `true`.
   *
   * Optional, and absence means `false`. Unlike `counterpartyTags` — where an
   * omission produced a silently *empty* value that disabled controls — an
   * omission here produces the strict answer: the first-contact escalation
   * stays on. There is nothing to be gained by forcing seventy call sites to
   * write down the same `false` that not writing it already means.
   */
  provenanceChainDerived?: boolean;
}

/**
 * Reduce a raw tool call to the canonical fact object every predicate reads.
 *
 * Doing this once, in one place, is what keeps the gate deterministic: a rule
 * can never accidentally depend on the shape of a particular tool's payload,
 * and two tools that mean the same thing produce the same facts.
 */
export function buildFacts(
  toolName: string,
  toolInput: unknown,
  ctx: FactsContext,
): ActionFacts {
  const input = isRecord(toolInput) ? toolInput : {};
  const base = classifyAction(toolName);
  const actionClass = base === null ? null : refineActionClass(base, input);

  return {
    toolName,
    actionClass,
    amountMinor: readAmountMinor(input),
    amountDeclared: input['amountMinor'] !== undefined && input['amountMinor'] !== null,
    counterpartyId: readString(input, 'counterpartyId') ?? readString(input, 'entityId'),
    counterpartyEmails: readEmails(input),
    counterpartyPhones: readPhones(input),
    counterpartyTags: ctx.counterpartyTags,
    provenance: ctx.provenance,
    chainDepth: ctx.chainDepth,
    // `?? false` and not `?? true`: an absent signal is a caller that never
    // computed one, and the exemption it feeds must read that as "no".
    provenanceChainDerived: ctx.provenanceChainDerived ?? false,
    dataClasses: readDataClasses(input),
    leavesInstance: isOutbound(toolName),
    supplierId: readString(input, 'supplierId'),
    discountPercent: readNumber(input, 'discountPercent') ?? 0,
    inputHash: canonicalHash(toolInput),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Money always arrives in minor units as an integer. A payload carrying a
 * decimal `amount` is rejected rather than coerced — silently rounding money is
 * exactly the class of bug the ceilings exist to prevent.
 */
function readAmountMinor(input: Record<string, unknown>): number {
  const raw = input['amountMinor'];
  if (raw === undefined || raw === null) return 0;

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError(
      `amountMinor must be a non-negative integer in minor units, received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Own properties only — for the readers whose fields, when present, make a
 * decision GENTLER.
 *
 * A bare `input[key]` walks the prototype chain, so a payload carrying an
 * inherited field answers a lookup for something it never actually said. The
 * gate and the mail adapter read the same payload with different code, and the
 * moment one of them traverses a prototype the other does not, they can
 * disagree about who a message reaches — see `prototype-payload.test.ts`.
 *
 * Not applied blindly to every reader in this file, and that is the point:
 * `readAmountMinor`, `readDataClasses` and `readNumber` deliberately keep
 * reading through the chain, because there an unstated field makes the action
 * look bigger or more sensitive, and refusing to see it would be the
 * permissive move. The rule is "an unstated field may not loosen", never
 * "ownership for its own sake". `inherited-fields.test.ts` pins both halves.
 */
function ownValue(input: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = ownValue(input, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every address an outbound message would reach.
 *
 * Lower-cased, because a do-not-contact entry must not be defeated by casing,
 * and split on `,`/`;` because a payload may join recipients into one string.
 * All of them, not the first: checking one address of several reads as "we
 * checked" while being false.
 *
 * Each split fragment is run through `extractAddressCandidate`
 * (`src/util/address.ts`) before anything else, the same function
 * `readRecipients` (delivery, `src/orchestrator/adapters/mail.ts`) uses --
 * see that function's docblock for why sharing it is load-bearing rather
 * than a style choice. Concretely: `matchDoNotContact` and the
 * `byEmailDomain` autonomy override below both key off `email.split('@')[1]`
 * -- the domain of *this function's output*. Before the shared extraction, a
 * display-name form like `'Dana Cohen <dana@x.com>'` was kept whole, so that
 * split read the domain as `'x.com>'` (the closing bracket still attached)
 * and a charter entry blocking `x.com` silently never matched, while the
 * mail adapter had already learned to unwrap the same string down to
 * `dana@x.com` for delivery. Unwrapping here first makes the domain this
 * function's callers screen the same domain the adapter actually sends to.
 *
 * Exported so `src/orchestrator/adapters/mail.ts`'s own recipient reader can
 * be pinned against this one by a parity test: the mail adapter must never
 * mail an address the gate did not also see when it decided whether the
 * message was allowed to go out.
 */
export function readEmails(input: Record<string, unknown>): string[] {
  return collectStrings(input, ['to', 'recipient', 'email'])
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => extractAddressCandidate(value))
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase());
}

/**
 * Digits only, so `+972-50-123-4567` and `0501234567` compare equal. The leading
 * country code is not normalised away — that needs a locale the charter owns.
 */
function readPhones(input: Record<string, unknown>): string[] {
  return collectStrings(input, ['phone', 'toNumber', 'msisdn'])
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.replace(/\D/g, ''))
    .filter((value) => value.length > 0);
}

/**
 * Every string under any of `keys`, whether the payload put one there or a list.
 *
 * The single-value form read `to` only when it was a string, so `to: [...]`
 * yielded nothing at all and the do-not-contact check silently had no address
 * to compare. Reading all of them is the only form where "we checked" and "we
 * checked everything" are the same statement.
 */
function collectStrings(input: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = ownValue(input, key);
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') out.push(item);
    }
  }
  return out;
}

function readNumber(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const KNOWN_DATA_CLASSES: ReadonlySet<string> = new Set([
  'public',
  'internal',
  'customer_pii',
  'financial',
  'health',
  'legal',
  'credentials',
]);

/**
 * An unrecognised data class scores as the worst one, not as nothing.
 *
 * The filtering form dropped anything it did not recognise, so a payload
 * declaring `['medical']` — a plausible near-miss for `health` — scored zero on
 * data sensitivity. The field is self-declared by the model, which is the least
 * trusted component in the loop; an unfamiliar value is a reason to be more
 * careful, not less.
 */
function readDataClasses(input: Record<string, unknown>): DataClass[] {
  const raw = input['dataClasses'];
  if (!Array.isArray(raw)) return [];

  const out: DataClass[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    out.push(KNOWN_DATA_CLASSES.has(value) ? (value as DataClass) : 'credentials');
  }
  return out;
}
