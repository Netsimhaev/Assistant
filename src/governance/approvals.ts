import { ulid } from 'ulid';
import { config } from '../config.js';
import type { ActionClass } from '../domain/action.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { getPool, type Queryable } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';

export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'approved_with_edit'
  | 'denied'
  | 'expired'
  | 'cancelled';

export interface ApprovalRequest {
  approvalId: string;
  jobId: string | null;
  envelopeId: string | null;
  actionClass: ActionClass;
  summary: string;
  detail: string;
  diffVsNorm: string | null;
  risk: RiskAssessment;
  proposedTool: string;
  proposedInput: unknown;
  inputHash: string;
  createdAt: string;
  expiresAt: string;
  state: ApprovalState;
  editedInput: unknown;
}

export interface EnqueueInput {
  jobId?: string | null;
  envelopeId?: string | null;
  facts: ActionFacts;
  risk: RiskAssessment;
  proposedInput: unknown;
  summary: string;
  detail?: string;
  diffVsNorm?: string | null;
  requestedFrom?: { personId: string; channel: string }[];
  ttlMinutes?: number;
  onTimeout?: 'expire' | 'escalate_next' | 'notify_only';
}

/**
 * Queue an action for human approval.
 *
 * The run that triggered this ends here — the hook denies with
 * `queued_for_approval:<id>` and the job goes dormant. Holding a `query()` open
 * while a human takes six hours to answer is a resource and reliability
 * disaster, so approval is never a blocking wait (docs/00-overview.md, #4).
 */
export async function enqueueApproval(
  input: EnqueueInput,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<string> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  if (input.facts.actionClass === null) {
    throw new Error('cannot queue an approval for a read-only action');
  }

  const approvalId = `AP-${ulid()}`;
  const ttl = input.ttlMinutes ?? defaultTtlMinutes(input.risk);
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

  await db.query(
    `INSERT INTO approval_requests (
       approval_id, business_id, job_id, envelope_id, action_class,
       summary, detail, diff_vs_norm, risk, proposed_tool, proposed_input,
       input_hash, requested_from, expires_at, on_timeout, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
    [
      approvalId,
      businessId,
      input.jobId ?? null,
      input.envelopeId ?? null,
      input.facts.actionClass,
      input.summary,
      input.detail ?? input.summary,
      input.diffVsNorm ?? null,
      JSON.stringify(input.risk),
      input.facts.toolName,
      JSON.stringify(input.proposedInput ?? null),
      input.facts.inputHash,
      JSON.stringify(input.requestedFrom ?? []),
      expiresAt,
      input.onTimeout ?? (input.risk.band === 'anomalous' ? 'escalate_next' : 'expire'),
    ],
  );

  return approvalId;
}

/** An anomalous action gets a shorter fuse and escalates rather than expiring. */
function defaultTtlMinutes(risk: RiskAssessment): number {
  return risk.band === 'anomalous' ? 60 : 4 * 60;
}

interface ApprovalRow {
  approval_id: string;
  job_id: string | null;
  envelope_id: string | null;
  action_class: string;
  summary: string;
  detail: string;
  diff_vs_norm: string | null;
  risk: unknown;
  proposed_tool: string;
  proposed_input: unknown;
  input_hash: string;
  created_at: Date;
  expires_at: Date;
  state: string;
  edited_input: unknown;
}

function toRequest(row: ApprovalRow): ApprovalRequest {
  return {
    approvalId: row.approval_id,
    jobId: row.job_id,
    envelopeId: row.envelope_id,
    actionClass: row.action_class as ActionClass,
    summary: row.summary,
    detail: row.detail,
    diffVsNorm: row.diff_vs_norm,
    risk: row.risk as RiskAssessment,
    proposedTool: row.proposed_tool,
    proposedInput: row.proposed_input,
    inputHash: row.input_hash,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    state: row.state as ApprovalState,
    editedInput: row.edited_input,
  };
}

export async function getApproval(
  approvalId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ApprovalRequest | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ApprovalRow>(
    'SELECT * FROM approval_requests WHERE approval_id = $1 AND business_id = $2',
    [approvalId, options.businessId ?? config.businessId],
  );
  const row = rows[0];
  return row ? toRequest(row) : null;
}

/**
 * The approval, if any, that already covers this exact step.
 *
 * Approvals do not record a step id when they are enqueued — the gate that
 * creates one only ever sees a tool call, not the plan step it came from — so
 * there is nothing to join a resumed step back to its approval by *except*
 * what both sides already agree on: the input. `buildFacts` sets
 * `inputHash: canonicalHash(toolInput)` (`src/policy/facts.ts`) and
 * `enqueueApproval` stores that same value in `input_hash`, so a step whose
 * ORIGINAL input hashes the same as an approved, unconsumed row for this job
 * is the step that row was answering.
 *
 * "Original" matters: an approval-with-edit's edited input is a different
 * value living under a different column (`input_hash_at_decision`, written by
 * `decide`). This lookup only ever matches on the proposed input's hash —
 * finding the right approval is a job-and-input match, not a content match —
 * and the edited input is substituted later, inside `executeStep`, once the
 * approval itself has been found.
 *
 * Ordered oldest-first with `LIMIT 1` so that two rows which happened to match
 * — the same job re-proposing the identical input twice — cannot answer
 * differently across two runs of the same resume.
 *
 * Expired rows are excluded. `expireOverdue` only sweeps rows still in
 * `pending`, so an approval that was granted and then stranded — the job
 * halted, the run never came back — keeps `state = 'approved'` indefinitely.
 * Without the `expires_at` predicate here, a re-plan long afterwards that
 * happened to produce the same input hash would be handed a decision nobody
 * remembers making. A step offered nothing simply queues a fresh request,
 * which is the right outcome: the fuse ran out on the question, not on the
 * work. `consumeApproval` re-checks the same predicate in its claim, because
 * this answer can go stale between the two statements.
 */
export async function unspentApprovalFor(
  query: { jobId: string; inputHash: string; businessId?: string; db?: Queryable },
): Promise<string | null> {
  const db = query.db ?? getPool();
  const { rows } = await db.query<{ approval_id: string }>(
    `SELECT approval_id FROM approval_requests
      WHERE business_id = $1 AND job_id = $2 AND input_hash = $3
        AND state IN ('approved', 'approved_with_edit')
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at ASC
      LIMIT 1`,
    [query.businessId ?? config.businessId, query.jobId, query.inputHash],
  );
  return rows[0]?.approval_id ?? null;
}

export async function pendingApprovals(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ApprovalRequest[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ApprovalRow>(
    `SELECT * FROM approval_requests
      WHERE business_id = $1 AND state = 'pending'
      ORDER BY created_at ASC`,
    [options.businessId ?? config.businessId],
  );
  return rows.map(toRequest);
}

/**
 * The pending approval a job is parked behind, if any — the id a report to
 * the owner can link to.
 *
 * `null` is a real outcome, not a bug: between the caller reading
 * `jobs.phase = 'await_approval'` and this query running, the one row that
 * explains it may have moved — decided (`decide`) or timed out
 * (`expireOverdue`), both of which take it out of `pending`. The caller (the
 * WhatsApp report, `src/orchestrator/whatsapp-report.ts`) treats that as
 * "nothing to link to today", never as a reason to throw: the job's own
 * phase is the fact being reported, and a stale approval row is not required
 * to report it.
 *
 * `LIMIT 1` ordered newest-first: `executeStep` only ever parks a job behind
 * one live approval at a time, so more than one `pending` row for the same
 * job would itself be a different bug — this function is not the place that
 * surfaces it.
 */
export async function pendingApprovalForJob(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<string | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ approval_id: string }>(
    `SELECT approval_id FROM approval_requests
      WHERE business_id = $1 AND job_id = $2 AND state = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
    [options.businessId ?? config.businessId, jobId],
  );
  return rows[0]?.approval_id ?? null;
}

/**
 * Thrown when an approval cannot be decided: it is not `pending` any more, its
 * fuse has burned out, or another statement claimed it between this call's
 * read and its own `UPDATE`.
 *
 * A named class, not a bare `Error`, because callers have to tell "a person
 * already answered this / the clock ran out" apart from a real fault. The
 * dashboard renders the first as a refusal the owner can act on and the second
 * as a 500; message-matching to make that distinction would be a control held
 * together by prose. The messages themselves are unchanged.
 */
export class ApprovalNotDecidableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotDecidableError';
  }
}

export interface Decision {
  by: string;
  channel: 'dashboard' | 'whatsapp' | 'email';
  note?: string;
  /** Present when the boss edited the action before approving. */
  editedInput?: unknown;
}

/**
 * Record a human decision.
 *
 * `inputHashAtDecision` is the TOCTOU guard: the approval binds to the exact
 * input that was shown. When the action is finally executed, the live input is
 * hashed again and compared — if the world moved underneath (a price changed on
 * the supplier's page), the mismatch re-queues rather than proceeding on an
 * approval the boss never actually gave for *this* input.
 */
export async function decide(
  approvalId: string,
  outcome: 'approved' | 'denied',
  decision: Decision,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ApprovalRequest> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const existing = await getApproval(approvalId, { businessId, db });
  if (!existing) throw new Error(`unknown approval ${approvalId}`);
  if (existing.state !== 'pending') {
    throw new ApprovalNotDecidableError(
      `approval ${approvalId} is already ${existing.state}; refusing to decide it twice`,
    );
  }
  // A fuse that burned out is not a decision that can still be made. `state`
  // stays 'pending' until the scheduler sweeps it, and `expireOverdue` has no
  // caller yet — so without this check an approval three days past its expiry
  // was still approvable, and the TTL was decoration.
  if (Date.parse(existing.expiresAt) <= Date.now()) {
    throw new ApprovalNotDecidableError(
      `approval ${approvalId} expired at ${existing.expiresAt}; it must be re-queued, not decided`,
    );
  }

  // **`edited` is a comparison, not the presence of a field** — and this was
  // the last of the two findings the 28/08 security review left open on
  // purpose. It used to be `decision.editedInput !== undefined`, so ANY
  // caller that passed the payload back unchanged stamped
  // `approved_with_edit` on an approval nobody touched.
  //
  // The dashboard happens not to: `parseEditedInput`
  // (`src/dashboard/server.ts`) hashes the owner's text against the original
  // and omits the field when they match, precisely so a round-trip through
  // the textarea that changed only key order is not read as an edit. But
  // that put the whole control in ONE caller, one layer above the statement
  // that writes the label — and this project's rule is that a boundary
  // documented as a control has to be the control. A second caller (the SDK
  // path, a future approval channel, a test helper copied from the wrong
  // place) reintroduces the bug with nothing to catch it.
  //
  // **What the mislabel actually costs, which is why it is a security item
  // and not a cosmetic one.** `approvalStreak`
  // (`src/governance/agreement.ts`) counts only `approved` — `break` on
  // anything else, deliberately, since an edit means the owner did not
  // accept what was proposed. So a mislabelled row silently resets the run
  // toward promotion: an owner who approved ten cards unchanged would never
  // earn the raise, `evaluateAutonomy` would report no streak, and nothing
  // anywhere would say why. That is the autonomy mechanism quietly not
  // working, which is worse than it refusing out loud. Beyond that, the
  // audit trail would assert that a human edited something they did not.
  //
  // Comparing against `existing.inputHash` and not against
  // `decision.editedInput === undefined` also keeps `boundHash` below
  // honest: an equivalent payload leaves the approval bound to the hash it
  // was raised with, rather than rebinding it to a recomputation of the same
  // bytes. The dashboard's own check stays where it is — two layers, the way
  // this file's `expires_at` guard is checked in JS and again in SQL.
  const edited =
    decision.editedInput !== undefined &&
    canonicalHash(decision.editedInput) !== existing.inputHash;
  const state: ApprovalState =
    outcome === 'denied' ? 'denied' : edited ? 'approved_with_edit' : 'approved';

  // An edit re-binds the approval to the edited input, which is what lets the
  // boss change a quantity on the card and have that exact change executed.
  const boundHash = edited
    ? canonicalHash(decision.editedInput)
    : existing.inputHash;

  const { rows } = await db.query<ApprovalRow>(
    `UPDATE approval_requests
        SET state = $3, decided_by = $4, decided_at = now(),
            decided_channel = $5, decision_note = $6,
            edited_input = $7, input_hash_at_decision = $8
      WHERE approval_id = $1 AND business_id = $2
        AND state = 'pending' AND expires_at > now()
      RETURNING *`,
    [
      approvalId,
      businessId,
      state,
      decision.by,
      decision.channel,
      decision.note ?? null,
      edited ? JSON.stringify(decision.editedInput) : null,
      boundHash,
    ],
  );

  const row = rows[0];
  if (!row) {
    // The predicate above is the authority, not the read that preceded it: the
    // scheduler may have expired this row between the two statements.
    throw new ApprovalNotDecidableError(
      `approval ${approvalId} was decided or expired concurrently`,
    );
  }
  return toRequest(row);
}

/**
 * Expire approvals whose fuse ran out. Called by the scheduler.
 * Returns the ones that expired so the caller can escalate where configured.
 */
export async function expireOverdue(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ApprovalRequest[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ApprovalRow>(
    `UPDATE approval_requests
        SET state = 'expired'
      WHERE business_id = $1 AND state = 'pending' AND expires_at <= now()
      RETURNING *`,
    [options.businessId ?? config.businessId],
  );
  return rows.map(toRequest);
}

