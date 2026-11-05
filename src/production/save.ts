/**
 * `doc.save` — copy the exact approved file into a folder the owner named,
 * always inside the base folder she configured (document production §9.2).
 *
 * Path safety is the whole point, and every rule is positive:
 *
 * - **A folder is a sequence of relative segments, each checked against an
 *   allowlist** (`/^[\p{L}\p{N} _.-]+$/u`, no leading dot), never a path that
 *   is "cleaned". Bidi controls are stripped first, so an override cannot make
 *   the owner read one name while the disk gets another. Refused: `..`,
 *   anything absolute, a drive letter, a UNC share, an empty segment, Windows
 *   reserved device names (case-insensitive, with or without an extension —
 *   `con.txt` opens the console on Windows), a trailing dot or space (Windows
 *   silently strips them, so `a.` IS `a` and `CON ` IS `CON`), more than five
 *   segments, more than 200 characters. A `null` folder is the kind label.
 * - **Directories are walked one segment at a time, and a link is refused
 *   even when it points back inside.** First a read-only walk over the
 *   segments that already exist — any link or non-directory refuses before
 *   anything is created — then the missing segments are made one `mkdir` at
 *   a time (never `recursive`, which follows links), each re-`lstat`ed. Then
 *   the created directory's `realpath` must start with the base's `realpath`
 *   plus a separator: the backstop for a link swapped in between the checks.
 * - **A file is never overwritten.** Opened with `wx` (O_CREAT|O_EXCL, which
 *   also refuses a dangling link at that name); on `EEXIST` the next name is
 *   ` (2)` … ` (99)` before the extension, and past that a Hebrew refusal.
 * - **The bytes written are the bytes approved.** The source is read once and
 *   hashed (`readVersionBytes`, shared with the mail attachment resolver), the
 *   same buffer is written, and the written file is read back and re-hashed —
 *   a mismatch deletes what was written and fails.
 *
 * Only a document DELIVERY job may run it (a job a
 * `document_cards.delivery_job_id` in this business names — `isDeliveryJob`,
 * the Task 12 marker), checked before anything touches the disk. The base
 * folder's own copies are the owner's files: erasure lists them but never
 * deletes them (§9.3), which is why the result carries the absolute `path`.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { getPool, type Queryable } from '../db/pool.js';
import { SafeLookupKey } from '../domain/charter.js';
import type { DocumentKind } from '../domain/document-spec.js';
import { documentKindLabel } from '../domain/labels.js';
import { loadDocumentSettings } from '../governance/document-settings.js';
import { StepChannelError } from '../orchestrator/step-error.js';
import { stripBidiControls } from '../util/bidi.js';
import { isDeliveryJob, loadVersionFile, readVersionBytes } from './attachments.js';

export const DocSaveInput = z
  .object({
    producedVersionId: SafeLookupKey,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    folder: z.string().max(1000).nullable(),
    filename: z.string().min(1).max(200),
  })
  .strict();
export type DocSaveInput = z.infer<typeof DocSaveInput>;

export type SaveFailureCode =
  | 'save_not_supported'
  | 'save_no_base_folder'
  | 'save_not_found'
  | 'save_hash_mismatch'
  | 'save_name_mismatch'
  | 'save_folder_refused'
  | 'save_names_exhausted'
  | 'save_verify_failed';

export const SAVE_FAILURE_HE: Readonly<Record<SaveFailureCode, string>> = {
  save_not_supported: 'אפשר לשמור קובץ רק ממסמך שאושר — לא נשמר',
  save_no_base_folder: 'לא הוגדרה תיקיית בסיס לשמירה — אפשר להגדיר אותה בהגדרות',
  save_not_found: 'המסמך לשמירה לא נמצא — לא נשמר',
  save_hash_mismatch: 'המסמך השתנה מאז שאושר — לא נשמר',
  save_name_mismatch: 'שם הקובץ אינו השם שאושר — לא נשמר',
  save_folder_refused: 'התיקייה שבבקשה אינה תקינה — לא נשמר',
  save_names_exhausted: 'כבר יש בתיקייה 99 קבצים בשם הזה — לא נשמר',
  save_verify_failed: 'הקובץ שנכתב אינו זהה למסמך שאושר — הוא נמחק ולא נשמר',
};

export const MAX_FOLDER_SEGMENTS = 5;
export const MAX_FOLDER_CHARS = 200;
const MAX_NAME_SUFFIX = 99;

/** The allowlist, verbatim from the brief. A leading dot is refused separately. */
const SEGMENT_CHARS = /^[\p{L}\p{N} _.-]+$/u;
/**
 * Windows device names. `¹²³` because `\p{N}` admits them and Windows treats
 * `COM¹` … `LPT³` as devices too.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

const HE = {
  tooLong: `נתיב התיקייה ארוך מ-${MAX_FOLDER_CHARS} תווים`,
  absolute: 'התיקייה חייבת להיות יחסית לתיקיית הבסיס — בלי כונן ובלי נתיב מלא',
  tooDeep: `אפשר עד ${MAX_FOLDER_SEGMENTS} רמות תיקיות`,
  empty: 'יש בנתיב תיקייה בלי שם',
  dots: 'אסור ".." בשם תיקייה או קובץ',
  chars: 'שם תיקייה או קובץ מכיל תו אסור (מותרים אותיות, ספרות, רווח, מקף, קו תחתון ונקודה)',
  leadingDot: 'שם תיקייה או קובץ לא יכול להתחיל בנקודה',
  trailing: 'שם תיקייה או קובץ לא יכול להסתיים בנקודה או ברווח',
  reserved: (stem: string) => `"${stem}" הוא שם שמור ב-Windows`,
  link: 'בדרך לתיקייה יש קיצור דרך (קישור) — לא שומרים דרכו',
  notDirectory: 'בדרך לתיקייה יש קובץ באותו שם',
  escaped: 'התיקייה שנוצרה אינה בתוך תיקיית הבסיס',
  baseMissing: 'תיקיית הבסיס לא נמצאה',
} as const;

function segmentProblem(segment: string): string | null {
  if (segment === '') return HE.empty;
  if (segment.includes('..')) return HE.dots;
  if (!SEGMENT_CHARS.test(segment)) return HE.chars;
  if (segment.startsWith('.')) return HE.leadingDot;
  if (segment.endsWith('.') || segment.endsWith(' ')) return HE.trailing;
  const stem = (segment.split('.')[0] ?? '').trim();
  if (WINDOWS_RESERVED.test(stem)) return HE.reserved(stem);
  return null;
}

type Segments = { ok: true; segments: string[] } | { ok: false; he: string };

function folderSegments(folder: string | null, kind: DocumentKind): Segments {
  const cleaned = folder === null ? '' : stripBidiControls(folder).trim();
  if (cleaned === '') return { ok: true, segments: [documentKindLabel[kind]] };
  if (cleaned.length > MAX_FOLDER_CHARS) return { ok: false, he: HE.tooLong };
  if (/^[\\/]/.test(cleaned) || /^[A-Za-z]:/.test(cleaned) || isAbsolute(cleaned)) {
    return { ok: false, he: HE.absolute };
  }
  // One trailing separator ("חוזים/") is how people write a folder; an empty
  // segment anywhere else is refused below.
  const segments = cleaned.replace(/[\\/]$/, '').split(/[\\/]/);
  if (segments.length > MAX_FOLDER_SEGMENTS) return { ok: false, he: HE.tooDeep };
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== null) return { ok: false, he: problem };
  }
  return { ok: true, segments };
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Is this an entry the walk may enter? A link — wherever it points — is not. */
function walkProblem(info: Awaited<ReturnType<typeof lstat>>): string | null {
  if (info.isSymbolicLink()) return HE.link;
  if (!info.isDirectory()) return HE.notDirectory;
  return null;
}

export type SaveTarget = { ok: true; dir: string; name: string } | { ok: false; he: string };

/**
 * Validate the folder and the filename, then create the folder inside the
 * base — or refuse in Hebrew. See the module docblock for every rule.
 */
export async function resolveSaveTarget(
  baseFolder: string,
  folder: string | null,
  kind: DocumentKind,
  filename: string,
): Promise<SaveTarget> {
  const parsed = folderSegments(folder, kind);
  if (!parsed.ok) return parsed;
  const nameProblem = segmentProblem(filename);
  if (nameProblem !== null) return { ok: false, he: nameProblem };

  let realBase: string;
  try {
    realBase = await realpath(baseFolder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, he: HE.baseMissing };
    throw err;
  }

  // Read-only walk first: a link or a file anywhere on the existing part of
  // the path refuses before a single directory is created.
  let current = realBase;
  let firstMissing = parsed.segments.length;
  for (const [index, segment] of parsed.segments.entries()) {
    const candidate = join(current, segment);
    const info = await lstatOrNull(candidate);
    if (info === null) {
      firstMissing = index;
      break;
    }
    const problem = walkProblem(info);
    if (problem !== null) return { ok: false, he: problem };
    current = candidate;
  }

  // Create what is missing, one segment at a time; never `recursive`.
  for (const segment of parsed.segments.slice(firstMissing)) {
    const candidate = join(current, segment);
    try {
      await mkdir(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const info = await lstatOrNull(candidate);
    if (info === null) return { ok: false, he: HE.notDirectory };
    const problem = walkProblem(info);
    if (problem !== null) return { ok: false, he: problem };
    current = candidate;
  }

  const realDir = await realpath(current);
  const prefix = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (!realDir.startsWith(prefix)) return { ok: false, he: HE.escaped };
  return { ok: true, dir: realDir, name: filename };
}

function nameWithSuffix(name: string, n: number): string {
  if (n === 1) return name;
  const ext = extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  return `${stem} (${n})${ext}`;
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export type SaveFileResult = { ok: true; path: string } | { ok: false; code: SaveFailureCode; he: string };

/**
 * Write `bytes` into `dir` under `name` — or `name (2)` … `name (99)` — never
 * overwriting, then read the file back and compare its hash with
 * `expectedSha256`. A mismatch deletes what this call wrote.
 */
export async function saveVersionToFolder(
  dir: string,
  name: string,
  bytes: Buffer,
  expectedSha256: string,
): Promise<SaveFileResult> {
  for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
    const path = join(dir, nameWithSuffix(name, n));
    // Any entry at the name — a file, a folder, a link, a DANGLING link — is
    // taken. Checked before `wx` because Windows opens a dangling junction
    // under O_EXCL instead of answering EEXIST (measured on the dev machine);
    // `wx` stays as the race-proof layer for a file created in between.
    if ((await lstatOrNull(path)) !== null) continue;
    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    // What was opened must be the regular file this call just created. A
    // link swapped in between the check and the open is left alone (not
    // unlinked — it is not ours) and the next name is tried.
    const opened = await handle.stat();
    const entry = await lstatOrNull(path);
    if (!opened.isFile() || entry === null || !entry.isFile()) {
      await handle.close();
      continue;
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw err;
    }
    await handle.close();

    const written = await readFile(path);
    if (sha256Of(written) !== expectedSha256) {
      await unlink(path).catch(() => undefined);
      return { ok: false, code: 'save_verify_failed', he: SAVE_FAILURE_HE.save_verify_failed };
    }
    return { ok: true, path };
  }
  return { ok: false, code: 'save_names_exhausted', he: SAVE_FAILURE_HE.save_names_exhausted };
}

function refuse(code: SaveFailureCode, he: string = SAVE_FAILURE_HE[code]): StepChannelError {
  // Final, never retryable: the same payload against the same disk refuses
  // again, and a retry that eventually wrote would be a save nobody re-approved.
  return new StepChannelError(code, he, false);
}

/**
 * The `doc.save` step. Throws a `StepChannelError` with a Hebrew message on
 * every refusal; returns the absolute path that was written.
 */
export async function runDocSave(
  input: DocSaveInput,
  ctx: { jobId: string; businessId: string; db?: Queryable },
): Promise<{ performed: true; path: string }> {
  const db = ctx.db ?? getPool();
  if (!(await isDeliveryJob(ctx.businessId, ctx.jobId, db))) throw refuse('save_not_supported');

  const settings = await loadDocumentSettings({ businessId: ctx.businessId, db });
  if (settings.baseFolder === null) throw refuse('save_no_base_folder');

  const version = await loadVersionFile(input.producedVersionId, ctx.businessId, db);
  if (version === null) throw refuse('save_not_found');
  if (version.sha256 !== input.sha256) throw refuse('save_hash_mismatch');
  // Exact, as for attachments: the name the owner confirmed is the name saved.
  if (input.filename !== version.filename) throw refuse('save_name_mismatch');

  // The source is read (once) BEFORE the folder is created: a file that
  // changed on disk refuses without leaving an empty folder behind.
  const read = await readVersionBytes(version, { sha256: version.sha256, sizeBytes: version.sizeBytes });
  if (!read.ok) throw refuse(read.code === 'attachment_not_found' ? 'save_not_found' : 'save_hash_mismatch');

  const target = await resolveSaveTarget(settings.baseFolder, input.folder, version.kind, input.filename);
  if (!target.ok) throw refuse('save_folder_refused', target.he);

  const saved = await saveVersionToFolder(target.dir, target.name, read.bytes, version.sha256);
  if (!saved.ok) throw refuse(saved.code, saved.he);
  return { performed: true, path: saved.path };
}
