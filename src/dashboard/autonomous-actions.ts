/**
 * What the assistant did entirely on its own — spec §8.4/§8.5.
 *
 * This docblock used to say the owner deliberately does NOT get a
 * notification for every autonomous step (`docs/05-approvals.md`'s "he wants
 * to look when he wants to look"). Owner ruling H3 (26/10, shadow mode)
 * reverses that: every step this list returns, minus those from jobs he
 * instructed himself (`fromInstruction`), now gets its own update on the
 * channels he picked — one per step, never batched
 * (`orchestrator/action-updates.ts`, which reads this list). The screen is
 * still load-bearing: an update is a pointer to it, and without a screen
 * that lists exactly what ran unattended, there is nothing for him to mark,
 * and the demotion half of the promotion mechanism
 * (`orchestrator/promote.ts`'s `markCount`) has no way to ever receive a
 * mark: a mark can only follow from a step the owner can actually see.
 *
 * **The filter is the whole point.** A step this list shows is one the
 * assistant did without anyone's sign-off, which is exactly the fact that
 * makes marking it "a mistake" meaningful. A step that went out because the
 * owner clicked "approve" on a card is a decision HE made — showing it here
 * would invite him to mark his own approval as the assistant's error, and
 * would let a mark demote a class whose real cause was a person, not the
 * autonomy the dial governs.
 *
 * Read at STEP granularity, via `approval_requests.consumed_by_step`
 * (`governance/consume.ts`) — the exact step id a spent approval recorded as
 * the one that spent it. An earlier version of this query excluded by job id
 * alone (any spent card anywhere in the job hid every completed step in it),
 * which a live two-step-plan reproduction proved wrong: `run-plan.ts`'s own
 * docblock describes a halted multi-step plan resuming — one step already
 * earned autonomy, a sibling step still needs a card — as the designed
 * operating mode this promotion feature exists to reach. Under the job-level
 * filter, the moment the gated sibling's card was spent, the OTHER step —
 * which never touched a card — vanished from the list: invisible, therefore
 * unmarkable, therefore undemotable. Filtering on `consumed_by_step = r.step_id`
 * excludes exactly the step a card paid for and nothing else.
 *
 * The action class shown is not the plan's advisory `expectedActionClass`
 * (`domain/plan.ts` states plainly that field is never authoritative) but the
 * SAME computation the gate itself used to decide the step could run
 * autonomously — `classifyAction` then `refineActionClass`, exactly as
 * `run-plan.ts`'s own `actionClassOf` derives it. Anything else would let
 * this screen, and the mark it produces, describe a class the gate never
 * actually acted under.
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import type { ActionClass } from '../domain/action.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { readEmails, readPhones } from '../policy/facts.js';

/** One completed step the assistant ran with nobody's card behind it. */
export interface AutonomousAction {
  jobId: string;
  stepId: string;
  actionClass: ActionClass;
  toolName: string;
  /** `jobs.title` is nullable and, for several origins, content someone else wrote. */
  jobTitle: string | null;
  /** The email or phone number `readEmails`/`readPhones` found in the step's own payload. */
  recipient: string | null;
  /** The step payload's `subject` field, when it carries one and it is a string. */
  subject: string | null;
  /** The provider's handle on what the step created, or `null` when it created nothing. */
  externalId: string | null;
  completedAt: Date;
  /**
   * The job was opened by the owner's own instruction — a `boss_instructions`
   * row for it under THIS business. Shadow mode words the update differently
   * for "you asked me to" than for "I did this on my own".
   */
  fromInstruction: boolean;
}

interface ActionRow {
  job_id: string;
  step_id: string;
  external_id: string | null;
  completed_at: Date;
  job_title: string | null;
  plan: unknown;
  from_instruction: boolean;
}

/**
 * Every completed step that ran without a card, newest first.
 *
 * The join to `job_plans` carries `AND jp.plan_hash = r.plan_hash` — not just
 * the job id — because a job's bound plan is the one row `job_plans` will
 * ever hold for it (`bindPlanToJob`'s first-plan-wins rule), and a completion
 * recorded under any other hash belongs to a plan this job is no longer
 * running (`resume-plan.test.ts` seeds exactly that shape). Matching only on
 * `job_id` would resolve such a stale row against the CURRENT plan and read a
 * step that never actually ran under it.
 *
 * `AND r.performed = true` (migration 037): a `completed` row whose step did
 * nothing (`performed = false`, a local tool with no implementation) or does
 * not know (`performed IS NULL`) is not something she DID, and shadow mode
 * must not report it as an action. `= true` excludes NULL as well, which is
 * the point — a row that cannot say it performed is not listed as one that did.
 *
 * A step whose tool is not classified (`classifyAction` returns `null` — a
 * `READ_ONLY_TOOLS` member, by construction never anything else) is not an
 * "action" in the sense this screen means: it never needed a card, ramp or
 * mark to run, autonomously or otherwise, so it is left out rather than
 * listed with a fabricated class.
 */
export async function listAutonomousActions(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomousAction[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<ActionRow>(
    `SELECT r.job_id, r.step_id, r.external_id, r.completed_at,
            j.title AS job_title, jp.plan AS plan,
            EXISTS (
              SELECT 1 FROM boss_instructions b
               WHERE b.business_id = r.business_id
                 AND b.job_id = r.job_id
            ) AS from_instruction
       FROM job_step_results r
       JOIN jobs j       ON j.job_id = r.job_id  AND j.business_id = r.business_id
       JOIN job_plans jp ON jp.job_id = r.job_id AND jp.business_id = r.business_id
                        AND jp.plan_hash = r.plan_hash
      WHERE r.business_id = $1
        AND r.status = 'completed'
        AND r.performed = true
        AND NOT EXISTS (
          SELECT 1 FROM approval_requests a
           WHERE a.business_id = r.business_id
             AND a.job_id = r.job_id
             AND a.consumed_by_step = r.step_id
        )
      ORDER BY r.completed_at DESC`,
    [businessId],
  );

  const actions: AutonomousAction[] = [];
  for (const row of rows) {
    const parsed = Plan.safeParse(row.plan);
    if (!parsed.success) {
      throw new Error(
        `listAutonomousActions: stored plan for job ${row.job_id} does not parse as a Plan`,
      );
    }
    const step = parsed.data.steps.find((candidate) => candidate.id === row.step_id);
    if (step === undefined) continue;

    const base = classifyAction(step.toolName);
    if (base === null) continue;
    const actionClass = refineActionClass(base, step.input);

    const [email] = readEmails(step.input);
    const [phone] = readPhones(step.input);
    const subjectRaw = step.input['subject'];

    actions.push({
      jobId: row.job_id,
      stepId: row.step_id,
      actionClass,
      toolName: step.toolName,
      jobTitle: row.job_title,
      recipient: email ?? phone ?? null,
      subject: typeof subjectRaw === 'string' ? subjectRaw : null,
      externalId: row.external_id,
      completedAt: row.completed_at,
      fromInstruction: row.from_instruction,
    });
  }

  return actions;
}
