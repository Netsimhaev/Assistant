import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { resetDatabase } from '../test/db.js';
import { resolveAttachments, sanitizeAttachmentFilename, type AttachmentRef } from './attachments.js';
import { createProduction, saveVersion } from './store.js';

const B = 'test-business';
const OTHER = 'other-business';
const DIR = `produced/__attach-test-${process.pid}`;

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'מכתב',
  filename: 'letter',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** One produced version on disk; returns the ref the approved payload would carry. */
async function produced(
  bytes: Buffer,
  opts: { businessId?: string; name?: string; recordSize?: number } = {},
): Promise<AttachmentRef> {
  const format = 'docx';
  const productionId = await createProduction({
    businessId: opts.businessId ?? B,
    originJobId: 'J-origin',
    instructionText: 'תכיני מכתב',
    textOrigin: 'typed',
    format,
    language: 'he',
    kind: 'letter',
    destination: { mode: 'save', folder: null },
    sourceDocumentIds: [],
  });
  const storedPath = `${DIR}/${productionId}.${format}`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  const size = opts.recordSize ?? bytes.length;
  const versionId = await saveVersion({
    productionId,
    versionNo: 1,
    spec,
    storedPath,
    sha256: sha(bytes),
    sizeBytes: size,
  });
  return { producedVersionId: versionId, sha256: sha(bytes), filename: opts.name ?? 'מכתב', sizeBytes: size };
}

beforeEach(async () => {
  await resetDatabase();
});
afterEach(async () => {
  await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

describe('resolveAttachments', () => {
  it('returns the exact bytes, the format MIME type and the sanitised name', async () => {
    const bytes = Buffer.from('PK\x03\x04 docx bytes');
    const ref = await produced(bytes, { name: 'הצעה.pdf' });
    const result = await resolveAttachments([ref], B);
    expect(result).toEqual({
      ok: true,
      files: [
        {
          // The real extension is forced: the name said .pdf, the file is docx.
          filename: 'הצעה.pdf.docx',
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes,
        },
      ],
    });
  });

  it('re-hashes from disk: a file modified after hashing → attachment_hash_mismatch', async () => {
    const bytes = Buffer.from('original bytes!!');
    const ref = await produced(bytes);
    // Control: unchanged, it resolves (so the refusal below is the hash check).
    expect((await resolveAttachments([ref], B)).ok).toBe(true);
    // Same length, different bytes — the size check cannot catch it, only the hash.
    const { rows } = await getPool().query<{ stored_path: string }>(
      'SELECT stored_path FROM document_versions WHERE version_id = $1',
      [ref.producedVersionId],
    );
    await writeFile(join(config.documentRoot, rows[0]!.stored_path), Buffer.from('tampered bytes!!'));
    const result = await resolveAttachments([ref], B);
    expect(result).toMatchObject({ ok: false, code: 'attachment_hash_mismatch' });
    if (result.ok) throw new Error('unreachable');
    expect(result.he).toMatch(/השתנה/);
  });

  it('a ref whose sha or size disagrees with the row → attachment_hash_mismatch', async () => {
    const ref = await produced(Buffer.from('abc'));
    expect((await resolveAttachments([{ ...ref, sha256: 'a'.repeat(64) }], B)).ok).toBe(false);
    expect(await resolveAttachments([{ ...ref, sizeBytes: 4 }], B)).toMatchObject({
      ok: false,
      code: 'attachment_hash_mismatch',
    });
    expect((await resolveAttachments([ref], B)).ok).toBe(true);
  });

  it('a version id from another business → attachment_not_found', async () => {
    const ref = await produced(Buffer.from('other business file'), { businessId: OTHER });
    // Control: its own business resolves it.
    expect((await resolveAttachments([ref], OTHER)).ok).toBe(true);
    expect(await resolveAttachments([ref], B)).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('an unknown id or a missing file → attachment_not_found', async () => {
    const ref = await produced(Buffer.from('xyz'));
    expect(await resolveAttachments([{ ...ref, producedVersionId: 'DV-nope-1' }], B)).toMatchObject({
      ok: false,
      code: 'attachment_not_found',
    });
    await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
    expect(await resolveAttachments([ref], B)).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('a stored path escaping the document root → attachment_not_found, the file is never read', async () => {
    const ref = await produced(Buffer.from('inside'));
    await getPool().query('UPDATE document_versions SET stored_path = $1 WHERE version_id = $2', [
      '../outside.docx',
      ref.producedVersionId,
    ]);
    expect(await resolveAttachments([ref], B)).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('25MB total → attachment_too_large, before any file is opened', async () => {
    // The rows claim 12.5MB each; the files are tiny, so the refusal can only
    // be the total computed from the rows.
    const a = await produced(Buffer.from('a'), { recordSize: 12.5 * 1024 * 1024 });
    const b = await produced(Buffer.from('b'), { recordSize: 12.5 * 1024 * 1024 });
    expect(await resolveAttachments([a, b], B)).toMatchObject({ ok: false, code: 'attachment_too_large' });
    // Control: one of them alone passes the cap and reaches the file check.
    expect(await resolveAttachments([a], B)).toMatchObject({ ok: false, code: 'attachment_hash_mismatch' });
  });
});

describe('sanitizeAttachmentFilename', () => {
  it('strips bidi controls and path separators, and forces the real extension', () => {
    expect(sanitizeAttachmentFilename('invoice‮fdp.exe', 'pdf')).toBe('invoicefdp.exe.pdf');
    expect(sanitizeAttachmentFilename('../../etc/passwd', 'docx')).toBe('etcpasswd.docx');
    expect(sanitizeAttachmentFilename('a\r\nBcc: x', 'xlsx')).toBe('aBcc x.xlsx');
    expect(sanitizeAttachmentFilename('הצעת מחיר.PPTX', 'pptx')).toBe('הצעת מחיר.pptx');
    expect(sanitizeAttachmentFilename('   ', 'pdf')).toBe('document.pdf');
    expect(sanitizeAttachmentFilename('x'.repeat(200), 'pdf')).toHaveLength(120);
  });
});
