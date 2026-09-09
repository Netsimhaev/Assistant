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
  /**
   * The clarifying question the planner asked about this instruction, if it
   * asked one.
   *
   * `null` covers two different things and cannot tell them apart: no
   * question was ever asked, and a question asked before migration 023 gave
   * it somewhere to live. Neither is recoverable and neither is treated as
   * an obstacle — `pendingQuestions` selects on the job's phase and on
   * `answer IS NULL`, never on this column, so a parked job with no stored
   * question still appears and can still be answered.
   */
  question: string | null;
  answer: string | null;
  createdAt: string;
}

interface InstructionRow {
  instruction_id: string;
  business_id: string;
  job_id: string;
  text: string;
  question: string | null;
  answer: string | null;
  created_at: string;
}

function toInstruction(row: InstructionRow): InstructionRecord {
  return {
    instructionId: row.instruction_id,
    businessId: row.business_id,
    jobId: row.job_id,
    text: row.text,
    question: row.question,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

const COLUMNS =
  'instruction_id, business_id, job_id, text, question, answer, created_at::text AS created_at';

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

/**
 * Stores the clarifying question the planner asked, so the owner can find it
 * again (I3).
 *
 * Called only when `runInstruction` is about to return `needs_answer` — the
 * one moment a question exists. Best-effort by design at the call site: the
 * job is already parked and the instruction row already written, so a
 * failure here must not turn a question into a failed instruction.
 *
 * Bounded to `MAX_INSTRUCTION_CHARS` here and by a CHECK constraint, the same
 * pairing `saveInstruction` uses: this is model output, and model output that
 * can grow without limit is a storage bound nobody set. Truncated rather than
 * refused — a question the owner can read most of is worth more than a row
 * that was never written.
 */
export async function recordQuestion(
  instructionId: string,
  question: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  await db.query(
    `UPDATE boss_instructions SET question = $3
      WHERE instruction_id = $1 AND business_id = $2`,
    [instructionId, businessId, question.slice(0, MAX_INSTRUCTION_CHARS)],
  );
}

/**
 * Every instruction still waiting on an answer from the owner (I3).
 *
 * The predicate is written in the positive and it is deliberately two
 * conditions, not one. The job's phase must be `understand` — the phase a
 * parked instruction sits in and nothing in the scheduler touches — AND the
 * answer must still be missing. Phase alone would list a job whose answer was
 * recorded but whose re-run then refused; `answer IS NULL` alone would list
 * every instruction that never asked anything at all.
 *
 * Newest first, so a fresh question is not buried under old ones.
 */
export async function pendingQuestions(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<InstructionRecord[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<InstructionRow>(
    `SELECT i.instruction_id, i.business_id, i.job_id, i.text, i.question, i.answer,
            i.created_at::text AS created_at
       FROM boss_instructions i
       JOIN jobs j ON j.job_id = i.job_id AND j.business_id = i.business_id
      WHERE i.business_id = $1
        AND j.phase = 'understand'
        AND i.answer IS NULL
      ORDER BY i.created_at DESC`,
    [businessId],
  );
  return rows.map(toInstruction);
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
