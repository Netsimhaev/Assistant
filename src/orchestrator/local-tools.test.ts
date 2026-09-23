import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { config } from '../config.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { compileCharter } from '../charter/compile.js';
import { createJob, loadJob, transition } from './jobs.js';
import { Plan } from '../domain/plan.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';
import { recallMemories } from '../memory/store.js';
import { insertOrGetDocument, markExtracted } from '../documents/store.js';
import { renderReadingBrief } from '../documents/brief.js';
import { interpretReaderResponse, type ReadOutcome } from '../sdk/know-reader.js';
import type { DocumentArtifact } from '../documents/types.js';
import {
  LOCAL_TOOL_CONTRACTS,
  implementedLocalTools,
  renderLocalToolContracts,
  runLocalTool,
} from './local-tools.js';
import { READ_ONLY_TOOLS, classifiedToolNames, isOutbound } from '../policy/classify.js';
import { StepChannelError } from './step-error.js';
import type { TrustLevel } from '../domain/trust.js';

const BUSINESS = 'test-business';

async function aJob(provenance: TrustLevel = 'boss', tag = 'lt'): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: `${tag}-${provenance}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    businessId: BUSINESS,
    title: 'local tools',
  });
  return job.jobId;
}

describe('the local tool executor', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('records an entity and says what it recorded', async () => {
    const jobId = await aJob();
    const out = await runLocalTool(
      'memory.write_entity',
      { entityId: 'c_812', attributes: { name: 'אלפא', phone: '03-5551234' } },
      { jobId, businessId: BUSINESS },
    );

    expect(out['recorded']).toBe(true);
    expect(out['subject']).toBe('c_812');

    const found = await recallMemories({ subjectKey: 'c_812' }, { businessId: BUSINESS });
    expect(found[0]?.body).toEqual({ name: 'אלפא', phone: '03-5551234' });
  });

  it('records a preference and replaces it on a second write', async () => {
    const jobId = await aJob();
    const write = (value: string) =>
      runLocalTool(
        'memory.upsert_preference',
        { subject: 'c_812', preference: 'meeting_time', value },
        { jobId, businessId: BUSINESS },
      );

    await write('בוקר');
    await write('אחר הצהריים');

    const found = await recallMemories(
      { subjectKey: 'c_812', kind: 'preference' },
      { businessId: BUSINESS },
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.body).toEqual({ value: 'אחר הצהריים' });
  });

  it('recalls what an earlier step recorded, in the same shape a plan can read', async () => {
    const jobId = await aJob();
    await runLocalTool(
      'memory.write_chunk',
      { subject: 'c_812', text: 'מעדיפים אספקה בבוקר' },
      { jobId, businessId: BUSINESS },
    );

    const out = await runLocalTool(
      'memory.recall',
      { subject: 'c_812' },
      { jobId, businessId: BUSINESS },
    );

    expect(out['count']).toBe(1);
    const memories = out['memories'] as { body: Record<string, unknown> }[];
    expect(String(memories[0]?.body['text'])).toContain('אספקה בבוקר');
  });

  /**
   * The control the whole memory layer exists to keep, asserted at the level
   * a plan actually sees.
   *
   * A chunk written while a job was reading a stranger's document must come
   * back labelled as that stranger's claim. If recall rendered it without the
   * label, a later step would read "the supplier's account is X" as something
   * the business knows — and a prompt injection would have landed, one day
   * late.
   */
  it('hands every recalled memory back with the trust level it was written under', async () => {
    const ownerJob = await aJob('boss', 'owner');
    const documentJob = await aJob('unknown_external', 'doc');

    await runLocalTool(
      'memory.write_chunk',
      { subject: 'c_900', text: 'הבעלים קבע' },
      { jobId: ownerJob, businessId: BUSINESS },
    );
    await runLocalTool(
      'memory.write_chunk',
      { subject: 'c_900', text: 'המסמך טען' },
      { jobId: documentJob, businessId: BUSINESS },
    );

    const out = await runLocalTool(
      'memory.recall',
      { subject: 'c_900' },
      { jobId: ownerJob, businessId: BUSINESS },
    );

    const memories = out['memories'] as { body: Record<string, unknown>; provenance: string }[];
    expect(memories).toHaveLength(2);
    const byText = new Map(memories.map((m) => [String(m.body['text']), m.provenance]));
    expect(byText.get('הבעלים קבע')).toBe('boss');
    expect(byText.get('המסמך טען')).toBe('unknown_external');
  });

  it('retires a memory and reports how many it touched', async () => {
    const jobId = await aJob();
    await runLocalTool(
      'memory.write_entity',
      { entityId: 'c_gone', attributes: { name: 'ספק' } },
      { jobId, businessId: BUSINESS },
    );

    const out = await runLocalTool(
      'memory.retire',
      { kind: 'entity', subject: 'c_gone', reason: 'הספק סגר' },
      { jobId, businessId: BUSINESS },
    );
    expect(out['retired']).toBe(1);

    // Retiring nothing is a result, not a failure: the world was already in
    // the state asked for.
    const again = await runLocalTool(
      'memory.retire',
      { kind: 'entity', subject: 'c_gone', reason: 'שוב' },
      { jobId, businessId: BUSINESS },
    );
    expect(again['retired']).toBe(0);
  });

  it('fails the step on a payload it cannot use, naming the field', async () => {
    const jobId = await aJob();
    await expect(
      runLocalTool('memory.write_entity', { attributes: {} }, { jobId, businessId: BUSINESS }),
    ).rejects.toBeInstanceOf(StepChannelError);

    await expect(
      runLocalTool(
        'memory.write_entity',
        { entityId: 'c_1', attributes: 'a string, not an object' },
        { jobId, businessId: BUSINESS },
      ),
    ).rejects.toThrow(/attributes/);
  });

  /**
   * `__proto__` as a lookup key turned a signed charter into global prototype
   * pollution once already (28/08). A memory subject arrives from the same
   * origin — a model's JSON — so it gets the same guard, not a second opinion
   * about whether this particular field needs one.
   */
  it('refuses a subject key that is a dangerous object key', async () => {
    const jobId = await aJob();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      await expect(
        runLocalTool(
          'memory.write_entity',
          { entityId: key, attributes: { x: 1 } },
          { jobId, businessId: BUSINESS },
        ),
      ).rejects.toBeInstanceOf(StepChannelError);
    }
  });

  /**
   * An unimplemented tool must not fail the plan — a plan that drafts before
   * it sends is ordinary, and failing every such plan to make a point would
   * break the instruction path that works. But it must not claim an effect
   * either, which is exactly what returning `null` and recording `completed`
   * used to do.
   */
  it('says a tool is unimplemented rather than failing or pretending', async () => {
    const jobId = await aJob();
    const out = await runLocalTool('template.render', { templateId: 'x' }, { jobId, businessId: BUSINESS });
    expect(out).toEqual({ performed: false, reason: 'not_implemented', tool: 'template.render' });
  });

  /**
   * The handler table is a plain object, so `constructor` and `toString`
   * resolve to functions on its prototype. A lookup whose meaning is "absent
   * means do nothing" must not walk that chain and call one.
   */
  it('does not treat an inherited object property as a handler', async () => {
    const jobId = await aJob();
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const out = await runLocalTool(name, {}, { jobId, businessId: BUSINESS });
      expect(out['performed']).toBe(false);
      expect(out['reason']).toBe('not_implemented');
    }
  });

  /**
   * Every tool this executor claims to perform must actually be a local tool.
   * A handler for something outbound would run it without a channel, without a
   * credential and without the binding the charter signed — bypassing the
   * whole connection layer rather than extending it.
   */
  /**
   * The wiring, end to end through the real engine.
   *
   * Everything above tests the executor directly. This proves `performStep`
   * reaches it — the branch that returned `{ output: null }` for every local
   * step since the engine was written, which is why `memory.recall` in a live
   * plan came back with nothing and the step was recorded as a success.
   *
   * Two steps, and the second reads what the first wrote: that is the claim
   * "the assistant remembers between steps", stated as behaviour.
   */
  it('is reached by a real plan, and the second step reads what the first wrote', async () => {
    const bundle = await installCharter(
      buildCharter({ version: 'local-e2e', autonomyBase: { 'memory.write_longterm': 'auto' } }),
      { businessId: BUSINESS },
    );
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'remember then recall',
    });
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }
    const fresh = await loadJob(job.jobId, { businessId: BUSINESS });
    if (fresh === null) throw new Error('job vanished');

    const plan = Plan.parse({
      goal: 'record what we learned, then read it back',
      steps: [
        {
          id: 's1',
          agent: 'know.memory',
          intent: 'record the preference',
          toolName: 'memory.upsert_preference',
          input: { subject: 'c_812', preference: 'delivery_time', value: 'בוקר' },
          expectedActionClass: 'memory.write_longterm',
        },
        {
          id: 's2',
          agent: 'know.memory',
          intent: 'read it back',
          toolName: 'memory.recall',
          input: { subject: 'c_812' },
          dependsOn: ['s1'],
          expectedActionClass: null,
        },
      ],
    });

    const result = await runPlan({
      job: fresh,
      bundle,
      plan,
      registry: new AdapterRegistry([]),
      bindings: [],
      credentials: envCredentials({}, 'NONE_'),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: new Date('2026-08-18T09:00:00.000Z'),
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');

    // The write really happened — read from the store, not from the result.
    const stored = await recallMemories(
      { subjectKey: 'c_812', kind: 'preference' },
      { businessId: BUSINESS },
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toEqual({ value: 'בוקר' });
    expect(stored[0]?.provenance).toBe('boss');

    // And the recall step returned it, rather than the `null` this branch
    // produced for every local step before 12/09.
    // `StepEffect.output` lands on the outcome as `result` — the engine's own
    // name for what a step produced.
    const recall = result.steps.find((s) => s.stepId === 's2');
    expect(recall?.outcome.status).toBe('done');
    const recalled = (recall?.outcome as { result?: unknown }).result as
      | { count: number; memories: { provenance: string }[] }
      | undefined;
    expect(recalled?.count).toBe(1);
    expect(recalled?.memories[0]?.provenance).toBe('boss');
  });

  /**
   * Every implemented tool must declare its payload, and every declaration
   * must name a tool that has a handler.
   *
   * The live run of 12/09 is the reason. Asked to remember a contact, the
   * planner wrote `memory.write_entity` with `name`/`email`/`organization` and
   * no `entityId`, and `memory.upsert_preference` with
   * `preferenceKey`/`preferenceValue` — reasonable readings of the tool names,
   * and every one of them refused by the handler. A contract that covers five
   * of six tools leaves exactly that hole for the sixth.
   */
  it('declares a payload contract for every tool it implements, and no others', () => {
    const implemented = implementedLocalTools();
    const declared = LOCAL_TOOL_CONTRACTS.map((c) => c.toolName).sort();
    expect(declared).toEqual(implemented);

    // And each one has to say something a planner could act on. A contract
    // that names its tool and nothing else would satisfy the line above.
    for (const contract of LOCAL_TOOL_CONTRACTS) {
      expect(contract.payload.length, `${contract.toolName} has an empty contract`).toBeGreaterThan(20);
    }
  });

  /**
   * The rendering is what actually reaches the model, and it sits in the
   * cacheable prefix of two prompts — so it must be stable across calls and
   * must carry the field names the handlers really require.
   */
  it('renders the contracts with the field names the handlers enforce', () => {
    const rendered = renderLocalToolContracts();
    expect(rendered).toBe(renderLocalToolContracts());

    // The two fields the live run got wrong, named explicitly.
    expect(rendered).toContain('entityId');
    expect(rendered).toContain('attributes');
    expect(rendered).toContain('preference');
    expect(rendered).toContain('subject');
  });

  it('implements only tools that are local and known', () => {
    const implemented = implementedLocalTools();
    expect(implemented.length).toBeGreaterThan(0);

    const known = new Set([...classifiedToolNames(), ...READ_ONLY_TOOLS]);
    for (const tool of implemented) {
      expect(known.has(tool), `${tool} is not a tool the policy knows`).toBe(true);
      expect(isOutbound(tool), `${tool} is outbound and must not run locally`).toBe(false);
    }
  });

  /**
   * `doc.fetch` — know.reader's half of a delegation. Until this task it had
   * no implementation at all, so a child job created by `requestHelp` would
   * have completed with `not_implemented` and taught the parent nothing.
   */
  describe('doc.fetch', () => {
    async function anExtractedDocument(text: string): Promise<string> {
      const documentId = `DOC-${ulid()}`;
      await insertOrGetDocument(
        {
          documentId,
          source: 'manual',
          originalName: 'מסמך.txt',
          mediaType: 'text/plain',
          sha256: ulid().padEnd(64, '0'),
          byteSize: text.length,
          storedPath: `${BUSINESS}/${documentId}/original.txt`,
        },
        { businessId: BUSINESS },
      );
      await markExtracted(
        documentId,
        [{ ordinal: 0, kind: 'text', partName: 'גוף', content: { blocks: [{ kind: 'paragraph', text }] }, flags: [] }],
        { businessId: BUSINESS },
      );
      return documentId;
    }

    function stubReader(raw: string) {
      let calls = 0;
      const reader = async (request: { artifacts: readonly DocumentArtifact[] }): Promise<ReadOutcome> => {
        calls += 1;
        const { includedOrdinals } = renderReadingBrief(request.artifacts);
        return interpretReaderResponse(raw, includedOrdinals, [], 1);
      };
      return { reader, callCount: () => calls };
    }

    it('reads an extracted document and hands back the reading', async () => {
      const jobId = await aJob('unknown_external', 'docfetch1');
      const documentId = await anExtractedDocument('מה המחיר לאספקה?');
      const { reader, callCount } = stubReader(
        JSON.stringify({
          summary: 'שאלה על מחיר אספקה.',
          findings: [],
          intents: [
            {
              intent: 'file_document',
              subject: { kind: 'sender' },
              sourceRef: { ordinal: 0, locator: null },
              note: '',
            },
          ],
          unreadable: [],
        }),
      );
      const bundle = compileCharter(buildCharter({ version: 'docfetch-v1' }));

      const out = await runLocalTool(
        'doc.fetch',
        { documentId, question: 'מה המסמך מבקש?' },
        { jobId, businessId: BUSINESS, bundle, reader },
      );

      expect(out['performed']).toBe(true);
      expect(out['status']).toBe('read');
      expect((out['reading'] as { summary: string }).summary).toBe('שאלה על מחיר אספקה.');
      expect(callCount()).toBe(1);
    });

    it('reports no_artifacts without calling the reader, for a document with nothing extracted', async () => {
      const jobId = await aJob('unknown_external', 'docfetch2');
      const documentId = `DOC-${ulid()}`;
      await insertOrGetDocument(
        {
          documentId,
          source: 'manual',
          originalName: 'ריק.txt',
          mediaType: 'text/plain',
          sha256: ulid().padEnd(64, '0'),
          byteSize: 0,
          storedPath: `${BUSINESS}/${documentId}/original.txt`,
        },
        { businessId: BUSINESS },
      );
      const bundle = compileCharter(buildCharter({ version: 'docfetch-v2' }));
      let called = false;
      const reader = async (): Promise<ReadOutcome> => {
        called = true;
        throw new Error('must not be called for a document with no artifacts');
      };

      const out = await runLocalTool('doc.fetch', { documentId }, { jobId, businessId: BUSINESS, bundle, reader });
      expect(out).toEqual({ performed: false, reason: 'no_artifacts' });
      expect(called).toBe(false);
    });

    it('throws a clear internal error when the caller forgot to supply a bundle', async () => {
      const jobId = await aJob('unknown_external', 'docfetch3');
      await expect(
        runLocalTool('doc.fetch', { documentId: 'doc-x' }, { jobId, businessId: BUSINESS }),
      ).rejects.toThrow(/bundle/);
    });

    it('fails the step on a payload missing documentId', async () => {
      const jobId = await aJob('unknown_external', 'docfetch4');
      const bundle = compileCharter(buildCharter({ version: 'docfetch-v4' }));
      await expect(
        runLocalTool('doc.fetch', { question: 'מה זה?' }, { jobId, businessId: BUSINESS, bundle }),
      ).rejects.toBeInstanceOf(StepChannelError);
    });

    /**
     * `DOCUMENT_READS_PER_DAY` bounds document reads for the instance.
     * `conductPendingDocuments` enforces it for the inbox path; a delegation's
     * `doc.fetch` step reaches `readDocument` without ever going through that
     * loop, and without a check here it would be billed and counted only
     * against `delegationsPerDay`, which bounds a different thing entirely.
     */
    it('refuses once the daily document-reads cap is used up, retryably', async () => {
      const jobId = await aJob('unknown_external', 'docfetch5');
      const documentId = await anExtractedDocument('כמה זה עולה?');
      const bundle = compileCharter(buildCharter({ version: 'docfetch-v5' }));

      for (let i = 0; i < config.documentReadsPerDay; i++) {
        await getPool().query(
          `INSERT INTO document_readings (
             reading_id, business_id, document_id, status, reason, content,
             provenance, model, prompt_version, brief_hash
           ) VALUES ($1, $2, $3, 'unreadable', 'seed', NULL, 'boss', 'test', 'v1', $4)`,
          [`RDG-${ulid()}`, BUSINESS, documentId, `seed-${i}`],
        );
      }

      const { reader, callCount } = stubReader(JSON.stringify({ summary: 'x', findings: [], intents: [], unreadable: [] }));
      let caught: unknown;
      try {
        await runLocalTool('doc.fetch', { documentId }, { jobId, businessId: BUSINESS, bundle, reader });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StepChannelError);
      const typed = caught as StepChannelError;
      expect(typed.code).toBe('document_reads_exhausted');
      expect(typed.retryable).toBe(true);
      // Refused before the model was ever called.
      expect(callCount()).toBe(0);
    });

    /**
     * The pair to the test above: that one is a cap that WILL reset at
     * midnight, retryable. This one — `DOCUMENT_READS_PER_DAY=0`, a
     * legitimate "off" setting (CLAUDE.md) — never will, so `retryable` must
     * be `false`. Without this test, reverting
     * `config.documentReadsPerDay > 0` to a bare `true`, or flipping the
     * comparison, passes the whole suite untouched — the nonzero test above
     * asserts `retryable: true` regardless of which branch produced it.
     */
    it('refuses finally, not retryably, when the cap itself is zero', async () => {
      const jobId = await aJob('unknown_external', 'docfetch6');
      const bundle = compileCharter(buildCharter({ version: 'docfetch-v6' }));

      const original = config.documentReadsPerDay;
      (config as { documentReadsPerDay: number }).documentReadsPerDay = 0;
      try {
        const { reader, callCount } = stubReader(
          JSON.stringify({ summary: 'x', findings: [], intents: [], unreadable: [] }),
        );
        let caught: unknown;
        try {
          await runLocalTool('doc.fetch', { documentId: 'doc-any' }, { jobId, businessId: BUSINESS, bundle, reader });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(StepChannelError);
        const typed = caught as StepChannelError;
        expect(typed.code).toBe('document_reads_exhausted');
        expect(typed.retryable).toBe(false);
        expect(callCount()).toBe(0);
      } finally {
        (config as { documentReadsPerDay: number }).documentReadsPerDay = original;
      }
    });
  });

  /**
   * `agent.request_help` — the tool that opens a delegation. Until Task 7 it
   * had no implementation at all: a plan naming it landed here and got
   * `{ performed: false, reason: 'not_implemented' }`, and `requestHelp`
   * (built in Task 6) had no production caller.
   */
  describe('agent.request_help', () => {
    async function parentJobInExecute(): Promise<{ jobId: string; bundle: ReturnType<typeof compileCharter> }> {
      const bundle = await installCharter(buildCharter({ version: `req-help-${ulid()}` }), {
        businessId: BUSINESS,
      });
      const job = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'boss',
        businessId: BUSINESS,
        title: 'delegating job',
      });
      for (const to of ['understand', 'plan', 'execute'] as const) {
        await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
      }
      return { jobId: job.jobId, bundle };
    }

    it('opens a child job, parks the parent, and reports itself as parked', async () => {
      const { jobId, bundle } = await parentJobInExecute();
      const documentId = `DOC-${ulid()}`;

      const out = await runLocalTool(
        'agent.request_help',
        {
          to: 'know.reader',
          intent: 'read_for_question',
          payload: { question: 'מה המסמך הזה מבקש?' },
          contextRefs: [{ kind: 'document', documentId }],
        },
        { jobId, businessId: BUSINESS, bundle, agent: 'comms.email' },
      );

      expect(out['performed']).toBe(true);
      expect(out['status']).toBe('delegated');
      expect(out['parked']).toBe(true);
      expect(typeof out['childJobId']).toBe('string');
      expect(typeof out['envelopeId']).toBe('string');

      const parent = await loadJob(jobId, { businessId: BUSINESS });
      expect(parent?.phase).toBe('followup');
      expect(parent?.awaitingEnvelopeId).toBe(out['envelopeId']);

      const child = await loadJob(out['childJobId'] as string, { businessId: BUSINESS });
      expect(child?.phase).toBe('execute');
    });

    /**
     * The integration Piece B exists for: `runPlan` must not throw trying to
     * move a job `requestHelp` already moved out from under it. Before the
     * `parked` outcome, `executeStep` would try `verify` next on a job
     * already sitting in `followup`, and `LEGAL_TRANSITIONS` has no
     * `followup → verify` — an illegal-transition throw, not a clean halt.
     */
    it('runs through runPlan as a "parked" halt, not a "done" step — and does not try to move the job a second time', async () => {
      const { jobId, bundle } = await parentJobInExecute();
      const documentId = `DOC-${ulid()}`;
      const plan = Plan.parse({
        goal: 'ask know.reader to read the document',
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'delegate',
            toolName: 'agent.request_help',
            input: {
              to: 'know.reader',
              intent: 'read_for_question',
              payload: { question: 'מה המסמך הזה מבקש?' },
              contextRefs: [{ kind: 'document', documentId }],
            },
            dependsOn: [],
            expectedActionClass: 'agent.delegate',
          },
        ],
      });
      const job = await loadJob(jobId, { businessId: BUSINESS });
      if (job === null) throw new Error('job vanished');

      const result = await runPlan({
        job,
        bundle,
        plan,
        registry: new AdapterRegistry([]),
        bindings: [],
        credentials: envCredentials({}, 'TEST_CRED_'),
        counterpartyTags: [],
        rampLevel: 'auto',
      });

      expect(result.status).toBe('halted');
      if (result.status !== 'halted') throw new Error('expected halted');
      expect(result.reason).toBe('parked');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.outcome.status).toBe('parked');

      const parent = await loadJob(jobId, { businessId: BUSINESS });
      expect(parent?.phase).toBe('followup');
      expect(parent?.awaitingEnvelopeId).not.toBeNull();
    });
  });
});
