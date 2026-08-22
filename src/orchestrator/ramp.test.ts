import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { Plan } from '../domain/plan.js';
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
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'approve_required', { businessId: BUSINESS });
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('takes the most restrictive level across every class a plan declares', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    await setRampLevel('crm.write', 'approve_required', { businessId: BUSINESS });
    const plan = planWith(['email.initiate', 'crm.write']);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('approve_required');
  });

  it('treats a step that declares no class as draft_only', async () => {
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
    const plan = planWith(['email.initiate', null]);
    expect(await rampLevelForPlan(plan, { businessId: BUSINESS })).toBe('draft_only');
  });
});
