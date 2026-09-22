/**
 * The pass that moves a class up when it has earned it and down the moment
 * it has not.
 *
 * Everything it reads is derived: the streak from `approval_requests`, the
 * demotion count from `autonomy_events`, the failures from the job record.
 * Nothing here maintains a counter, so nothing here can drift — the counter
 * columns migration 001 put on `autonomy_ramp` (`samples`,
 * `approved_without_edit`, `incidents`) stay empty on purpose, spec §9.3.
 * `promoted_at` and `demoted_at` are written, because they are facts about a
 * move rather than tallies beside the truth.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { ActionClass } from '../domain/action.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { STREAK_REQUIRED, approvalStreak } from '../governance/agreement.js';
import { loadRampLevel, setRampLevel } from './ramp.js';

export interface AutonomyPassResult {
  promoted: ActionClass[];
  demoted: ActionClass[];
  /**
   * Classes whose own evaluation threw and was isolated (spec §10).
   *
   * Without this field the isolation is indistinguishable from "nothing was
   * due": a class that fails to evaluate every pass would never promote and
   * never say why. It exists for the same reason `RunDueResult` splits its
   * buckets — an outcome nobody prints is an outcome that does not exist.
   */
  errored: ActionClass[];
}

/**
 * The single rung the measurement may earn. Spec §2.3, §5.4.
 *
 * `draft_only → approve_required` is the owner's act, never the measurement's,
 * and `auto_notify → auto` is not built: the two are identical at the gate
 * today, so climbing to it would change nothing and could not be measured.
 */
const EARNED_STEP: { from: AutonomyLevel; to: AutonomyLevel } = {
  from: 'approve_required',
  to: 'auto_notify',
};

/** Two falls and the class waits for the owner. Spec §6.4. */
const DEMOTIONS_BEFORE_STOP = 2;

async function lastEventAt(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date }>(
    `SELECT at FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2
      ORDER BY at DESC LIMIT 1`,
    [businessId, actionClass],
  );
  return rows[0]?.at ?? null;
}

/**
 * When the ramp row for this class was last written.
 *
 * The fallback window for the demotion signals when the class has never moved
 * through this pass. §6.1 counts a failure only under a level ABOVE
 * `approve_required`, and with no window at all `failureCount(null)` reached
 * back over all history — so a class raised by hand (`npm run ramp:set`, the
 * path CLAUDE.md documents as in use on `dev-business`) fell again on the very
 * next pass because of a job that failed long before the raise, quietly
 * undoing the raise. `updated_at` is when the level this pass is judging came
 * into being, which is exactly the start of the period it may judge.
 */
async function rampUpdatedAt(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<Date | null> {
  const { rows } = await db.query<{ updated_at: Date }>(
    `SELECT updated_at FROM autonomy_ramp
      WHERE business_id = $1 AND action_class = $2`,
    [businessId, actionClass],
  );
  return rows[0]?.updated_at ?? null;
}

async function demotionCount(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2 AND direction = 'demote'`,
    [businessId, actionClass],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Clean approvals for this class decided strictly after the last ramp move.
 *
 * This is what makes spec §6.3 — "the streak starts again" — true. Without
 * it, `approvalStreak` keeps reporting the same ten decisions that earned the
 * previous promotion, so a class demoted on an owner's mark climbs straight
 * back on the very next pass and the mark lasts one scheduler interval. It is
 * asked only when a move has already happened; a class that has never moved
 * has nothing to restart from, and the streak alone decides it.
 *
 * Only `approved` is counted, and one literal rather than a second copy of
 * `agreement.ts`'s verdict list: this asks how many clean approvals there are
 * since the move, and the streak check beside it is what proves the ten most
 * recent decisions are consecutive. Together they mean ten consecutive clean
 * approvals, all of them after the last move.
 */
async function cleanApprovalsSince(
  actionClass: ActionClass,
  businessId: string,
  since: Date,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approval_requests
      WHERE business_id = $1 AND action_class = $2
        AND state = 'approved' AND decided_at > $3`,
    [businessId, actionClass, since],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Owner marks on this class since the last move. Spec §6.1. */
async function markCount(
  actionClass: ActionClass,
  businessId: string,
  since: Date | null,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM autonomy_marks
      WHERE business_id = $1 AND action_class = $2
        AND ($3::timestamptz IS NULL OR marked_at > $3)`,
    [businessId, actionClass, since],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Jobs that reached `failed` since the last move, whose bound plan declares
 * this action class.
 *
 * `job_steps` is the timestamp source because the phase change and its row
 * are written in one transaction (`transition`, `jobs.ts`), so "when did this
 * fail" is answerable exactly. The plan is matched by jsonb containment
 * rather than by unpacking the steps, which keeps the predicate one
 * expression.
 *
 * Attribution is deliberately broad (spec §6.1.1): a plan that declares the
 * class counts, even when another step is what actually failed. Broad here
 * means the assistant goes back to asking, which is the safe direction.
 */
async function failureCount(
  actionClass: ActionClass,
  businessId: string,
  since: Date | null,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT jp.job_id)::text AS n
       FROM job_plans jp
       JOIN job_steps js ON js.job_id = jp.job_id
      WHERE jp.business_id = $1
        AND js.to_phase = 'failed'
        AND ($3::timestamptz IS NULL OR js.at > $3)
        AND jp.plan @> $2::jsonb`,
    [businessId, JSON.stringify({ steps: [{ expectedActionClass: actionClass }] }), since],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Which signal fired, named rather than implied.
 *
 * Spec §9.1 makes the event row the history §8 shows the owner — "this class
 * was demoted on Tuesday, and here is why". A fixed disjunction ("a mark or a
 * failed job") answers neither half of that, and both counts are already in
 * hand at the call site. Written as two positive clauses that each name what
 * they found, so a demotion driven by both says both.
 */
function demotionReason(marks: number, failures: number): string {
  const parts: string[] = [];
  if (marks > 0) parts.push(`סימון טעות של הבוס (${marks})`);
  if (failures > 0) parts.push(`משימה שנכשלה (${failures})`);
  return parts.join(' ו-');
}

/**
 * Move one class, as one transaction.
 *
 * The level, the event row, `promoted_at`/`demoted_at` and the audit entry
 * are one fact about the business and must commit or roll back together.
 * Written as four statements on the pool, a failure in the last of them — and
 * `appendAudit` takes a per-business advisory lock, which contends exactly
 * when the system is busy — left the class ALREADY at `auto_notify` with no
 * audit row and nothing in `promoted`: autonomy raised, silently. The same
 * hazard `trip()` in `killswitch.ts` documents, except that one is
 * deliberately non-atomic because stopping without a record beats not
 * stopping; here there is no such asymmetry, so the transaction is simply
 * right.
 *
 * `appendAudit` receives the transaction as `tx` and therefore joins it,
 * rather than opening one of its own and taking the advisory lock inside a
 * single statement.
 *
 * The transaction is opened here rather than threaded from `evaluateAutonomy`'s
 * `options.db`: that parameter points the READS at a connection, and every
 * caller today leaves it unset. A caller that passed a live transaction there
 * would have its reads and this write on two different connections — recorded
 * because it is a real limit, not because anything relies on it.
 */
async function move(
  direction: 'promote' | 'demote',
  actionClass: ActionClass,
  from: AutonomyLevel,
  to: AutonomyLevel,
  reason: string,
  businessId: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    await setRampLevel(actionClass, to, { businessId, db: tx });
    await tx.query(
      `INSERT INTO autonomy_events
         (event_id, business_id, action_class, direction, from_level, to_level, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`AE-${ulid()}`, businessId, actionClass, direction, from, to, reason],
    );
    await tx.query(
      `UPDATE autonomy_ramp
          SET ${direction === 'promote' ? 'promoted_at' : 'demoted_at'} = now(), updated_at = now()
        WHERE business_id = $1 AND action_class = $2`,
      [businessId, actionClass],
    );
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'autonomy_change',
        actionClass,
        charterVersion: 'unknown',
        provenance: 'boss',
        inputHash: canonicalHash({ actionClass, direction, from, to }),
        reason: `${actionClass}: ${from} → ${to} (${reason})`,
      },
      { businessId, tx },
    );
  });
}

/**
 * One evaluation of every action class. Spec §5, §6, §10.
 *
 * Runs last in `schedulerPass` because it consumes what that very round
 * produced: a card just decided, a job just failed.
 */
export async function evaluateAutonomy(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyPassResult> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const mode = await loadAutonomyMode({ businessId, db });

  const promoted: ActionClass[] = [];
  const demoted: ActionClass[] = [];
  const errored: ActionClass[] = [];

  for (const actionClass of ActionClass.options) {
    // One class failing to evaluate must not stop the rest (spec §10). A
    // promotion that did not happen is late; a pass that threw is the whole
    // mechanism down.
    try {
      const level = await loadRampLevel(actionClass, { businessId, db });
      const since = await lastEventAt(actionClass, businessId, db);

      // Demotion first, and not gated on the mode: the record of a class that
      // was acting on its own must be able to come back down whatever the
      // owner has since done with the dial. In practice the dial's clamp
      // decides when this branch is reachable — at `off` and `ask`
      // `loadRampLevel` already answers below `auto_notify`, so she is not
      // acting either way — and a mark raised while the dial sat there is not
      // lost, because the window below is "since the last move", not "since
      // the last pass".
      if (level === EARNED_STEP.to) {
        // The period this pass may judge: since the last move if there was
        // one, and otherwise since the level itself was written — see
        // `rampUpdatedAt`. Never the beginning of time, which would let
        // evidence from before the class was ever released count against it.
        const signalSince = since ?? (await rampUpdatedAt(actionClass, businessId, db));
        const marks = await markCount(actionClass, businessId, signalSince, db);
        const failures = await failureCount(actionClass, businessId, signalSince, db);
        if (marks + failures > 0) {
          await move(
            'demote',
            actionClass,
            EARNED_STEP.to,
            EARNED_STEP.from,
            demotionReason(marks, failures),
            businessId,
          );
          demoted.push(actionClass);
          continue;
        }
      }

      if (mode !== 'learn') continue;
      if (level !== EARNED_STEP.from) continue;
      if ((await demotionCount(actionClass, businessId, db)) >= DEMOTIONS_BEFORE_STOP) continue;
      if ((await approvalStreak(actionClass, { businessId, db })) < STREAK_REQUIRED) continue;
      // Spec §6.3 — see `cleanApprovalsSince`. Asked only after a move.
      if (
        since !== null &&
        (await cleanApprovalsSince(actionClass, businessId, since, db)) < STREAK_REQUIRED
      ) {
        continue;
      }

      await move(
        'promote',
        actionClass,
        EARNED_STEP.from,
        EARNED_STEP.to,
        `${STREAK_REQUIRED} אישורים רצופים ללא שינוי`,
        businessId,
      );
      promoted.push(actionClass);
    } catch {
      // Isolated per class, by design — see above — but reported, never
      // swallowed: the whole point of `errored` is that "it threw" and
      // "nothing was due" must not look the same to whoever reads the pass.
      errored.push(actionClass);
    }
  }

  return { promoted, demoted, errored };
}
