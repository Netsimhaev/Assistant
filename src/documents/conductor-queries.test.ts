import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from './store.js';
import { ingestDocument } from './ingest.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUSINESS = 'biz-conductor';

async function anExtractedDocument(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cond-'));
  const path = join(dir, 'note.txt');
  await writeFile(path, text, 'utf8');
  const doc = await ingestDocument(
    { path, source: 'manual' },
    { businessId: BUSINESS, documentRoot: dir },
  );
  expect(doc.status, 'fixture must produce an extracted document').toBe('extracted');
  return doc.documentId;
}

describe('the conductor queries', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('offers an extracted document that has never been read', async () => {
    const documentId = await anExtractedDocument('שלום');
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('still offers a document that has a reading but no proposal yet', async () => {
    // A throw between `readDocument` returning and `proposeForReading`
    // writing its row must not retire the document forever — the reading
    // alone is not the completion marker (see `documentsAwaitingRead`'s own
    // docblock, ruling I2). A re-offer costs nothing: the same brief hits the
    // reading cache instead of the model.
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, reason, content,
          provenance, model, prompt_version, brief_hash)
       VALUES ('RD-1', $1, $2, 'read', NULL, '{}'::jsonb,
               'unknown_external', 'test', 'v1', 'h')`,
      [BUSINESS, documentId],
    );
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('stops offering a document once it has a proposal', async () => {
    // The completion marker: a proposal reachable through the reading, even
    // an `unproposable` one — a genuine dead end must still terminate.
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, reason, content,
          provenance, model, prompt_version, brief_hash)
       VALUES ('RD-1', $1, $2, 'read', NULL, '{}'::jsonb,
               'unknown_external', 'test', 'v1', 'h')`,
      [BUSINESS, documentId],
    );
    await getPool().query(
      `INSERT INTO proposals
         (proposal_id, business_id, reading_id, job_id, status, reason, content, raw,
          model, prompt_version)
       VALUES ('PRP-1', $1, 'RD-1', NULL, 'unproposable', 'nothing to act on', NULL, '{}',
               'test', 'v1')`,
      [BUSINESS],
    );
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting).toEqual([]);
  });

  it('never lets another business\'s proposal suppress this one\'s document', async () => {
    // Both hops of the join (`document_readings`, `proposals`) are scoped by
    // `business_id` independently — a proposal that happens to reference the
    // same `reading_id` under a different business must not count.
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, reason, content,
          provenance, model, prompt_version, brief_hash)
       VALUES ('RD-1', $1, $2, 'read', NULL, '{}'::jsonb,
               'unknown_external', 'test', 'v1', 'h')`,
      [BUSINESS, documentId],
    );
    await getPool().query(
      `INSERT INTO proposals
         (proposal_id, business_id, reading_id, job_id, status, reason, content, raw,
          model, prompt_version)
       VALUES ('PRP-1', 'other-biz', 'RD-1', NULL, 'unproposable', 'not mine', NULL, '{}',
               'test', 'v1')`,
      [],
    );
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('stops offering a document after three failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    for (let i = 0; i < 3; i += 1) {
      await recordReadFailure(documentId, `boom ${i}`, { businessId: BUSINESS });
    }
    expect(await documentsAwaitingRead(10, { businessId: BUSINESS })).toEqual([]);

    const { rows } = await getPool().query<{ read_attempts: number; read_error: string }>(
      `SELECT read_attempts, read_error FROM documents WHERE document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.read_attempts).toBe(3);
    expect(rows[0]?.read_error).toBe('boom 2');
  });

  it('still offers a document after two failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    await recordReadFailure(documentId, 'once', { businessId: BUSINESS });
    await recordReadFailure(documentId, 'twice', { businessId: BUSINESS });
    const waiting = await documentsAwaitingRead(10, { businessId: BUSINESS });
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('never offers another business\'s document', async () => {
    await anExtractedDocument('שלום');
    expect(await documentsAwaitingRead(10, { businessId: 'someone-else' })).toEqual([]);
  });

  it('counts only readings created today, for this business', async () => {
    const documentId = await anExtractedDocument('שלום');
    await getPool().query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, reason, content,
          provenance, model, prompt_version, brief_hash, created_at)
       VALUES
         ('RD-today', $1, $2, 'read', NULL, '{}'::jsonb, 'unknown_external', 'test', 'v1', 'h1', now()),
         ('RD-old',   $1, $2, 'read', NULL, '{}'::jsonb, 'unknown_external', 'test', 'v1', 'h2', now() - interval '2 days'),
         ('RD-other', 'other-biz', $2, 'read', NULL, '{}'::jsonb, 'unknown_external', 'test', 'v1', 'h3', now())`,
      [BUSINESS, documentId],
    );

    // `RD-other` names a document belonging to BUSINESS, which the foreign key
    // allows — `document_readings` references `documents (document_id)` alone.
    // That is the point: the count must exclude it on `business_id`, not on
    // whether the join happens to resolve.
    expect(await readingsToday({ businessId: BUSINESS })).toBe(1);
  });
});
