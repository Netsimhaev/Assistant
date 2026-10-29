import { ulid } from 'ulid';
import { config } from '../config.js';
import { JobPhase, canTransition, type JobActor } from '../domain/job.js';
import type { TrustLevel } from '../domain/trust.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { recordStepCompletion, type StepCompletion } from './plan-store.js';

export interface Job {
  jobId: string;
  businessId: string;
  phase: JobPhase;
  charterVersion: string;
  provenance: TrustLevel;
  title: string | null;
  wakeAt: string | null;
  closedAt: string | null;
  /**
   * Whether this job has ever pulled content from outside the instance's
   * trust boundary. Required, not optional: every construction site must
   * state its answer, rather than a field that quietly defaults to the
   * permissive case when a caller forgets it. See migration 011 for the
   * full rationale and `markContentIngested` for how it is set.
   */
  contentIngested: boolean;
  /**
   * The `help_request` envelope this job is parked on, or `null`. Set when
   * `requestHelp` (`orchestrator/delegate.ts`) moves a delegating job to
   * `followup`; read by `resumeDelegatedJobs` to find which job to wake once
   * the child it spawned closes. Migration 028.
   */
  awaitingEnvelopeId: string | null;
}

interface JobRow {
  job_id: string;
  business_id: string;
  phase: string;
  charter_version: string;
  provenance: string;
  title: string | null;
  wake_at: Date | null;
  closed_at: Date | null;
  content_ingested: boolean;
  awaiting_envelope_id: string | null;
}

function toJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    businessId: row.business_id,
    phase: JobPhase.parse(row.phase),
    charterVersion: row.charter_version,
    provenance: row.provenance as TrustLevel,
    title: row.title,
    wakeAt: row.wake_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    contentIngested: row.content_ingested,
    awaitingEnvelopeId: row.awaiting_envelope_id,
  };
}

export interface CreateJobInput {
  charterVersion: string;
  /**
   * Lowest trust in the causal chain, stamped by the gateway before any model
   * sees the content. Not a default and not optional: a job whose provenance
   * nobody stamped would inherit the most permissive ceiling in the system.
   */
  provenance: TrustLevel;
  title?: string;
  businessId?: string;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const businessId = input.businessId ?? config.businessId;
  const jobId = `J-${ulid()}`;

  const { rows } = await getPool().query<JobRow>(
    `INSERT INTO jobs (job_id, business_id, phase, charter_version, provenance, title)
     VALUES ($1, $2, 'intake', $3, $4, $5)
     RETURNING *`,
    [jobId, businessId, input.charterVersion, input.provenance, input.title ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error('job insert returned no row');
  return toJob(row);
}

export async function loadJob(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Job | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<JobRow>(
    'SELECT * FROM jobs WHERE job_id = $1 AND business_id = $2',
    [jobId, options.businessId ?? config.businessId],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

export interface TransitionInput {
  to: JobPhase;
  actor: JobActor;
  reason: string;
  /** Set when moving to `followup`: when the job should be picked up again. */
  wakeAt?: Date | null;
  envelopeId?: string | null;
  /**
   * The `help_request` envelope id to park this job on, or omitted/`null` to
   * clear it.
   *
   * Overwritten on every transition, exactly like `wakeAt` above and for the
   * same reason: each move states its own wake condition rather than merging
   * with whatever the row already held, so a job that is no longer waiting on
   * a delegation cannot carry a stale envelope id forward by omission.
   */
  awaitingEnvelopeId?: string | null;
  costMinor?: number | null;
  businessId?: string;
  /**
   * A plan step that finished and whose completion belongs with this move.
   *
   * Written inside this transaction rather than beside it — see the docblock
   * below and `recordStepCompletion`.
   */
  completedStep?: StepCompletion;
  /**
   * Move only if the job is still in this phase, read under the same
   * `FOR UPDATE` as the move; otherwise throw `PhaseMovedError` and write
   * nothing. For a caller that decided on the move from an earlier read and
   * must not move a job someone else already moved on (`execute → failed` is
   * legal, so without this a stale decision would silently fail a running
   * job). Two callers: the boss-command confirm and settle paths
   * (`command-confirm.ts`, every move out of `plan`), and the re-ask
   * (`command-reask.ts`), which moves an old command job out of `followup`
   * only if a scheduler pass has not woken it first. Omitted, the move
   * behaves exactly as it always has.
   */
  expectFrom?: JobPhase;
}

/**
 * Thrown by `transition` when `expectFrom` was given and the job is no longer
 * in that phase. Typed so a caller can tell "someone else moved it" from a
 * real failure without matching strings.
 */
export class PhaseMovedError extends Error {
  constructor(
    readonly jobId: string,
    readonly expected: JobPhase,
    readonly actual: JobPhase,
  ) {
    super(`job ${jobId} is in ${actual}, not ${expected}`);
    this.name = 'PhaseMovedError';
  }
}

/**
 * Move a job to a new phase and record the move.
 *
 * The phase update and its `job_steps` row are one transaction. A phase that
 * advanced without a step row would be a job whose history has a hole in it,
 * and the history is the only thing that makes the run auditable afterwards.
 *
 * `completedStep` joins that same transaction for the same reason, one level
 * up: a step's completion and the phase change that follows it must land
 * together or not at all. Written separately, a crash between them leaves the
 * job advanced past a step no row records, and the resumed run does that step
 * again. What the transaction cannot cover is the external call itself, which
 * already happened — `recordStepCompletion` says so in full.
 *
 * The read is `FOR UPDATE`, so two workers racing on the same job serialise
 * here rather than both reading `execute` and both deciding to advance.
 */
export async function transition(
  jobId: string,
  input: TransitionInput,
): Promise<Job> {
  const businessId = input.businessId ?? config.businessId;

  return withTransaction(async (tx) => {
    const { rows } = await tx.query<JobRow>(
      'SELECT * FROM jobs WHERE job_id = $1 AND business_id = $2 FOR UPDATE',
      [jobId, businessId],
    );
    const current = rows[0];
    if (!current) throw new Error(`unknown job ${jobId}`);

    const from = JobPhase.parse(current.phase);
    if (input.expectFrom !== undefined && from !== input.expectFrom) {
      throw new PhaseMovedError(jobId, input.expectFrom, from);
    }
    if (!canTransition(from, input.to)) {
      throw new Error(
        `illegal job transition ${from} → ${input.to} for ${jobId}; see LEGAL_TRANSITIONS`,
      );
    }

    const terminal = input.to === 'closed' || input.to === 'failed' || input.to === 'halted';

    const updated = await tx.query<JobRow>(
      `UPDATE jobs
          SET phase = $3,
              wake_at = $4,
              closed_at = CASE WHEN $5::boolean THEN now() ELSE closed_at END,
              awaiting_envelope_id = $6,
              updated_at = now()
        WHERE job_id = $1 AND business_id = $2
        RETURNING *`,
      [jobId, businessId, input.to, input.wakeAt ?? null, terminal, input.awaitingEnvelopeId ?? null],
    );

    await tx.query(
      `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, envelope_id, cost_minor, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        jobId,
        from,
        input.to,
        input.actor,
        input.envelopeId ?? null,
        input.costMinor ?? null,
        input.reason,
      ],
    );

    if (input.completedStep !== undefined) {
      await recordStepCompletion(tx, {
        ...input.completedStep,
        jobId,
        businessId,
      });
    }

    const row = updated.rows[0];
    if (!row) throw new Error(`job ${jobId} vanished mid-transition`);
    return toJob(row);
  });
}

export interface JobStep {
  from: JobPhase;
  to: JobPhase;
  at: string;
  actor: string;
  reason: string;
}

/** The full history of a job, reconstructible from the database alone. */
export async function jobHistory(jobId: string): Promise<JobStep[]> {
  const { rows } = await getPool().query<{
    from_phase: string;
    to_phase: string;
    at: Date;
    actor: string;
    reason: string;
  }>(
    'SELECT from_phase, to_phase, at, actor, reason FROM job_steps WHERE job_id = $1 ORDER BY at, id',
    [jobId],
  );
  return rows.map((row) => ({
    from: JobPhase.parse(row.from_phase),
    to: JobPhase.parse(row.to_phase),
    at: row.at.toISOString(),
    actor: row.actor,
    reason: row.reason,
  }));
}

/**
 * Jobs whose wake time has come. The scheduler's query.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated rather
 * than starving the jobs that have waited longest.
 */
export async function dueJobs(
  options: { businessId?: string; now?: Date; limit?: number } = {},
): Promise<Job[]> {
  const { rows } = await getPool().query<JobRow>(
    `SELECT * FROM jobs
      WHERE business_id = $1
        AND closed_at IS NULL
        AND wake_at IS NOT NULL
        AND wake_at <= $2
      ORDER BY wake_at ASC
      LIMIT $3`,
    [options.businessId ?? config.businessId, options.now ?? new Date(), options.limit ?? 50],
  );
  return rows.map(toJob);
}

/**
 * Record that this job has pulled content from outside the instance.
 *
 * One-way. There is no unmark, deliberately: a job that has read an
 * attacker-authored document does not become clean again, and the first-contact
 * exemption must stay off for the rest of its life.
 *
 * Called BEFORE the read runs. The window it protects is a crash between the
 * external call and this write — in that window the read happened and nothing
 * remembers it, and the next run would hand out an exemption nobody earned.
 * Marking early can only over-restrict, which is the safe direction.
 *
 * Returns the number of rows the UPDATE matched — 0 or 1, since `job_id` is a
 * primary key. `executeStep` can ignore this safely: `job` there was loaded
 * from the very row being updated, so a mismatch is not a case that occurs.
 * The SDK gate hook cannot make that assumption — `jobId` and `businessId`
 * arrive there as two independent caller-supplied fields, not read off a job
 * already loaded — so a stale id, a typo, or a job belonging to another
 * business all produce a zero-row match indistinguishable from success unless
 * the caller checks. Silently treating that as success is `setPassword`'s
 * mistake (`src/dashboard/auth.ts`): its own zero-row UPDATE has no way to
 * report "no such account", and the one caller that cared had to pre-check
 * with a separate query. This function reports the count itself instead, so
 * a caller with something to protect does not have to guess.
 */
export async function markContentIngested(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE jobs SET content_ingested = true, updated_at = now()
      WHERE job_id = $1 AND business_id = $2`,
    [jobId, options.businessId ?? config.businessId],
  );
  return result.rowCount ?? 0;
}

/**
 * Records which inbound WhatsApp message opened this job — migration 036's
 * `jobs.whatsapp_message_id`. Several messages can carry the same job (a
 * clarifying answer reuses it), and only the one that opened it should ever
 * be linked, so this is written once, by the caller that just created the
 * job from that message — never derived from `whatsapp_messages` itself,
 * which has no column the other direction could read it back from.
 *
 * Throws when the UPDATE matches no row — the same rule `settleMessage`
 * (`src/whatsapp/store.ts`) and `markContentIngested` above already carry: a
 * silent miss here would leave a job that looks linked to nothing, and the
 * caller (the WhatsApp door) needs to know its own id or business id was
 * wrong rather than finding out later, downstream, as silence.
 */
export async function linkWhatsAppMessage(
  jobId: string,
  whatsappMessageId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;
  const { rowCount } = await db.query(
    `UPDATE jobs SET whatsapp_message_id = $1, updated_at = now()
      WHERE job_id = $2 AND business_id = $3`,
    [whatsappMessageId, jobId, businessId],
  );
  if (rowCount !== 1) {
    throw new Error(
      `linkWhatsAppMessage: no jobs row for jobId=${jobId}, businessId=${businessId}`,
    );
  }
}

/**
 * The inbound WhatsApp message that opened this job, or `null`.
 *
 * The read counterpart of `linkWhatsAppMessage` above, and it lives beside it
 * rather than in the WhatsApp modules for the reason that function's own
 * docblock gives: `whatsapp_messages` has no column the other direction could
 * be read back from, so `jobs.whatsapp_message_id` is the only place this
 * fact exists and this file is the only writer of it.
 *
 * `null` covers two cases it cannot tell apart and does not need to: no such
 * job, and a job that never came from the WhatsApp door. Both mean the same
 * thing to every caller — there is no opening message to act on — and
 * neither is treated as a reason to guess one.
 */
export async function whatsAppMessageOf(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<string | null> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;
  const { rows } = await db.query<{ whatsapp_message_id: string | null }>(
    'SELECT whatsapp_message_id FROM jobs WHERE job_id = $1 AND business_id = $2',
    [jobId, businessId],
  );
  return rows[0]?.whatsapp_message_id ?? null;
}
