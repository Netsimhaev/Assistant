/**
 * Loop A — the folder scan. No model calls, no money, no judgement.
 *
 * Deliberately separate from the understanding loop (`conduct.ts`). This half
 * is cheap and deterministic; that half is expensive and not. Keeping them
 * apart means the daily ceiling applies only to what actually costs, and a
 * model outage still lets files enter the system.
 */
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ingestDocument } from '../documents/ingest.js';

export interface ScanInboxOptions {
  inbox: string;
  businessId?: string;
  documentRoot?: string;
}

export interface ScanResult {
  ingested: number;
  rejected: number;
  /** Files that could not be claimed this pass — almost always still being written. */
  skipped: number;
}

const WORKING = 'working';
const PROCESSED = 'processed';
const REJECTED = 'rejected';
const SUBDIRS = [WORKING, PROCESSED, REJECTED];

/**
 * Move `from` to `dir`, without ever overwriting what is already there.
 *
 * Two different files may legitimately share a name — the owner saves
 * "חוזה.docx" twice a month — and the folder is the owner's own record of what
 * happened. Silently replacing one with the other destroys that record.
 */
async function moveWithoutClobber(from: string, dir: string, name: string): Promise<void> {
  const ext = extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    const target = join(dir, candidate);
    try {
      await stat(target);
      continue; // taken; try the next suffix
    } catch {
      await rename(from, target);
      return;
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
    await mkdir(join(inbox, sub), { recursive: true });
  }

  const entries = await readdir(inbox, { withFileTypes: true });
  const result: ScanResult = { ingested: 0, rejected: 0, skipped: 0 };

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

    // One bad document must not stop the batch — the same rule `ingestDocument`
    // already keeps internally for a hostile file.
    try {
      const document = await ingestDocument(
        { path: claimed, source: 'manual', originalName: name },
        scope,
      );
      if (document.status === 'rejected') {
        await moveWithoutClobber(claimed, join(inbox, REJECTED), name);
        result.rejected += 1;
      } else {
        await moveWithoutClobber(claimed, join(inbox, PROCESSED), name);
        result.ingested += 1;
      }
    } catch {
      await moveWithoutClobber(claimed, join(inbox, REJECTED), name);
      result.rejected += 1;
    }
  }

  return result;
}
