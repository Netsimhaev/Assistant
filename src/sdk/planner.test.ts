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

  it('puts the owner\'s instruction in the final section, not the intents array', async () => {
    const b = await bundle();
    const prompt = buildPlannerPrompt({
      bundle: b,
      intents: [],
      instruction: 'תשלחי לדנה את ההצעה',
      provenance: 'boss',
      rampLevel: 'approve_required',
    });

    expect(prompt).toContain('תשלחי לדנה את ההצעה');
    expect(prompt).toContain('# ההוראה מבעל העסק');
    expect(prompt).not.toContain('# ה-intents');
  });

  it('keeps everything before the final section byte-identical either way', async () => {
    // The cacheable prefix is the whole point of assembling the prompt in this
    // order (see the function's docblock). If an instruction changed anything
    // above the final heading, every instruction would miss the cache.
    const b = await bundle();
    const base = { bundle: b, intents: [], provenance: 'boss' as const, rampLevel: 'approve_required' as const };
    const withIntents = buildPlannerPrompt(base);
    const withInstruction = buildPlannerPrompt({ ...base, instruction: 'תשלחי לדנה' });

    const prefixOf = (p: string): string => p.slice(0, p.lastIndexOf('# '));
    expect(prefixOf(withInstruction)).toBe(prefixOf(withIntents));
    // And they must actually differ below it — without this the assertion
    // above holds trivially when the feature is absent, since the extra
    // property is simply ignored and both prompts come out identical.
    expect(withInstruction).toContain('תשלחי לדנה');
    expect(withIntents).not.toContain('תשלחי לדנה');
  });

  /**
   * The live run of 11/09, and the reason this section exists.
   *
   * The owner typed "reply by email to Moti at moti@alfa-tech.example …".
   * The planner wrote a `mail.send` step with no `inReplyTo` — correctly,
   * since the quote arrived as a file in the inbox and there is no thread —
   * and declared `expectedActionClass: 'email.reply'`. `classMismatch`
   * refused the whole instruction: the gate classifies a `mail.send` without
   * a thread reference as `email.initiate`.
   *
   * The model was not guessing. The catalogue renders `mail.send · email.reply`
   * because `classifyAction` returns the BASE class, and the prompt then asks
   * for the class the step "will be considered". It copied what it was shown —
   * the same failure as the read-only label (L1), one column over.
   *
   * The column stays a bare token, because prose there is what L1 was about.
   * The rule goes in a section of its own instead.
   */
  it('states the payload-refinement rules, so a reply without a thread is not planned as one', async () => {
    const prompt = buildPlannerPrompt({
      bundle: await bundle(),
      intents: [],
      provenance: 'boss',
      rampLevel: 'approve_required',
    });

    // The deciding field and both outcomes, for the case that actually broke.
    expect(prompt).toContain('inReplyTo');
    expect(prompt).toContain('email.initiate');
    // `email.initiate` is refinement-only — no tool maps to it — so the
    // catalogue can never print it. Without the rules section this assertion
    // has nothing to match, which is what makes it bite.
    expect(prompt).toContain('conversationId');
    expect(prompt).toContain('whatsapp.initiate');
    // The money-bearing click, whose refinement is the one with a price tag.
    expect(prompt).toContain('purchase.place');
  });

  it('still renders the intents array when no instruction is given', async () => {
    const b = await bundle();
    const prompt = buildPlannerPrompt({
      bundle: b,
      intents: [{ name: 'reply_to_sender' }],
      provenance: 'boss',
      rampLevel: 'approve_required',
    });

    expect(prompt).toContain('# ה-intents');
    expect(prompt).toContain('reply_to_sender');
  });
});
