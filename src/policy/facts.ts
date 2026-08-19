import type { DataClass } from '../domain/charter.js';
import type { ActionFacts } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
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

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
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
 * Exported so `src/orchestrator/adapters/mail.ts`'s own recipient reader can
 * be pinned against this one by a parity test: the mail adapter must never
 * mail an address the gate did not also see when it decided whether the
 * message was allowed to go out.
 */
export function readEmails(input: Record<string, unknown>): string[] {
  return collectStrings(input, ['to', 'recipient', 'email'])
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
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
    const value = input[key];
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
