/**
 * The dial's clamp on `loadRampLevel`, proved both as a table comparison and
 * — for the one case that matters most — through a real gate decision.
 *
 * Uses the seeding pattern from `ramp-raise.test.ts` (`resetDatabase`,
 * `installCharter` + `buildCharter`, `closePool`) rather than duplicating it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { loadRampLevel, setRampLevel } from './ramp.js';
import { evaluateToolCall } from '../policy/engine.js';

const BUSINESS = 'test-business';

// Outside the fixture charter's quiet-hours window (20:00-07:00 Asia/Jerusalem)
// so the gate's step 7 never denies before reaching the code under test —
// same fixed clock `ramp-raise.test.ts` and `standing-approval.test.ts` use.
const NOON = new Date('2026-08-18T09:00:00.000Z');

describe('the dial raises the ramp floor, and the charter still wins', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  /**
   * The test an earlier draft of this plan did not have, and the defect it
   * would have shipped: a class already promoted must come back DOWN when the
   * owner turns the dial off. A switch labelled "off" that leaves her acting
   * is the worst thing this feature could do.
   */
  it('pulls a promoted class back to draft_only when the dial is off', async () => {
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('pins everything at approve_required on ask — she asks every time', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('lifts a class with no row to approve_required once the dial is on', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    expect(await loadRampLevel('calendar.create', { businessId: BUSINESS })).toBe('approve_required');
  });

  /**
   * Closes a gap mutation testing found in this file's own coverage: the
   * "no row" test above returns the floor via the `stored === undefined`
   * branch and never reaches the `!permits(parsed.data, floor)` line at all,
   * so deleting that line left every test in this file green. A row that
   * exists but sits BELOW the current floor — a value written before the
   * dial was turned to `learn`, or while it briefly sat on `off` — is the
   * only input that exercises the raise itself.
   */
  it('raises a stored level below the floor up to the floor', async () => {
    await setRampLevel('email.reply', 'draft_only', { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('keeps an earned level while the dial is on learn', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('auto_notify');
  });

  /**
   * Spec §12.1 — the one test without which the whole design is unsafe.
   * Asserted through a real gate decision, never by comparing tables: the
   * charter pins `email.initiate` at `approve_required`, so a ramp shouting
   * `auto` (clamped by `learn`'s ceiling to `auto_notify`, still well above
   * `approve_required`) must still produce a card.
   */
  it('still raises a card when the charter caps the class, however high the ramp', async () => {
    const bundle = await installCharter(buildCharter({ version: 'c1' }), { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    // Three POSITIONAL arguments — `(toolName, toolInput, ctx)` — not one
    // object. Matches `src/policy/standing-approval.test.ts`, which is the
    // shape the gate really has.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'stranger@nowhere.example', subject: 'x', body: 'y' },
      {
        agent: 'comms.email',
        bundle,
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        businessId: BUSINESS,
        jobId: null,
        rampLevel: await loadRampLevel('email.initiate', { businessId: BUSINESS }),
        now: NOON,
      },
    );

    expect(decision.outcome).toBe('queue_approval');
  });
});
