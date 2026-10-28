/**
 * The one confirmation question a boss command asks before anything with a
 * side effect runs, and the per-step claims that make a confirmed plan run
 * once (spec 2026-10-28, §4.4, §10.2).
 *
 * **One row per job, flipped once.** Every state change is a single
 * `UPDATE ... WHERE state = 'pending'`: a double "כן", or WhatsApp and the
 * dashboard answering at the same moment, confirm once — only the call whose
 * UPDATE caught the row gets `true`. `confirmChoice` also checks, in the same
 * statement, that the chosen hash is one of the presented options, so a hash
 * the owner was never shown can never become the confirmed one.
 *
 * **Claims are the exactly-once half.** The gate exemption that reads a
 * confirmed row is a read; on its own it cannot stop a second run after a
 * crash between the adapter returning and the completion being recorded.
 * `claimConfirmedStep` is an `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
 * so the first claimant of a step gets `true` and every later one `false` —
 * and a refused claim means "this may already have run", never "run it".
 *
 * `businessId` is required on every call, with no default: every statement is
 * scoped by it, and a same-job-id row in another business is never touched.
 *
 * Both tables are wired into erasure (`erasure-plan.ts`, `erasure.ts`).
 */
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import { config } from '../config.js';
import { Plan } from '../domain/plan.js';

export const ConfirmationOption = z.object({
  label: z.string(),
  planHash: z.string().min(1),
  plan: Plan,
  /**
   * Where the address in this option came from: typed by the owner / from
   * memory he wrote (`boss`), from memory learned out of a document or mail
   * (`unverified`), or no contact involved (`null`).
   */
  contactSource: z.enum(['boss', 'unverified']).nullable(),
});
export type ConfirmationOption = z.infer<typeof ConfirmationOption>;

const ConfirmationOptions = z.array(ConfirmationOption);

export type ConfirmationState = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type ConfirmationChannel = 'whatsapp' | 'dashboard';

export interface InstructionConfirmation {
  jobId: string;
  options: ConfirmationOption[];
  presentedText: string;
  presentedAt: Date;
  channel: ConfirmationChannel;
  state: ConfirmationState;
  chosenPlanHash: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  reaskOf: string | null;
}

interface ConfirmationRow {
  job_id: string;
  options: unknown;
  presented_text: string;
  presented_at: Date;
  channel: ConfirmationChannel;
  state: ConfirmationState;
  chosen_plan_hash: string | null;
  decided_at: Date | null;
  decided_by: string | null;
  reask_of: string | null;
}

/**
 * Options are parsed back, not cast: a stored value that no longer reads as
 * the options the owner was shown is not something to confirm against.
 */
function toConfirmation(row: ConfirmationRow): InstructionConfirmation {
  return {
    jobId: row.job_id,
    options: ConfirmationOptions.parse(row.options),
    presentedText: row.presented_text,
    presentedAt: row.presented_at,
    channel: row.channel,
    state: row.state,
    chosenPlanHash: row.chosen_plan_hash,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    reaskOf: row.reask_of,
  };
}

interface Scope {
  businessId: string;
  db?: Queryable;
}

export async function createConfirmation(
  input: {
    jobId: string;
    options: ConfirmationOption[];
    presentedText: string;
    channel: ConfirmationChannel;
    reaskOf?: string;
  },
  options: Scope,
): Promise<void> {
  const db = options.db ?? getPool();
  const parsed = ConfirmationOptions.min(1).parse(input.options);
  await db.query(
    `INSERT INTO instruction_confirmations
       (business_id, job_id, options, presented_text, channel, reask_of)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      options.businessId,
      input.jobId,
      JSON.stringify(parsed),
      input.presentedText,
      input.channel,
      input.reaskOf ?? null,
    ],
  );
}

export async function loadConfirmation(
  jobId: string,
  options: Scope,
): Promise<InstructionConfirmation | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ConfirmationRow>(
    `SELECT job_id, options, presented_text, presented_at, channel, state,
            chosen_plan_hash, decided_at, decided_by, reask_of
       FROM instruction_confirmations
      WHERE business_id = $1 AND job_id = $2`,
    [options.businessId, jobId],
  );
  const row = rows[0];
  return row ? toConfirmation(row) : null;
}

/**
 * Flip a pending row to `confirmed` with the chosen plan. `true` only for the
 * call that flipped it; `false` for an unknown job, a row that is no longer
 * pending, or a hash that is not among the presented options.
 */
export async function confirmChoice(
  jobId: string,
  planHash: string,
  decidedBy: string,
  options: Scope,
): Promise<boolean> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE instruction_confirmations
        SET state = 'confirmed', chosen_plan_hash = $3, decided_at = now(), decided_by = $4
      WHERE business_id = $1 AND job_id = $2 AND state = 'pending'
        AND options @> jsonb_build_array(jsonb_build_object('planHash', $3::text))`,
    [options.businessId, jobId, planHash, decidedBy],
  );
  return result.rowCount === 1;
}

/** Flip a pending row to `cancelled`. `true` only for the call that flipped it. */
export async function cancelConfirmation(
  jobId: string,
  decidedBy: string,
  options: Scope,
): Promise<boolean> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE instruction_confirmations
        SET state = 'cancelled', decided_at = now(), decided_by = $3
      WHERE business_id = $1 AND job_id = $2 AND state = 'pending'`,
    [options.businessId, jobId, decidedBy],
  );
  return result.rowCount === 1;
}

/**
 * Expire every pending row presented longer ago than the window, and return
 * their job ids.
 *
 * The window is `config.whatsappQuestionWindowMinutes` unless overridden, the
 * same setting and the same reading as `openMailCards`: `0` means nothing is
 * ever expired here (the setting is a switch, not a broken value).
 */
export async function expireConfirmations(options: {
  businessId: string;
  now?: Date;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<string[]> {
  const windowMinutes = options.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return [];
  const db = options.db ?? getPool();
  const now = options.now ?? new Date();
  const { rows } = await db.query<{ job_id: string }>(
    `UPDATE instruction_confirmations
        SET state = 'expired', decided_at = $2
      WHERE business_id = $1 AND state = 'pending'
        AND presented_at < $2::timestamptz - make_interval(mins => $3)
      RETURNING job_id`,
    [options.businessId, now, windowMinutes],
  );
  return rows.map((row) => row.job_id).sort();
}

/**
 * Claim one step of a confirmed plan. `true` only for the first claimant; a
 * `false` means the step was already claimed — it may already have run, and
 * must not run again.
 */
export async function claimConfirmedStep(
  input: { jobId: string; stepId: string; planHash: string },
  options: Scope,
): Promise<boolean> {
  const db = options.db ?? getPool();
  const { rows } = await db.query(
    `INSERT INTO confirmed_step_claims (business_id, job_id, step_id, plan_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, job_id, step_id) DO NOTHING
     RETURNING step_id`,
    [options.businessId, input.jobId, input.stepId, input.planHash],
  );
  return rows.length === 1;
}
