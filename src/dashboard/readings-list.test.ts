import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { recentReadings } from './readings-list.js';

const BUSINESS = 'biz-readings';

async function seed(businessId: string, documentId: string, stance: string): Promise<void> {
  await getPool().query(
    `INSERT INTO documents
       (document_id, business_id, source, original_name, media_type, byte_size,
        sha256, stored_path, status)
     VALUES ($1, $2, 'manual', 'חוזה.txt', 'text/plain', 10,
             repeat('a', 64), 'p/1.txt', 'extracted')`,
    [documentId, businessId],
  );
  await getPool().query(
    `INSERT INTO document_readings
       (reading_id, business_id, document_id, status, reason, content,
        provenance, model, prompt_version, brief_hash)
     VALUES ($1, $2, $3, 'read', NULL, $4::jsonb,
             'unknown_external', 'test', 'v1', 'h')`,
    [`RD-${documentId}`, businessId, documentId, JSON.stringify({ summary: 'סיכום', findings: [], intents: [] })],
  );
  await getPool().query(
    `INSERT INTO proposals
       (proposal_id, business_id, reading_id, job_id, status, reason, content, raw,
        model, prompt_version)
     VALUES ($1, $2, $3, NULL, 'proposed', NULL, $4::jsonb, '', 'test', 'v1')`,
    [
      `PR-${documentId}`,
      businessId,
      `RD-${documentId}`,
      JSON.stringify({
        headline: 'אני נגד חתימה',
        stance,
        reasons: [{ text: 'המחיר השתנה', findingLabel: 'מחיר' }],
        action: null,
      }),
    ],
  );
}

describe('recentReadings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns the reading with its proposal stance and reasons', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    const rows = await recentReadings(10, { businessId: BUSINESS });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stance).toBe('advise_against');
    expect(rows[0]?.headline).toBe('אני נגד חתימה');
    expect(rows[0]?.reasons).toEqual(['המחיר השתנה']);
  });

  it('never returns another business\'s reading', async () => {
    await seed(BUSINESS, 'DOC-1', 'advise_against');
    expect(await recentReadings(10, { businessId: 'other' })).toEqual([]);
  });
});
