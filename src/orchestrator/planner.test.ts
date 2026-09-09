import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan, planProblems, topologicalOrder } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { createJob, jobHistory, loadJob, transition } from './jobs.js';
import { READ_ONLY_CLASS_LABEL, capabilityCatalogue, renderCatalogue } from './catalogue.js';
import { AdapterRegistry } from './adapters/registry.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './adapters/types.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

/**
 * These tests are about plan validation and DAG ordering, not about channels.
 * One catch-all connection serving the OUTBOUND tools they use keeps channel
 * resolution out of their way: without it every plan here would be rejected
 * for having no channel, and the assertions below would pass for a reason
 * that has nothing to do with what they are testing.
 *
 * `crm.read` is deliberately absent. It reaches nothing outside the instance,
 * so it needs no connection — and having had to list it here to keep these
 * tests green was the signal that the channel requirement was too wide.
 */
const SERVED_TOOLS = ['mail.send', 'crm.write'] as const;

const OFFICE: CharterConnection = {
  system: 'office-suite',
  label: 'מערכות המשרד',
  channel: 'api',
  serves: [...SERVED_TOOLS],
  target: null,
  subprocessor: null,
};

const OFFICE_LIVE: ConnectionBinding = {
  system: 'office-suite',
  status: 'live',
  endpoint: null,
  credentialRef: null,
  lastOkAt: null,
  lastError: null,
};

const CREDENTIALS = envCredentials({}, 'TEST_CRED_');

/** Records the tools it was asked to run, and reaches nothing external. */
function stubRegistry(): { calls: string[]; registry: AdapterRegistry } {
  const calls: string[] = [];
  const adapter: ExternalAdapter = {
    system: 'office-suite',
    channel: 'api',
    serves: [...SERVED_TOOLS],
    async execute(call: AdapterCall): Promise<AdapterResult> {
      calls.push(call.toolName);
      return { ok: true, output: null, externalId: null };
    },
  };
  return { calls, registry: new AdapterRegistry([adapter]) };
}

async function install(overrides: CharterOverrides = {}): Promise<PolicyBundle> {
  return installCharter(buildCharter({ connections: [OFFICE], ...overrides }), {
    businessId: BUSINESS,
  });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return Plan.parse({
    goal: 'לענות ללקוח ולעדכן את הרישום',
    steps: [
      {
        id: 's2',
        agent: 'ops.systems',
        intent: 'update_record',
        toolName: 'crm.write',
        input: { entityId: 'c_812', note: 'נענה' },
        dependsOn: ['s1'],
      },
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'draft_reply',
        toolName: 'mail.send',
        input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812' },
      },
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('the plan is a DAG, and that is checked before anything runs', () => {
  it('orders steps by dependency, not by the order they were written', () => {
    // s2 is written first but depends on s1.
    expect(topologicalOrder(plan()).map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('breaks ties in the planner order so the same plan always runs the same way', () => {
    const p = Plan.parse({
      goal: 'שני צעדים בלתי תלויים',
      steps: [
        { id: 'b', agent: 'ops.systems', intent: 'x', toolName: 'crm.read', input: {} },
        { id: 'a', agent: 'ops.systems', intent: 'y', toolName: 'crm.read', input: {} },
      ],
    });
    // A non-deterministic order would make a failure impossible to reproduce
    // from the audit trail, which is what the trail is for.
    expect(topologicalOrder(p).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('names a cycle rather than looping on it', () => {
    const p = plan({
      steps: [
        { id: 'a', agent: 'ops.systems', intent: 'x', toolName: 'crm.read', input: {}, dependsOn: ['b'], expectedActionClass: null },
        { id: 'b', agent: 'ops.systems', intent: 'y', toolName: 'crm.read', input: {}, dependsOn: ['a'], expectedActionClass: null },
      ],
    });
    expect(planProblems(p)).toContainEqual({ kind: 'cycle', stepIds: ['a', 'b'] });
  });

  it('catches a dependency on a step that does not exist', () => {
    const p = plan({
      steps: [
        { id: 'a', agent: 'ops.systems', intent: 'x', toolName: 'crm.read', input: {}, dependsOn: ['ghost'], expectedActionClass: null },
      ],
    });
    expect(planProblems(p)).toContainEqual({
      kind: 'unknown_dependency',
      stepId: 'a',
      dependsOn: 'ghost',
    });
  });

  it('refuses a plan naming an agent the enum does not have', () => {
    // Closed enums on everything the gate reads, so a plan naming a
    // nonexistent agent fails to parse rather than failing halfway through.
    const result = Plan.safeParse({
      goal: 'x',
      steps: [{ id: 'a', agent: 'comms.telepathy', intent: 'x', toolName: 'mail.send', input: {} }],
    });
    expect(result.success).toBe(false);
  });
});

describe('the capability catalogue makes a plan feasible by construction', () => {
  it('reports the autonomy a tool would actually resolve to', async () => {
    const bundle = await install();
    const entries = capabilityCatalogue(bundle, 'boss');
    const email = entries.find((e) => e.agent === 'comms.email');

    const send = email?.tools.find((t) => t.toolName === 'mail.send');
    expect(send?.actionClass).toBe('email.reply');
    expect(send?.effectiveAutonomy).toBe('auto_notify');
  });

  it('shows an untrusted chain what it will actually be allowed to do', async () => {
    const bundle = await install();
    const entries = capabilityCatalogue(bundle, 'open_web');
    const send = entries
      .find((e) => e.agent === 'comms.email')
      ?.tools.find((t) => t.toolName === 'mail.send');

    // The provenance ceiling caps open_web at draft_only, so a planner working
    // from web content is told that up front rather than discovering it at the
    // gate on step four.
    expect(send?.effectiveAutonomy).toBe('draft_only');
  });

  it('renders deterministically, because it is the most-cached text there is', async () => {
    const bundle = await install();
    const once = renderCatalogue(capabilityCatalogue(bundle, 'boss'));
    const twice = renderCatalogue(capabilityCatalogue(bundle, 'boss'));

    // A single varying byte invalidates the whole cached prefix.
    expect(once).toBe(twice);
    expect(once).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(once).toContain('## comms.email');
  });

  /**
   * L1, found by running the door against the real model.
   *
   * The catalogue used to render a class-less tool as the bare token
   * `read-only`, in the same column where every other tool shows a real
   * `ActionClass` member — and the same prompt then asks the model to fill
   * `expectedActionClass`. The model copied what it was shown, `ActionClass`
   * has no such member, `Plan.safeParse` failed, and the owner was told their
   * instruction could not be understood. Every control behaved correctly; the
   * label next door was the whole defect.
   *
   * The first assertion pins the subject present before the negative one is
   * allowed to mean anything: a rendered catalogue with no class-less tool in
   * it would satisfy "contains no bare `read-only`" for the wrong reason.
   */
  it('renders a class-less tool as a null instruction, never as a bare token', async () => {
    const bundle = await install();
    const entries = capabilityCatalogue(bundle, 'boss');

    const classless = entries.flatMap((e) => e.tools).filter((t) => t.actionClass === null);
    expect(classless.length, 'no class-less tool in the catalogue to render').toBeGreaterThan(0);

    const rendered = renderCatalogue(entries);
    expect(rendered).toContain(READ_ONLY_CLASS_LABEL);
    // The class column of every line is either a real ActionClass member or
    // the label above. `read-only` standing alone between the separators is
    // what the model copied.
    expect(rendered).not.toMatch(/ · read-only · /);
  });

  it('never lists a tool the gate would refuse', async () => {
    const bundle = await install();
    for (const entry of capabilityCatalogue(bundle, 'boss')) {
      for (const tool of entry.tools) {
        expect(tool.toolName, `${entry.agent} → ${tool.toolName}`).not.toBe('contract.sign');
      }
    }
    // ops.web holds no communication tool, however the catalogue is rendered.
    const web = capabilityCatalogue(bundle, 'boss').find((e) => e.agent === 'ops.web');
    expect(web?.tools.map((t) => t.toolName)).not.toContain('mail.send');
  });
});

describe('running a plan', () => {
  it('runs the steps in dependency order and records each one', async () => {
    const bundle = await install({ autonomyBase: { 'crm.write': 'auto' } });
    const job = await jobInExecute(bundle);
    const { calls, registry } = stubRegistry();

    const result = await runPlan({
      job,
      bundle,
      plan: plan(),
      registry,
      bindings: [OFFICE_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    // s2 is written first and depends on s1; the runner reports the order it
    // actually ran them in.
    expect(result.steps.map((record) => record.stepId)).toEqual(['s1', 's2']);
    // And both actually reached an adapter, in that same order.
    expect(calls).toEqual(['mail.send', 'crm.write']);

    // Every step transition is in the history; nothing advanced silently.
    const history = await jobHistory(job.jobId);
    expect(history.filter((h) => h.reason.includes('s1')).length).toBeGreaterThan(0);
    expect(history.filter((h) => h.reason.includes('s2')).length).toBeGreaterThan(0);
  });

  it('rejects a whole plan rather than half-executing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const { calls, registry } = stubRegistry();

    // ops.web may never send mail. The step is the *second* one, so a plan
    // validated lazily would have run the first before discovering it.
    const result = await runPlan({
      job,
      bundle,
      plan: plan({
        steps: [
          { id: 's1', agent: 'ops.systems', intent: 'read', toolName: 'crm.read', input: {}, dependsOn: [], expectedActionClass: null },
          { id: 's2', agent: 'ops.web', intent: 'send', toolName: 'mail.send', input: {}, dependsOn: ['s1'], expectedActionClass: null },
        ],
      }),
      registry,
      bindings: [OFFICE_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    // Rejected for the capability reason, not for a missing channel: both
    // tools are served by the charter connection above. Asserted so this test
    // cannot start passing for the wrong reason.
    expect(result.reason).toContain('ops.web may not use mail.send');
    expect(calls).toEqual([]);
  });

  it('refuses a plan that reasoned about a step as something it is not', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);

    // The planner thought this was a reply; with no thread it is a first
    // contact, which is a different autonomy level entirely.
    const result = await runPlan({
      job,
      bundle,
      plan: plan({
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'reply',
            toolName: 'mail.send',
            input: { to: 'stranger@example.com' },
            dependsOn: [],
            expectedActionClass: 'email.reply',
          },
        ],
      }),
      registry: stubRegistry().registry,
      bindings: [OFFICE_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('email.initiate');
  });

  it('stops at the step that needs a human and leaves the rest for later', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    const { calls, registry } = stubRegistry();

    const result = await runPlan({
      job,
      bundle,
      plan: plan({
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'first_contact',
            toolName: 'mail.send',
            input: { to: 'stranger@example.com', body: 'שלום' },
            dependsOn: [],
            expectedActionClass: null,
          },
          {
            id: 's2',
            agent: 'ops.systems',
            intent: 'log',
            toolName: 'crm.write',
            input: { entityId: 'c_812' },
            dependsOn: ['s1'],
            expectedActionClass: null,
          },
        ],
      }),
      registry,
      bindings: [OFFICE_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.at).toBe('s1');
    // Neither step reached an adapter, and the job says what happens next.
    expect(calls).toEqual([]);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });
});
