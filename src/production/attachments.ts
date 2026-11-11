/**
 * Resolve the produced documents a `mail.send` step carries into the exact
 * bytes the owner approved (document production, spec §8.2, D18, C16).
 *
 * The same pattern as "חתום ואשר": the bytes are re-read FROM DISK and
 * re-hashed right before sending, and compared with the `sha256` the approved
 * payload carries. Any disagreement — the row's hash, the row's size, the
 * file's size, the file's hash — refuses the send as
 * `attachment_hash_mismatch`, final. A version is found only when its
 * production belongs to THIS business; anything else is `attachment_not_found`,
 * the same answer as a version that never existed, so another business's ids
 * are not even confirmed to exist.
 *
 * The path is built only from the row's relative `stored_path` under
 * `config.documentRoot`, with a `path.relative` containment check — the rule
 * `createDbImageLoader` (`render-docx.ts`) applies. `mediaType` comes from the
 * production's `format`, never from the filename. The name the recipient sees
 * is the version's canonical name (`canonicalAttachmentName`), and a ref
 * carrying any other name is refused (`attachment_name_mismatch`) — so the
 * name in the confirmation echo is exactly the name that is sent.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { BusinessDb } from '../db/pool.js';
import {
  FORMAT_MEDIA_TYPE,
  sanitizeAttachmentFilename,
  type AttachmentRef,
} from '../domain/attachment-ref.js';
import { DocumentFormat, DocumentKind } from '../domain/document-spec.js';

export {
  AttachmentRef,
  AttachmentRefs,
  formatAttachmentSize,
  sanitizeAttachmentFilename,
} from '../domain/attachment-ref.js';

/** The total of every attachment on one send, every provider (spec §8.2). */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

export interface ResolvedAttachment {
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export type AttachmentFailureCode =
  | 'attachment_not_found'
  | 'attachment_hash_mismatch'
  | 'attachment_name_mismatch'
  | 'attachment_too_large';

export type ResolveAttachmentsResult =
  | { ok: true; files: ResolvedAttachment[] }
  | { ok: false; code: AttachmentFailureCode; he: string };

export const ATTACHMENT_FAILURE_HE: Readonly<Record<AttachmentFailureCode, string>> = {
  attachment_not_found: 'הקובץ המצורף לא נמצא — המייל לא נשלח',
  attachment_hash_mismatch: 'הקובץ המצורף השתנה מאז שאושר — המייל לא נשלח',
  attachment_name_mismatch: 'שם הקובץ המצורף אינו השם שאושר — המייל לא נשלח',
  attachment_too_large: 'הקבצים המצורפים גדולים מ-20MB — המייל לא נשלח',
};

interface VersionFileRow {
  stored_path: string;
  sha256: string;
  size_bytes: string | number;
  format: string;
  kind: string;
  spec_filename: string | null;
}

/**
 * One produced version as the two consumers of its exact bytes see it — the
 * mail attachment resolver here and `doc.save` (`save.ts`). Shared so the
 * business scoping, the containment check and the single read + hash are
 * written once.
 */
export interface VersionFile {
  versionId: string;
  storedPath: string;
  sha256: string;
  sizeBytes: number;
  format: DocumentFormat;
  kind: DocumentKind;
  /** The name the recipient sees — see `canonicalAttachmentName`. */
  filename: string;
}

function toVersionFile(versionId: string, row: VersionFileRow): VersionFile | null {
  const format = DocumentFormat.safeParse(row.format);
  if (!format.success) return null;
  const kind = DocumentKind.safeParse(row.kind);
  if (!kind.success) return null;
  return {
    versionId,
    storedPath: row.stored_path,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    format: format.data,
    kind: kind.data,
    filename: canonicalAttachmentName({ spec: { filename: row.spec_filename ?? '' }, format: format.data }),
  };
}

/**
 * The version row, found only when its production belongs to THIS business.
 * `null` for anything else — another business's id reads exactly like an id
 * that never existed.
 */
export async function loadVersionFile(
  db: BusinessDb,
  versionId: string,
): Promise<VersionFile | null> {
  const { rows } = await db.query<VersionFileRow>(
    `SELECT v.stored_path, v.sha256, v.size_bytes, p.format, p.kind, v.spec->>'filename' AS spec_filename
       FROM document_versions v
       JOIN document_productions p ON p.production_id = v.production_id
      WHERE v.version_id = $1 AND p.business_id = $2`,
    [versionId, db.businessId],
  );
  const row = rows[0];
  return row === undefined ? null : toVersionFile(versionId, row);
}

export type ReadVersionBytesResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: 'attachment_not_found' | 'attachment_hash_mismatch' };

/**
 * The version's file, read ONCE from disk and hashed, against the size and
 * hash the caller expects. The path is the row's relative `stored_path` under
 * the caller's `documentRoot` (threaded from the entry point, which alone
 * falls back to `config.documentRoot`), contained by `path.relative`; the size is checked
 * against the open handle before reading, so a file swapped for a far larger
 * one is a mismatch without being pulled into memory. The returned buffer is
 * the one that was hashed — callers must use it and never re-read.
 */
export async function readVersionBytes(
  version: VersionFile,
  expected: { sha256: string; sizeBytes: number },
  documentRoot: string,
): Promise<ReadVersionBytesResult> {
  const root = resolve(documentRoot);
  const full = resolve(root, version.storedPath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, code: 'attachment_not_found' };

  let bytes: Buffer;
  try {
    const handle = await open(full, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { ok: false, code: 'attachment_not_found' };
      if (info.size !== expected.sizeBytes) return { ok: false, code: 'attachment_hash_mismatch' };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return { ok: false, code: 'attachment_not_found' };
    throw err;
  }
  if (bytes.length !== expected.sizeBytes) return { ok: false, code: 'attachment_hash_mismatch' };
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) return { ok: false, code: 'attachment_hash_mismatch' };
  return { ok: true, bytes };
}

/**
 * The one name a produced version is sent under: the version's own spec
 * `filename` (written by the drafter, validated by `validateSpec`), sanitised
 * with the real extension forced. A ref must carry exactly this name — the
 * resolver refuses any other (`attachment_name_mismatch`) — so the name the
 * owner confirms in the echo is the name the recipient gets. Task 14 builds
 * refs with it.
 */
export function canonicalAttachmentName(version: {
  spec: { filename: string };
  format: DocumentFormat;
}): string {
  return sanitizeAttachmentFilename(version.spec.filename, version.format);
}

function fail(code: AttachmentFailureCode): ResolveAttachmentsResult {
  return { ok: false, code, he: ATTACHMENT_FAILURE_HE[code] };
}

/**
 * Every ref → `{ filename, mediaType, bytes }`, or the first failure.
 *
 * Order of checks, cheapest and most absolute first: the rows (this business
 * only), the declared hash and size against each row, the total against the
 * 20MB cap (before any file is opened), then each file — contained under the
 * document root, its size, and its re-computed hash.
 */
export async function resolveAttachments(
  db: BusinessDb,
  refs: readonly AttachmentRef[],
  documentRoot: string,
): Promise<ResolveAttachmentsResult> {
  const versions: VersionFile[] = [];
  for (const ref of refs) {
    const version = await loadVersionFile(db, ref.producedVersionId);
    if (version === null) return fail('attachment_not_found');
    if (version.sha256 !== ref.sha256 || version.sizeBytes !== ref.sizeBytes) {
      return fail('attachment_hash_mismatch');
    }
    // Exact, not normalised: the echo shows `ref.filename`, so it must be
    // byte-for-byte the name that goes out.
    if (ref.filename !== version.filename) return fail('attachment_name_mismatch');
    versions.push(version);
  }

  const total = versions.reduce((sum, v) => sum + v.sizeBytes, 0);
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) return fail('attachment_too_large');

  const files: ResolvedAttachment[] = [];
  for (const [index, ref] of refs.entries()) {
    const version = versions[index];
    if (version === undefined) return fail('attachment_not_found');
    const read = await readVersionBytes(version, { sha256: ref.sha256, sizeBytes: ref.sizeBytes }, documentRoot);
    if (!read.ok) return fail(read.code);

    files.push({
      filename: version.filename,
      mediaType: FORMAT_MEDIA_TYPE[version.format],
      bytes: read.bytes,
    });
  }
  return { ok: true, files };
}

/**
 * Is this job the delivery job of a document card in THIS business?
 *
 * The positive marker that lets a `mail.send` carry attachments at all
 * (ruling, fix round 1 of Task 12): only the delivery plan built from an
 * approved card names a produced file, so a model-written plan that emits the
 * field — on an instruction job, a mail reply, anything else — is refused
 * before any file is read.
 */
export async function isDeliveryJob(db: BusinessDb, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM document_cards WHERE business_id = $1 AND delivery_job_id = $2 LIMIT 1',
    [db.businessId, jobId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The one produced version this job may deliver: the `version_id` of the
 * card (in THIS business) whose `delivery_job_id` is this job, or `null`.
 *
 * The hardened form of `isDeliveryJob` (Task 14, carry (b)): being a
 * delivery job is not enough — a `mail.send` attachment and a `doc.save`
 * step must name exactly the version the owner approved on that card. A plan
 * that somehow names another version (another card's, another production's)
 * is refused before any file is read. `approveDocumentCard` is the only
 * writer of `delivery_job_id`, and only on the job it creates, so the card a
 * delivery job resolves to is the card the owner pressed.
 */
export async function deliveryVersionOf(
  db: BusinessDb,
  jobId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ version_id: string }>(
    'SELECT version_id FROM document_cards WHERE business_id = $1 AND delivery_job_id = $2',
    [db.businessId, jobId],
  );
  // Two cards naming one job cannot happen (one writer, one job per
  // approval); if it ever did, which version is approved is not knowable.
  return rows.length === 1 ? rows[0]!.version_id : null;
}
