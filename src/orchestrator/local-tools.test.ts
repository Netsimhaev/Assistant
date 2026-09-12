import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob, transition } from './jobs.js';
import { Plan } from '../domain/plan.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';
import { recallMemories } from '../memory/store.js';
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
});
