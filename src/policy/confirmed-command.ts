import type { ActionFacts } from '../domain/policy.js';
import { Plan } from '../domain/plan.js';
import { canonicalHash } from '../util/canonical.js';
import { MAX_SEND_AHEAD_MS, readSendAt } from '../util/send-at.js';
import type { GateContext } from './engine.js';

/**
 * Whether the call in front of the gate is a step of a boss command the owner
 * has CONFIRMED — the one case in which the gate lets an action past stages
 * 5–9 and every approval requirement (spec 2026-10-28 §4.5, §10.2, §10.7,
 * §10.12; owner ruling 28/10, §9 item 1: "the command overrides everything").
 *
 * Once the owner has read the plan's every byte in the confirmation question
 * and said yes, those bytes run under ANY freedom-level dial, `off` included,
 * and past the charter's `forbidden` rules, do-not-contact, quiet hours, the
 * budget ceilings and `needsApproval` as a whole. Those are all brakes on the
 * ASSISTANT; the owner said explicitly that his command is not braked by them.
 *
 * Built in the pattern of `approvedReplyCovers` (`approved-reply.ts`). Every
 * condition is positive; each one is required, and all but the first two are
 * one SQL statement:
 *
 *   - `ctx.approval` is ABSENT. A call carrying an approval is the approval
 *     path's, and it takes the normal route; the two never mix;
 *   - `ctx.jobId` and `ctx.stepId` are both set. `stepId` is set by
 *     `executeStep` and by nothing else — the SDK gate-hook never sets it, so
 *     an agent running directly through the SDK can never be exempt. A step
 *     is the unit the owner confirmed, and a call the gate cannot tie to one
 *     is not something he confirmed;
 *   - the job is in this business and its stored `provenance` is `boss` —
 *     read from the `jobs` row, never from `ctx.provenance`, which is the
 *     caller's claim;
 *   - a `boss_instructions` row exists for the job: it was opened by the
 *     instruction door, not by any other path that happens to stamp `boss`;
 *   - its `instruction_confirmations` row is `confirmed`, and was decided
 *     within the last 24 hours (§10.7) — a "yes" from last week does not
 *     carry a transfer the owner may no longer want. One extension, and only
 *     one (task 13, H15): a matched `wa.send_message` step (that tool only)
 *     whose OWN input carries a parsable
 *     ISO `sendAt` (a scheduled WhatsApp) is covered until `sendAt + 24h`,
 *     when the "yes" was given before `sendAt` and no more than 30 days
 *     before it, AND the job's `charter_version` still equals the active
 *     charter's — a charter re-signed in between ends the "yes". The bytes
 *     check below still applies, and `sendAt` is part of those bytes, so a
 *     plan whose time changed is never carried by the old "yes". The clock
 *     is the database's, as it was when the window lived in SQL;
 *   - `chosen_plan_hash` equals the hash of the plan bound to the job
 *     (`job_plans`): the plan about to run is the plan he chose;
 *   - that plan has a step with id `ctx.stepId`, whose `agent` is the agent
 *     making this call (`ctx.agent`), whose `toolName` is the tool the gate
 *     is judging and whose `canonicalHash(input)` equals
 *     `facts.inputHash` — the same `canonicalHash` `buildFacts` uses — so the
 *     bytes about to run are the bytes he was shown. Editing a confirmed
 *     command is therefore impossible by construction (§4.5);
 *   - the job has NO `job_step_results` row with status `unknown`, on any
 *     step. Such a row means a call was dispatched and nothing authoritative
 *     came back: it may already have happened. The same lesson as
 *     `learnedReplyCovers` — after a timeout, never again without asking.
 *
 * It is a read and only a read, returning the step id and plan hash the gate
 * then CLAIMS (`claimConfirmedStep`) after recording intent. The claim, not
 * this read, is what makes each step run at most once (§10.2).
 *
 * What it never bypasses, named positively: the kill switch (stage 1), a
 * readable current charter (stage 2), the capability allowlist and
 * `UNOWNED_TOOLS` (stage 3) all run before this is consulted;
 * `amount_unreadable` still refuses inside the exemption, because an amount
 * that could not be read was never shown in the question, so it was never
 * confirmed; and the `intent_to_act` row is still written, ending in
 * `CONFIRMED_COMMAND_EXEMPTION_MARKER`.
 */
/** Appended to the `intent_to_act` audit reason when the exemption carried the call. */
export const CONFIRMED_COMMAND_EXEMPTION_MARKER = 'confirmed_command_exemption';

export async function confirmedCommandCovers(
  facts: ActionFacts,
  ctx: GateContext,
): Promise<{ stepId: string; planHash: string } | null> {
  if (ctx.approval !== undefined) return null;
  if (typeof ctx.jobId !== 'string') return null;
  if (typeof ctx.stepId !== 'string') return null;

  const db = ctx.db;
  const businessId = db.businessId;
  const { rows } = await db.query<{
    plan_hash: string;
    plan: unknown;
    decided_at: Date | null;
    db_now: Date;
    job_charter_version: string;
    active_charter_version: string | null;
  }>(
    `SELECT p.plan_hash, p.plan, c.decided_at, now() AS db_now,
            j.charter_version AS job_charter_version,
            (SELECT a.charter_version FROM charter_active a WHERE a.business_id = $1) AS active_charter_version
       FROM jobs j
       JOIN boss_instructions b
         ON b.job_id = j.job_id AND b.business_id = $1
       JOIN instruction_confirmations c
         ON c.job_id = j.job_id AND c.business_id = $1
       JOIN job_plans p
         ON p.job_id = j.job_id AND p.business_id = $1
      WHERE j.job_id = $2
        AND j.business_id = $1
        AND j.provenance = 'boss'
        AND c.state = 'confirmed'
        AND c.chosen_plan_hash = p.plan_hash
        AND NOT EXISTS (
          SELECT 1 FROM job_step_results r
           WHERE r.business_id = $1 AND r.job_id = $2 AND r.status = 'unknown'
        )`,
    [businessId, ctx.jobId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  // A stored plan that no longer parses is not a plan the owner confirmed.
  const parsed = Plan.safeParse(row.plan);
  if (!parsed.success) return null;

  const stepId = ctx.stepId;
  const step = parsed.data.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return null;
  if (step.agent !== ctx.agent) return null;
  if (step.toolName !== facts.toolName) return null;
  if (canonicalHash(step.input) !== facts.inputHash) return null;

  if (!withinConfirmationWindow(row, step.toolName, step.input, ctx.bundle.charterVersion)) return null;

  return { stepId: step.id, planHash: row.plan_hash };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window a "yes" carries, every arm positive and fail-closed: a missing
 * `decided_at`, an unparsable `sendAt` or an unknown active charter all mean
 * "not covered".
 */
function withinConfirmationWindow(
  row: { decided_at: Date | null; db_now: Date; job_charter_version: string; active_charter_version: string | null },
  stepToolName: string,
  stepInput: Record<string, unknown>,
  bundleCharterVersion: string,
): boolean {
  if (row.decided_at === null) return false;
  const decided = row.decided_at.getTime();
  const now = row.db_now.getTime();
  if (!Number.isFinite(decided) || !Number.isFinite(now)) return false;
  if (now - decided < DAY_MS) return true;

  // The extension is a scheduled WhatsApp's and nothing else's: a `sendAt`
  // on any other tool is an ordinary payload field and buys no time.
  if (stepToolName !== 'wa.send_message') return false;
  const sendAt = readSendAt(stepInput);
  if (sendAt === null) return false;
  const at = sendAt.getTime();
  if (!(decided < at)) return false;
  if (at - decided > MAX_SEND_AHEAD_MS) return false;
  if (!(now < at + DAY_MS)) return false;
  return (
    row.active_charter_version !== null &&
    row.job_charter_version === row.active_charter_version &&
    row.job_charter_version === bundleCharterVersion
  );
}
