/**
 * What the owner said, where it came from, and the answer they gave when
 * asked to clarify.
 *
 * The text is stored byte-for-byte as submitted. `authorisedRecipients`
 * (`src/governance/typed-recipients.ts`) matches candidate addresses against
 * exactly these bytes, so trimming or normalising here would quietly change
 * which recipients count as named by the owner.
 *
 * **"What the owner typed" stopped being the whole truth when the WhatsApp
 * channel arrived, which is why `textOrigin` is stored beside the text.** A
 * voice note's text is a transcription provider's model output; nobody typed
 * it. The row has to carry that fact because the text outlives the message it
 * arrived in: an answer to a clarifying question is planned over the JOIN of
 * this stored text and the new answer (`src/dashboard/server.ts`,
 * `src/orchestrator/whatsapp-door.ts`), and without the stored origin a typed
 * answer would launder the recorded half into typed bytes one hop later.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { InstructionTextOrigin } from './typed-recipients.js';

/** Enforced here and by a CHECK constraint, so neither path can drift alone. */
export const MAX_INSTRUCTION_CHARS = 4000;

export interface InstructionRecord {
  instructionId: string;
  businessId: string;
  jobId: string;
  text: string;
  /**
   * Where `text` came from — the owner's keyboard, or a transcript of his
   * recording. Written once at insert and never updated: an instruction does
   * not change origin, and an UPDATE path would be a way to relabel a
   * recording as typing after the fact.
   */
  textOrigin: InstructionTextOrigin;
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
  text_origin: string;
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
    // Positive, and typed as the raw `string` it arrives as rather than cast:
    // migration 039's CHECK already confines the column to the two values,
    // and this is the second of the two layers that project keeps wherever a
    // value decides authority. A stored string this reader does not
    // recognise — a value written before the CHECK existed, a row restored
    // from somewhere else — is NOT typed, which is the safe side.
    textOrigin: row.text_origin === 'typed' ? 'typed' : 'transcribed',
    question: row.question,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

const COLUMNS =
  'instruction_id, business_id, job_id, text, text_origin, question, answer, created_at::text AS created_at';

export async function saveInstruction(
  input: { jobId: string; text: string; textOrigin: InstructionTextOrigin },
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
    `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [`INS-${ulid()}`, businessId, input.jobId, input.text, input.textOrigin],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('instruction insert returned no row');
  return toInstruction(row);
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
 *
 * **`channel: 'whatsapp'` narrows, and it is the one query — never a second
 * copy of this predicate.** The WhatsApp door has to know what is open on
 * ITS own channel: a question raised from the dashboard was never put to the
 * owner over WhatsApp, so reading his next WhatsApp message as its answer
 * would swallow a message he had no reason to think was being asked for.
 * The narrowing condition is positive and derived from a column that already
 * exists for exactly this fact — `jobs.whatsapp_message_id`, whose only
 * writer is `linkWhatsAppMessage`, called only for a job the door itself
 * opened (`whatsapp-door.ts`, for `needs_answer` as well as `planned`). No
 * new table, no new column, no second "what is open" to drift from this one.
 */
export async function pendingQuestions(
  options: { businessId?: string; db?: Queryable; channel?: 'whatsapp' } = {},
): Promise<InstructionRecord[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  // Positive narrowing: the clause is added only when the caller asks for
  // the WhatsApp channel, and the unnarrowed form is byte-identical to what
  // the dashboard's `GET /instruct` has always run.
  const channelClause =
    options.channel === 'whatsapp' ? 'AND j.whatsapp_message_id IS NOT NULL' : '';

  const { rows } = await db.query<InstructionRow>(
    `SELECT i.instruction_id, i.business_id, i.job_id, i.text, i.text_origin,
            i.question, i.answer, i.created_at::text AS created_at
       FROM boss_instructions i
       JOIN jobs j ON j.job_id = i.job_id AND j.business_id = i.business_id
      WHERE i.business_id = $1
        AND j.phase = 'understand'
        AND i.answer IS NULL
        ${channelClause}
      ORDER BY i.created_at DESC`,
    [businessId],
  );
  return rows.map(toInstruction);
}

/**
 * Records an answer only if nobody has recorded one yet — a single
 * `UPDATE ... WHERE answer IS NULL` whose row count says whether this caller
 * won. **The only writer of this column.**
 *
 * One winner decided in SQL, the same shape `claimMessage` and
 * `consumeApproval` already use here and for the same reason: a
 * read-then-write lets two callers both see `NULL` and both proceed. What
 * that costs if it is lost is concrete — two routes reaching the same open
 * question (a dashboard answer racing a WhatsApp message) would both re-run
 * the planner and both supersede the parked job, and the second `transition`
 * would hit `LEGAL_TRANSITIONS`'s empty entry for an already-terminal job and
 * throw.
 *
 * **This replaced a plain overwriting `recordAnswer`, and the reason that one
 * existed is worth recording because it stopped being true.** The dashboard's
 * answer route used to depend on the overwrite: a refused re-run left the
 * parked job in `understand` so the owner could shorten his answer and
 * resubmit. Task 12's fix round 1 found that path was already broken — the
 * answer was recorded before the re-run, so the job had left
 * `pendingQuestions` and `GET /instruct` could not list it — and the route now
 * CLOSES the parked job on a refusal and says so. With no path left that needs
 * to write this column twice, two writers with different rules would have
 * been two rules for one fact.
 */
export async function claimAnswer(
  instructionId: string,
  answer: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<boolean> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rowCount } = await db.query(
    `UPDATE boss_instructions SET answer = $3
      WHERE instruction_id = $1 AND business_id = $2 AND answer IS NULL`,
    [instructionId, businessId, answer],
  );
  return rowCount === 1;
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
