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
import { join } from 'node:path';
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
 * The `approval_requests` rows an erasure destroys, as ONE predicate.
 *
 * **Why the second arm exists (final review, N1).** `approval_requests.job_id`
 * is TEXT with no NOT NULL and no foreign key (001_spine.sql), and the
 * production path that produces a NULL is real: `GateContext.jobId` is
 * `string | null`, `evaluateToolCall` writes `jobId: ctx.jobId ?? null` into
 * `enqueueApproval`, and `gate-hook.ts` carries the same nullable id for the
 * SDK path that has no job row. Such a card holds the recipient address and
 * the whole message body in `summary`, `detail`, `proposed_input` and
 * `edited_input` — and it closes over to no job, so `job_id = ANY($2)` can
 * never reach it. The contact search above found it and the `job_id IS NOT
 * NULL` filter discarded it: the plan listed nothing and the row survived.
 *
 * **Restricted to `job_id IS NULL`, and that is a positive condition, not a
 * leftover.** A card that HAS a job is already reached through that job — the
 * contact search adds its `job_id` to `jobIds`, and if the owner chose to keep
 * that job the card is kept with it. Widening the content arm past the orphan
 * shape would destroy the cards of a job the owner explicitly kept, which is
 * the opposite failure. The orphan is the only row with no other way in.
 *
 * **Two anchor shapes close it; the third cannot.** A contact anchor matches
 * the four content columns, exactly as the contact search does. A window
 * anchor matches `approval_requests.created_at` inside the window, exactly as
 * the `jobs` search does — an orphan card raised in that window is content
 * from that window, and the window anchor already takes every job created in
 * it regardless of content. A DOCUMENT anchor has no closure available and is
 * deliberately given none: `approval_requests` carries no document reference
 * of any kind, and an orphan card is by definition not reachable through the
 * proposals/readings chain either, so there is no honest predicate to write.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds, `$3` the contact
 * LIKE pattern or NULL, `$4`/`$5` the window bounds or NULL. Built by
 * `approvalRequestParams` so the preview and the destruction cannot differ in
 * values any more than they can differ in text.
 */
const APPROVAL_REQUESTS_MATCHED = `business_id = $1
  AND (job_id = ANY ($2)
    OR (job_id IS NULL
        AND (($3::text IS NOT NULL
              AND (coalesce(proposed_input::text, '') ILIKE $3 ESCAPE '\'
                OR coalesce(edited_input::text, '')  ILIKE $3 ESCAPE '\'
                OR summary ILIKE $3 ESCAPE '\'
                OR detail  ILIKE $3 ESCAPE '\'))
          OR ($4::timestamptz IS NOT NULL
              AND created_at >= $4::timestamptz
              AND created_at <  $5::timestamptz))))`;

/**
 * The one conditional in spec §5.1.1's delete-versus-scrub table.
 *
 * `approval_requests` is deleted **unless a signature points at it, and then
 * it is scrubbed**. A signature says "this person, at this time, THROUGH THIS
 * APPROVAL, accepted the document" — deleting the approval out from under it
 * leaves the one row recording a human act pointing at nothing. It is the
 * same ethic migration 020 already encodes by making the signature survive
 * its document's deletion with `ON DELETE RESTRICT`: the record of what a
 * person did outlives the content it was about.
 *
 * Two predicates over the same matched set, so a matched row lands in exactly
 * one of them and neither can silently claim a row the other should have had.
 * Both are interpolated verbatim by `countItems` and by the executor.
 */
export const APPROVAL_REQUESTS_ERASED_PREDICATE = `${APPROVAL_REQUESTS_MATCHED}
  AND NOT EXISTS (SELECT 1 FROM signatures s
                   WHERE s.business_id = $1 AND s.approval_id = approval_requests.approval_id)`;

/** The matched rows a signature attests to: emptied, and kept. */
export const APPROVAL_REQUESTS_SCRUBBED_PREDICATE = `${APPROVAL_REQUESTS_MATCHED}
  AND EXISTS (SELECT 1 FROM signatures s
               WHERE s.business_id = $1 AND s.approval_id = approval_requests.approval_id)`;

/**
 * Every content column spec §5.1 names for this table, emptied in one place
 * so the executor's `SET` list cannot drift from what the preview counted.
 * `summary`, `detail`, `proposed_input`, `risk` and `artifacts` are NOT NULL,
 * so they take a neutral value rather than NULL.
 */
export const APPROVAL_REQUESTS_SCRUB_SET = `summary = 'נמחק בהוראת הבעלים',
        detail = 'נמחק בהוראת הבעלים',
        proposed_input = '{}'::jsonb,
        edited_input = NULL,
        decision_note = NULL,
        diff_vs_norm = NULL,
        artifacts = '[]'::jsonb,
        risk = '{}'::jsonb`;

/**
 * The five parameters `APPROVAL_REQUESTS_ERASED_PREDICATE` takes, derived
 * from the anchor the plan already carries.
 *
 * Exported so the executor derives them from `plan.anchor` with this same
 * function rather than rebuilding the pattern by hand — the `proposals` pair
 * agrees in text, parameters AND values, and this one has to agree the same
 * way or the fix reintroduces the defect it closes one layer up.
 */
export function approvalRequestParams(
  businessId: string,
  jobIds: readonly string[],
  anchor: ErasureAnchor,
): unknown[] {
  return [
    businessId,
    jobIds,
    anchor.kind === 'contact' ? `%${likeLiteral(anchor.identifier)}%` : null,
    anchor.kind === 'window' ? anchor.fromIso : null,
    anchor.kind === 'window' ? anchor.toIso : null,
  ];
}

/**
 * The `proposals` rows an erasure destroys, as ONE predicate.
 *
 * Scoped by `reading_id` through the erased documents as well as by `job_id`
 * (fix round 2, N1/Residual 2): `document_readings` cascades onto
 * `proposals`, so ANY proposal on a reading of a document being erased is
 * about to be destroyed regardless of which job made it — including a job
 * outside `jobIds` (a second job proposing against a reading two documents
 * legitimately share) and a proposal whose `job_id` is NULL (migration 018
 * made the column nullable by design, and `ON DELETE SET NULL` still produces
 * one). `job_id = ANY($2)` alone undercounts both identically.
 *
 * **Exported as one constant rather than written out twice** (final review,
 * N6). `countItems` below and the executor's delete both interpolate this
 * exact text with the exact same parameters, so "the preview equals the
 * destruction" holds here by construction and not by two copies being kept
 * equal by hand. Two tests bite if the predicate is neutered; there is no
 * longer a side that can be neutered on its own.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds, `$3` documentIds.
 */
export const PROPOSALS_ERASED_PREDICATE = `business_id = $1
  AND (job_id = ANY ($2)
    OR reading_id IN (
         SELECT reading_id FROM document_readings
          WHERE business_id = $1 AND document_id = ANY ($3)
       ))`;

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
  options: { businessId?: string; db?: Queryable; documentRoot?: string } = {},
): Promise<ErasurePlan> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const documentRoot = options.documentRoot ?? config.documentRoot;

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

    // `job_id IS NOT NULL` because this query derives JOB ids and a NULL is
    // not one. The orphan card it skips is not lost: it is matched directly,
    // by its own content, in `APPROVAL_REQUESTS_ERASED_PREDICATE` below.
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
    // Absolute, always. `documents.stored_path` is relative by design —
    // `ingest.ts` writes `<businessId>/<documentId>/original.<ext>` and joins
    // `config.documentRoot` separately — and the executor `unlink`s exactly
    // what this list holds while resolving nothing of its own (spec §8). A
    // relative path arriving there resolves against whatever the process's
    // working directory happens to be, misses, and is tolerated as "already
    // gone": every row destroyed, every byte kept, and the screen reporting
    // a clean run. The join belongs to whoever owns the plan, and
    // `verify.ts` is the house convention for this exact column.
    //
    // It also matters for what the owner reads: the done screen lists the
    // paths that failed so they can be cleaned by hand, and a relative path
    // is not something anyone can act on.
    for (const row of rows) filePaths.push(join(documentRoot, row.stored_path));

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

  const items = await countItems(db, businessId, anchor, jobList, documentList, memoryIds);

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
  anchor: ErasureAnchor,
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
      `SELECT count(*)::text AS n FROM proposals WHERE ${PROPOSALS_ERASED_PREDICATE}`,
      [businessId, jobIds, documentIds],
    ),
    await one(
      'approval_requests',
      'delete',
      `SELECT count(*)::text AS n FROM approval_requests WHERE ${APPROVAL_REQUESTS_ERASED_PREDICATE}`,
      approvalRequestParams(businessId, jobIds, anchor),
    ),
    await one(
      'approval_requests',
      'scrub',
      `SELECT count(*)::text AS n FROM approval_requests WHERE ${APPROVAL_REQUESTS_SCRUBBED_PREDICATE}`,
      approvalRequestParams(businessId, jobIds, anchor),
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
