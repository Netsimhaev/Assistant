import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { resetDatabase } from '../test/db.js';
import {
  canonicalAttachmentName,
  resolveAttachments,
  sanitizeAttachmentFilename,
  type AttachmentRef,
} from './attachments.js';
import { createProduction, saveVersion } from './store.js';

const B = 'test-business';
const OTHER = 'other-business';
const DIR = `produced/__attach-test-${process.pid}`;

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'מכתב',
  filename: 'הצעת מחיר',
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
  const productionId = await withBusiness(opts.businessId ?? B, (db) => createProduction(db, {
    originJobId: 'J-origin',
    instructionText: 'תכיני מכתב',
    textOrigin: 'typed',
    format,
    language: 'he',
    kind: 'letter',
    destination: { mode: 'save', folder: null },
    sourceDocumentIds: [],
  }));
  const storedPath = `${DIR}/${productionId}.${format}`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  const size = opts.recordSize ?? bytes.length;
  const versionId = await withBusiness(opts.businessId ?? B, (db) => saveVersion(db, {
    productionId,
    versionNo: 1,
    spec,
    storedPath,
    sha256: sha(bytes),
    sizeBytes: size,
  }));
  return { producedVersionId: versionId, sha256: sha(bytes), filename: opts.name ?? 'הצעת מחיר.docx', sizeBytes: size };
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
  it('M7: reads the file under the documentRoot its caller passes, not config.documentRoot', async () => {
    const bytes = Buffer.from('PK bytes under another root');
    const ref = await produced(bytes);
    // Move the produced file to a different root, keeping its relative path.
    const otherRoot = await mkdtemp(join(tmpdir(), 'attach-root-'));
    try {
      await mkdir(join(otherRoot, DIR), { recursive: true });
      const { rows } = await getPool().query<{ stored_path: string }>(
        'SELECT stored_path FROM document_versions WHERE version_id = $1',
        [ref.producedVersionId],
      );
      const storedPath = rows[0]!.stored_path;
      await rename(join(config.documentRoot, storedPath), join(otherRoot, storedPath));

      const found = await withBusiness(B, (db) => resolveAttachments(db, [ref], otherRoot));
      expect(found.ok).toBe(true);
      if (found.ok) expect(found.files[0]?.bytes.equals(bytes)).toBe(true);
      // Control: the default root no longer holds it.
      expect(await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_not_found' });
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('canonical name passes: exact bytes, the format MIME type, the name from the version spec', async () => {
    const bytes = Buffer.from('PK\x03\x04 docx bytes');
    const ref = await produced(bytes);
    const result = await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot));
    expect(result).toEqual({
      ok: true,
      files: [
        {
          filename: 'הצעת מחיר.docx',
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes,
        },
      ],
    });
  });

  it('a ref whose filename is not the canonical name → attachment_name_mismatch', async () => {
    const bytes = Buffer.from('PK\x03\x04 docx bytes');
    for (const name of ['הצעה.pdf', 'הצעת מחיר', 'הצעת מחיר.DOCX', 'הצעת‮ מחיר.docx']) {
      const ref = await produced(bytes, { name });
      const result = await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot));
      expect(result, name).toMatchObject({ ok: false, code: 'attachment_name_mismatch' });
      if (result.ok) throw new Error('unreachable');
      expect(result.he).toMatch(/שם/);
    }
  });

  it('canonicalAttachmentName is the spec filename sanitised with the real extension', () => {
    expect(canonicalAttachmentName({ spec: { filename: 'דוח/רבעון‮' }, format: 'xlsx' })).toBe('דוחרבעון.xlsx');
    expect(canonicalAttachmentName({ spec: { filename: 'מכתב.docx' }, format: 'docx' })).toBe('מכתב.docx');
  });

  it('re-hashes from disk: a file modified after hashing → attachment_hash_mismatch', async () => {
    const bytes = Buffer.from('original bytes!!');
    const ref = await produced(bytes);
    // Control: unchanged, it resolves (so the refusal below is the hash check).
    expect((await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).ok).toBe(true);
    // Same length, different bytes — the size check cannot catch it, only the hash.
    const { rows } = await getPool().query<{ stored_path: string }>(
      'SELECT stored_path FROM document_versions WHERE version_id = $1',
      [ref.producedVersionId],
    );
    await writeFile(join(config.documentRoot, rows[0]!.stored_path), Buffer.from('tampered bytes!!'));
    const result = await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot));
    expect(result).toMatchObject({ ok: false, code: 'attachment_hash_mismatch' });
    if (result.ok) throw new Error('unreachable');
    expect(result.he).toMatch(/השתנה/);
  });

  it('a ref whose sha or size disagrees with the row → attachment_hash_mismatch', async () => {
    const ref = await produced(Buffer.from('abc'));
    expect((await withBusiness(B, (db) => resolveAttachments(db, [{ ...ref, sha256: 'a'.repeat(64) }], config.documentRoot))).ok).toBe(false);
    expect(await withBusiness(B, (db) => resolveAttachments(db, [{ ...ref, sizeBytes: 4 }], config.documentRoot))).toMatchObject({
      ok: false,
      code: 'attachment_hash_mismatch',
    });
    expect((await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).ok).toBe(true);
  });

  it('a version id from another business → attachment_not_found', async () => {
    const ref = await produced(Buffer.from('other business file'), { businessId: OTHER });
    // Control: its own business resolves it.
    expect((await withBusiness(OTHER, (db) => resolveAttachments(db, [ref], config.documentRoot))).ok).toBe(true);
    expect(await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('an unknown id or a missing file → attachment_not_found', async () => {
    const ref = await produced(Buffer.from('xyz'));
    expect(await withBusiness(B, (db) => resolveAttachments(db, [{ ...ref, producedVersionId: 'DV-nope-1' }], config.documentRoot))).toMatchObject({
      ok: false,
      code: 'attachment_not_found',
    });
    await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
    expect(await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('a stored path escaping the document root → attachment_not_found, the file is never read', async () => {
    const ref = await produced(Buffer.from('inside'));
    await getPool().query('UPDATE document_versions SET stored_path = $1 WHERE version_id = $2', [
      '../outside.docx',
      ref.producedVersionId,
    ]);
    expect(await withBusiness(B, (db) => resolveAttachments(db, [ref], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });

  it('25MB total → attachment_too_large, before any file is opened', async () => {
    // The rows claim 12.5MB each; the files are tiny, so the refusal can only
    // be the total computed from the rows.
    const a = await produced(Buffer.from('a'), { recordSize: 12.5 * 1024 * 1024 });
    const b = await produced(Buffer.from('b'), { recordSize: 12.5 * 1024 * 1024 });
    expect(await withBusiness(B, (db) => resolveAttachments(db, [a, b], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_too_large' });
    // Control: one of them alone passes the cap and reaches the file check.
    expect(await withBusiness(B, (db) => resolveAttachments(db, [a], config.documentRoot))).toMatchObject({ ok: false, code: 'attachment_hash_mismatch' });
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
