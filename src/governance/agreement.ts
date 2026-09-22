/**
 * How many times in a row the owner approved what the assistant proposed,
 * without changing a word.
 *
 * Derived from `approval_requests` on every call, never accumulated. A
 * counter maintained beside its source can drift from it without anyone
 * noticing — the failure this codebase has already paid for twice — while a
 * derived number is right by construction, and right retroactively after a
 * bug is fixed. The counter columns migration 001 put on `autonomy_ramp`
 * stay empty on purpose (spec §4.1).
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';

/** How long a clean run must be before a class earns a step. Spec §13. */
export const STREAK_REQUIRED = 10;

/**
 * The three states that carry a verdict, named positively.
 *
 * `expired` and `cancelled` are excluded because they say nobody answered or
 * the request was withdrawn — neither is the assistant being right and
 * neither is her being wrong, so they must not count AND must not break a
 * run (spec §4.3). Excluding them in the query rather than filtering after
 * is what makes them invisible to the streak instead of fatal to it.
 */
const DECIDED_STATES = ['approved', 'approved_with_edit', 'denied'] as const;

export async function approvalStreak(
  actionClass: ActionClass,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM approval_requests
      WHERE business_id = $1 AND action_class = $2 AND state = ANY($3::text[])
      ORDER BY decided_at DESC
      LIMIT $4`,
    [options.businessId ?? config.businessId, actionClass, [...DECIDED_STATES], STREAK_REQUIRED],
  );

  let streak = 0;
  for (const row of rows) {
    // Positive: only a clean approval extends the run. `approved_with_edit`
    // and `denied` both stop it, and anything else this build does not know
    // stops it too — an unreadable state is never a permissive one.
    if (row.state !== 'approved') break;
    streak += 1;
  }
  return streak;
}
