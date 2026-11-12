import { closePlatformPool, withPlatform } from '../db/platform-pool.js';

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
 * Trimmed and lower-cased exactly as the index is: `" Dana@X.example "` and
 * `dana@x.example` are one mailbox.
 */
export async function resolveLogin(
  login: string,
): Promise<{ businessId: string; status: 'active' | 'suspended' } | null> {
  const normalised = login.trim().toLowerCase();
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
