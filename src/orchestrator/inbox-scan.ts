/**
 * Loop A — the folder scan. No model calls, no money, no judgement.
 *
 * Deliberately separate from the understanding loop (`conduct.ts`). This half
 * is cheap and deterministic; that half is expensive and not. Keeping them
 * apart means the daily ceiling applies only to what actually costs, and a
 * model outage still lets files enter the system.
 */
import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ingestDocument } from '../documents/ingest.js';

export interface ScanInboxOptions {
  inbox: string;
  businessId?: string;
  documentRoot?: string;
}

export interface ScanResult {
  /** Ingest reported `extracted`. */
  ingested: number;
  /** Ingest reported `rejected` — a fact about the document. */
  rejected: number;
  /** Ingest reported `pending` — stuck, terminal, and never a success. */
  failed: number;
  /** Ingest threw. A fault, not a verdict; the file goes back for a retry. */
  deferred: number;
  /** Could not be claimed this pass — almost always still being written. */
  skipped: number;
}

const WORKING = 'working';
const PROCESSED = 'processed';
const REJECTED = 'rejected';
const FAILED = 'failed';
const SUBDIRS = [WORKING, PROCESSED, REJECTED, FAILED];

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * Move `from` to `dir`, without ever overwriting what is already there.
 *
 * Two different files may legitimately share a name — the owner saves
 * "חוזה.docx" twice a month — and the folder is the owner's own record of what
 * happened. Silently replacing one with the other destroys that record.
 *
 * Reserves each candidate name with `link` (a hard link), not `stat` then
 * `rename`: `stat`-then-`rename` has a gap between checking a name is free
 * and claiming it, and `rename` itself overwrites an existing destination on
 * every platform Node targets — exactly the outcome this function exists to
 * prevent. `link` fails atomically with `EEXIST` when the name is taken,
 * which makes "is it free" and "claim it" one filesystem operation; on
 * success the original name is removed with `unlink`, completing the move.
 *
 * Falls back to a plain `rename` only when `link` cannot work at all —
 * `EXDEV` (`from` and `dir` are on different devices) or `EPERM` (a
 * filesystem without hard-link support). That fallback is **not** atomic: a
 * concurrent claim of the same candidate name in the narrow window between
 * its `stat` and its `rename` can still lose the race there. It exists only
 * because there is nothing better to do on a filesystem that cannot link.
 */
async function moveWithoutClobber(from: string, dir: string, name: string): Promise<void> {
  const ext = extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    const target = join(dir, candidate);
    try {
      await link(from, target);
      await unlink(from);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (code === 'EEXIST') continue; // taken; try the next suffix

      if (code === 'EXDEV' || code === 'EPERM') {
        // No hard-link support here. Not atomic — see the docblock above —
        // but it is the only option left when linking itself cannot work.
        try {
          await stat(target);
          continue;
        } catch {
          await rename(from, target);
          return;
        }
      }

      throw err;
    }
  }
}

/**
 * Ingest every file sitting in the inbox root.
 *
 * **Claiming is the write-in-progress check.** A file still open for writing
 * cannot be renamed, so the attempt to move it into `working/` doubles as the
 * test for whether it is finished. A separate "is it still being written"
 * check would be a check with a gap after it: the file could be complete when
 * asked and half-written when read.
 */
export async function scanInbox(options: ScanInboxOptions): Promise<ScanResult> {
  const { inbox } = options;
  const scope = {
    ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
    ...(options.documentRoot !== undefined ? { documentRoot: options.documentRoot } : {}),
  };

  for (const sub of SUBDIRS) {
    try {
      await mkdir(join(inbox, sub), { recursive: true });
    } catch (err) {
      if (errorCode(err) === 'EEXIST') {
        // recursive mkdir does not throw when the target is already a
        // directory — only when a plain file already occupies the name. A
        // reserved subdirectory name that is a file bricks every future
        // scan at this same line, so this must be loud, not a silent skip.
        throw new Error(
          `לא ניתן להקים את תיקיית "${sub}" בתוך תיבת הקלט: יש כבר קובץ (לא תיקייה) בנתיב ${join(inbox, sub)}. יש להעביר או למחוק אותו כדי שהסריקה תוכל להמשיך.`,
        );
      }
      throw err;
    }
  }

  const entries = await readdir(inbox, { withFileTypes: true });
  const result: ScanResult = { ingested: 0, rejected: 0, failed: 0, deferred: 0, skipped: 0 };

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const name = basename(entry.name);
    const claimed = join(inbox, WORKING, name);

    try {
      await rename(join(inbox, name), claimed);
    } catch {
      result.skipped += 1;
      continue;
    }

    let document;
    try {
      document = await ingestDocument(
        { path: claimed, source: 'manual', originalName: name },
        scope,
      );
    } catch {
      // A throw out of ingestDocument is a genuine fault — the database
      // unreachable, the disk full, a transient failure inside its own
      // transaction — never a verdict about this document. Every
      // document-level outcome, hostile or malformed included, comes back
      // as a returned `status` instead of a throw. Filing a fault into
      // `rejected/` would permanently mislabel a perfectly good document as
      // bad in the one place meant to be the owner's honest record, and a
      // real outage would do that to every remaining file in the pass. Move
      // the claimed copy back to the inbox root instead, so the next scan
      // retries it.
      try {
        await moveWithoutClobber(claimed, inbox, name);
      } catch {
        // The recovery move itself failed — the same class of fault (full
        // disk, permissions) that made ingestDocument throw in the first
        // place. The file stays in `working/`, which a future scan does not
        // look inside, so it will not be retried automatically; someone
        // must move it back to the inbox root by hand. Still counted below,
        // and — this is the point — swallowed here rather than left to
        // abort the rest of the batch: one fault must not stop every file
        // still waiting behind it.
      }
      result.deferred += 1;
      continue;
    }

    // Decided positively — `DocumentStatus` is three-way, and there is no
    // permissive `else` left to swallow a value none of these three named.
    if (document.status === 'extracted') {
      await moveWithoutClobber(claimed, join(inbox, PROCESSED), name);
      result.ingested += 1;
    } else if (document.status === 'rejected') {
      await moveWithoutClobber(claimed, join(inbox, REJECTED), name);
      result.rejected += 1;
    } else if (document.status === 'pending') {
      // Terminal and never a success (see ingest.ts's own docblock): a
      // `writeFile` throw, a transient failure inside `markExtracted`'s
      // transaction after extraction already ran, or the process being
      // killed mid-ingest. `insertOrGetDocument` hands back this same stuck
      // row — without throwing — for every later arrival of the same bytes,
      // so this is not a one-off outcome to shrug off: it must never be
      // counted as ingested.
      await moveWithoutClobber(claimed, join(inbox, FAILED), name);
      result.failed += 1;
    }
  }

  return result;
}
