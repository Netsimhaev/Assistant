/**
 * Owner-approved topics a known client or supplier may be answered on. A topic
 * names which tier-2 sources may feed the answer and whether the assistant may
 * answer it alone; it grants nothing by itself — the gate and the send-time
 * checks decide.
 */
import { ulid } from 'ulid';
import { appendAudit } from '../audit/log.js';
import type { BusinessDb } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';

export const TIER2_SOURCE_NAMES = [
  'uploaded_invoices',
  'sent_invoices',
  'accounting_invoices',
  'calendar_busy',
  'ledger_of_sender',
  'meetings_of_sender',
  'external_of_sender',
  'public',
] as const;
export type Tier2SourceName = (typeof TIER2_SOURCE_NAMES)[number];

export type TopicAppliesTo = 'client' | 'supplier' | 'both';

export interface ContactTopic {
  topicId: string;
  name: string;
  description: string;
  appliesTo: TopicAppliesTo;
  sources: Tier2SourceName[];
  autoReply: boolean;
  retiredAt: Date | null;
  updatedAt: Date;
}

interface TopicRow {
  topic_id: string;
  name: string;
  description: string;
  applies_to: TopicAppliesTo;
  sources: string[];
  auto_reply: boolean;
  retired_at: Date | null;
  updated_at: Date;
}

const COLUMNS = 'topic_id, name, description, applies_to, sources, auto_reply, retired_at, updated_at';

function toTopic(row: TopicRow): ContactTopic {
  return {
    topicId: row.topic_id,
    name: row.name,
    description: row.description,
    appliesTo: row.applies_to,
    sources: row.sources.filter((s): s is Tier2SourceName => (TIER2_SOURCE_NAMES as readonly string[]).includes(s)),
    autoReply: row.auto_reply,
    retiredAt: row.retired_at,
    updatedAt: row.updated_at,
  };
}

export interface TopicInput {
  name: string;
  description: string;
  appliesTo: TopicAppliesTo;
  sources: Tier2SourceName[];
  autoReply: boolean;
  by: string;
}

export const TOPIC_NAME_REQUIRED = 'חובה לתת שם לנושא.';
export const TOPIC_APPLIES_INVALID = 'הנושא חייב להתאים ללקוחות, לספקים או לשניהם.';
export const TOPIC_SOURCE_UNKNOWN = 'מקור מידע לא מוכר.';
export const TOPIC_NOT_FOUND = 'הנושא לא נמצא.';

/** A validation refusal whose Hebrew message is safe to show the owner. */
export class TopicInputError extends Error {}
/** The topic is missing, belongs to another business or is retired. */
export class TopicNotFoundError extends Error {
  constructor() {
    super(TOPIC_NOT_FOUND);
  }
}

const APPLIES = ['client', 'supplier', 'both'];

function validate(p: { name?: string; appliesTo?: string; sources?: string[] }): void {
  if (p.name !== undefined && p.name.trim() === '') throw new TopicInputError(TOPIC_NAME_REQUIRED);
  if (p.appliesTo !== undefined && !APPLIES.includes(p.appliesTo)) throw new TopicInputError(TOPIC_APPLIES_INVALID);
  if (p.sources !== undefined) {
    for (const s of p.sources) {
      if (!(TIER2_SOURCE_NAMES as readonly string[]).includes(s)) throw new TopicInputError(TOPIC_SOURCE_UNKNOWN);
    }
  }
}

async function audit(db: BusinessDb, action: string, topicId: string, by: string): Promise<void> {
  await appendAudit(db, {
    actor: 'human',
    onBehalfOf: by,
    kind: 'tool_call',
    charterVersion: 'n/a',
    provenance: 'boss',
    inputHash: canonicalHash({ topicId }),
    reason: `contact_topic:${action}`,
  });
}

export async function listTopics(db: BusinessDb, opts: { includeRetired?: boolean } = {}): Promise<ContactTopic[]> {
  const { rows } = await db.query<TopicRow>(
    `SELECT ${COLUMNS} FROM contact_topics
      WHERE business_id = $1 ${opts.includeRetired === true ? '' : 'AND retired_at IS NULL'}
      ORDER BY created_at, topic_id`,
    [db.businessId],
  );
  return rows.map(toTopic);
}

export async function loadTopic(db: BusinessDb, topicId: string): Promise<ContactTopic | null> {
  const { rows } = await db.query<TopicRow>(
    `SELECT ${COLUMNS} FROM contact_topics WHERE business_id = $1 AND topic_id = $2`,
    [db.businessId, topicId],
  );
  const row = rows[0];
  return row === undefined ? null : toTopic(row);
}

export async function createTopic(db: BusinessDb, input: TopicInput): Promise<ContactTopic> {
  validate({ name: input.name, appliesTo: input.appliesTo, sources: input.sources });
  const topicId = ulid();
  await db.query(
    `INSERT INTO contact_topics (business_id, topic_id, name, description, applies_to, sources, auto_reply, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [db.businessId, topicId, input.name.trim(), input.description, input.appliesTo, input.sources, input.autoReply, input.by],
  );
  await audit(db, 'created', topicId, input.by);
  if (input.autoReply) await audit(db, 'auto_on', topicId, input.by);
  const topic = await loadTopic(db, topicId);
  if (topic === null) throw new Error('topic insert returned no row');
  return topic;
}

export interface TopicPatch {
  name?: string;
  description?: string;
  appliesTo?: TopicAppliesTo;
  sources?: Tier2SourceName[];
}

export async function updateTopic(db: BusinessDb, topicId: string, patch: TopicPatch, by: string): Promise<ContactTopic> {
  validate(patch);
  const current = await loadTopic(db, topicId);
  if (current === null || current.retiredAt !== null) throw new TopicNotFoundError();
  await db.query(
    `UPDATE contact_topics SET name = $3, description = $4, applies_to = $5, sources = $6, updated_at = now()
      WHERE business_id = $1 AND topic_id = $2`,
    [
      db.businessId,
      topicId,
      patch.name?.trim() ?? current.name,
      patch.description ?? current.description,
      patch.appliesTo ?? current.appliesTo,
      patch.sources ?? current.sources,
    ],
  );
  await audit(db, 'updated', topicId, by);
  const topic = await loadTopic(db, topicId);
  if (topic === null) throw new Error('topic vanished');
  return topic;
}

export async function retireTopic(db: BusinessDb, topicId: string, by: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contact_topics SET retired_at = now(), auto_reply = false, updated_at = now()
      WHERE business_id = $1 AND topic_id = $2 AND retired_at IS NULL`,
    [db.businessId, topicId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await audit(db, 'retired', topicId, by);
  return true;
}

export async function setTopicAutoReply(db: BusinessDb, topicId: string, on: boolean, by: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contact_topics SET auto_reply = $3, updated_at = now()
      WHERE business_id = $1 AND topic_id = $2 AND retired_at IS NULL`,
    [db.businessId, topicId, on],
  );
  if ((rowCount ?? 0) === 0) return false;
  await audit(db, on ? 'auto_on' : 'auto_off', topicId, by);
  return true;
}

export function topicApplies(topic: Pick<ContactTopic, 'appliesTo'>, kind: 'client' | 'supplier'): boolean {
  return topic.appliesTo === 'both' || topic.appliesTo === kind;
}
