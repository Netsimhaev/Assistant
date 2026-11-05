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
 * An absent row reads as the defaults, and reading never writes one.
 */
import { constants } from 'node:fs';
import { access as fsAccess, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';

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
});

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

export async function loadDocumentSettings(options: { businessId: string; db?: Queryable }): Promise<DocumentSettings> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SettingsRow>(
    `SELECT to_whatsapp, to_email, to_screen, base_folder
       FROM document_settings WHERE business_id = $1`,
    [options.businessId],
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
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/** The checked, resolved base folder, or a Hebrew refusal thrown as an `Error`. */
async function checkedBaseFolder(
  raw: string | null,
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
  return realpath(folder);
}

export async function saveDocumentSettings(
  settings: DocumentSettings,
  options: {
    businessId: string;
    db?: Queryable;
    /** `fs.access` — injectable so a test can drive the not-writable refusal on any OS. */
    access?: (path: string, mode: number) => Promise<void>;
  },
): Promise<void> {
  if (!(settings.toWhatsApp || settings.toEmail || settings.toScreen)) {
    throw new Error(DOCUMENT_SETTINGS_HE.noChannel);
  }
  const baseFolder = await checkedBaseFolder(settings.baseFolder, options.access ?? fsAccess);
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen, base_folder)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id) DO UPDATE
       SET to_whatsapp = EXCLUDED.to_whatsapp,
           to_email = EXCLUDED.to_email,
           to_screen = EXCLUDED.to_screen,
           base_folder = EXCLUDED.base_folder,
           updated_at = now()`,
    [options.businessId, settings.toWhatsApp, settings.toEmail, settings.toScreen, baseFolder],
  );
}
