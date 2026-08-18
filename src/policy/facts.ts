import type { DataClass } from '../domain/charter.js';
import type { ActionFacts } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { canonicalHash } from '../util/canonical.js';
import { classifyAction, isOutbound, refineActionClass } from './classify.js';

export interface FactsContext {
  /** Lowest trust in the job's causal chain, stamped by the gateway. */
  provenance: TrustLevel;
  chainDepth: number;
  /** Tags carried by the resolved counterparty, used by narrowed rules. */
  counterpartyTags?: string[];
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
    counterpartyId: readString(input, 'counterpartyId') ?? readString(input, 'entityId'),
    counterpartyEmail: readEmail(input),
    counterpartyPhone: readPhone(input),
    counterpartyTags: ctx.counterpartyTags ?? [],
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
 * The address an outbound message would actually reach.
 *
 * Lower-cased, because a do-not-contact entry must not be defeated by casing.
 * Only the first recipient is read: Phase 0 serialises one outbound message per
 * counterparty thread, so a multi-recipient payload is not a shape the gate is
 * built to reason about — and quietly checking one of several addresses would
 * be worse than not checking at all. See the note in docs/04-charter.md.
 */
function readEmail(input: Record<string, unknown>): string | null {
  const raw = readString(input, 'to') ?? readString(input, 'recipient') ?? readString(input, 'email');
  return raw === null ? null : raw.trim().toLowerCase();
}

/**
 * Digits only, so `+972-50-123-4567` and `0501234567` compare equal. The leading
 * country code is not normalised away — that needs a locale the charter owns.
 */
function readPhone(input: Record<string, unknown>): string | null {
  const raw =
    readString(input, 'phone') ?? readString(input, 'toNumber') ?? readString(input, 'msisdn');
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
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

function readDataClasses(input: Record<string, unknown>): DataClass[] {
  const raw = input['dataClasses'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is DataClass =>
      typeof value === 'string' && KNOWN_DATA_CLASSES.has(value),
  );
}
