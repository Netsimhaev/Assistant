import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import type { Reading } from '../domain/reading.js';
import { insertOrGetDocument } from './store.js';
import {
  findReadingForBrief,
  loadLatestReading,
  saveReading,
  type NewReading,
} from './reading-store.js';

const BUSINESS = 'test-business';
const OTHER_BUSINESS = 'other-business';

const READING: Reading = {
  summary: 'הצעת מחיר.',
  findings: [],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' }],
  unreadable: [],
};

async function aDocument(businessId = BUSINESS): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'הצעה.xlsx',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 10,
      storedPath: `${businessId}/${documentId}/original.txt`,
    },
    { businessId },
  );
  return documentId;
}

function newReading(documentId: string, overrides: Partial<NewReading> = {}): NewReading {
  return {
    readingId: `RDG-${ulid()}`,
    documentId,
    status: 'read',
    reason: null,
    content: READING,
    provenance: 'unknown_external',
    model: 'haiku',
    promptVersion: 'v1',
    briefHash: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

describe('saveReading', () => {
  it('stores a successful reading and hands it back', async () => {
    const documentId = await aDocument();
    const { record, created } = await saveReading(newReading(documentId), { businessId: BUSINESS });
    expect(created).toBe(true);
    expect(record.status).toBe('read');
    expect(record.content?.summary).toBe('הצעת מחיר.');
    expect(record.provenance).toBe('unknown_external');
  });

  it('stores an unreadable outcome, because a failed attempt is a fact', async () => {
    const documentId = await aDocument();
    const { record } = await saveReading(
      newReading(documentId, { status: 'unreadable', reason: 'no JSON object in the response', content: null }),
      { businessId: BUSINESS },
    );
    expect(record.status).toBe('unreadable');
    expect(record.reason).toBe('no JSON object in the response');
    expect(record.content).toBeNull();
  });

  it('returns the existing row instead of a second one for the same brief', async () => {
    const documentId = await aDocument();
    const first = await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId), { businessId: BUSINESS });
    expect(second.created).toBe(false);
    expect(second.record.readingId).toBe(first.record.readingId);
  });

  it('treats a different prompt version as a different question', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId, { promptVersion: 'v2' }), { businessId: BUSINESS });
    expect(second.created).toBe(true);
  });

  it('treats a different brief as a different reading', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const second = await saveReading(newReading(documentId, { briefHash: 'b'.repeat(64) }), { businessId: BUSINESS });
    expect(second.created).toBe(true);
  });

  it('treats a different trust level as a different question', async () => {
    // Intake dedupes on `(business_id, sha256)`, so the same bytes arriving
    // from the owner and later from a stranger are one `documents` row. Two
    // readings, not one — and neither lookup may be served the other's row,
    // or the cache becomes a way to raise a trust level (migration 014).
    const documentId = await aDocument();
    const boss = await saveReading(newReading(documentId, { provenance: 'boss' }), { businessId: BUSINESS });
    const stranger = await saveReading(
      newReading(documentId, { provenance: 'unknown_external' }),
      { businessId: BUSINESS },
    );
    expect(stranger.created).toBe(true);
    expect(stranger.record.readingId).not.toBe(boss.record.readingId);

    const asBoss = await findReadingForBrief(documentId, 'a'.repeat(64), 'v1', 'boss', { businessId: BUSINESS });
    const asStranger = await findReadingForBrief(
      documentId, 'a'.repeat(64), 'v1', 'unknown_external', { businessId: BUSINESS },
    );
    expect(asBoss?.readingId).toBe(boss.record.readingId);
    expect(asBoss?.provenance).toBe('boss');
    expect(asStranger?.readingId).toBe(stranger.record.readingId);
    expect(asStranger?.provenance).toBe('unknown_external');
  });

  it('refuses a read row with no content', async () => {
    const documentId = await aDocument();
    await expect(
      saveReading(newReading(documentId, { content: null }), { businessId: BUSINESS }),
    ).rejects.toThrow();
  });
});

describe('findReadingForBrief', () => {
  it('finds the reading made from this exact brief', async () => {
    const documentId = await aDocument();
    const { record } = await saveReading(newReading(documentId), { businessId: BUSINESS });
    const found = await findReadingForBrief(documentId, 'a'.repeat(64), 'v1', 'unknown_external', { businessId: BUSINESS });
    expect(found?.readingId).toBe(record.readingId);
  });

  it('returns null for a brief nobody has read', async () => {
    const documentId = await aDocument();
    expect(
      await findReadingForBrief(documentId, 'c'.repeat(64), 'v1', 'unknown_external', { businessId: BUSINESS }),
    ).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    const found = await findReadingForBrief(documentId, 'a'.repeat(64), 'v1', 'unknown_external', { businessId: OTHER_BUSINESS });
    expect(found).toBeNull();
  });
});

describe('loadLatestReading', () => {
  it('returns the most recently created reading, not merely one of the candidates', async () => {
    // `created_at` ties inside a single millisecond are ordinary in this
    // suite, and `ulid()` here is not the monotonic factory, so two ids
    // generated in the same millisecond sort randomly relative to each
    // other. A test that only checks membership in {v1, v2} would pass even
    // with `ORDER BY created_at ASC` — so the first reading is backdated by
    // an hour with a direct query, and the assertion names the second
    // reading specifically, by id. Reversing the ORDER BY must fail this.
    const documentId = await aDocument();
    const first = await saveReading(newReading(documentId), { businessId: BUSINESS });
    await getPool().query(
      `UPDATE document_readings SET created_at = now() - interval '1 hour' WHERE reading_id = $1`,
      [first.record.readingId],
    );
    const second = await saveReading(newReading(documentId, { promptVersion: 'v2' }), { businessId: BUSINESS });

    const latest = await loadLatestReading(documentId, 'unknown_external', { businessId: BUSINESS });
    expect(latest).not.toBeNull();
    expect(latest?.readingId).toBe(second.record.readingId);
    expect(latest?.promptVersion).toBe('v2');
  });

  it('returns null when a document has never been read', async () => {
    const documentId = await aDocument();
    expect(await loadLatestReading(documentId, 'unknown_external', { businessId: BUSINESS })).toBeNull();
  });

  it('does not hand back a reading made under a different trust level', async () => {
    // The hole migration 014 closed in `findReadingForBrief`, checked again
    // here: a lookup under one provenance must never return another
    // provenance's row, even when that row is newer.
    const documentId = await aDocument();
    const boss = await saveReading(newReading(documentId, { provenance: 'boss' }), { businessId: BUSINESS });
    const stranger = await saveReading(
      newReading(documentId, { provenance: 'unknown_external', promptVersion: 'v2' }),
      { businessId: BUSINESS },
    );

    const asBoss = await loadLatestReading(documentId, 'boss', { businessId: BUSINESS });
    expect(asBoss?.readingId).toBe(boss.record.readingId);

    const asStranger = await loadLatestReading(documentId, 'unknown_external', { businessId: BUSINESS });
    expect(asStranger?.readingId).toBe(stranger.record.readingId);
  });
});

describe('the readings table', () => {
  it('drops a document\'s readings when the document is deleted', async () => {
    const documentId = await aDocument();
    await saveReading(newReading(documentId), { businessId: BUSINESS });
    await getPool().query('DELETE FROM documents WHERE document_id = $1', [documentId]);
    const { rows } = await getPool().query(
      'SELECT 1 FROM document_readings WHERE document_id = $1',
      [documentId],
    );
    expect(rows).toHaveLength(0);
  });
});
