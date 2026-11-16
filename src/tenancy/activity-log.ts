/**
 * What a technician did in the operator panel (migration 072,
 * `platform_activity_log`). Append-only in the database: no runtime account
 * may UPDATE or DELETE a row.
 *
 * **No content, ever.** A row names the staff member (by id), a closed action
 * kind, and the business it touched. `detail` takes only numbers, booleans and
 * short strings the caller chose — counts and flags, never something a
 * business wrote (CLAUDE.md, the panel never displays business content).
 */
import { withPlatform } from '../db/platform-pool.js';

export const STAFF_ACTIONS = [
  'business_open',
  'business_suspend',
  'business_resume',
  'whatsapp_saved',
  'setup_package_saved',
  'profile_saved',
  'logo_saved',
  'invite_issued',
  'reset_issued',
  'totp_reset',
  'staff_invited',
  'staff_removed',
] as const;

export type StaffAction = (typeof STAFF_ACTIONS)[number];

const KNOWN: ReadonlySet<string> = new Set(STAFF_ACTIONS);

/** Shortest cap that still fits an id or a code; anything longer is not a flag. */
const MAX_DETAIL_STRING = 200;

function checkDetail(detail: Record<string, number | boolean | string>): void {
  for (const [key, value] of Object.entries(detail)) {
    const ok =
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= MAX_DETAIL_STRING);
    if (!ok) throw new Error(`logStaffAction: detail "${key}" is not a number, boolean or short string`);
  }
}

export async function logStaffAction(input: {
  staffId: string;
  action: StaffAction;
  businessId: string | null;
  detail?: Record<string, number | boolean | string>;
}): Promise<void> {
  // The type closes the list at compile time; this closes it past a cast.
  if (!KNOWN.has(input.action)) throw new Error('logStaffAction: unknown action');
  const detail = input.detail ?? {};
  checkDetail(detail);
  await withPlatform((db) =>
    db.query(
      `INSERT INTO platform_activity_log (staff_id, action, business_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [input.staffId, input.action, input.businessId, JSON.stringify(detail)],
    ),
  );
}

export interface StaffActionRow {
  at: Date;
  staffDisplayName: string;
  action: StaffAction;
  businessId: string | null;
}

/** The latest `limit` actions, newest first, with who did them. */
export async function recentStaffActions(limit: number): Promise<StaffActionRow[]> {
  const bounded = Math.max(0, Math.min(Math.floor(limit), 1000));
  const { rows } = await withPlatform((db) =>
    db.query<{ at: Date; display_name: string; action: StaffAction; business_id: string | null }>(
      `SELECT l.at, s.display_name, l.action, l.business_id
         FROM platform_activity_log l JOIN platform_staff s ON s.staff_id = l.staff_id
        ORDER BY l.seq DESC
        LIMIT $1`,
      [bounded],
    ),
  );
  return rows.map((r) => ({
    at: r.at,
    staffDisplayName: r.display_name,
    action: r.action,
    businessId: r.business_id,
  }));
}
