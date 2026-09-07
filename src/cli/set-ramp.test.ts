import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { runSetRampCli } from './set-ramp.js';

const BUSINESS = 'test-business';

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

describe('runSetRampCli', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  afterAll(async () => {
    await closePool();
  });

  it('raises one action class and leaves every other at the floor', async () => {
    const { log } = collector();

    await runSetRampCli(['email.reply', 'approve_required'], { log, businessId: BUSINESS });

    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
    // The floor is what an unset class falls to, so this proves the write was
    // scoped to the one class named rather than applied broadly.
    expect(await loadRampLevel('email.initiate', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('refuses an unknown action class, names the valid ones, and writes nothing', async () => {
    const { log } = collector();

    await expect(
      runSetRampCli(['email.nope', 'approve_required'], { log, businessId: BUSINESS }),
    ).rejects.toThrow(/email\.reply/);

    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('refuses an unknown level and writes nothing', async () => {
    const { log } = collector();

    await expect(
      runSetRampCli(['email.reply', 'whenever_you_like'], { log, businessId: BUSINESS }),
    ).rejects.toThrow(/approve_required/);

    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('reports where the new level is actually felt, and where a ceiling still overrides it', async () => {
    // The reason this command exists in this shape. Raising the ramp is the
    // minimum of several ceilings, and a raise that changes nothing looks
    // identical to a broken system unless the command says so. The charter
    // fixture caps content from an unknown external source at `draft_only`,
    // so the raise cannot be felt there however high the ramp goes.
    const { log, lines } = collector();

    await runSetRampCli(['email.reply', 'approve_required'], { log, businessId: BUSINESS });
    const output = lines.join('\n');

    expect(output).toContain('boss');
    expect(output).toContain('approve_required');
    expect(output).toContain('unknown_external');
    expect(output).toContain('draft_only');
  });

  it('refuses when no charter is installed rather than reporting a ceiling it cannot read', async () => {
    await resetDatabase();
    const { log } = collector();

    await expect(
      runSetRampCli(['email.reply', 'approve_required'], { log, businessId: BUSINESS }),
    ).rejects.toThrow();

    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('draft_only');
  });
});
