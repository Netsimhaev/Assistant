/**
 * `ingestDocument` — the single entry point for the intake pipeline (spec
 * §3.5, §5.5, §8). Everything else under `src/documents/` is a piece this
 * file composes; the order it calls them in *is* the design, not an
 * implementation detail:
 *
 *   hash the bytes → deduplicate → size cap → sniff the type from content
 *   → store under the document root → archive guard for ZIP-container
 *   types, before spawning anything → runExtractor → buildOutline →
 *   markExtracted
 *
 * **Rejection is a recorded status, never a thrown exception.** Every
 * failure branch below calls `markRejected` with a Hebrew reason and
 * returns the resulting record — the same principle the orchestrator
 * already holds for a failed plan step: one hostile or malformed document
 * must never stop a caller from ingesting the rest of a batch. The one
 * exception is a genuine fault — the database being unreachable, a thrown
 * `TypeError` from a caller's own bad input — which still propagates,
 * because that is not a property of the document being ingested.
 *
 * **The original filename is never a path.** `input.originalName` (or, if
 * omitted, `basename(input.path)`) is stored verbatim in `original_name`
 * and used nowhere else — `stored_path` is built entirely from
 * system-generated ids (`businessId`, a fresh `documentId`) and the
 * *sniffed* media type's own extension, never from anything the caller or
 * a remote sender supplied (§5.5). A name containing `..` or a path
 * separator is inert data in that column.
 *
 * **A rejected document keeps its stored file.** Every rejection branch
 * below runs after the bytes are already written to disk — so someone can
 * open `stored_path` and see why a document was refused. The two branches
 * that must cost nothing on a hostile file — an unsupported type and a
 * malicious archive — both still write the file first: identifying a type
 * from a few kilobytes of header and reading a ZIP's central directory are
 * both cheap regardless of what the file contains, and neither spawns a
 * process. Spawning the isolated child (`runExtractor`) is the one
 * genuinely expensive step, and the archive guard runs strictly before it
 * for exactly that reason.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { inspectArchive } from './archive-guard.js';
import type { ArchiveVerdict } from './archive-guard.js';
import {
  CSV,
  DOCX,
  JSON as JSON_MEDIA_TYPE,
  MARKDOWN,
  TEXT,
  XLSX,
  sniffMediaType,
} from './media-type.js';
import { buildOutline } from './outline.js';
import { extractorFor } from './registry.js';
import { runExtractor } from './run-extractor.js';
import type { ExtractOutcome, RunExtractorOptions } from './run-extractor.js';
import { insertOrGetDocument, markExtracted, markRejected } from './store.js';
import type { DocumentRecord, DocumentSource } from './types.js';

/** §3.4: the original file's own size ceiling — independent of, and checked before, the content-level caps §5.3 enforces inside the extractor. */
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

/**
 * How much of the file `sniffMediaType` sees. The whole buffer is already
 * in memory by the time this runs (needed for the hash and the disk
 * write), but sniffing only ever needs a signature-sized prefix — capping
 * it here avoids UTF-8-decoding an entire multi-megabyte file just to
 * answer "is this text."
 */
const SNIFF_HEAD_BYTES = 8192;

/**
 * Written to `media_type` for a file `sniffMediaType` could not identify.
 * Never handed to `extractorFor` as a real answer — the unsupported-type
 * rejection branch below checks `sniffed === null` directly, before this
 * placeholder is ever consulted. It exists only to satisfy the column's
 * `NOT NULL` constraint for a document that is about to be rejected
 * anyway.
 */
const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

/** The extension `stored_path` gets for each type `sniffMediaType` can name — never the caller-supplied name's own extension (§5.5, §3.5). */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  [XLSX]: 'xlsx',
  [DOCX]: 'docx',
  [CSV]: 'csv',
  [TEXT]: 'txt',
  [MARKDOWN]: 'md',
  [JSON_MEDIA_TYPE]: 'json',
};
const UNKNOWN_EXTENSION = 'bin';

/** The two ZIP-container types the archive guard (§5.2) must clear before `runExtractor` ever spawns a child. */
const ZIP_CONTAINER_TYPES: ReadonlySet<string> = new Set([XLSX, DOCX]);

export interface IngestInput {
  /** Where the bytes are right now. Read once, then owned by this call. */
  path: string;
  source: DocumentSource;
  /**
   * As the sender or uploader named it. Stored verbatim in `original_name`
   * and never treated as a path (§5.5). Defaults to `basename(path)` when
   * omitted.
   */
  originalName?: string;
}

export interface IngestOptions {
  businessId?: string;
  documentRoot?: string;
  /**
   * Test-only escape hatch, threaded straight through to `runExtractor`.
   * Not part of the pipeline's real behaviour — it exists so a test can
   * point the isolated child at a stub that hangs, floods stdout, or
   * exhausts memory (`fixtures/stub-children/`), the same way
   * `run-extractor.test.ts` already does directly, instead of ingest.ts
   * inventing its own copy of that machinery.
   */
  runExtractorOptions?: RunExtractorOptions;
}

/**
 * Runs the archive guard and translates its outcome to `{ ok }` or a Hebrew
 * rejection reason — pulled out of `ingestDocument` so the "catch a genuine
 * I/O failure and turn it into a recorded rejection, not an uncaught
 * crash" behaviour (decision 4 of the task brief: `inspectArchive` still
 * rejects its promise on e.g. ENOENT if the file vanished between the
 * sniff and the guard) is exercised directly against a path guaranteed not
 * to exist, rather than only through a real vanishing-file race that
 * cannot be reproduced deterministically in a test.
 */
export async function guardZipArchive(
  absolutePath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let verdict: ArchiveVerdict;
  try {
    verdict = await inspectArchive(absolutePath);
  } catch (err) {
    // inspectArchive rejects its promise only on a genuine I/O failure
    // (its own docblock: e.g. ENOENT if the file vanished between the
    // sniff and this call) — never for a malformed or hostile archive,
    // which comes back as an `ok: false` verdict instead. That is a fact
    // about this one document, not a system fault, so it is caught and
    // recorded rather than left to crash the caller's whole batch.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `שגיאה בבדיקת הארכיון: ${message}` };
  }
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.detail };
}

/** A Hebrew reason for every `ExtractOutcome` failure code, for `markRejected`. */
function reasonForExtractFailure(outcome: Extract<ExtractOutcome, { ok: false }>): string {
  switch (outcome.code) {
    case 'extractor_timeout':
    case 'extractor_output_too_large':
      // run-extractor.ts already phrases these two in Hebrew.
      return outcome.detail;
    case 'extractor_crashed':
      return `תהליך הפענוח קרס: ${outcome.detail}`;
    case 'extractor_failed':
      return `הפענוח נכשל: ${outcome.detail}`;
  }
}

export async function ingestDocument(
  input: IngestInput,
  options: IngestOptions = {},
): Promise<DocumentRecord> {
  const businessId = options.businessId ?? config.businessId;
  const documentRoot = options.documentRoot ?? config.documentRoot;

  // Read once. Every later step — the hash, the dedupe key, the sniff, the
  // disk write — works off this same buffer instead of re-reading a file
  // that (unlike our own stored copy) is not ours to assume stays put.
  const bytes = await readFile(input.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const originalName = input.originalName ?? basename(input.path);

  const sniffed = sniffMediaType(bytes.subarray(0, SNIFF_HEAD_BYTES), originalName);
  const extension = sniffed !== null ? (EXTENSION_BY_MEDIA_TYPE[sniffed] ?? UNKNOWN_EXTENSION) : UNKNOWN_EXTENSION;

  // A fresh id, generated before the row exists — `stored_path` below is
  // built from it, and `stored_path` is one of the columns the dedupe
  // INSERT writes. If that INSERT loses its race (a concurrent ingest of
  // the same bytes got there first), this id and the storedPath built from
  // it are simply discarded below: no row, no directory, no file ever
  // uses them.
  const documentId = `DOC-${ulid()}`;
  const storedPath = `${businessId}/${documentId}/original.${extension}`;

  const { document, created } = await insertOrGetDocument(
    {
      documentId,
      source: input.source,
      originalName,
      mediaType: sniffed ?? UNKNOWN_MEDIA_TYPE,
      sha256,
      byteSize: bytes.length,
      storedPath,
    },
    { businessId },
  );

  // §8: the same sha256 already exists for this business → the existing
  // document is returned, untouched, and nothing below runs. The bytes we
  // just hashed are never written anywhere under our discarded documentId.
  if (!created) return document;

  const absolutePath = join(documentRoot, businessId, documentId, `original.${extension}`);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  const reject = async (reason: string): Promise<DocumentRecord> => {
    await markRejected(documentId, reason, { businessId });
    return { ...document, status: 'rejected', reason };
  };

  if (bytes.length > MAX_ORIGINAL_BYTES) {
    return reject(
      `הקובץ (${bytes.length.toLocaleString('he-IL')} בייטים) חורג מתקרת הגודל המקסימלית של ${MAX_ORIGINAL_BYTES.toLocaleString('he-IL')} בייטים`,
    );
  }

  if (sniffed === null) {
    return reject('סוג הקובץ אינו מזוהה או אינו נתמך');
  }

  const extractorId = extractorFor(sniffed);
  if (extractorId === null) {
    // Defensive: every type `sniffMediaType` can name is registered today
    // (registry.test.ts's own invariant), so this is unreachable while
    // that holds. If it ever drifts, a document whose sniffed type has no
    // extractor must still be rejected by name, not handed to nothing.
    return reject(`סוג הקובץ ${sniffed} אינו נתמך`);
  }

  if (ZIP_CONTAINER_TYPES.has(sniffed)) {
    const verdict = await guardZipArchive(absolutePath);
    if (!verdict.ok) return reject(verdict.reason);
  }

  const outcome = await runExtractor(extractorId, absolutePath, options.runExtractorOptions);
  if (!outcome.ok) {
    return reject(reasonForExtractFailure(outcome));
  }

  const outline = buildOutline(outcome.artifacts);
  await markExtracted(documentId, [...outcome.artifacts, outline], { businessId });
  return { ...document, status: 'extracted' };
}
