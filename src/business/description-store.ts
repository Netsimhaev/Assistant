import { createHash } from 'node:crypto';
import { appendAudit } from '../audit/log.js';
import { acquireAdvisoryLock, transaction, type BusinessDb } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';

export const BUSINESS_DESCRIPTION_MAX_CHARS = 8000;
export const DESCRIPTION_PROPOSAL_RUNS_PER_DAY = 10;

export interface BusinessDescription {
  version: number;
  text: string;
  createdAt: Date;
  createdBy: string;
}

interface DescriptionRow {
  version: number;
  text: string;
  created_at: Date;
  created_by: string;
}

function toDescription(row: DescriptionRow): BusinessDescription {
  return {
    version: row.version,
    text: row.text,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function loadActiveDescription(db: BusinessDb): Promise<BusinessDescription | null> {
  const { rows } = await db.query<DescriptionRow>(
    `SELECT version, text, created_at, created_by
       FROM business_descriptions
      WHERE business_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [db.businessId],
  );
  const row = rows[0];
  return row ? toDescription(row) : null;
}

export type SaveDescriptionResult =
  | { saved: true; description: BusinessDescription }
  | { saved: false; reason: 'unchanged' }
  | { saved: false; reason: 'too_long'; messageHe: string };

/**
 * Save a new version. Empty text is valid (the owner may clear the
 * description). The row and its audit row are one transaction; the audit row
 * carries a hash and the length, never the text.
 */
export async function saveDescription(
  db: BusinessDb,
  input: { text: string; createdBy: string },
): Promise<SaveDescriptionResult> {
  const text = input.text.trim();
  if (text.length > BUSINESS_DESCRIPTION_MAX_CHARS) {
    return {
      saved: false,
      reason: 'too_long',
      messageHe: `התיאור ארוך מדי: עד ${BUSINESS_DESCRIPTION_MAX_CHARS.toLocaleString('en-US')} תווים.`,
    };
  }

  return transaction(db, async (tx): Promise<SaveDescriptionResult> => {
    await acquireAdvisoryLock(tx, `description:${tx.businessId}`);
    const current = await loadActiveDescription(tx);
    if ((current?.text ?? '') === text) return { saved: false, reason: 'unchanged' };

    const { rows } = await tx.query<DescriptionRow>(
      `INSERT INTO business_descriptions (business_id, version, text, created_by)
       SELECT $1::text, coalesce(max(version), 0) + 1, $2::text, $3::text
         FROM business_descriptions WHERE business_id = $1
       RETURNING version, text, created_at, created_by`,
      [tx.businessId, text, input.createdBy],
    );
    const row = rows[0];
    if (!row) throw new Error('description insert returned no row');
    const description = toDescription(row);

    await appendAudit(tx, {
      actor: 'human',
      onBehalfOf: input.createdBy,
      kind: 'description_change',
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({
        length: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
      }),
      reason: `תיאור העסק עודכן (גרסה ${description.version}, ${text.length} תווים)`,
    });
    return { saved: true, description };
  });
}

/** Description versions written in the last 24 hours (the daily proposal cap). */
export async function proposalRunsInLastDay(db: BusinessDb): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM business_descriptions
      WHERE business_id = $1 AND created_at > now() - interval '24 hours'`,
    [db.businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

export function normaliseSentence(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function sentenceHash(s: string): string {
  return createHash('sha256').update(normaliseSentence(s)).digest('hex');
}

export async function recordRejectedSentence(db: BusinessDb, sentence: string): Promise<void> {
  await db.query(
    `INSERT INTO description_rule_rejections (business_id, sentence_hash)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [db.businessId, sentenceHash(sentence)],
  );
}

export async function rejectedSentenceHashes(db: BusinessDb): Promise<ReadonlySet<string>> {
  const { rows } = await db.query<{ sentence_hash: string }>(
    'SELECT sentence_hash FROM description_rule_rejections WHERE business_id = $1',
    [db.businessId],
  );
  return new Set(rows.map((r) => r.sentence_hash));
}
