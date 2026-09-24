/**
 * The local tool executor: what happens when a step reaches nothing outside
 * the instance.
 *
 * Thirty-nine of the tools an agent may hold are local — they need no
 * connection, no credential and no adapter, so `performStep` never had
 * anywhere to send them. Until now it returned `{ output: null }` for all of
 * them and the step was recorded `completed`, which meant a plan that
 * "recalled what we know about this supplier" proceeded on nothing and
 * recorded success for having done so.
 *
 * **Two rules shape this file.**
 *
 * *A tool with no handler says so.* It does not fail — a plan that drafts
 * before it sends is an ordinary plan, and failing every one of them would
 * break what works today to make a point. But it returns a result that names
 * itself `not_implemented`, so the step's record says what happened instead of
 * implying an effect that never occurred.
 *
 * *A handler validates its own input.* Nothing anywhere declares the shape of
 * `memory.write_entity`'s payload — the planner invents it from the tool's
 * name — so each handler parses what it was given and a shape it cannot use is
 * a stated failure, never a silent write of something malformed. `zod` does
 * the parsing, and the error carries the field that was wrong.
 *
 * The memory family was the whole of what the owner authorised the assistant
 * to do on its own initiative — record and remember. `doc.fetch` joined it for
 * a different reason: it is the tool the intent registry's one delegation
 * target (`know.reader`) calls, and a child job whose single step completes
 * with `not_implemented` would run a delegation end to end and teach the
 * parent nothing — see `intent-registry.ts`'s reachability check. Every other
 * local tool remains honestly unimplemented rather than stubbed into something
 * that looks like it worked.
 */
import { z } from 'zod';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { AgentId } from '../domain/audit.js';
import { SafeLookupKey } from '../domain/charter.js';
import { ContextRef, ResultEnvelopePayload } from '../domain/envelope.js';
import type { PolicyBundle } from '../domain/policy.js';
import { readDocument } from '../documents/read.js';
import { readingsToday } from '../documents/store.js';
import type { ReadOutcome, ReadRequest } from '../sdk/know-reader.js';
import { loadEnvelopeForChildJob, loadResultForChildJob } from '../governance/envelope-store.js';
import {
  recallMemories,
  retireMemories,
  writeMemory,
  type MemoryKind,
  type MemoryRecord,
} from '../memory/store.js';
import { requestHelp } from './delegate.js';
import { loadJob, transition } from './jobs.js';
import { StepChannelError } from './step-error.js';

export interface LocalToolContext {
  jobId: string;
  businessId: string;
  db?: Queryable;
  /**
   * The active charter — required by `doc.fetch` (`readDocument` needs it to
   * build the reading prompt) and by nothing else today. Optional here so the
   * memory-family tests that predate this field do not have to supply one;
   * `doc.fetch`'s own handler throws a clear internal error if it is missing,
   * because that is a wiring bug, not a malformed payload.
   */
  bundle?: PolicyBundle;
  /**
   * The one step that costs money, injectable so a test can drive `doc.fetch`
   * without an API key — the same seam `ReadDocumentOptions.reader` already
   * is. Defaults to the real `runKnowReader` inside `readDocument` itself when
   * omitted.
   */
  reader?: (request: ReadRequest) => Promise<ReadOutcome>;
  /**
   * The agent this step runs as — required by `agent.request_help` (it is
   * `requestHelp`'s `from`, the requesting agent recorded on the envelope)
   * and read by nothing else today. Optional here so every test that
   * predates delegation, and every handler that has no use for it, is
   * unaffected.
   */
  agent?: AgentId;
}

/** What a local handler returns — the value that lands in the step's record. */
export type LocalToolResult = Record<string, unknown>;

type LocalHandler = (
  input: Record<string, unknown>,
  ctx: LocalToolContext,
) => Promise<LocalToolResult>;

/**
 * `subjectKey` under the same guard the charter uses for an entity id.
 *
 * A memory subject is a lookup key, and `__proto__` as a key is the exact
 * shape that turned a signed charter into global prototype pollution once
 * already. The value here arrives from a model's JSON, which is the same
 * origin, so it gets the same guard rather than a second opinion about it.
 */
const SubjectKey = SafeLookupKey.min(1).max(200);
const Attribute = SafeLookupKey.min(1).max(200);

/**
 * A body must be an object, not a bare string.
 *
 * The store writes JSONB and recall reads fields back out of it; a string
 * would recall as a string and every consumer would have to guess which shape
 * it got. Passthrough rather than a closed schema: what is worth remembering
 * about a supplier is not a list this file can write in advance.
 */
const Body = z.record(z.string(), z.unknown());

const WriteEntityInput = z.object({
  entityId: SubjectKey,
  attributes: Body,
  sourceRef: z.string().max(500).optional(),
});

const UpsertPreferenceInput = z.object({
  subject: SubjectKey,
  preference: Attribute,
  value: z.unknown(),
  sourceRef: z.string().max(500).optional(),
});

const WriteChunkInput = z.object({
  subject: SubjectKey,
  text: z.string().min(1).max(2_000),
  sourceRef: z.string().max(500).optional(),
});

const RetireInput = z.object({
  kind: z.enum(['entity', 'preference', 'chunk']),
  subject: SubjectKey,
  preference: Attribute.optional(),
  reason: z.string().min(1).max(500),
});

const RecallInput = z.object({
  subject: SubjectKey.optional(),
  query: z.string().max(200).optional(),
  kind: z.enum(['entity', 'preference', 'chunk']).optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * `documentId` is the one field this handler actually needs; it arrives here
 * because `requestHelp` (`orchestrator/delegate.ts`) merges the resolved
 * context ref into the step's input before binding the child's plan — a
 * `ContextRef` carries a pointer, never text, and this is where the pointer is
 * followed. `question` rides along from the registry's payload and is not
 * read yet: `readDocument` always produces the same structured `Reading`
 * regardless of phrasing, so there is nothing for it to steer today.
 */
const DocFetchInput = z.object({
  documentId: SafeLookupKey,
  question: z.string().min(1).max(500).optional(),
});

/**
 * `agent.request_help`'s own payload. **The field naming the target agent
 * must be `to`** — `delegationProblems` (`governance/delegation.ts`) and the
 * gate's own stage-3 check (`policy/engine.ts`) both read `step.input['to']`
 * directly off the plan step, before this handler ever runs; a planner that
 * named it anything else would pass neither check and never reach here at
 * all, but a handler that parsed a differently-named field would silently
 * agree with a planner that got it wrong.
 *
 * `contextRefs` is optional and defaults to `[]` — most intents need none,
 * and `resolveIntent`'s own `requiresContextRef` is what actually decides
 * whether that is fatal, inside `requestHelp` itself.
 */
const RequestHelpToolInput = z.object({
  to: AgentId,
  intent: z.string().min(1).max(200),
  payload: z.unknown().optional(),
  contextRefs: z.array(ContextRef).optional(),
});

/** Fails the step with the field that was wrong, never a bare "invalid". */
function parseOrFail<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first === undefined ? '' : ` (${first.path.join('.') || 'root'}: ${first.message})`;
  // Not retryable: the same malformed payload will be malformed on the next
  // pass too, and a plan that keeps being retried is a plan that keeps holding
  // the scheduler's window.
  throw new StepChannelError('local_tool_bad_input', `${toolName}${where}`, false);
}

/**
 * What a recalled memory looks like to the step that asked for it.
 *
 * `provenance` is included on every item, deliberately and without an option
 * to omit it. A memory written while reading a stranger's document is a claim
 * that stranger made, and the thing that reads this back has to be able to
 * tell that from something the owner said. Stripping it here would undo the
 * only control the memory store has.
 */
function renderRecalled(memories: MemoryRecord[]): LocalToolResult {
  return {
    count: memories.length,
    memories: memories.map((m) => ({
      kind: m.kind,
      subject: m.subjectKey,
      attribute: m.attribute,
      body: m.body,
      provenance: m.provenance,
      sourceRef: m.sourceRef,
      recordedAt: m.createdAt.toISOString(),
    })),
  };
}

async function write(
  kind: MemoryKind,
  ctx: LocalToolContext,
  fields: { subjectKey: string; attribute?: string; body: Record<string, unknown>; sourceRef?: string },
): Promise<LocalToolResult> {
  const written = await writeMemory(
    {
      jobId: ctx.jobId,
      kind,
      subjectKey: fields.subjectKey,
      ...(fields.attribute !== undefined ? { attribute: fields.attribute } : {}),
      body: fields.body,
      ...(fields.sourceRef !== undefined ? { sourceRef: fields.sourceRef } : {}),
    },
    { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) },
  );
  // The provenance is echoed back so the step's own record shows the trust
  // level this memory will carry forever after.
  return {
    recorded: true,
    memoryId: written.memoryId,
    kind: written.kind,
    subject: written.subjectKey,
    provenance: written.provenance,
  };
}

/**
 * The handlers, by tool name. A positive list: a tool absent from it is
 * unimplemented, and `runLocalTool` says so rather than guessing.
 */
const HANDLERS: Record<string, LocalHandler> = {
  'memory.write_entity': async (input, ctx) => {
    const parsed = parseOrFail(WriteEntityInput, input, 'memory.write_entity');
    return write('entity', ctx, {
      subjectKey: parsed.entityId,
      body: parsed.attributes,
      ...(parsed.sourceRef !== undefined ? { sourceRef: parsed.sourceRef } : {}),
    });
  },

  'memory.upsert_preference': async (input, ctx) => {
    const parsed = parseOrFail(UpsertPreferenceInput, input, 'memory.upsert_preference');
    return write('preference', ctx, {
      subjectKey: parsed.subject,
      attribute: parsed.preference,
      body: { value: parsed.value },
      ...(parsed.sourceRef !== undefined ? { sourceRef: parsed.sourceRef } : {}),
    });
  },

  'memory.write_chunk': async (input, ctx) => {
    const parsed = parseOrFail(WriteChunkInput, input, 'memory.write_chunk');
    return write('chunk', ctx, {
      subjectKey: parsed.subject,
      body: { text: parsed.text },
      ...(parsed.sourceRef !== undefined ? { sourceRef: parsed.sourceRef } : {}),
    });
  },

  'memory.retire': async (input, ctx) => {
    const parsed = parseOrFail(RetireInput, input, 'memory.retire');
    const retired = await retireMemories(
      {
        kind: parsed.kind,
        subjectKey: parsed.subject,
        ...(parsed.preference !== undefined ? { attribute: parsed.preference } : {}),
        reason: parsed.reason,
      },
      { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) },
    );
    // Zero is a result, not a failure: "there was nothing to retire" is a true
    // answer to the question asked, and reporting it as an error would make
    // the step fail for having found the world already in the desired state.
    return { retired };
  },

  'memory.recall': async (input, ctx) => {
    const parsed = parseOrFail(RecallInput, input, 'memory.recall');
    const found = await recallMemories(
      {
        ...(parsed.subject !== undefined ? { subjectKey: parsed.subject } : {}),
        ...(parsed.query !== undefined ? { keyword: parsed.query } : {}),
        ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      },
      { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) },
    );
    return renderRecalled(found);
  },

  // The shallow variant is the same question with a smaller answer — it exists
  // so triage can check "do we know this party at all" without pulling a
  // supplier's whole history into a quarantined agent's context.
  'memory.recall_shallow': async (input, ctx) => {
    const parsed = parseOrFail(RecallInput, input, 'memory.recall_shallow');
    const found = await recallMemories(
      {
        ...(parsed.subject !== undefined ? { subjectKey: parsed.subject } : {}),
        ...(parsed.query !== undefined ? { keyword: parsed.query } : {}),
        limit: 3,
      },
      { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) },
    );
    return renderRecalled(found);
  },

  /**
   * `know.reader`'s half of a delegation. Resolves the document context ref
   * `requestHelp` merged into the step's input, reads it, and hands back a
   * result shape that says which of the three real outcomes happened —
   * `readDocument` itself never throws for a document, only for a genuine
   * fault (see its own docblock).
   *
   * The job's own `provenance` is loaded rather than trusted from the input,
   * for the same reason `writeMemory` reads it off the job record and not off
   * its caller: a handler that could accept a trust level as a parameter is a
   * handler a hostile payload could use to launder one.
   */
  'doc.fetch': async (input, ctx) => {
    const parsed = parseOrFail(DocFetchInput, input, 'doc.fetch');
    if (ctx.bundle === undefined) {
      throw new Error('runLocalTool: doc.fetch requires ctx.bundle (the active charter)');
    }
    const job = await loadJob(ctx.jobId, {
      businessId: ctx.businessId,
      ...(ctx.db !== undefined ? { db: ctx.db } : {}),
    });
    if (job === null) {
      throw new Error(`runLocalTool: doc.fetch could not load job ${ctx.jobId}`);
    }
    // `DOCUMENT_READS_PER_DAY` bounds document reads for the instance —
    // `conductPendingDocuments`'s inbox loop enforces it for the inbox path,
    // but a delegation's `doc.fetch` step reaches `readDocument` without ever
    // passing through that loop, and without this it would be billed and
    // counted only against `delegationsPerDay`, which bounds a different
    // thing. Checked here directly, never behind `DOCUMENT_INBOX` — that
    // switch is about the inbox scan, not about every read this instance
    // makes. Counts `document_readings` rows the same way the conductor does,
    // which means a cache hit that would cost nothing can still be refused
    // here if the count is already at the ceiling — the same conservative
    // trade the conductor's own docblock names (M1): it can only under-run
    // the budget, never exceed it.
    const readsSoFar = await readingsToday({
      businessId: ctx.businessId,
      ...(ctx.db !== undefined ? { db: ctx.db } : {}),
    });
    if (readsSoFar >= config.documentReadsPerDay) {
      // `DOCUMENT_READS_PER_DAY=0` is a legitimate ceiling (CLAUDE.md: an
      // operator turning document reads off entirely), and `positiveInt`
      // accepts it. At that value `readsSoFar >= 0` is true before anything
      // has been read, so `retryable: true` would be a lie — "come back
      // later" never becomes true at a cap of zero, and the child would be
      // parked and retried forever. A genuine cap (reached, but nonzero)
      // resets at midnight and stays retryable; the conductor's own answer to
      // an exhausted-but-nonzero cap is also to stop for the day, not to spin.
      //
      // NOT fixed here: an exhausted nonzero cap still retries on a flat
      // five-minute delay (`executeStep`'s default), which is ~288 wake
      // cycles a day until the envelope deadline frees the parent. The
      // honest fix — wake at the next day boundary — needs `StepChannelError`
      // to carry its own `wakeAt`, which is Task 7's territory (it already
      // owns the deadline path this depends on).
      throw new StepChannelError(
        'document_reads_exhausted',
        `${readsSoFar}/${config.documentReadsPerDay} document reads already used today`,
        config.documentReadsPerDay > 0,
      );
    }
    const outcome = await readDocument(
      {
        documentId: parsed.documentId,
        bundle: ctx.bundle,
        provenance: job.provenance,
        jobId: ctx.jobId,
      },
      {
        businessId: ctx.businessId,
        ...(ctx.db !== undefined ? { db: ctx.db } : {}),
        ...(ctx.reader !== undefined ? { reader: ctx.reader } : {}),
      },
    );
    switch (outcome.status) {
      case 'no_artifacts':
        return { performed: false, reason: 'no_artifacts' };
      case 'unreadable':
        return { performed: true, status: 'unreadable', reason: outcome.reason };
      case 'read':
        return { performed: true, status: 'read', reading: outcome.reading, cached: outcome.cached };
    }
  },

  /**
   * The one plan step that opens a delegation. `agent.request_help` reaches
   * nothing outside the instance — the child it opens runs like any other
   * job, through the full gate — so it is a local tool, and this is what was
   * missing since Task 6 built `requestHelp` and nothing in production ever
   * called it: a plan naming this tool landed here and got
   * `{ performed: false, reason: 'not_implemented' }`.
   *
   * **This handler can itself move `ctx.jobId`'s phase, and that is not a
   * bug to route around.** `requestHelp` parks the parent `execute →
   * followup` on the happy path, and its own oscillation guard — the one
   * guard that fails the REQUESTER rather than merely refusing — moves it
   * `execute → failed` directly. Either way the job this handler is running
   * inside of is no longer in the phase `executeStep` found it in, and the
   * `parked: true` this returns is what tells `executeStep` not to try to
   * move it a second time (`StepEffect.parked`).
   *
   * **`parentEnvelope` is derived, never trusted from the payload.** A
   * hostile document cannot claim an ancestry it does not have — the same
   * reasoning `requestHelp` itself applies to `input.parentEnvelope` by
   * re-verifying it against the stored row rather than the caller's object.
   * Here that starts one step earlier: this handler asks `agent_envelopes`
   * directly (`loadEnvelopeForChildJob`, keyed on `ctx.jobId` — the CURRENT
   * job, which may itself be a delegation's child) rather than accepting an
   * envelope id as part of the tool's payload at all, so a second-hop
   * delegation inherits from its real ancestor and a root job gets `null`.
   */
  'agent.request_help': async (input, ctx) => {
    const parsed = parseOrFail(RequestHelpToolInput, input, 'agent.request_help');
    if (ctx.bundle === undefined) {
      throw new Error('runLocalTool: agent.request_help requires ctx.bundle (the active charter)');
    }
    if (ctx.agent === undefined) {
      throw new Error('runLocalTool: agent.request_help requires ctx.agent (the requesting agent)');
    }
    const dbOpts = { businessId: ctx.businessId, ...(ctx.db !== undefined ? { db: ctx.db } : {}) };

    const parentEnvelope = await loadEnvelopeForChildJob(ctx.jobId, dbOpts);

    const result = await requestHelp({
      parentJobId: ctx.jobId,
      from: ctx.agent,
      to: parsed.to,
      intent: parsed.intent,
      payload: parsed.payload ?? {},
      contextRefs: parsed.contextRefs ?? [],
      bundle: ctx.bundle,
      parentEnvelope,
      businessId: ctx.businessId,
    });

    if (result.status === 'opened') {
      return {
        performed: true,
        status: 'delegated',
        envelopeId: result.envelopeId,
        childJobId: result.childJobId,
        parked: true,
      };
    }

    if (result.status === 'duplicate') {
      if (result.childJobId === null) {
        // The crash window `requestHelp`'s own docblock names: the envelope
        // committed but no child was ever attached. Not this step's repair to
        // make — retryable, so the scheduler's own retry loop comes back
        // rather than this failing the job outright over a window an
        // operator (or a future pass) may yet close with `attachChildJob`.
        throw new StepChannelError(
          'delegation_orphaned',
          `envelope ${result.envelopeId} has no child job attached`,
          true,
        );
      }

      // Fix round 2, item 2. This used to ask `child.phase` directly and
      // complete only for a terminal one — which had no terminal phase to
      // find for a child `resumeDelegatedJobs` woke the PARENT for on a
      // TIMEOUT: that child is still running by definition. The resumed step
      // then fell through to `delegation_pending` below every single time,
      // and because that threw retryably, `executeStep` deferred through the
      // generic path, which clears `awaiting_envelope_id` on every deferral —
      // `resumeDelegatedJobs` never saw this parent again, its deadline could
      // never fire a second time, and the parent polled on a flat five-minute
      // timer forever instead of resolving.
      //
      // Reading the `result` envelope instead — the durable record
      // `resumeDelegatedJobs` already wrote for a close, a failure, AND a
      // timeout alike — fixes this uniformly: whichever of the three it is,
      // an answer that exists is read and the step completes with it,
      // without asking what phase the child happens to be in right now.
      // Scoped by `result.correlationId` (this delegation's own tree), not
      // just the child job id — `loadResultForChildJob`'s own docblock says
      // why that predicate has to be real rather than a comment.
      const resultEnvelope = await loadResultForChildJob(
        result.childJobId,
        result.correlationId,
        dbOpts,
      );
      if (resultEnvelope !== null) {
        // Fix round 3, item 1. `ResultEnvelopePayload` is the ONE schema
        // both `resumeDelegatedJobs` (the writer) and this handler (the
        // reader) agree on — `AgentEnvelope.payload` is `z.unknown()` by
        // design, so nothing else enforces it. A hand-narrowed read with an
        // `'unknown'` fallback used to let a payload that failed to parse
        // (missing, non-string, or out-of-enum `outcome`) complete this step
        // as `done` anyway — the exact "a value we could not read treated as
        // a permitting one" shape this project refuses everywhere else
        // (`amount_unreadable`, an unknown data class scored most severe, an
        // unknown calendar action becoming `calendar.cancel`). A `result`
        // envelope that does not parse is a corrupted state, not a
        // completion, and is refused the same way any other corrupted
        // delegation state this handler finds is refused.
        const parsedResult = ResultEnvelopePayload.safeParse(resultEnvelope.payload);
        if (!parsedResult.success) {
          throw new StepChannelError(
            'delegation_result_corrupted',
            `result envelope ${resultEnvelope.id} has an unreadable payload: ` +
              parsedResult.error.issues.map((issue) => issue.message).join('; '),
            false,
          );
        }
        // A child that failed or halted still yields a `done` PARENT step
        // here, deliberately: the parent never fails on its own account of
        // its helper's outcome — that is `resumeDelegatedJobs`'s own decision
        // for the envelope it writes, and this is the other half of it — the
        // failure is carried in `outcome` for whatever reads this step's
        // result next, not re-raised as this step's own failure.
        return {
          performed: true,
          status: 'answered',
          envelopeId: result.envelopeId,
          childJobId: result.childJobId,
          outcome: parsedResult.data.outcome,
        };
      }

      const child = await loadJob(result.childJobId, dbOpts);
      if (child === null) {
        throw new Error(
          `runLocalTool: agent.request_help's child ${result.childJobId} does not exist`,
        );
      }

      // No answer yet — re-park under the SAME envelope rather than throw a
      // `delegation_pending` retry through the generic path. `transition`
      // overwrites `awaiting_envelope_id` on every move rather than merging
      // with it, so a plain retryable throw here would clear the column via
      // `executeStep`'s deferral branch, and `resumeDelegatedJobs` — the ONLY
      // mechanism enforcing this delegation's deadline — would never look at
      // this parent again. Re-parking under the same envelope id keeps that
      // mechanism in charge of the wait instead of an uncapped five-minute
      // poll.
      await transition(ctx.jobId, {
        to: 'followup',
        actor: 'orchestrator',
        reason: `ממתין לתשובת ${parsed.to} על "${parsed.intent}" (מעטפת ${result.envelopeId})`,
        // `envelopeId` names the `job_steps` row for this move, the same way
        // the original park (`delegate.ts`'s `transition(parent.jobId, {to:
        // 'followup', envelopeId: envelope.id, ...})`) does — omitting it
        // left the column `NULL` here while the Hebrew reason string was the
        // only place the envelope id survived.
        envelopeId: result.envelopeId,
        awaitingEnvelopeId: result.envelopeId,
        businessId: ctx.businessId,
      });
      return {
        performed: false,
        status: 'pending',
        envelopeId: result.envelopeId,
        childJobId: result.childJobId,
        parked: true,
      };
    }

    // result.status === 'refused'. Most refusals leave `ctx.jobId` exactly
    // where `executeStep` found it (`execute`), and the thrown error below is
    // what lets `executeStep`'s own catch block fail it normally. The
    // oscillation guard is the one exception — it already moved the job to
    // `failed` itself (see this handler's own docblock) — so that one case is
    // reported as `parked` instead of thrown, or `executeStep` would try to
    // fail an already-failed job and hit `LEGAL_TRANSITIONS`'s empty entry for
    // it.
    const after = await loadJob(ctx.jobId, dbOpts);
    if (after !== null && after.phase !== 'execute') {
      return {
        performed: false,
        status: 'refused',
        code: result.code,
        reason: result.reason,
        parked: true,
      };
    }
    throw new StepChannelError(`delegation_refused:${result.code}`, result.reason, false);
  },
};

/** The tools this executor actually performs. Exported for the invariant test. */
export function implementedLocalTools(): string[] {
  return Object.keys(HANDLERS).sort();
}

/**
 * The payload each implemented tool expects, in the words a planner needs.
 *
 * **Nothing else in the system declares this, and the live run of 12/09 is
 * what that costs.** Asked to remember a contact's preference, the planner
 * wrote a `memory.write_entity` step with `name`, `email` and `organization`
 * and no `entityId` at all, and a `memory.upsert_preference` step keyed
 * `preferenceKey`/`preferenceValue` against a subject of
 * `"רונית כהן <ronit@beta-log.example> (בטא לוגיסטיקה)"`. Every one of those is
 * a reasonable reading of the tool's name, and every one of them would have
 * been refused by `parseOrFail` the moment the ramp let the step run.
 *
 * This is the third time the same shape has appeared: the catalogue hands the
 * model a tool name and nothing about how to call it, and the model fills the
 * gap plausibly and wrongly. The read-only-class label was the first, the
 * payload-refined action classes the second. So the contract is declared here,
 * beside the handlers that enforce it, and rendered into the prompts from this
 * constant rather than retyped — the two cannot drift while there is only one
 * of them.
 *
 * `subjectKey` is stressed deliberately. It is a lookup key, so a memory
 * recorded under a sentence can never be recalled by anything but that exact
 * sentence, and the store would fill with subjects nothing ever matches.
 */
export const LOCAL_TOOL_CONTRACTS: readonly { toolName: string; payload: string }[] = [
  {
    toolName: 'memory.write_entity',
    payload:
      '`{"entityId": מזהה יציב וקצר, "attributes": אובייקט, "sourceRef": טקסט (רשות)}` — ' +
      'כל מה שידוע על הישות נכנס לתוך `attributes`, ולא כשדות אחיו.',
  },
  {
    toolName: 'memory.upsert_preference',
    payload:
      '`{"subject": מזהה יציב וקצר, "preference": שם ההעדפה, "value": הערך, "sourceRef": טקסט (רשות)}`.',
  },
  {
    toolName: 'memory.write_chunk',
    payload: '`{"subject": מזהה יציב וקצר, "text": עד 2000 תווים, "sourceRef": טקסט (רשות)}`.',
  },
  {
    toolName: 'memory.retire',
    payload:
      '`{"kind": "entity"|"preference"|"chunk", "subject": המזהה, "preference": שם ההעדפה (רק ל-preference), "reason": למה}`.',
  },
  {
    toolName: 'memory.recall',
    payload:
      '`{"subject": מזהה (רשות), "query": מילת חיפוש (רשות), "kind": סוג (רשות), "limit": מספר (רשות)}` — ' +
      'לפחות אחד מ-`subject` או `query`.',
  },
  {
    toolName: 'memory.recall_shallow',
    payload: 'כמו `memory.recall`, ומחזיר לכל היותר שלוש תוצאות.',
  },
  {
    toolName: 'doc.fetch',
    payload:
      '`{"documentId": מזהה המסמך, "question": טקסט (רשות, עדיין לא נקרא)}` — ' +
      'לא נקרא ישירות על ידי תוכנית; זה הכלי שהצעד היחיד של משימת-בת בהאצלה קורא לו.',
  },
  {
    toolName: 'agent.request_help',
    payload:
      '`{"to": מזהה הסוכן שממנו מבקשים עזרה, "intent": שם הכוונה שהוא תומך בה, ' +
      '"payload": אובייקט לפי סכמת אותה כוונה, "contextRefs": מערך מצביעים (רשות), ' +
      'למשל `[{"kind":"document","documentId": מזהה המסמך}]`}` — ' +
      'שם השדה חייב להיות בדיוק `to`; זה השדה שגם השער וגם בדיקת התוכנית קוראים.',
  },
];

/**
 * The contracts as the text a prompt carries.
 *
 * A stable, sorted rendering: this sits in the cacheable prefix of both
 * prompts, and a byte that moves between calls invalidates the whole prefix.
 */
export function renderLocalToolContracts(): string {
  return [...LOCAL_TOOL_CONTRACTS]
    .sort((a, b) => a.toolName.localeCompare(b.toolName))
    .map((c) => `- \`${c.toolName}\` — ${c.payload}`)
    .join('\n');
}

/**
 * Run one local step.
 *
 * Returns the result that becomes the step's recorded output. A tool with no
 * handler returns `{ performed: false, reason: 'not_implemented' }` — the step
 * still completes, because it did not fail; it simply did nothing, and now it
 * says which.
 */
export async function runLocalTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: LocalToolContext,
): Promise<LocalToolResult> {
  // `Object.hasOwn`, not `in` and not a bare index: `HANDLERS` is a plain
  // object, so `constructor` and `toString` would otherwise resolve to a
  // function and be called as a handler. Same rule `isKnownTool` keeps, and
  // for the same reason — a lookup whose meaning is "absent means refuse"
  // must not walk the prototype chain.
  if (!Object.hasOwn(HANDLERS, toolName)) {
    return { performed: false, reason: 'not_implemented', tool: toolName };
  }
  const handler = HANDLERS[toolName] as LocalHandler;
  return handler(input, ctx);
}
