import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';
import type { Plan } from '../domain/plan.js';
import { AutonomyLevel, mostRestrictiveAutonomy } from '../domain/trust.js';
import { READ_ONLY_TOOLS } from '../policy/classify.js';

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
 * A step whose `expectedActionClass` is null contributes `RAMP_FLOOR` — with
 * one exception, and the distinction between them is the whole of this
 * function's subtlety. "The planner did not say" must not read as "no ceiling
 * applies", so a tool that HAS a class and was left unclassified still floors
 * the plan. But a tool on `READ_ONLY_TOOLS` has no class **by construction**:
 * `classifyAction` returns null for it, and the gate short-circuits it at
 * stage 4, before the autonomy stage reads this value at all. It has no
 * ceiling to contribute and never did.
 *
 * Conflating the two cost this project every autonomous action it ever had.
 * The live run of 11/09: the ramp for `email.reply` stood at `auto_notify`,
 * the charter allowed it, a standing authorisation covered the recipient —
 * and the gate denied at `draft_only:persist_as_draft`, because the plan also
 * contained `memory.recall` and `mail.draft`. Any plan that recalls or drafts
 * before it sends was floored, which is every plan a competent planner
 * writes, so the ramp was unreachable in practice and raising it changed
 * nothing.
 *
 * `capabilityCatalogue` (`catalogue.ts`) already draws this line, reporting
 * `auto` for a read-only tool because "a read-only tool has no class and no
 * ceiling to combine; the gate short-circuits it, so reporting anything else
 * would be a lie". This is the same statement, on the enforcement side.
 *
 * A tool that is neither classified nor on the read-only list is a tool
 * nobody has reasoned about, and still floors the plan: the check is
 * membership of a positive list, never the absence of a class.
 */
export async function rampLevelForPlan(
  plan: Plan,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const levels: AutonomyLevel[] = [];
  for (const step of plan.steps) {
    if (step.expectedActionClass === null) {
      if (READ_ONLY_TOOLS.has(step.toolName)) continue;
      levels.push(RAMP_FLOOR);
      continue;
    }
    levels.push(await loadRampLevel(step.expectedActionClass, options));
  }
  // A plan made entirely of read-only steps contributes no ceiling at all.
  // `mostRestrictiveAutonomy` throws on an empty list rather than defaulting
  // to permissive, and the floor is the right answer here anyway: there is
  // nothing for the ramp to cap, and every step short-circuits before the
  // autonomy stage reads it.
  if (levels.length === 0) return RAMP_FLOOR;
  return mostRestrictiveAutonomy(levels);
}
