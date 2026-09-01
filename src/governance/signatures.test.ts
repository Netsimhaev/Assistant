import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { insertOrGetDocument, loadDocument } from '../documents/store.js';
import { DocumentAlreadySignedError, loadSignature, recordSignature } from './signatures.js';

const BUSINESS = 'test-business';

async function aDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'חוזה.docx', mediaType: 'text/plain',
    sha256: 'a'.repeat(64), byteSize: 10,
    storedPath: `${BUSINESS}/${documentId}/original.txt`,
  }, { businessId: BUSINESS });
  return documentId;
}

function newSignature(documentId: string) {
  return {
    signatureId: `SIG-${ulid()}`, documentId, signedSha256: 'b'.repeat(64),
    approvalId: `AP-${ulid()}`, signedBy: 'owner',
  };
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('recordSignature', () => {
  it('stores a signature and hands it back', async () => {
    const documentId = await aDocument();
    const record = await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    expect(record.documentId).toBe(documentId);
    expect(record.signedBy).toBe('owner');
    expect(record.signedSha256).toBe('b'.repeat(64));
  });

  it('refuses a second signature on the same document', async () => {
    const documentId = await aDocument();
    await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    await expect(
      recordSignature(newSignature(documentId), { businessId: BUSINESS }),
    ).rejects.toThrow(DocumentAlreadySignedError);
  });

  it('leaves the first signature untouched when a second is refused', async () => {
    const documentId = await aDocument();
    const first = await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    await expect(
      recordSignature(newSignature(documentId), { businessId: BUSINESS }),
    ).rejects.toThrow(DocumentAlreadySignedError);
    const loaded = await loadSignature(documentId, { businessId: BUSINESS });
    expect(loaded?.signatureId).toBe(first.signatureId);
  });
});

describe('loadSignature', () => {
  it('returns null for an unsigned document', async () => {
    const documentId = await aDocument();
    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const documentId = await aDocument();
    await recordSignature(newSignature(documentId), { businessId: BUSINESS });
    expect(await loadSignature(documentId, { businessId: 'other' })).toBeNull();
  });
});

describe('loadDocument', () => {
  it('returns the document, and null across the business boundary', async () => {
    const documentId = await aDocument();
    expect((await loadDocument(documentId, { businessId: BUSINESS }))?.documentId).toBe(documentId);
    expect(await loadDocument(documentId, { businessId: 'other' })).toBeNull();
  });
});
