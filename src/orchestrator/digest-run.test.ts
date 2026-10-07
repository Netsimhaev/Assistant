import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { setDigestSettings } from '../governance/digest-settings.js';
import { recentDigests } from './digest-store.js';
import { runDigests } from './digest-run.js';

const BUSINESS = 'test-business';

describe('runDigests', () => {
  let charterVersion: string;

  beforeEach(async () => {
    await resetDatabase();
    // A signed charter must exist: the time zone comes from it (spec §4).
    // `jobs.charter_version` also carries a composite FK to
    // `charter_versions (business_id, charter_version)` since migration 002,
    // which the "seed a closed job" helper below relies on.
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    charterVersion = bundle.charterVersion;
  });

  /**
   * Inserted directly, the same way `digest-facts.test.ts` (Task 4) seeds a
   * closed job — `createJob`/`transition` stamp `closed_at` from the real
   * wall clock via SQL `now()`, which has no relationship to the fixed `now`
   * every test below hands `runDigests`, and the digest's window is computed
   * from THAT `now`, not the real one. `closedAt` must land inside whichever
   * window the test's own `now` produces.
   */
  async function seedClosedJob(closedAt: Date): Promise<void> {
    await getPool().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, charter_version, provenance, content_ingested, closed_at)
       VALUES ($1, $2, 'משימה שהושלמה', 'closed', $3, 'boss', false, $4)`,
      [`J-${Math.random().toString(36).slice(2)}`, BUSINESS, charterVersion, closedAt],
    );
  }

  /** Spec §4: off means nothing is produced at all. */
  it('does nothing while the schedule is off', async () => {
    const result = await runDigests({ businessId: BUSINESS, now: new Date('2026-10-07T09:00:00+03:00') });
    expect(result.sent).toEqual([]);
    expect(await recentDigests({ businessId: BUSINESS })).toEqual([]);
  });

  /**
   * Spec §2 decision 3: an empty window reaches the SCREEN but not the inbox.
   * A daily email that is usually empty teaches him to ignore the one that is
   * not — and then he misses the day that mattered.
   */
  it('stores an empty window for the screen without sending email', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: true, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const calls: string[] = [];
    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-07T09:00:00+03:00'),
      sendAlert: async (subject) => { calls.push(subject); return { ok: true }; },
    });

    expect(result.screenOnly).toBe(1);
    expect(calls).toEqual([]);
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hadContent).toBe(false);
    expect(stored[0]?.emailState).toBeNull();
  });

  /**
   * Spec §6: a channel the owner enabled but which cannot be reached is SAID,
   * not silenced. "Not sent" and "nothing to send" must not look alike.
   */
  it('records that WhatsApp was wanted and not connected, rather than skipping quietly', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: true },
      'owner', { businessId: BUSINESS },
    );
    // Seed one closed job so the window has content. The daily window for
    // `now` below is [2026-10-06T05:00:00.000Z, 2026-10-07T05:00:00.000Z) —
    // see `digest-window.test.ts` for the same arithmetic spelled out.
    await seedClosedJob(new Date('2026-10-07T07:00:00+03:00'));

    await runDigests({ businessId: BUSINESS, now: new Date('2026-10-07T09:00:00+03:00') });
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored[0]?.whatsappState).toBe('skipped_not_connected');
  });

  /** Spec §6: a send failure is recorded on the row and never thrown. */
  it('records a failed email without failing the digest', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: true, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    // Seed content — same window as above.
    await seedClosedJob(new Date('2026-10-07T07:00:00+03:00'));

    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-07T09:00:00+03:00'),
      sendAlert: async () => ({ ok: false, error: 'smtp down' }),
    });

    expect(result.errored).toBeNull();
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored[0]?.emailState).toBe('failed');
  });

  /**
   * Mutation check (Task 6, step 7 #1): storage must precede delivery.
   * `sendAlert` THROWS here, rather than merely returning `{ ok: false }` —
   * if delivery ran first, nothing would ever reach `storeDigest` and the
   * row would never exist at all.
   */
  it('stores the digest even when the email send throws outright', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: true, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    await seedClosedJob(new Date('2026-10-07T07:00:00+03:00'));

    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-07T09:00:00+03:00'),
      sendAlert: async () => { throw new Error('boom'); },
    });

    expect(result.errored).toBeNull();
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.emailState).toBe('failed');
  });

  /** Spec §5: the same window is not sent twice. */
  it('does not resend a window it already sent', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const now = new Date('2026-10-07T09:00:00+03:00');
    await runDigests({ businessId: BUSINESS, now });
    await runDigests({ businessId: BUSINESS, now });
    expect(await recentDigests({ businessId: BUSINESS })).toHaveLength(1);
  });

  /** Spec §5: both kinds fire independently, and the overlap is deliberate. */
  it('sends a daily and a weekly for the same moment when both are on', async () => {
    await setDigestSettings(
      { schedule: 'both', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-11T09:00:00+03:00'), // Sunday
    });
    expect(result.sent.map((s) => s.kind).sort()).toEqual(['daily', 'weekly']);
  });
});
