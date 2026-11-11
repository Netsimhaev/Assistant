import { withPlatform } from '../db/platform-pool.js';
import { isValidBusinessId } from '../db/pool.js';

/** A refusal meant for the platform operator; the message is Hebrew. */
export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

export type BusinessStatus = 'active' | 'suspended';

export interface Business {
  businessId: string;
  displayName: string;
  status: BusinessStatus;
}

interface BusinessRow {
  business_id: string;
  display_name: string;
  status: BusinessStatus;
}

function toBusiness(row: BusinessRow): Business {
  return { businessId: row.business_id, displayName: row.display_name, status: row.status };
}

export async function createBusiness(id: string, displayName: string): Promise<void> {
  if (!isValidBusinessId(id)) {
    throw new TenancyError(
      `מזהה עסק לא תקין "${id}" — אותיות אנגליות קטנות, ספרות ומקפים בלבד, באורך 3 עד 63`,
    );
  }
  const name = displayName.trim();
  if (name.length === 0 || name.length > 120) {
    throw new TenancyError('שם העסק חייב להכיל בין 1 ל-120 תווים');
  }
  await withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `INSERT INTO businesses (business_id, display_name) VALUES ($1, $2)
       ON CONFLICT (business_id) DO NOTHING`,
      [id, name],
    );
    if (rowCount === 0) throw new TenancyError(`העסק ${id} כבר קיים`);
  });
}

export async function setBusinessStatus(id: string, status: BusinessStatus): Promise<void> {
  await withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE businesses
          SET status = $2::text,
              suspended_at = CASE WHEN $2::text = 'suspended' THEN now() ELSE NULL END
        WHERE business_id = $1`,
      [id, status],
    );
    if (rowCount === 0) throw new TenancyError(`העסק ${id} לא קיים`);
  });
}

export async function getBusiness(id: string): Promise<Business | null> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<BusinessRow>(
      'SELECT business_id, display_name, status FROM businesses WHERE business_id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toBusiness(row) : null;
  });
}

export async function listBusinesses(): Promise<Business[]> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<BusinessRow>(
      'SELECT business_id, display_name, status FROM businesses ORDER BY business_id',
    );
    return rows.map(toBusiness);
  });
}
