/**
 * Where the owner hears that a produced document is ready, and the one folder
 * on her computer that `doc.save` may write into (document production §9.2,
 * §10).
 *
 * **At least one channel, in two layers** — the `action_update_settings`
 * pattern: `saveDocumentSettings` refuses an all-false choice in Hebrew before
 * touching the database, and migration 053's
 * `document_settings_at_least_one_channel` CHECK makes the same row impossible
 * to write from anywhere else.
 *
 * **The base folder is checked when it is saved, not trusted when it is
 * used.** It must be an absolute path (on Windows: a drive or a UNC share — a
 * bare `\x` is "absolute" to `path.isAbsolute` but means "the current drive",
 * i.e. wherever the process happens to run), exist, be a directory, and pass
 * `fs.access(W_OK)`. What is stored is its `realpath`, so the containment
 * check in `save.ts` compares against the folder the owner actually chose
 * even when she typed it through a link. `doc.save` still re-resolves it on
 * every save — the setting is the owner's choice, not a guarantee about the
 * disk tomorrow.
 *
 * **And it must sit inside this business's save folder on the server**,
 * `<DOCUMENT_SAVE_ROOT>/<businessId>` (spec §5.8): on a shared server every
 * business's folders are on one disk, and without this one owner could point
 * her saves at a folder of another business. Compared as `realpath`s, so a
 * link inside the business folder that leads out of it is refused too. A
 * server with no `DOCUMENT_SAVE_ROOT` accepts no base folder at all.
 * `doc.save` re-checks this at write time (`isInsideBusinessSaveRoot`).
 *
 * An absent row reads as the defaults, and reading never writes one.
 */
import { constants } from 'node:fs';
import { access as fsAccess, realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import type { BusinessDb } from '../db/pool.js';
import { businessSaveRoot } from '../tenancy/paths.js';

export interface DocumentSettings {
  toWhatsApp: boolean;
  toEmail: boolean;
  toScreen: boolean;
  baseFolder: string | null;
}

/** Email and the screen, not WhatsApp (not live on any install), and no folder until the owner names one. */
export const DOCUMENT_SETTINGS_DEFAULTS: Readonly<DocumentSettings> = Object.freeze({
  toWhatsApp: false,
  toEmail: true,
  toScreen: true,
  baseFolder: null,
});

export const DOCUMENT_SETTINGS_HE = Object.freeze({
  noChannel: 'חובה לבחור לפחות דרך אחת לקבל הודעה על מסמך מוכן',
  notAbsolute: 'תיקיית הבסיס חייבת להיות נתיב מלא, למשל C:\\מסמכים',
  missing: 'תיקיית הבסיס לא נמצאה',
  notDirectory: 'תיקיית הבסיס אינה תיקייה',
  notWritable: 'אין הרשאת כתיבה לתיקיית הבסיס',
  outsideBusiness: 'התיקייה חייבת להיות בתוך התיקייה של העסק בשרת',
  noServerRoot: 'לא הוגדרה בשרת תיקייה לשמירת מסמכים — אי אפשר להגדיר תיקיית בסיס',
});

/**
 * Is `folder` — resolved through `realpath` — this business's save folder or
 * inside it? False when the server has no save root, when the business
 * folder does not exist, or when `folder` does not resolve. Shared by the
 * setting and by `doc.save`, so the two can never disagree on "inside".
 */
export async function isInsideBusinessSaveRoot(folder: string, businessId: string): Promise<boolean> {
  const root = businessSaveRoot(businessId);
  if (root === null) return false;
  let realRoot: string;
  let realFolder: string;
  try {
    realRoot = await realpath(root);
    realFolder = await realpath(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realFolder === realRoot || realFolder.startsWith(prefix);
}

interface SettingsRow {
  to_whatsapp: boolean;
  to_email: boolean;
  to_screen: boolean;
  base_folder: string | null;
}

function toSettings(row: SettingsRow): DocumentSettings {
  return {
    toWhatsApp: row.to_whatsapp,
    toEmail: row.to_email,
    toScreen: row.to_screen,
    baseFolder: row.base_folder,
  };
}

export async function loadDocumentSettings(db: BusinessDb): Promise<DocumentSettings> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT to_whatsapp, to_email, to_screen, base_folder
       FROM document_settings WHERE business_id = $1`,
    [db.businessId],
  );
  const row = rows[0];
  return row === undefined ? { ...DOCUMENT_SETTINGS_DEFAULTS } : toSettings(row);
}

/**
 * Absolute in the strong sense. On Windows `path.isAbsolute('\\x')` is true,
 * but `\x` is relative to whichever drive is current — so a drive letter or a
 * UNC prefix is required there.
 */
function isFullyQualified(path: string): boolean {
  if (!isAbsolute(path)) return false;
  if (process.platform !== 'win32') return true;
  // A drive, or a UNC share `\\server\share`. The device namespaces `\\.\`
  // and `\\?\` (either separator) are refused: they bypass Win32 path
  // normalisation — the very layer that makes "inside the base" mean anything.
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return /^[\\/]{2}(?![.?][\\/])[^\\/]+[\\/][^\\/]+/.test(path);
}

/** The checked, resolved base folder, or a Hebrew refusal thrown as an `Error`. */
async function checkedBaseFolder(
  raw: string | null,
  businessId: string,
  access: (path: string, mode: number) => Promise<void>,
): Promise<string | null> {
  const folder = raw?.trim() ?? '';
  if (folder === '') return null;
  if (!isFullyQualified(folder)) throw new Error(DOCUMENT_SETTINGS_HE.notAbsolute);
  let info;
  try {
    info = await stat(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(DOCUMENT_SETTINGS_HE.missing);
    throw err;
  }
  if (!info.isDirectory()) throw new Error(DOCUMENT_SETTINGS_HE.notDirectory);
  try {
    await access(folder, constants.W_OK);
  } catch {
    throw new Error(DOCUMENT_SETTINGS_HE.notWritable);
  }
  if (businessSaveRoot(businessId) === null) throw new Error(DOCUMENT_SETTINGS_HE.noServerRoot);
  if (!(await isInsideBusinessSaveRoot(folder, businessId))) throw new Error(DOCUMENT_SETTINGS_HE.outsideBusiness);
  return realpath(folder);
}

export async function saveDocumentSettings(
  db: BusinessDb,
  settings: DocumentSettings,
  options: {
    /** `fs.access` — injectable so a test can drive the not-writable refusal on any OS. */
    access?: (path: string, mode: number) => Promise<void>;
  } = {},
): Promise<void> {
  if (!(settings.toWhatsApp || settings.toEmail || settings.toScreen)) {
    throw new Error(DOCUMENT_SETTINGS_HE.noChannel);
  }
  const baseFolder = await checkedBaseFolder(settings.baseFolder, db.businessId, options.access ?? fsAccess);
  await db.query(
    `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen, base_folder)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id) DO UPDATE
       SET to_whatsapp = EXCLUDED.to_whatsapp,
           to_email = EXCLUDED.to_email,
           to_screen = EXCLUDED.to_screen,
           base_folder = EXCLUDED.base_folder,
           updated_at = now()`,
    [db.businessId, settings.toWhatsApp, settings.toEmail, settings.toScreen, baseFolder],
  );
}
