import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, type Queryable } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  insertOrGetDocument,
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

/** A fresh `NewDocumentWithId`, the way `ingestDocument` builds one — a caller-generated id, everything else from `INPUT` unless overridden. */
function withId(overrides: Partial<NewDocument> = {}) {
  return { ...INPUT, ...overrides, documentId: `DOC-${ulid()}` };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('insertOrGetDocument', () => {
  it('stores a new document as pending', async () => {
    const { document, created } = await insertOrGetDocument(
      withId({ sha256: 'd'.repeat(64) }),
      { businessId: BUSINESS },
    );
    expect(created).toBe(true);
    expect(document.status).toBe('pending');
    expect(document.documentId).toMatch(/^DOC-/);
    expect(document.businessId).toBe(BUSINESS);
    expect(document.reason).toBeNull();
  });

  it('returns the existing document rather than storing the same bytes twice', async () => {
    const first = await insertOrGetDocument(withId({ sha256: 'b'.repeat(64) }), {
      businessId: BUSINESS,
    });
    const again = await insertOrGetDocument(withId({ sha256: 'b'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(again.created).toBe(false);
    expect(again.document.documentId).toBe(first.document.documentId);
  });

  it('does not let one business dedupe against another business\'s bytes', async () => {
    await insertOrGetDocument(withId({ sha256: 'e'.repeat(64) }), { businessId: BUSINESS });
    const elsewhere = await insertOrGetDocument(withId({ sha256: 'e'.repeat(64) }), {
      businessId: OTHER_BUSINESS,
    });
    // A different business dedupes against nothing — this is a fresh
    // insert under OTHER_BUSINESS, not a lookup of BUSINESS's row.
    expect(elsewhere.created).toBe(true);
    expect(elsewhere.document.businessId).toBe(OTHER_BUSINESS);
  });

  it('throws when the ON CONFLICT fires but the follow-up re-select finds no row — a concurrent delete between the two statements, not "nothing to dedupe against"', async () => {
    // A stub `Queryable` whose every query — the INSERT and the re-select
    // alike — returns no rows, the way a real ON CONFLICT DO NOTHING plus a
    // SELECT would if the conflicting row were deleted in between. No real
    // database involved: the throw is unreachable against `assistant_test`
    // itself, since nothing here can delete a row between two statements
    // of the same async function.
    const stubDb: Queryable = {
      query: (async () => ({ rows: [] })) as unknown as Queryable['query'],
    };

    await expect(
      insertOrGetDocument(withId({ sha256: 'f'.repeat(64) }), {
        businessId: BUSINESS,
        db: stubDb,
      }),
    ).rejects.toThrow(/no row was found on re-select/);
  });
});

describe('markExtracted', () => {
  it('writes the artefacts and the status together, or neither', async () => {
    const { document: doc } = await insertOrGetDocument(
      withId({ originalName: 'מחירון.xlsx', sha256: 'a'.repeat(64) }),
      { businessId: BUSINESS },
    );
    expect(doc.status).toBe('pending');

    await markExtracted(doc.documentId, [
      { ordinal: 0, kind: 'table', partName: 'מחירים', content: { rows: [] }, flags: ['hidden_sheet'] },
    ], { businessId: BUSINESS });

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.flags).toEqual(['hidden_sheet']);

    // Re-fetch through insertOrGetDocument's own dedupe path (created:
    // false, since the sha already exists) rather than a dedicated lookup
    // function — this is the same re-select `ingestDocument`'s dedupe uses
    // in production, and it reflects markExtracted's write immediately.
    const again = await insertOrGetDocument(withId({ sha256: 'a'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(again.created).toBe(false);
    expect(again.document.status).toBe('extracted');
  });

  it('preserves artefact order by ordinal', async () => {
    const { document: doc } = await insertOrGetDocument(withId({ sha256: 'f'.repeat(64) }), {
      businessId: BUSINESS,
    });

    await markExtracted(doc.documentId, [
      { ordinal: 1, kind: 'outline', partName: null, content: { parts: [], flags: [] }, flags: [] },
      { ordinal: 0, kind: 'table', partName: 'גיליון1', content: { rows: [] }, flags: [] },
    ], { businessId: BUSINESS });

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts.map((a) => a.ordinal)).toEqual([0, 1]);
    expect(artifacts[0]?.partName).toBe('גיליון1');
  });

  it('rolls back the whole write when one artefact is invalid, leaving status untouched', async () => {
    const { document: doc } = await insertOrGetDocument(withId({ sha256: '1'.repeat(64) }), {
      businessId: BUSINESS,
    });

    await expect(
      markExtracted(doc.documentId, [
        { ordinal: 0, kind: 'table', partName: null, content: { rows: [] }, flags: [] },
        // Not a real ArtifactKind — forces the DB's CHECK constraint to reject
        // the whole transaction.
        { ordinal: 1, kind: 'bogus' as never, partName: null, content: {}, flags: [] },
      ], { businessId: BUSINESS }),
    ).rejects.toThrow();

    const stillPending = await insertOrGetDocument(withId({ sha256: '1'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(stillPending.created).toBe(false);
    expect(stillPending.document.status).toBe('pending');

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(0);
  });

  it('refuses a businessId that does not own the document, and leaves no artefact rows behind', async () => {
    const { document: doc } = await insertOrGetDocument(withId({ sha256: '3'.repeat(64) }), {
      businessId: BUSINESS,
    });

    // `document_artifacts.document_id` FK-references `documents.document_id`
    // alone (see the migration header), so the FK is satisfied by the row
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

    const stillPending = await insertOrGetDocument(withId({ sha256: '3'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(stillPending.created).toBe(false);
    expect(stillPending.document.status).toBe('pending');
  });
});

describe('markRejected', () => {
  it('records why, and leaves no artefacts behind', async () => {
    const { document: doc } = await insertOrGetDocument(withId({ sha256: '2'.repeat(64) }), {
      businessId: BUSINESS,
    });

    await markRejected(doc.documentId, 'סוג קובץ לא נתמך: application/x-msdownload', {
      businessId: BUSINESS,
    });

    const rejected = await insertOrGetDocument(withId({ sha256: '2'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(rejected.created).toBe(false);
    expect(rejected.document.status).toBe('rejected');
    expect(rejected.document.reason).toBe('סוג קובץ לא נתמך: application/x-msdownload');

    const artifacts = await loadArtifacts(doc.documentId, { businessId: BUSINESS });
    expect(artifacts).toHaveLength(0);
  });

  it('refuses a businessId that does not own the document', async () => {
    const { document: doc } = await insertOrGetDocument(withId({ sha256: '4'.repeat(64) }), {
      businessId: BUSINESS,
    });

    await expect(
      markRejected(doc.documentId, 'not yours', { businessId: OTHER_BUSINESS }),
    ).rejects.toThrow();

    const stillPending = await insertOrGetDocument(withId({ sha256: '4'.repeat(64) }), {
      businessId: BUSINESS,
    });
    expect(stillPending.created).toBe(false);
    expect(stillPending.document.status).toBe('pending');
    expect(stillPending.document.reason).toBeNull();
  });
});
