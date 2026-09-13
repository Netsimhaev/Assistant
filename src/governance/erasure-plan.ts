/**
 * Turning "forget this" into exactly what will be deleted.
 *
 * Read-only, and that is the boundary that matters: `executeErasure` deletes
 * precisely what this returns and resolves nothing of its own. Anything this
 * function misses is not deleted, and anything it lists is shown to the owner
 * before a row is touched — which is what makes the preview the truth rather
 * than a decoration (spec §4.4).
 *
 * The anchor is searched in seven places (spec §4.3), and every match closes
 * over to the job or document that carries it, so dependent rows — readings,
 * proposals, extracted parts, step records — come along.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { keptIds, type KeptItemKind } from './kept-items.js';

export type ErasureAnchor =
  | { kind: 'contact'; identifier: string }
  | { kind: 'window'; fromIso: string; toIso: string }
  | { kind: 'document'; documentId: string };

export interface ErasureItem {
  table: string;
  action: 'delete' | 'scrub';
  count: number;
}

export interface ErasureRefusal {
  kind: 'live_job' | 'signed_document';
  detail: string;
}

export interface KeptExclusion {
  itemKind: KeptItemKind;
  itemId: string;
  keptAt: string;
  note: string | null;
}

export interface ErasurePlan {
  anchor: ErasureAnchor;
  jobIds: string[];
  documentIds: string[];
  memoryIds: string[];
  filePaths: string[];
  items: ErasureItem[];
  excluded: KeptExclusion[];
  refusals: ErasureRefusal[];
}

/**
 * A phase the owner is still involved in, or the engine is mid-way through.
 * Erasing under one of these leaves a job pointing at a plan that no longer
 * exists (spec §7.1).
 *
 * Exported so `executeErasure` can re-run the identical check, under a row
 * lock, at the top of its transaction — the plan-time refusal below narrows
 * the window a job can be woken into a live phase between the preview and
 * the owner's confirmation, but does not close it. Two definitions of "live"
 * drifting apart would be worse than one shared one (spec §7.1, I4).
 */
export const LIVE_PHASES: readonly string[] = ['execute', 'await_approval'];

/**
 * Escapes what `LIKE` would otherwise read as a pattern.
 *
 * The anchor is owner-supplied text. A bare `%` would match every row in
 * every table searched — the same reason `recallMemories` escapes its
 * keyword.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function idsFrom(
  db: Queryable,
  sql: string,
  params: unknown[],
  column: string,
): Promise<string[]> {
  const { rows } = await db.query<Record<string, string>>(sql, params);
  return rows.map((row) => row[column] as string);
}

export async function buildErasurePlan(
  anchor: ErasureAnchor,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ErasurePlan> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const jobIds = new Set<string>();
  const documentIds = new Set<string>();

  if (anchor.kind === 'contact') {
    const pattern = `%${likeLiteral(anchor.identifier)}%`;
    const exact = anchor.identifier;

    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM job_authorizations
        WHERE business_id = $1 AND $2 = ANY (recipients)`,
      [businessId, exact],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM job_plans
        WHERE business_id = $1 AND plan::text ILIKE $2 ESCAPE '\\'`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM boss_instructions
        WHERE business_id = $1
          AND (text ILIKE $2 ESCAPE '\\' OR coalesce(answer, '') ILIKE $2 ESCAPE '\\')`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM approval_requests
        WHERE business_id = $1 AND job_id IS NOT NULL
          AND (coalesce(proposed_input::text, '') ILIKE $2 ESCAPE '\\'
            OR coalesce(edited_input::text, '')  ILIKE $2 ESCAPE '\\'
            OR summary ILIKE $2 ESCAPE '\\'
            OR detail  ILIKE $2 ESCAPE '\\')`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM jobs WHERE business_id = $1 AND coalesce(title, '') ILIKE $2 ESCAPE '\\'`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);
  }

  if (anchor.kind === 'window') {
    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM jobs WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
      [businessId, anchor.fromIso, anchor.toIso],
      'job_id',
    )) jobIds.add(jobId);
  }

  if (anchor.kind === 'document') {
    documentIds.add(anchor.documentId);
  }

  // Documents reached through the jobs that read them.
  if (jobIds.size > 0) {
    for (const documentId of await idsFrom(
      db,
      `SELECT DISTINCT d.document_id FROM documents d
         JOIN document_readings r ON r.document_id = d.document_id AND r.business_id = $1
         JOIN proposals p ON p.reading_id = r.reading_id AND p.business_id = $1
        WHERE d.business_id = $1 AND p.job_id = ANY ($2)`,
      [businessId, [...jobIds]],
      'document_id',
    )) documentIds.add(documentId);
  }

  // The reverse direction, for a `document` anchor specifically: `documents
  // .document_id` cascades onto `document_readings`, which cascades onto
  // `proposals`, so deleting the document row is going to destroy every
  // proposal on every reading of it regardless of which job made that
  // proposal. Without this, `jobIds` stays empty (a document anchor names no
  // contact and no window), `countItems` reports zero proposals, and the
  // owner approves a preview that undercounts exactly what the cascade is
  // about to do — the defect C1 named. Scoped to `document` anchors only:
  // a `contact` anchor already found its jobs directly, and pulling in every
  // other job that happens to share a reading with a document it touched
  // would sweep in jobs the owner never named.
  if (anchor.kind === 'document' && documentIds.size > 0) {
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT p.job_id FROM proposals p
         JOIN document_readings r ON r.reading_id = p.reading_id AND r.business_id = $1
        WHERE r.business_id = $1 AND r.document_id = ANY ($2)
          AND p.business_id = $1 AND p.job_id IS NOT NULL`,
      [businessId, [...documentIds]],
      'job_id',
    )) jobIds.add(jobId);
  }

  // Memories: by subject, by body, by source — and by the jobs above.
  const memoryRows =
    anchor.kind === 'contact'
      ? await db.query<{ memory_id: string }>(
          `SELECT memory_id FROM memories
            WHERE business_id = $1
              AND (subject_key = $2
                OR body::text ILIKE $3 ESCAPE '\\'
                OR coalesce(source_ref, '') ILIKE $3 ESCAPE '\\'
                OR written_by_job = ANY ($4))`,
          [businessId, anchor.identifier, `%${likeLiteral(anchor.identifier)}%`, [...jobIds]],
        )
      : await db.query<{ memory_id: string }>(
          'SELECT memory_id FROM memories WHERE business_id = $1 AND written_by_job = ANY ($2)',
          [businessId, [...jobIds]],
        );

  // Kept items drop out of the plan and into the exclusions, never silently.
  const keptDocuments = await keptIds('document', { businessId, db });
  const keptMemories = await keptIds('memory', { businessId, db });
  const keptJobs = await keptIds('job', { businessId, db });

  const excluded: KeptExclusion[] = [];
  const { rows: keptRows } = await db.query<{
    item_kind: string;
    item_id: string;
    kept_at: Date;
    note: string | null;
  }>('SELECT item_kind, item_id, kept_at, note FROM kept_items WHERE business_id = $1', [
    businessId,
  ]);

  const keepInfo = new Map(keptRows.map((row) => [`${row.item_kind}:${row.item_id}`, row]));
  const noteFor = (kind: KeptItemKind, id: string): void => {
    const row = keepInfo.get(`${kind}:${id}`);
    if (row === undefined) return;
    excluded.push({
      itemKind: kind,
      itemId: id,
      keptAt: row.kept_at.toISOString(),
      note: row.note,
    });
  };

  const memoryIds: string[] = [];
  for (const row of memoryRows.rows) {
    if (keptMemories.has(row.memory_id)) noteFor('memory', row.memory_id);
    else memoryIds.push(row.memory_id);
  }

  const keptDocumentList = [...documentIds].filter((id) => keptDocuments.has(id));
  for (const id of keptDocumentList) noteFor('document', id);
  const documentList = [...documentIds].filter((id) => !keptDocuments.has(id));

  const keptJobList = [...jobIds].filter((id) => keptJobs.has(id));
  for (const id of keptJobList) noteFor('job', id);
  const jobList = [...jobIds].filter((id) => !keptJobs.has(id));

  // Refusals.
  const refusals: ErasureRefusal[] = [];

  if (jobList.length > 0) {
    const { rows } = await db.query<{ job_id: string; phase: string }>(
      'SELECT job_id, phase FROM jobs WHERE business_id = $1 AND job_id = ANY ($2) AND phase = ANY ($3)',
      [businessId, jobList, LIVE_PHASES],
    );
    for (const row of rows) {
      refusals.push({
        kind: 'live_job',
        detail: `משימה ${row.job_id} נמצאת ב-${row.phase} ותלויה בפריטים האלה. בטל אותה קודם, או הוצא אותם מהמחיקה.`,
      });
    }
  }

  const filePaths: string[] = [];
  if (documentList.length > 0) {
    const { rows } = await db.query<{ document_id: string; stored_path: string }>(
      'SELECT document_id, stored_path FROM documents WHERE business_id = $1 AND document_id = ANY ($2)',
      [businessId, documentList],
    );
    for (const row of rows) filePaths.push(row.stored_path);

    const signed = await db.query<{ document_id: string; signed_by: string }>(
      'SELECT document_id, signed_by FROM signatures WHERE business_id = $1 AND document_id = ANY ($2)',
      [businessId, documentList],
    );
    for (const row of signed.rows) {
      refusals.push({
        kind: 'signed_document',
        detail: `חתמת על המסמך ${row.document_id}. מחיקתו תמחק את הראיה שחתמת.`,
      });
    }
  }

  const items = await countItems(db, businessId, jobList, documentList, memoryIds);

  return {
    anchor,
    jobIds: jobList,
    documentIds: documentList,
    memoryIds,
    filePaths,
    items,
    excluded,
    refusals,
  };
}

/**
 * The preview's numbers, and the executor's work list.
 *
 * `delete` versus `scrub` follows the rule in spec §5.1.1: a row whose whole
 * existence is the content goes; a row that merely carries a content field
 * stays and is emptied, so audit rows keep pointing at jobs that exist.
 */
async function countItems(
  db: Queryable,
  businessId: string,
  jobIds: string[],
  documentIds: string[],
  memoryIds: string[],
): Promise<ErasureItem[]> {
  const one = async (
    table: string,
    action: 'delete' | 'scrub',
    sql: string,
    params: unknown[],
  ): Promise<ErasureItem> => {
    const { rows } = await db.query<{ n: string }>(sql, params);
    return { table, action, count: Number(rows[0]?.n ?? '0') };
  };

  return [
    await one(
      'memories',
      'delete',
      `SELECT count(*)::text AS n FROM memories
        WHERE business_id = $1 AND memory_id = ANY ($2)`,
      [businessId, memoryIds],
    ),
    await one(
      'documents',
      'delete',
      `SELECT count(*)::text AS n FROM documents
        WHERE business_id = $1 AND document_id = ANY ($2)`,
      [businessId, documentIds],
    ),
    await one(
      'document_artifacts',
      'delete',
      `SELECT count(*)::text AS n FROM document_artifacts
        WHERE business_id = $1 AND document_id = ANY ($2)`,
      [businessId, documentIds],
    ),
    await one(
      'document_readings',
      'delete',
      `SELECT count(*)::text AS n FROM document_readings
        WHERE business_id = $1 AND document_id = ANY ($2)`,
      [businessId, documentIds],
    ),
    await one(
      'proposals',
      'delete',
      // Scoped by `reading_id` through the erased documents as well as by
      // `job_id` (fix round 2, N1/Residual 2): `document_readings` cascades
      // onto `proposals`, so ANY proposal on a reading of a document being
      // erased is about to be destroyed regardless of which job made it —
      // including a job outside `jobIds` (a second job proposing against a
      // reading two documents legitimately share) and a proposal whose
      // `job_id` is NULL (migration 018 made the column nullable by design,
      // and `ON DELETE SET NULL` still produces one). `job_id = ANY($2)`
      // alone undercounts both identically; this is the same query the
      // executor runs to delete, so the preview and the deletion agree by
      // construction.
      `SELECT count(*)::text AS n FROM proposals
        WHERE business_id = $1
          AND (job_id = ANY ($2)
            OR reading_id IN (
                 SELECT reading_id FROM document_readings
                  WHERE business_id = $1 AND document_id = ANY ($3)
               ))`,
      [businessId, jobIds, documentIds],
    ),
    await one(
      'approval_requests',
      'delete',
      `SELECT count(*)::text AS n FROM approval_requests
        WHERE business_id = $1 AND job_id = ANY ($2)`,
      [businessId, jobIds],
    ),
    await one(
      'boss_instructions',
      'delete',
      `SELECT count(*)::text AS n FROM boss_instructions
        WHERE business_id = $1 AND job_id = ANY ($2)`,
      [businessId, jobIds],
    ),
    await one(
      'job_plans',
      'delete',
      `SELECT count(*)::text AS n FROM job_plans
        WHERE business_id = $1 AND job_id = ANY ($2)`,
      [businessId, jobIds],
    ),
    await one(
      'job_authorizations',
      'delete',
      `SELECT count(*)::text AS n FROM job_authorizations
        WHERE business_id = $1 AND job_id = ANY ($2)`,
      [businessId, jobIds],
    ),
    await one(
      'jobs',
      'scrub',
      `SELECT count(*)::text AS n FROM jobs
        WHERE business_id = $1 AND job_id = ANY ($2) AND title IS NOT NULL`,
      [businessId, jobIds],
    ),
    await one(
      'job_steps',
      'scrub',
      `SELECT count(*)::text AS n FROM job_steps
        WHERE job_id = ANY ($1)`,
      [jobIds],
    ),
    await one(
      'job_step_results',
      'scrub',
      `SELECT count(*)::text AS n FROM job_step_results
        WHERE business_id = $1 AND job_id = ANY ($2) AND external_id IS NOT NULL`,
      [businessId, jobIds],
    ),
  ];
}
