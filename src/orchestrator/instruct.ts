/**
 * The instruction door's pipeline: text in, a bound plan out.
 *
 * `provenance: 'boss'` is set here and is not a field on the input. A caller
 * able to ask for a provenance would be a caller able to forge an instruction,
 * and the whole authority of this path rests on the session that reached it —
 * the same structural rule `conduct.ts` keeps in the opposite direction.
 *
 * The order is deliberate: the cap is checked before the planner is called, so
 * a pasted document costs nothing; the plan is validated before anything is
 * bound; and the authorisation is granted only after the plan is known good,
 * because a grant against a plan that will not run is a grant nobody audits.
 *
 * Three more commits happen between that grant and the job reaching `execute`
 * — the `plan` transition, `bindPlanToJob`, and the `execute` transition — and
 * a crash between any of them can leave a grant committed for a job that never
 * gets there. That residue is inert, not merely unlikely: `coveredByAuthorization`
 * is only ever consulted for a step running under this job, and no phase but
 * `execute` ever runs a step, so an authorisation attached to a job stuck
 * anywhere else is simply never read. This paragraph exists so the ordering
 * above is not read as a claim that the four commits are atomic — they are
 * not, and do not need to be.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import type { ActionClass } from '../domain/action.js';
import { planProblems, type Plan } from '../domain/plan.js';
import { grantAuthorization } from '../governance/authorization.js';
import {
  MAX_INSTRUCTION_CHARS,
  saveInstruction,
  type InstructionRecord,
} from '../governance/instructions.js';
import { authorisedRecipients } from '../governance/typed-recipients.js';
import { readEmails, readPhones } from '../policy/facts.js';
import { makePlan, type PlanOutcome, type PlanRequest } from '../sdk/planner.js';
import { planStepIsFeasible } from './catalogue.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { classMismatch } from './run-plan.js';

export interface RunInstructionOptions {
  businessId?: string;
  /** The one step that costs money, injectable so the pipeline can be tested without an API key. */
  planner?: (request: PlanRequest) => Promise<PlanOutcome>;
}

export interface GrantedAuthorization {
  actionClass: ActionClass;
  recipients: string[];
}

export type InstructionOutcome =
  | {
      status: 'planned';
      jobId: string;
      instructionId: string;
      granted: GrantedAuthorization[];
      /**
       * Set only when a plan spanning more than one action class caused
       * `granted` to come back empty on purpose (see C1 in fix round 2). The
       * owner is about to be asked about something they may believe they
       * already authorised, and this is the sentence that tells them why.
       */
      grantNote: string | null;
    }
  | { status: 'needs_answer'; jobId: string; instructionId: string; question: string }
  | { status: 'refused'; reason: string };

export async function runInstruction(
  input: { text: string },
  options: RunInstructionOptions = {},
): Promise<InstructionOutcome> {
  const businessId = options.businessId ?? config.businessId;
  const planner = options.planner ?? makePlan;

  if (input.text.trim().length === 0) {
    return { status: 'refused', reason: 'ההוראה ריקה.' };
  }
  // Before the planner, on purpose: the cap exists to stop a pasted document,
  // and a cap enforced after the model call has already paid for the paste.
  if (input.text.length > MAX_INSTRUCTION_CHARS) {
    return {
      status: 'refused',
      reason: `ההוראה ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים. להעברת מסמך יש תיקיית קליטה.`,
    };
  }

  const active = await loadActiveCharter(businessId);
  if (active === null) {
    return { status: 'refused', reason: 'אין תקנון פעיל — המתכנן נשען על הקטלוג והתקרות שבו.' };
  }

  const job = await createJob({
    charterVersion: active.charter.charterVersion,
    // Not a parameter. See this module's header.
    provenance: 'boss',
    businessId,
    title: input.text.slice(0, 80),
  });

  let instruction: InstructionRecord;
  try {
    instruction = await saveInstruction({ jobId: job.jobId, text: input.text }, { businessId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transition(job.jobId, {
      to: 'failed',
      actor: 'human',
      reason: `instruction door: instruction could not be stored (${message})`,
      businessId,
    });
    // Fixed Hebrew for the owner; the raw error — Hebrew from saveInstruction's
    // own guard, or an English Postgres string otherwise — stays only in the
    // audit trail above, never surfaced as-is to whoever typed the instruction.
    return { status: 'refused', reason: 'לא הצלחתי לשמור את ההוראה.' };
  }

  await transition(job.jobId, {
    to: 'understand',
    actor: 'human',
    reason: `instruction door: ${instruction.instructionId}`,
    businessId,
  });

  let outcome: PlanOutcome;
  try {
    outcome = await planner({
      bundle: active.bundle,
      intents: [],
      instruction: input.text,
      provenance: 'boss',
      // The plan does not exist yet, so there is no per-class ramp to take a
      // minimum over. `draft_only` is what the catalogue is rendered against —
      // deliberately the floor, so the planner is never shown a capability the
      // gate would refuse. `rampLevelForPlan` is applied to the real plan by
      // `runDueJobs` when it runs.
      rampLevel: 'draft_only',
    });
  } catch (err) {
    // `makePlan` returns `{status:'unparseable'}` for bad model OUTPUT, but it
    // THROWS for the ordinary failure mode of a network call — a missing API
    // key, an HTTP error, a transport drop. Left uncaught, that throw leaves
    // the job sitting in `understand`, a phase nothing in production reads,
    // forever. The handler below this one already covers a clean refusal;
    // this one covers the call never returning one at all.
    const message = err instanceof Error ? err.message : String(err);
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: planner threw (${message})`,
      businessId,
    });
    return { status: 'refused', reason: 'קריאת המתכנן נכשלה ולא הצלחתי לבנות תוכנית.' };
  }

  if (outcome.status !== 'planned') {
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: ${outcome.reason}`,
      businessId,
    });
    return { status: 'refused', reason: 'לא הצלחתי להבין את ההוראה מספיק כדי לבנות תוכנית.' };
  }

  const plan = outcome.plan;

  // A question is not a plan. The job stops here and waits, and nothing is
  // bound or granted — see spec §8.
  if (plan.clarifyingQuestion !== null) {
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question: plan.clarifyingQuestion,
    };
  }

  const problems = planProblems(plan);
  if (problems.length > 0) {
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: plan invalid (${problems.map((p) => p.kind).join(', ')})`,
      businessId,
    });
    return { status: 'refused', reason: 'התוכנית שנבנתה אינה תקינה ולכן לא רצה.' };
  }

  // Everything below is pure — no database, no channel — which is exactly
  // what lets it run before the plan is bound or a grant is written. Left to
  // `runPlan`, either failure surfaces only after the job already reached
  // `execute`; `runPlan` rejects it every subsequent pass, `runDueJobs` does
  // not move the phase on that rejection, and the job sits at the front of
  // the scheduler's window forever — the same starvation `unbound` already
  // documents (`run-due.ts`) for its own case. Catching both here means a bad
  // plan fails once, loudly, in `understand`/`failed`, and never reaches
  // `execute` at all.
  for (const step of plan.steps) {
    if (!planStepIsFeasible(step.agent, step.toolName)) {
      await transition(job.jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: `instruction door: step ${step.id} not allowlisted (${step.agent} may not use ${step.toolName})`,
        businessId,
      });
      return { status: 'refused', reason: 'התוכנית משתמשת בכלי שאינו מורשה לסוכן שנבחר.' };
    }

    const mismatch = classMismatch(step);
    if (mismatch !== null) {
      await transition(job.jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: `instruction door: step ${step.id} class mismatch (${mismatch})`,
        businessId,
      });
      return { status: 'refused', reason: 'התוכנית סיווגה צעד אחרת ממה שהשער היה קובע בפועל.' };
    }
  }

  const { granted, grantNote } = await grantForPlan(
    job.jobId,
    plan,
    input.text,
    active.bundle.knownCounterparties,
    businessId,
  );

  await transition(job.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'instruction door: plan accepted',
    businessId,
  });

  const binding = await bindPlanToJob(job.jobId, plan, { businessId });
  if (binding.status === 'conflict') {
    // Cannot happen for a job this function just created — this is the first
    // plan ever offered for it — but `bindPlanToJob` returns a result rather
    // than throwing, and a caller that does not read it is the exact defect
    // CLAUDE.md names: an adapter (or, here, a store) hands back an outcome
    // and the caller discards it. Reading it costs nothing and means this
    // stops being true by convention instead of by construction.
    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `instruction door: plan binding conflict (stored ${binding.storedHash.slice(0, 12)} vs offered ${binding.offeredHash.slice(0, 12)})`,
      businessId,
    });
    return { status: 'refused', reason: 'התוכנית התנגשה עם תוכנית קיימת עבור העבודה הזו.' };
  }

  await transition(job.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'instruction door: bound and ready',
    businessId,
  });

  return {
    status: 'planned',
    jobId: job.jobId,
    instructionId: instruction.instructionId,
    granted,
    grantNote,
  };
}

interface GrantForPlanResult {
  granted: GrantedAuthorization[];
  grantNote: string | null;
}

/**
 * One grant per action class the plan declares, carrying only the recipients
 * that instruction actually authorises.
 *
 * A class whose covered set is empty gets no row at all rather than an empty
 * one: `coveredByAuthorization` already refuses an empty recipient list, and a
 * row that authorises nobody is a record of permission that was never given.
 *
 * **A plan spanning more than one action class gets no grant at all.**
 * `job_authorizations` is `PRIMARY KEY (business_id, job_id)` — one row per
 * job, by the schema's own shape — and `grantAuthorization` turns a second
 * insert for the same job into a thrown `AuthorizationAlreadyGrantedError`.
 * An ordinary two-step instruction ("send Dana the proposal and book her for
 * Tuesday") names two allowlisted classes carrying the same typed address,
 * and writing the first grant and then reaching for the second would throw
 * out of a function whose type promises an outcome, not an exception — the
 * first grant would commit, the job would be stranded, and nothing about
 * which class "won" was ever a decision anyone made on purpose. Refusing to
 * choose silently is the same reasoning already applied to an empty covered
 * set, one level up: every step in a multi-class plan takes the ordinary
 * approval path instead, which is the safe direction, and the instruction
 * still runs — only the shortcut is withheld, never the instruction itself.
 */
async function grantForPlan(
  jobId: string,
  plan: Plan,
  instruction: string,
  known: Parameters<typeof authorisedRecipients>[0]['known'],
  businessId: string,
): Promise<GrantForPlanResult> {
  const byClass = new Map<ActionClass, Set<string>>();

  for (const step of plan.steps) {
    const actionClass = step.expectedActionClass;
    // The planner's declared class is advisory and the gate classifies for
    // itself, so a step that declares nothing grants nothing — "the planner
    // did not say" must read as "no permission was widened".
    if (actionClass === null) continue;

    const covered = authorisedRecipients({
      instruction,
      actionClass,
      // Emails and phones both. A WhatsApp step's recipient is a number, and
      // Task 3 widened `coveredByAuthorization` to see them for the same
      // reason — a grant the gate cannot match is a grant that does nothing.
      candidates: [...readEmails(step.input), ...readPhones(step.input)],
      known,
    });
    if (covered.length === 0) continue;

    const bucket = byClass.get(actionClass) ?? new Set<string>();
    for (const address of covered) bucket.add(address);
    byClass.set(actionClass, bucket);
  }

  // Decided explicitly, before a single `grantAuthorization` call, rather
  // than letting the table's primary key decide it via a thrown unique
  // violation. See this function's docblock.
  if (byClass.size > 1) {
    return {
      granted: [],
      grantNote:
        'ההוראה נגעה ביותר ממחלקת פעולה אחת, ולכן לא ניתנה הרשאה אוטומטית לאף אחת מהן — ' +
        'כל צעד בתוכנית יעבור את מסלול האישור הרגיל.',
    };
  }

  const granted: GrantedAuthorization[] = [];
  for (const [actionClass, addresses] of byClass) {
    const recipients = [...addresses].sort();
    await grantAuthorization({ jobId, actionClass, recipients }, { businessId, db: getPool() });
    granted.push({ actionClass, recipients });
  }
  return { granted, grantNote: null };
}
