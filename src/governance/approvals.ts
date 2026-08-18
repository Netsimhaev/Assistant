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
    throw new Error(
      `approval ${approvalId} is already ${existing.state}; refusing to decide it twice`,
    );
  }
  // A fuse that burned out is not a decision that can still be made. `state`
  // stays 'pending' until the scheduler sweeps it, and `expireOverdue` has no
  // caller yet — so without this check an approval three days past its expiry
  // was still approvable, and the TTL was decoration.
  if (Date.parse(existing.expiresAt) <= Date.now()) {
    throw new Error(
      `approval ${approvalId} expired at ${existing.expiresAt}; it must be re-queued, not decided`,
    );
  }

  const edited = decision.editedInput !== undefined;
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
    throw new Error(`approval ${approvalId} was decided or expired concurrently`);
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

