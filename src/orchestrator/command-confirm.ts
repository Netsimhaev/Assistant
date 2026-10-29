/**
 * Reading the owner's answer to a boss-command confirmation question, and
 * applying it (spec 2026-10-28, §4.3, §10.1, §10.11).
 *
 * A held command waits in phase `plan` with a pending
 * `instruction_confirmations` row. The owner answers in one of three ways —
 * a confirm word, a pick (number or name), or a cancel — and nothing else is
 * read as an answer: `none` means "not an answer to this question", so the
 * caller treats the message as a new instruction and the question stays open.
 *
 * **Fixed word lists, never a model**, for the same reason `closure-command.ts`
 * and `forget-command.ts` give: whether the owner just authorised an action
 * must be an inspectable question. Whole messages only, after
 * `stripBidiControls` and `trim`. `CONFIRM_WORDS` is disjoint from the
 * cancel words, `FORGET_VERBS` and the mail-card words "שלח"/"שלחי"; the test
 * intersects the exported lists.
 *
 * **A confirm word never picks between several options.** "כן" does not say
 * which; with two options it is `unclear`, never the first one.
 *
 * **Names are matched against the stored `contactName`, never parsed out of
 * the label** — the label also carries the company and the address. A pick
 * by name must belong to exactly one option; a name two options share is
 * `unclear`.
 *
 * **Applying is gated by the store, not by this module.** `confirmChoice` and
 * `cancelConfirmation` are single `UPDATE ... WHERE state = 'pending'`
 * statements (freshness-gated, for the confirm), so a second answer — or two
 * channels answering at once — gets `already_decided` and moves nothing.
 */
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { CLOSURE_VERB_WORDS } from '../governance/closure-command.js';
import {
  ConfirmationOption,
  cancelConfirmation,
  confirmChoice,
  loadConfirmation,
  type InstructionConfirmation,
} from '../governance/instruction-confirmations.js';
import { stripBidiControls } from '../util/bidi.js';
import { transition } from './jobs.js';
import { bindPlanToJob, loadStoredPlan } from './plan-store.js';

/** Whole-message words that confirm (spec §4.3). */
export const CONFIRM_WORDS: readonly string[] = [
  'כן',
  'אשר',
  'אשרי',
  'מאשר',
  'מאשרת',
  'בצע',
  'בצעי',
  'תבצעי',
];

/**
 * Whole-message words that cancel: "לא", and every closure verb taken from
 * the exported list rather than re-typed. "לא" cancels only here, on a
 * confirmation question (§10.11).
 */
export const CANCEL_WORDS: readonly string[] = ['לא', ...CLOSURE_VERB_WORDS];

export type ConfirmReading =
  | { kind: 'confirm'; planHash: string }
  | { kind: 'cancel' }
  | { kind: 'unclear' }
  | { kind: 'none' };

export type ConfirmOutcome = 'executing' | 'cancelled' | 'already_decided' | 'unclear';

/** Whitespace-split tokens, with trailing punctuation stripped, case-folded for Latin names. */
function nameTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/[)'"»,.;:!?]+$/, '').toLocaleLowerCase())
    .filter((token) => token !== '');
}

/**
 * The owner's answer to a confirmation question with these options.
 *
 * In order: a confirm word (one option → that one; several → `unclear`); a
 * cancel word; an integer (1..N → that option, anything else → `unclear`);
 * a name — every token of the message is a token of exactly one option's
 * `contactName` (so the full name and a surname both work). Two options
 * matching → `unclear`; nothing matching → `none`.
 */
export function readConfirmation(text: string, options: readonly ConfirmationOption[]): ConfirmReading {
  const clean = stripBidiControls(text).trim();
  if (clean === '') return { kind: 'none' };

  if (CONFIRM_WORDS.includes(clean)) {
    const only = options[0];
    return options.length === 1 && only !== undefined
      ? { kind: 'confirm', planHash: only.planHash }
      : { kind: 'unclear' };
  }

  if (CANCEL_WORDS.includes(clean)) return { kind: 'cancel' };

  if (/^\d+$/.test(clean)) {
    const picked = options[Number(clean) - 1];
    return picked !== undefined ? { kind: 'confirm', planHash: picked.planHash } : { kind: 'unclear' };
  }

  const typed = nameTokens(clean);
  const matching = options.filter((option) => {
    if (option.contactName === undefined) return false;
    const name = new Set(nameTokens(option.contactName));
    return typed.every((token) => name.has(token));
  });
  const match = matching[0];
  if (matching.length === 1 && match !== undefined) return { kind: 'confirm', planHash: match.planHash };
  if (matching.length > 1) return { kind: 'unclear' };
  return { kind: 'none' };
}

interface ConfirmationRow {
  job_id: string;
}

/**
 * The confirmation questions a message arriving at `inboundAt` can answer.
 * Read-only. Every condition is positive:
 *
 *   - pending, on this channel, in this business;
 *   - presented strictly before the message (`inboundAt === null` — a
 *     timestamp nobody could read — answers nothing; a "כן" typed for an
 *     earlier question and delivered late must not confirm a later one);
 *   - presented inside the question window, on the database clock that wrote
 *     `presented_at` (`<= 0` means nothing is open — `openMailCards`' reading);
 *   - the job is still parked in `plan` and was born at the instruction door
 *     (it has a `boss_instructions` row).
 */
export async function openConfirmations(o: {
  businessId: string;
  channel: 'whatsapp';
  inboundAt: Date | null;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<InstructionConfirmation[]> {
  if (o.inboundAt === null || Number.isNaN(o.inboundAt.getTime())) return [];
  const windowMinutes = o.windowMinutes ?? config.whatsappQuestionWindowMinutes;
  if (windowMinutes <= 0) return [];
  const db = o.db ?? getPool();

  const { rows } = await db.query<ConfirmationRow>(
    `SELECT c.job_id
       FROM instruction_confirmations c
       JOIN jobs j
         ON j.business_id = c.business_id AND j.job_id = c.job_id AND j.phase = 'plan'
      WHERE c.business_id = $1
        AND c.channel = $2
        AND c.state = 'pending'
        AND c.presented_at < $3
        AND c.presented_at > now() - make_interval(mins => $4)
        AND EXISTS (
          SELECT 1 FROM boss_instructions b
           WHERE b.business_id = c.business_id AND b.job_id = c.job_id
        )
      ORDER BY c.presented_at`,
    [o.businessId, o.channel, o.inboundAt, windowMinutes],
  );

  const open: InstructionConfirmation[] = [];
  for (const row of rows) {
    const loaded = await loadConfirmation(row.job_id, { businessId: o.businessId, db });
    if (loaded !== null && loaded.state === 'pending') open.push(loaded);
  }
  return open;
}

/**
 * Bind the confirmed plan to a job that was parked with several options and
 * nothing bound. One transaction: the job row and the confirmation row are
 * locked and re-read — the row must still exist, be `confirmed`, and carry
 * exactly this hash (an erasure landing between `confirmChoice` and here
 * deletes the row, and a bind after it would re-create content about a
 * person the owner just erased) — then `bindPlanToJob` runs on the same
 * transaction, and the bound hash must equal the chosen one.
 *
 * Exported for the test that proves the re-check; `applyConfirmation` is the
 * only production caller.
 */
export async function bindChosenPlan(
  jobId: string,
  planHash: string,
  o: { businessId: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const job = await tx.query<{ phase: string }>(
      'SELECT phase FROM jobs WHERE business_id = $1 AND job_id = $2 FOR UPDATE',
      [o.businessId, jobId],
    );
    if (job.rows[0]?.phase !== 'plan') {
      throw new Error(`command confirm: job ${jobId} is no longer parked in plan`);
    }
    const { rows } = await tx.query<{ options: unknown }>(
      `SELECT options FROM instruction_confirmations
        WHERE business_id = $1 AND job_id = $2
          AND state = 'confirmed' AND chosen_plan_hash = $3
        FOR UPDATE`,
      [o.businessId, jobId, planHash],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`command confirm: job ${jobId} is no longer confirmed with plan ${planHash}`);
    }
    const chosen = ConfirmationOption.array()
      .parse(row.options)
      .find((option) => option.planHash === planHash);
    if (chosen === undefined) {
      throw new Error(`command confirm: plan ${planHash} is not among job ${jobId}'s options`);
    }
    const binding = await bindPlanToJob(jobId, chosen.plan, { businessId: o.businessId, tx });
    if (binding.status === 'conflict' || binding.planHash !== planHash) {
      throw new Error(
        `command confirm: job ${jobId} could not be bound to the chosen plan ${planHash} (${binding.status})`,
      );
    }
  });
}

/**
 * Apply the owner's answer.
 *
 *   - `confirm`: `confirmChoice` flips the row (false → `already_decided`).
 *     With several options the chosen plan is bound now (`bindChosenPlan`);
 *     with one it was bound before the question, and the bound hash must
 *     equal the chosen one. Then `plan → execute`.
 *   - `cancel`: `cancelConfirmation` (false → `already_decided`), then
 *     `plan → closed` — closed, not failed: the owner said no.
 *   - `unclear` / `none`: nothing changes.
 *
 * A bound hash that is not the chosen one throws and leaves the job in
 * `plan`: running a plan the owner did not pick is the one outcome this must
 * never produce, and a job left parked runs nothing.
 */
export async function applyConfirmation(
  jobId: string,
  reading: ConfirmReading,
  by: string,
  o: { businessId: string },
): Promise<ConfirmOutcome> {
  if (reading.kind === 'cancel') {
    const cancelled = await cancelConfirmation(jobId, by, { businessId: o.businessId });
    if (!cancelled) return 'already_decided';
    await transition(jobId, {
      to: 'closed',
      actor: 'human',
      reason: 'command: cancelled',
      businessId: o.businessId,
    });
    return 'cancelled';
  }

  if (reading.kind !== 'confirm') return 'unclear';

  const confirmed = await confirmChoice(jobId, reading.planHash, by, { businessId: o.businessId });
  if (!confirmed) return 'already_decided';

  const confirmation = await loadConfirmation(jobId, { businessId: o.businessId });
  if (confirmation === null) {
    throw new Error(`command confirm: job ${jobId} lost its confirmation row`);
  }
  if (confirmation.options.length > 1) {
    await bindChosenPlan(jobId, reading.planHash, o);
  } else {
    const stored = await loadStoredPlan(jobId, { businessId: o.businessId });
    if (stored?.planHash !== reading.planHash) {
      throw new Error(
        `command confirm: job ${jobId} is bound to ${stored?.planHash ?? 'nothing'}, not the confirmed plan ${reading.planHash}`,
      );
    }
  }

  await transition(jobId, {
    to: 'execute',
    actor: 'human',
    reason: 'command: confirmed',
    businessId: o.businessId,
  });
  return 'executing';
}
