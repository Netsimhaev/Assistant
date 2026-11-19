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

export async function deleteDraft(db: BusinessDb, systemId: string): Promise<void> {
  await db.query(`DELETE FROM external_system_drafts WHERE business_id = $1 AND system_id = $2`, [
    db.businessId,
    systemId,
  ]);
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

/**
 * Reads from the last day's jobs the owner's own instructions opened, newest
 * first — what the instruct screen shows as "what came back". Joined to
 * `boss_instructions`, so a read from any other kind of job never appears.
 */
export async function loadRecentOwnerReads(db: BusinessDb, limit = 5): Promise<ExternalReadRecord[]> {
  const { rows } = await db.query<ReadRow>(
    `SELECT r.read_id, r.job_id, r.step_id, r.system_id, r.operation, r.fields, r.created_at
       FROM external_reads r
       JOIN boss_instructions i ON i.business_id = r.business_id AND i.job_id = r.job_id
      WHERE r.business_id = $1 AND r.created_at > now() - interval '24 hours'
      ORDER BY r.read_id DESC LIMIT $2`,
    [db.businessId, limit],
  );
  return rows.map(toRead);
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

/** Returns false when the same (system, item hash) was already stored. */
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
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (business_id, system_id, item_hash) DO NOTHING
     RETURNING event_id`,
    [db.businessId, `XE-${ulid()}`, input.systemId, input.source, input.eventType, input.itemHash, JSON.stringify(input.fields)],
  );
  return rows.length > 0;
}

/** Uncurated events with an id after `cursor` (null = from the start), oldest first. */
export async function newEventsSince(db: BusinessDb, cursor: string | null): Promise<ExternalEventRecord[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT event_id, system_id, source, event_type, item_hash, fields, created_at, curated_at
       FROM external_events
      WHERE business_id = $1 AND curated_at IS NULL AND ($2::text IS NULL OR event_id > $2)
      ORDER BY event_id`,
    [db.businessId, cursor],
  );
  return rows.map(toEvent);
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

export async function lastScanAt(db: BusinessDb, systemId: string): Promise<Date | null> {
  const { rows } = await db.query<{ last_scan_at: Date | null }>(
    `SELECT last_scan_at FROM external_system_state WHERE business_id = $1 AND system_id = $2`,
    [db.businessId, systemId],
  );
  return rows[0]?.last_scan_at ?? null;
}

export async function setLastScanAt(db: BusinessDb, systemId: string, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO external_system_state (business_id, system_id, last_scan_at) VALUES ($1, $2, $3)
     ON CONFLICT (business_id, system_id) DO UPDATE SET last_scan_at = EXCLUDED.last_scan_at`,
    [db.businessId, systemId, at],
  );
}
