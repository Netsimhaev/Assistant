/**
 * The technician's setup package (admin-panel spec): the boss's WhatsApp
 * number, and the contacts and colleagues the technician typed for a business
 * that has not yet signed its first charter.
 *
 * It is pre-confirmation data. `saveSetupPackage` refuses once the business
 * has an active charter (`SetupLockedError`) — from the first signature on,
 * only the owner decides who the assistant knows. The two clears are how the
 * data leaves after the owner confirmed or discarded it, and they work at any
 * time; the row is deleted once all three fields are empty.
 *
 * Phones are stored in canonical international form (`+<digits>`), through
 * `authorityNumberKey` — the same parser the WhatsApp door uses to decide who
 * the principal is, so a number typed here means the same thing there.
 */
import { z } from 'zod';
import { activeCharterVersion } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { authorityNumberKey } from '../governance/principal-number.js';

export const MAX_SETUP_CONTACTS = 200;
export const MAX_SETUP_COLLEAGUES = 50;
export const PERSON_FIELD_MAX_CHARS = 120;

/** A phone in international `+` form, normalised to `+<digits>`; anything else is refused. */
export const InternationalPhone = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const key = authorityNumberKey(value);
    if (key === null) {
      ctx.addIssue({ code: 'custom', message: 'מספר טלפון בפורמט בינלאומי בלבד, למשל +972501234567' });
      return z.NEVER;
    }
    return `+${key}`;
  });

export const PersonEntry = z
  .object({
    name: z.string().trim().min(1).max(PERSON_FIELD_MAX_CHARS),
    role: z.string().trim().min(1).max(PERSON_FIELD_MAX_CHARS),
    phone: InternationalPhone,
  })
  .strict();
export type PersonEntry = z.infer<typeof PersonEntry>;

export const SetupPackage = z
  .object({
    bossWhatsapp: InternationalPhone.nullable(),
    contacts: z.array(PersonEntry).max(MAX_SETUP_CONTACTS),
    colleagues: z.array(PersonEntry).max(MAX_SETUP_COLLEAGUES),
  })
  .strict();
export type SetupPackage = z.infer<typeof SetupPackage>;

export class SetupLockedError extends Error {
  constructor() {
    super('העסק כבר חתם על התקנון — נתוני ההקמה נעולים, ומעכשיו רק בעל העסק מעדכן אותם.');
    this.name = 'SetupLockedError';
  }
}

interface SetupPackageRow {
  boss_whatsapp: string | null;
  contacts: unknown;
  colleagues: unknown;
}

function toSetupPackage(row: SetupPackageRow): SetupPackage {
  // Parsed, not cast: a row written by anything but `saveSetupPackage` is
  // refused loudly rather than handed on as if it were valid.
  return SetupPackage.parse({
    bossWhatsapp: row.boss_whatsapp,
    contacts: row.contacts,
    colleagues: row.colleagues,
  });
}

export async function loadSetupPackage(db: BusinessDb): Promise<SetupPackage | null> {
  const { rows } = await db.query<SetupPackageRow>(
    'SELECT boss_whatsapp, contacts, colleagues FROM setup_packages WHERE business_id = $1',
    [db.businessId],
  );
  const row = rows[0];
  return row ? toSetupPackage(row) : null;
}

/**
 * Inside the caller's transaction: take the advisory lock the interview's
 * install takes (`charter-install:<businessId>`) and refuse with
 * `SetupLockedError` when a charter is already active. Held to the caller's
 * commit, so no install can land between this check and the caller's write.
 * The panel's profile and logo saves take it too.
 */
export async function assertSetupUnlocked(tx: BusinessDb): Promise<void> {
  if (!tx.inTransaction) throw new Error('assertSetupUnlocked: must run inside a transaction');
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('charter-install:' || $1))", [tx.businessId]);
  if ((await activeCharterVersion(tx)) !== null) throw new SetupLockedError();
}

/**
 * Replace the package. Refuses with `SetupLockedError` once a charter is
 * active, under the same advisory lock the interview's install takes, so a
 * save cannot land between that install's check and its commit. An empty
 * package deletes the row.
 */
export async function saveSetupPackage(db: BusinessDb, pkg: SetupPackage, updatedBy: string): Promise<void> {
  const parsed = SetupPackage.parse(pkg);
  await transaction(db, async (tx) => {
    await assertSetupUnlocked(tx);
    if (parsed.bossWhatsapp === null && parsed.contacts.length === 0 && parsed.colleagues.length === 0) {
      await tx.query('DELETE FROM setup_packages WHERE business_id = $1', [tx.businessId]);
      return;
    }
    await tx.query(
      `INSERT INTO setup_packages (business_id, boss_whatsapp, contacts, colleagues, updated_at, updated_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, now(), $5)
       ON CONFLICT (business_id) DO UPDATE
         SET boss_whatsapp = EXCLUDED.boss_whatsapp,
             contacts      = EXCLUDED.contacts,
             colleagues    = EXCLUDED.colleagues,
             updated_at    = EXCLUDED.updated_at,
             updated_by    = EXCLUDED.updated_by`,
      [tx.businessId, parsed.bossWhatsapp, JSON.stringify(parsed.contacts), JSON.stringify(parsed.colleagues), updatedBy],
    );
  });
}

const DELETE_WHEN_EMPTY = `DELETE FROM setup_packages
  WHERE business_id = $1
    AND boss_whatsapp IS NULL
    AND contacts = '[]'::jsonb
    AND colleagues = '[]'::jsonb`;

/** Empty the contacts and colleagues; the row goes when the boss number is empty too. */
export async function clearSetupPeople(db: BusinessDb): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      `UPDATE setup_packages SET contacts = '[]'::jsonb, colleagues = '[]'::jsonb, updated_at = now()
        WHERE business_id = $1`,
      [tx.businessId],
    );
    await tx.query(DELETE_WHEN_EMPTY, [tx.businessId]);
  });
}

/**
 * Remove the contacts and colleagues whose phone is in the given lists — the
 * ones the owner's signature just applied — and keep any the technician added
 * after the owner confirmed, so they stay pending rather than vanish unseen.
 * The row goes when everything is empty. Runs in the caller's transaction
 * when it has one (the install).
 */
export async function removeSetupPeople(
  db: BusinessDb,
  applied: { contactPhones: readonly string[]; colleaguePhones: readonly string[] },
): Promise<void> {
  await transaction(db, async (tx) => {
    const { rows } = await tx.query<SetupPackageRow>(
      'SELECT boss_whatsapp, contacts, colleagues FROM setup_packages WHERE business_id = $1 FOR UPDATE',
      [tx.businessId],
    );
    const row = rows[0];
    if (!row) return;
    const pkg = toSetupPackage(row);
    const contacts = pkg.contacts.filter((c) => !applied.contactPhones.includes(c.phone));
    const colleagues = pkg.colleagues.filter((c) => !applied.colleaguePhones.includes(c.phone));
    await tx.query(
      `UPDATE setup_packages SET contacts = $2::jsonb, colleagues = $3::jsonb, updated_at = now()
        WHERE business_id = $1`,
      [tx.businessId, JSON.stringify(contacts), JSON.stringify(colleagues)],
    );
    await tx.query(DELETE_WHEN_EMPTY, [tx.businessId]);
  });
}

/** Empty the boss number; the row goes when the contacts and colleagues are empty too. */
export async function clearSetupBoss(db: BusinessDb): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query('UPDATE setup_packages SET boss_whatsapp = NULL, updated_at = now() WHERE business_id = $1', [
      tx.businessId,
    ]);
    await tx.query(DELETE_WHEN_EMPTY, [tx.businessId]);
  });
}
