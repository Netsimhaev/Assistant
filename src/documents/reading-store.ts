/**
 * Reading and writing `document_readings` (spec §8).
 *
 * A reading is a model's claim about a document, and it lives in its own table
 * rather than as a fourth artefact kind for that reason — see the migration's
 * own header for the argument.
 */

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { Reading } from '../domain/reading.js';
import type { TrustLevel } from '../domain/trust.js';

export type ReadingStatus = 'read' | 'unreadable';

export interface ReadingRecord {
  readingId: string;
  businessId: string;
  documentId: string;
  status: ReadingStatus;
  reason: string | null;
  content: Reading | null;
  provenance: TrustLevel;
  model: string;
  promptVersion: string;
  briefHash: string;
}

/** What a caller supplies. `businessId` rides on the options, as everywhere else here. */
export interface NewReading {
  readingId: string;
  documentId: string;
  status: ReadingStatus;
  reason: string | null;
  content: Reading | null;
  provenance: TrustLevel;
  model: string;
  promptVersion: string;
  briefHash: string;
}

interface ReadingRow {
  reading_id: string;
  business_id: string;
  document_id: string;
  status: string;
  reason: string | null;
  content: unknown;
  provenance: string;
  model: string;
  prompt_version: string;
  brief_hash: string;
}

function toReading(row: ReadingRow): ReadingRecord {
  return {
    readingId: row.reading_id,
    businessId: row.business_id,
    documentId: row.document_id,
    status: row.status as ReadingStatus,
    reason: row.reason,
    // Stored as validated JSON, read back without re-validation: what went in
    // passed `Reading.safeParse` at the boundary, and re-parsing here would
    // make every read of the table able to fail for a reason the caller cannot
    // act on.
    content: (row.content ?? null) as Reading | null,
    provenance: row.provenance as TrustLevel,
    model: row.model,
    promptVersion: row.prompt_version,
    briefHash: row.brief_hash,
  };
}

const COLUMNS = `reading_id, business_id, document_id, status, reason, content,
                 provenance, model, prompt_version, brief_hash`;

/**
 * Store a reading, or hand back the one already stored for this exact brief
 * and prompt version.
 *
 * A single `INSERT ... ON CONFLICT DO NOTHING RETURNING *` followed by a
 * `SELECT` when the insert lost — the shape `insertOrGetDocument` already uses,
 * and for the same reason: read-then-write lets two concurrent readers of one
 * document both insert, and the loser dies on the unique index instead of
 * quietly getting the row that won.
 */
export async function saveReading(
  input: NewReading,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<{ record: ReadingRecord; created: boolean }> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const inserted = await db.query<ReadingRow>(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, reason, content,
        provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (business_id, document_id, brief_hash, prompt_version, provenance) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.readingId,
      businessId,
      input.documentId,
      input.status,
      input.reason,
      input.content === null ? null : JSON.stringify(input.content),
      input.provenance,
      input.model,
      input.promptVersion,
      input.briefHash,
    ],
  );

  const row = inserted.rows[0];
  if (row !== undefined) return { record: toReading(row), created: true };

  const existing = await findReadingForBrief(
    input.documentId,
    input.briefHash,
    input.promptVersion,
    input.provenance,
    { businessId, db },
  );
  if (existing === null) {
    // The insert conflicted and the conflicting row is not visible. That is
    // not a document property — it is the table disagreeing with itself.
    throw new Error(
      `saveReading: conflict on ${input.documentId} but no row to return; the readings table is inconsistent`,
    );
  }
  return { record: existing, created: false };
}

/**
 * The reading made from this exact brief, under this exact prompt version, of
 * material carrying this exact trust level — if any.
 *
 * `provenance` is part of the question and not a detail of the answer
 * (migration 014). Matching without it let a reading made under `boss` be
 * handed back for the same bytes arriving from an untrusted sender, which
 * raised a trust level through the cache — the one thing the stored column's
 * own comment forbids.
 */
export async function findReadingForBrief(
  documentId: string,
  briefHash: string,
  promptVersion: string,
  provenance: TrustLevel,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${COLUMNS} FROM document_readings
      WHERE business_id = $1 AND document_id = $2
        AND brief_hash = $3 AND prompt_version = $4 AND provenance = $5`,
    [options.businessId ?? config.businessId, documentId, briefHash, promptVersion, provenance],
  );
  const row = rows[0];
  return row === undefined ? null : toReading(row);
}

/** The most recent reading of a document, whatever brief produced it. */
export async function loadLatestReading(
  documentId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ReadingRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${COLUMNS} FROM document_readings
      WHERE business_id = $1 AND document_id = $2
      ORDER BY created_at DESC, reading_id DESC
      LIMIT 1`,
    [options.businessId ?? config.businessId, documentId],
  );
  const row = rows[0];
  return row === undefined ? null : toReading(row);
}
