import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import type { ReadOutcome } from '../sdk/know-reader.js';
import { insertOrGetDocument, markExtracted } from './store.js';
import { readDocument } from './read.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

const READING_JSON = {
  summary: 'חשבונית מספק.',
  findings: [{ label: 'סכום', value: '1,200', sourceRef: { ordinal: 0, locator: null } }],
  intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null }, note: '' }],
  unreadable: [],
};

/** A reader that returns a fixed response without a model. Counts its calls. */
function stubReader(raw: string) {
  const calls: number[] = [];
  const reader = async (request: { artifacts: readonly unknown[] }): Promise<ReadOutcome> => {
    calls.push(request.artifacts.length);
    const { interpretReaderResponse } = await import('../sdk/know-reader.js');
    return interpretReaderResponse(raw, request.artifacts as never, [], 1);
  };
  return { reader, calls };
}

async function anExtractedDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'חשבונית.txt',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 20,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  await markExtracted(
    documentId,
    [{ ordinal: 0, kind: 'text', partName: 'גוף', content: { blocks: [{ kind: 'paragraph', text: 'סכום: 1,200' }] }, flags: [] }],
    { businessId: BUSINESS },
  );
  return documentId;
}

beforeEach(async () => {
  await resetDatabase();
  // `createJob` FKs `charter_version` to an installed row (migration 002); the
  // module-level `bundle` above is only `compileCharter`d, which never writes
  // one. Install the same charter under the same business so the two tests
  // below that create real jobs against `bundle.charterVersion` satisfy the
  // constraint.
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('readDocument', () => {
  it('reads a document and stores the reading', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'unknown_external', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('read');
    if (result.status !== 'read') throw new Error('expected a reading');
    expect(result.reading.summary).toBe('חשבונית מספק.');
    expect(result.record.status).toBe('read');
    expect(result.cached).toBe(false);
  });

  it('does not call the model twice for the same document and brief', async () => {
    const documentId = await anExtractedDocument();
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));
    const input = { documentId, bundle, provenance: 'unknown_external' as const, jobId: null };
    await readDocument(input, { businessId: BUSINESS, reader });
    const second = await readDocument(input, { businessId: BUSINESS, reader });
    expect(calls).toHaveLength(1);
    expect(second.status).toBe('read');
    if (second.status !== 'read') throw new Error('expected a reading');
    expect(second.cached).toBe(true);
  });

  it('records an unreadable outcome instead of throwing', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader('לא הצלחתי');
    const result = await readDocument(
      { documentId, bundle, provenance: 'unknown_external', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') throw new Error('expected unreadable');
    expect(result.record.status).toBe('unreadable');
    expect(result.record.content).toBeNull();
  });

  it('stores the source\'s trust level and never raises it', async () => {
    const documentId = await anExtractedDocument();
    const { reader } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'open_web', jobId: null },
      { businessId: BUSINESS, reader },
    );
    if (result.status !== 'read') throw new Error('expected a reading');
    expect(result.record.provenance).toBe('open_web');
  });

  it('marks the job as having ingested content before the read', async () => {
    const documentId = await anExtractedDocument();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'לקרוא חשבונית',
    });
    let flagDuringRead: boolean | null = null;
    const reader = async (request: { artifacts: readonly unknown[] }): Promise<ReadOutcome> => {
      const { rows } = await getPool().query<{ content_ingested: boolean }>(
        'SELECT content_ingested FROM jobs WHERE job_id = $1',
        [job.jobId],
      );
      flagDuringRead = rows[0]?.content_ingested ?? null;
      const { interpretReaderResponse } = await import('../sdk/know-reader.js');
      return interpretReaderResponse(JSON.stringify(READING_JSON), request.artifacts as never, [], 1);
    };

    const result = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: job.jobId },
      { businessId: BUSINESS, reader },
    );

    // The positive half matters: without it this test would pass even if the
    // read never happened at all.
    expect(result.status).toBe('read');
    expect(flagDuringRead).toBe(true);
  });

  it('refuses to read when the content-ingested flag cannot be recorded', async () => {
    const documentId = await anExtractedDocument();
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));

    // A job id that resolves to nothing — a stale id, a typo, or a job
    // belonging to another business all look exactly like this to the UPDATE.
    await expect(
      readDocument(
        { documentId, bundle, provenance: 'boss', jobId: `JOB-${ulid()}` },
        { businessId: BUSINESS, reader },
      ),
    ).rejects.toThrow(/content ingestion was not recorded/);

    // The read must not have happened, and nothing must have been stored:
    // failing closed after calling the model would record conclusions for a
    // job that does not remember consuming them.
    expect(calls).toHaveLength(0);
    const { rows } = await getPool().query(
      'SELECT 1 FROM document_readings WHERE document_id = $1',
      [documentId],
    );
    expect(rows).toHaveLength(0);
  });

  it('marks content ingested on a cache hit too, because the job still receives the document', async () => {
    const documentId = await anExtractedDocument();
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'לקרוא שוב',
    });
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));
    // First read, with no job, populates the cache.
    await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: null },
      { businessId: BUSINESS, reader },
    );
    const second = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: job.jobId },
      { businessId: BUSINESS, reader },
    );
    if (second.status !== 'read') throw new Error('expected a reading');

    // Both halves are load-bearing. Without them this would pass for the
    // ordinary reason — a fresh read marks the job — and prove nothing about
    // the cache path at all.
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);

    const { rows } = await getPool().query<{ content_ingested: boolean }>(
      'SELECT content_ingested FROM jobs WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows[0]?.content_ingested).toBe(true);
  });

  it('reports no_artifacts for a document that was never extracted', async () => {
    const documentId = `DOC-${ulid()}`;
    await insertOrGetDocument(
      {
        documentId,
        source: 'manual',
        originalName: 'ריק.txt',
        mediaType: 'text/plain',
        sha256: ulid().padEnd(64, '0'),
        byteSize: 0,
        storedPath: `${BUSINESS}/${documentId}/original.txt`,
      },
      { businessId: BUSINESS },
    );
    const { reader, calls } = stubReader(JSON.stringify(READING_JSON));
    const result = await readDocument(
      { documentId, bundle, provenance: 'boss', jobId: null },
      { businessId: BUSINESS, reader },
    );
    expect(result.status).toBe('no_artifacts');
    expect(calls).toHaveLength(0);
  });
});
