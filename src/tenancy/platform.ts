import { closePlatformPool, withPlatform } from '../db/platform-pool.js';
import { verifyKeyState } from '../governance/master-key.js';
import { normaliseLogin } from './login.js';

/**
 * Close the platform pool on shutdown, for a process outside the modules that
 * may import it directly — the dashboard, which reads the login and the
 * business's status through this module.
 */
export async function closePlatform(): Promise<void> {
  await closePlatformPool();
}

/**
 * Named cross-business operations (spec §5.7), run on the platform pool.
 * Only this module and its siblings under `src/tenancy/` may do so.
 */
export async function listActiveBusinesses(): Promise<string[]> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ business_id: string }>(
      // Byte order, not the database's collation: the scheduler's rotation
      // compares ids with JS `>=`, which must agree with this order.
      `SELECT business_id FROM businesses WHERE status = 'active' ORDER BY business_id COLLATE "C"`,
    );
    return rows.map((row) => row.business_id);
  });
}

/**
 * Which business a dashboard login belongs to, before there is a session
 * (spec §5.7, item 2). The login is unique across the server on
 * `lower(login)` (migration 066), so at most one row matches.
 *
 * Returns the business id and its status, and nothing else — no username, no
 * hash, no counter. Everything the login then does to the account (the
 * password check, the failure counters, the lock) runs inside that
 * business's own `withBusiness`, on the app role, never here.
 *
 * Normalised by `normaliseLogin` (./login.ts), the one function the
 * stored value and the index's `lower(login)` agree with: `" Dana@X.example "`
 * and `dana@x.example` are one mailbox.
 */
export async function resolveLogin(
  login: string,
): Promise<{ businessId: string; status: 'active' | 'suspended' } | null> {
  const normalised = normaliseLogin(login);
  if (normalised.length === 0) return null;
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ business_id: string; status: 'active' | 'suspended' }>(
      // Joined to `businesses`: a user row whose business is not registered
      // resolves to nothing, exactly like an unknown address.
      `SELECT u.business_id, b.status
         FROM dashboard_users u
         JOIN businesses b ON b.business_id = u.business_id
        WHERE lower(u.login) = $1`,
      [normalised],
    );
    const row = rows[0];
    return row ? { businessId: row.business_id, status: row.status } : null;
  });
}

/**
 * Delete every OAuth `state` row that can no longer matter — already
 * consumed, or past its own TTL and therefore already refused by
 * `consumeState`'s `expires_at` check (spec §5.7, item 4). Returns how many
 * rows went.
 *
 * Here, on the platform pool, because the cleanup is server-wide by design:
 * a consumed or expired row from business A is exactly as dead as one from
 * business B, and each one holds a `code_verifier` in plaintext. Run on a
 * business's own connection it would reach only that business's rows once
 * row level security is on, and every other business's stale rows would sit
 * until one of their owners happened to start a ceremony too. The predicate
 * names only dead rows — nothing here can read, or remove, a live state.
 */
export async function cleanupOAuthStates(): Promise<number> {
  return withPlatform(async (db) => {
    const result = await db.query(
      'DELETE FROM oauth_states WHERE consumed_at IS NOT NULL OR expires_at <= now()',
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Check `key` against the server's key state (`verifyKeyState`), for a
 * process that holds no connection of its own yet — the scheduler at
 * startup. The key belongs to the server (spec §5.9), not to any business, so
 * the check runs on the platform pool rather than inside some business's
 * `withBusiness`. A caller that already holds a connection (a dashboard
 * request, a CLI inside `withBusiness`) calls `verifyKeyState` on it instead
 * and never acquires a second one.
 */
export async function verifyServerKeyState(key: Buffer): Promise<void> {
  await withPlatform((db) => verifyKeyState(key, db));
}
