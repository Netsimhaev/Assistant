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
 * **A question is answerable only while it is fresh — checked in the same
 * UPDATE.** `confirmChoice` requires `presented_at` to be inside the question
 * window (`config.whatsappQuestionWindowMinutes`, the setting `openMailCards`
 * reads) as a positive condition of that one statement. Expiry by sweep alone
 * would leave the gap between sweeps open, and the gate's 24-hour check
 * measures `decided_at`, so a question presented weeks ago and confirmed now
 * would otherwise look fresh. A window of `0` means what it means for
 * `openMailCards` — nothing is open — so every confirm is refused and
 * `expireConfirmations` expires every pending row.
 *
 * **A WhatsApp question counts only once it was delivered.** `presented_at`
 * is written at INSERT, before the send; `delivered_at` is stamped by
 * `markConfirmationDelivered` only after an `ok` send. A WhatsApp answer
 * (`confirmChoice` with `whatsappInboundAt`) requires a WhatsApp row with
 * `delivered_at` set and strictly before the message — otherwise a failed
 * send followed by a later "כן" confirmed a plan the owner never saw. The
 * dashboard renders the row itself and needs no delivery.
 *
 * **One clock: the database's.** `presented_at` is written by `DEFAULT now()`,
 * and every comparison and every `decided_at` uses the same `now()`; the app
 * clock never meets the stored one.
 *
 * **The hash is the store's, not the caller's.** `createConfirmation`
 * computes `planHashOf` for each option itself and refuses a supplied hash
 * that disagrees, or two options with the same hash — the hash is what the
 * gate later binds and exempts, so it must name exactly the plan presented.
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
import { planHashOf } from '../orchestrator/plan-store.js';

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
  /**
   * The name of the contact this option is about, one line, when the option
   * is one candidate of an ambiguous name (`planPerCandidate`). Stored so the
   * confirm reader (`command-confirm.ts`) can match "דנה חיוט" or "חיוט"
   * against the name itself rather than parse it back out of `label`, which
   * also carries the company and the address. Absent on a single option.
   */
  contactName: z.string().min(1).optional(),
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
  /**
   * When a WhatsApp question was actually sent — stamped only after an `ok`
   * send (`markConfirmationDelivered`). `null` on a dashboard row, and on a
   * WhatsApp row whose send failed, never ran, or was refused as too long.
   */
  deliveredAt: Date | null;
  channel: ConfirmationChannel;
  state: ConfirmationState;
  chosenPlanHash: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  reaskOf: string | null;
}

/** The `instruction_confirmations` columns `toConfirmation` reads. Exported for readers that select rows themselves. */
export interface ConfirmationRow {
  job_id: string;
  options: unknown;
  presented_text: string;
  presented_at: Date;
  delivered_at: Date | null;
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
export function toConfirmation(row: ConfirmationRow): InstructionConfirmation {
  return {
    jobId: row.job_id,
    options: ConfirmationOptions.parse(row.options),
    presentedText: row.presented_text,
    presentedAt: row.presented_at,
    deliveredAt: row.delivered_at,
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
  const seen = new Set<string>();
  for (const option of parsed) {
    const computed = planHashOf(option.plan);
    if (option.planHash !== computed) {
      throw new Error(`confirmation option planHash does not match its plan (${option.planHash} != ${computed})`);
    }
    if (seen.has(computed)) {
      throw new Error(`confirmation options repeat the same plan (${computed})`);
    }
    seen.add(computed);
  }
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
    `SELECT job_id, options, presented_text, presented_at, delivered_at, channel, state,
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
 * pending, a question presented outside the window, or a hash that is not
 * among the presented options. A window of `0` or less refuses every confirm.
 *
 * `whatsappInboundAt` marks an answer that arrived on WhatsApp, dated by the
 * provider. It adds, in the same statement: the row is a WhatsApp question,
 * it was delivered, and it was delivered strictly before the answer — the
 * re-check of `openConfirmations`' read, so a row whose delivery was never
 * stamped can never be confirmed from WhatsApp. An unreadable date confirms
 * nothing. Absent (the dashboard), none of this applies.
 */
export async function confirmChoice(
  jobId: string,
  planHash: string,
  decidedBy: string,
  options: Scope & { windowMinutes?: number; whatsappInboundAt?: Date },
): Promise<boolean> {
  const windowMinutes = options.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return false;
  const inboundAt = options.whatsappInboundAt;
  if (inboundAt !== undefined && Number.isNaN(inboundAt.getTime())) return false;
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE instruction_confirmations
        SET state = 'confirmed', chosen_plan_hash = $3, decided_at = now(), decided_by = $4
      WHERE business_id = $1 AND job_id = $2 AND state = 'pending'
        AND presented_at > now() - make_interval(mins => $5)
        AND options @> jsonb_build_array(jsonb_build_object('planHash', $3::text))
        AND ($6::timestamptz IS NULL
             OR (channel = 'whatsapp' AND delivered_at IS NOT NULL AND delivered_at < $6::timestamptz))`,
    [options.businessId, jobId, planHash, decidedBy, windowMinutes, inboundAt ?? null],
  );
  return result.rowCount === 1;
}

/**
 * Record that a WhatsApp question was sent — call it only after an `ok`
 * send. `true` only for the call that stamped it: the row must be a pending
 * WhatsApp row not yet stamped, in this business. On the database clock, the
 * one `openConfirmations` compares the provider's date against.
 */
export async function markConfirmationDelivered(jobId: string, options: Scope): Promise<boolean> {
  const db = options.db ?? getPool();
  const result = await db.query(
    `UPDATE instruction_confirmations
        SET delivered_at = now()
      WHERE business_id = $1 AND job_id = $2
        AND channel = 'whatsapp' AND state = 'pending' AND delivered_at IS NULL`,
    [options.businessId, jobId],
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
 * Expire every pending row presented at or before the window's start, and
 * return their job ids — the exact complement of what `confirmChoice` still
 * accepts.
 *
 * The window is `config.whatsappQuestionWindowMinutes` unless overridden, the
 * same setting and the same reading as `openMailCards`: `0` (or less) means no
 * question is open, so every pending row of the business expires. Measured on
 * the database clock (`now()`), the clock that wrote `presented_at`.
 */
export async function expireConfirmations(options: {
  businessId: string;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<string[]> {
  const windowMinutes = options.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ job_id: string }>(
    `UPDATE instruction_confirmations
        SET state = 'expired', decided_at = now()
      WHERE business_id = $1 AND state = 'pending'
        AND ($2 <= 0 OR presented_at <= now() - make_interval(mins => $2))
      RETURNING job_id`,
    [options.businessId, windowMinutes],
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
