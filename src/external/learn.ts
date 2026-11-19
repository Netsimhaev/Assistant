/**
 * Learning from external-system events (Stage D, Task 12) — the webhook's
 * and the daily scan's events, curated into memory.
 *
 * What it may do, and nothing else:
 *  - **Only systems in the ACTIVE charter.** An event of a system that is no
 *    longer signed stays in its table, unlearned.
 *  - **A learning job per group of up to `EVENTS_PER_JOB` events of one
 *    system**, opened with `provenance: 'unknown_external'` as a literal in
 *    the `createJob` call — never a parameter, never derived from an event.
 *    Everything read from outside is a stranger's text (spec, decision 2).
 *  - **No plan, ever.** The job is `intake → understand → closed`; it is
 *    never bound to a plan, so no `ext.*` step — or any step — can come of
 *    an event. A webhook or a scan only teaches.
 *  - **Chunk-only, never retiring** (`curateJob` scope `external`), under its
 *    own daily cap (`externalCurationPerDay`, `EXTERNAL_CURATION_PER_DAY`,
 *    overridable per business, 0 = off), counted off `audit_log` apart from
 *    document and mail curation.
 *
 * Events are claimed for the job before the curator runs (`curation_job_id`)
 * and marked curated only once the curator was CALLED — a billed call that
 * failed is still a call, so its batch is not retried into a second bill.
 * A skip before the call (cap, no key) gives the claim back for tomorrow.
 */
import type { BusinessDb } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { curateJob, curationRunsToday } from '../memory/curate.js';
import { createJob, PhaseMovedError, transition } from '../orchestrator/jobs.js';
import type { Curator } from '../sdk/curator.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import {
  claimEventsForCuration,
  markEventsCurated,
  releaseCurationClaim,
  uncuratedEvents,
} from './store.js';

/** Events learned from in one curator call. */
export const EVENTS_PER_JOB = 20;

/** Fixed: a title built from event content would carry a stranger's text into `jobs`. */
export const LEARNING_JOB_TITLE = 'למידה ממערכת חיצונית';

/** A claim older than this, on a job still in `understand`, belongs to a crashed pass. */
const STALE_CLAIM_MINUTES = 30;

export interface LearnOptions {
  /** Injected by tests; production leaves it unset and gets the billed call (`refuseUnderTest` guards it). */
  curator?: Curator;
  /** Defaults to the business's `externalCurationPerDay`. Injected by tests. */
  runsPerDay?: number;
}

export interface LearnResult {
  /** Learning jobs opened this pass. */
  jobs: number;
  /** Events marked curated this pass. */
  curated: number;
  warnings: string[];
}

/** Fails orphan learning jobs and gives their events back. */
async function releaseStaleClaims(db: BusinessDb): Promise<void> {
  const { rows } = await db.query<{ job_id: string; phase: string | null }>(
    `SELECT DISTINCT e.curation_job_id AS job_id, j.phase
       FROM external_events e
       LEFT JOIN jobs j ON j.business_id = e.business_id AND j.job_id = e.curation_job_id
      WHERE e.business_id = $1 AND e.curated_at IS NULL AND e.curation_job_id IS NOT NULL
        AND (j.job_id IS NULL OR j.phase <> 'understand'
             OR j.created_at < now() - make_interval(mins => $2))`,
    [db.businessId, STALE_CLAIM_MINUTES],
  );
  for (const row of rows) {
    if (row.phase === 'understand') {
      try {
        await transition(db, row.job_id, {
          to: 'failed',
          actor: 'orchestrator',
          reason: 'external learning: interrupted pass',
          expectFrom: 'understand',
        });
      } catch (error) {
        if (!(error instanceof PhaseMovedError)) throw error;
      }
    }
    await releaseCurationClaim(db, row.job_id);
  }
}

export async function learnFromExternalEvents(db: BusinessDb, options: LearnOptions = {}): Promise<LearnResult> {
  const result: LearnResult = { jobs: 0, curated: 0, warnings: [] };

  let active;
  try {
    active = await loadActiveCharter(db);
  } catch (error) {
    result.warnings.push(
      `charter unreadable — no external learning this pass: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }
  if (active === null || active.bundle.externalSystems.length === 0) return result;

  const runsPerDay = options.runsPerDay ?? capFor(await loadRuntimeSettings(db), 'externalCurationPerDay');
  if (runsPerDay <= 0) return result;
  // The same switch `curateJob` reads: without a key no job is opened at all,
  // rather than one per system per pass that closes on `no_key`.
  if (options.curator === undefined && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') return result;

  await releaseStaleClaims(db);

  for (const system of active.bundle.externalSystems) {
    try {
      if ((await curationRunsToday(db, { scope: 'external' })) >= runsPerDay) break;
      const events = await uncuratedEvents(db, system.id, EVENTS_PER_JOB);
      if (events.length === 0) continue;

      const job = await createJob(db, {
        charterVersion: active.charter.charterVersion,
        // Not a parameter, and not derived from anything an event says.
        provenance: 'unknown_external',
        title: LEARNING_JOB_TITLE,
      });
      result.jobs += 1;
      await transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 'external learning' });

      const claimed = await claimEventsForCuration(db, events.map((e) => e.eventId), job.jobId);
      if (claimed.length === 0) {
        await transition(db, job.jobId, { to: 'closed', actor: 'orchestrator', reason: 'external learning: nothing to claim' });
        continue;
      }

      const outcome = await curateJob(db, job.jobId, {
        scope: 'external',
        runsPerDay,
        ...(options.curator !== undefined ? { curator: options.curator } : {}),
      });
      if (outcome.skipped === null) {
        // The curator was called (and billed), whether or not it answered.
        await markEventsCurated(db, claimed);
        result.curated += claimed.length;
      } else {
        await releaseCurationClaim(db, job.jobId);
      }
      await transition(db, job.jobId, {
        to: outcome.failed ? 'failed' : 'closed',
        actor: 'orchestrator',
        reason: outcome.failed ? 'external learning: curation failed' : `external learning: ${outcome.skipped ?? 'curated'}`,
      });
    } catch (error) {
      result.warnings.push(
        `external learning for ext:${system.id} failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
    }
  }
  return result;
}
