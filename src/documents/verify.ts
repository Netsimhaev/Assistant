/**
 * `verifyDocumentUnchanged` — the control the whole signing feature rests
 * on. A signature attesting to a hash nobody re-measured is worth nothing:
 * it would name a file while a different one sits on disk. This function
 * re-reads the stored bytes at signing time, hashes them exactly as intake
 * did (`createHash('sha256').update(bytes).digest('hex')`, see
 * `ingest.ts`), and compares against `documents.sha256` as recorded then.
 *
 * Five outcomes, none of them thrown — a missing file, an unreadable file
 * and an edited file are all facts about the document, not faults, and the
 * caller needs to tell them apart to write a refusal a person can act on:
 *
 * - `unknown_document` — this business does not own `documentId`
 *   (`loadDocument` returns `null`).
 * - `missing` — the file at `stored_path` genuinely is not there (`ENOENT`
 *   specifically). Someone deleted or moved it.
 * - `unreadable` — the read failed for any other reason: a permissions
 *   error (`EACCES`), a directory sitting where the file should be
 *   (`EISDIR`), or anything else Node's filesystem layer can throw.
 *   `missing` is deliberately narrow rather than a catch-all — a
 *   permissions misconfiguration reported as "someone deleted the file"
 *   sends an operator looking in the wrong place. An error with no `code`
 *   at all still lands here, never in `missing`: an unrecognised failure is
 *   never the more specific claim.
 * - `changed` — the file reads fine but hashes to something other than
 *   what intake recorded.
 * - `unchanged` — the file still hashes to what intake recorded.
 *
 * The read error is caught here and never propagates — the caller renders
 * a refusal, not a stack trace.
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
  | { status: 'unreadable'; cause: string }
  | { status: 'unknown_document' };

/**
 * Node's fs errors carry a `code` (`ENOENT`, `EACCES`, `EISDIR`, …) as an
 * `errno.SystemError`, but that type isn't part of the `catch` clause's
 * static type — narrow it defensively rather than assume the shape.
 */
function readErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A human-renderable cause for `unreadable` — never the whole error object or a stack. */
function readErrorCause(err: unknown, code: string | undefined): string {
  if (code !== undefined) return code;
  return err instanceof Error ? err.message : String(err);
}

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
  } catch (err) {
    const code = readErrorCode(err);
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', cause: readErrorCause(err, code) };
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== document.sha256) {
    return { status: 'changed', expected: document.sha256, actual };
  }
  return { status: 'unchanged', sha256: actual };
}
