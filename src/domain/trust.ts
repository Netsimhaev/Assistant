import { z } from 'zod';

/**
 * How much the system trusts the origin of a piece of work.
 *
 * Every job carries the *lowest* trust level in its causal chain. This is the
 * enforcement teeth behind the prompt-injection defence (docs/08-risks.md):
 * an email from an unknown sender cannot cause a payment, because the gateway
 * stamps provenance onto a database column before any model sees the content,
 * and no prompt can change a database column.
 */
export const TrustLevel = z.enum([
  'boss',
  'staff',
  'known_counterparty',
  'unknown_external',
  'open_web',
]);
export type TrustLevel = z.infer<typeof TrustLevel>;

/** Higher number = more trusted. Used only for comparison, never persisted. */
const TRUST_RANK: Record<TrustLevel, number> = {
  open_web: 0,
  unknown_external: 1,
  known_counterparty: 2,
  staff: 3,
  boss: 4,
};

/**
 * The provenance ceiling of a causal chain is its *least* trusted link.
 * Constraints tighten monotonically down a delegation chain — privilege can
 * never be laundered by passing work to another agent (docs/03-protocol.md).
 */
export function lowestTrust(levels: readonly TrustLevel[]): TrustLevel {
  if (levels.length === 0) {
    throw new Error('lowestTrust: refusing to infer a trust level from an empty chain');
  }
  return levels.reduce((lowest, next) =>
    TRUST_RANK[next] < TRUST_RANK[lowest] ? next : lowest,
  );
}

export function isAtLeastAsTrustedAs(a: TrustLevel, b: TrustLevel): boolean {
  return TRUST_RANK[a] >= TRUST_RANK[b];
}

/**
 * What an agent may do without a human in the loop.
 *
 * Autonomy is *earned* per action class by measured agreement, never configured
 * optimistically (docs/05-approvals.md). Every class starts at `draft_only`.
 */
export const AutonomyLevel = z.enum([
  'forbidden',
  'draft_only',
  'approve_required',
  'auto_notify',
  'auto',
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/** Higher number = more permissive. */
const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  forbidden: 0,
  draft_only: 1,
  approve_required: 2,
  auto_notify: 3,
  auto: 4,
};

/**
 * The effective autonomy for an action is the most restrictive of every ceiling
 * that applies: the charter baseline, the counterparty override, the provenance
 * ceiling, the earned ramp level, and the envelope's own cap.
 *
 * Combining ceilings by minimum is what makes them ceilings — any single input
 * can tighten the result, none can loosen it.
 */
export function mostRestrictiveAutonomy(
  levels: readonly AutonomyLevel[],
): AutonomyLevel {
  if (levels.length === 0) {
    throw new Error(
      'mostRestrictiveAutonomy: refusing to default to permissive with no ceilings supplied',
    );
  }
  return levels.reduce((lowest, next) =>
    AUTONOMY_RANK[next] < AUTONOMY_RANK[lowest] ? next : lowest,
  );
}

export function permits(level: AutonomyLevel, atLeast: AutonomyLevel): boolean {
  return AUTONOMY_RANK[level] >= AUTONOMY_RANK[atLeast];
}
