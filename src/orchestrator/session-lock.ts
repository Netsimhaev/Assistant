import { withBusiness, type BusinessDb } from '../db/pool.js';

export type SessionLocked<T> = { locked: true; value: T } | { locked: false };

/**
 * Hold the SESSION advisory lock `scope` (`pg_try_advisory_lock`, never
 * blocking) on `db` for as long as `fn` runs, then unlock it. The lock is
 * taken on the very `BusinessDb` that does the work, so the work, the lock and
 * the business context share one session.
 *
 * `{ locked: false }` — and `fn` never runs — when another session holds the
 * lock: a second runner skips the work and comes back, it does not queue
 * behind the first and repeat it.
 *
 * **A failed unlock poisons the connection so it is destroyed.** The lock
 * lives on the session and only certainly ends when the session does.
 * Returned to the pool alive, the next checkout of this connection would
 * carry the lock, and every later run of this scope would see
 * `pg_try_advisory_lock` fail and report "locked out", silently, until the
 * pool happened to recycle it. `withBusiness` destroys any connection it does
 * not find idle outside a transaction, so a failed unlock leaves the session
 * inside a `BEGIN` — the one way, through `withBusiness`'s own rule, to make
 * sure it is never pooled. If even that `BEGIN` fails, the connection is
 * broken and the RESET `withBusiness` runs next fails too, which destroys it
 * as well.
 *
 * **A `db` already in a transaction is refused.** The poisoning above works by
 * leaving the session in a `BEGIN`, which inside a caller's transaction would
 * be a no-op warning and would not stop the connection being pooled; and a
 * session lock held across a caller's transaction is not what the callers of
 * this function — long passes that make external calls — must ever do.
 *
 * An error from `fn` propagates after the unlock attempt; callers isolate
 * their own per-item failures.
 */
export async function withSessionLockOn<T>(
  db: BusinessDb,
  scope: string,
  fn: () => Promise<T>,
): Promise<SessionLocked<T>> {
  if (db.inTransaction) {
    throw new Error('withSessionLockOn: refusing a connection that is already in a transaction');
  }
  const lock = await db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    [scope],
  );
  if (lock.rows[0]?.locked !== true) return { locked: false };
  try {
    return { locked: true, value: await fn() };
  } finally {
    try {
      await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
    } catch {
      await db.query('BEGIN').catch(() => {
        // Broken connection: withBusiness's RESET fails and destroys it.
      });
    }
  }
}

/**
 * `withSessionLockOn` on a fresh connection of its own for `businessId` — for
 * per-item work where each item runs on its own connection (`runDueJobs`,
 * `closeVerifiedJobs`, `resumeDelegatedJobs`, `reaskFailedCommands`), so one
 * slow item holds one pool slot for its own duration only.
 */
export async function withSessionLock<T>(
  businessId: string,
  scope: string,
  fn: (db: BusinessDb) => Promise<T>,
): Promise<SessionLocked<T>> {
  return withBusiness(businessId, (db) => withSessionLockOn(db, scope, () => fn(db)));
}
