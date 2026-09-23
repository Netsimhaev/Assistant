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
import type { Queryable } from '../db/pool.js';
import { SafeLookupKey } from '../domain/charter.js';
import type { PolicyBundle } from '../domain/policy.js';
import { readDocument } from '../documents/read.js';
import type { ReadOutcome, ReadRequest } from '../sdk/know-reader.js';
import {
  recallMemories,
  retireMemories,
  writeMemory,
  type MemoryKind,
  type MemoryRecord,
} from '../memory/store.js';
import { loadJob } from './jobs.js';
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
