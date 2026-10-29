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
  toConfirmation,
  type ConfirmationRow,
  type InstructionConfirmation,
} from '../governance/instruction-confirmations.js';
import { stripBidiControls } from '../util/bidi.js';
import { loadJob, transition } from './jobs.js';
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

/** The shortest token a typed name may consist of: one letter is never a name. */
const MIN_NAME_TOKEN_CHARS = 2;

/** Same tokens, any order, same count — "דנה חיוט" and "חיוט דנה" are the full name. */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((token, i) => token === right[i]);
}

/**
 * Whether the typed tokens name this option: its FULL name, or its surname
 * (the last token of `contactName`) alone. A first name alone never selects —
 * it is exactly what two candidates share, and selecting on it would turn the
 * ambiguity the question exists for back into a guess.
 */
function namesOption(typed: readonly string[], option: ConfirmationOption): boolean {
  if (option.contactName === undefined) return false;
  const name = nameTokens(option.contactName);
  const surname = name[name.length - 1];
  if (sameTokens(typed, name)) return true;
  return typed.length === 1 && name.length > 1 && typed[0] === surname;
}

/**
 * The owner's answer to a confirmation question with these options.
 *
 * In order:
 *   - a confirm word: one option → that one; several → `unclear`;
 *   - a cancel word → `cancel`;
 *   - a canonical integer (`/^[1-9]\d*$/`, so "01" is not one): 1..N → that
 *     option, out of range → `unclear`;
 *   - a name: every token at least two characters, and the message is one
 *     option's full name or its surname alone. Exactly one option → that
 *     one; two → `unclear`. Tokens that all belong to some option's name but
 *     name none of them (a first name alone) → `unclear`: it is an attempt
 *     to answer, not a new instruction;
 *   - anything else → `none`.
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
    const picked = /^[1-9]\d*$/.test(clean) ? options[Number(clean) - 1] : undefined;
    return picked !== undefined ? { kind: 'confirm', planHash: picked.planHash } : { kind: 'unclear' };
  }

  const typed = nameTokens(clean);
  if (typed.length === 0 || typed.some((token) => token.length < MIN_NAME_TOKEN_CHARS)) {
    return { kind: 'none' };
  }
  const matching = options.filter((option) => namesOption(typed, option));
  const match = matching[0];
  if (matching.length === 1 && match !== undefined) return { kind: 'confirm', planHash: match.planHash };
  if (matching.length > 1) return { kind: 'unclear' };

  const partOfAName = typed.every((token) =>
    options.some(
      (option) => option.contactName !== undefined && nameTokens(option.contactName).includes(token),
    ),
  );
  return partOfAName ? { kind: 'unclear' } : { kind: 'none' };
}

/**
 * The confirmation questions a message arriving at `inboundAt` can answer.
 * Read-only. Every condition is positive, and every one is in the SQL — a
 * second check in code would hide the SQL one from its tests:
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
    `SELECT c.job_id, c.options, c.presented_text, c.presented_at, c.channel, c.state,
            c.chosen_plan_hash, c.decided_at, c.decided_by, c.reask_of
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
  return rows.map(toConfirmation);
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
 *   - `unclear` / `none`: nothing changes.
 *   - The job must still be parked in `plan`; otherwise `already_decided`,
 *     before anything is flipped.
 *   - `confirm`: `confirmChoice` flips the row (false → `already_decided`).
 *     With several options the chosen plan is bound now (`bindChosenPlan`);
 *     with one it was bound before the question, and the bound hash must
 *     equal the chosen one. Then `plan → execute`.
 *   - `cancel`: `cancelConfirmation` (false → `already_decided`), then
 *     `plan → closed` — closed, not failed: the owner said no.
 *
 * **The flip commits first, so whatever fails after it is left to
 * `settleDecidedConfirmations`**, which the scheduler runs every pass: a row
 * that is no longer pending on a job still in `plan` is moved on from the
 * record, never left parked. A throw here therefore means "decided, not yet
 * applied". One case is read back rather than thrown: when the job is already
 * where this call was taking it (the sweep, or another channel, got there
 * first), the answer did take effect.
 */
export async function applyConfirmation(
  jobId: string,
  reading: ConfirmReading,
  by: string,
  o: { businessId: string },
): Promise<ConfirmOutcome> {
  if (reading.kind !== 'confirm' && reading.kind !== 'cancel') return 'unclear';

  const job = await loadJob(jobId, { businessId: o.businessId });
  if (job?.phase !== 'plan') return 'already_decided';

  if (reading.kind === 'cancel') {
    const cancelled = await cancelConfirmation(jobId, by, { businessId: o.businessId });
    if (!cancelled) return 'already_decided';
    try {
      await moveTo(jobId, 'closed', 'command: cancelled', 'human', o.businessId);
    } catch (err) {
      if (await phaseIs(jobId, 'closed', o.businessId)) return 'cancelled';
      throw err;
    }
    return 'cancelled';
  }

  const confirmed = await confirmChoice(jobId, reading.planHash, by, { businessId: o.businessId });
  if (!confirmed) return 'already_decided';

  try {
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
    await moveTo(jobId, 'execute', 'command: confirmed', 'human', o.businessId);
  } catch (err) {
    if (await phaseIs(jobId, 'execute', o.businessId)) return 'executing';
    throw err;
  }
  return 'executing';
}

async function moveTo(
  jobId: string,
  to: 'execute' | 'closed' | 'failed',
  reason: string,
  actor: 'human' | 'system',
  businessId: string,
): Promise<void> {
  await transition(jobId, { to, actor, reason, businessId });
}

async function phaseIs(jobId: string, phase: string, businessId: string): Promise<boolean> {
  return (await loadJob(jobId, { businessId }))?.phase === phase;
}

export interface SettleResult {
  settled: Array<{ jobId: string; to: 'execute' | 'closed' | 'failed' }>;
  errored: Array<{ jobId: string; error: string }>;
}

/** The reason a decided confirmation that cannot be applied fails its job with. */
export const UNAPPLIABLE_REASON = 'command: could not apply confirmation';

/**
 * Move on every job still parked in `plan` whose confirmation is no longer
 * pending — the answer was recorded but not applied: `applyConfirmation`
 * threw after its flip committed, a transient transition error, or an expiry
 * whose close failed. Without this the job sits in `plan` forever, because
 * every other reader takes `pending` rows only.
 *
 *   - `cancelled` / `expired` → `plan → closed`;
 *   - `confirmed`, and the bound plan's hash equals `chosen_plan_hash` →
 *     `plan → execute`;
 *   - `confirmed`, nothing bound, several options → bind the chosen plan
 *     (`bindChosenPlan`, with its re-check), then `execute`;
 *   - anything else — a hash mismatch, a single option with nothing bound, a
 *     bind that refuses — → `plan → failed` (`UNAPPLIABLE_REASON`). Never
 *     `execute` on a plan the owner did not pick.
 *
 * Only jobs born at the instruction door (a `boss_instructions` row). Each job
 * on its own: one that throws is reported in `errored`, the rest go on, and
 * it is found again next pass.
 */
export async function settleDecidedConfirmations(o: {
  businessId: string;
  limit?: number;
}): Promise<SettleResult> {
  const { rows } = await getPool().query<ConfirmationRow>(
    `SELECT c.job_id, c.options, c.presented_text, c.presented_at, c.channel, c.state,
            c.chosen_plan_hash, c.decided_at, c.decided_by, c.reask_of
       FROM instruction_confirmations c
       JOIN jobs j
         ON j.business_id = c.business_id AND j.job_id = c.job_id AND j.phase = 'plan'
      WHERE c.business_id = $1
        AND c.state <> 'pending'
        AND EXISTS (
          SELECT 1 FROM boss_instructions b
           WHERE b.business_id = c.business_id AND b.job_id = c.job_id
        )
      ORDER BY c.decided_at, c.job_id
      LIMIT $2`,
    [o.businessId, o.limit ?? 50],
  );

  const result: SettleResult = { settled: [], errored: [] };
  for (const row of rows) {
    const jobId = row.job_id;
    try {
      const to = await settleOne(toConfirmation(row), o.businessId);
      result.settled.push({ jobId, to });
    } catch (err) {
      result.errored.push({ jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function settleOne(
  confirmation: InstructionConfirmation,
  businessId: string,
): Promise<'execute' | 'closed' | 'failed'> {
  const { jobId } = confirmation;
  if (confirmation.state === 'cancelled') {
    await moveTo(jobId, 'closed', 'command: cancelled', 'system', businessId);
    return 'closed';
  }
  if (confirmation.state === 'expired') {
    await moveTo(jobId, 'closed', 'command: confirmation expired', 'system', businessId);
    return 'closed';
  }

  const chosen = confirmation.state === 'confirmed' ? confirmation.chosenPlanHash : null;
  if (chosen !== null) {
    const stored = await loadStoredPlan(jobId, { businessId });
    if (stored?.planHash === chosen) {
      await moveTo(jobId, 'execute', 'command: confirmed', 'system', businessId);
      return 'execute';
    }
    if (stored === null && confirmation.options.length > 1) {
      let bound = true;
      try {
        await bindChosenPlan(jobId, chosen, { businessId });
      } catch {
        bound = false;
      }
      if (bound) {
        await moveTo(jobId, 'execute', 'command: confirmed', 'system', businessId);
        return 'execute';
      }
    }
  }
  await moveTo(jobId, 'failed', UNAPPLIABLE_REASON, 'system', businessId);
  return 'failed';
}
