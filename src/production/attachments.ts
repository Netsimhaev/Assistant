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
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import {
  FORMAT_MEDIA_TYPE,
  sanitizeAttachmentFilename,
  type AttachmentRef,
} from '../domain/attachment-ref.js';
import { DocumentFormat } from '../domain/document-spec.js';

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
  spec_filename: string | null;
}

interface VersionFile {
  storedPath: string;
  sha256: string;
  sizeBytes: number;
  format: DocumentFormat;
  /** The name the recipient sees — see `canonicalAttachmentName`. */
  filename: string;
}

function toVersionFile(row: VersionFileRow): VersionFile | null {
  const format = DocumentFormat.safeParse(row.format);
  if (!format.success) return null;
  return {
    storedPath: row.stored_path,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    format: format.data,
    filename: canonicalAttachmentName({ spec: { filename: row.spec_filename ?? '' }, format: format.data }),
  };
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
  refs: readonly AttachmentRef[],
  businessId: string,
  db: Queryable = getPool(),
): Promise<ResolveAttachmentsResult> {
  const versions: VersionFile[] = [];
  for (const ref of refs) {
    const { rows } = await db.query<VersionFileRow>(
      `SELECT v.stored_path, v.sha256, v.size_bytes, p.format, v.spec->>'filename' AS spec_filename
         FROM document_versions v
         JOIN document_productions p ON p.production_id = v.production_id
        WHERE v.version_id = $1 AND p.business_id = $2`,
      [ref.producedVersionId, businessId],
    );
    const row = rows[0];
    if (row === undefined) return fail('attachment_not_found');
    const version = toVersionFile(row);
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

  const root = resolve(config.documentRoot);
  const files: ResolvedAttachment[] = [];
  for (const [index, ref] of refs.entries()) {
    const version = versions[index];
    if (version === undefined) return fail('attachment_not_found');
    const full = resolve(root, version.storedPath);
    const rel = relative(root, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return fail('attachment_not_found');

    let bytes: Buffer;
    try {
      const handle = await open(full, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) return fail('attachment_not_found');
        // Checked before reading: a file swapped for a far larger one is a
        // mismatch, and must not be pulled into memory to find that out.
        if (info.size !== ref.sizeBytes) return fail('attachment_hash_mismatch');
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return fail('attachment_not_found');
      throw err;
    }
    if (bytes.length !== ref.sizeBytes) return fail('attachment_hash_mismatch');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.sha256) return fail('attachment_hash_mismatch');

    files.push({
      filename: version.filename,
      mediaType: FORMAT_MEDIA_TYPE[version.format],
      bytes,
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
export async function isDeliveryJob(businessId: string, jobId: string, db: Queryable = getPool()): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM document_cards WHERE business_id = $1 AND delivery_job_id = $2 LIMIT 1',
    [businessId, jobId],
  );
  return (rowCount ?? 0) > 0;
}
