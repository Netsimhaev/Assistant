/**
 * The pass that moves a class up when it has earned it and down the moment
 * it has not.
 *
 * Everything it reads is derived: the agreement rate from `approval_requests`, the
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
import { agreementFor, isLearned } from '../governance/agreement.js';

import { loadRampLevel, loadStoredRampLevel, setRampLevel } from './ramp.js';

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
export const DEMOTIONS_BEFORE_STOP = 2;

/**
 * When this class last moved, in either direction — the `since` the
 * agreement rate is measured from.
 *
 * Exported for the learning-level screen (`dashboard/learning-view.ts`),
 * which must ask the very same question this pass asks: a screen that
 * measured from a different moment would say "ready" while the pass does not
 * promote, or the reverse.
 */
export async function lastEventAt(
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

/**
 * When this class was last promoted — the "acting alone since" the
 * learning-level screen shows. `null` for a class that was never promoted by
 * this pass (a level raised by hand with `npm run ramp:set` has no event row).
 */
export async function lastPromotionAt(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date }>(
    `SELECT at FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2 AND direction = 'promote'
      ORDER BY at DESC LIMIT 1`,
    [businessId, actionClass],
  );
  return rows[0]?.at ?? null;
}

/** Exported for the learning-level screen, for the same reason as `lastEventAt`. */
export async function demotionCount(
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
 *
 * `from` is whatever the caller passed — `evaluateAutonomy` passes the raw
 * `autonomy_ramp` row (`loadStoredRampLevel`), not the level the dial made
 * visible to this pass, so `autonomy_events.from_level` names what the class
 * was actually stored at rather than what the gate saw.
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
      //
      // A mark recorded for a send that happened before a demotion already in
      // effect has no further effect: `markCount` is consulted only while the
      // class sits at `auto_notify`, and after a re-promotion its window
      // starts after that mark. The class is already demoted, so the mark is
      // not counted twice.
      if (level === EARNED_STEP.to) {
        // The period this pass may judge: since the last move if there was
        // one, and otherwise since the level itself was written — see
        // `rampUpdatedAt`. Never the beginning of time, which would let
        // evidence from before the class was ever released count against it.
        const signalSince = since ?? (await rampUpdatedAt(actionClass, businessId, db));
        const marks = await markCount(actionClass, businessId, signalSince, db);
        const failures = await failureCount(actionClass, businessId, signalSince, db);
        if (marks + failures > 0) {
          // `from` is the row's own stored level, not the clamped `level`
          // this pass evaluated — see `loadStoredRampLevel`. The two agree
          // whenever the dial's ceiling did no work; they can differ when it
          // did (a hand-raised `auto` clamped down to `auto_notify` under
          // `learn`), and the event row must name what was actually there.
          const storedFrom = (await loadStoredRampLevel(actionClass, { businessId, db })) ?? level;
          await move(
            'demote',
            actionClass,
            storedFrom,
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
      // The owner agreed more than 80% of the time over at least five verdicts.
      // The "starts again after a move" rule (spec §6.3) is carried by `since`:
      // `agreementFor` only counts cards decided after the last ramp move.
      const agreement = await agreementFor(actionClass, { businessId, since, db });
      if (!isLearned(agreement)) continue;

      // Spec §5.1.4 — promotion on the windowed agreement rate (>80% of at
      // least five owner verdicts), with no mark and no failed job —
      // has no separate check here, on purpose, not by omission. The two
      // halves are satisfied for DIFFERENT reasons, and an earlier draft of
      // this comment collapsed them into one claim that was not true of the
      // code.
      //
      // The mark half is structural: a mark can only exist for a step
      // `listAutonomousActions` shows, which is a step that ran without an
      // approval card. A class sitting at `approve_required` produces no
      // such step, so `markCount` cannot fire for a class that is a
      // candidate for promotion.
      //
      // The failure half is satisfied by not being asked: this branch never
      // calls `failureCount`. Note what that does NOT mean — `failureCount`
      // itself carries no level filter, so §6.1's wording ("a job that ran
      // above `approve_required`") is stricter than the query, which counts
      // any failed job whose plan declares the class. That gap is narrow and
      // predates this branch, and it is named here rather than papered over:
      // it would matter the day something asks `failureCount` on the
      // promotion path.
      const storedFrom = (await loadStoredRampLevel(actionClass, { businessId, db })) ?? level;
      await move(
        'promote',
        actionClass,
        storedFrom,
        EARNED_STEP.to,
        `${agreement.right} מתוך ${agreement.counted} הכרעות אחרונות (${Math.round((100 * agreement.right) / agreement.counted)}%)`,
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
