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
 *
 * **What the grant this module writes actually buys today: nothing yet.**
 * `executeStep` does now set `useStandingAuthorization: true`, so the gate
 * reads the row instead of ignoring it — but reading it and being changed by
 * it are different things, and the next reader will meet this module
 * believing the owner has stopped being asked. They have not.
 * `needsApproval` (`src/policy/engine.ts`) is three disjuncts:
 *
 *   1. `NEVER_FULLY_AUTONOMOUS.has(actionClass)`
 *   2. `effective === 'approve_required'` — the ceiling the owner signed
 *   3. `!standing && risk.band !== 'routine'`
 *
 * A standing authorisation can only cancel the third. The first two stand
 * entirely outside its reach, deliberately: an instruction is momentary and a
 * signed ceiling is a durable, considered statement, which is the same limit
 * the first-contact exemption already keeps.
 *
 * And a third condition makes the point moot in every installation that
 * exists right now. `RAMP_FLOOR` (`orchestrator/ramp.ts`) is `draft_only` for
 * any class with no ramp row, nothing in production raises one — `ramp:set`
 * is a command a person runs — and stage 8 of the gate runs BEFORE stage 10,
 * so every outbound step of an instruction is denied `draft_only:
 * persist_as_draft` before the risk band this grant would relax is even
 * computed.
 *
 * So: the row is written, the row is read, and the owner keeps being asked,
 * until they raise a class's ramp above `approve_required` AND their signed
 * charter gives that class a ceiling above `approve_required`. Do not write
 * a sentence anywhere — comment, document or dashboard — that promises
 * otherwise.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import type { ActionClass } from '../domain/action.js';
import { planProblems, type Plan } from '../domain/plan.js';
import { grantAuthorization } from '../governance/authorization.js';
import {
  MAX_INSTRUCTION_CHARS,
  recordQuestion,
  saveInstruction,
  type InstructionRecord,
} from '../governance/instructions.js';
import { authorisedRecipients, emailAddressesIn } from '../governance/typed-recipients.js';
import { listContacts } from '../memory/contacts.js';
import { resolveContacts, type Ambiguity, type Resolution } from '../memory/contact-resolver.js';
import { recallForPlanning } from '../memory/recall-planning.js';
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
  /**
   * Set by the dashboard's answer route (spec §7.2) when it re-runs an
   * instruction the owner has already been asked to clarify once. Deliberately
   * coarse: it does not track which name was ambiguous, only that a second
   * pass is underway, so any second pass — not just one that resolves the
   * same name — suppresses the identity question. That coarseness is what
   * bounds the loop: without it, a name that stays ambiguous after an answer
   * would be asked about again, forever.
   */
  identityAsked?: boolean;
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
      /**
       * Set only when a name was still ambiguous on the second pass, so the
       * instruction went ahead with none of that person's memory (spec
       * §7.2's "ומציינת זאת").
       *
       * Carried out on the outcome rather than written anywhere, exactly as
       * `grantNote` above is, because it is the same kind of fact: the owner
       * has already been asked once, their answer did not settle it, and
       * without this sentence they would assume the memory was used. Silence
       * here is not neutral — it is a claim that nothing went unused.
       */
      identityNote: string | null;
    }
  | {
      status: 'needs_answer';
      jobId: string;
      instructionId: string;
      question: string;
      /**
       * The text this question was asked about — exactly what was stored.
       *
       * Carried on the outcome rather than re-read by the caller so the card
       * rendered immediately after a POST shows the same pairing the parked
       * list on `GET /instruct` shows, from one source.
       */
      instructionText: string;
    }
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

  // Two positive sources, never a guess: addresses the owner typed, and
  // contacts whose name appears in the instruction. `emailAddressesIn` is the
  // same extractor the standing-authorisation path uses — resolving a NAME is
  // new, and deliberately feeds memory only (spec §9): it does not widen who
  // may be written to.
  const typed = emailAddressesIn(input.text);
  let resolution: Resolution = { subjects: [], ambiguities: [] };
  try {
    resolution = resolveContacts(input.text, await listContacts({ businessId }));
  } catch {
    // A failed contact read degrades to no memory, never to a failed
    // instruction — the same trade the recall below already makes. Spec §10
    // row 1: the instruction proceeds with no memory AND no question, since
    // a read that never returned recognised nobody — which is a different
    // thing from recognising somebody ambiguously.
  }

  // Spec §6: more than one person fits the name, so nothing is planned and
  // nothing is sent until the owner says which. Asked once per chain (§7.2):
  // after an answer has come back, an unresolved name proceeds without memory
  // rather than asking again.
  if (resolution.ambiguities.length > 0 && options.identityAsked !== true) {
    const question = renderIdentityQuestion(resolution.ambiguities);
    try {
      await recordQuestion(instruction.instructionId, question, { businessId });
    } catch {
      // Swallowed by design, exactly as the planner's own question is.
    }
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question,
      instructionText: instruction.text,
    };
  }

  // Reached only when either nothing was ambiguous or the owner has already
  // been asked once, so a remaining ambiguity here is exactly spec §7.2's
  // case: proceed without that person's memory, and say so.
  const identityNote =
    resolution.ambiguities.length > 0
      ? renderIdentityNote(resolution.ambiguities.map((ambiguity) => ambiguity.token))
      : null;

  const subjects = [...typed, ...resolution.subjects];

  // A failed recall degrades to no memory block rather than failing the
  // instruction — planning without the past is worse than planning with it,
  // but not planning at all because a read failed is worse than both. Unlike
  // the planner call below, which throws for the ordinary failure mode of a
  // real call and must fail the job because there is no plan without it,
  // this one has a safe fallback and takes it instead.
  let memoryBlock = '';
  try {
    memoryBlock = await recallForPlanning(subjects, { businessId });
  } catch {
    memoryBlock = '';
  }

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
      ...(memoryBlock === '' ? {} : { memoryBlock }),
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
    // Written down before the answer is returned, so the question outlives
    // the HTTP response that carries it (I3). Until this line the question
    // existed only in that response: a reload orphaned the job in
    // `understand`, a phase nothing in the scheduler touches, with the owner
    // unable to see what they had been asked.
    //
    // Genuinely best-effort, matching `recordQuestion`'s own docblock: the
    // job is already parked and the instruction row already written, so a
    // failed UPDATE here must not reach the caller and turn a question into
    // a failed instruction. The owner still sees the job — `pendingQuestions`
    // lists it regardless — with `QUESTION_UNAVAILABLE` in place of the text
    // that failed to save (`src/dashboard/views.ts`).
    try {
      await recordQuestion(instruction.instructionId, plan.clarifyingQuestion, { businessId });
    } catch {
      // Swallowed by design — see above.
    }
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question: plan.clarifyingQuestion,
      instructionText: instruction.text,
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
    identityNote,
  };
}

/**
 * The sentence the owner reads when their answer did not settle who was
 * meant and the instruction went ahead anyway (spec §7.2).
 *
 * It says three things, in the order the owner needs them: which name went
 * unresolved, that the instruction ran WITHOUT what is remembered about that
 * person, and the one thing that fixes it — writing the address. Pointing at
 * the address is not incidental: it is the same path the identity question's
 * own no-detail branch offers, and the only one that both identifies the
 * person and (separately, through the charter) authorises writing to them.
 */
function renderIdentityNote(tokens: readonly string[]): string {
  const names = tokens.map((token) => `"${token}"`).join(', ');
  return tokens.length === 1
    ? `עדיין לא ידעתי לזהות בוודאות למי התכוונת ב-${names}, ולכן המשכתי בלי מה שאני ` +
        'זוכרת על אותו אדם. אם תכתוב לי את כתובת המייל שלו, אדע בפעם הבאה בדיוק במי מדובר.'
    : `עדיין לא ידעתי לזהות בוודאות למי התכוונת ב-${names}, ולכן המשכתי בלי מה שאני ` +
        'זוכרת על אותם אנשים. אם תכתוב לי את כתובות המייל שלהם, אדע בפעם הבאה בדיוק במי מדובר.';
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
 * **A plan spanning more than one action class WITH A NON-EMPTY COVERED SET
 * gets no grant at all.** The qualifier is the whole trigger and it used to
 * be missing here (M1): `byClass` only ever gains an entry for a class whose
 * `authorisedRecipients` came back non-empty, so a plan of `email.initiate`
 * to an address the owner typed plus `calendar.create` to one they never
 * named contributes exactly one entry and DOES get its grant. Counting
 * classes rather than covered classes would have described a stricter rule
 * than the code has, in a comment the next reader would have trusted.
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
      // The owner's own sentence, and it says what actually happened rather
      // than a simplification of it (M1): more than one class had a
      // recipient this instruction covers. A class whose recipients the
      // owner never named was never in the running and is not what caused
      // this.
      grantNote:
        'ההוראה נגעה ביותר מסוג פעולה אחד שאתה נקבת בנמען שלו, ולכן לא ניתנה הרשאה ' +
        'אוטומטית לאף אחד מהם — כל צעד בתוכנית יעבור את מסלול האישור הרגיל.',
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

/**
 * The question the owner is asked, carrying what distinguishes the candidates.
 *
 * It offers the distinguishing details rather than asking the owner to guess
 * which detail would help — that is what the owner's decision calls "another
 * identifying detail", and the answer comes back as more text on the same
 * instruction, which the same matcher then narrows on.
 */
function renderIdentityQuestion(ambiguities: readonly Ambiguity[]): string {
  const lines = ambiguities.map((ambiguity) => {
    // Positive check: does ANY candidate carry something that tells it apart
    // from the others? When none does, offering their bare names is a
    // question with no possible answer, so the owner is pointed at the one
    // path that both identifies the person and authorises writing to them —
    // typing the address — rather than being asked to guess.
    const hasDistinguishingDetail = ambiguity.candidates.some(
      (candidate) => candidate.company !== null || candidate.email !== null,
    );
    if (!hasDistinguishingDetail) {
      return (
        `יש לי כמה אנשי קשר בשם "${ambiguity.token}" ואין לי דרך להבחין ביניהם. ` +
        `כדי שאדע בדיוק למי לפנות, אפשר לכתוב את כתובת המייל או מספר הטלפון שלה/שלו.`
      );
    }

    const options = ambiguity.candidates
      .map((candidate) => {
        const details = [candidate.company, candidate.email].filter(
          (detail): detail is string => detail !== null,
        );
        return details.length === 0
          ? candidate.name
          : `${candidate.name} (${details.join(' · ')})`;
      })
      .join(' · ');
    return `למי התכוונת ב"${ambiguity.token}"? ${options}`;
  });
  return lines.join('\n');
}
