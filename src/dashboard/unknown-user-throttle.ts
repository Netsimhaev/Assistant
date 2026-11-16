/**
 * The failure counter for usernames that have no `dashboard_users` row.
 *
 * `login` counts failures with an UPDATE against the user's own row. When the
 * username does not exist that UPDATE matches nothing, so the counter never
 * advanced and the lockout never engaged: an unauthenticated caller could
 * spend the server's CPU on `scrypt` calls without limit. See
 * `src/db/migrations/010_unknown_user_throttle.sql` for why the counter lives
 * in one shared row rather than one row per submitted name, and for what that
 * choice does and does not leak. Since migration 066 that row is one for the
 * whole server, not one per business: a login is an email that has not yet
 * resolved to any business when it fails, so there is no business to file the
 * failure under (spec §5.5).
 *
 * The threshold is NOT defined in this module — the caller passes it, so
 * there is one definition of "five attempts, fifteen minutes", in `auth.ts`.
 * (The table still carries the recovery codes' columns from migration 010;
 * nothing reads or writes them since the codes were removed in 070.)
 */
import type { Queryable } from '../db/pool.js';

export interface ThrottleInput {
  maxFailed: number;
  lockMinutes: number;
  now?: Date;
  /**
   * Any connection — the row has no business and no policy. Before a login
   * has resolved that is `withNoBusiness`; inside a business's request it is
   * that request's own connection.
   */
  db: Queryable;
}

/**
 * Is the shared unknown-username bucket currently locked?
 *
 * Clears an expired lock lazily on the way through, the same pattern the
 * per-user path uses: the WHERE clause re-checks the expiry in Postgres
 * rather than trusting the JavaScript-side read, so a concurrent failure that
 * re-locked the bucket between the two statements is not clobbered a moment
 * after it was set.
 */
export async function unknownUserLocked(input: ThrottleInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const db = input.db;

  const { rows } = await db.query<{ locked_until: Date | null }>(
    `SELECT locked_until
       FROM dashboard_unknown_user_throttle`,
  );
  const lockedUntil = rows[0]?.locked_until ?? null;
  if (lockedUntil === null) return false;

  if (lockedUntil.getTime() <= now.getTime()) {
    const cleared = await db.query(
      `UPDATE dashboard_unknown_user_throttle
          SET failed_attempts = 0, locked_until = NULL
        WHERE locked_until <= $1`,
      [now],
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
  const now = input.now ?? new Date();
  const db = input.db;
  const lockUntilIfThresholdReached = new Date(now.getTime() + input.lockMinutes * 60_000);

  await db.query(
    `INSERT INTO dashboard_unknown_user_throttle (singleton, failed_attempts, locked_until)
     VALUES (true, 1, CASE WHEN 1 >= $1 THEN $2::timestamptz END)
     ON CONFLICT (singleton) DO UPDATE
        SET failed_attempts = dashboard_unknown_user_throttle.failed_attempts + 1,
            locked_until = CASE
              WHEN dashboard_unknown_user_throttle.failed_attempts + 1 >= $1 THEN $2::timestamptz
              ELSE dashboard_unknown_user_throttle.locked_until
            END`,
    [input.maxFailed, lockUntilIfThresholdReached],
  );
}
