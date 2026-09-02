import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
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

/**
 * F4, migration 020. Both of these are properties of the schema, not of any
 * function in this module, so they are asserted with raw SQL: a signature is
 * the row that records a human act, and it must not be deleted by a purge of
 * the thing it attests to, nor hold a value that cannot be a SHA-256.
 */
describe('the signatures table as evidence', () => {
  it('refuses to delete a document that carries a signature, and keeps the signature', async () => {
    const documentId = await aDocument();
    await recordSignature(newSignature(documentId), { businessId: BUSINESS });

    await expect(
      getPool().query('DELETE FROM documents WHERE document_id = $1 AND business_id = $2', [
        documentId,
        BUSINESS,
      ]),
    ).rejects.toThrow(/signatures/);

    expect(await loadSignature(documentId, { businessId: BUSINESS })).not.toBeNull();
  });

  it('refuses a signed_sha256 that is not 64 lowercase hex characters', async () => {
    const documentId = await aDocument();
    for (const bad of ['', 'not-a-hash', 'B'.repeat(64), 'b'.repeat(63)]) {
      await expect(
        getPool().query(
          `INSERT INTO signatures (signature_id, business_id, document_id, signed_sha256, approval_id, signed_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [`SIG-${ulid()}`, BUSINESS, documentId, bad, `AP-${ulid()}`, 'owner'],
        ),
      ).rejects.toThrow(/signature_sha256_is_sha256/);
    }
  });
});

describe('loadDocument', () => {
  it('returns the document, and null across the business boundary', async () => {
    const documentId = await aDocument();
    expect((await loadDocument(documentId, { businessId: BUSINESS }))?.documentId).toBe(documentId);
    expect(await loadDocument(documentId, { businessId: 'other' })).toBeNull();
  });
});
