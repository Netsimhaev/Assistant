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
 *
 * **Migration 026 added three tables, and only one of them belongs here.**
 * `autonomy_marks.note` is owner-typed free text about one corrected step —
 * `src/governance/corrections.ts` files it against the job whose step was
 * wrong — and that text is not restricted to naming the counterparty the
 * step happened to be addressed to; a note about who was wrongly cc'd, or
 * who should have been contacted instead, can name someone the job's own
 * plan, title, instructions and authorizations never mention. It is content
 * about a person in exactly the sense `boss_instructions.text` already is,
 * and it is wired in below the same way `boss_instructions` is: BOTH as a
 * `job_id`-scoped deletion target below AND as a contact-anchor discovery
 * source of its own (the `autonomy_marks` query beside the `boss_instructions`
 * one), because a note is exactly the kind of free text that can be the only
 * place in a job that names the person being erased. `autonomy_mode` (one
 * row per business: the owner's dial position) and
 * `autonomy_events` (a promotion/demotion ledger whose `reason` column holds
 * only counts, e.g. "10 אישורים רצופים ללא שינוי") are facts about the
 * SYSTEM's own permissions, not about any counterparty — neither carries a
 * job id, a contact identifier, or any column a person's name could land in
 * during ordinary use. They are left unwired for the same reason
 * `autonomy_ramp` (migration 001) already is: there is nothing counterparty-
 * shaped in them to erase.
 *
 * **Migration 027 added two more, and both are deliberately out of scope.**
 * `credentials` holds a business's own connection secrets — the ciphertext
 * and nonce as `bytea`, plus a ref (`OFFICE_MAIL`), a key id and the platform
 * operator who wrote the row — and `credential_key_state` holds one row
 * saying which master key is live. Not a column in either can hold a
 * counterparty's name, address or phone: there is no free text, no job id and
 * no contact identifier anywhere in them, and the secret itself is sealed
 * bytes rather than content about anyone. They are the business's own
 * configuration, so an erasure of a contact or a window has nothing to take
 * from them, and erasing them under a `business` anchor is not a thing this
 * planner offers — no anchor is business-wide. Recorded here rather than
 * assumed, because the standing rule is that a new table holding content must
 * be wired to the executor, and silence about a table is indistinguishable
 * from having forgotten it. Their TEXT columns do fall inside
 * `erasure-invariants.test.ts`'s schema-derived sweep like every other
 * table's — but that sweep can only notice a value it seeded, and nothing
 * seeds one here, so it is a backstop for a future column that received a
 * copy of a probed value, not a proof that these two are empty of content
 * today. The reasoning above is what carries that, and it has to be rechecked
 * if either table ever gains a free-text column.
 *
 * **Migration 028 added two more, and both belong here.** `agent_envelopes`
 * carries `payload` — the content of one agent's request to another, and the
 * ONLY column of this row that can name a counterparty at all: `context_refs`
 * is a closed union of four id-only pointers (`domain/envelope.ts`'s
 * `ContextRef`), `intent` is a registry key, and the rest are hashes,
 * generated ids or enums. `verification_verdicts` carries `verdict`, which
 * quotes the draft it checked. Both are wired below by job id
 * (`AGENT_ENVELOPES_ERASED_PREDICATE`, `VERIFICATION_VERDICTS_ERASED_PREDICATE`),
 * the same way `job_plans` already is. `agent_envelopes` IS also given a
 * discovery query of its own, beside `boss_instructions`'s: `payload` is the
 * calling plan step's own input, so for a plan-issued delegation it is
 * already found through `job_plans.plan` — but a delegation opened by calling
 * `requestHelp` directly, with no plan step behind it (Task 10), has no plan
 * text to be found by, and the discovery query is what reaches that case.
 * See `AGENT_ENVELOPES_ERASED_PREDICATE`'s own docblock for the full trace.
 * `verification_verdicts` has no writer yet and is not given a discovery
 * query — see that predicate's own docblock for why this must be rechecked
 * once one exists.
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
 * Escapes what `LIKE` would otherwise read as a pattern.
 *
 * The anchor is owner-supplied text. A bare `%` would match every row in
 * every table searched — the same reason `recallMemories` escapes its
 * keyword.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The `ESCAPE` clause every `LIKE`/`ILIKE` in this module carries, written
 * once.
 *
 * `likeLiteral` above prefixes a backslash, and that prefix means nothing
 * unless the statement also DECLARES backslash as the escape character. The
 * two halves only work as a pair, so they live as a pair.
 *
 * **Why a constant and not fourteen typed clauses** (fix round 3, and the
 * class behind F1). Written inline, the clause is spelled with two
 * backslashes inside a template literal. One instead of two is not a syntax
 * error, not a type error and not visibly wrong: the literal quietly
 * collapses to `ESCAPE ''`, which disables escape processing altogether, and
 * the statement then fails *only* for an anchor containing `_`, `%` or a
 * backslash — an ordinary email local part. That is exactly how it reached
 * the last gate of this branch, in the one clause that had just been added.
 * A property held right fourteen times by hand is a property waiting to
 * break — the same argument that put the `proposals` predicate in one place.
 *
 * Spelled with `String.raw` deliberately: it is the one spelling the
 * collapsing rule cannot touch, so the fix cannot be undone by the mechanism
 * that caused the defect. It is the same ten characters as the two-backslash
 * template spelling — verified by running both, not assumed.
 */
export const LIKE_ESCAPE = String.raw`ESCAPE '\'`;

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
              AND (coalesce(proposed_input::text, '') ILIKE $3 ${LIKE_ESCAPE}
                OR coalesce(edited_input::text, '')  ILIKE $3 ${LIKE_ESCAPE}
                OR summary ILIKE $3 ${LIKE_ESCAPE}
                OR detail  ILIKE $3 ${LIKE_ESCAPE}))
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
 * The `agent_envelopes` rows an erasure destroys, as ONE predicate.
 *
 * `parent_job_id` only, and that is a traced conclusion, not an
 * oversimplification (fix round 1, item 1). Of the columns this row carries,
 * only `payload` can name a counterparty at all: `context_refs` is a closed
 * union of four id-only pointers (`domain/envelope.ts`'s `ContextRef` — "no
 * branch carries free text"), `intent` is a registry key, and every other
 * column is a hash, a generated id or an enum. `payload` is exactly the
 * object `requestHelp` (`orchestrator/delegate.ts`) parses off the calling
 * PLAN STEP's own input, which is to say it already lives, byte for byte, in
 * the delegating job's `job_plans.plan` — and `buildErasurePlan` already
 * searches that column with `plan::text ILIKE` below. So whenever this
 * envelope's payload names the contact, its `parent_job_id` is already in
 * `jobIds` through that discovery, for a plan-issued delegation.
 *
 * The one gap that is real: a caller that invokes `requestHelp` directly, not
 * through a plan step (Task 10), can put a contact-naming payload into an
 * envelope with no plan text anywhere to discover it by. `parent_job_id` is
 * still the right column to search FOR that gap — see the `agent_envelopes`
 * discovery query below, which searches `payload` itself and adds the
 * matching `parent_job_id` to `jobIds`. Once that discovery exists, a single
 * `parent_job_id` arm is sufficient: nothing about a contact is ever findable
 * through `child_job_id` that discovery has not already put in `jobIds` via
 * `parent_job_id`.
 *
 * A `child_job_id` arm was tried here first and reverted: since an envelope
 * reached only through its child means the payload does NOT name the
 * contact, that arm produced pure over-deletion — destroying a delegation
 * record for a reason unrelated to the contact, including one whose PARENT
 * job the owner explicitly kept (`keptJobs`, below): a kept job's `jobIds`
 * membership is removed, but the envelope would still be reached through the
 * child and destroyed out from under it, defeating the keep. In this
 * codebase over-deletion is exactly as serious as under-deletion — the
 * preview is a contract in both directions.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds.
 */
export const AGENT_ENVELOPES_ERASED_PREDICATE = `business_id = $1
  AND parent_job_id = ANY ($2)`;

/**
 * The `verification_verdicts` rows an erasure destroys.
 *
 * One row per job (migration 028: `PRIMARY KEY (business_id, job_id)`), so
 * `job_id = ANY ($2)` is the whole predicate — no second arm the way
 * `agent_envelopes` briefly had one, because this table carries no separate
 * parent/child distinction at all.
 *
 * **Wired ahead of its own writer, and that is a real gap, not a settled
 * one.** No code writes `verification_verdicts` yet (Task 11), so there is no
 * production shape to trace the way `agent_envelopes.payload` was traced back
 * to `job_plans.plan` above. A verdict quoting a runtime-resolved draft could
 * plausibly name a party absent from that job's `job_plans.plan`, with no
 * discovery query anywhere searching `verdict` for one. This predicate — and
 * the question of whether a discovery query belongs beside it — must be
 * rechecked once Task 11's writer exists and its actual payload shape is
 * known, not assumed clean because deletion-by-`job_id` was wired in early.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds.
 */
export const VERIFICATION_VERDICTS_ERASED_PREDICATE = `business_id = $1 AND job_id = ANY ($2)`;

/**
 * The `jobs` rows an erasure scrubs, and what gets emptied on them — as
 * shared constants for the same reason `APPROVAL_REQUESTS_SCRUB_SET` is one
 * (fix round 1, item 2). `awaiting_envelope_id` is migration 028's plain
 * `TEXT` column with no foreign key, pointing at the `agent_envelopes` row
 * that reports back to a PARKED parent (`jobs.phase = 'followup'`) once its
 * child finishes. `LIVE_PHASES` is `['execute', 'await_approval']`, so a
 * parked parent is not "live" by either the plan-time refusal or the
 * in-transaction re-check — nothing stops `agent_envelopes` from deleting
 * that very row out from under it. Left un-cleared, the job holds a pointer
 * to a row that no longer exists: the next scheduler pass calls
 * `loadEnvelopeWithChild`, gets `null`, and `failCorruptedParent` moves the
 * job to `failed` — an erasure of a contact silently killing a parked job
 * that has nothing to do with why it was parked. This is the same shape
 * `LIVE_PHASES`'s own docblock already names ("leaves a job pointing at a
 * plan that no longer exists"), one column over from `job_plans`.
 *
 * `title` and `awaiting_envelope_id` are cleared together, in one predicate
 * and one `SET`, because a job can need either half alone: a job with no
 * title left to scrub but a live envelope pointer, or vice versa, must still
 * be picked up and scrubbed.
 */
export const JOBS_SCRUBBED_PREDICATE = `business_id = $1 AND job_id = ANY ($2)
  AND (title IS NOT NULL OR awaiting_envelope_id IS NOT NULL)`;

export const JOBS_SCRUB_SET = `title = NULL, awaiting_envelope_id = NULL`;

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
        WHERE business_id = $1 AND plan::text ILIKE $2 ${LIKE_ESCAPE}`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM boss_instructions
        WHERE business_id = $1
          AND (text ILIKE $2 ${LIKE_ESCAPE} OR coalesce(answer, '') ILIKE $2 ${LIKE_ESCAPE})`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    // `autonomy_marks.note` is owner-typed free text and is not restricted to
    // naming only the counterparty the corrected step was addressed to — a
    // note about who was wrongly cc'd, or who should have been contacted
    // instead, can name someone the job's plan/title/instructions/
    // authorizations never mention at all. Without this query such a job is
    // never placed in `jobIds`, the `job_id = ANY($2)` deletion below never
    // reaches it, and the name survives an erasure permanently — the same
    // defect class already fixed twice in this module (`job_plans`, the
    // orphan `approval_requests` card). `boss_instructions` just above is the
    // template: a table reached BOTH as a discovery source (by its own
    // content) and as a closure target (by `job_id` membership), and
    // `autonomy_marks` needs the same pairing, not just the second half.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM autonomy_marks
        WHERE business_id = $1 AND note ILIKE $2 ${LIKE_ESCAPE}`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    // `agent_envelopes.payload` is a plan-issued delegation's own step input,
    // and is therefore normally already found through `job_plans.plan` above
    // — but `requestHelp` can also be invoked directly, with no plan step
    // behind it (Task 10), and that delegation's contact-naming payload would
    // otherwise have no text anywhere for this search to find it by. Keyed on
    // `parent_job_id`, the same column `AGENT_ENVELOPES_ERASED_PREDICATE`
    // deletes by, for the same reason `boss_instructions`/`autonomy_marks`
    // above are both a discovery source and a closure target: see that
    // predicate's own docblock for the full trace of why no `child_job_id`
    // side is needed here.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT parent_job_id AS job_id FROM agent_envelopes
        WHERE business_id = $1 AND payload::text ILIKE $2 ${LIKE_ESCAPE}`,
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
          AND (coalesce(proposed_input::text, '') ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(edited_input::text, '')  ILIKE $2 ${LIKE_ESCAPE}
            OR summary ILIKE $2 ${LIKE_ESCAPE}
            OR detail  ILIKE $2 ${LIKE_ESCAPE})`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM jobs WHERE business_id = $1 AND coalesce(title, '') ILIKE $2 ${LIKE_ESCAPE}`,
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
  //
  // **Discovered from the PRE-exclusion `jobIds`, and the kept jobs are
  // subtracted afterwards** (final review, N5). So "keep job J" preserves J's
  // plans, authorizations, instructions and title, while J's document and J's
  // memories are still destroyed. That is deliberate — a keep is a keep on
  // the item named, not a transitive shield over everything that item touched
  // — and the preview is honest about it: both are counted and listed before
  // the owner confirms. It is written down because a reader of the keep
  // button will not assume it, and spec §6 is a promise about not being
  // surprised. The same note applies to the memory query below.
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
  // `jobIds` here is still the pre-exclusion set; see the note at the
  // document discovery above for why keeping a job does not keep its
  // memories.
  const memoryRows =
    anchor.kind === 'contact'
      ? await db.query<{ memory_id: string }>(
          `SELECT memory_id FROM memories
            WHERE business_id = $1
              AND (subject_key = $2
                OR body::text ILIKE $3 ${LIKE_ESCAPE}
                OR coalesce(source_ref, '') ILIKE $3 ${LIKE_ESCAPE}
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
    // See this module's header for why `autonomy_marks` and not its two
    // migration-026 siblings. Deleted by `job_id` membership exactly like
    // `boss_instructions` above — and, like it, `jobIds` for a contact anchor
    // already includes every job whose OWN note names the contact, via the
    // discovery query beside `boss_instructions`'s above.
    await one(
      'autonomy_marks',
      'delete',
      `SELECT count(*)::text AS n FROM autonomy_marks
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
    // See `AGENT_ENVELOPES_ERASED_PREDICATE` above for why `parent_job_id`
    // alone is sufficient once the discovery query above it exists.
    await one(
      'agent_envelopes',
      'delete',
      `SELECT count(*)::text AS n FROM agent_envelopes WHERE ${AGENT_ENVELOPES_ERASED_PREDICATE}`,
      [businessId, jobIds],
    ),
    await one(
      'verification_verdicts',
      'delete',
      `SELECT count(*)::text AS n FROM verification_verdicts WHERE ${VERIFICATION_VERDICTS_ERASED_PREDICATE}`,
      [businessId, jobIds],
    ),
    await one(
      'jobs',
      'scrub',
      `SELECT count(*)::text AS n FROM jobs WHERE ${JOBS_SCRUBBED_PREDICATE}`,
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
