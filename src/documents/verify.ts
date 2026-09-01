/**
 * `verifyDocumentUnchanged` — the control the whole signing feature rests
 * on. A signature attesting to a hash nobody re-measured is worth nothing:
 * it would name a file while a different one sits on disk. This function
 * re-reads the stored bytes at signing time, hashes them exactly as intake
 * did (`createHash('sha256').update(bytes).digest('hex')`, see
 * `ingest.ts`), and compares against `documents.sha256` as recorded then.
 *
 * Four outcomes, none of them thrown — a missing file and an edited file
 * are both facts about the document, not faults, and the caller needs to
 * tell them apart to write a refusal a person can act on:
 *
 * - `unknown_document` — this business does not own `documentId`
 *   (`loadDocument` returns `null`).
 * - `missing` — the row exists but the file at `stored_path` could not be
 *   read (deleted, moved, permissions). The read error is caught here and
 *   never propagates.
 * - `changed` — the file reads fine but hashes to something other than
 *   what intake recorded.
 * - `unchanged` — the file still hashes to what intake recorded.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { loadDocument } from './store.js';

export type VerifyOutcome =
  | { status: 'unchanged'; sha256: string }
  | { status: 'changed'; expected: string; actual: string }
  | { status: 'missing' }
  | { status: 'unknown_document' };

export async function verifyDocumentUnchanged(
  documentId: string,
  options: { businessId?: string; db?: Queryable; documentRoot?: string } = {},
): Promise<VerifyOutcome> {
  const documentRoot = options.documentRoot ?? config.documentRoot;

  const document = await loadDocument(documentId, {
    ...(options.businessId !== undefined ? { businessId: options.businessId } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
  if (document === null) return { status: 'unknown_document' };

  const absolutePath = join(documentRoot, document.storedPath);

  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    // A missing (or otherwise unreadable) file is a fact about the
    // document, not a fault in this call — the caller writes a refusal,
    // not a stack trace.
    return { status: 'missing' };
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== document.sha256) {
    return { status: 'changed', expected: document.sha256, actual };
  }
  return { status: 'unchanged', sha256: actual };
}
