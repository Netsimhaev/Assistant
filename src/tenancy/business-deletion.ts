/**
 * Deleting a whole business — the tenancy half (spec
 * docs/superpowers/specs/2026-11-19-business-deletion-design.md).
 *
 * Three steps, in this order, each one its own call so a retry can re-run
 * only what did not finish:
 *
 * 1. `deleteBusinessRows` — in ONE platform transaction: lock the registry
 *    row, re-check every guard against what the database says now (the head
 *    admin, the suspension, the exact name, no scheduler pass in flight), run
 *    `delete_business_rows` (migration 081 — every table, found at call time),
 *    and set the status to `deleting`. A refusal changes nothing.
 * 2. `deleteBusinessFiles` — the document and inbox folders. Never the save
 *    folder: those are the owner's own copies on her machine's share
 *    (`doc.save`), and a business re-created with the same id is refused
 *    while it still holds a file (`createBusiness`).
 * 3. `finishDeletion` — the registry row, last, and only once both folders
 *    are gone. Until then the status `deleting` keeps the id taken and lets
 *    the head admin retry the file step.
 *
 * Nothing here writes an activity-log row or an audit row: the caller records
 * the action, and the business's own audit chain is one of the things deleted.
 *
 * Cross-business by nature, so it runs on the platform pool and is one of the
 * named functions in the closed list (CLAUDE.md, "ריבוי עסקים"). It is the
 * only production file that names `delete_business_rows` (pinned by
 * `business-deletion.test.ts`).
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { config } from '../config.js';
import { isValidBusinessId } from '../db/pool.js';
import { withPlatform } from '../db/platform-pool.js';
import { businessFolders } from './paths.js';

export type DeletionRefusal = 'not_head' | 'not_suspended' | 'name_mismatch' | 'pass_in_flight' | 'unknown_business';

/** What the head admin reads when a deletion is refused. Plain Hebrew. */
export const DELETION_REFUSAL_HE: Readonly<Record<DeletionRefusal, string>> = {
  not_head: 'רק מנהל ראשי יכול למחוק עסק.',
  not_suspended: 'אפשר למחוק רק עסק מושהה. יש להשהות את העסק קודם.',
  name_mismatch: 'השם שהוקלד אינו תואם בדיוק את שם העסק.',
  pass_in_flight: 'העוזרת עובדת על העסק הזה ברגע זה. כדאי לנסות שוב בעוד כמה דקות.',
  unknown_business: 'העסק לא נמצא.',
};

/**
 * Ruling 4: a pass is in flight when it started after the last one finished,
 * and started less than 30 minutes ago — a pass that crashed without ending
 * stops blocking after that. On the database clock, never the process's.
 */
const PASS_IN_FLIGHT_SQL = `(pass_started_at IS NOT NULL
   AND pass_started_at > coalesce(pass_finished_at, '-infinity'::timestamptz)
   AND pass_started_at > now() - interval '30 minutes')`;

/** The scheduler's heartbeat at the start of one business's pass. */
export async function recordPassStart(businessId: string): Promise<void> {
  await withPlatform((db) =>
    db.query('UPDATE businesses SET pass_started_at = now() WHERE business_id = $1', [businessId]),
  );
}

/** The scheduler's heartbeat at the end of one business's pass. */
export async function recordPassEnd(businessId: string): Promise<void> {
  await withPlatform((db) =>
    db.query('UPDATE businesses SET pass_finished_at = now() WHERE business_id = $1', [businessId]),
  );
}

/** Is a scheduler pass of this business running now (Ruling 4)? `false` for an unknown business. */
export async function passInFlight(businessId: string): Promise<boolean> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ in_flight: boolean }>(
      `SELECT ${PASS_IN_FLIGHT_SQL} AS in_flight FROM businesses WHERE business_id = $1`,
      [businessId],
    );
    return rows[0]?.in_flight === true;
  });
}

export interface DeleteBusinessRowsInput {
  businessId: string;
  /** The staff member asking — re-checked here as a live head admin. */
  staffId: string;
  /** The business's name as the head admin typed it. Only its ends are trimmed. */
  typedName: string;
}

export type DeleteBusinessRowsResult =
  | { ok: true; tables: { table: string; deleted: number }[] }
  | { ok: false; refusal: DeletionRefusal };

/**
 * The row step. Every guard is read inside the transaction, after the
 * registry row is locked, so what the panel showed when the page loaded
 * decides nothing: a head role removed since, a business resumed since, a
 * pass that started since — each refuses.
 *
 * The name must match exactly after trimming both ends: no case folding, no
 * collapsing of inner spaces, no stripping of invisible marks. A name typed
 * with a doubled space or a hidden direction mark is not the name.
 *
 * A business already `deleting` is refused (`not_suspended`): its rows are
 * gone, and a retry re-runs only the file step (`deleteBusinessFiles`, then
 * `finishDeletion`).
 */
export async function deleteBusinessRows(input: DeleteBusinessRowsInput): Promise<DeleteBusinessRowsResult> {
  const { businessId, staffId, typedName } = input;
  // A malformed id cannot be a registered business; the function would refuse it too.
  if (!isValidBusinessId(businessId)) return { ok: false, refusal: 'unknown_business' };
  return withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      const refuse = async (refusal: DeletionRefusal): Promise<DeleteBusinessRowsResult> => {
        await db.query('ROLLBACK');
        return { ok: false, refusal };
      };
      const { rows: bizRows } = await db.query<{ display_name: string; status: string; in_flight: boolean }>(
        `SELECT display_name, status, ${PASS_IN_FLIGHT_SQL} AS in_flight
           FROM businesses WHERE business_id = $1 FOR UPDATE`,
        [businessId],
      );
      const biz = bizRows[0];
      if (biz === undefined) return await refuse('unknown_business');

      // FOR SHARE: a concurrent removal of the head role waits for this
      // transaction rather than slipping in between the check and the delete.
      const { rows: staffRows } = await db.query(
        'SELECT 1 FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL AND is_head FOR SHARE',
        [staffId],
      );
      if (staffRows.length === 0) return await refuse('not_head');
      if (biz.status !== 'suspended') return await refuse('not_suspended');
      if (typedName.trim() !== biz.display_name.trim()) return await refuse('name_mismatch');
      if (biz.in_flight) return await refuse('pass_in_flight');

      const { rows: deleted } = await db.query<{ table_name: string; deleted: string }>(
        'SELECT table_name, deleted FROM delete_business_rows($1)',
        [businessId],
      );
      await db.query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [businessId]);
      await db.query('COMMIT');
      return {
        ok: true,
        tables: deleted.map((r) => ({ table: r.table_name, deleted: Number(r.deleted) })),
      };
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/**
 * How many files (anything that is not a directory, links included) sit
 * under `folder`, recursively. A missing folder holds none.
 */
export async function countFilesUnder(folder: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  return entries.filter((e) => !e.isDirectory()).length;
}

type RmFn = (path: string, options: { recursive: true; force: true }) => Promise<void>;

/** Test seam only; ignored outside tests. */
export interface DeleteFilesTestSeam {
  rm?: RmFn;
}

/** The document and inbox folders of a business, each with a label for its root. */
function deletableFolders(businessId: string): Array<{ label: string; root: string; folder: string }> {
  const folders = businessFolders(businessId);
  const out = [{ label: 'DOCUMENT_ROOT', root: config.documentRoot, folder: folders.document }];
  if (folders.inbox !== null && config.documentInboxRoot !== null) {
    out.push({ label: 'DOCUMENT_INBOX_ROOT', root: config.documentInboxRoot, folder: folders.inbox });
  }
  return out;
}

/**
 * The file step: removes `<DOCUMENT_ROOT>/<id>` and `<DOCUMENT_INBOX_ROOT>/<id>`
 * whole. Never the save folder. `removed` counts the files under each folder
 * that was removed (counted before removing); `failed` names each folder that
 * could not be removed by its root's name and the path under it — never an
 * absolute server path, since it reaches a screen.
 */
export async function deleteBusinessFiles(
  businessId: string,
  testSeam?: DeleteFilesTestSeam,
): Promise<{ removed: number; failed: string[] }> {
  const remove: RmFn = (config.isTest ? testSeam?.rm : undefined) ?? rm;
  let removed = 0;
  const failed: string[] = [];
  for (const { label, root, folder } of deletableFolders(businessId)) {
    const under = relative(root, folder).split(sep).join('/');
    try {
      const count = await countFilesUnder(folder);
      await remove(folder, { recursive: true, force: true });
      removed += count;
    } catch {
      failed.push(`${label}/${under}`);
    }
  }
  return { removed, failed };
}

async function folderExists(folder: string): Promise<boolean> {
  try {
    await lstat(folder);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * The last step: deletes the registry row — only while its status is
 * `deleting` and only once the document and inbox folders no longer exist.
 * The save folder is not checked (it is never removed). Returns whether it
 * removed the row.
 */
export async function finishDeletion(businessId: string): Promise<boolean> {
  if (!isValidBusinessId(businessId)) return false;
  for (const { folder } of deletableFolders(businessId)) {
    if (await folderExists(folder)) return false;
  }
  return withPlatform(async (db) => {
    const { rowCount } = await db.query(
      `DELETE FROM businesses WHERE business_id = $1 AND status = 'deleting'`,
      [businessId],
    );
    return (rowCount ?? 0) > 0;
  });
}
