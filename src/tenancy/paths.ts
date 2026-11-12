/**
 * Where a business's files live on a shared server (spec §5.8).
 *
 * Three server-wide roots, one folder per business under each:
 *
 * - `DOCUMENT_ROOT/<businessId>` — every ingested document and every
 *   produced file (`produced/<businessId>/...` is ALREADY the shape of a
 *   stored path, so that tree is not re-rooted here — `stored_path` values
 *   begin with the business and are joined to `config.documentRoot` as they
 *   always were). What changes is the READER: `know.reader`'s subprocess
 *   `cwd` and the SDK gate's `isPathWithin` take the business folder, not the
 *   root, so a reader for one business cannot open another's document.
 * - `DOCUMENT_INBOX_ROOT/<businessId>` — the folder the inbox scan watches,
 *   with its `working/processed/rejected/failed` subfolders inside it.
 * - `DOCUMENT_SAVE_ROOT/<businessId>` — the only tree a business's `doc.save`
 *   base folder may sit in. Without it one owner could point her saves at a
 *   folder of another business on the same server.
 *
 * Every function here validates the id first: a business id is joined into a
 * filesystem path, and `..` or a separator in it would be a traversal. The
 * shape check (`isValidBusinessId`) admits neither.
 */
import { basename, join, resolve } from 'node:path';
import { config } from '../config.js';
import { isValidBusinessId } from '../db/pool.js';

function checkedId(businessId: string): string {
  if (!isValidBusinessId(businessId)) {
    // Not echoed: the id may be whatever a caller passed in.
    throw new Error('invalid business id for a filesystem path — expected ^[a-z0-9-]{3,63}$');
  }
  return businessId;
}

/** `<DOCUMENT_ROOT>/<businessId>` — the reader's root and the gate's path scope. */
export function businessDocumentRoot(businessId: string): string {
  return join(config.documentRoot, checkedId(businessId));
}

/** `<root>/<businessId>` for a server-wide root the caller holds (the inbox root, a test root). */
export function businessFolderUnder(root: string, businessId: string): string {
  return join(root, checkedId(businessId));
}

/**
 * `<DOCUMENT_SAVE_ROOT>/<businessId>`, or `null` when the server has no save
 * root — then no base folder is acceptable and `doc.save` cannot run at all.
 */
export function businessSaveRoot(businessId: string): string | null {
  return config.documentSaveRoot === null ? null : join(config.documentSaveRoot, checkedId(businessId));
}

/**
 * Is `folder` the folder of `businessId` — its last segment the business id?
 *
 * The positive check the reader's gate and the inbox scan make on the folder
 * they are HANDED, so a caller that passed a server root (or another
 * business's folder) is refused before anything is read. It does not prove
 * which root the folder sits under; the callers build it from the root.
 */
export function isFolderOfBusiness(folder: string, businessId: string): boolean {
  return isValidBusinessId(businessId) && basename(resolve(folder)) === businessId;
}
