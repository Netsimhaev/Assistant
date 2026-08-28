import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  findBySha,
  insertDocument,
  loadArtifacts,
  markExtracted,
  markRejected,
  type NewDocument,
} from './store.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-business';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const INPUT: NewDocument = {
  source: 'manual',
  originalName: 'מסמך.xlsx',
  mediaType: XLSX,
  sha256: 'c'.repeat(64),
  byteSize: 120,
  storedPath: 'test-business/DOC-x/original.xlsx',
};

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('insertDocument', () => {
  it('stores a new document as pending', async () => {
    const doc = await insertDocument(
      { ...INPUT, sha256: 'd'.repeat(64) },
      { businessId: BUSINESS },
    );
    expect(doc.status).toBe('pending');
    expect(doc.documentId).toMatch(/^DOC-/);
    expect(doc.businessId).toBe(BUSINESS);
    expect(doc.reason).toBeNull();
  });

  it('returns the existing document rather than storing the same bytes twice', async () => {
    const first = await insertDocument({ ...INPUT, sha256: 'b'.repeat(64) }, { businessId: BUSINESS });
    const again = await findBySha('b'.repeat(64), { businessId: BUSINESS });
    expect(again?.documentId).toBe(first.documentId);
  });

  it('does not let one business dedupe against another business\'s bytes', async () => {
    await insertDocument({ ...INPUT, sha256: 'e'.repeat(64) }, { businessId: BUSINESS });
    const foundElsewhere = await findBySha('e'.repeat(64), { businessId: OTHER_BUSINESS });
    expect(foundElsewhere).toBeNull();
  });
});

describe('markExtracted', () => {
  it('writes the artefacts and the status together, or neither', async () => {
    const doc = await insertDocument(
      { ...INPUT, originalName: 'מחירון.xlsx', sha256: 'a'.repeat(64) },
      { businessId: BUSINESS },
    );
    expect(doc.status).toBe('pending');

    await markExtracted(doc.documentId, [
      { ordinal: 0, kind: 'table', partName: 'מחירים', content: { rows: [] }, flags: ['hidden_sheet'] },
    ], { businessId: BUSINESS });

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.flags).toEqual(['hidden_sheet']);

    const again = await findBySha('a'.repeat(64), { businessId: BUSINESS });
    expect(again?.status).toBe('extracted');
  });

  it('preserves artefact order by ordinal', async () => {
    const doc = await insertDocument({ ...INPUT, sha256: 'f'.repeat(64) }, { businessId: BUSINESS });

    await markExtracted(doc.documentId, [
      { ordinal: 1, kind: 'outline', partName: null, content: { parts: [], flags: [] }, flags: [] },
      { ordinal: 0, kind: 'table', partName: 'גיליון1', content: { rows: [] }, flags: [] },
    ], { businessId: BUSINESS });

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts.map((a) => a.ordinal)).toEqual([0, 1]);
    expect(artifacts[0]?.partName).toBe('גיליון1');
  });

  it('rolls back the whole write when one artefact is invalid, leaving status untouched', async () => {
    const doc = await insertDocument({ ...INPUT, sha256: '1'.repeat(64) }, { businessId: BUSINESS });

    await expect(
      markExtracted(doc.documentId, [
        { ordinal: 0, kind: 'table', partName: null, content: { rows: [] }, flags: [] },
        // Not a real ArtifactKind — forces the DB's CHECK constraint to reject
        // the whole transaction.
        { ordinal: 1, kind: 'bogus' as never, partName: null, content: {}, flags: [] },
      ], { businessId: BUSINESS }),
    ).rejects.toThrow();

    const stillPending = await findBySha('1'.repeat(64), { businessId: BUSINESS });
    expect(stillPending?.status).toBe('pending');

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(0);
  });

  it('refuses a businessId that does not own the document, and leaves no artefact rows behind', async () => {
    const doc = await insertDocument({ ...INPUT, sha256: '3'.repeat(64) }, { businessId: BUSINESS });

    // `document_artifacts.document_id` FK-references `documents.document_id`
    // alone (see the migration header) — the FK is satisfied by the row
    // under its real owner, BUSINESS, so a naive insert-then-update under
    // the wrong business would insert the artefact rows first and only then
    // discover the UPDATE matches nothing. Asserting only the throw would
    // pass even if that insert were never rolled back — so this checks both
    // businesses see zero artefact rows afterwards.
    await expect(
      markExtracted(doc.documentId, [
        { ordinal: 0, kind: 'table', partName: null, content: { rows: [] }, flags: [] },
      ], { businessId: OTHER_BUSINESS }),
    ).rejects.toThrow();

    const underWrongBusiness = await loadArtifacts(doc.documentId, { businessId: OTHER_BUSINESS });
    expect(underWrongBusiness).toHaveLength(0);

    const underRealOwner = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(underRealOwner).toHaveLength(0);

    const stillPending = await findBySha('3'.repeat(64), { businessId: BUSINESS });
    expect(stillPending?.status).toBe('pending');
  });
});

describe('markRejected', () => {
  it('records why, and leaves no artefacts behind', async () => {
    const doc = await insertDocument({ ...INPUT, sha256: '2'.repeat(64) }, { businessId: BUSINESS });

    await markRejected(doc.documentId, 'סוג קובץ לא נתמך: application/x-msdownload', {
      businessId: BUSINESS,
    });

    const rejected = await findBySha('2'.repeat(64), { businessId: BUSINESS });
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.reason).toBe('סוג קובץ לא נתמך: application/x-msdownload');

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(0);
  });

  it('refuses a businessId that does not own the document', async () => {
    const doc = await insertDocument({ ...INPUT, sha256: '4'.repeat(64) }, { businessId: BUSINESS });

    await expect(
      markRejected(doc.documentId, 'not yours', { businessId: OTHER_BUSINESS }),
    ).rejects.toThrow();

    const stillPending = await findBySha('4'.repeat(64), { businessId: BUSINESS });
    expect(stillPending?.status).toBe('pending');
    expect(stillPending?.reason).toBeNull();
  });
});
