import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan, planProblems, topologicalOrder } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, jobHistory, loadJob, transition } from './jobs.js';
import { capabilityCatalogue, renderCatalogue } from './catalogue.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function install(overrides = {}): Promise<PolicyBundle> {
  return installCharter(buildCharter(overrides), { businessId: BUSINESS });
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
    const performed: string[] = [];

    const result = await runPlan({
      job,
      bundle,
      plan: plan(),
      perform: async (step) => {
        performed.push(step.id);
        return null;
      },
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    expect(performed).toEqual(['s1', 's2']);

    // Every step transition is in the history; nothing advanced silently.
    const history = await jobHistory(job.jobId);
    expect(history.filter((h) => h.reason.includes('s1')).length).toBeGreaterThan(0);
    expect(history.filter((h) => h.reason.includes('s2')).length).toBeGreaterThan(0);
  });

  it('rejects a whole plan rather than half-executing it', async () => {
    const bundle = await install();
    const job = await jobInExecute(bundle);
    let performed = 0;

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
      perform: async () => {
        performed += 1;
        return null;
      },
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    expect(performed).toBe(0);
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
      perform: async () => null,
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
    const performed: string[] = [];

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
      perform: async (step) => {
        performed.push(step.id);
        return null;
      },
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.at).toBe('s1');
    // The second step never ran, and the job says what happens next.
    expect(performed).toEqual([]);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });
});
