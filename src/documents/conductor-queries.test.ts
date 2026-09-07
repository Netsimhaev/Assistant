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

  it('stops offering a document once it has a reading', async () => {
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
    expect(waiting).toEqual([]);
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
