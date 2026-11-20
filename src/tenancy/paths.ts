/**
 * Where a business's files live on a shared server (spec §5.8).
 *
 * Three server-wide roots, one folder per business under each:
 *
 * - `DOCUMENT_ROOT/<businessId>` — every ingested document. Produced files
 *   are NOT under it: they live in `DOCUMENT_ROOT/produced/<businessId>/…`
 *   (the production loop's stored-path shape, `produced/<businessId>/
 *   <productionId>/…`, joined to `config.documentRoot` as it always was), a
 *   sibling tree that `businessFolders(...).produced` names and whole-business
 *   deletion removes. What changes is the READER: `know.reader`'s subprocess
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
import { readdir } from 'node:fs/promises';
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

/** The three folders of one business on the server; `null` where the server has no such root. */
export interface BusinessFolders {
  /** `<DOCUMENT_ROOT>/<businessId>` — ingested documents and the logo. */
  document: string;
  /** `<DOCUMENT_ROOT>/produced/<businessId>` — the files the production loop wrote. */
  produced: string;
  /** `<DOCUMENT_INBOX_ROOT>/<businessId>`, or `null` when the server has no inbox root. */
  inbox: string | null;
  /** `<DOCUMENT_SAVE_ROOT>/<businessId>`, or `null` when the server has no save root. */
  save: string | null;
}

/**
 * Every folder a business owns on the server, each the business id joined as
 * ONE segment under its root — so `acme` and `acme-2` are siblings, never one
 * inside the other's name. A caller compares or removes these folders whole;
 * it never tests a path with a string prefix (`startsWith`), which would take
 * `acme-2` for part of `acme`.
 */
export function businessFolders(businessId: string): BusinessFolders {
  const id = checkedId(businessId);
  return {
    document: join(config.documentRoot, id),
    produced: join(config.documentRoot, 'produced', id),
    inbox: config.documentInboxRoot === null ? null : join(config.documentInboxRoot, id),
    save: config.documentSaveRoot === null ? null : join(config.documentSaveRoot, id),
  };
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
