/**
 * Stage D stores: staff drafts of external-system definitions, fields read for
 * a job, events (webhook or scan), the content-free call log and per-system
 * state. Every function takes a `BusinessDb`, so RLS scopes it to one business.
 */
import { monotonicFactory } from 'ulid';
import type { BusinessDb } from '../db/pool.js';
import { localParts, localToInstant } from '../util/local-time.js';

const ulid = monotonicFactory();

export interface ExternalFieldValue {
  label: string;
  value: string;
}

interface DraftRow {
  system_id: string;
  definition: unknown;
  updated_at: Date;
  updated_by_staff: string;
}
export interface DraftRecord {
  systemId: string;
  definition: unknown;
  updatedAt: Date;
  updatedByStaff: string;
}
function toDraft(r: DraftRow): DraftRecord {
  return { systemId: r.system_id, definition: r.definition, updatedAt: r.updated_at, updatedByStaff: r.updated_by_staff };
}

export async function saveDraft(
  db: BusinessDb,
  input: { systemId: string; definition: unknown; staffId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO external_system_drafts (business_id, system_id, definition, updated_by_staff)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (business_id, system_id)
     DO UPDATE SET definition = EXCLUDED.definition, updated_by_staff = EXCLUDED.updated_by_staff, updated_at = now()`,
    [db.businessId, input.systemId, JSON.stringify(input.definition), input.staffId],
  );
}

export async function loadDrafts(db: BusinessDb): Promise<DraftRecord[]> {
  const { rows } = await db.query<DraftRow>(
    `SELECT system_id, definition, updated_at, updated_by_staff
       FROM external_system_drafts WHERE business_id = $1 ORDER BY system_id`,
    [db.businessId],
  );
  return rows.map(toDraft);
}

/**
 * One draft, row-locked (`FOR UPDATE`) when `db` is in a transaction — the
 * owner's sign route reads it under the lock it later deletes it under, so a
 * draft the technician saves between the hash check and the delete is never
 * deleted unseen. `null` when there is none.
 */
export async function lockDraft(db: BusinessDb, systemId: string): Promise<DraftRecord | null> {
  const { rows } = await db.query<DraftRow>(
    `SELECT system_id, definition, updated_at, updated_by_staff
       FROM external_system_drafts WHERE business_id = $1 AND system_id = $2 FOR UPDATE`,
    [db.businessId, systemId],
  );
  const row = rows[0];
  return row === undefined ? null : toDraft(row);
}

/** Deletes the draft; returns how many rows went (0 when there was none). */
export async function deleteDraft(db: BusinessDb, systemId: string): Promise<number> {
  const result = await db.query(`DELETE FROM external_system_drafts WHERE business_id = $1 AND system_id = $2`, [
    db.businessId,
    systemId,
  ]);
  return result.rowCount ?? 0;
}

/**
 * The active charter's signed definition of one system, as stored, or `null`.
 * Read by the panel's editor as the starting text when there is no draft: a
 * definition is technician-authored configuration (ruling T9-b). A narrow
 * read, not `loadActiveCharter`, so an unparseable charter does not take the
 * editor down with it.
 */
export async function loadSignedDefinition(db: BusinessDb, systemId: string): Promise<unknown> {
  const { rows } = await db.query<{ definition: unknown }>(
    `SELECT e.def AS definition
       FROM charter_active ca
       JOIN charter_versions cv ON cv.business_id = ca.business_id AND cv.charter_version = ca.charter_version
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(cv.charter -> 'externalSystems') = 'array'
              THEN cv.charter -> 'externalSystems' ELSE '[]'::jsonb END) AS e(def)
      WHERE ca.business_id = $1 AND e.def ->> 'id' = $2`,
    [db.businessId, systemId],
  );
  return rows[0]?.definition ?? null;
}

export interface SignedSystemName {
  label: string;
  /** Webhook event types and operation names, each with its signed Hebrew label. */
  eventLabels: Map<string, string>;
}

/**
 * The signed label of every system in the active charter, and of its event
 * types and operations, by id. A narrow read like `loadSignedDefinition` —
 * an unparseable charter does not take a brief, a digest or a screen down
 * with it; a missing label is simply absent and the caller falls back to the id.
 */
export async function signedSystemNames(db: BusinessDb): Promise<Map<string, SignedSystemName>> {
  const { rows } = await db.query<{ def: unknown }>(
    `SELECT e.def
       FROM charter_active ca
       JOIN charter_versions cv ON cv.business_id = ca.business_id AND cv.charter_version = ca.charter_version
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(cv.charter -> 'externalSystems') = 'array'
              THEN cv.charter -> 'externalSystems' ELSE '[]'::jsonb END) AS e(def)
      WHERE ca.business_id = $1`,
    [db.businessId],
  );
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const out = new Map<string, SignedSystemName>();
  for (const { def } of rows) {
    if (def === null || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const id = text(d['id']);
    const label = text(d['label']);
    if (id === null || label === null) continue;
    const eventLabels = new Map<string, string>();
    for (const list of [d['operations'], (d['webhook'] as Record<string, unknown> | null | undefined)?.['events']]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        const key = text(it['name']) ?? text(it['type']);
        const name = text(it['label']);
        if (key !== null && name !== null) eventLabels.set(key, name);
      }
    }
    out.set(id, { label, eventLabels });
  }
  return out;
}

interface ReadRow {
  read_id: string;
  job_id: string;
  step_id: string;
  system_id: string;
  operation: string;
  fields: ExternalFieldValue[];
  created_at: Date;
}
export interface ExternalReadRecord {
  readId: string;
  jobId: string;
  stepId: string;
  systemId: string;
  operation: string;
  fields: ExternalFieldValue[];
  createdAt: Date;
}
function toRead(r: ReadRow): ExternalReadRecord {
  return {
    readId: r.read_id,
    jobId: r.job_id,
    stepId: r.step_id,
    systemId: r.system_id,
    operation: r.operation,
    fields: r.fields,
    createdAt: r.created_at,
  };
}

export async function recordExternalRead(
  db: BusinessDb,
  input: { jobId: string; stepId: string; systemId: string; operation: string; fields: ExternalFieldValue[] },
): Promise<void> {
  await db.query(
    `INSERT INTO external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [db.businessId, `XR-${ulid()}`, input.jobId, input.stepId, input.systemId, input.operation, JSON.stringify(input.fields)],
  );
}

export async function loadReadsForJob(db: BusinessDb, jobId: string): Promise<ExternalReadRecord[]> {
  const { rows } = await db.query<ReadRow>(
    `SELECT read_id, job_id, step_id, system_id, operation, fields, created_at
       FROM external_reads WHERE business_id = $1 AND job_id = $2 ORDER BY read_id`,
    [db.businessId, jobId],
  );
  return rows.map(toRead);
}

export interface OwnerReadRecord extends ExternalReadRecord {
  /** The phase of the job the read belongs to; only `closed` is "done". */
  jobPhase: string;
}

/**
 * Reads from the last day's jobs the owner's own instructions opened, newest
 * first — what the instruct screen shows as "what came back". `EXISTS` on
 * `boss_instructions` (not a join), so a job with several instruction rows
 * does not repeat its reads, and a read from any other kind of job never
 * appears.
 */
export async function loadRecentOwnerReads(db: BusinessDb, limit = 5): Promise<OwnerReadRecord[]> {
  const { rows } = await db.query<ReadRow & { phase: string }>(
    `SELECT r.read_id, r.job_id, r.step_id, r.system_id, r.operation, r.fields, r.created_at, j.phase
       FROM external_reads r
       JOIN jobs j ON j.business_id = r.business_id AND j.job_id = r.job_id
      WHERE r.business_id = $1 AND r.created_at > now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM boss_instructions i
                     WHERE i.business_id = r.business_id AND i.job_id = r.job_id)
      ORDER BY r.read_id DESC LIMIT $2`,
    [db.businessId, limit],
  );
  return rows.map((r) => ({ ...toRead(r), jobPhase: r.phase }));
}

interface EventRow {
  event_id: string;
  system_id: string;
  source: 'webhook' | 'scan';
  event_type: string;
  item_hash: string;
  fields: ExternalFieldValue[];
  created_at: Date;
  curated_at: Date | null;
}
export interface ExternalEventRecord {
  eventId: string;
  systemId: string;
  source: 'webhook' | 'scan';
  eventType: string;
  itemHash: string;
  fields: ExternalFieldValue[];
  createdAt: Date;
  curatedAt: Date | null;
}
function toEvent(r: EventRow): ExternalEventRecord {
  return {
    eventId: r.event_id,
    systemId: r.system_id,
    source: r.source,
    eventType: r.event_type,
    itemHash: r.item_hash,
    fields: r.fields,
    createdAt: r.created_at,
    curatedAt: r.curated_at,
  };
}

/**
 * Returns false when the same (system, item hash) was already stored — or was
 * stored once and then erased by the owner (`external_erased_items`, migration
 * 080). Without the tombstone, the provider's unchanged record would arrive on
 * the next scan or alert and learning would write the erased person back.
 * A record the provider changed hashes differently and is stored again.
 */
export async function insertEvent(
  db: BusinessDb,
  input: {
    systemId: string;
    source: 'webhook' | 'scan';
    eventType: string;
    itemHash: string;
    fields: ExternalFieldValue[];
  },
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO external_events (business_id, event_id, system_id, source, event_type, item_hash, fields)
     SELECT $1, $2, $3, $4, $5, $6, $7::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM external_erased_items t
         WHERE t.business_id = $1 AND t.system_id = $3 AND t.item_hash = $6
      )
     ON CONFLICT (business_id, system_id, item_hash) DO NOTHING
     RETURNING event_id`,
    [db.businessId, `XE-${ulid()}`, input.systemId, input.source, input.eventType, input.itemHash, JSON.stringify(input.fields)],
  );
  return rows.length > 0;
}

/**
 * Up to `limit` uncurated, unclaimed events of one system, oldest first.
 *
 * Selected by `curated_at IS NULL`, never by an id cursor. Two writers insert
 * events — the webhook receiver (dashboard process) and the daily scan
 * (scheduler) — and each takes its own monotonic ULID factory, so a ULID
 * cursor could skip an event a slower writer inserted with a lower id after
 * the cursor moved past it. The column is the truth; the order is only
 * fairness.
 */
export async function uncuratedEvents(
  db: BusinessDb,
  systemId: string,
  limit: number,
): Promise<ExternalEventRecord[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT event_id, system_id, source, event_type, item_hash, fields, created_at, curated_at
       FROM external_events
      WHERE business_id = $1 AND system_id = $2 AND curated_at IS NULL AND curation_job_id IS NULL
      ORDER BY created_at, event_id
      LIMIT $3`,
    [db.businessId, systemId, limit],
  );
  return rows.map(toEvent);
}

/**
 * Claims events for one learning job: only those still uncurated and
 * unclaimed. Returns the ids actually claimed — a concurrent pass that got
 * there first keeps its own.
 */
export async function claimEventsForCuration(db: BusinessDb, ids: string[], jobId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ event_id: string }>(
    `UPDATE external_events SET curation_job_id = $3
      WHERE business_id = $1 AND event_id = ANY($2::text[])
        AND curated_at IS NULL AND curation_job_id IS NULL
      RETURNING event_id`,
    [db.businessId, ids, jobId],
  );
  return rows.map((r) => r.event_id);
}

/** The events a learning job claimed, oldest first — what its curation brief is built from. */
export async function eventsForCurationJob(db: BusinessDb, jobId: string): Promise<ExternalEventRecord[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT event_id, system_id, source, event_type, item_hash, fields, created_at, curated_at
       FROM external_events
      WHERE business_id = $1 AND curation_job_id = $2
      ORDER BY created_at, event_id`,
    [db.businessId, jobId],
  );
  return rows.map(toEvent);
}

/** Gives a job's still-uncurated events back, so the next pass can claim them again. */
export async function releaseCurationClaim(db: BusinessDb, jobId: string): Promise<void> {
  await db.query(
    `UPDATE external_events SET curation_job_id = NULL
      WHERE business_id = $1 AND curation_job_id = $2 AND curated_at IS NULL`,
    [db.businessId, jobId],
  );
}

export async function markEventsCurated(db: BusinessDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE external_events SET curated_at = now()
      WHERE business_id = $1 AND event_id = ANY($2::text[]) AND curated_at IS NULL`,
    [db.businessId, ids],
  );
}

export async function recordCall(db: BusinessDb, input: { systemId: string; outcome: string }): Promise<void> {
  await db.query(`INSERT INTO external_calls (business_id, system_id, outcome) VALUES ($1, $2, $3)`, [
    db.businessId,
    input.systemId,
    input.outcome,
  ]);
}

/** Calls since local midnight in `timeZone` (an IANA zone), not UTC midnight. */
export async function countCallsToday(
  db: BusinessDb,
  systemId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<number> {
  const start = localToInstant(localParts(now, timeZone).date, '00:00', timeZone);
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM external_calls WHERE business_id = $1 AND system_id = $2 AND at >= $3`,
    [db.businessId, systemId, start],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Counts a refused webhook. `reason` is for the caller's log only; nothing but the count is stored. */
export async function recordRejectedHook(db: BusinessDb, systemId: string, _reason: string): Promise<void> {
  await db.query(
    `INSERT INTO external_system_state (business_id, system_id, rejected_hooks, last_rejected_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (business_id, system_id)
     DO UPDATE SET rejected_hooks = external_system_state.rejected_hooks + 1, last_rejected_at = now()`,
    [db.businessId, systemId],
  );
}

/**
 * One scan attempt: always its time and outcome code, and `last_scan_at` only
 * when it succeeded — a failed scan never moves the window it asks about.
 */
export async function recordScanAttempt(
  db: BusinessDb,
  systemId: string,
  input: { at: Date; outcome: string; succeeded: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO external_system_state (business_id, system_id, last_scan_attempt_at, last_scan_outcome, last_scan_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN $3::timestamptz ELSE NULL END)
     ON CONFLICT (business_id, system_id) DO UPDATE SET
       last_scan_attempt_at = EXCLUDED.last_scan_attempt_at,
       last_scan_outcome = EXCLUDED.last_scan_outcome,
       last_scan_at = CASE WHEN $5 THEN EXCLUDED.last_scan_attempt_at ELSE external_system_state.last_scan_at END`,
    [db.businessId, systemId, input.at, input.outcome, input.succeeded],
  );
}

interface StateRow {
  system_id: string;
  last_scan_at: Date | null;
  last_scan_attempt_at: Date | null;
  last_scan_outcome: string | null;
  rejected_hooks: number;
  last_rejected_at: Date | null;
}
export interface ExternalSystemState {
  systemId: string;
  lastScanAt: Date | null;
  lastScanAttemptAt: Date | null;
  lastScanOutcome: string | null;
  rejectedHooks: number;
  lastRejectedAt: Date | null;
}
function toState(r: StateRow): ExternalSystemState {
  return {
    systemId: r.system_id,
    lastScanAt: r.last_scan_at,
    lastScanAttemptAt: r.last_scan_attempt_at,
    lastScanOutcome: r.last_scan_outcome,
    rejectedHooks: r.rejected_hooks,
    lastRejectedAt: r.last_rejected_at,
  };
}

/** The state row of one system, or `null` when nothing was ever recorded for it. */
export async function loadSystemState(db: BusinessDb, systemId: string): Promise<ExternalSystemState | null> {
  const { rows } = await db.query<StateRow>(
    `SELECT system_id, last_scan_at, last_scan_attempt_at, last_scan_outcome, rejected_hooks, last_rejected_at
       FROM external_system_state WHERE business_id = $1 AND system_id = $2`,
    [db.businessId, systemId],
  );
  const row = rows[0];
  return row === undefined ? null : toState(row);
}

/** Events of one system since `since`, counted. */
export async function countEventsSince(db: BusinessDb, systemId: string, since: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM external_events WHERE business_id = $1 AND system_id = $2 AND created_at >= $3`,
    [db.businessId, systemId, since],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The newest `limit` events of one system, newest first. */
export async function recentEvents(db: BusinessDb, systemId: string, limit: number): Promise<ExternalEventRecord[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT event_id, system_id, source, event_type, item_hash, fields, created_at, curated_at
       FROM external_events WHERE business_id = $1 AND system_id = $2
      ORDER BY created_at DESC, event_id DESC LIMIT $3`,
    [db.businessId, systemId, limit],
  );
  return rows.map(toEvent);
}

/**
 * A learning job still open (`intake`/`understand`) this long after it was
 * created belongs to a crashed pass. One constant for both readers: the stale
 * sweep in `learn.ts` fails such a job, and erasure stops counting it as live
 * (`LEARNING_JOB_OPEN_CONDITION` in `governance/erasure-plan.ts`) — so the two
 * can never disagree about whether a job is still at work.
 */
export const LEARNING_JOB_STALE_MINUTES = 30;

/** Records that `jobId` is a learning job for `systemId` (migration 079). */
export async function recordLearningJob(db: BusinessDb, jobId: string, systemId: string): Promise<void> {
  await db.query(
    `INSERT INTO external_learning_jobs (business_id, job_id, system_id) VALUES ($1, $2, $3)
     ON CONFLICT (business_id, job_id) DO NOTHING`,
    [db.businessId, jobId, systemId],
  );
}

/** Marks a learning job failed (first failure time is kept). */
export async function markLearningJobFailed(db: BusinessDb, jobId: string): Promise<void> {
  await db.query(
    `UPDATE external_learning_jobs SET failed_at = coalesce(failed_at, now())
      WHERE business_id = $1 AND job_id = $2`,
    [db.businessId, jobId],
  );
}

/** The latest learning failure of one system at or after `since`, or `null`. */
export async function lastLearningFailure(db: BusinessDb, systemId: string, since: Date): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `SELECT max(failed_at) AS at FROM external_learning_jobs
      WHERE business_id = $1 AND system_id = $2 AND failed_at >= $3`,
    [db.businessId, systemId, since],
  );
  return rows[0]?.at ?? null;
}
