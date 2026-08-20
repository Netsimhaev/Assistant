/**
 * The failure counter for usernames that have no `dashboard_users` row.
 *
 * `login` and `redeemRecoveryCode` both count failures with an UPDATE against
 * the user's own row. When the username does not exist that UPDATE matches
 * nothing, so the counter never advanced and the lockout never engaged: an
 * unauthenticated caller could spend the server's CPU — up to eight `scrypt`
 * calls per recovery attempt — without limit. See
 * `src/db/migrations/010_unknown_user_throttle.sql` for why the counter lives
 * in one shared row per business rather than one row per submitted name, and
 * for what that choice does and does not leak.
 *
 * The two budgets stay separate here exactly as they are on `dashboard_users`:
 * wrong recovery codes must not spend login's allowance, and vice versa. The
 * thresholds are NOT defined in this module — each caller passes its own, so
 * there is one definition of "five attempts, fifteen minutes" and one of "ten
 * attempts, one minute", not two of each drifting apart.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/** Which of the two budgets a call is spending. */
export type ThrottleKind = 'login' | 'recovery';

/**
 * Column names per budget. A closed map of literals, never interpolated from
 * anything a caller supplies — `ThrottleKind` is a two-value union, so this
 * cannot be reached with an arbitrary string.
 */
const COLUMNS: Record<ThrottleKind, { attempts: string; lockedUntil: string }> = {
  login: { attempts: 'failed_attempts', lockedUntil: 'locked_until' },
  recovery: { attempts: 'recovery_failed_attempts', lockedUntil: 'recovery_locked_until' },
};

export interface ThrottleInput {
  kind: ThrottleKind;
  maxFailed: number;
  lockMinutes: number;
  businessId?: string;
  now?: Date;
  db?: Queryable;
}

/**
 * Is the shared unknown-username bucket currently locked?
 *
 * Clears an expired lock lazily on the way through, the same pattern both
 * per-user paths use: the WHERE clause re-checks the expiry in Postgres
 * rather than trusting the JavaScript-side read, so a concurrent failure that
 * re-locked the bucket between the two statements is not clobbered a moment
 * after it was set.
 */
export async function unknownUserLocked(input: ThrottleInput): Promise<boolean> {
  const businessId = input.businessId ?? config.businessId;
  const now = input.now ?? new Date();
  const db = input.db ?? getPool();
  const col = COLUMNS[input.kind];

  const { rows } = await db.query<{ locked_until: Date | null }>(
    `SELECT ${col.lockedUntil} AS locked_until
       FROM dashboard_unknown_user_throttle WHERE business_id = $1`,
    [businessId],
  );
  const lockedUntil = rows[0]?.locked_until ?? null;
  if (lockedUntil === null) return false;

  if (lockedUntil.getTime() <= now.getTime()) {
    const cleared = await db.query(
      `UPDATE dashboard_unknown_user_throttle
          SET ${col.attempts} = 0, ${col.lockedUntil} = NULL
        WHERE business_id = $1 AND ${col.lockedUntil} <= $2`,
      [businessId, now],
    );
    // A no-op means someone else's fresh lock won the race, and that lock
    // stands.
    return (cleared.rowCount ?? 0) === 0;
  }

  return true;
}

/**
 * Count one failed attempt against the shared bucket, locking it if that
 * attempt reaches the threshold.
 *
 * The increment is computed by Postgres inside a single statement, never
 * read-modify-written in JavaScript: concurrent attempts would otherwise all
 * read the same stale count and each write back count + 1, so the counter
 * would advance by one instead of by N and the throttle would stop existing
 * under exactly the concurrency it exists to survive. The upsert makes the
 * first failure create the row, so nothing has to seed it.
 */
export async function recordUnknownUserFailure(input: ThrottleInput): Promise<void> {
  const businessId = input.businessId ?? config.businessId;
  const now = input.now ?? new Date();
  const db = input.db ?? getPool();
  const col = COLUMNS[input.kind];
  const lockUntilIfThresholdReached = new Date(now.getTime() + input.lockMinutes * 60_000);

  await db.query(
    `INSERT INTO dashboard_unknown_user_throttle (business_id, ${col.attempts}, ${col.lockedUntil})
     VALUES ($1, 1, CASE WHEN 1 >= $2 THEN $3::timestamptz END)
     ON CONFLICT (business_id) DO UPDATE
        SET ${col.attempts} = dashboard_unknown_user_throttle.${col.attempts} + 1,
            ${col.lockedUntil} = CASE
              WHEN dashboard_unknown_user_throttle.${col.attempts} + 1 >= $2 THEN $3::timestamptz
              ELSE dashboard_unknown_user_throttle.${col.lockedUntil}
            END`,
    [businessId, input.maxFailed, lockUntilIfThresholdReached],
  );
}
