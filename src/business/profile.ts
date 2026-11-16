/**
 * The business's own profile: its address and its logo (admin-panel spec).
 *
 * Not a counterparty's data, so not wired into contact erasure. The panel
 * enforces the charter lock itself before calling these; the owner's own
 * settings call them with no lock.
 *
 * The logo is judged by its bytes (`sniffImage`), capped at `LOGO_MAX_BYTES`,
 * and written to `<documentRoot>/<businessId>/profile/logo.png|jpg`. The row
 * holds the path relative to `documentRoot` and the sha256; `readLogo`
 * re-hashes the file on every read and refuses a mismatch — the same rule
 * "sign and approve" and every produced-file exit follow: what is served is
 * what was stored, or nothing.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { transaction, type BusinessDb } from '../db/pool.js';
import { LOGO_MAX_BYTES, sniffImage, type LogoMediaType } from './logo.js';

export const ADDRESS_MAX_CHARS = 300;

export interface BusinessProfile {
  address: string | null;
  logo: { path: string; mediaType: LogoMediaType; sha256: string } | null;
}

export class ProfileValidationError extends Error {
  constructor(messageHe: string) {
    super(messageHe);
    this.name = 'ProfileValidationError';
  }
}

interface ProfileRow {
  address: string | null;
  logo_path: string | null;
  logo_media_type: LogoMediaType | null;
  logo_sha256: string | null;
}

function toProfile(row: ProfileRow | undefined): BusinessProfile {
  if (!row) return { address: null, logo: null };
  const logo =
    row.logo_path !== null && row.logo_media_type !== null && row.logo_sha256 !== null
      ? { path: row.logo_path, mediaType: row.logo_media_type, sha256: row.logo_sha256 }
      : null;
  return { address: row.address, logo };
}

export async function loadProfile(db: BusinessDb): Promise<BusinessProfile> {
  const { rows } = await db.query<ProfileRow>(
    `SELECT address, logo_path, logo_media_type, logo_sha256
       FROM business_profiles WHERE business_id = $1`,
    [db.businessId],
  );
  return toProfile(rows[0]);
}

/** Save or clear the address. Blank is cleared; more than 300 characters is refused. */
export async function saveAddress(db: BusinessDb, address: string | null, updatedBy: string): Promise<void> {
  const trimmed = address === null ? null : address.trim();
  const value = trimmed === null || trimmed === '' ? null : trimmed;
  if (value !== null && value.length > ADDRESS_MAX_CHARS) {
    throw new ProfileValidationError(`הכתובת ארוכה מדי — עד ${ADDRESS_MAX_CHARS} תווים.`);
  }
  await db.query(
    `INSERT INTO business_profiles (business_id, address, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (business_id) DO UPDATE
       SET address = EXCLUDED.address, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [db.businessId, value, updatedBy],
  );
}

/** The only relative paths a logo may live at, for this business. */
function logoPathsFor(businessId: string): Record<LogoMediaType, string> {
  return {
    'image/png': `${businessId}/profile/logo.png`,
    'image/jpeg': `${businessId}/profile/logo.jpg`,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Store a new logo, replacing the old one. The file is written to a temporary
 * name and renamed into place, then the row is updated; a logo of the other
 * format is removed after the row points at the new one.
 */
export async function saveLogo(
  db: BusinessDb,
  bytes: Buffer,
  documentRoot: string,
  updatedBy: string,
): Promise<'ok' | 'not_image' | 'too_large'> {
  if (bytes.length > LOGO_MAX_BYTES) return 'too_large';
  const mediaType = sniffImage(bytes);
  if (mediaType === null) return 'not_image';

  const paths = logoPathsFor(db.businessId);
  const relative = paths[mediaType];
  const absolute = join(documentRoot, relative);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${ulid()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, absolute);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }

  await transaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO business_profiles (business_id, logo_path, logo_media_type, logo_sha256, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (business_id) DO UPDATE
         SET logo_path = EXCLUDED.logo_path,
             logo_media_type = EXCLUDED.logo_media_type,
             logo_sha256 = EXCLUDED.logo_sha256,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [tx.businessId, relative, mediaType, sha256(bytes), updatedBy],
    );
  });

  const other: LogoMediaType = mediaType === 'image/png' ? 'image/jpeg' : 'image/png';
  await rm(join(documentRoot, paths[other]), { force: true });
  return 'ok';
}

/**
 * The stored logo's bytes, or `null` when there is none, the stored path is
 * not one this module writes for this business, the file is gone, or its
 * bytes no longer hash to what was stored.
 */
export async function readLogo(
  db: BusinessDb,
  documentRoot: string,
): Promise<{ bytes: Buffer; mediaType: LogoMediaType } | null> {
  const { logo } = await loadProfile(db);
  if (logo === null) return null;
  // Positive check: the path must be exactly the one written for this
  // business and this format — a tampered row cannot point the read
  // anywhere else.
  const expected = logoPathsFor(db.businessId)[logo.mediaType];
  if (logo.path !== expected) return null;
  let bytes: Buffer;
  try {
    bytes = await readFile(join(documentRoot, expected));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (sha256(bytes) !== logo.sha256) return null;
  return { bytes, mediaType: logo.mediaType };
}
