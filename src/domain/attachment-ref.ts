import { z } from 'zod';
import { SafeLookupKey } from './charter.js';
import type { DocumentFormat } from './document-spec.js';
import { stripBidiControls } from '../util/bidi.js';

/**
 * One produced document a `mail.send` step carries (document production,
 * spec §8.2, ruling C16).
 *
 * Pure and DB-free on purpose: the confirmation echo (`command-echo.ts`)
 * renders it, and the echo must not pull a database handle or the document
 * root into its import graph. The resolver that reads the bytes is
 * `src/production/attachments.ts`.
 *
 * `sizeBytes` rides on the ref so the echo can show the size without a DB
 * read; it is a claim the resolver checks against the version row (and the
 * file on disk) — a mismatch is `attachment_hash_mismatch`, never a send.
 */
export const AttachmentRef = z
  .object({
    producedVersionId: SafeLookupKey,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    filename: z.string().max(120),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const AttachmentRefs = z.array(AttachmentRef);
export type AttachmentRefs = z.infer<typeof AttachmentRefs>;

/** The one key a step payload carries attachments under. */
export const ATTACHMENTS_KEY = 'attachments';

/** The only tool that may carry `attachments`. */
export const ATTACHMENT_TOOL = 'mail.send';

/** MIME type per produced format — derived from the version's format, never from a filename. */
export const FORMAT_MEDIA_TYPE: Readonly<Record<DocumentFormat, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

const MAX_FILENAME_CHARS = 120;
/**
 * Path separators, control characters (C0, DEL, C1 — CR/LF among them, so a
 * name can never break a MIME header line) and the characters Windows refuses
 * in a filename.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g;

/**
 * The name the recipient sees: bidi controls stripped (a right-to-left
 * override makes `invoice‮fdp.exe` read as a different file), path separators
 * and controls removed, and ALWAYS the real format's extension — appended when
 * the given name does not already end with it. Never empty.
 */
export function sanitizeAttachmentFilename(name: string, format: DocumentFormat): string {
  const ext = `.${format}`;
  let base = stripBidiControls(name).replace(UNSAFE_FILENAME_CHARS, '').trim();
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length);
  base = base.replace(/^[.\s]+|[.\s]+$/g, '');
  if (base === '') base = 'document';
  const room = MAX_FILENAME_CHARS - ext.length;
  if (base.length > room) base = base.slice(0, room).trim();
  return `${base}${ext}`;
}

/** A byte count for the owner: bytes, KB or MB, one decimal at most. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} בתים`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${roundOne(kb)} KB`;
  return `${roundOne(kb / 1024)} MB`;
}

function roundOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
