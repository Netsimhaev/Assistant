/**
 * Turning "you got that wrong" into two things at once: a mark the promotion
 * pass (`orchestrator/promote.ts`) can demote a class on, and a memory the
 * planner will see the next time it writes to the same person. Spec §7.
 *
 * **The dangerous point, and why this file exists rather than a new field on
 * `writeMemory`.** `writeMemory` reads provenance from the JOB, deliberately
 * — see its own docblock: a caller able to declare its own trust level is a
 * caller able to launder a stranger's claim into the owner's knowledge. A
 * card born of an external document (`unknown_external`) is a real case here,
 * not a hypothetical one: the owner correcting it is not the stranger's claim
 * gaining standing, it is the OWNER speaking, and the memory must carry the
 * owner's provenance regardless of what job the card came from.
 *
 * The fix is not a parameter that lets this module hand `writeMemory` a
 * provenance of its choosing — that is the exact hole the design closes
 * everywhere else. It opens its OWN job with `'boss'` as a literal in the
 * call, exactly as `orchestrator/instruct.ts` does for the instruction door,
 * and for the identical reason: the correction's authority comes from the
 * session that reached this function (behind the owner's dashboard), not
 * from anything the caller could pass in. `writeMemory` then reads that new
 * job's provenance — `boss` — the same way it reads any other job's.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { messagesAPerson, type ActionClass } from '../domain/action.js';
import { createJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { readEmails, readPhones } from '../policy/facts.js';
import { writeMemory } from '../memory/store.js';

export interface CorrectionInput {
  /** The job whose step the owner is correcting — not the job this writes. */
  jobId: string;
  stepId: string;
  actionClass: ActionClass;
  note: string;
  by: string;
}

export interface CorrectionResult {
  markId: string;
  /** False when no recipient could be resolved from the step — see below. */
  remembered: boolean;
}

/**
 * Who the corrected step was actually addressed to, read from the job's own
 * bound plan — never invented, and never taken from the correction's caller.
 *
 * A positive rule, not an absence check: a memory is written only when a
 * recipient can actually be resolved. `actionClass` that does not address a
 * `person` (`messagesAPerson`) has nobody to file a preference under, and a
 * step whose payload carries no address either — a plan the owner never
 * bound, a step id that does not exist, or a payload with no `to`/`phone`
 * field `readEmails`/`readPhones` recognise — is the same case: inventing a
 * subject key here would file the lesson where nothing will ever recall it,
 * which is worse than not filing it at all.
 */
async function recipientOfStep(
  jobId: string,
  stepId: string,
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<string | null> {
  if (!messagesAPerson(actionClass)) return null;

  const stored = await loadPlanBody(jobId, { businessId, db });
  if (stored === null) return null;
  const step = stored.plan.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return null;

  const [email] = readEmails(step.input);
  if (email !== undefined) return email;
  const [phone] = readPhones(step.input);
  return phone ?? null;
}

/**
 * Record that the owner marked one autonomous step wrong.
 *
 * Always writes the mark — `autonomy_marks` is the row `evaluateAutonomy`
 * counts to demote a class (spec §6.1), and the demotion must happen whether
 * or not a memory could be filed alongside it. The memory write is the
 * second, separable half: best-effort in the sense that a step with no
 * resolvable recipient still demotes, never in the sense that a resolvable
 * one silently fails to teach anything.
 *
 * The attribute is the action class, not just the recipient, so
 * replace-on-write (the partial unique index `writeMemory` already relies on)
 * supersedes per PERSON AND PER KIND OF ACTION: a correction about how a
 * reply is drafted does not retire one about how a meeting is scheduled for
 * the same person. That is the same index, no new code — see
 * `memory/store.ts`'s own docblock on why an entity or preference replaces
 * rather than accumulates, which is what keeps the planner's hard character
 * budget (`memory/recall-planning.ts`) from filling up with every correction
 * ever made about one person instead of the newest.
 */
export async function recordCorrection(
  input: CorrectionInput,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<CorrectionResult> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const markId = `AM-${ulid()}`;
  await db.query(
    `INSERT INTO autonomy_marks
       (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [markId, businessId, input.jobId, input.stepId, input.actionClass, input.note, input.by],
  );

  const subjectKey = await recipientOfStep(input.jobId, input.stepId, input.actionClass, businessId, db);
  if (subjectKey === null) return { markId, remembered: false };

  const active = await loadActiveCharter(businessId, db);
  if (active === null) return { markId, remembered: false };

  // A job of the correction's OWN, stamped `boss` as a literal — not a
  // parameter, and not the provenance of the job being corrected. See this
  // module's header, and `orchestrator/instruct.ts` for the same structural
  // choice in the opposite direction (a stranger's job may never borrow the
  // owner's authority; here the owner's own act must never inherit a
  // stranger's).
  const job = await createJob({
    charterVersion: active.bundle.charterVersion,
    provenance: 'boss',
    title: `תיקון של הבוס — ${input.actionClass}`,
    businessId,
  });

  await writeMemory(
    {
      jobId: job.jobId,
      kind: 'preference',
      subjectKey,
      attribute: `תיקון — ${input.actionClass}`,
      body: { value: input.note },
      sourceRef: `סימון בדיעבד ${markId}`,
    },
    { businessId, db },
  );

  return { markId, remembered: true };
}
