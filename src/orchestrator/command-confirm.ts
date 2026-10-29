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
 * must be an inspectable question. Compared after one normalisation shared
 * with names — `stripBidiControls`, `trim`, trailing punctuation — and the
 * first token decides: a cancel word cancels whatever follows it. `CONFIRM_WORDS` is disjoint from the
 * cancel words, `FORGET_VERBS` and the mail-card words "שלח"/"שלחי"; the test
 * intersects the exported lists.
 *
 * **A confirm word never picks between several options.** "כן" does not say
 * which; with two options it is `unclear`, never the first one.
 *
 * **Names are matched against the stored `contactName`, never parsed out of
 * the label** — the label also carries the company and the address. A pick
 * by name must belong to exactly one option; a name two options share is
 * `unclear`. A reply word (confirm, cancel, `REPLY_STOPLIST`) is never a name,
 * and an unverified option is picked only by number or full name.
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
import { JobPhase } from '../domain/job.js';
import { stripBidiControls } from '../util/bidi.js';
import { PhaseMovedError, loadJob, transition } from './jobs.js';
import { bindPlanToJob, loadStoredPlan } from './plan-store.js';

/**
 * Words that confirm (spec §4.3) — only as the whole message, and only the
 * first token is ever compared (see `readConfirmation`).
 */
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
 * Words that cancel when they OPEN the reply: "לא", every closure verb taken
 * from the exported list rather than re-typed, and the plain cancel and stop
 * verbs an owner types to refuse. "לא" and the cancel verbs cancel only here,
 * on a confirmation question (§10.11) — `closure-command.ts` excludes
 * "תבטלי" from its own list for its own reasons, which do not apply to a
 * question whose only other answers are a yes or a pick.
 *
 * Disjoint from `FORGET_VERBS` and the mail-card words (a test intersects the
 * exported lists).
 */
export const CANCEL_WORDS: readonly string[] = [
  'לא',
  ...CLOSURE_VERB_WORDS,
  'בטל',
  'בטלי',
  'תבטלי',
  'ביטול',
  'עצור',
  'עצרי',
  'תעצרי',
];

export type ConfirmReading =
  | { kind: 'confirm'; planHash: string }
  | { kind: 'cancel' }
  | { kind: 'unclear' }
  | { kind: 'none' };

export type ConfirmOutcome = 'executing' | 'cancelled' | 'already_decided' | 'unclear';

/**
 * Ordinary replies that are never a name, even when a contact happens to
 * carry one ("דנה טוב"): a reply the owner types to mean "fine" or "thanks"
 * must not pick a person. Disjoint from `CONFIRM_WORDS` (a test intersects
 * them) — a confirm word has its own, stricter handling.
 */
export const REPLY_STOPLIST: readonly string[] = ['תודה', 'טוב', 'אוקי', 'בסדר', 'סבבה', 'יופי'];

/**
 * One token, normalised the same way everywhere this module compares one: the
 * trailing punctuation a reply carries ("לא.", "כן!", "חיוט,") is stripped,
 * and Latin is case-folded. Confirm and cancel words go through exactly this,
 * so "לא!" can never fall through to name matching as an unknown word.
 */
function normaliseToken(token: string): string {
  return token.replace(/[)'"»,.;:!?…]+$/, '').toLocaleLowerCase();
}

/** Bidi-stripped, trimmed, whitespace-split, normalised, empties dropped. */
function tokensOf(value: string): string[] {
  return stripBidiControls(value)
    .trim()
    .split(/\s+/)
    .map(normaliseToken)
    .filter((token) => token !== '');
}

/** A token that is a reply word, never a name: confirm, cancel, or the stoplist. */
function isReplyWord(token: string): boolean {
  return CONFIRM_WORDS.includes(token) || CANCEL_WORDS.includes(token) || REPLY_STOPLIST.includes(token);
}

/**
 * True when a contact name carries a cancel word as one of its tokens
 * ("דנה בטל"). `planPerCandidate` leaves such a candidate out of the options
 * altogether: no real person's name is a cancel word, and a memory row that
 * says so was planted so that the owner's own refusal would read as a pick.
 * Confirm words and the stoplist are NOT checked here — "אשר" and "טוב" are
 * real names — and the reader already refuses them as name picks.
 */
export function nameCarriesCancelWord(name: string): boolean {
  return tokensOf(name).some((token) => CANCEL_WORDS.includes(token));
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
 * Whether the typed tokens name this option: its FULL name, or — only for an
 * option whose address the owner vouched for (`contactSource !== 'unverified'`)
 * — its surname (the last token) alone. A first name alone never selects. An
 * unverified option is picked only by its number or its full name: a contact
 * learned from a document is a stranger's words, and a surname is the
 * shortest thing he could choose to collide with a reply.
 *
 * A one-token name has no separate surname: its one token IS the full name,
 * so the surname path adds nothing there, and a one-word "דנה" shared with a
 * "דנה לוי" is kept from picking by the candidate count in
 * `readConfirmation` (two options contain the token → `unclear`), not here.
 */
function namesOption(typed: readonly string[], option: ConfirmationOption): boolean {
  if (option.contactName === undefined) return false;
  const name = tokensOf(option.contactName);
  if (sameTokens(typed, name)) return true;
  if (option.contactSource === 'unverified') return false;
  return typed.length === 1 && typed[0] === name[name.length - 1];
}

/**
 * The owner's answer to a confirmation question with these options.
 *
 * The message is bidi-stripped, trimmed, split and normalised once
 * (`tokensOf`), and **the first token decides before anything else**:
 *
 *   - a cancel word → `cancel`, whatever follows ("לא, תודה", "בטל!");
 *   - a confirm word → with nothing after it, one option → that one and
 *     several → `unclear`; with anything after it → `unclear`. "כן" never
 *     picks between options, and "כן תשלחי גם לרונית" is not a confirmation;
 *
 * neither ever reaches number or name matching. Then:
 *
 *   - a single canonical integer (`/^[1-9]\d*$/`, so "01" is not one): 1..N →
 *     that option, out of range → `unclear`;
 *   - a name: every token at least two characters and none a reply word
 *     (confirm, cancel, `REPLY_STOPLIST`); the options whose names contain
 *     every typed token are the candidates, and only when there is exactly
 *     one, and the message is its full name or (see `namesOption`) its
 *     surname, is it picked. Several candidates → `unclear` ("דנה" when one
 *     option is "דנה" and another "דנה לוי"). Tokens that belong to a name
 *     but pick nothing → `unclear`: an attempt to answer, not an instruction;
 *   - anything else → `none`.
 *
 * Why the order: a hostile document can plant a contact named "דנה בטל" —
 * read by surname, the owner's "בטל" would have confirmed the very option he
 * was refusing. A reply word is read as a reply first, and never as a name.
 */
export function readConfirmation(text: string, options: readonly ConfirmationOption[]): ConfirmReading {
  const tokens = tokensOf(text);
  const first = tokens[0];
  if (first === undefined) return { kind: 'none' };

  if (CANCEL_WORDS.includes(first)) return { kind: 'cancel' };
  if (CONFIRM_WORDS.includes(first)) {
    const only = options[0];
    return tokens.length === 1 && options.length === 1 && only !== undefined
      ? { kind: 'confirm', planHash: only.planHash }
      : { kind: 'unclear' };
  }

  if (tokens.length === 1 && /^\d+$/.test(first)) {
    const picked = /^[1-9]\d*$/.test(first) ? options[Number(first) - 1] : undefined;
    return picked !== undefined ? { kind: 'confirm', planHash: picked.planHash } : { kind: 'unclear' };
  }

  const partOfAName = (option: ConfirmationOption): boolean =>
    option.contactName !== undefined &&
    tokens.every((token) => tokensOf(option.contactName ?? '').includes(token));
  const candidates = options.filter(partOfAName);

  if (tokens.some((token) => token.length < MIN_NAME_TOKEN_CHARS || isReplyWord(token))) {
    return candidates.length > 0 ? { kind: 'unclear' } : { kind: 'none' };
  }
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined && namesOption(tokens, only)) {
    return { kind: 'confirm', planHash: only.planHash };
  }
  return candidates.length > 0 ? { kind: 'unclear' } : { kind: 'none' };
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
 * The confirmation questions the dashboard can answer: pending, inside the
 * window, the job still parked in `plan` and born at the instruction door —
 * on EITHER channel. No strict-after check: there is no inbound message to
 * date, and a question presented on WhatsApp must be answerable here,
 * because the collision refusal sends the owner here. Read-only;
 * `confirmChoice` still enforces the window when the answer lands.
 */
export async function dashboardConfirmations(o: {
  businessId: string;
  windowMinutes?: number;
  db?: Queryable;
}): Promise<InstructionConfirmation[]> {
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
        AND c.state = 'pending'
        AND c.presented_at > now() - make_interval(mins => $2)
        AND EXISTS (
          SELECT 1 FROM boss_instructions b
           WHERE b.business_id = c.business_id AND b.job_id = c.job_id
        )
      ORDER BY c.presented_at DESC`,
    [o.businessId, windowMinutes],
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
    const phase = job.rows[0]?.phase;
    if (phase === undefined) throw new Error(`command confirm: unknown job ${jobId}`);
    if (phase !== 'plan') throw new PhaseMovedError(jobId, 'plan', JobPhase.parse(phase));
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

/**
 * Every move this module makes is out of `plan`, and only out of `plan`:
 * `expectFrom` makes the phase check and the move one locked step, so a
 * decision taken on an earlier read can never move a job someone else
 * already moved on (`PhaseMovedError` instead).
 */
async function moveTo(
  jobId: string,
  to: 'execute' | 'closed' | 'failed',
  reason: string,
  actor: 'human' | 'system',
  businessId: string,
): Promise<void> {
  await transition(jobId, { to, actor, reason, businessId, expectFrom: 'plan' });
}

async function phaseIs(jobId: string, phase: string, businessId: string): Promise<boolean> {
  return (await loadJob(jobId, { businessId }))?.phase === phase;
}

export interface SettleResult {
  settled: Array<{ jobId: string; to: 'execute' | 'closed' | 'failed' }>;
  /**
   * Jobs that left `plan` between the sweep's read and its move — settled by
   * someone else (the owner's own `applyConfirmation`, another scheduler).
   * Not a failure: nothing is moved and nothing is logged as an error.
   */
  skipped: string[];
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
 *
 * **Every move is conditional on the job still being in `plan`**, checked under
 * the job's lock in the move's own transaction (`transition`'s `expectFrom`).
 * The decision is taken on an earlier read, and the owner's dashboard is
 * another process: without the guard, a sweep that read "confirmed, nothing
 * bound" while `applyConfirmation` bound and moved the job to `execute` would
 * see its own bind refused and fail a job the owner had just confirmed
 * (`execute → failed` is legal). A job that moved on is `skipped`.
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

  const result: SettleResult = { settled: [], skipped: [], errored: [] };
  for (const row of rows) {
    const jobId = row.job_id;
    try {
      const to = await settleOne(toConfirmation(row), o.businessId);
      result.settled.push({ jobId, to });
    } catch (err) {
      if (err instanceof PhaseMovedError) {
        result.skipped.push(jobId);
        continue;
      }
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
      } catch (err) {
        // A refusal is a reason to fail the job only while it is still
        // parked here; one that moved on was settled by someone else.
        const now = (await loadJob(jobId, { businessId }))?.phase;
        if (now !== undefined && now !== 'plan') throw new PhaseMovedError(jobId, 'plan', now);
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
