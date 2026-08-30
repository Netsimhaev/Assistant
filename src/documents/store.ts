import type pg from 'pg';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import type {
  ArtifactKind,
  DocumentArtifact,
  DocumentRecord,
  DocumentSource,
  DocumentStatus,
} from './types.js';

export type {
  ArtifactKind,
  DocumentArtifact,
  DocumentRecord,
  DocumentSource,
  DocumentStatus,
} from './types.js';

interface DocumentRow {
  document_id: string;
  business_id: string;
  source: string;
  original_name: string;
  media_type: string;
  sha256: string;
  byte_size: bigint;
  stored_path: string;
  status: string;
  reason: string | null;
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    documentId: row.document_id,
    businessId: row.business_id,
    source: row.source as DocumentSource,
    originalName: row.original_name,
    mediaType: row.media_type,
    sha256: row.sha256,
    // `byte_size` is BIGINT; the pool's type parser hands it back as a JS
    // `bigint`. Documents are capped well under Number.MAX_SAFE_INTEGER
    // (§3.4: 25MB originals), so a plain `number` is safe and far more
    // convenient for every caller that compares it against a ceiling.
    byteSize: Number(row.byte_size),
    storedPath: row.stored_path,
    status: row.status as DocumentStatus,
    reason: row.reason,
  };
}

interface ArtifactRow {
  ordinal: number;
  kind: string;
  part_name: string | null;
  content: unknown;
  flags: string[];
}

function toArtifact(row: ArtifactRow): DocumentArtifact {
  return {
    ordinal: row.ordinal,
    kind: row.kind as ArtifactKind,
    partName: row.part_name,
    content: row.content,
    flags: row.flags,
  };
}

/** What the caller of `insertOrGetDocument` provides. Everything else is derived. */
export interface NewDocument {
  source: DocumentSource;
  originalName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  storedPath: string;
}

/**
 * What the caller of `insertOrGetDocument` provides — `NewDocument` plus a
 * caller-generated `documentId`. The id is not generated inside
 * `insertOrGetDocument`: `stored_path` is built from it
 * (`<documentRoot>/<businessId>/<documentId>/original.<ext>`, §3.5) by
 * `ingestDocument` *before* this call, since `stored_path` is itself one of
 * the columns this INSERT writes. Generating the id inside the function
 * would make that impossible to sequence.
 */
export interface NewDocumentWithId extends NewDocument {
  documentId: string;
}

/**
 * Store a newly-arrived document as `pending`, or hand back the document
 * already stored under this business for the same `sha256` (§8: "same
 * sha256 already exists → the existing document is returned; no duplicate
 * is created").
 *
 * A single `INSERT ... ON CONFLICT (business_id, sha256) DO NOTHING
 * RETURNING *` — the same shape `bindPlanToJob` already uses in
 * `orchestrator/plan-store.ts` — not a `SELECT` to check for an existing row
 * followed by a plain `INSERT`. That two-statement form is a real race: two
 * concurrent ingests of identical bytes both read nothing, both insert, and
 * the unique index on `(business_id, sha256)` rejects the loser with a
 * thrown error instead of quietly returning the row that won. Folding the
 * check into the INSERT's own conflict clause makes the database the single
 * point of truth for "did this row already exist," instead of two callers
 * racing a read. (An earlier version of this module exposed that
 * two-statement form directly as `insertDocument`/`findBySha`, with nothing
 * in production ever calling either — see I5 of the intake fix wave: both
 * were deleted, and this function's own dedupe path picked up the direct
 * unit-test coverage the deleted pair had instead.)
 *
 * When this call loses the race (`created: false`), the caller's own
 * `documentId` and any file already associated with it in memory were never
 * written anywhere — `ingestDocument` only writes bytes to disk after a
 * `created: true` result, so a lost race leaves no orphaned file.
 */
export async function insertOrGetDocument(
  input: NewDocumentWithId,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<{ document: DocumentRecord; created: boolean }> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const documentId = input.documentId;

  const inserted = await db.query<DocumentRow>(
    `INSERT INTO documents
       (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (business_id, sha256) DO NOTHING
     RETURNING *`,
    [
      documentId,
      businessId,
      input.source,
      input.originalName,
      input.mediaType,
      input.sha256,
      input.byteSize,
      input.storedPath,
    ],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) return { document: toDocument(insertedRow), created: true };

  // Lost the race (or simply arrived second): another row already holds
  // this (business_id, sha256) pair. Read it back rather than fabricate a
  // record from what we tried to insert — a concurrent winner's row may
  // carry a different documentId, source or storedPath than ours would
  // have.
  const { rows } = await db.query<DocumentRow>(
    'SELECT * FROM documents WHERE business_id = $1 AND sha256 = $2',
    [businessId, input.sha256],
  );
  const existing = rows[0];
  if (!existing) {
    // The ON CONFLICT fired, which means a row for this (business_id,
    // sha256) existed a statement ago — only a concurrent delete of that
    // exact document explains its absence now. Louder than pretending we
    // found nothing.
    throw new Error(
      `insertOrGetDocument: ON CONFLICT fired for business ${businessId} sha256 ${input.sha256}, but no row was found on re-select`,
    );
  }
  return { document: toDocument(existing), created: false };
}

/**
 * Write a document's extracted parts and flip its status to `extracted`, in
 * one transaction.
 *
 * The two writes must land together, and neither may land without the other
 * — including when the status UPDATE matches zero rows. `document_artifacts.
 * document_id` references `documents.document_id` alone, not the
 * `(business_id, document_id)` pair (see the migration header), so the
 * artefact INSERTs above succeed even when `documentId` does not belong to
 * `businessId`: the FK is satisfied by the row under its real owner. Left
 * unchecked, the UPDATE below would then match nothing, the transaction
 * would commit anyway, and `loadArtifacts` — which does not gate on status —
 * would surface those rows to the wrong business under a document that still
 * reads `pending`. Checking `rowCount` and throwing on zero rolls the
 * artefact inserts back with it, so "invisible until the status says it is
 * worth calling" stays true rather than merely stated.
 */
export async function markExtracted(
  documentId: string,
  artifacts: DocumentArtifact[],
  options: { businessId?: string } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;

  await withTransaction(async (tx: pg.PoolClient) => {
    for (const artifact of artifacts) {
      await tx.query(
        `INSERT INTO document_artifacts
           (business_id, document_id, ordinal, kind, part_name, content, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          businessId,
          documentId,
          artifact.ordinal,
          artifact.kind,
          artifact.partName,
          JSON.stringify(artifact.content),
          artifact.flags,
        ],
      );
    }

    const { rowCount } = await tx.query(
      `UPDATE documents SET status = 'extracted', extracted_at = now()
        WHERE business_id = $1 AND document_id = $2`,
      [businessId, documentId],
    );

    // Zero rows means no document with this id belongs to this business —
    // wrong tenant, wrong id, or never inserted. Throwing here (inside the
    // transaction) rolls back every artefact insert above along with it.
    if ((rowCount ?? 0) === 0) {
      throw new Error(
        `markExtracted: no document ${documentId} for business ${businessId}; rolling back its artefacts`,
      );
    }
  });
}

/** Mark a document `rejected` with a human-readable reason (§8). The original bytes stay on disk. */
export async function markRejected(
  documentId: string,
  reason: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const { rowCount } = await db.query(
    `UPDATE documents SET status = 'rejected', reason = $3
      WHERE business_id = $1 AND document_id = $2`,
    [options.businessId ?? config.businessId, documentId, reason],
  );

  // Same reasoning as markExtracted: a zero-row match here means this
  // business does not own `documentId`, and writing nothing must not look
  // like success.
  if ((rowCount ?? 0) === 0) {
    throw new Error(
      `markRejected: no document ${documentId} for business ${options.businessId ?? config.businessId}`,
    );
  }
}

/** A document's extracted parts, ordered the way they were written. */
export async function loadArtifacts(
  documentId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DocumentArtifact[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ArtifactRow>(
    `SELECT ordinal, kind, part_name, content, flags FROM document_artifacts
      WHERE business_id = $1 AND document_id = $2
      ORDER BY ordinal`,
    [options.businessId ?? config.businessId, documentId],
  );
  return rows.map(toArtifact);
}
