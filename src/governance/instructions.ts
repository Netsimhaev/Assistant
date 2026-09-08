/**
 * What the owner typed, and the answer they gave when asked to clarify.
 *
 * The text is stored byte-for-byte as submitted. `authorisedRecipients`
 * (`src/governance/typed-recipients.ts`) matches candidate addresses against
 * exactly these bytes, so trimming or normalising here would quietly change
 * which recipients count as named by the owner.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/** Enforced here and by a CHECK constraint, so neither path can drift alone. */
export const MAX_INSTRUCTION_CHARS = 4000;

export interface InstructionRecord {
  instructionId: string;
  businessId: string;
  jobId: string;
  text: string;
  answer: string | null;
  createdAt: string;
}

interface InstructionRow {
  instruction_id: string;
  business_id: string;
  job_id: string;
  text: string;
  answer: string | null;
  created_at: string;
}

function toInstruction(row: InstructionRow): InstructionRecord {
  return {
    instructionId: row.instruction_id,
    businessId: row.business_id,
    jobId: row.job_id,
    text: row.text,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

const COLUMNS = 'instruction_id, business_id, job_id, text, answer, created_at::text AS created_at';

export async function saveInstruction(
  input: { jobId: string; text: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<InstructionRecord> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  // Checked here as well as in the CHECK constraint. The constraint is the
  // one that cannot be bypassed; this one gives a message in the owner's
  // language instead of a Postgres error string.
  if (input.text.trim().length === 0) {
    throw new Error('ההוראה ריקה');
  }
  if (input.text.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(
      `ההוראה ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים (${input.text.length}). ` +
        'תיבת ההוראות אינה המקום להדביק מסמך שלם — לתיקיית הקליטה יש מסלול משלה.',
    );
  }

  const { rows } = await db.query<InstructionRow>(
    `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [`INS-${ulid()}`, businessId, input.jobId, input.text],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('instruction insert returned no row');
  return toInstruction(row);
}

export async function recordAnswer(
  instructionId: string,
  answer: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  await db.query(
    `UPDATE boss_instructions SET answer = $3
      WHERE instruction_id = $1 AND business_id = $2`,
    [instructionId, businessId, answer],
  );
}

export async function loadInstructionForJob(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<InstructionRecord | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<InstructionRow>(
    `SELECT ${COLUMNS} FROM boss_instructions
      WHERE job_id = $1 AND business_id = $2`,
    [jobId, businessId],
  );
  const row = rows[0];
  return row === undefined ? null : toInstruction(row);
}
