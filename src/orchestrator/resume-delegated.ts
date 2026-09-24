/**
 * The parent half of delegation: wake a job that parked itself waiting on a
 * child's answer.
 *
 * `requestHelp` (`orchestrator/delegate.ts`) moves a delegating job
 * `execute → followup` and records which envelope it is waiting on
 * (`jobs.awaiting_envelope_id`). Nothing read that column until this module —
 * a child that finished sat closed, and its parent slept in `followup`
 * forever, one phase short of the leak `closeVerifiedJobs` was built to
 * drain.
 *
 * A parked parent is freed in exactly two situations:
 *
 * 1. **The child reached a terminal phase.** `closed` is success; `failed`
 *    and `halted` are both a plain failure. Either way the parent does NOT
 *    fail by itself — that is a decision the parent's own plan makes on its
 *    next pass through `execute`, the same way any other step outcome is a
 *    fact the plan reacts to rather than a verdict imposed from outside. A
 *    `result` envelope is written first, so the outcome survives in the same
 *    durable, typed form the request itself took — never silence about
 *    *what* happened, only about what should happen next.
 * 2. **The envelope's own deadline passed and the child is still running.**
 *    `constraints.deadlineAt` is what frees the parent when the child never
 *    answers at all. Without this branch one stuck child parks its parent in
 *    `followup` permanently, and nothing else in the system would ever
 *    notice — the exact shape of leak `closeVerifiedJobs` exists to close,
 *    one phase earlier. The `result` envelope records a timeout in the same
 *    shape a real answer would take, so a parent reading its envelope back
 *    cannot tell a slow child from a silent one by structure alone — only by
 *    `payload.outcome`.
 *
 * Every other combination — the child still running, the deadline still
 * ahead — is left alone; the parent stays parked and this function looks at
 * it again next pass.
 *
 * Per-job advisory lock and per-job isolation, the same shape `runDueJobs`
 * already uses and for the same reason: one parent with corrupted state must
 * not stop every other parent in the same pass from waking. Three specific
 * corruptions — an `awaiting_envelope_id` pointing at nothing, an envelope
 * with no child ever attached, and a child job that no longer exists — are
 * not merely reported: the parent is moved to `failed` (see
 * `failCorruptedParent`), because this function is that parent's only
 * possible mover and leaving it parked would starve the scheduler's window
 * exactly the way an unbound job used to (`run-due.ts`'s `RunDueResult.unbound`).
 * An unreadable `constraints.deadlineAt` gets the same treatment — a value
 * that cannot be read is never treated as "still inside the window".
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { AgentId } from '../domain/audit.js';
import type { AgentEnvelope, DelegationOutcome } from '../domain/envelope.js';
import { canonicalHash } from '../util/canonical.js';
import { loadEnvelopeWithChild, writeEnvelope } from '../governance/envelope-store.js';
import { loadJob, transition } from './jobs.js';

/** A parent whose processing threw before reaching a disposition, and why. */
export interface ErroredParent {
  jobId: string;
  error: string;
}

export interface ResumeResult {
  /** Parents woken because their child reached a terminal phase. */
  resumed: string[];
  /** Parents woken because the envelope's deadline passed before the child did. */
  timedOut: string[];
  /**
   * Parents whose bookkeeping could not be trusted, or whose processing threw
   * before reaching a disposition. Shaped like `RunDueResult.errored`
   * (`run-due.ts`) on purpose — the same diagnostic an operator reads there is
   * the one they need here, not a bare id with the reason discarded.
   *
   * A missing envelope, an envelope with no child ever attached, and a
   * missing child row are all reported here — but, unlike a genuinely
   * unexpected throw, each of the three is ALSO moved to `failed` first (see
   * `failCorruptedParent`). Left merely `errored`, such a parent would stay
   * in `followup` with `awaiting_envelope_id` set forever: `wakeDueJobs`
   * never looks at that column, so this function is its only possible mover,
   * and a query that finds the same unmovable row every pass sorts first
   * under `ORDER BY updated_at ASC LIMIT $n` — the exact starvation
   * `run-due.ts` documents and fixes for an unbound job (`RunDueResult.unbound`).
   */
  errored: ErroredParent[];
}

interface DueParentRow {
  job_id: string;
}

/**
 * Wake every parent whose child has answered, or whose patience ran out.
 *
 * Scans `jobs` directly — `phase = 'followup' AND awaiting_envelope_id IS NOT
 * NULL` — rather than `agent_envelopes` by `child_job_id`: the parent is the
 * row this function moves, so it is the row this function starts from.
 */
export async function resumeDelegatedJobs(
  options: { businessId?: string; limit?: number; now?: Date } = {},
): Promise<ResumeResult> {
  const businessId = options.businessId ?? config.businessId;
  const limit = options.limit ?? 20;
  const now = options.now ?? new Date();

  const { rows } = await getPool().query<DueParentRow>(
    `SELECT job_id FROM jobs
      WHERE business_id = $1
        AND phase = 'followup'
        AND awaiting_envelope_id IS NOT NULL
        AND closed_at IS NULL
      ORDER BY updated_at ASC
      LIMIT $2`,
    [businessId, limit],
  );

  const result: ResumeResult = { resumed: [], timedOut: [], errored: [] };

  for (const row of rows) {
    const jobId = row.job_id;
    const lockScope = `resume-delegated:${businessId}:${jobId}`;
    const client = await getPool().connect();
    let holdsLock = false;
    try {
      try {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [lockScope],
        );
        if (lock.rows[0]?.locked !== true) continue;
        holdsLock = true;

        // Re-read under the lock, the same reasoning `runDueJobs` argues at
        // length: the phase may have moved between the query above and the
        // lock being granted.
        const parent = await loadJob(jobId, { businessId });
        if (parent === null || parent.phase !== 'followup' || parent.awaitingEnvelopeId === null) {
          continue;
        }

        const stored = await loadEnvelopeWithChild(parent.awaitingEnvelopeId, { businessId });
        if (stored === null) {
          const error = `job ${jobId} awaits envelope ${parent.awaitingEnvelopeId}, which does not exist`;
          await failCorruptedParent(jobId, businessId, error);
          result.errored.push({ jobId, error });
          continue;
        }
        if (stored.childJobId === null) {
          // The crash window `requestHelp`'s own docblock names: the
          // envelope committed but the child was never attached. Not this
          // function's repair to make — an operator can still re-derive the
          // child id and call `attachChildJob` by hand — but a parent cannot
          // be left parked on a promise nothing will ever keep.
          const error = `job ${jobId} awaits envelope ${stored.envelope.id}, which has no child job attached`;
          await failCorruptedParent(jobId, businessId, error);
          result.errored.push({ jobId, error });
          continue;
        }

        const child = await loadJob(stored.childJobId, { businessId });
        if (child === null) {
          const error = `job ${jobId}'s child ${stored.childJobId} does not exist`;
          await failCorruptedParent(jobId, businessId, error);
          result.errored.push({ jobId, error });
          continue;
        }

        const terminal = child.phase === 'closed' || child.phase === 'failed' || child.phase === 'halted';

        if (terminal) {
          const outcome: DelegationOutcome = child.phase === 'closed' ? 'succeeded' : 'failed';
          await writeResultAndWake(stored.envelope, jobId, child.jobId, outcome, { businessId, now });
          result.resumed.push(jobId);
          continue;
        }

        // The child is still running. Whether the parent may keep waiting
        // depends on the deadline — and a deadline this function cannot read
        // is never treated as one still ahead. `Date.parse` on a missing or
        // mangled `deadlineAt` returns `NaN`, and `NaN <= x` is always
        // `false`: left unchecked, that reads as "still inside the window"
        // and the parent is skipped silently, forever, with no timeout and no
        // `errored` line anywhere. The project's rule is explicit and applies
        // here exactly as it does to `amount_unreadable`: a value that could
        // not be read is never a permitting value.
        const deadlineMs = Date.parse(stored.envelope.constraints.deadlineAt);
        if (Number.isNaN(deadlineMs)) {
          const error =
            `job ${jobId}'s envelope ${stored.envelope.id} carries an unreadable deadline ` +
            `(${JSON.stringify(stored.envelope.constraints.deadlineAt)})`;
          await failCorruptedParent(jobId, businessId, error);
          result.errored.push({ jobId, error });
          continue;
        }

        if (deadlineMs > now.getTime()) {
          // Still running, still inside the deadline — left exactly alone.
          continue;
        }

        await writeResultAndWake(stored.envelope, jobId, child.jobId, 'timeout', { businessId, now });
        result.timedOut.push(jobId);
      } catch (error) {
        // This parent's failure must not take the rest of the pass down with
        // it — the same isolation `runDueJobs` gives every job it touches.
        // Unlike the corrupted shapes above, an unexpected throw here is not
        // moved to `failed`: a transient failure (a dropped connection) is
        // not evidence the parent's own state is unrecoverable, and forcing
        // a terminal phase on it would be the wrong direction to guess.
        result.errored.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (holdsLock) {
        // Unlock-then-release, kept apart so `release` is called exactly
        // once on every path, and a failed unlock destroys the connection
        // instead of returning a session to the pool that still holds this
        // job's lock. `runDueJobs` argues both points at length.
        let unlockError: unknown;
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockScope]);
        } catch (error) {
          unlockError = error;
        }
        if (unlockError === undefined) {
          client.release();
        } else {
          client.release(
            unlockError instanceof Error ? unlockError : new Error(String(unlockError)),
          );
        }
      } else {
        client.release();
      }
    }
  }

  return result;
}

/**
 * Fail a parent whose delegation bookkeeping cannot be trusted, instead of
 * leaving it parked in `followup` forever.
 *
 * `wakeDueJobs` (`scheduler.ts`) only ever looks at `jobs.wake_at`, never
 * `awaiting_envelope_id` — this function is a parent's ONLY possible mover
 * once that column is corrupted, so leaving it merely `errored` (reported,
 * untouched) means it never moves again. And because `updated_at` never
 * advances on a row nothing writes, it sorts first under `ORDER BY
 * updated_at ASC LIMIT $n` on every subsequent pass: enough such rows and no
 * parent of that business is ever reached again — the exact starvation
 * `run-due.ts` documents and fixes for an unbound job (`RunDueResult.unbound`).
 * Loud and terminal, the same treatment.
 */
async function failCorruptedParent(jobId: string, businessId: string, reason: string): Promise<void> {
  await transition(jobId, {
    to: 'failed',
    actor: 'system',
    reason: `resume_delegated: ${reason}`,
    businessId,
  });
}

function outcomeNote(outcome: DelegationOutcome): string {
  switch (outcome) {
    case 'succeeded':
      return 'הבקשה נענתה והמשימה שנפתחה עבורה נסגרה';
    case 'failed':
      return 'המשימה שנפתחה לבקשה נכשלה ולא נסגרה כראוי';
    case 'timeout':
      return 'הבקשה לא נענתה בתוך המועד שנקבע לה';
  }
}

/**
 * Write the `result` envelope answering `original`, then wake the parent it
 * belongs to.
 *
 * `to` is derived from `original.from`, not carried separately: a
 * `help_request` envelope's `from` is always the requesting AGENT
 * (`RequestHelpInput.from` is typed `AgentId`, never the `'orchestrator'`
 * sentinel that only ever appears on the synthetic root-ancestor constant),
 * so recovering it here rather than threading a fourth argument keeps the
 * two envelopes' fields in an obvious correspondence. A malformed row that
 * violates this — `from: 'orchestrator'` on a real, attached `help_request`
 * envelope — throws and is caught by this module's own per-job isolation,
 * exactly like any other corrupted-state finding.
 */
async function writeResultAndWake(
  original: AgentEnvelope,
  parentJobId: string,
  helperJobId: string,
  outcome: DelegationOutcome,
  ctx: { businessId: string; now: Date },
): Promise<void> {
  const to = AgentId.parse(original.from);

  const resultEnvelope: AgentEnvelope = {
    v: 1,
    id: `ENV-${ulid()}`,
    correlationId: original.correlationId,
    causalChain: [...original.causalChain, original.id],
    from: original.to,
    to,
    kind: 'result',
    intent: original.intent,
    payload: { outcome, note: outcomeNote(outcome) },
    contextRefs: [{ kind: 'job', jobId: helperJobId }],
    constraints: original.constraints,
    hops: original.hops,
    // Deterministic in the pair (original envelope, outcome): a second pass
    // that finds the same terminal state — a race with another scheduler, a
    // retry after this function's own throw — collides on the same key and
    // `writeEnvelope` reports `duplicate` rather than writing a second
    // record of the same fact.
    idempotencyKey: canonicalHash({ resultFor: original.id, outcome }),
    createdAt: ctx.now.toISOString(),
  };

  const written = await writeEnvelope(resultEnvelope, {
    parentJobId: helperJobId,
    businessId: ctx.businessId,
  });

  await transition(parentJobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: `${outcomeNote(outcome)} (מעטפת ${written.envelope.id})`,
    envelopeId: written.envelope.id,
    awaitingEnvelopeId: null,
    businessId: ctx.businessId,
  });
}
