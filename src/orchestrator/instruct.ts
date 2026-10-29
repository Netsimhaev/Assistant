/**
 * The instruction door's pipeline: text in, a bound plan out.
 *
 * **A plan with a side effect does not go straight to `execute` (boss
 * command, spec 2026-10-28).** When any step is a classified action
 * (`classifyAction(...) !== null`, §10.4) the plan is bound and the job is
 * PARKED in `plan` — inert, since `runDueJobs` takes only `execute` (§10.1) —
 * beside a pending `instruction_confirmations` row, and the confirmation
 * question is returned (`needs_confirmation`). A plan of reads only runs as
 * before. When a name fits two or three distinguishable contacts, each
 * candidate is planned separately with its identity in
 * `PlanRequest.resolvedContact` — never appended to `instruction`, which
 * stays the stored text byte for byte — and the owner's pick among the plans
 * is the confirmation, so nothing is bound until he picks (§4.2, §10.6,
 * §10.9). The catalogue on this path is rendered at `auto` (§10.10): the
 * question, not the planner's caution, is the control.
 *
 * `provenance: 'boss'` is set here and is not a field on the input. A caller
 * able to ask for a provenance would be a caller able to forge an instruction,
 * and the whole authority of this path rests on the session that reached it —
 * the same structural rule `conduct.ts` keeps in the opposite direction.
 *
 * **`textOrigin` is the opposite case and is a required option for exactly
 * that reason.** `provenance` has one correct value here, so it is a literal;
 * where the text came from genuinely differs by door — a dashboard form is
 * the owner's keystrokes, a WhatsApp voice note is a transcription
 * provider's model output that nobody typed — so it cannot be fixed in this
 * file. What it must never be is optional: the standing authorisation this
 * module writes rests on "the owner typed this address himself", and a door
 * that said nothing would inherit that claim for free. Required, no default,
 * no `??`. See `RunInstructionOptions.textOrigin` below.
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
import type { PolicyBundle } from '../domain/policy.js';
import { grantAuthorization } from '../governance/authorization.js';
import {
  createConfirmation,
  type ConfirmationChannel,
  type ConfirmationOption,
} from '../governance/instruction-confirmations.js';
import {
  MAX_INSTRUCTION_CHARS,
  recordQuestion,
  saveInstruction,
  type InstructionRecord,
} from '../governance/instructions.js';
import {
  authorisedRecipients,
  emailAddressesIn,
  recipientsOnlyInRecording,
  type InstructionTextOrigin,
} from '../governance/typed-recipients.js';
import { listContacts, type Contact } from '../memory/contacts.js';
import { resolveContacts, type Ambiguity, type Resolution } from '../memory/contact-resolver.js';
import { recallForPlanning } from '../memory/recall-planning.js';
import { classifyAction } from '../policy/classify.js';
import { readEmails, readPhones } from '../policy/facts.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import { nameCarriesCancelWord } from './command-confirm.js';
import { makePlan, type PlanOutcome, type PlanRequest } from '../sdk/planner.js';
import { planStepIsFeasible } from './catalogue.js';
import { renderConfirmationQuestion } from './command-echo.js';
import { createJob, transition } from './jobs.js';
import { bindPlanToJob, planHashOf } from './plan-store.js';
import { classMismatch } from './run-plan.js';

export interface RunInstructionOptions {
  /**
   * Where `input.text`'s bytes came from — **required, with no default**.
   *
   * `provenance` is not a field here at all, because it has one correct
   * value on this path and a caller able to aim it would be a caller able to
   * forge an instruction (see this module's header). This one genuinely
   * varies by door, so it cannot be a literal — but it decides the same kind
   * of thing, so it is required instead: `CredentialSource.resolve`
   * (`src/orchestrator/credentials.ts`) makes exactly this trade for exactly
   * this reason, "required means an omission is a compile error rather than
   * a wrong lookup at run time". There is deliberately no `?? 'typed'`
   * anywhere: a door added later cannot inherit the permissive answer by
   * saying nothing.
   *
   * **The one rule for a caller: derive it from HOW the message arrived,
   * never from anything inside the text.** The WhatsApp door reads it off
   * `mediaKind`; the dashboard states `'typed'` because an HTML form
   * submission is the owner's own keystrokes. Both are pinned structurally
   * (`whatsapp-invariants.test.ts`), because a value read out of the text
   * would be authority derived from content — the thing this whole field
   * exists to prevent.
   *
   * For text that JOINS two halves — an answer to a clarifying question —
   * `'typed'` holds only if both halves were typed. Each caller computes
   * that from the stored origin of the half it is joining to
   * (`InstructionRecord.textOrigin`), positively.
   */
  textOrigin: InstructionTextOrigin;
  /**
   * The door the instruction arrived through — **required, no default**,
   * for the same reason `textOrigin` is. A plan with a side effect parks on a
   * confirmation question (boss command, spec §4), and the question is
   * answered in the channel it was asked in; a door that said nothing would
   * leave the question with nowhere to be answered.
   */
  channel: ConfirmationChannel;
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
       * Set only when the instruction's text came from a recording AND that
       * is what withheld a recipient the owner would otherwise have
       * authorised by typing it (`recipientsOnlyInRecording`).
       *
       * The owner's ruling of 05/10/2026 has two halves and this is the
       * second one: a clear transcript authorises the action, and an address
       * that appears only in a recording needs his explicit confirmation.
       * Withholding the grant is the first half; **saying so is the other**,
       * and without it he gives a spoken instruction, watches it be planned,
       * and later meets an approval card for a recipient he believes he
       * already named — the same silence `grantNote` above exists to break,
       * from a different cause.
       *
       * Null whenever nothing was actually withheld for this reason: a typed
       * instruction, a recording whose recipients the charter already knows,
       * or a class no instruction could authorise anyway. A note that fires
       * when the thing it describes did not happen is how a real notice
       * stops being read.
       */
      recordingNote: string | null;
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
      /**
       * The same fact as `identityNote` on `planned`, on the outcome where it
       * is most likely to be true — which is why it is here at all.
       *
       * A measured live run: the name stayed unresolved, so the memory block
       * came back empty, so the planner had no context and returned its own
       * clarifying question, so the instruction ended `needs_answer` and the
       * note — which rode `planned` alone — was never rendered. The owner was
       * shown a generic question about "רונית" and told nothing about the name
       * not having been recognised. The two are not merely co-occurring: the
       * missing memory is what produced the question.
       *
       * The two returns that produce this status set it differently on
       * purpose, and each says why at its own site.
       */
      identityNote: string | null;
    }
  | {
      /**
       * Boss command, spec §4: the plan has at least one classified step, so
       * the job is parked in `plan` (§10.1) beside a pending
       * `instruction_confirmations` row and nothing runs until the owner
       * answers. With one option the plan is already bound; with several
       * (one per candidate contact, §4.2) nothing is bound until he picks.
       */
      status: 'needs_confirmation';
      jobId: string;
      /** Exactly the text stored as the row's `presented_text`. */
      question: string;
      optionCount: number;
      /**
       * The same fact as on `planned`: a name stayed ambiguous after an
       * answer, so the plan was made without that person's memory. Carried
       * here too, because a side-effecting instruction now ends on this
       * outcome instead of `planned`, and dropping the note would silence
       * spec §7.2's "ומציינת זאת" for exactly those instructions.
       */
      identityNote: string | null;
    }
  | { status: 'refused'; reason: string };

export async function runInstruction(
  input: { text: string },
  options: RunInstructionOptions,
): Promise<InstructionOutcome> {
  const businessId = options.businessId ?? config.businessId;
  const planner = options.planner ?? makePlan;
  // Read once, used for the stored row and for the grant, so the bytes that
  // were saved and the bytes that were weighed for authority can never be
  // described differently. No default — see the option's own docblock.
  const textOrigin = options.textOrigin;

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
    instruction = await saveInstruction(
      { jobId: job.jobId, text: input.text, textOrigin },
      { businessId },
    );
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

  // Two positive sources, never a guess: addresses that appear in the text,
  // and contacts whose name appears in it. `emailAddressesIn` is the same
  // extractor the standing-authorisation path uses — resolving a NAME is
  // new, and deliberately feeds memory only (spec §9): it does not widen who
  // may be written to.
  //
  // **Deliberately blind to `textOrigin`, and that is not an oversight.**
  // This feeds the recall scope below and nothing else: which of the
  // business's own remembered facts the planner is shown. Recall is reading,
  // every row it returns carries its own provenance label, and no authority
  // follows from it — so an address the owner only said out loud still
  // scopes the memory block, exactly as it did before the origin rule. The
  // only thing a recording stops buying is who may be contacted.
  const addressesInText = emailAddressesIn(input.text);
  let contacts: Contact[] = [];
  let resolution: Resolution = { subjects: [], ambiguities: [] };
  try {
    contacts = await listContacts({ businessId });
    resolution = resolveContacts(input.text, contacts);
  } catch {
    // A failed contact read degrades to no memory, never to a failed
    // instruction — the same trade the recall below already makes. Spec §10
    // row 1: the instruction proceeds with no memory AND no question, since
    // a read that never returned recognised nobody — which is a different
    // thing from recognising somebody ambiguously.
  }

  const door: DoorContext = {
    businessId,
    jobId: job.jobId,
    instruction,
    planner,
    channel: options.channel,
    textOrigin,
    bundle: active.bundle,
  };

  // Spec §6: more than one person fits the name, so nothing is sent until the
  // owner says which. Asked once per chain (§7.2): after an answer has come
  // back, an unresolved name proceeds without memory rather than asking again.
  if (resolution.ambiguities.length > 0 && options.identityAsked !== true) {
    // Boss command, spec §4.2: a small, distinguishable set of candidates is
    // planned once each, and the owner's choice among the plans IS the
    // confirmation. Anything else keeps today's identity question.
    const candidates = candidatesToPlan(resolution.ambiguities);
    if (candidates !== null) {
      return planPerCandidate(
        door,
        candidates,
        [...addressesInText, ...resolution.subjects],
        renderIdentityQuestion(resolution.ambiguities),
      );
    }

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
      // Null on purpose, and this is the one return where it must be: the
      // question above IS the notice that the name was not recognised, and
      // nothing has gone ahead without the memory yet — nothing has gone
      // ahead at all. A note repeating the question beside the question is
      // noise, and noise beside a real notice is how a real notice stops
      // being read.
      identityNote: null,
    };
  }

  // Reached only when either nothing was ambiguous or the owner has already
  // been asked once, so a remaining ambiguity here is exactly spec §7.2's
  // case: proceed without that person's memory, and say so.
  const identityNote =
    resolution.ambiguities.length > 0
      ? renderIdentityNote(resolution.ambiguities.map((ambiguity) => ambiguity.token))
      : null;

  const checked = await planAndCheck(door, [...addressesInText, ...resolution.subjects], undefined);

  if (checked.kind === 'question') {
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
      await recordQuestion(instruction.instructionId, checked.question, { businessId });
    } catch {
      // Swallowed by design — see above.
    }
    return {
      status: 'needs_answer',
      jobId: job.jobId,
      instructionId: instruction.instructionId,
      question: checked.question,
      instructionText: instruction.text,
      // Carried, unlike the identity question's own return above: this
      // question is the PLANNER's, about something else entirely, and it is
      // the likeliest place the note is true — an unresolved name empties the
      // memory block, and a planner with no context asks. Without it the
      // owner reads a question about the work and concludes the name was
      // understood.
      identityNote,
    };
  }

  if (checked.kind === 'refused') {
    await failJob(door, checked.audit);
    return { status: 'refused', reason: checked.reason };
  }

  return finishSingle(door, {
    plan: checked.plan,
    label: SINGLE_OPTION_LABEL,
    contactSource: contactSourceOf(
      contacts.filter((contact) =>
        contact.subjectKeys.some((key) => resolution.subjects.includes(key)),
      ),
    ),
    identityNote,
  });
}

/** Everything one instruction's planning passes share. */
interface DoorContext {
  businessId: string;
  jobId: string;
  instruction: InstructionRecord;
  planner: (request: PlanRequest) => Promise<PlanOutcome>;
  channel: ConfirmationChannel;
  textOrigin: InstructionTextOrigin;
  bundle: PolicyBundle;
}

/**
 * The label of a single-option question. Fixed text rather than the plan's
 * `goal`: the goal is model output, and the line the owner reads above the
 * echo must not be something the planner chose to say about its own plan.
 */
const SINGLE_OPTION_LABEL = 'לבצע את הפעולות הבאות?';

/** The most candidates planned separately; past this, the identity question stays (spec §4.2). */
const MAX_PLANNED_CANDIDATES = 3;

type CheckedPlan =
  | { kind: 'plan'; plan: Plan }
  | { kind: 'question'; question: string }
  /** `reason` is the owner's Hebrew sentence; `audit` the English `job_steps.reason`. */
  | { kind: 'refused'; reason: string; audit: string };

/**
 * One planner call and the validation chain every plan from this door goes
 * through — the same chain whether the plan is the only one or one of several
 * candidates (spec §10.9). Pure apart from the recall read and the planner
 * call: no transition, no binding, no grant; the caller decides what a
 * refusal does to the job.
 */
async function planAndCheck(
  door: DoorContext,
  subjects: string[],
  resolvedContact: string | undefined,
): Promise<CheckedPlan> {
  // A failed recall degrades to no memory block rather than failing the
  // instruction — planning without the past is worse than planning with it,
  // but not planning at all because a read failed is worse than both. Unlike
  // the planner call below, which throws for the ordinary failure mode of a
  // real call and must fail the job because there is no plan without it,
  // this one has a safe fallback and takes it instead.
  let memoryBlock = '';
  try {
    memoryBlock = await recallForPlanning(subjects, { businessId: door.businessId });
  } catch {
    memoryBlock = '';
  }

  let outcome: PlanOutcome;
  try {
    outcome = await door.planner({
      bundle: door.bundle,
      intents: [],
      // The stored text, byte for byte. A candidate's identity travels in
      // `resolvedContact` and NEVER here: this field is weighed as the
      // owner's own words (spec §10.6, `instruction-invariants.test.ts`).
      instruction: door.instruction.text,
      ...(resolvedContact === undefined ? {} : { resolvedContact }),
      provenance: 'boss',
      // Spec §10.10: on the instruction path the confirmation question is
      // the control, so the planner is shown the catalogue at `auto` — at
      // `draft_only` it leaned on `mail.draft` for everything. The gate still
      // applies the real ramp (`rampLevelForPlan`) when the plan runs.
      rampLevel: 'auto',
      ...(memoryBlock === '' ? {} : { memoryBlock }),
    });
  } catch (err) {
    // `makePlan` returns `{status:'unparseable'}` for bad model OUTPUT, but it
    // THROWS for the ordinary failure mode of a network call — a missing API
    // key, an HTTP error, a transport drop. Left uncaught, that throw leaves
    // the job sitting in `understand`, a phase nothing in production reads,
    // forever.
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'refused',
      reason: 'קריאת המתכנן נכשלה ולא הצלחתי לבנות תוכנית.',
      audit: `instruction door: planner threw (${message})`,
    };
  }

  if (outcome.status !== 'planned') {
    return {
      kind: 'refused',
      reason: 'לא הצלחתי להבין את ההוראה מספיק כדי לבנות תוכנית.',
      audit: `instruction door: ${outcome.reason}`,
    };
  }

  const plan = outcome.plan;

  // A question is not a plan. The job stops and waits, and nothing is bound
  // or granted — see spec §8.
  if (plan.clarifyingQuestion !== null) {
    return { kind: 'question', question: plan.clarifyingQuestion };
  }

  const problems = planProblems(plan);
  if (problems.length > 0) {
    return {
      kind: 'refused',
      reason: 'התוכנית שנבנתה אינה תקינה ולכן לא רצה.',
      audit: `instruction door: plan invalid (${problems.map((p) => p.kind).join(', ')})`,
    };
  }

  // Everything below is pure — no database, no channel — which is exactly
  // what lets it run before the plan is bound or a grant is written. Left to
  // `runPlan`, either failure surfaces only after the job already reached
  // `execute`; `runPlan` rejects it every subsequent pass, `runDueJobs` does
  // not move the phase on that rejection, and the job sits at the front of
  // the scheduler's window forever — the same starvation `unbound` already
  // documents (`run-due.ts`) for its own case. Catching both here means a bad
  // plan fails once, loudly, and never reaches `execute` at all.
  for (const step of plan.steps) {
    if (!planStepIsFeasible(step.agent, step.toolName)) {
      return {
        kind: 'refused',
        reason: 'התוכנית משתמשת בכלי שאינו מורשה לסוכן שנבחר.',
        audit: `instruction door: step ${step.id} not allowlisted (${step.agent} may not use ${step.toolName})`,
      };
    }

    const mismatch = classMismatch(step);
    if (mismatch !== null) {
      return {
        kind: 'refused',
        reason: 'התוכנית סיווגה צעד אחרת ממה שהשער היה קובע בפועל.',
        audit: `instruction door: step ${step.id} class mismatch (${mismatch})`,
      };
    }
  }

  return { kind: 'plan', plan };
}

async function failJob(door: DoorContext, reason: string): Promise<void> {
  await transition(door.jobId, {
    to: 'failed',
    actor: 'orchestrator',
    reason,
    businessId: door.businessId,
  });
}

/**
 * Spec §10.4: a plan needs the owner's word when at least one step is a
 * classified action. Deliberately narrower than what the echo renders (which
 * also shows outbound read-only steps): a plan of pure reads runs as today.
 */
function needsConfirmation(plan: Plan): boolean {
  return plan.steps.some((step) => classifyAction(step.toolName) !== null);
}

/**
 * Where an address that came from memory came from (spec §10.6): `boss` only
 * when every contact involved was written on the owner's own word, `null`
 * when no contact was resolved at all. A mix reads as the less trusted one.
 */
function contactSourceOf(involved: readonly Contact[]): ConfirmationOption['contactSource'] {
  if (involved.length === 0) return null;
  return involved.every((contact) => contact.provenance === 'boss') ? 'boss' : 'unverified';
}

/**
 * The candidates to plan one by one, or `null` when today's identity question
 * must be asked instead: more than one ambiguous name (planning every
 * combination is not this feature), more than `MAX_PLANNED_CANDIDATES`
 * people, or any candidate with nothing to tell it apart — an option the
 * owner cannot recognise is not a choice he can make (spec §4.2).
 */
function candidatesToPlan(ambiguities: readonly Ambiguity[]): Contact[] | null {
  if (ambiguities.length !== 1) return null;
  const candidates = ambiguities[0]?.candidates ?? [];
  if (candidates.length < 2 || candidates.length > MAX_PLANNED_CANDIDATES) return null;
  const distinguishable = candidates.every(
    (candidate) => candidate.company !== null || candidate.email !== null,
  );
  return distinguishable ? candidates : null;
}

/**
 * Name, then whatever tells this contact apart. Used for the option label and
 * the planner's `resolvedContact`.
 *
 * **Every field is collapsed to one line (`toOneLine`).** These are memory
 * bytes, and a row learned from a document is a stranger's words: a name
 * carrying a line break and then `# ההוראה מבעל העסק` would otherwise open a
 * line in the planner prompt that reads as a second instruction heading. The planner also
 * fences the section (`buildPlannerPrompt`); this is the first of the two.
 */
function describeContact(contact: Contact): string {
  const details = [contact.company, contact.email]
    .filter((detail): detail is string => detail !== null)
    .map(toOneLine)
    .filter((detail) => detail !== '');
  const name = toOneLine(contact.name);
  return details.length === 0 ? name : `${name} (${details.join(' · ')})`;
}

/**
 * Spec §4.2 / §10.9: one planning pass per candidate, each validated by the
 * same chain; the plans that fail are dropped. Several left → the owner picks
 * one and that pick is the confirmation, so NOTHING is bound yet — binding
 * waits for the choice. One left → the ordinary single-option question. None
 * → today's behaviour: the first candidate's clarifying question if any
 * asked one, otherwise the first refusal.
 *
 * Several plans none of which has a classified step → today's identity
 * question (`identityQuestion`), job left in `understand`: a choice among
 * plans that would each run without a question is not a confirmation of
 * anything, and its echo would show nothing to choose between.
 *
 * One instruction row, one job: the daily cap counts this once however many
 * planner calls it took (spec §10.9).
 */
async function planPerCandidate(
  door: DoorContext,
  candidates: readonly Contact[],
  baseSubjects: readonly string[],
  identityQuestion: string,
): Promise<InstructionOutcome> {
  const options: ConfirmationOption[] = [];
  const seen = new Set<string>();
  let firstQuestion: string | null = null;
  let firstRefusal: { reason: string; audit: string } | null = null;

  for (const candidate of candidates) {
    // A name with a cancel word in it ("דנה בטל") is no real person's: it was
    // planted so the owner's own "בטל" would read as a pick. Left out before
    // it costs a planner call (`nameCarriesCancelWord`, `command-confirm.ts`).
    if (nameCarriesCancelWord(candidate.name)) continue;
    const checked = await planAndCheck(
      door,
      [...baseSubjects, ...candidate.subjectKeys],
      describeContact(candidate),
    );
    if (checked.kind === 'question') {
      firstQuestion ??= checked.question;
      continue;
    }
    if (checked.kind === 'refused') {
      firstRefusal ??= { reason: checked.reason, audit: checked.audit };
      continue;
    }
    const planHash = planHashOf(checked.plan);
    // Two candidates that produced the very same plan are one choice, not
    // two: a numbered list where two numbers do the same thing is noise, and
    // the confirmation store refuses repeated hashes anyway.
    if (seen.has(planHash)) continue;
    seen.add(planHash);
    // The name alone, one line, for the confirm reader to match a typed name
    // against (`command-confirm.ts`) without parsing it out of the label.
    const contactName = toOneLine(candidate.name);
    options.push({
      label: describeContact(candidate),
      planHash,
      plan: checked.plan,
      contactSource: contactSourceOf([candidate]),
      ...(contactName !== '' ? { contactName } : {}),
    });
  }

  const only = options[0];
  if (options.length === 1 && only !== undefined) {
    return finishSingle(door, {
      plan: only.plan,
      label: only.label,
      contactSource: only.contactSource,
      identityNote: null,
    });
  }

  if (options.length === 0) {
    if (firstQuestion !== null) return askOwner(door, firstQuestion);
    const refusal = firstRefusal ?? {
      reason: 'לא הצלחתי לבנות תוכנית.',
      audit: 'instruction door: no candidate produced a plan',
    };
    await failJob(door, refusal.audit);
    return { status: 'refused', reason: refusal.reason };
  }

  if (!options.some((option) => needsConfirmation(option.plan))) {
    return askOwner(door, identityQuestion);
  }

  const rendered = renderConfirmationQuestion(options);
  if ('refused' in rendered) {
    await failJob(door, 'instruction door: confirmation question refused (step too long to show)');
    return { status: 'refused', reason: rendered.refused };
  }

  // Parked in `plan` (spec §10.1) with NOTHING bound: the plan that runs is
  // the one the owner picks, bound only after the pick (spec §4.4).
  await transition(door.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: `instruction door: ${options.length} candidate plans await the owner's choice`,
    businessId: door.businessId,
  });
  return askAndPark(door, options, rendered.text, null);
}

/**
 * Park the job in `understand` on a question and return it (`needs_answer`).
 * The question is written down best-effort, exactly as on the single-plan
 * path: the job is already parked and the instruction row already exists, so
 * a failed UPDATE must not turn a question into a failed instruction.
 */
async function askOwner(door: DoorContext, question: string): Promise<InstructionOutcome> {
  try {
    await recordQuestion(door.instruction.instructionId, question, { businessId: door.businessId });
  } catch {
    // Swallowed by design — see above.
  }
  return {
    status: 'needs_answer',
    jobId: door.jobId,
    instructionId: door.instruction.instructionId,
    question,
    instructionText: door.instruction.text,
    identityNote: null,
  };
}

/**
 * The last step for a single plan. A plan with no classified step runs as it
 * always has — granted, bound, moved to `execute`. One with a classified step
 * is bound and then parked in `plan` (spec §10.1), never moved to `execute`,
 * and the confirmation question is stored and returned.
 */
async function finishSingle(
  door: DoorContext,
  single: {
    plan: Plan;
    label: string;
    contactSource: ConfirmationOption['contactSource'];
    identityNote: string | null;
  },
): Promise<InstructionOutcome> {
  const { plan } = single;
  const confirming = needsConfirmation(plan);

  // Rendered BEFORE anything is granted or bound, so a plan too long to show
  // whole fails with nothing written behind it.
  let question: string | null = null;
  let option: ConfirmationOption | null = null;
  if (confirming) {
    option = {
      label: single.label,
      planHash: planHashOf(plan),
      plan,
      contactSource: single.contactSource,
    };
    const rendered = renderConfirmationQuestion([option]);
    if ('refused' in rendered) {
      await failJob(door, 'instruction door: confirmation question refused (step too long to show)');
      return { status: 'refused', reason: rendered.refused };
    }
    question = rendered.text;
  }

  const { granted, grantNote, recordingNote } = await grantForPlan(
    door.jobId,
    plan,
    door.instruction.text,
    door.textOrigin,
    door.bundle.knownCounterparties,
    door.businessId,
  );

  await transition(door.jobId, {
    to: 'plan',
    actor: 'orchestrator',
    reason: 'instruction door: plan accepted',
    businessId: door.businessId,
  });

  const binding = await bindPlanToJob(door.jobId, plan, { businessId: door.businessId });
  if (binding.status === 'conflict') {
    // Cannot happen for a job this function just created — this is the first
    // plan ever offered for it — but `bindPlanToJob` returns a result rather
    // than throwing, and a caller that does not read it is the exact defect
    // CLAUDE.md names: an adapter (or, here, a store) hands back an outcome
    // and the caller discards it. Reading it costs nothing and means this
    // stops being true by convention instead of by construction.
    await failJob(
      door,
      `instruction door: plan binding conflict (stored ${binding.storedHash.slice(0, 12)} vs offered ${binding.offeredHash.slice(0, 12)})`,
    );
    return { status: 'refused', reason: 'התוכנית התנגשה עם תוכנית קיימת עבור העבודה הזו.' };
  }

  if (option !== null && question !== null) {
    // Bound, and parked: `plan` is inert (`runDueJobs` takes only `execute`),
    // so nothing runs until the owner answers.
    return askAndPark(door, [option], question, single.identityNote);
  }

  await transition(door.jobId, {
    to: 'execute',
    actor: 'orchestrator',
    reason: 'instruction door: bound and ready',
    businessId: door.businessId,
  });

  return {
    status: 'planned',
    jobId: door.jobId,
    instructionId: door.instruction.instructionId,
    granted,
    grantNote,
    recordingNote,
    identityNote: single.identityNote,
  };
}

/**
 * Store the pending confirmation and return the question. A store failure
 * fails the job rather than leaving it parked with no question anyone can
 * answer — a job in `plan` with no confirmation row is one nothing revisits.
 */
async function askAndPark(
  door: DoorContext,
  options: ConfirmationOption[],
  question: string,
  identityNote: string | null,
): Promise<InstructionOutcome> {
  try {
    await createConfirmation(
      { jobId: door.jobId, options, presentedText: question, channel: door.channel },
      { businessId: door.businessId },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(door, `instruction door: confirmation could not be stored (${message})`);
    return { status: 'refused', reason: 'לא הצלחתי לשמור את שאלת האישור.' };
  }
  return {
    status: 'needs_confirmation',
    jobId: door.jobId,
    question,
    optionCount: options.length,
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
  recordingNote: string | null;
}

/**
 * The sentence the owner reads when his instruction came from a recording and
 * that is what kept a recipient off the standing authorisation.
 *
 * **Worded to be true of a joined instruction as well as a purely spoken
 * one**, which is why it says "includes text that came from a recording"
 * rather than "this address came from the recording". An answer to a
 * clarifying question is planned over the join of the stored instruction and
 * the new answer, so one of the two halves can be typed — and if the owner
 * typed the address in that half, this still withholds it (the origin is one
 * value for the whole text, deliberately: see the option's docblock) and a
 * sentence claiming the address came from the recording would be false. What
 * it does claim is exactly what happened: part of this text was not typed, so
 * nothing in it was treated as an address the owner named himself, and here
 * is what consequently needs his word.
 *
 * It names the recipients, because "something needs confirming" the owner
 * cannot act on is the kind of notice that trains him to ignore notices.
 *
 * **Each recipient goes through `stripBidiControls` before it is quoted, and
 * that strip belongs HERE rather than at either reader.** On this path the
 * address reached the plan through a transcription provider's model, which is
 * the least trusted text that ever reaches a sentence the owner reads — and
 * the note travels to two surfaces with different escapers: the dashboard
 * passes it through `escLabel` (which strips the same set, plus HTML escapes)
 * and the WhatsApp ack is plain text with no escaping at all, where an HTML
 * entity would render literally. `whatsapp-routing.ts`'s `instructionSnippet`
 * makes exactly this call for exactly this reason. Stripping once, where the
 * sentence is composed, is what keeps the WhatsApp surface from being the one
 * that forgot — an address carrying a right-to-left override can otherwise
 * reorder the sentence that explains why it needs confirming, so the owner
 * reads one thing and confirms another.
 */
function renderRecordingNote(recipients: readonly string[]): string {
  const names = recipients.map((recipient) => `"${stripBidiControls(recipient)}"`).join(', ');
  return recipients.length === 1
    ? `ההוראה הזו כוללת טקסט שהגיע מהקלטה ולא מהקלדה שלך, ולכן לא התייחסתי ל-${names} ` +
        'כנמען שנקבת בו בעצמך. כדי שאפנה לשם, צריך אישור מפורש ממך.'
    : `ההוראה הזו כוללת טקסט שהגיע מהקלטה ולא מהקלדה שלך, ולכן לא התייחסתי ל-${names} ` +
        'כנמענים שנקבת בהם בעצמך. כדי שאפנה אליהם, צריך אישור מפורש ממך.';
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
 *
 * **`textOrigin` travels in here beside the instruction's bytes, and it
 * reaches `authorisedRecipients` rather than being interpreted on the way.**
 * The one judgement this function makes about it is which sentence the owner
 * is owed, never which recipients are allowed — that decision belongs to the
 * module that owns the rule (`governance/typed-recipients.ts`), and a second
 * reading of the same flag here would be a second rule to drift from it.
 */
async function grantForPlan(
  jobId: string,
  plan: Plan,
  instruction: string,
  textOrigin: InstructionTextOrigin,
  known: Parameters<typeof authorisedRecipients>[0]['known'],
  businessId: string,
): Promise<GrantForPlanResult> {
  const byClass = new Map<ActionClass, Set<string>>();
  // Accumulated across every step, independently of whether that step
  // granted anything: a step whose covered set is empty is precisely where a
  // withheld recipient lives, so this has to be collected BEFORE the
  // `continue` below.
  const withheld = new Set<string>();

  for (const step of plan.steps) {
    const actionClass = step.expectedActionClass;
    // The planner's declared class is advisory and the gate classifies for
    // itself, so a step that declares nothing grants nothing — "the planner
    // did not say" must read as "no permission was widened".
    if (actionClass === null) continue;

    // Emails and phones both. A WhatsApp step's recipient is a number, and
    // Task 3 widened `coveredByAuthorization` to see them for the same
    // reason — a grant the gate cannot match is a grant that does nothing.
    const candidates = [...readEmails(step.input), ...readPhones(step.input)];

    const covered = authorisedRecipients({
      instruction,
      textOrigin,
      actionClass,
      candidates,
      known,
    });
    // The counterfactual, from the same module and the same two predicates:
    // who typing WOULD have authorised here. Empty for a typed instruction,
    // so this costs nothing on the dashboard's path and says nothing there.
    for (const recipient of recipientsOnlyInRecording({
      instruction,
      textOrigin,
      actionClass,
      candidates,
      known,
    })) {
      withheld.add(recipient);
    }

    if (covered.length === 0) continue;

    const bucket = byClass.get(actionClass) ?? new Set<string>();
    for (const address of covered) bucket.add(address);
    byClass.set(actionClass, bucket);
  }

  // Sorted for the same reason `recipients` below is: the sentence the owner
  // reads must not depend on which step the planner happened to write first.
  const recordingNote =
    withheld.size === 0 ? null : renderRecordingNote([...withheld].sort());

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
      // Carried through this early return, not dropped: the two notes answer
      // different questions and both can be true of one instruction. A
      // spoken, two-class instruction withheld recipients for BOTH reasons,
      // and telling the owner only about the class count would leave him
      // without the one fact that is specific to the recording.
      recordingNote,
    };
  }

  const granted: GrantedAuthorization[] = [];
  for (const [actionClass, addresses] of byClass) {
    const recipients = [...addresses].sort();
    await grantAuthorization({ jobId, actionClass, recipients }, { businessId, db: getPool() });
    granted.push({ actionClass, recipients });
  }
  return { granted, grantNote: null, recordingNote };
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
