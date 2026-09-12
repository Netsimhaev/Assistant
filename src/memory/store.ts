/**
 * The memory store: the durable half of "record and remember".
 *
 * These are the only two things the owner authorised the assistant to do on
 * its own initiative, and until now neither happened — `memory.write_*` and
 * `memory.recall` reached no executor and returned `null`, so a plan that
 * "recalled" something proceeded on nothing and a plan that "recorded"
 * something recorded nothing.
 *
 * **The rule this module exists to keep: a memory carries the trust level of
 * the job that wrote it, and recall never strips it.**
 *
 * A supplier's document that says "our new bank account is X" is a claim that
 * supplier made. If writing it down converts it into a fact the business
 * knows, the injection succeeded — it just took a day longer. So `provenance`
 * is stored on every row, returned with every recalled row, and is read from
 * the job record by `writeMemory` itself. It is not a field on the input: a
 * caller able to choose it is a caller able to launder a stranger's claim into
 * the owner's own knowledge, which is the same reasoning `grantAuthorization`
 * uses to read `jobs.provenance` for itself rather than trust its caller.
 *
 * No embeddings and no similarity search. L3 needs pgvector (see
 * `001_spine.sql`) and is not built; recall here is by subject and by keyword
 * over the stored text. That is less than the spec's eventual L3 and more than
 * the nothing that preceded it, and it is described honestly rather than
 * named after the layer it is not.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { TrustLevel } from '../domain/trust.js';

/** What a memory is. Closed here and closed again by a CHECK in migration 024. */
export type MemoryKind = 'entity' | 'preference' | 'chunk';

export interface MemoryRecord {
  memoryId: string;
  kind: MemoryKind;
  subjectKey: string;
  attribute: string | null;
  body: Record<string, unknown>;
  /** The trust level of the job that wrote it. Never absent, never inferred. */
  provenance: TrustLevel;
  writtenByJob: string | null;
  sourceRef: string | null;
  createdAt: Date;
}

interface MemoryRow {
  memory_id: string;
  kind: string;
  subject_key: string;
  attribute: string | null;
  body: unknown;
  provenance: string;
  written_by_job: string | null;
  source_ref: string | null;
  created_at: Date;
}

function toRecord(row: MemoryRow): MemoryRecord {
  const parsed = TrustLevel.safeParse(row.provenance);
  return {
    memoryId: row.memory_id,
    kind: row.kind as MemoryKind,
    subjectKey: row.subject_key,
    attribute: row.attribute,
    body: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Record<string, unknown>,
    // A level this build does not recognise reads as the least trusted one
    // available, never as the most. Same rule `loadRampLevel` keeps for a
    // level string it cannot rank: a value nobody can read is never a
    // permissive value.
    provenance: parsed.success ? parsed.data : 'open_web',
    writtenByJob: row.written_by_job,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
  };
}

/** Thrown when the job a write claims to belong to cannot be resolved. */
export class MemoryJobUnresolvedError extends Error {}

export interface WriteMemoryInput {
  jobId: string;
  kind: MemoryKind;
  subjectKey: string;
  /** Required for `preference`, forbidden for the others — the DB checks too. */
  attribute?: string | null;
  body: Record<string, unknown>;
  sourceRef?: string | null;
}

/**
 * Write one memory, stamped with the provenance of the job that caused it.
 *
 * The provenance is read here, from `jobs`, and an unresolved job throws
 * rather than defaulting. That is the same decision `readDocument` makes when
 * its `markContentIngested` update matches no row, and for the same reason: a
 * job id that does not resolve is not a property of the thing being written,
 * it is a caller that has lost track of what it is doing.
 *
 * An entity or preference that already exists is replaced, and the old row is
 * retired rather than deleted — "what we used to believe" is the question a
 * business asks when a decision it made last quarter stops making sense.
 */
export async function writeMemory(
  input: WriteMemoryInput,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<MemoryRecord> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const job = await db.query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [input.jobId, businessId],
  );
  const provenance = job.rows[0]?.provenance;
  if (provenance === undefined) {
    throw new MemoryJobUnresolvedError(
      `writeMemory: no job ${input.jobId} for business ${businessId}`,
    );
  }

  const attribute = input.kind === 'preference' ? (input.attribute ?? null) : null;

  // Retire the row this one replaces, in the same statement order as the
  // insert so the partial unique index can never see two live rows. Chunks
  // accumulate; only the keyed kinds replace.
  if (input.kind === 'entity' || input.kind === 'preference') {
    await db.query(
      `UPDATE memories
          SET retired_at = now(), retired_reason = 'superseded'
        WHERE business_id = $1 AND kind = $2 AND subject_key = $3
          AND attribute IS NOT DISTINCT FROM $4
          AND retired_at IS NULL`,
      [businessId, input.kind, input.subjectKey, attribute],
    );
  }

  const { rows } = await db.query<MemoryRow>(
    `INSERT INTO memories
       (memory_id, business_id, kind, subject_key, attribute, body,
        provenance, written_by_job, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING memory_id, kind, subject_key, attribute, body, provenance,
               written_by_job, source_ref, created_at`,
    [
      `MEM-${randomUUID()}`,
      businessId,
      input.kind,
      input.subjectKey,
      attribute,
      JSON.stringify(input.body),
      provenance,
      input.jobId,
      input.sourceRef ?? null,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('writeMemory: insert returned no row');
  return toRecord(row);
}

/**
 * Retire a memory: it stopped being true.
 *
 * Soft, and returns how many rows it touched so a caller can tell "retired
 * three" from "found none" — an operation that silently affects nothing is
 * indistinguishable from one that worked.
 */
export async function retireMemories(
  input: { kind: MemoryKind; subjectKey: string; attribute?: string | null; reason: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const attribute = input.kind === 'preference' ? (input.attribute ?? null) : null;

  const result = await db.query(
    `UPDATE memories
        SET retired_at = now(), retired_reason = $5
      WHERE business_id = $1 AND kind = $2 AND subject_key = $3
        AND attribute IS NOT DISTINCT FROM $4
        AND retired_at IS NULL`,
    [businessId, input.kind, input.subjectKey, attribute, input.reason],
  );
  return result.rowCount ?? 0;
}

export interface RecallQuery {
  /** Who or what it is about. Exact match. */
  subjectKey?: string;
  /** A word to look for in the stored text. Case-insensitive, substring. */
  keyword?: string;
  kind?: MemoryKind;
  limit?: number;
}

/** How many memories one recall may return, whatever the caller asked for. */
export const MAX_RECALL = 20;

/**
 * Read memories back, newest first, retired rows excluded.
 *
 * Every returned record carries its `provenance`. That is not a convenience
 * for the caller — it is the control: the reader has to be able to tell a
 * thing the owner said from a thing a stranger's document said, a month after
 * neither is fresh in anyone's mind.
 *
 * A query with neither `subjectKey` nor `keyword` returns the most recent
 * memories rather than everything, because `limit` is capped. "Recall
 * everything" is not a question this store answers.
 */
export async function recallMemories(
  query: RecallQuery,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<MemoryRecord[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const where: string[] = ['business_id = $1', 'retired_at IS NULL'];
  const params: unknown[] = [businessId];

  if (query.subjectKey !== undefined) {
    params.push(query.subjectKey);
    where.push(`subject_key = $${params.length}`);
  }
  if (query.kind !== undefined) {
    params.push(query.kind);
    where.push(`kind = $${params.length}`);
  }
  if (query.keyword !== undefined && query.keyword.trim() !== '') {
    // Parameterised and matched against the rendered JSON, never interpolated.
    // `%` and `_` inside the keyword are escaped so a recalled word cannot
    // turn itself into a wildcard that matches the whole store.
    const escaped = query.keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.push(`%${escaped}%`);
    where.push(`(body::text ILIKE $${params.length} ESCAPE '\\' OR subject_key ILIKE $${params.length} ESCAPE '\\')`);
  }

  const limit = Math.min(Math.max(query.limit ?? 5, 1), MAX_RECALL);
  params.push(limit);

  const { rows } = await db.query<MemoryRow>(
    `SELECT memory_id, kind, subject_key, attribute, body, provenance,
            written_by_job, source_ref, created_at
       FROM memories
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, memory_id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toRecord);
}
