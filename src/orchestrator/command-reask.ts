/**
 * Asking the owner again after a confirmed boss command went wrong (spec
 * 2026-10-28, §4.6, §10.3, §10.7).
 *
 * A confirmed command runs once: the gate claims each step before it is
 * dispatched (`claimConfirmedStep`), and a claimed step never runs a second
 * time on the same confirmation. So when something goes wrong AFTER the "כן",
 * the only honest way forward is the owner's word again — never a silent
 * second run. This module finds those jobs and asks.
 *
 * **A command job is a positive fact, twice over:** a `boss_instructions` row
 * (the job was born at the instruction door) AND a `confirmed`
 * `instruction_confirmations` row. A mail reply job with an `unknown` row has
 * neither, and is the mail re-raise's (`reraiseAfterFailedSend`), never this.
 *
 * **What qualifies** (any one):
 *   (a) `failed`, and a step was claimed with no `completed` row for it —
 *       "claimed, outcome unknown or nothing done". This is also where a lost
 *       claim lands (`confirmed_step_already_claimed`), and where a
 *       `channel_unavailable` failure lands: the claim is spent before
 *       dispatch, so we cannot tell "nothing went out" from "went out,
 *       crashed", and the question says "ייתכן שזה כבר בוצע" — which is true;
 *   (b) `failed` or `followup`, and a step has an `unknown` row
 *       (`adapter_timeout`). A re-run would be refused by the exemption on
 *       that row and fall to the normal path, so it is caught here wherever
 *       that leaves it;
 *   (c) `followup`, the confirmation decided 24 hours ago or more (the
 *       exemption's own window, `confirmed-command.ts`), and a step still to
 *       run. Nothing was claimed-and-lost here, so the question is plain;
 *   (d) `failed` with `REASK_REASON` as its last move — this module moved it
 *       there and the re-ask is still owed (a crash after the move). Without
 *       this a (c)-only job, no longer in `followup`, would be lost.
 *
 * **The prefix follows the record, not the path that found the job.**
 * `REASK_PREFIX` is shown exactly when (a) or (b) holds — a claim without a
 * completion, or an `unknown` row. Those facts survive the move to `failed`,
 * so a retry after a crash asks the same question.
 *
 * **Once per old job, held by the schema.** Migration 049's partial UNIQUE
 * index on `(business_id, reask_of)` means one confirmation row may ever name
 * an old job. The candidate read skips a job that already has one, a
 * session advisory lock per old job keeps two passes from building the new
 * job at the same time (the loser skips, `lockedOut`), and the index is the
 * backstop: an INSERT that loses anyway fails the new job it was built for.
 *
 * **The new job is the old one's twin:** provenance `boss` (a literal, as at
 * the door), the same title, a new `boss_instructions` row with the old text
 * and origin, phase `plan`, the same plan bound (so the same hash), and a
 * confirmation with only the chosen option, `reask_of` = the old job, on the
 * old channel. It carries the old job's opening WhatsApp message link
 * (`linkWhatsAppMessage`, its only writer), so the report owed on that
 * message is delivered by the job that actually runs; the old job is kept out
 * of the report (`whatsapp-report.ts`), because the question already told the
 * owner. The WhatsApp question is sent only after the row exists, so the
 * owner's answer can never be dated before it. With no messenger the row
 * still exists and the dashboard lists it (`dashboardConfirmations`); it is
 * counted in `notConnected`, not silenced.
 */
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { JobPhase } from '../domain/job.js';
import { loadInstructionForJob, saveInstruction } from '../governance/instructions.js';
import {
  ConfirmationOption,
  createConfirmation,
  type ConfirmationChannel,
} from '../governance/instruction-confirmations.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { renderConfirmationQuestion } from './command-echo.js';
import { PhaseMovedError, createJob, linkWhatsAppMessage, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';

/** The reason an old job is moved to `failed` with when it is re-asked (case (d) reads it back). */
export const REASK_REASON = 'command: re-asking';

const UNIQUE_VIOLATION = '23505';

export interface ReaskResult {
  /** Old jobs re-asked this pass: a new job and a new confirmation exist for each. */
  reasked: Array<{ oldJobId: string; newJobId: string; uncertain: boolean }>;
  /** Re-asks whose WhatsApp question was sent. */
  sent: number;
  /** Re-asks on the WhatsApp channel with no messenger this pass — the dashboard lists them. */
  notConnected: number;
  /** Re-asks whose WhatsApp send came back `{ ok: false }` — the row exists, the dashboard lists it. */
  sendFailed: number;
  /** Old jobs another pass was re-asking at the same moment. */
  lockedOut: string[];
  errored: Array<{ jobId: string; error: string }>;
}

interface CandidateRow {
  job_id: string;
  phase: string;
  title: string | null;
  whatsapp_message_id: string | null;
  options: unknown;
  chosen_plan_hash: string;
  channel: ConfirmationChannel;
  uncertain: boolean;
}

/**
 * Every condition in SQL, every one positive. `$2` limits the read to one job
 * (the re-read under the lock) or, `NULL`, to none.
 */
const CANDIDATES_SQL = `
  WITH command AS (
    SELECT j.job_id, j.phase, j.title, j.whatsapp_message_id,
           c.options, c.chosen_plan_hash, c.channel, c.decided_at,
           (EXISTS (
              SELECT 1 FROM confirmed_step_claims k
               WHERE k.business_id = j.business_id AND k.job_id = j.job_id
                 AND NOT EXISTS (
                   SELECT 1 FROM job_step_results r
                    WHERE r.business_id = k.business_id AND r.job_id = k.job_id
                      AND r.step_id = k.step_id AND r.plan_hash = k.plan_hash
                      AND r.status = 'completed'
                 )
            )) AS claim_uncertain,
           (EXISTS (
              SELECT 1 FROM job_step_results u
               WHERE u.business_id = j.business_id AND u.job_id = j.job_id
                 AND u.status = 'unknown'
            )) AS has_unknown,
           (EXISTS (
              SELECT 1 FROM job_plans p, jsonb_array_elements(p.plan -> 'steps') s
               WHERE p.business_id = j.business_id AND p.job_id = j.job_id
                 AND NOT EXISTS (
                   SELECT 1 FROM job_step_results r
                    WHERE r.business_id = p.business_id AND r.job_id = p.job_id
                      AND r.plan_hash = p.plan_hash AND r.step_id = s ->> 'id'
                      AND r.status = 'completed'
                 )
            )) AS steps_left,
           ((SELECT st.reason FROM job_steps st
              WHERE st.job_id = j.job_id
              ORDER BY st.at DESC, st.id DESC LIMIT 1) = $3) AS moved_for_reask
      FROM jobs j
      JOIN instruction_confirmations c
        ON c.business_id = j.business_id AND c.job_id = j.job_id AND c.state = 'confirmed'
     WHERE j.business_id = $1
       AND ($2::text IS NULL OR j.job_id = $2)
       AND j.phase IN ('failed', 'followup')
       AND EXISTS (
         SELECT 1 FROM boss_instructions b
          WHERE b.business_id = j.business_id AND b.job_id = j.job_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM instruction_confirmations r
          WHERE r.business_id = j.business_id AND r.reask_of = j.job_id
       )
  )
  SELECT job_id, phase, title, whatsapp_message_id, options, chosen_plan_hash, channel,
         (claim_uncertain OR has_unknown) AS uncertain
    FROM command
   WHERE (phase = 'failed' AND claim_uncertain)
      OR has_unknown
      OR (phase = 'followup' AND decided_at <= now() - interval '24 hours' AND steps_left)
      OR (phase = 'failed' AND moved_for_reask)
   ORDER BY job_id
   LIMIT $4`;

async function readCandidates(businessId: string, jobId: string | null, limit: number): Promise<CandidateRow[]> {
  const { rows } = await getPool().query<CandidateRow>(CANDIDATES_SQL, [businessId, jobId, REASK_REASON, limit]);
  return rows;
}

/**
 * Re-ask every qualifying command job of this business, once each. Each job on
 * its own: one that throws is in `errored` and found again next pass.
 */
export async function reaskFailedCommands(o: {
  businessId?: string;
  messenger?: BossMessenger;
  limit?: number;
}): Promise<ReaskResult> {
  const businessId = o.businessId ?? config.businessId;
  const result: ReaskResult = { reasked: [], sent: 0, notConnected: 0, sendFailed: 0, lockedOut: [], errored: [] };

  const candidates = await readCandidates(businessId, null, o.limit ?? 20);
  for (const candidate of candidates) {
    const oldJobId = candidate.job_id;
    const lockScope = `command-reask:${businessId}:${oldJobId}`;
    const client = await getPool().connect();
    let holdsLock = false;
    let broken = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockScope],
      );
      if (lock.rows[0]?.locked !== true) {
        result.lockedOut.push(oldJobId);
        continue;
      }
      holdsLock = true;

      // Re-read under the lock: another pass may have re-asked it already.
      const fresh = (await readCandidates(businessId, oldJobId, 1))[0];
      if (fresh === undefined) continue;

      const outcome = await reaskOne(fresh, businessId, o.messenger);
      if (outcome === null) continue;
      result.reasked.push(outcome.reasked);
      if (outcome.delivery === 'sent') result.sent += 1;
      if (outcome.delivery === 'not_connected') result.notConnected += 1;
      if (outcome.delivery === 'failed') result.sendFailed += 1;
    } catch (err) {
      result.errored.push({ jobId: oldJobId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (holdsLock) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope]);
        } catch {
          broken = true;
        }
      }
      // A session whose unlock failed may still hold the lock: destroy it
      // rather than hand it back to the pool (`run-due.ts` does the same).
      client.release(broken ? true : undefined);
    }
  }
  return result;
}

interface ReaskOneOutcome {
  reasked: ReaskResult['reasked'][number];
  delivery: 'sent' | 'not_connected' | 'failed' | 'dashboard';
}

async function reaskOne(
  candidate: CandidateRow,
  businessId: string,
  messenger: BossMessenger | undefined,
): Promise<ReaskOneOutcome | null> {
  const oldJobId = candidate.job_id;
  const chosen = ConfirmationOption.array()
    .parse(candidate.options)
    .find((option) => option.planHash === candidate.chosen_plan_hash);
  if (chosen === undefined) {
    throw new Error(`command re-ask: job ${oldJobId}'s chosen plan is not among its options`);
  }
  const instruction = await loadInstructionForJob(oldJobId, { businessId });
  if (instruction === null) throw new Error(`command re-ask: job ${oldJobId} has no instruction`);

  const rendered = renderConfirmationQuestion([chosen], { reask: candidate.uncertain });
  if ('refused' in rendered) {
    throw new Error(`command re-ask: job ${oldJobId}'s question cannot be rendered (${rendered.refused})`);
  }
  const active = await loadActiveCharter(businessId);
  if (active === null) throw new Error(`command re-ask: no active charter for business ${businessId}`);

  // The old job stops first, so nothing can run it again while the new one is
  // built. Locked and conditional: a job someone else moved on is not ours.
  if (JobPhase.parse(candidate.phase) === 'followup') {
    try {
      await transition(oldJobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: REASK_REASON,
        businessId,
        expectFrom: 'followup',
      });
    } catch (err) {
      if (err instanceof PhaseMovedError) return null;
      throw err;
    }
  }

  const job = await createJob({
    charterVersion: active.charter.charterVersion,
    provenance: 'boss',
    businessId,
    ...(candidate.title !== null ? { title: candidate.title } : {}),
  });

  let confirmed = false;
  try {
    await saveInstruction(
      { jobId: job.jobId, text: instruction.text, textOrigin: instruction.textOrigin },
      { businessId },
    );
    for (const to of ['understand', 'plan'] as const) {
      await transition(job.jobId, {
        to,
        actor: 'orchestrator',
        reason: `command: re-ask of ${oldJobId}`,
        businessId,
      });
    }
    const binding = await bindPlanToJob(job.jobId, chosen.plan, { businessId });
    if (binding.status !== 'stored' || binding.planHash !== chosen.planHash) {
      throw new Error(`command re-ask: job ${job.jobId} could not be bound to plan ${chosen.planHash}`);
    }
    try {
      await createConfirmation(
        {
          jobId: job.jobId,
          options: [chosen],
          presentedText: rendered.text,
          channel: candidate.channel,
          reaskOf: oldJobId,
        },
        { businessId },
      );
    } catch (err) {
      if ((err as { code?: unknown }).code === UNIQUE_VIOLATION) {
        throw new Error(`command re-ask: job ${oldJobId} was already re-asked`);
      }
      throw err;
    }
    confirmed = true;
  } finally {
    if (!confirmed) {
      // A job in `plan` with no confirmation is one nothing revisits.
      try {
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: 'command: re-ask could not be built',
          businessId,
        });
      } catch {
        // Best effort: the error that brought us here is the one to report.
      }
    }
  }

  if (candidate.whatsapp_message_id !== null) {
    await linkWhatsAppMessage(job.jobId, candidate.whatsapp_message_id, { businessId });
  }

  const reasked = { oldJobId, newJobId: job.jobId, uncertain: candidate.uncertain };
  if (candidate.channel !== 'whatsapp') return { reasked, delivery: 'dashboard' };
  if (messenger === undefined) return { reasked, delivery: 'not_connected' };
  const sent = await messenger.send({ text: rendered.text, jobId: job.jobId });
  return { reasked, delivery: sent.ok ? 'sent' : 'failed' };
}
