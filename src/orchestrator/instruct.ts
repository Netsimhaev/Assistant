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
import { createJob, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';

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
    await transition(job.jobId, {
      to: 'failed',
      actor: 'human',
      reason: 'instruction door: instruction could not be stored',
      businessId,
    });
    return { status: 'refused', reason: err instanceof Error ? err.message : String(err) };
  }

  await transition(job.jobId, {
    to: 'understand',
    actor: 'human',
    reason: `instruction door: ${instruction.instructionId}`,
    businessId,
  });

  const outcome = await planner({
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

  const granted = await grantForPlan(job.jobId, plan, input.text, active.bundle.knownCounterparties, businessId);

  await transition(job.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'instruction door: plan accepted',
    businessId,
  });
  await bindPlanToJob(job.jobId, plan, { businessId });
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
  };
}

/**
 * One grant per action class the plan declares, carrying only the recipients
 * that instruction actually authorises.
 *
 * A class whose covered set is empty gets no row at all rather than an empty
 * one: `coveredByAuthorization` already refuses an empty recipient list, and a
 * row that authorises nobody is a record of permission that was never given.
 */
async function grantForPlan(
  jobId: string,
  plan: Plan,
  instruction: string,
  known: Parameters<typeof authorisedRecipients>[0]['known'],
  businessId: string,
): Promise<GrantedAuthorization[]> {
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

  const granted: GrantedAuthorization[] = [];
  for (const [actionClass, addresses] of byClass) {
    const recipients = [...addresses].sort();
    await grantAuthorization({ jobId, actionClass, recipients }, { businessId, db: getPool() });
    granted.push({ actionClass, recipients });
  }
  return granted;
}
