import { withPlatform } from '../db/platform-pool.js';

/**
 * Named cross-business operations (spec §5.7), run on the platform pool.
 * Only this module and its siblings under `src/tenancy/` may do so.
 */
export async function listActiveBusinesses(): Promise<string[]> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ business_id: string }>(
      "SELECT business_id FROM businesses WHERE status = 'active' ORDER BY business_id",
    );
    return rows.map((row) => row.business_id);
  });
}
