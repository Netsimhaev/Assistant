import { beforeEach, describe, expect, it } from 'vitest';
import { getPool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from './store.js';
import { ingestDocument } from './ingest.js';
import { createJob } from '../orchestrator/jobs.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUSINESS = 'biz-conductor';

async function anExtractedDocument(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cond-'));
  const path = join(dir, 'note.txt');
  await writeFile(path, text, 'utf8');
  const doc = await withBusiness(BUSINESS, (db) => ingestDocument(
    db,
    { path, source: 'manual' },
    { documentRoot: dir },
  ));
  expect(doc.status, 'fixture must produce an extracted document').toBe('extracted');
  return doc.documentId;
}

describe('the conductor queries', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('offers an extracted document that has never been read', async () => {
    const documentId = await anExtractedDocument('שלום');
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
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
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
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
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
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
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('stops offering a document after three failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    for (let i = 0; i < 3; i += 1) {
      await withBusiness(BUSINESS, (db) => recordReadFailure(db, documentId, `boom ${i}`));
    }
    expect(await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10))).toEqual([]);

    const { rows } = await getPool().query<{ read_attempts: number; read_error: string }>(
      `SELECT read_attempts, read_error FROM documents WHERE document_id = $1`,
      [documentId],
    );
    expect(rows[0]?.read_attempts).toBe(3);
    expect(rows[0]?.read_error).toBe('boom 2');
  });

  it('still offers a document after two failures', async () => {
    const documentId = await anExtractedDocument('שלום');
    await withBusiness(BUSINESS, (db) => recordReadFailure(db, documentId, 'once'));
    await withBusiness(BUSINESS, (db) => recordReadFailure(db, documentId, 'twice'));
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
    expect(waiting.map((d) => d.documentId)).toEqual([documentId]);
  });

  it('never offers a file the owner attached to an instruction, only the inbox file beside it', async () => {
    // An owner upload is ingested as an ordinary `manual` document. Without
    // the exclusion the conductor read it as a stranger's document
    // (`unknown_external`) and raised a card on the owner's own file.
    const ownerUpload = await anExtractedDocument('הצעת מחיר שהבעלים העלה');
    const inboxFile = await anExtractedDocument('מסמך מתיקיית הקליטה');
    const foreignNamed = await anExtractedDocument('מסמך שעסק אחר נוקב בו');
    const db = getPool();
    const own = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'cond-own' })));
    const foreign = await withBusiness('someone-else', (bdb) => installCharter(bdb, buildCharter({ version: 'cond-foreign' })));
    const ownJob = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: own.charterVersion, provenance: 'boss' }));
    const foreignJob = await withBusiness('someone-else', (db) => createJob(db, { charterVersion: foreign.charterVersion, provenance: 'boss' }));
    await db.query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin, attached_document_ids)
       VALUES ('INS-upload', $1, $2, 'תכיני הצעה', 'typed', $3)`,
      [BUSINESS, ownJob.jobId, [ownerUpload]],
    );
    // Same id under ANOTHER business: must not hide this business's file.
    await db.query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin, attached_document_ids)
       VALUES ('INS-foreign', 'someone-else', $1, 'תכיני הצעה', 'typed', $2)`,
      [foreignJob.jobId, [foreignNamed]],
    );

    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
    expect(waiting.map((d) => d.documentId).sort()).toEqual([inboxFile, foreignNamed].sort());
    expect(waiting.map((d) => d.documentId)).not.toContain(ownerUpload);
  });

  it('never offers another business\'s document', async () => {
    await anExtractedDocument('שלום');
    expect(await withBusiness('someone-else', (db) => documentsAwaitingRead(db, 10))).toEqual([]);
  });

  it('never offers a file uploaded with an instruction, even when no instruction row ever named it', async () => {
    // The structural layer: an upload whose instruction was refused (or
    // crashed) before `boss_instructions` was written carries no attached
    // id anywhere — only its source says it was the owner's.
    const dir = await mkdtemp(join(tmpdir(), 'cond-'));
    const path = join(dir, 'upload');
    await writeFile(path, 'מחירון שהבעלים העלה', 'utf8');
    const upload = await withBusiness(BUSINESS, (db) => ingestDocument(db, { path, source: 'instruction' }, { documentRoot: dir }));
    expect(upload.status).toBe('extracted');
    const inboxFile = await anExtractedDocument('מסמך מתיקיית הקליטה');
    const waiting = await withBusiness(BUSINESS, (db) => documentsAwaitingRead(db, 10));
    expect(waiting.map((d) => d.documentId)).toEqual([inboxFile]);
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
    expect(await withBusiness(BUSINESS, (db) => readingsToday(db))).toBe(1);
  });
});
