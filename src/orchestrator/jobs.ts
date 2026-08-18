import { ulid } from 'ulid';
import { config } from '../config.js';
import { JobPhase, canTransition, type JobActor } from '../domain/job.js';
import type { TrustLevel } from '../domain/trust.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';

export interface Job {
  jobId: string;
  businessId: string;
  phase: JobPhase;
  charterVersion: string;
  provenance: TrustLevel;
  title: string | null;
  wakeAt: string | null;
  closedAt: string | null;
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
  costMinor?: number | null;
  businessId?: string;
}

/**
 * Move a job to a new phase and record the move.
 *
 * The phase update and its `job_steps` row are one transaction. A phase that
 * advanced without a step row would be a job whose history has a hole in it,
 * and the history is the only thing that makes the run auditable afterwards.
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
              updated_at = now()
        WHERE job_id = $1 AND business_id = $2
        RETURNING *`,
      [jobId, businessId, input.to, input.wakeAt ?? null, terminal],
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
