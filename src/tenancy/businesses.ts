import { mkdir } from 'node:fs/promises';
import { withPlatform } from '../db/platform-pool.js';
import { isValidBusinessId, RESERVED_BUSINESS_IDS } from '../db/pool.js';
import { businessFolders, businessSaveRoot, countFilesUnder } from './paths.js';

/** A refusal meant for the platform operator; the message is Hebrew. */
export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

/**
 * A refusal over the business id itself — malformed, or no such business.
 * Separate from other refusals so a command can exit 2 (a usage error) for
 * these and 1 for the rest ("already exists", a bad display name).
 */
export class BusinessIdError extends TenancyError {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessIdError';
  }
}

/**
 * The id is already registered — refused before anything was written. Its
 * own class so a caller can tell it from a refusal raised AFTER the row was
 * inserted (the save folder): the first means "this business is someone
 * else's", the second "yours exists, with one thing missing".
 */
export class BusinessExistsError extends TenancyError {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessExistsError';
  }
}

function malformedIdMessage(id: string): string {
  return `מזהה עסק לא תקין "${id}" — אותיות אנגליות קטנות, ספרות ומקפים בלבד, באורך 3 עד 63`;
}

/** `deleting`: the rows are gone, the files not yet (migration 081); the id stays taken until they are. */
export type BusinessStatus = 'active' | 'suspended' | 'deleting';

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
  // Before the shape message: a reserved id has the right shape, and telling
  // the operator it is malformed would send her looking for the wrong fix.
  if (RESERVED_BUSINESS_IDS.has(id)) {
    throw new BusinessIdError(`המזהה "${id}" שמור לשימוש המערכת — בחרי מזהה אחר לעסק`);
  }
  if (!isValidBusinessId(id)) {
    throw new BusinessIdError(malformedIdMessage(id));
  }
  const name = displayName.trim();
  if (name.length === 0 || name.length > 120) {
    throw new TenancyError('שם העסק חייב להכיל בין 1 ל-120 תווים');
  }
  // A business re-created with an old id starts empty (deletion spec). While
  // the old one is still being deleted its id is taken; once its row is gone,
  // a file it left in any of its three folders — the save folder above all,
  // which deletion never removes — would become the new business's. An empty
  // or missing folder does not block.
  const existing = await getBusiness(id);
  if (existing?.status === 'deleting') {
    throw new TenancyError(
      `העסק ${id} נמצא באמצע מחיקה. אפשר לפתוח עסק עם המזהה הזה רק אחרי שהמחיקה תסתיים.`,
    );
  }
  if (existing === null) {
    const folders = businessFolders(id);
    for (const folder of [folders.document, folders.inbox, folders.save]) {
      if (folder !== null && (await countFilesUnder(folder)) > 0) {
        throw new TenancyError(
          `בשרת נשארו קבצים בתיקייה של המזהה ${id} מעסק קודם. ` +
            'אפשר לפתוח עסק עם המזהה הזה רק אחרי שהקבצים יועברו או יימחקו.',
        );
      }
    }
  }
  await withPlatform(async (db) => {
    // One statement, so the registry row and the profile copy of the name
    // (migration 075 — what a business connection reads for its letterhead
    // and official messages) are written together or not at all. A refused
    // duplicate inserts nothing in `b`, so the existing profile is untouched.
    const { rows } = await db.query<{ business_id: string }>(
      `WITH b AS (
         INSERT INTO businesses (business_id, display_name) VALUES ($1, $2)
         ON CONFLICT (business_id) DO NOTHING
         RETURNING business_id
       )
       INSERT INTO business_profiles (business_id, display_name, updated_by)
       SELECT business_id, $2, 'platform' FROM b
       ON CONFLICT (business_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING business_id`,
      [id, name],
    );
    if (rows.length === 0) throw new BusinessExistsError(`העסק ${id} כבר קיים`);
  });
  // The business's save folder on the server (spec §5.8). `saveDocumentSettings`
  // accepts a base folder only inside it, so a business without it could
  // never save. After the row, so a refused duplicate creates nothing new.
  const saveRoot = businessSaveRoot(id);
  if (saveRoot !== null) {
    try {
      await mkdir(saveRoot, { recursive: true });
    } catch (err) {
      throw new TenancyError(
        `העסק ${id} נוצר, אבל תיקיית השמירה שלו בשרת (${saveRoot}) לא נוצרה: ` +
          `${err instanceof Error ? err.message : String(err)} — יש ליצור אותה ידנית`,
      );
    }
  }
}

export async function setBusinessStatus(id: string, status: BusinessStatus): Promise<void> {
  // Checked before the UPDATE, as `createBusiness` checks before its INSERT:
  // a malformed id cannot match a row, but it should be refused for what it
  // is, not reported as "no such business".
  if (!isValidBusinessId(id)) {
    throw new BusinessIdError(malformedIdMessage(id));
  }
  await withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE businesses
          SET status = $2::text,
              suspended_at = CASE WHEN $2::text = 'suspended' THEN now() ELSE NULL END
        WHERE business_id = $1`,
      [id, status],
    );
    if (rowCount === 0) throw new BusinessIdError(`העסק ${id} לא קיים`);
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
