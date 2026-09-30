import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { activeScopes, checkKillSwitch } from '../governance/killswitch.js';
import { runKillCli } from './kill.js';

const BUSINESS = 'test-business';

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

async function auditReasons(): Promise<string[]> {
  const { rows } = await getPool().query<{ reason: string }>(
    "SELECT reason FROM audit_log WHERE kind = 'kill_switch' ORDER BY at ASC",
  );
  return rows.map((r) => r.reason);
}

describe('runKillCli', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The point of the whole command: the stop becomes real, and it becomes
   * PROVABLE from the audit trail. Stage 0's exit condition asks for the
   * second thing specifically, and before this command existed nothing
   * outside a test file could produce either.
   */
  it('stops a scope, enforces it at the gate stage, and leaves an audit row naming who and why', async () => {
    const { log, lines } = collector();
    await runKillCli(['stop', 'outbound', 'operator', 'drill'], { log, businessId: BUSINESS });

    expect((await activeScopes(BUSINESS)).map((s) => s.scope)).toEqual(['outbound']);
    const check = await checkKillSwitch('comms.email', true, { businessId: BUSINESS });
    expect(check.blocked).toBe(true);
    expect(check.scope).toBe('outbound');

    const reasons = await auditReasons();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('TRIPPED');
    expect(reasons[0]).toContain('outbound');
    expect(reasons[0]).toContain('operator');
    expect(reasons[0]).toContain('drill');

    expect(lines.join('\n')).toContain('resume outbound');
  });

  /**
   * `outbound` is the useful middle setting, and the command's explanation
   * says so. If reading stopped too, the text would be a lie and the scope
   * would have no reason to exist beside `all`.
   */
  it('leaves non-outbound work running under an outbound stop, and stops it under all', async () => {
    const { log } = collector();

    await runKillCli(['stop', 'outbound', 'operator', 'drill'], { log, businessId: BUSINESS });
    expect((await checkKillSwitch('know.reader', false, { businessId: BUSINESS })).blocked).toBe(false);
    await runKillCli(['resume', 'outbound', 'operator', 'done'], { log, businessId: BUSINESS });

    await runKillCli(['stop', 'all', 'operator', 'drill'], { log, businessId: BUSINESS });
    expect((await checkKillSwitch('know.reader', false, { businessId: BUSINESS })).blocked).toBe(true);
  });

  /**
   * A department stop must reach its own agents and no others, and the
   * explanation is derived from `AGENT_DEPARTMENT` rather than a hand-written
   * list — so it names the real membership.
   */
  it('stops one department only, and names its agents', async () => {
    const { log, lines } = collector();
    await runKillCli(['stop', 'governance', 'operator', 'drill'], { log, businessId: BUSINESS });

    expect((await checkKillSwitch('gov.verify', false, { businessId: BUSINESS })).blocked).toBe(true);
    expect((await checkKillSwitch('comms.email', true, { businessId: BUSINESS })).blocked).toBe(false);

    const text = lines.join('\n');
    expect(text).toContain('gov.verify');
    expect(text).toContain('gov.charter');
    expect(text).toContain('gov.risk');
    expect(text).not.toContain('comms.email');
  });

  it('releases a scope and records the release, leaving other scopes stopped', async () => {
    const { log, lines } = collector();
    await runKillCli(['stop', 'outbound', 'operator', 'drill'], { log, businessId: BUSINESS });
    await runKillCli(['stop', 'knowledge', 'operator', 'drill'], { log, businessId: BUSINESS });

    lines.length = 0;
    await runKillCli(['resume', 'outbound', 'operator', 'done'], { log, businessId: BUSINESS });

    expect((await activeScopes(BUSINESS)).map((s) => s.scope)).toEqual(['knowledge']);
    // The one thing an operator must not conclude from "released": that
    // everything is open again.
    expect(lines.join('\n')).toContain('knowledge');

    const reasons = await auditReasons();
    expect(reasons.some((r) => r.includes('RELEASED') && r.includes('outbound'))).toBe(true);
  });

  it('reports the live state, and says so when nothing is stopped', async () => {
    const { log, lines } = collector();
    await runKillCli(['status'], { log, businessId: BUSINESS });
    expect(lines.join('\n')).toContain('אין שום עצירה פעילה');

    lines.length = 0;
    await runKillCli(['stop', 'production', 'operator', 'drill'], { log, businessId: BUSINESS });
    lines.length = 0;
    await runKillCli(['status'], { log, businessId: BUSINESS });
    const text = lines.join('\n');
    expect(text).toContain('production');
    expect(text).toContain('operator');
    expect(text).toContain('drill');
  });

  /**
   * Every refusal below writes nothing. A stop recorded without a reason, or
   * against a scope nobody defined, is worse than no stop: the audit row is
   * the only place a human's reason survives.
   */
  it('refuses an unknown scope, an unknown action, a missing reason and a stray argument, writing nothing', async () => {
    const { log } = collector();
    const deps = { log, businessId: BUSINESS };

    await expect(runKillCli(['stop', 'sales', 'operator', 'drill'], deps)).rejects.toThrow('sales');
    await expect(runKillCli(['halt', 'all', 'operator', 'drill'], deps)).rejects.toThrow('halt');
    await expect(runKillCli(['stop', 'all', 'operator'], deps)).rejects.toThrow('שימוש');
    await expect(runKillCli(['stop', 'all', 'operator', 'a', 'b'], deps)).rejects.toThrow('עודף');
    await expect(runKillCli(['stop', 'all', '   ', 'drill'], deps)).rejects.toThrow('המפעיל');
    await expect(runKillCli(['stop', 'all', 'operator', '  '], deps)).rejects.toThrow('נימוק');
    await expect(runKillCli(['status', 'all'], deps)).rejects.toThrow('status');
    await expect(runKillCli([], deps)).rejects.toThrow('שימוש');

    expect(await activeScopes(BUSINESS)).toEqual([]);
    expect(await auditReasons()).toEqual([]);
  });

  /**
   * `release` on a scope that is not stopped must not invent a release row.
   * `release()` itself refuses (its own `rowCount` check); this asserts the
   * command surfaces that rather than reporting a success it did not achieve.
   */
  it('refuses to release a scope that is not stopped', async () => {
    const { log } = collector();
    await expect(
      runKillCli(['resume', 'all', 'operator', 'nothing to release'], { log, businessId: BUSINESS }),
    ).rejects.toThrow();
    expect(await auditReasons()).toEqual([]);
  });

  /**
   * The business id is the one thing this command must never widen. A stop
   * pulled for one business that quietly stopped another would be the worst
   * possible failure of a control an operator reaches for under pressure.
   */
  it('confines a stop to its own business', async () => {
    const { log } = collector();
    await runKillCli(['stop', 'all', 'operator', 'drill'], { log, businessId: BUSINESS });

    expect((await checkKillSwitch('comms.email', true, { businessId: BUSINESS })).blocked).toBe(true);
    expect((await checkKillSwitch('comms.email', true, { businessId: 'other-business' })).blocked).toBe(false);
    expect(await activeScopes('other-business')).toEqual([]);
  });
});
