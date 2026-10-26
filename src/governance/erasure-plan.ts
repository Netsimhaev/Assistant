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
 * `verification_verdicts` got a writer in Task 10 (`gov-verify.ts`'s
 * `verifyDraft`) and a production-reachable WRITING BRANCH once the
 * verification loop closed: `assert.evaluate`'s handler
 * (`orchestrator/local-tools.ts`) resolves `know.reader`'s answer and calls
 * `verifyDraft` with it, so `saveVerdict` really does run. It therefore gets
 * a discovery query of its own beside `boss_instructions`'s — see
 * `VERIFICATION_VERDICTS_ERASED_PREDICATE`'s own docblock for why the answer
 * came out "yes, needed" rather than "no, already covered".
 *
 * **The same branch bound a plan to `gov.verify`'s job, and that opened a
 * DOCUMENT-anchor discovery gap this module had to close.** `conduct.ts`'s
 * `beginVerification` now binds a one-step plan whose input carries
 * `documentId`, the draft text and the question verbatim. A contact anchor
 * already reaches that job through the `job_plans.plan ILIKE` query below. A
 * document anchor did not: its only job discovery was a single query over
 * `proposals`, and the `gov.verify` job has no `proposals` row — so a
 * document-anchored erasure left the draft derived from that very document
 * sitting in `job_plans.plan`. The `job_plans` query added to the document
 * branch below is the closure, written the same positive way the contact
 * anchor's is.
 *
 * **Migration 036 added `whatsapp_messages`, and it is wired in below.**
 * `.sender_number`, `.body` and `.transcript` are content about a person in
 * exactly the sense `boss_instructions.text` already is. It is NOT scoped by
 * `job_id` alone the way `boss_instructions` is, because `whatsapp_messages
 * .job_id` is nullable where `boss_instructions.job_id` is `NOT NULL UNIQUE`:
 * an unclaimed inbound message (still `received`) or a message from a number
 * the business never opened a job for carries no job at all, and
 * `job_id = ANY($2)` alone would leave such a row as unreachable as the
 * orphan `approval_requests` card already was (N1, above). So the predicate
 * has the same three arms that card's does: `job_id = ANY($2)` for a message
 * tied to a job the anchor already found, a contact arm matching
 * `sender_number`/`body`/`transcript` directly for a message with none, and a
 * window arm matching `created_at` for the same reason — a window anchor
 * erases everything CREATED in it, claimed or not. The latter two arms are
 * gated on `job_id IS NULL` (fix round 1, Critical 1) — exactly like
 * `APPROVAL_REQUESTS_MATCHED`'s own second arm — because a message that DOES
 * have a job must be reached only through that job, or a kept job's own
 * message would be deleted directly and a live job outside `jobList` could
 * lose its message with no refusal. **And because of that gate, a job-tied
 * message needs the other half `approval_requests` already has: a discovery
 * query of its own** (fix round 3, the HIGH security-review finding).
 * `boss_instructions`, `autonomy_marks`, `agent_envelopes` and
 * `verification_verdicts` are all both a discovery source (by their own
 * content) and a closure target (by `job_id` membership); `whatsapp_messages`
 * had only the second half, so a contact named only in a job-tied message's
 * own content — a non-opening message on an existing job, or an
 * assistant-authored `recordOutbound` body stored nowhere else — was reached
 * by neither arm and survived a contact erasure permanently. See the
 * `whatsapp_messages` discovery query beside `approval_requests`'s, below.
 * See `WHATSAPP_MESSAGES_ERASED_PREDICATE`'s own docblock for the predicate.
 *
 * **Migration 040 added `digests`, and it belongs here for the reason the
 * feature's own spec names: a digest NAMES failures** — a rejected
 * document's `original_name`, a stalled job's `title`, an expired approval's
 * `summary` (`digest-facts.ts`'s `collectDigestFacts`) — so a document name,
 * a recipient or a contact's name can land in `digests.body` even though
 * nothing else about the digest mentions any of them. Once stored it
 * survives, and "forget about Ronit" has to reach it.
 *
 * **Discovered by its own content alone — there is no job-membership half to
 * this one.** Every other table above that is not itself a discovery source
 * is reached because some OTHER query already put its owning job into
 * `jobIds`. `digests` has no `job_id` column at all (migration 040:
 * `digest_id`, `business_id`, `kind`, `window_start`, `window_end`, `body`,
 * `had_content`, `created_at`, `email_state`, `whatsapp_state` — nothing
 * else) — it is a periodic rollup across many jobs, not a record that
 * belongs to one. So a contact-anchored erasure can only ever find one by
 * searching `body` itself, exactly the way the contact search already
 * searches `jobs.title`; see the `digests` discovery query below.
 *
 * **The window anchor: `created_at`, not `window_start`/`window_end` — the
 * case against this, written down rather than decided silently.** A digest
 * carries two candidate time columns: `created_at` (when this ROW was
 * written) and `window_start`/`window_end` (the period its body
 * SUMMARISES). Every window-anchored predicate elsewhere in this module —
 * `jobs`, the orphan arm of `approval_requests`, the orphan/content arm of
 * `whatsapp_messages` — matches the row's own `created_at`, never the time
 * of the real-world event the row describes, so `created_at` is the
 * convention already kept everywhere else in this module.
 *
 * `created_at` is only an honest stand-in for "content about this period"
 * because it actually tracks `window_end` closely in this deployment:
 * `dueWindow` (`orchestrator/digest-window.ts`) fixes `end` to the
 * SCHEDULED moment the window closes, and `digest-run.ts` stores the row in
 * the very same scheduler pass that computes it ("stored before delivery")
 * — so `created_at` lands within seconds of `window_end`, never days after
 * it. If a digest could be generated long after the period it describes,
 * an owner erasing "last week" by `created_at` could miss a digest whose
 * `window_start`/`window_end` fall entirely inside that week but whose
 * `created_at` landed later — exactly the "content survives because
 * nothing discovers it" shape this module exists to prevent, and worth
 * re-checking if the generation delay ever stops being near-zero.
 *
 * Matching on `window_start`/`window_end` instead was considered and
 * rejected — not because the concern above is wrong, but because it trades
 * one honesty problem for a worse one. A weekly digest's window spans seven
 * days, so ANY anchor overlapping even one of them would delete the whole
 * week's summary — six days of content the owner never asked to erase — and
 * this module has no existing convention for what "overlap" should even
 * mean here (any intersection? full containment?), because no other row in
 * it carries a RANGE rather than a single instant. Over-deletion is treated
 * as seriously as under-deletion everywhere else in this module (see
 * `AGENT_ENVELOPES_ERASED_PREDICATE`'s own docblock: "a `child_job_id` arm
 * was tried here first and reverted" for exactly that reason) — inventing an
 * untested overlap rule for the one table that would need it, instead of
 * reusing the convention every other table here already proves out, is the
 * wrong place to take that risk. `created_at` is the choice that stays
 * consistent with the rest of the module and is honest about the one
 * deployment this project actually ships.
 *
 * No document-anchor discovery is offered for `digests`, and that is the
 * same honesty `approval_requests` already states for its own orphan card:
 * the table carries no document reference of any kind — not even an
 * indirect one through a job — so a predicate pretending a document anchor
 * could reach a digest would be exactly the lie that anchor's own docblock
 * already refuses to write.
 *
 * **Migrations 042/044 added the mailbox: `mail_messages` and `mail_invoices`
 * are wired in below; `mailbox_cursor` is not.** A mail row is the most
 * counterparty-shaped content this module handles — sender, name, reply-to,
 * recipients, subject, the full body, the model's summary, attachment file
 * names — and like `digests` it is discovered by its own columns, not through
 * a job: the contact anchor searches them directly, the window anchor matches
 * `received_at` (when the mail ARRIVED — the real-world event the row records,
 * and the only time column the owner can see on the mail screen; `created_at`
 * trails it by one poll interval at most), and the document anchor reaches
 * only `mail_invoices`, by its `document_id` (see `MAIL_INVOICES_ERASED_
 * PREDICATE` for why the mail itself is not the document). Ids land in
 * `mailIds`, and every mail found then closes over to what it produced: its
 * triage job (`job_id`), its reply job (`reply_job_id`), every EARLIER reply
 * job a re-raise unlinked from it (found by its bound plan naming the mail's
 * `providerMessageId` — `claimFailedReply` nulls `reply_job_id`, so the
 * column alone forgets a predecessor whose plan and card still hold the
 * recipient and the drafted body), and the documents its attachments were
 * ingested as (`attachments[].documentId`, `mail_invoices.document_id`). The
 * existing job-scoped machinery then erases those jobs' plans, cards, step
 * records, WhatsApp copies and memories exactly as it does for any other job.
 *
 * `mailbox_cursor` holds one row per business: the provider, an opaque
 * provider cursor, timestamps and `last_error` — a closed set of codes
 * (`list_<failure>`, `cursor_expired_gap`, `record_failed:<hash>:<n>`, the
 * hash being of a provider id, never an address). Nothing in it can name a
 * counterparty, so it is left out for the same reason `autonomy_mode` is.
 */
import { join } from 'node:path';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { keptIds, type KeptItemKind } from './kept-items.js';
import { LIKE_ESCAPE, likeLiteral } from '../util/like.js';

export { LIKE_ESCAPE };

export type ErasureAnchor =
  | { kind: 'contact'; identifier: string }
  | { kind: 'window'; fromIso: string; toIso: string }
  | { kind: 'document'; documentId: string };

export interface ErasureItem {
  table: string;
  /**
   * `'fail'` is one row: a job PARKED on a delegation (`phase = 'followup'`,
   * `awaiting_envelope_id` set) whose own `agent_envelopes` row this erasure
   * is about to delete. Clearing the pointer alone (as `scrub` on `jobs`
   * already does, unconditionally) leaves that job in `followup` forever —
   * `resumeDelegatedJobs`'s own docblock calls it that job's ONLY possible
   * mover, `wakeDueJobs` never picks it up (`wake_at` is NULL for a
   * delegation park), and its `job_plans` row is gone in the same
   * transaction regardless. A phase with no reader is the leak this project
   * already names in prose (`LIVE_PHASES`'s docblock, "a job pointing at a
   * plan that no longer exists") — moved to `failed` instead, deliberately,
   * as part of the erasure. See `STRANDED_PARENT_PREDICATE`'s docblock.
   */
  action: 'delete' | 'scrub' | 'fail';
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
  digestIds: string[];
  /** `mail_messages` rows found by the anchor itself — see this module's header. */
  mailIds: string[];
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
 * The `whatsapp_messages` rows an erasure destroys, as ONE predicate.
 *
 * Three arms, for the reason this module's header spells out: unlike
 * `boss_instructions` (`job_id NOT NULL UNIQUE` — every instruction belongs
 * to exactly one job), a WhatsApp message can exist with no job at all. The
 * job arm reaches everything the anchor already tied to a job, the same way
 * `boss_instructions` is reached; the other two arms reach a jobless message
 * directly, the same way `APPROVAL_REQUESTS_MATCHED`'s second arm reaches an
 * orphan approval card.
 *
 * **The content and window arms are gated on `job_id IS NULL`, and that is a
 * positive condition, not a leftover** — the same shape
 * `APPROVAL_REQUESTS_MATCHED` already uses for its own second arm (fix
 * round 1, Critical 1). A message that HAS a job is already reached through
 * that job: `jobIds` (and, downstream of it, `jobList`) is where a kept job
 * is removed before deletion runs, so a message reached only via `job_id =
 * ANY($2)` is correctly skipped when its job was kept. Without the gate, a
 * message belonging to a KEPT job would still be deleted directly by its own
 * `sender_number`/`body`/`transcript` or its own `created_at` — the preview
 * would report "job J kept" while destroying J's own opening message, which
 * is exactly the over-deletion the `agent_envelopes` `child_job_id` arm was
 * tried and reverted for (see that predicate's own docblock above: "in this
 * codebase over-deletion is exactly as serious as under-deletion"). It would
 * also widen the live-job window: the plan-time refusal and the executor's
 * `FOR UPDATE` re-check both only cover `jobList`, so a message naming the
 * contact only in its own WhatsApp text — with the job's `job_plans`,
 * `boss_instructions` and `jobs.title` all silent on it — belongs to a job
 * that is neither refused nor locked, and an ungated arm would delete that
 * job's message out from under it even while the job sits in `execute` right
 * now. `job_id IS NULL` closes both: there is no job to undermine and
 * nothing live to race.
 *
 * Content columns only: `sender_number`, `body` and `transcript` — never
 * `provider_message_id` (the provider's own id, not a person) and never
 * `direction`/`state`/`job_id` (structure, not content).
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds, `$3` the contact
 * LIKE pattern or NULL, `$4`/`$5` the window bounds or NULL — the same
 * convention `approvalRequestParams` already established, reused via
 * `whatsappMessageParams` below so the preview and the destruction cannot
 * differ in values any more than in text.
 */
export const WHATSAPP_MESSAGES_ERASED_PREDICATE = `business_id = $1
  AND (job_id = ANY ($2)
    OR (job_id IS NULL
        AND (($3::text IS NOT NULL
              AND (coalesce(sender_number, '') ILIKE $3 ${LIKE_ESCAPE}
                OR coalesce(body, '')          ILIKE $3 ${LIKE_ESCAPE}
                OR coalesce(transcript, '')    ILIKE $3 ${LIKE_ESCAPE}))
          OR ($4::timestamptz IS NOT NULL
              AND created_at >= $4::timestamptz
              AND created_at <  $5::timestamptz))))`;

/**
 * The five parameters `WHATSAPP_MESSAGES_ERASED_PREDICATE` takes, derived
 * from the anchor the plan already carries — the same shape as
 * `approvalRequestParams`, kept as its own function rather than reused
 * because the two tables' predicates are independent text that must not
 * drift together by sharing one parameter builder that happens to look
 * identical today.
 */
export function whatsappMessageParams(
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
 * **One keep interaction remains, and it is not a gap the way the dropped arm
 * was.** If the owner keeps the CHILD job while the PARENT stays in `jobIds`,
 * this predicate still deletes the envelope: `parent_job_id` names the
 * parent, not the child, and the parent was never kept. That is correct — the
 * envelope is the PARENT's own content (its own delegation request), not the
 * child's, and destroying it is not the `keptJobs`-defeating shape above,
 * where keeping the very job named on the predicate failed to shield its own
 * envelope. It is still a second, distinct way "keep" and `agent_envelopes`
 * interact, worth a reader knowing about before finding it in production
 * rather than here.
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
 * **The writer runs in production, and so does the branch that writes.**
 * `conduct.ts`'s `beginVerification` opens `gov.verify`'s job with
 * `answer: null`, so its own call parks rather than judges — but the job now
 * carries a bound one-step plan, and when `know.reader` answers,
 * `assert.evaluate`'s handler (`orchestrator/local-tools.ts`) resolves that
 * answer and calls `verifyDraft` again with it. That is the call that reaches
 * `saveVerdict`. Rows in this table are real.
 *
 * **Discovery is needed from BOTH anchor sides, and for two different
 * reasons.** `Verdict.criteria[].detail` is free text the JUDGE MODEL writes,
 * instructed to quote from the draft or the answer when it helps — exactly
 * the kind of content `agent_envelopes.payload` also is, and it can name a
 * counterparty the rest of this job never mentions, so the CONTACT anchor
 * gets a `verdict::text ILIKE` query of its own below. The DOCUMENT anchor is
 * served one layer over: the same bound plan puts `documentId`, the draft and
 * the question into `job_plans.plan`, so the document branch's own
 * `job_plans` query is what places this job in `jobIds` — and once it is
 * there, `job_id = ANY ($2)` deletes the verdict with it. Neither query
 * changes this predicate; both change what `jobIds` contains when it runs.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds.
 */
export const VERIFICATION_VERDICTS_ERASED_PREDICATE = `business_id = $1 AND job_id = ANY ($2)`;

/**
 * The `action_updates` rows an erasure destroys (migration 047).
 *
 * One row per performed step, telling the owner what the assistant did on
 * her own — `recipient`, `subject` and `body` name the person the step was
 * addressed to. Job-anchored exactly like `autonomy_marks`: deleted by
 * `job_id` membership, with no discovery query of its own, because every
 * value in a row is derived from the step's own payload, which already sits
 * in `job_plans.plan` and places the job in `jobIds` through that table's
 * discovery. The row cannot name anyone the job's plan does not.
 *
 * Parameters, in both places: `$1` businessId, `$2` jobIds.
 */
export const ACTION_UPDATES_ERASED_PREDICATE = `business_id = $1 AND job_id = ANY ($2)`;

/**
 * The `digests` rows an erasure destroys, as ONE predicate.
 *
 * `digest_id = ANY ($2)` alone, the same id-list shape as
 * `VERIFICATION_VERDICTS_ERASED_PREDICATE` — no second arm, because a
 * digest carries no job id and no document id to branch on at all.
 * Everything `digestIds` can ever hold comes from the discovery queries in
 * `buildErasurePlan` below (contact: `body ILIKE`; window: `created_at` —
 * see this module's header for why `created_at` and not
 * `window_start`/`window_end`).
 *
 * Parameters, in both places: `$1` businessId, `$2` digestIds.
 */
export const DIGESTS_ERASED_PREDICATE = `business_id = $1 AND digest_id = ANY ($2)`;

/**
 * The `mail_messages` rows an erasure destroys: exactly the `mailIds` the
 * plan's discovery found, the same id-list shape as `DIGESTS_ERASED_PREDICATE`.
 * A mail has no job-membership arm — it is never reached BY a job (a job in
 * `jobIds` for some other reason does not drag in the mail it answered:
 * that would erase one sender's mail because a second contact's name
 * appeared in a reply draft). It is reached by its own content, its own
 * arrival time, and nothing else.
 *
 * **A kept job does not keep its mail.** Mails are not a keepable kind, so a
 * mail found by the anchor goes even when its triage or reply job is kept. A
 * kept reply job that is still live keeps its approval card (job-scoped, and
 * the job was kept), but loses what is keyed on the mail row: the dashboard's
 * reply layout (`isMailReplyJob`) and its WhatsApp presentation
 * (`openMailCards` joins on `mail_messages.reply_job_id`).
 *
 * Parameters, in both places: `$1` businessId, `$2` mailIds.
 */
export const MAIL_MESSAGES_ERASED_PREDICATE = `business_id = $1 AND mail_id = ANY ($2)`;

/**
 * The `mail_invoices` rows an erasure destroys: every invoice of an erased
 * mail, AND every invoice whose `document_id` is an erased document.
 *
 * **Deleted explicitly, before `mail_messages`, though the FK cascades.**
 * `mail_invoices.mail_id` is `ON DELETE CASCADE`, so deleting the mail first
 * would remove its invoices silently and this statement would report zero for
 * a table that really lost rows — the same "cascade beats the explicit
 * delete" defect `erasure.ts`'s header names for `proposals`.
 *
 * **The document arm is the document anchor's whole reach into the mailbox.**
 * An invoice row is a record ABOUT one document (its number, amount and file
 * name), so it goes with the document. The mail that delivered it does not: a
 * mail is a person's message, it may carry other attachments, and erasing one
 * file is not "forget this sender". A document-anchor erasure therefore
 * leaves the delivering mail standing, with its `attachments[].filename`
 * (chosen by the sender — the mail is the sender's message, and it is erased
 * by a contact or window anchor, not by a document one) and the now-dangling
 * `attachments[].documentId` (a system id, not content).
 *
 * The same arm also fires under a contact or window anchor, for every
 * document the plan erases — including the rare case of a second sender's
 * invoice whose PDF deduplicated (`documents` is unique on `sha256`) onto a
 * document this erasure takes. That is the precedent `PROPOSALS_ERASED_
 * PREDICATE` already set ("any proposal on a reading of a document being
 * erased is about to be destroyed regardless of which job made it"): an
 * invoice record whose document is gone describes nothing that exists.
 *
 * Parameters, in both places: `$1` businessId, `$2` mailIds, `$3` documentIds.
 */
export const MAIL_INVOICES_ERASED_PREDICATE = `business_id = $1
  AND (mail_id = ANY ($2) OR document_id = ANY ($3))`;

/**
 * A mail's content columns, matched against a contact pattern (`$2`). Every
 * column a person's identity or words can land in: sender, display name,
 * reply-to, recipients, subject, body, the model's summary, and the
 * attachment list (file names are chosen by the sender). Never the provider
 * ids, flags, categories or labels — structure and closed sets, not content.
 *
 * `attachments::text` also carries each attachment's `summary` (and
 * `docType`) that the triage reader wrote from a PDF's text (spec §9.3), so a
 * contact named only inside an attachment summary is matched too.
 *
 * **Known gap.** A contact anchor does not search `document_artifacts` — the
 * extracted text of the attached files themselves. A person named only
 * inside a PDF (and in neither the mail nor the reader's summary of it) is
 * not found by this pattern; that document is erased only when the mail that
 * delivered it is matched (its documents go with it) or by a document
 * anchor. Searching artefact text by contact would reach every document
 * that merely mentions the name, which is a different, broader erasure.
 */
const MAIL_CONTENT_MATCHES = `(from_address ILIKE $2 ${LIKE_ESCAPE}
      OR coalesce(from_name, '')  ILIKE $2 ${LIKE_ESCAPE}
      OR coalesce(reply_to, '')   ILIKE $2 ${LIKE_ESCAPE}
      OR array_to_string(to_addresses, chr(10)) ILIKE $2 ${LIKE_ESCAPE}
      OR subject ILIKE $2 ${LIKE_ESCAPE}
      OR coalesce(body_text, '')  ILIKE $2 ${LIKE_ESCAPE}
      OR coalesce(summary, '')    ILIKE $2 ${LIKE_ESCAPE}
      OR attachments::text        ILIKE $2 ${LIKE_ESCAPE})`;

/**
 * The `jobs` rows an erasure scrubs, and what gets emptied on them — as
 * shared constants for the same reason `APPROVAL_REQUESTS_SCRUB_SET` is one
 * (fix round 1, item 2). `awaiting_envelope_id` is migration 028's plain
 * `TEXT` column with no foreign key, pointing at the `agent_envelopes` row
 * that reports back to a PARKED parent (`jobs.phase = 'followup'`) once its
 * child finishes. `LIVE_PHASES` is `['execute', 'await_approval']`, so a
 * parked parent is not "live" by either the plan-time refusal or the
 * in-transaction re-check — nothing stops `agent_envelopes` from deleting
 * that very row out from under it. This is the same shape `LIVE_PHASES`'s own
 * docblock already names ("leaves a job pointing at a plan that no longer
 * exists"), one column over from `job_plans`.
 *
 * `title` and `awaiting_envelope_id` are cleared together, in one predicate
 * and one `SET`, because a job can need either half alone: a job with no
 * title left to scrub but a live envelope pointer, or vice versa, must still
 * be picked up and scrubbed.
 *
 * **Clearing the pointer alone is NOT the fix for a parked parent — it is
 * only content hygiene, and it used to be mistaken for the fix (fix round 1,
 * item 2; corrected in fix round 2, item 1).** A cleared `NULL` pointer on a
 * job still sitting in `phase = 'followup'` gives that job no way out:
 * `resumeDelegatedJobs`'s own docblock calls itself that job's ONLY possible
 * mover, and its query requires `awaiting_envelope_id IS NOT NULL` — a job
 * this `SET` just nulled no longer matches it. `wakeDueJobs` cannot pick it
 * up either (`wake_at` is NULL for a delegation park, not a retry). The job
 * is left in a phase with no reader — "parked" became "stranded" instead of
 * "killed", and a phase with no reader is not a resting place. What actually
 * resolves this is `STRANDED_PARENT_PREDICATE` below, which moves such a job
 * to `failed` as part of the same erasure. This `SET` still runs
 * unconditionally on every job in `jobIds`, stranded or not, because the
 * `title` half has nothing to do with parking at all.
 */
export const JOBS_SCRUBBED_PREDICATE = `business_id = $1 AND job_id = ANY ($2)
  AND (title IS NOT NULL OR awaiting_envelope_id IS NOT NULL)`;

export const JOBS_SCRUB_SET = `title = NULL, awaiting_envelope_id = NULL`;

/**
 * A job parked on a delegation whose OWN `agent_envelopes` row this erasure
 * is about to delete — the count the preview shows for `ErasureItem`'s
 * `'fail'` action (see that type's own docblock for the full failure chain).
 *
 * **One predicate, shared by text, not just by agreement (fix round 3, item
 * 2).** A first version of this had the executor re-express the same
 * condition as a JS filter over the locked rows — correct today, but exactly
 * the drift every OTHER disposition in this module avoids by sharing one
 * exported SQL constant (`PROPOSALS_ERASED_PREDICATE`,
 * `APPROVAL_REQUESTS_ERASED_PREDICATE`, `AGENT_ENVELOPES_ERASED_PREDICATE`,
 * `JOBS_SCRUBBED_PREDICATE` all do this; spec §5.1.1's whole point is that
 * the preview and the destruction cannot differ in text any more than in
 * values). The argument for not RE-QUERYING `jobs` after other statements
 * run is real (a table `agent_envelopes` is about to delete would be read a
 * second time with different results) — but that argues against a second
 * `SELECT`, not against reusing this constant's TEXT. The executor now
 * interpolates it as a computed column on the SAME locked `SELECT` the
 * liveness check already runs (`(${STRANDED_PARENT_PREDICATE}) AS
 * stranded`), so the condition is evaluated exactly once, before any delete,
 * and the preview and the executor read the identical SQL.
 *
 * Read-only here for the PREVIEW specifically: `buildErasurePlan` has no lock
 * and no transaction, so its own use of this constant is an estimate exactly
 * like the `LIVE_PHASES` refusal above is — re-verified at execution time
 * under the `FOR UPDATE` lock, not trusted as still true by the time the
 * owner confirms.
 *
 * **Only the meaningful half is shared (fix round 4, item 3).** The
 * job-scoping arm — `business_id = $1 AND job_id = ANY ($2)` — is still
 * restated by hand as the executor's own locked `SELECT`'s `WHERE`, not read
 * from this constant; only `phase = 'followup' AND awaiting_envelope_id IS
 * NOT NULL` is shared as the computed column. If the SCOPING arm here ever
 * changed, `countItems` would count under the new scope while the executor
 * kept applying its own, intersected with whatever changed — preview and
 * execution would diverge one clause over from where this fix round closed
 * the gap. Not restructured, because the direction of that failure is safe:
 * the executor can only fail FEWER jobs than the preview promised, never
 * more, and it would surface as a visible count mismatch rather than
 * silently. Worth a sentence, not worth the extra indirection today.
 *
 * Parameters: `$1` businessId, `$2` jobIds.
 */
export const STRANDED_PARENT_PREDICATE = `business_id = $1 AND job_id = ANY ($2)
  AND phase = 'followup' AND awaiting_envelope_id IS NOT NULL`;

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
  const digestIds = new Set<string>();
  const mailIds = new Set<string>();

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

    // `verification_verdicts.verdict`. A criterion's `detail` is free text the
    // JUDGE MODEL writes, quoting the draft or the answer when it helps —
    // exactly the `agent_envelopes.payload` shape above. The `job_plans.plan`
    // query above does reach `gov.verify`'s job for a contact named in the
    // DRAFT, because `beginVerification` binds the draft into that job's plan
    // — but the judge writes its own prose, and a name it puts in `detail`
    // need not appear in the draft at all. So this query is not redundant
    // with that one: without it, a verdict that is the ONLY surviving place a
    // counterparty's name appears for this job is invisible to a
    // contact-anchored erasure, even though
    // `VERIFICATION_VERDICTS_ERASED_PREDICATE` would delete the row once the
    // job is found some other way.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM verification_verdicts
        WHERE business_id = $1 AND verdict::text ILIKE $2 ${LIKE_ESCAPE}`,
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

    // `whatsapp_messages` is reached as a closure target by `job_id`
    // membership (`WHATSAPP_MESSAGES_ERASED_PREDICATE`'s job arm), so a name
    // that appears ONLY here — a non-opening message on an existing job
    // (only the message that OPENED a job is mirrored into
    // `boss_instructions.text`, which has `job_id NOT NULL UNIQUE`; every
    // later message on that same job has its text nowhere else), or an
    // assistant-authored `recordOutbound` body, which is stored in no other
    // table at all — must be able to put its job into `jobIds` first. The
    // same pairing `boss_instructions`, `autonomy_marks`, `agent_envelopes`
    // and `verification_verdicts` above all have: fix round 3's HIGH finding
    // was exactly this table having the closure half (the content arm inside
    // `job_id IS NULL`) without this discovery half, so a contact named only
    // in a job-tied message's own `sender_number`/`body`/`transcript` was
    // reached by neither the job arm (nothing else discovered that job) nor
    // the content arm (switched off by the gate the job arm needs to stay
    // safe) — `countItems` reported zero, the owner was told the row was
    // gone, and it survived permanently. `job_id IS NOT NULL` because this
    // query derives JOB ids; the orphan row it skips is matched directly, by
    // its own content, in `WHATSAPP_MESSAGES_ERASED_PREDICATE`'s own
    // `job_id IS NULL` arm.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM whatsapp_messages
        WHERE business_id = $1 AND job_id IS NOT NULL
          AND (coalesce(sender_number, '') ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(body, '')         ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(transcript, '')   ILIKE $2 ${LIKE_ESCAPE})`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM jobs WHERE business_id = $1 AND coalesce(title, '') ILIKE $2 ${LIKE_ESCAPE}`,
      [businessId, pattern],
      'job_id',
    )) jobIds.add(jobId);

    // `digests` carries no job id at all — see this module's header for why
    // it is discovered by its own `body` alone, with no job-membership half
    // the way `boss_instructions`/`autonomy_marks`/`agent_envelopes`/
    // `verification_verdicts` above also have. Without this query a contact
    // named only in a digest's rendered summary — a failed job's title, a
    // rejected document's name, an expired approval's recipient — is never
    // placed anywhere this erasure looks, and the name survives permanently.
    for (const digestId of await idsFrom(
      db,
      `SELECT digest_id FROM digests WHERE business_id = $1 AND body ILIKE $2 ${LIKE_ESCAPE}`,
      [businessId, pattern],
      'digest_id',
    )) digestIds.add(digestId);

    // The mailbox, by its own content — see this module's header. Two
    // sources: the mail row's own columns, and its invoice rows (the
    // supplier's name and the invoice's number and file name are written
    // from the mail, but a reader of this query should not have to know
    // that to trust it covers them).
    for (const mailId of await idsFrom(
      db,
      `SELECT mail_id FROM mail_messages WHERE business_id = $1 AND ${MAIL_CONTENT_MATCHES}`,
      [businessId, pattern],
      'mail_id',
    )) mailIds.add(mailId);

    for (const mailId of await idsFrom(
      db,
      `SELECT DISTINCT mail_id FROM mail_invoices
        WHERE business_id = $1
          AND (supplier_address ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(supplier_name, '')  ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(invoice_number, '') ILIKE $2 ${LIKE_ESCAPE}
            OR coalesce(file_name, '')      ILIKE $2 ${LIKE_ESCAPE})`,
      [businessId, pattern],
      'mail_id',
    )) mailIds.add(mailId);
  }

  if (anchor.kind === 'window') {
    // `received_at`, not `created_at` — see this module's header.
    for (const mailId of await idsFrom(
      db,
      `SELECT mail_id FROM mail_messages WHERE business_id = $1 AND received_at >= $2 AND received_at < $3`,
      [businessId, anchor.fromIso, anchor.toIso],
      'mail_id',
    )) mailIds.add(mailId);

    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM jobs WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
      [businessId, anchor.fromIso, anchor.toIso],
      'job_id',
    )) jobIds.add(jobId);

    // `created_at`, not `window_start`/`window_end` — see this module's
    // header for the full reasoning and the case against.
    for (const digestId of await idsFrom(
      db,
      `SELECT digest_id FROM digests WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
      [businessId, anchor.fromIso, anchor.toIso],
      'digest_id',
    )) digestIds.add(digestId);
  }

  if (anchor.kind === 'document') {
    documentIds.add(anchor.documentId);
  }

  // What every mail found above produced. Runs BEFORE the job→document and
  // memory closures below, because the jobs it adds are exactly what those
  // closures read (a mail's curated memory is `written_by_job` = its triage
  // job; see this module's header for the whole chain).
  if (mailIds.size > 0) {
    const mailList = [...mailIds];
    for (const jobId of await idsFrom(
      db,
      `SELECT job_id FROM mail_messages
        WHERE business_id = $1 AND mail_id = ANY ($2) AND job_id IS NOT NULL
       UNION
       SELECT reply_job_id AS job_id FROM mail_messages
        WHERE business_id = $1 AND mail_id = ANY ($2) AND reply_job_id IS NOT NULL`,
      [businessId, mailList],
      'job_id',
    )) jobIds.add(jobId);

    // Every reply job ever raised for these mails, including a predecessor a
    // re-raise took off `reply_job_id` (`claimFailedReply`). Matched by JSON
    // containment on the bound plan — a `mail.send` step whose input names
    // this mail's `providerMessageId` — never by `ILIKE` on an id: the
    // provider's id is exact, and containment needs no escaping.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT p.job_id FROM job_plans p
         JOIN mail_messages m ON m.business_id = p.business_id
        WHERE p.business_id = $1 AND m.mail_id = ANY ($2)
          AND p.plan -> 'steps' @> jsonb_build_array(jsonb_build_object(
                'toolName', 'mail.send',
                'input', jsonb_build_object('providerMessageId', m.provider_message_id)))`,
      [businessId, mailList],
      'job_id',
    )) jobIds.add(jobId);

    // The documents its attachments were ingested as. Both places the link
    // lives: `attachments[].documentId` (Task 12, R14) and the invoice row.
    for (const documentId of await idsFrom(
      db,
      `SELECT e ->> 'documentId' AS document_id
         FROM mail_messages m,
              jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments) = 'array'
                                        THEN m.attachments ELSE '[]'::jsonb END) AS e
        WHERE m.business_id = $1 AND m.mail_id = ANY ($2)
          AND e ->> 'documentId' IS NOT NULL
       UNION
       SELECT document_id FROM mail_invoices
        WHERE business_id = $1 AND mail_id = ANY ($2) AND document_id IS NOT NULL`,
      [businessId, mailList],
      'document_id',
    )) documentIds.add(documentId);
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

    // A job whose BOUND PLAN names this document, which the `proposals` query
    // above structurally cannot reach.
    //
    // `conduct.ts`'s `beginVerification` opens a `gov.verify` job beside the
    // approval card and binds a one-step plan whose input carries
    // `documentId`, the question, and `draftText` — the draft DERIVED FROM
    // THIS DOCUMENT, verbatim. That job has no `proposals` row of its own (the
    // proposal belongs to the subject job), no reading, and a title that names
    // only the subject job id. So before this query a document-anchored
    // erasure destroyed the document, its readings and the subject job's
    // plan — and left the draft sitting in the `gov.verify` job's
    // `job_plans.plan`, which is exactly the "content survives because nothing
    // discovers it" shape this module exists to prevent. A CONTACT anchor
    // already found it, through the `job_plans.plan ILIKE` query above; only
    // the document side was blind.
    //
    // Written the same positive way that query is: search the column that
    // holds the text, add the owning `job_id`, and let the unchanged
    // `job_id = ANY ($2)` deletions close over it — no delete predicate
    // changes here. `anchor.documentId` rather than the `documentIds` set,
    // because on a `document` anchor the set is exactly that one id (the
    // jobs→documents query above ran with `jobIds` still empty), and an
    // `ILIKE ANY (array)` form cannot carry the `ESCAPE` clause that
    // `likeLiteral` only works as a pair with.
    //
    // Over-deletion is not the risk it would be for a hand-written contact
    // string: a `documentId` is `DOC-<ulid>`, system-generated, so a plan
    // whose text contains it named THIS document deliberately.
    for (const jobId of await idsFrom(
      db,
      `SELECT DISTINCT job_id FROM job_plans
        WHERE business_id = $1 AND plan::text ILIKE $2 ${LIKE_ESCAPE}`,
      [businessId, `%${likeLiteral(anchor.documentId)}%`],
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

  const digestList = [...digestIds];
  const mailList = [...mailIds];
  const items = await countItems(
    db, businessId, anchor, jobList, documentList, memoryIds, digestList, mailList,
  );

  return {
    anchor,
    jobIds: jobList,
    documentIds: documentList,
    memoryIds,
    digestIds: digestList,
    mailIds: mailList,
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
  digestIds: string[],
  mailIds: string[],
): Promise<ErasureItem[]> {
  const one = async (
    table: string,
    action: 'delete' | 'scrub' | 'fail',
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
    // See this module's header for why `digests` is discovered by its own
    // content alone, with no job to carry it in by. Placed beside `memories`
    // rather than in the job-scoped group below it: like memories, nothing
    // about its deletion depends on the document cascade order, and its ids
    // come from `digestIds` directly, never from `jobIds`.
    await one(
      'digests',
      'delete',
      `SELECT count(*)::text AS n FROM digests WHERE ${DIGESTS_ERASED_PREDICATE}`,
      [businessId, digestIds],
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
    // The mailbox. `mail_invoices` before `mail_messages`, matching the
    // executor's order — see `MAIL_INVOICES_ERASED_PREDICATE` for why the
    // cascade must not be what removes an invoice.
    await one(
      'mail_invoices',
      'delete',
      `SELECT count(*)::text AS n FROM mail_invoices WHERE ${MAIL_INVOICES_ERASED_PREDICATE}`,
      [businessId, mailIds, documentIds],
    ),
    await one(
      'mail_messages',
      'delete',
      `SELECT count(*)::text AS n FROM mail_messages WHERE ${MAIL_MESSAGES_ERASED_PREDICATE}`,
      [businessId, mailIds],
    ),
    await one(
      'boss_instructions',
      'delete',
      `SELECT count(*)::text AS n FROM boss_instructions
        WHERE business_id = $1 AND job_id = ANY ($2)`,
      [businessId, jobIds],
    ),
    // See `WHATSAPP_MESSAGES_ERASED_PREDICATE` above for why this is three
    // arms rather than `job_id = ANY($2)` alone.
    await one(
      'whatsapp_messages',
      'delete',
      `SELECT count(*)::text AS n FROM whatsapp_messages WHERE ${WHATSAPP_MESSAGES_ERASED_PREDICATE}`,
      whatsappMessageParams(businessId, jobIds, anchor),
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
    // See `ACTION_UPDATES_ERASED_PREDICATE` above: job-anchored, like
    // `autonomy_marks`.
    await one(
      'action_updates',
      'delete',
      `SELECT count(*)::text AS n FROM action_updates WHERE ${ACTION_UPDATES_ERASED_PREDICATE}`,
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
    // See `ErasureItem.action`'s and `STRANDED_PARENT_PREDICATE`'s own
    // docblocks (fix round 2, item 1) for why this is counted separately from
    // the `scrub` above rather than folded into it.
    await one(
      'jobs',
      'fail',
      `SELECT count(*)::text AS n FROM jobs WHERE ${STRANDED_PARENT_PREDICATE}`,
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
