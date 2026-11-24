/** The exact payload hash the six exit checks cleared for an auto reply; the gate re-reads it at send time. */
import type { BusinessDb } from '../db/pool.js';

export interface Clearance {
  inputHash: string;
  conversationId: string;
  topicId: string;
}

const HASH = /^[0-9a-f]{64}$/;

export async function writeClearance(
  db: BusinessDb,
  c: { jobId: string; stepId: string; inputHash: string; conversationId: string; topicId: string },
): Promise<void> {
  if (!HASH.test(c.inputHash)) throw new Error('clearance input hash is malformed');
  await db.query(
    `INSERT INTO contact_auto_clearances (business_id, job_id, step_id, input_hash, conversation_id, topic_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (business_id, job_id, step_id) DO UPDATE SET
       input_hash = EXCLUDED.input_hash, conversation_id = EXCLUDED.conversation_id, topic_id = EXCLUDED.topic_id`,
    [db.businessId, c.jobId, c.stepId, c.inputHash, c.conversationId, c.topicId],
  );
}

export async function loadClearance(db: BusinessDb, jobId: string, stepId: string): Promise<Clearance | null> {
  const { rows } = await db.query<{ input_hash: string; conversation_id: string; topic_id: string }>(
    `SELECT input_hash, conversation_id, topic_id FROM contact_auto_clearances
      WHERE business_id = $1 AND job_id = $2 AND step_id = $3`,
    [db.businessId, jobId, stepId],
  );
  const r = rows[0];
  return r === undefined ? null : { inputHash: r.input_hash, conversationId: r.conversation_id, topicId: r.topic_id };
}
