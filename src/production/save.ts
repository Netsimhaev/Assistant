/**
 * `doc.save` — copy the exact approved file into a folder the owner named,
 * always inside the base folder she configured (document production §9.2).
 *
 * Path safety is the whole point, and every rule is positive:
 *
 * - **A folder is a sequence of relative segments, each checked by
 *   `nameProblem`** (`name-rules.ts` — the same rule `validateSpec` applies to
 *   the spec filename), never a path that is "cleaned". Bidi controls are
 *   stripped first, so an override cannot make the owner read one name while
 *   the disk gets another. Refused here on top: anything absolute, a drive
 *   letter, a UNC share, an empty segment, more than five segments, more than
 *   200 characters. A `null` folder is the kind label. The filename passes the
 *   same rule. A path the filesystem still finds too long (`ENAMETOOLONG`) is
 *   the same Hebrew folder refusal, never a crash.
 * - **Directories are walked one segment at a time, and a link is refused
 *   even when it points back inside.** First a read-only walk over the
 *   segments that already exist — any link or non-directory refuses before
 *   anything is created — then the missing segments are made one `mkdir` at
 *   a time (never `recursive`), each re-`lstat`ed. Then the created
 *   directory's `realpath` must start with the base's `realpath` plus a
 *   separator. **What that backstop does and does not cover, honestly:** if a
 *   link is swapped into an existing segment between the walk and a later
 *   `mkdir`, that `mkdir` goes through the link and an EMPTY directory may be
 *   created OUTSIDE the base before the `realpath` check refuses. No file is
 *   ever written there — the file is opened only after the check passes.
 *   Swapping a link into the owner's folder needs local write access to it,
 *   which is already more than this tool could grant.
 * - **A file is never overwritten.** A name with any entry at it (a link, a
 *   dangling link included) is taken; the open is `wx+` (O_CREAT|O_EXCL). On
 *   `EEXIST` the next name is ` (2)` … ` (99)` before the extension, and past
 *   that a Hebrew refusal. **Windows residual:** O_EXCL there does NOT refuse a
 *   dangling junction (measured on the dev machine: the open succeeds and the
 *   write fails `EISDIR`). The `lstat` before the open catches the static case;
 *   a junction swapped in between the two is caught by the post-open identity
 *   check (the opened handle must be a regular file with the same dev/ino as
 *   the path's `lstat`), which closes it untouched and moves on. A junction
 *   can only point at a directory, so a file can never be written through one;
 *   a file symlink needs admin or developer mode on Windows.
 * - **The bytes written are the bytes approved, checked through the handle.**
 *   The source is read once and hashed (`readVersionBytes`, shared with the
 *   mail attachment resolver), the same buffer is written and `sync`ed, then
 *   read back through the SAME handle from position 0 and re-hashed. On a
 *   mismatch, or a write error, the handle's file is truncated to zero and the
 *   path is unlinked ONLY if its `lstat` dev/ino still equals the handle's —
 *   a name re-pointed in between is never deleted, because it is not ours.
 *
 * Only a document DELIVERY job may run it (a job a
 * `document_cards.delivery_job_id` in this business names), and only for the
 * version that card shows (`deliveryVersionOf`), checked before anything
 * touches the disk. The base
 * folder's own copies are the owner's files: erasure lists them but never
 * deletes them (§9.3), which is why the result carries the absolute `path`
 * and why it is recorded on the delivery row (`recordSavedPath`, migration 057).
 */
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { getPool, type Queryable } from '../db/pool.js';
import { SafeLookupKey } from '../domain/charter.js';
import type { DocumentKind } from '../domain/document-spec.js';
import { documentKindLabel } from '../domain/labels.js';
import { loadDocumentSettings } from '../governance/document-settings.js';
import { StepChannelError } from '../orchestrator/step-error.js';
import { stripBidiControls } from '../util/bidi.js';
import { deliveryVersionOf, loadVersionFile, readVersionBytes } from './attachments.js';
import { MAX_SEGMENT_BYTES, nameProblem } from './name-rules.js';

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

const HE = {
  tooLong: `נתיב התיקייה ארוך מ-${MAX_FOLDER_CHARS} תווים`,
  absolute: 'התיקייה חייבת להיות יחסית לתיקיית הבסיס — בלי כונן ובלי נתיב מלא',
  tooDeep: `אפשר עד ${MAX_FOLDER_SEGMENTS} רמות תיקיות`,
  link: 'בדרך לתיקייה יש קיצור דרך (קישור) — לא שומרים דרכו',
  notDirectory: 'בדרך לתיקייה יש קובץ באותו שם',
  escaped: 'התיקייה שנוצרה אינה בתוך תיקיית הבסיס',
  baseMissing: 'תיקיית הבסיס לא נמצאה',
  pathTooLong: 'הנתיב ארוך מדי למערכת הקבצים — לא נשמר',
} as const;

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
    const problem = nameProblem(segment);
    if (problem !== null) return { ok: false, he: problem };
  }
  return { ok: true, segments };
}

const isNameTooLong = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENAMETOOLONG';

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Is this an entry the walk may enter? A link — wherever it points — is not. */
function walkProblem(info: BigIntStats): string | null {
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
  const filenameIssue = nameProblem(filename);
  if (filenameIssue !== null) return { ok: false, he: filenameIssue };
  try {
    return await createInsideBase(baseFolder, parsed.segments, filename);
  } catch (err) {
    if (isNameTooLong(err)) return { ok: false, he: HE.pathTooLong };
    throw err;
  }
}

async function createInsideBase(baseFolder: string, segments: string[], filename: string): Promise<SaveTarget> {
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
  let firstMissing = segments.length;
  for (const [index, segment] of segments.entries()) {
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
  for (const segment of segments.slice(firstMissing)) {
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

const sameEntry = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Empty the handle's file, then unlink the path only if it still names that
 * very file. A path re-pointed since the open is not ours to delete.
 */
async function discard(handle: FileHandle, path: string): Promise<void> {
  await handle.truncate(0).catch(() => undefined);
  const mine = await handle.stat({ bigint: true }).catch(() => null);
  const there = await lstatOrNull(path).catch(() => null);
  if (mine !== null && there !== null && there.isFile() && sameEntry(mine, there)) {
    await unlink(path).catch(() => undefined);
  }
}

/** The whole file, read through the handle from position 0. */
async function readBack(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export type SaveFileResult = { ok: true; path: string } | { ok: false; code: SaveFailureCode; he: string };

/**
 * Write `bytes` into `dir` under `name` — or `name (2)` … `name (99)` — never
 * overwriting, then read the file back through the same handle and compare
 * its hash with `expectedSha256`. A mismatch discards what this call wrote.
 */
export async function saveVersionToFolder(
  dir: string,
  name: string,
  bytes: Buffer,
  expectedSha256: string,
  options: {
    /** The read-back through the handle — injectable so a test can make it throw. */
    readBack?: (handle: FileHandle, size: number) => Promise<Buffer>;
  } = {},
): Promise<SaveFileResult> {
  for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
    const candidateName = nameWithSuffix(name, n);
    // The suffix can push a name the rule accepted past the component limit
    // (`MAX_SEGMENT_BYTES`). Refused here, the same on every OS — Windows
    // answers such a name with ENOENT/EINVAL rather than ENAMETOOLONG.
    if (Buffer.byteLength(candidateName, 'utf8') > MAX_SEGMENT_BYTES) {
      return { ok: false, code: 'save_folder_refused', he: HE.pathTooLong };
    }
    const path = join(dir, candidateName);
    // Any entry at the name — a dangling link included — is taken. Before the
    // open because Windows opens a dangling junction under O_EXCL.
    if ((await lstatOrNull(path)) !== null) continue;
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx+');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if (isNameTooLong(err)) return { ok: false, code: 'save_folder_refused', he: HE.pathTooLong };
      throw err;
    }
    try {
      // What was opened must be the regular file at this path, by identity.
      // Anything else (a junction swapped in) is closed untouched — not ours.
      const opened = await handle.stat({ bigint: true });
      const entry = await lstatOrNull(path);
      if (!opened.isFile() || entry === null || !entry.isFile() || !sameEntry(opened, entry)) continue;

      try {
        await handle.write(bytes, 0, bytes.length, 0);
        await handle.sync();
      } catch (err) {
        await discard(handle, path);
        throw err;
      }

      // A read-back or hash that throws must not leave an unverified file
      // behind: discard it, then rethrow.
      let digest: string;
      try {
        const written = await (options.readBack ?? readBack)(handle, bytes.length + 1);
        digest = createHash('sha256').update(written).digest('hex');
      } catch (err) {
        await discard(handle, path);
        throw err;
      }
      if (digest !== expectedSha256) {
        await discard(handle, path);
        return { ok: false, code: 'save_verify_failed', he: SAVE_FAILURE_HE.save_verify_failed };
      }
      return { ok: true, path };
    } finally {
      await handle.close().catch(() => undefined);
    }
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
  // The version must be the one the owner approved on the card that created
  // this delivery job (Task 14, carry (b)) — checked before any disk read.
  const approved = await deliveryVersionOf(ctx.businessId, ctx.jobId, db);
  if (approved === null || approved !== input.producedVersionId) throw refuse('save_not_supported');

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
  await recordSavedPath(ctx, saved.path, db);
  return { performed: true, path: saved.path };
}

/**
 * Where the copy landed, on this delivery job's own `document_deliveries`
 * row (migration 057) — the only record of it: a local step's output is not
 * persisted, and the written name may carry a " (2)" suffix the plan never
 * knew. An erasure of the person the document was for lists the path under
 * "נשארים בתיקייה שלך" and never deletes the file (spec C7).
 *
 * **A failure here does not fail the save.** The file is written and
 * verified; failing the step would tell the owner the save failed while his
 * copy sits on disk. The cost, recorded in CLAUDE.md's known issues: such a
 * copy is missing from a later erasure preview. Logged, so it is not silent.
 */
async function recordSavedPath(
  ctx: { jobId: string; businessId: string },
  path: string,
  db: Queryable,
): Promise<void> {
  try {
    await db.query(
      `UPDATE document_deliveries SET saved_path = $3, saved_at = now()
        WHERE business_id = $1 AND job_id = $2`,
      [ctx.businessId, ctx.jobId, path],
    );
  } catch (err) {
    console.error(`doc.save: the copy for job ${ctx.jobId} was written but its path was not recorded`, err);
  }
}
