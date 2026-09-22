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
import { getPool, type Queryable } from '../db/pool.js';
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

async function record(
  direction: 'promote' | 'demote',
  actionClass: ActionClass,
  from: AutonomyLevel,
  to: AutonomyLevel,
  reason: string,
  businessId: string,
  db: Queryable,
): Promise<void> {
  await db.query(
    `INSERT INTO autonomy_events
       (event_id, business_id, action_class, direction, from_level, to_level, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`AE-${ulid()}`, businessId, actionClass, direction, from, to, reason],
  );
  await db.query(
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
    { businessId },
  );
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
        const bad =
          (await markCount(actionClass, businessId, since, db)) +
          (await failureCount(actionClass, businessId, since, db));
        if (bad > 0) {
          await setRampLevel(actionClass, EARNED_STEP.from, { businessId, db });
          await record(
            'demote',
            actionClass,
            EARNED_STEP.to,
            EARNED_STEP.from,
            'סימון של הבוס או משימה שנכשלה',
            businessId,
            db,
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

      await setRampLevel(actionClass, EARNED_STEP.to, { businessId, db });
      await record(
        'promote',
        actionClass,
        EARNED_STEP.from,
        EARNED_STEP.to,
        `${STREAK_REQUIRED} אישורים רצופים ללא שינוי`,
        businessId,
        db,
      );
      promoted.push(actionClass);
    } catch {
      // Swallowed per class, by design — see above.
    }
  }

  return { promoted, demoted };
}
