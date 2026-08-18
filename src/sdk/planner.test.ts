import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { buildPlannerPrompt, parsePlan } from './planner.js';

const BUSINESS = 'test-business';

const GOOD_PLAN = {
  goal: 'לענות ללקוח',
  assumptions: [],
  clarifyingQuestion: null,
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'draft_reply',
      toolName: 'mail.send',
      input: { to: 'a@b.com', inReplyTo: 'm1' },
      dependsOn: [],
      expectedActionClass: null,
    },
  ],
  estimatedCostMinor: 0,
};

async function bundle(): Promise<PolicyBundle> {
  return installCharter(buildCharter(), { businessId: BUSINESS });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

/**
 * The model is not under test here. What is under test is everything that
 * stands between the model's output and something running — because the model
 * is the component the whole architecture assumes can be talked into things.
 */
describe('parsing what the planner returned', () => {
  it('accepts a clean plan', () => {
    const result = parsePlan(JSON.stringify(GOOD_PLAN));
    expect(result.status).toBe('planned');
  });

  it('finds the plan inside a fenced block with prose around it', () => {
    const raw = `בטח, הנה התוכנית:\n\`\`\`json\n${JSON.stringify(GOOD_PLAN)}\n\`\`\`\nאשמח להמשיך.`;
    expect(parsePlan(raw).status).toBe('planned');
  });

  it('skips an illustrative object and takes the plan that follows', () => {
    // Scanning for a balanced object rather than first `{` to last `}`: the
    // naive span across both objects is not valid JSON at all.
    const raw = `לדוגמה: {"note": "not a plan"}\n\n${JSON.stringify(GOOD_PLAN)}`;
    const result = parsePlan(raw);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error('unreachable');
    expect(result.plan.goal).toBe('לענות ללקוח');
  });

  it('refuses a response with no JSON at all rather than guessing', () => {
    const result = parsePlan('אני לא בטוח מה נדרש כאן.');
    expect(result.status).toBe('unparseable');
  });

  it('refuses a plan naming an agent that does not exist', () => {
    const raw = JSON.stringify({
      ...GOOD_PLAN,
      steps: [{ ...GOOD_PLAN.steps[0], agent: 'comms.telepathy' }],
    });
    expect(parsePlan(raw).status).toBe('unparseable');
  });

  it('refuses a plan whose steps form a cycle', () => {
    const raw = JSON.stringify({
      ...GOOD_PLAN,
      steps: [
        { ...GOOD_PLAN.steps[0], id: 'a', dependsOn: ['b'] },
        { ...GOOD_PLAN.steps[0], id: 'b', dependsOn: ['a'] },
      ],
    });
    const result = parsePlan(raw);
    expect(result.status).toBe('unparseable');
    if (result.status !== 'unparseable') throw new Error('unreachable');
    expect(result.reason).toContain('cycle');
  });

  it('refuses a plan with no steps', () => {
    expect(parsePlan(JSON.stringify({ ...GOOD_PLAN, steps: [] })).status).toBe('unparseable');
  });
});

describe('the planner prompt', () => {
  it('puts the varying part last so the cached prefix survives', async () => {
    const b = await bundle();
    const first = buildPlannerPrompt({
      bundle: b,
      intents: { id: 'A' },
      provenance: 'boss',
      rampLevel: 'auto',
    });
    const second = buildPlannerPrompt({
      bundle: b,
      intents: { id: 'B' },
      provenance: 'boss',
      rampLevel: 'auto',
    });

    // Everything before the intents must be byte-identical across jobs: one
    // varying byte invalidates the whole cached prefix and costs ~10x.
    const prefixOf = (text: string) => text.slice(0, text.indexOf('# ה-intents'));
    expect(prefixOf(first)).toBe(prefixOf(second));
    expect(first).not.toBe(second);
  });

  it('tells the planner what it will actually be allowed to do', async () => {
    const b = await bundle();
    const untrusted = buildPlannerPrompt({
      bundle: b,
      intents: {},
      provenance: 'open_web',
      rampLevel: 'auto',
    });

    // A planner working from web content is told up front that it is capped at
    // draft_only, rather than discovering it at the gate on step four.
    expect(untrusted).toContain('draft_only');
    expect(untrusted).toContain('## comms.email');
  });

  it('carries the signed charter, not a paraphrase of it', async () => {
    const b = await bundle();
    const prompt = buildPlannerPrompt({
      bundle: b,
      intents: {},
      provenance: 'boss',
      rampLevel: 'auto',
    });
    expect(prompt).toContain(b.plainLanguage);
  });
});
