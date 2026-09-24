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
import type { AgentEnvelope, DelegationOutcome } from '../domain/envelope.js';
import { attachChildJob, loadEnvelope, writeEnvelope } from '../governance/envelope-store.js';
import { loadVerificationOutcome } from '../governance/verdict-store.js';
import { saveReading } from '../documents/reading-store.js';
import type { VerifyDraftInput, VerifyDraftResult } from '../sdk/gov-verify.js';
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
     * Fix round 2, item 2. A resumed run of the same step while the child is
     * STILL RUNNING and no `result` envelope exists yet must not throw a
     * plain retryable error: `executeStep`'s generic deferral clears
     * `awaiting_envelope_id` on every move (`transition` overwrites it,
     * never merges), and clearing it here would mean `resumeDelegatedJobs` —
     * the only thing enforcing this delegation's deadline — never looks at
     * this parent again. The fix re-parks under the SAME envelope id, so the
     * next scheduler pass finds it exactly as it would have found a freshly
     * opened delegation.
     */
    it('re-parks under the same envelope when resumed before the child has answered, rather than clearing the watch', async () => {
      const { jobId, bundle } = await parentJobInExecute();
      const documentId = `DOC-${ulid()}`;
      const input = {
        to: 'know.reader' as const,
        intent: 'read_for_question',
        payload: { question: 'מה המסמך הזה מבקש?' },
        contextRefs: [{ kind: 'document' as const, documentId }],
      };
      const ctx = { jobId, businessId: BUSINESS, bundle, agent: 'comms.email' as const };

      const first = await runLocalTool('agent.request_help', input, ctx);
      expect(first['status']).toBe('delegated');
      const envelopeId = first['envelopeId'] as string;
      const childJobId = first['childJobId'] as string;

      // Simulate the resumed run: the parent is back in `execute` (as
      // `resumeDelegatedJobs` would only ever put it once it has an answer —
      // this test deliberately does NOT go through it, to isolate what the
      // handler does when no `result` envelope exists at all), and the SAME
      // step runs again.
      await transition(jobId, { to: 'execute', actor: 'orchestrator', reason: 'test resume', businessId: BUSINESS });

      const second = await runLocalTool('agent.request_help', input, ctx);
      expect(second['performed']).toBe(false);
      expect(second['status']).toBe('pending');
      expect(second['parked']).toBe(true);
      expect(second['envelopeId']).toBe(envelopeId);
      expect(second['childJobId']).toBe(childJobId);

      const parent = await loadJob(jobId, { businessId: BUSINESS });
      expect(parent?.phase).toBe('followup');
      // The SAME envelope id — not cleared, not a new one — so
      // `resumeDelegatedJobs` keeps watching this exact delegation.
      expect(parent?.awaitingEnvelopeId).toBe(envelopeId);

      // Fix round 3, item 3: `job_steps.envelope_id` must name this envelope
      // too, not just `jobs.awaiting_envelope_id` — the original park
      // (`delegate.ts`) sets both, and omitting it here left the id
      // surviving only in the Hebrew reason string.
      const { rows: stepRows } = await getPool().query<{ envelope_id: string | null }>(
        'SELECT envelope_id FROM job_steps WHERE job_id = $1 ORDER BY id DESC LIMIT 1',
        [jobId],
      );
      expect(stepRows[0]?.envelope_id).toBe(envelopeId);

      // The child itself is untouched by any of this.
      const child = await loadJob(childJobId, { businessId: BUSINESS });
      expect(child?.phase).toBe('execute');
    });

    /**
     * Fix round 3, item 1, the good-parse half. A `result` envelope whose
     * payload actually matches `ResultEnvelopePayload` completes the step
     * normally — this is the ordinary case the corrupted-payload test right
     * after it is contrasted against.
     */
    it('completes the step from a well-formed result envelope written directly, without asking the child\'s phase', async () => {
      const { jobId, bundle } = await parentJobInExecute();
      const documentId = `DOC-${ulid()}`;
      const input = {
        to: 'know.reader' as const,
        intent: 'read_for_question',
        payload: { question: 'מה המסמך הזה מבקש?' },
        contextRefs: [{ kind: 'document' as const, documentId }],
      };
      const ctx = { jobId, businessId: BUSINESS, bundle, agent: 'comms.email' as const };

      const first = await runLocalTool('agent.request_help', input, ctx);
      const childJobId = first['childJobId'] as string;

      // A well-formed result, written directly rather than through
      // `resumeDelegatedJobs` — isolating what THIS handler does with one,
      // not re-testing the writer.
      await writeEnvelope(
        {
          v: 1,
          id: `ENV-${ulid()}`,
          correlationId: jobId,
          causalChain: [],
          from: 'know.reader',
          to: 'comms.email',
          kind: 'result',
          intent: 'read_for_question',
          payload: { outcome: 'succeeded', note: 'נענתה' },
          contextRefs: [{ kind: 'job', jobId: childJobId }],
          constraints: {
            charterVersion: bundle.charterVersion,
            provenanceCeiling: 'boss',
            autonomyCeiling: 'auto',
            moneyCeilingMinor: null,
            deadlineAt: '2026-12-31T00:00:00.000Z',
          },
          hops: 1,
          idempotencyKey: `IDEM-${ulid()}`,
          createdAt: new Date().toISOString(),
        },
        { parentJobId: childJobId, businessId: BUSINESS },
      );

      await transition(jobId, { to: 'execute', actor: 'orchestrator', reason: 'test resume', businessId: BUSINESS });
      const second = await runLocalTool('agent.request_help', input, ctx);
      expect(second['performed']).toBe(true);
      expect(second['status']).toBe('answered');
      expect(second['outcome']).toBe('succeeded');
    });

    /**
     * Fix round 3, item 1, the unparseable half. Before this fix, a `result`
     * envelope whose `outcome` did not survive `ResultEnvelopePayload`
     * completed the step as `done` with `outcome: 'unknown'` anyway — a
     * value we could not read, treated as a permitting one. It must instead
     * be refused the same way any other corrupted delegation state here is
     * refused (non-retryably, failing the parent).
     */
    it('fails rather than completes when the result envelope payload cannot be parsed', async () => {
      const { jobId, bundle } = await parentJobInExecute();
      const documentId = `DOC-${ulid()}`;
      const input = {
        to: 'know.reader' as const,
        intent: 'read_for_question',
        payload: { question: 'מה המסמך הזה מבקש?' },
        contextRefs: [{ kind: 'document' as const, documentId }],
      };
      const ctx = { jobId, businessId: BUSINESS, bundle, agent: 'comms.email' as const };

      const first = await runLocalTool('agent.request_help', input, ctx);
      const childJobId = first['childJobId'] as string;

      // A malformed result — `outcome` is not one of the closed union.
      await writeEnvelope(
        {
          v: 1,
          id: `ENV-${ulid()}`,
          correlationId: jobId,
          causalChain: [],
          from: 'know.reader',
          to: 'comms.email',
          kind: 'result',
          intent: 'read_for_question',
          payload: { outcome: 'not-a-real-outcome' },
          contextRefs: [{ kind: 'job', jobId: childJobId }],
          constraints: {
            charterVersion: bundle.charterVersion,
            provenanceCeiling: 'boss',
            autonomyCeiling: 'auto',
            moneyCeilingMinor: null,
            deadlineAt: '2026-12-31T00:00:00.000Z',
          },
          hops: 1,
          idempotencyKey: `IDEM-${ulid()}`,
          createdAt: new Date().toISOString(),
        },
        { parentJobId: childJobId, businessId: BUSINESS },
      );

      await transition(jobId, { to: 'execute', actor: 'orchestrator', reason: 'test resume', businessId: BUSINESS });

      let caught: unknown;
      try {
        await runLocalTool('agent.request_help', input, ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StepChannelError);
      const typed = caught as StepChannelError;
      expect(typed.code).toBe('delegation_result_corrupted');
      expect(typed.retryable).toBe(false);
    });

    /**
     * Fix round 1, Important 4. `loadEnvelopeForChildJob` had no test at all:
     * both cases above use a root parent, so the lookup returns `null`
     * either way and a mutation replacing the real call with a literal
     * `null` would leave the whole suite green. This seeds a MIDDLE job that
     * is itself governed by a real ancestor envelope (strict constraints,
     * `hops: 3`) and asserts a delegation opened FROM that job inherits the
     * ancestor's values — never `ROOT_ANCESTOR_CONSTRAINTS`'s permissive
     * defaults, and never `hops: 0`, which would reset the correlation both
     * anti-ping-pong guards scope by.
     */
    it("inherits the ancestor envelope governing the CURRENT job, not a root baseline", async () => {
      const { jobId: middleJobId, bundle } = await parentJobInExecute();

      // Strictly tighter than anything `requestHelp` would derive on its own
      // for this call (provenance `boss`, autonomy `auto`, no money cap, a
      // 24h deadline) — so every field surviving in the grandchild's envelope
      // proves the ancestor was actually read, not merely defaulted.
      const strictDeadline = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const ancestorEnvelope: AgentEnvelope = {
        v: 1,
        id: `ENV-${ulid()}`,
        correlationId: 'JOB-root-of-the-tree',
        causalChain: ['ENV-earlier'],
        from: 'sched.meetings',
        to: 'comms.email',
        kind: 'help_request',
        intent: 'an_earlier_intent',
        payload: {},
        contextRefs: [],
        constraints: {
          charterVersion: bundle.charterVersion,
          provenanceCeiling: 'unknown_external',
          autonomyCeiling: 'draft_only',
          moneyCeilingMinor: 100,
          deadlineAt: strictDeadline,
        },
        hops: 3,
        idempotencyKey: `IDEM-${ulid()}`,
        createdAt: new Date().toISOString(),
      };
      await writeEnvelope(ancestorEnvelope, { parentJobId: 'JOB-some-grandparent', businessId: BUSINESS });
      await attachChildJob(ancestorEnvelope.id, middleJobId, { businessId: BUSINESS });

      const documentId = `DOC-${ulid()}`;
      const out = await runLocalTool(
        'agent.request_help',
        {
          to: 'know.reader',
          intent: 'read_for_question',
          payload: { question: 'מה המסמך הזה מבקש?' },
          contextRefs: [{ kind: 'document', documentId }],
        },
        { jobId: middleJobId, businessId: BUSINESS, bundle, agent: 'comms.email' },
      );

      expect(out['status']).toBe('delegated');
      const envelope = await loadEnvelope(out['envelopeId'] as string, { businessId: BUSINESS });
      expect(envelope?.hops).toBe(4); // ancestor's 3 + 1, never 0 + 1
      expect(envelope?.correlationId).toBe('JOB-root-of-the-tree'); // inherited, not middleJobId
      expect(envelope?.constraints.provenanceCeiling).toBe('unknown_external');
      expect(envelope?.constraints.autonomyCeiling).toBe('draft_only');
      expect(envelope?.constraints.moneyCeilingMinor).toBe(100);
      expect(envelope?.constraints.deadlineAt).toBe(strictDeadline);
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

  /**
   * `assert.evaluate` — the second half of `gov.verify`'s check, the step that
   * runs once the helper it asked has answered. Until this task the tool had
   * no implementation, so the one-step plan `beginVerification` binds would
   * have completed with `not_implemented` and filed no verdict at all.
   *
   * The question is a local literal on purpose: the real one is module-private
   * in `conduct.ts` and stays that way — exporting a conductor constant for a
   * test's convenience couples the two, and this handler passes the question
   * through without reading it.
   */
  describe('assert.evaluate', () => {
    const VERIFICATION_QUESTION = 'מה המסמך מבקש, ומה בו מחייב תשובה?';
    const SUMMARY = 'הצעת מחיר לאספקה, עם בקשה לאישור בכתב.';

    /** A minimal valid `Verdict` — `criteria` must carry at least one entry. */
    const stubJudge = async (_input: VerifyDraftInput): Promise<VerifyDraftResult> => ({
      criteria: [
        {
          id: 'c1',
          statement: 'הטיוטה עונה על מה שהמסמך ביקש',
          severity: 'must',
          passed: true,
          detail: 'נבדק',
        },
      ],
      ungroundedNumbers: [],
      answerTruncated: false,
      draftTruncated: false,
    });

    /**
     * A `gov.verify` job in `execute` that has already delegated, plus the
     * document and the saved reading its answer is composed from.
     *
     * `outcome === null` means the helper has not answered: the `help_request`
     * envelope and its child exist, and no `result` envelope does.
     */
    async function seedDelegation(outcome: DelegationOutcome | null): Promise<{
      parentJobId: string;
      subjectJobId: string;
      documentId: string;
      childJobId: string;
      bundle: ReturnType<typeof compileCharter>;
    }> {
      const bundle = await installCharter(buildCharter({ version: `verify-${ulid()}` }), {
        businessId: BUSINESS,
      });

      // `unknown_external`, the literal `conduct.ts` hard-codes for the
      // delegating job — and therefore the provenance the saved reading must
      // carry, since `loadLatestReading` is keyed on it.
      const parent = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'unknown_external',
        businessId: BUSINESS,
        title: 'אימות: טיוטה',
      });
      for (const to of ['understand', 'plan', 'execute'] as const) {
        await transition(parent.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
      }

      // The job whose draft is judged — never the same row as the delegating
      // job, the separation `VerifyDraftInput.subjectJobId` insists on.
      const subject = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'unknown_external',
        businessId: BUSINESS,
        title: 'הטיוטה שנבדקת',
      });

      const child = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'unknown_external',
        businessId: BUSINESS,
        title: 'know.reader',
      });

      const documentId = `DOC-${ulid()}`;
      await insertOrGetDocument(
        {
          documentId,
          source: 'manual',
          originalName: 'הצעה.txt',
          mediaType: 'text/plain',
          sha256: ulid().padEnd(64, '0'),
          byteSize: 64,
          storedPath: `${BUSINESS}/${documentId}/original.txt`,
        },
        { businessId: BUSINESS },
      );
      await markExtracted(
        documentId,
        [
          {
            ordinal: 0,
            kind: 'text',
            partName: 'גוף',
            content: { blocks: [{ kind: 'paragraph', text: 'התמורה 11,988 ש"ח.' }] },
            flags: [],
          },
        ],
        { businessId: BUSINESS },
      );
      await saveReading(
        {
          readingId: `RD-${ulid()}`,
          documentId,
          status: 'read',
          reason: null,
          content: {
            summary: SUMMARY,
            findings: [],
            intents: [
              {
                intent: 'reply_to_sender',
                subject: { kind: 'sender' },
                sourceRef: { ordinal: 0, locator: null },
                note: '',
              },
            ],
            unreadable: [],
          },
          provenance: 'unknown_external',
          model: 'stub',
          promptVersion: 'v1',
          briefHash: `BH-${ulid()}`,
        },
        { businessId: BUSINESS },
      );

      const constraints = {
        charterVersion: bundle.charterVersion,
        provenanceCeiling: 'unknown_external' as const,
        autonomyCeiling: 'draft_only' as const,
        moneyCeilingMinor: null,
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      const request: AgentEnvelope = {
        v: 1,
        id: `ENV-${ulid()}`,
        // A root delegating job correlates on its own id, the way
        // `requestHelp` derives it when no ancestor envelope exists.
        correlationId: parent.jobId,
        causalChain: [],
        from: 'gov.verify',
        to: 'know.reader',
        kind: 'help_request',
        intent: 'read_for_question',
        payload: { question: VERIFICATION_QUESTION },
        contextRefs: [{ kind: 'document', documentId }],
        constraints,
        hops: 1,
        idempotencyKey: `IDEM-${ulid()}`,
        createdAt: new Date().toISOString(),
      };
      // `parentJobId` is the DELEGATING job — the column the handler looks the
      // request up by.
      await writeEnvelope(request, { parentJobId: parent.jobId, businessId: BUSINESS });
      await attachChildJob(request.id, child.jobId, { businessId: BUSINESS });

      if (outcome !== null) {
        // Exactly the shape `resumeDelegatedJobs`'s `writeResultAndWake`
        // writes, including `parentJobId: childJobId` — which is why the
        // handler's `kind = 'help_request'` predicate has work to do.
        await writeEnvelope(
          {
            v: 1,
            id: `ENV-${ulid()}`,
            correlationId: parent.jobId,
            causalChain: [request.id],
            from: 'know.reader',
            to: 'gov.verify',
            kind: 'result',
            intent: 'read_for_question',
            payload: { outcome, note: 'נענתה' },
            contextRefs: [{ kind: 'job', jobId: child.jobId }],
            constraints,
            hops: 1,
            idempotencyKey: `IDEM-${ulid()}`,
            createdAt: new Date().toISOString(),
          },
          { parentJobId: child.jobId, businessId: BUSINESS },
        );
      }

      return {
        parentJobId: parent.jobId,
        subjectJobId: subject.jobId,
        documentId,
        childJobId: child.jobId,
        bundle,
      };
    }

    const seedAnsweredDelegation = (outcome: DelegationOutcome) => seedDelegation(outcome);
    const seedUnansweredDelegation = () => seedDelegation(null);

    it('judges and files a verdict when the delegation succeeded', async () => {
      // Full shape: a gov.verify job parked on an envelope whose child answered.
      const { parentJobId, subjectJobId, documentId, bundle } =
        await seedAnsweredDelegation('succeeded');
      // Captures what the judge was actually given, so the assertions below
      // prove the reading was loaded and composed rather than that the call
      // merely happened.
      let seen: VerifyDraftInput | null = null;
      const capturing = async (input: VerifyDraftInput): Promise<VerifyDraftResult> => {
        seen = input;
        return stubJudge(input);
      };

      const outcome = await runLocalTool(
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'שלום, מאשר את ההצעה.', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: capturing },
      );

      // Proves the handler RAN, not merely that nothing bad happened.
      expect(outcome).toMatchObject({ performed: true, status: 'judged' });
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toMatchObject({
        status: 'judged',
      });

      const given = seen as VerifyDraftInput | null;
      if (given === null) throw new Error('the verifier was never called');
      // The answer is the composed reading, not the document — the one
      // document-derived channel into the judge.
      expect(given.answer).toContain(SUMMARY);
      expect(given.answer).toContain('reply_to_sender');
      // The subject job, never the delegating one.
      expect(given.subjectJobId).toBe(subjectJobId);
      expect(given.parentJobId).toBe(parentJobId);
      // A root delegating job has no ancestor envelope, and the request it
      // opened itself must never be passed as one.
      expect(given.parentEnvelope).toBeNull();
      // The artifacts were loaded for numeric grounding.
      expect(given.sources.join('\n')).toContain('11,988');
    });

    it('files "not judged" and never calls the judge when the child failed', async () => {
      const { parentJobId, subjectJobId, documentId, bundle } = await seedAnsweredDelegation('failed');
      let judgeCalls = 0;
      const counting = async (input: VerifyDraftInput) => {
        judgeCalls += 1;
        return stubJudge(input);
      };
      const outcome = await runLocalTool(
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
      );
      expect(outcome).toMatchObject({ performed: true, status: 'not_judged', reason: 'failed' });
      expect(judgeCalls).toBe(0);
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toEqual({
        status: 'not_judged',
        reason: 'failed',
      });
    });

    it('files "not judged" with reason timeout when the deadline fired', async () => {
      const { parentJobId, subjectJobId, documentId, bundle } = await seedAnsweredDelegation('timeout');
      // Counted here for the same reason it is counted on the `failed` case:
      // the point of both is that the judge did not run at all, and a test
      // that only reads the filed row would pass on a handler that billed a
      // call and then discarded it.
      let judgeCalls = 0;
      const counting = async (input: VerifyDraftInput) => {
        judgeCalls += 1;
        return stubJudge(input);
      };
      const outcome = await runLocalTool(
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
      );
      expect(judgeCalls).toBe(0);
      expect(outcome).toMatchObject({ status: 'not_judged', reason: 'timeout' });
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toEqual({
        status: 'not_judged',
        reason: 'timeout',
      });
    });

    it('refuses when no result envelope exists — a state step 1 cannot produce', async () => {
      const { parentJobId, subjectJobId, documentId, bundle } = await seedUnansweredDelegation();
      let caught: unknown;
      try {
        await runLocalTool(
          'assert.evaluate',
          { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
          { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StepChannelError);
      const typed = caught as StepChannelError;
      expect(typed.code).toBe('verification_answer_missing');
      expect(typed.retryable).toBe(false);
      // A refusal files nothing — the card must keep reading "still running",
      // not "gave up", while the helper may yet answer.
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toBeNull();
    });

    /**
     * The delegation succeeded and came back with nothing to judge.
     * `ReadingRecord.content` is `Reading | null`, and a record whose `status`
     * is `unreadable` is exactly that shape — `know.reader` returns it for a
     * document it could not read, and its child job closes normally, so the
     * `result` envelope says `succeeded`.
     *
     * **Filed, not thrown.** A refusal would write no row, and absence in this
     * table means "still running" — so every unreadable document would have
     * left its card saying that forever. `unreadable` is the third
     * `NotJudgedReason` (migration 031) for exactly this state.
     */
    it('files "not judged" with reason unreadable when the reading carries no content', async () => {
      const { parentJobId, subjectJobId, documentId, bundle } =
        await seedAnsweredDelegation('succeeded');
      // Newer than the readable row seeded above, so `loadLatestReading` — which
      // orders by `created_at DESC` — returns this one.
      await saveReading(
        {
          readingId: `RD-${ulid()}`,
          documentId,
          status: 'unreadable',
          reason: 'לא ניתן היה לקרוא',
          content: null,
          provenance: 'unknown_external',
          model: 'stub',
          promptVersion: 'v1',
          briefHash: `BH-${ulid()}`,
        },
        { businessId: BUSINESS },
      );
      let judgeCalls = 0;
      const counting = async (input: VerifyDraftInput) => {
        judgeCalls += 1;
        return stubJudge(input);
      };

      const outcome = await runLocalTool(
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
      );

      expect(outcome).toMatchObject({ performed: true, status: 'not_judged', reason: 'unreadable' });
      expect(judgeCalls).toBe(0);
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toEqual({
        status: 'not_judged',
        reason: 'unreadable',
      });
    });

    /**
     * The same state reached the other way: a document with no extracted parts
     * makes `doc.fetch` return `no_artifacts` and save no reading at all, and
     * the child still completes. A missing row and an empty one mean the same
     * thing here — the helper had nothing to tell us — and must file the same
     * reason rather than one filing and one refusing.
     */
    it('files "not judged" with reason unreadable when no reading was saved at all', async () => {
      const { parentJobId, subjectJobId, bundle } = await seedAnsweredDelegation('succeeded');
      // A document this job never read: no `document_readings` row exists for
      // it under any provenance.
      const unreadDocumentId = `DOC-${ulid()}`;
      let judgeCalls = 0;
      const counting = async (input: VerifyDraftInput) => {
        judgeCalls += 1;
        return stubJudge(input);
      };

      const outcome = await runLocalTool(
        'assert.evaluate',
        {
          subjectJobId,
          documentId: unreadDocumentId,
          draftText: 'טיוטה',
          question: VERIFICATION_QUESTION,
        },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
      );

      expect(outcome).toMatchObject({ performed: true, status: 'not_judged', reason: 'unreadable' });
      expect(judgeCalls).toBe(0);
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toEqual({
        status: 'not_judged',
        reason: 'unreadable',
      });
    });

    /**
     * `answer` is non-null on every call this handler makes, so `verifyDraft`
     * has no branch left that delegates — and if one appears, the step must
     * say so loudly rather than file a verdict it never got. Only a stub can
     * produce this shape today; the refusal is here so the day the real
     * function's branching changes, it fails visibly.
     */
    it('refuses if the verifier delegates a second time, and files nothing', async () => {
      const { parentJobId, subjectJobId, documentId, childJobId, bundle } =
        await seedAnsweredDelegation('succeeded');
      const delegatingAgain = async (): Promise<VerifyDraftResult> => ({
        status: 'awaiting_delegation',
        envelopeId: `ENV-${ulid()}`,
        childJobId,
        ungroundedNumbers: [],
      });

      let caught: unknown;
      try {
        await runLocalTool(
          'assert.evaluate',
          { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
          {
            jobId: parentJobId,
            businessId: BUSINESS,
            bundle,
            agent: 'gov.verify',
            verifier: delegatingAgain,
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StepChannelError);
      expect((caught as StepChannelError).code).toBe('verification_delegated_again');
      expect((caught as StepChannelError).retryable).toBe(false);
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toBeNull();
    });

    /**
     * A `result` envelope whose payload does not parse is a corrupted state,
     * not an outcome — refused, never filed as `not_judged`, which would claim
     * we know the helper failed when we do not.
     */
    it('refuses a result envelope whose payload cannot be read', async () => {
      const { parentJobId, subjectJobId, documentId, childJobId, bundle } =
        await seedUnansweredDelegation();
      await writeEnvelope(
        {
          v: 1,
          id: `ENV-${ulid()}`,
          correlationId: parentJobId,
          causalChain: [],
          from: 'know.reader',
          to: 'gov.verify',
          kind: 'result',
          intent: 'read_for_question',
          payload: { outcome: 'not-a-real-outcome' },
          contextRefs: [{ kind: 'job', jobId: childJobId }],
          constraints: {
            charterVersion: bundle.charterVersion,
            provenanceCeiling: 'unknown_external',
            autonomyCeiling: 'draft_only',
            moneyCeilingMinor: null,
            deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          hops: 1,
          idempotencyKey: `IDEM-${ulid()}`,
          createdAt: new Date().toISOString(),
        },
        { parentJobId: childJobId, businessId: BUSINESS },
      );

      let caught: unknown;
      try {
        await runLocalTool(
          'assert.evaluate',
          { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
          { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StepChannelError);
      expect((caught as StepChannelError).code).toBe('delegation_result_corrupted');
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toBeNull();
    });

    it('rejects a payload that names no subject job, without reaching the judge', async () => {
      const { parentJobId, documentId, bundle } = await seedAnsweredDelegation('succeeded');
      let judgeCalls = 0;
      const counting = async (input: VerifyDraftInput) => {
        judgeCalls += 1;
        return stubJudge(input);
      };
      let caught: unknown;
      try {
        await runLocalTool(
          'assert.evaluate',
          { documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
          { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: counting },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StepChannelError);
      expect((caught as StepChannelError).code).toBe('local_tool_bad_input');
      expect((caught as StepChannelError).message).toContain('subjectJobId');
      expect(judgeCalls).toBe(0);
    });

    it('running twice files one verdict, not two', async () => {
      const { parentJobId, subjectJobId, documentId, bundle } =
        await seedAnsweredDelegation('succeeded');
      const args = [
        'assert.evaluate',
        { subjectJobId, documentId, draftText: 'טיוטה', question: VERIFICATION_QUESTION },
        { jobId: parentJobId, businessId: BUSINESS, bundle, agent: 'gov.verify', verifier: stubJudge },
      ] as const;
      const first = await runLocalTool(...args);
      const second = await runLocalTool(...args);
      // Both runs judged — the count below is about the row, not about one of
      // the two calls having quietly refused.
      expect(first).toMatchObject({ performed: true, status: 'judged' });
      expect(second).toMatchObject({ performed: true, status: 'judged' });
      const { rows } = await getPool().query(
        `SELECT count(*)::int AS n FROM verification_verdicts WHERE business_id = $1 AND job_id = $2`,
        [BUSINESS, subjectJobId],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });
});
