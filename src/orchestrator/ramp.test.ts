import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { Plan } from '../domain/plan.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { loadRampLevel, rampLevelForPlan, setRampLevel } from './ramp.js';

const BUSINESS = 'test-business';

function planWith(classes: (string | null)[]): Plan {
  return Plan.parse({
    goal: 'test',
    steps: classes.map((cls, i) => ({
      id: `s${i}`,
      agent: 'comms.email',
      intent: 'send',
      toolName: 'mail.send',
      input: {},
      expectedActionClass: cls,
    })),
  });
}

describe('autonomy ramp', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns draft_only when the business has no row for the class', async () => {
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('returns the stored level once one is set', async () => {
    // `learn` opens the widest window (`approve_required`..`auto_notify`), so
    // this proves the raw round-trip rather than the dial's clamp — that
    // clamp is `ramp-floor.test.ts`'s job.
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('does not read another business’s row', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: 'other-business' });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('falls back to draft_only when the stored level is not a known level', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const { getPool } = await import('../db/pool.js');
    await getPool().query(
      `UPDATE autonomy_ramp SET level = 'wide_open'
        WHERE business_id = $1 AND action_class = $2`,
      [BUSINESS, 'email.initiate'],
    );
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('setRampLevel overwrites rather than inserting a second row', async () => {
    // Same reason as the round-trip test above: without `learn` the dial
    // clamps both writes down to `draft_only` and the overwrite would be
    // invisible to this assertion.
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('takes the most restrictive level across every class a plan declares', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('crm.write', 'approve_required', { businessId: BUSINESS });
    const plan = planWith(['email.initiate', 'crm.write']);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('approve_required');
  });

  it('treats a step that declares no class as draft_only', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    // Every step here is `mail.send` — a tool that HAS a class. A `null` on
    // one of those is the planner declining to say, and still floors the plan.
    const plan = planWith(['email.initiate', null]);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('draft_only');
  });

  /**
   * The live run of 11/09, and the reason nothing had ever sent.
   *
   * The owner's instruction produced a perfectly ordinary three-step plan:
   * recall what we know, draft the reply, send it. The ramp for `email.reply`
   * stood at `auto_notify`, the charter allowed it, a standing authorisation
   * covered the recipient — and the gate denied at
   * `draft_only:persist_as_draft` anyway, because `memory.recall` and
   * `mail.draft` each contributed `RAMP_FLOOR` to the plan-wide minimum.
   *
   * Those two are `READ_ONLY_TOOLS`. Their class is `null` by construction,
   * not by the planner's omission — `classifyAction` returns `null` for them
   * and the gate short-circuits them before stage 8 ever runs, so they have no
   * ceiling to contribute and never did. Letting them vote floored every plan
   * that thinks before it speaks, which is every plan worth having: the ramp
   * was unreachable in practice, and raising it changed nothing.
   *
   * `capabilityCatalogue` already draws this exact distinction, reporting
   * `auto` for a read-only tool because "a read-only tool has no class and no
   * ceiling to combine; the gate short-circuits it, so reporting anything else
   * would be a lie". This makes the ramp agree with it.
   */
  it('lets a read-only step contribute no ceiling, so it cannot floor the plan', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    const plan = Plan.parse({
      goal: 'recall, draft, send',
      steps: [
        { id: 's1', agent: 'comms.email', intent: 'recall', toolName: 'memory.recall', input: {}, expectedActionClass: null },
        { id: 's2', agent: 'comms.email', intent: 'draft', toolName: 'mail.draft', input: {}, expectedActionClass: null },
        { id: 's3', agent: 'comms.email', intent: 'send', toolName: 'mail.send', input: {}, expectedActionClass: 'email.reply' },
      ],
    });

    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('auto_notify');
  });

  /**
   * The guard against reading the fix too broadly. A tool that is neither
   * classified nor on the read-only list is a tool nobody has reasoned about,
   * and it must still fail closed — otherwise "unknown" would buy the same
   * silence as "deliberately harmless", which is the inversion this whole
   * file exists to prevent.
   */
  it('still floors the plan for a classifiable tool the planner declined to classify', async () => {
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    const plan = Plan.parse({
      goal: 'draft then send, one unclassified',
      steps: [
        { id: 's1', agent: 'comms.email', intent: 'recall', toolName: 'memory.recall', input: {}, expectedActionClass: null },
        // `mail.send` HAS a class; declaring none here is an omission.
        { id: 's2', agent: 'comms.email', intent: 'send', toolName: 'mail.send', input: {}, expectedActionClass: null },
      ],
    });

    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('draft_only');
  });

  it('falls to the floor for a plan that is entirely read-only', async () => {
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    const plan = Plan.parse({
      goal: 'only look things up',
      steps: [
        { id: 's1', agent: 'comms.email', intent: 'recall', toolName: 'memory.recall', input: {}, expectedActionClass: null },
      ],
    });

    // No step carries a ceiling, so there is nothing to combine. The floor is
    // the safe answer and costs nothing: every step here short-circuits at the
    // gate before the autonomy stage reads this value at all.
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('draft_only');
  });

  /**
   * `agent.request_help` is classified (`agent.delegate`) but exempt from
   * the plan ceiling — unlike the read-only tools above, it does NOT
   * short-circuit at the gate. A delegation step sits beside an ordinary
   * classified step here, and its exemption must not drag the plan-wide
   * minimum down to whatever `agent.delegate`'s own (unset, and therefore
   * `approve_required` — the floor of mode `learn`, which this test sets) ramp
   * row would be. `email.reply`'s `auto_notify` is the only class that
   * contributes, exactly as `CEILING_EXEMPT_TOOLS`'s docblock promises.
   */
  it('lets a delegation step contribute no ceiling, so it cannot floor a plan that also acts', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    const plan = Plan.parse({
      goal: 'ask for help, then send',
      steps: [
        { id: 's1', agent: 'comms.email', intent: 'ask_for_help', toolName: 'agent.request_help', input: {}, expectedActionClass: 'agent.delegate' },
        { id: 's2', agent: 'comms.email', intent: 'send', toolName: 'mail.send', input: {}, expectedActionClass: 'email.reply' },
      ],
    });

    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('auto_notify');
  });

  /**
   * The case Important 1 of the Task 3 review was about, and the one that
   * proves the fix: a plan whose ONLY step is a delegation. Before the fix,
   * `levels` ended up empty and the function returned `RAMP_FLOOR`
   * (`draft_only`) unconditionally — which becomes `ctx.rampLevel` for this
   * very step, since a delegation is classified and does not short-circuit.
   * That denied the exact shape Task 6 builds for every child job.
   *
   * No ramp row is set for anything here on purpose: the answer must be
   * `'auto'` regardless of what `agent.delegate`'s own (absent) ramp row
   * would say, because the exemption means this function has nothing to say
   * about the step at all — the charter base and provenance ceiling still
   * bind independently in `effectiveAutonomy`, which this test does not
   * reach and does not need to.
   */
  it('answers auto for a plan that is entirely a delegation, never the floor', async () => {
    const plan = Plan.parse({
      goal: 'just ask for help',
      steps: [
        { id: 's1', agent: 'comms.email', intent: 'ask_for_help', toolName: 'agent.request_help', input: {}, expectedActionClass: 'agent.delegate' },
      ],
    });

    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('auto');
  });
});
