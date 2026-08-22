import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';
import type { Plan } from '../domain/plan.js';
import { AutonomyLevel, mostRestrictiveAutonomy } from '../domain/trust.js';

/**
 * The level an action class has when nothing says otherwise.
 *
 * Matches the column default in migration 001, and matters far more than that
 * suggests: this is the value a missing row, an unknown business, or a level
 * string this code does not recognise all resolve to. A value nobody could
 * read is never a permissive value — and `draft_only` is the level at which
 * work is produced and nothing leaves the building.
 */
const RAMP_FLOOR: AutonomyLevel = 'draft_only';

interface RampRow {
  level: string;
}

/**
 * The earned autonomy for one action class.
 *
 * The first reader this table has ever had. `RunPlanRequest.rampLevel` has
 * been required since the engine was written, so every caller until now was a
 * test passing a literal — which meant the one control that holds a new
 * install at "draft only" was carried entirely by nobody having wired a
 * production caller yet.
 */
export async function loadRampLevel(
  actionClass: ActionClass,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<RampRow>(
    `SELECT level FROM autonomy_ramp
      WHERE business_id = $1 AND action_class = $2`,
    [options.businessId ?? config.businessId, actionClass],
  );

  const stored = rows[0]?.level;
  if (stored === undefined) return RAMP_FLOOR;

  // Parsed rather than cast. The column is TEXT, so a level this build does
  // not know about — a rollback, a hand-edited row — is representable, and
  // treating it as an AutonomyLevel would hand the gate a ceiling it cannot
  // rank.
  const parsed = AutonomyLevel.safeParse(stored);
  return parsed.success ? parsed.data : RAMP_FLOOR;
}

/**
 * Set the earned autonomy for one action class.
 *
 * Deliberately blunt and deliberately not automatic: promotion out of
 * `draft_only` is a decision, and until the ramp mechanics of stage 2 exist
 * the only thing that should move this row is a person running a command.
 */
export async function setRampLevel(
  actionClass: ActionClass,
  level: AutonomyLevel,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO autonomy_ramp (business_id, action_class, level, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, action_class)
     DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
    [options.businessId ?? config.businessId, actionClass, level],
  );
}

/**
 * One ceiling for a whole plan: the most restrictive level across every class
 * its steps declare.
 *
 * `runPlan` takes a single `rampLevel` for the run, while a plan may touch
 * several action classes. Taking the minimum is the only combination that
 * keeps a ceiling a ceiling.
 *
 * A step whose `expectedActionClass` is null contributes `RAMP_FLOOR`. That
 * field is advisory to the gate — the gate classifies the call itself — but
 * here it is the only thing available before the step runs, and "the planner
 * did not say" must not read as "no ceiling applies".
 */
export async function rampLevelForPlan(
  plan: Plan,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const levels: AutonomyLevel[] = [];
  for (const step of plan.steps) {
    if (step.expectedActionClass === null) {
      levels.push(RAMP_FLOOR);
      continue;
    }
    levels.push(await loadRampLevel(step.expectedActionClass, options));
  }
  // `mostRestrictiveAutonomy` throws on an empty list rather than defaulting
  // to permissive; `Plan.steps` has `.min(1)`, so this is never empty.
  return mostRestrictiveAutonomy(levels);
}
