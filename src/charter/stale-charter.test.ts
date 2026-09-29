/**
 * What happens to an installation whose signed charter has fallen behind the
 * code — and the one door that must stay open when it has.
 *
 * This is not hypothetical. `agent.delegate` joined `ActionClass` without a
 * bump to `CURRENT_SCHEMA_VERSION`, and because `autonomy.base` is a
 * `z.record(ActionClass, …)` — exhaustive — every charter signed before that
 * moment stopped parsing. The installation it was found on failed every job
 * on every scheduler pass, and could not install a replacement charter
 * either: the install path reads the active charter first, so the repair was
 * blocked by the thing it was repairing.
 *
 * Two behaviours are pinned here, and they pull in opposite directions on
 * purpose:
 *
 * 1. `loadActiveCharter` **throws**, with a remedy naming which way to move.
 *    Every production caller uses it, and must keep failing loudly — work
 *    that runs against a policy nobody can parse is work running against no
 *    policy at all.
 * 2. `probeActiveCharter` **returns the failure**, for the install path and
 *    the readiness report alone. Without it there is no way back.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter, loadActiveCharter, probeActiveCharter } from './store.js';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';

const BUSINESS = 'test-business';

/**
 * Age the stored charter by one schema version, writing straight to the
 * column.
 *
 * Deliberately not done by signing a charter that declares an old version —
 * `BusinessCharter.parse` would refuse it on the way in, which is the
 * control working. The state under test is one no current code path can
 * create and every long-lived installation reaches anyway: a document signed
 * correctly months ago, under a schema this code has since moved past.
 */
async function ageStoredCharter(businessId: string, to: string): Promise<void> {
  await getPool().query(
    `UPDATE charter_versions
        SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb($2::text))
      WHERE business_id = $1`,
    [businessId, to],
  );
}

describe('a charter signed under an older schema', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  afterAll(async () => {
    await closePool();
  });

  it('stops every production reader, and says which way to move', async () => {
    await ageStoredCharter(BUSINESS, '1.1');

    await expect(loadActiveCharter(BUSINESS)).rejects.toThrow(/re-signed/);
    // The direction matters as much as the refusal: an operator told to
    // re-sign when the real problem is a rolled-back deployment is being sent
    // the wrong way. Pin that the message names the older-schema case.
    await expect(loadActiveCharter(BUSINESS)).rejects.toThrow(/older schema/);
  });

  it('points the other way for a charter NEWER than this code', async () => {
    await ageStoredCharter(BUSINESS, '9.9');

    await expect(loadActiveCharter(BUSINESS)).rejects.toThrow(/roll the code forward/);
    await expect(loadActiveCharter(BUSINESS)).rejects.toThrow(/do not re-sign/);
  });

  it('still lets the install path ask, and hands it the reason', async () => {
    await ageStoredCharter(BUSINESS, '1.1');

    const probe = await probeActiveCharter(BUSINESS);

    // The positive half first: the probe RESOLVED rather than rejecting. An
    // assertion only on `ok === false` would pass just as well if this call
    // had thrown and the test had never reached it.
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error('unreachable: the probe reported a readable charter');
    expect(probe.reason).toMatch(/re-signed/);
  });

  it('lets a replacement be installed over it', async () => {
    await ageStoredCharter(BUSINESS, '1.1');

    // The whole point: the door out is open. This is what `seed-charter.ts`
    // does after a failed probe.
    const bundle = await installCharter(
      buildCharter({ version: 'after-the-bump' }),
      { businessId: BUSINESS },
    );
    expect(bundle.charterVersion).toBe('after-the-bump');

    const recovered = await loadActiveCharter(BUSINESS);
    expect(recovered?.charter.charterVersion).toBe('after-the-bump');
  });
});

describe('a charter this code can read', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('probes as readable, carrying the charter itself', async () => {
    await installCharter(buildCharter({ version: 'current' }), { businessId: BUSINESS });

    const probe = await probeActiveCharter(BUSINESS);

    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error(`unreachable: ${probe.reason}`);
    expect(probe.active?.charter.charterVersion).toBe('current');
  });

  it('reports "nothing installed" as a success, not a failure', async () => {
    // An empty installation and an unreadable one are different answers, and
    // the installer treats them the same way while the readiness report must
    // not: "none — run seed-charter" and "stored but unreadable" send an
    // operator to different places.
    const probe = await probeActiveCharter(BUSINESS);

    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error(`unreachable: ${probe.reason}`);
    expect(probe.active).toBeNull();
  });
});
