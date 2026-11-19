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
 * A skip before the call (cap, no key) or a throw before it (the brief) gives
 * the claim back for the next pass (`CurationOutcome.modelCalled`).
 *
 * **Learning does not check the kill switch, by decision** — the same as mail
 * curation, which never did. It reaches no one and no system: it reads
 * events already stored and writes only tagged `chunk` rows. The scan, which
 * does send a request, checks it (`scan.ts`).
 */
import { transaction, type BusinessDb } from '../db/pool.js';
import { loadActiveCharter } from '../charter/store.js';
import { curateJob, curationRunsToday } from '../memory/curate.js';
import { createJob, PhaseMovedError, transition } from '../orchestrator/jobs.js';
import type { Curator } from '../sdk/curator.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import {
  claimEventsForCuration,
  LEARNING_JOB_STALE_MINUTES,
  markEventsCurated,
  markLearningJobFailed,
  recordLearningJob,
  releaseCurationClaim,
  uncuratedEvents,
} from './store.js';

/** Events learned from in one curator call. */
export const EVENTS_PER_JOB = 20;

/** Fixed: a title built from event content would carry a stranger's text into `jobs`. */
export const LEARNING_JOB_TITLE = 'למידה ממערכת חיצונית';


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

/**
 * Fails orphan learning jobs and gives their events back. Two ways in:
 *
 *  1. through claimed events — a claim whose job is gone, no longer in
 *     `understand`, or in `understand` past `LEARNING_JOB_STALE_MINUTES`;
 *  2. through `external_learning_jobs` itself — any learning job still in
 *     `intake`/`understand` past the same limit, claims or not. A crash
 *     before `claimEventsForCuration`, or after a release, leaves such a job
 *     holding nothing, and the first way never sees it.
 *
 * Run at the very start of every pass, before any early return (charter,
 * key, cap), so an orphan is failed even while learning is switched off.
 */
async function releaseStaleClaims(db: BusinessDb): Promise<void> {
  const { rows: open } = await db.query<{ job_id: string; phase: 'intake' | 'understand' }>(
    `SELECT j.job_id, j.phase
       FROM external_learning_jobs l
       JOIN jobs j ON j.business_id = l.business_id AND j.job_id = l.job_id
      WHERE l.business_id = $1 AND j.phase IN ('intake', 'understand')
        AND j.created_at < now() - make_interval(mins => $2)`,
    [db.businessId, LEARNING_JOB_STALE_MINUTES],
  );
  for (const row of open) {
    let failedHere = false;
    try {
      await transition(db, row.job_id, {
        to: 'failed',
        actor: 'orchestrator',
        reason: 'external learning: interrupted pass',
        expectFrom: row.phase,
      });
      failedHere = true;
    } catch (error) {
      if (!(error instanceof PhaseMovedError)) throw error;
    }
    if (failedHere) await markLearningJobFailed(db, row.job_id);
    await releaseCurationClaim(db, row.job_id);
  }

  const { rows } = await db.query<{ job_id: string; phase: string | null }>(
    `SELECT DISTINCT e.curation_job_id AS job_id, j.phase
       FROM external_events e
       LEFT JOIN jobs j ON j.business_id = e.business_id AND j.job_id = e.curation_job_id
      WHERE e.business_id = $1 AND e.curated_at IS NULL AND e.curation_job_id IS NOT NULL
        AND (j.job_id IS NULL OR j.phase <> 'understand'
             OR j.created_at < now() - make_interval(mins => $2))`,
    [db.businessId, LEARNING_JOB_STALE_MINUTES],
  );
  for (const row of rows) {
    if (row.phase === 'understand') {
      let failedHere = false;
      try {
        await transition(db, row.job_id, {
          to: 'failed',
          actor: 'orchestrator',
          reason: 'external learning: interrupted pass',
          expectFrom: 'understand',
        });
        failedHere = true;
      } catch (error) {
        if (!(error instanceof PhaseMovedError)) throw error;
        // Another pass already moved it; its outcome is that pass's to record,
        // so no failure is written here (it would show falsely on /systems).
      }
      if (failedHere) await markLearningJobFailed(db, row.job_id);
    }
    await releaseCurationClaim(db, row.job_id);
  }
}

/**
 * Moves a learning job that is still open (`intake` or `understand`) to
 * `failed`, at best effort. A job another pass already moved is left alone
 * (`PhaseMovedError`); any other error is noted by class name only.
 */
async function failOpenJob(db: BusinessDb, jobId: string, result: LearnResult): Promise<void> {
  for (const from of ['understand', 'intake'] as const) {
    try {
      await transition(db, jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: 'external learning: failed',
        expectFrom: from,
      });
      return;
    } catch (error) {
      if (error instanceof PhaseMovedError) continue;
      result.warnings.push(
        `external learning: could not fail job ${jobId}: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
      return;
    }
  }
}

export async function learnFromExternalEvents(db: BusinessDb, options: LearnOptions = {}): Promise<LearnResult> {
  const result: LearnResult = { jobs: 0, curated: 0, warnings: [] };

  // First, before any early return: an orphan learning job is failed even
  // when this pass learns nothing (no charter, no key, cap 0).
  try {
    await releaseStaleClaims(db);
  } catch (error) {
    result.warnings.push(
      `external learning: stale sweep failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
    );
  }

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

  for (const system of active.bundle.externalSystems) {
    let jobId: string | null = null;
    try {
      if ((await curationRunsToday(db, { scope: 'external' })) >= runsPerDay) break;
      const events = await uncuratedEvents(db, system.id, EVENTS_PER_JOB);
      if (events.length === 0) continue;

      // The job and its learning-job record land together: the record is how
      // the digest and `/systems` recognise this job (migration 079).
      const charterVersion = active.charter.charterVersion;
      const job = await transaction(db, async (tx) => {
        const created = await createJob(tx, {
          charterVersion,
          // Not a parameter, and not derived from anything an event says.
          provenance: 'unknown_external',
          title: LEARNING_JOB_TITLE,
        });
        await recordLearningJob(tx, created.jobId, system.id);
        return created;
      });
      jobId = job.jobId;
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
      if (outcome.modelCalled) {
        // The curator was called (and billed), whether or not it answered.
        await markEventsCurated(db, claimed);
        result.curated += claimed.length;
      } else {
        // A skip (cap, key) or a throw before the model call (the brief, the
        // cap query): nothing was paid for, so the events go back for the next pass.
        await releaseCurationClaim(db, job.jobId);
      }
      if (outcome.failed) await markLearningJobFailed(db, job.jobId);
      await transition(db, job.jobId, {
        to: outcome.failed ? 'failed' : 'closed',
        actor: 'orchestrator',
        reason: outcome.failed ? 'external learning: curation failed' : `external learning: ${outcome.skipped ?? 'curated'}`,
      });
    } catch (error) {
      result.warnings.push(
        `external learning for ext:${system.id} failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
      // Best effort: a job opened before the throw is failed, marked failed,
      // and its still-uncurated events go back. The job must be moved HERE:
      // once its claims are released the stale-claim sweep can no longer find
      // it, and it would sit in `understand` for good.
      if (jobId !== null) {
        const id = jobId;
        await failOpenJob(db, id, result);
        await markLearningJobFailed(db, id).catch(() => undefined);
        await releaseCurationClaim(db, id).catch(() => undefined);
      }
    }
  }
  return result;
}
