import { ulid } from 'ulid';
import type { Queryable } from '../../db/pool.js';
import { getPool } from '../../db/pool.js';
import { InterviewAnswers, InterviewAnswersDraft } from './answers.js';

/**
 * The owner's interview in flight: one row per business, saved a section at a
 * time (migration 051).
 *
 * **Every write validates; every read parses — and a row that does not parse
 * THROWS.** A corrupt draft is not "no draft": reading it as `null` would put
 * the owner back at an empty step one and the next save would merge over the
 * rows nobody can read, silently. A clear error naming the business is the
 * honest answer, the same choice `loadActiveCharter` makes for a charter that
 * no longer parses.
 */
export interface InterviewDraft {
  draftId: string;
  businessId: string;
  answers: InterviewAnswersDraft;
  frozenAt: Date | null;
  baseCharterVersion: string | null;
  updatedAt: Date;
}

interface DraftRow {
  draft_id: string;
  business_id: string;
  answers: unknown;
  frozen_at: Date | null;
  base_charter_version: string | null;
  updated_at: Date;
}

const COLUMNS = 'draft_id, business_id, answers, frozen_at, base_charter_version, updated_at';

function toDraft(row: DraftRow): InterviewDraft {
  const parsed = InterviewAnswersDraft.safeParse(row.answers);
  if (!parsed.success) {
    throw new Error(
      `interview draft ${row.draft_id} for business ${row.business_id} does not parse: ${parsed.error.message}`,
    );
  }
  return {
    draftId: row.draft_id,
    businessId: row.business_id,
    answers: parsed.data,
    frozenAt: row.frozen_at,
    baseCharterVersion: row.base_charter_version,
    updatedAt: row.updated_at,
  };
}

function only(rows: DraftRow[], what: string): InterviewDraft {
  const row = rows[0];
  if (row === undefined) throw new Error(`interview draft vanished mid-${what}`);
  return toDraft(row);
}

export async function loadDraft(businessId: string, db: Queryable = getPool()): Promise<InterviewDraft | null> {
  const { rows } = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM charter_interview_drafts WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  return row === undefined ? null : toDraft(row);
}

/**
 * Save one section whole, merged over the sections already saved.
 *
 * `value` is validated with that section's own schema before anything is
 * written. The route layer validates first and shows the owner the errors;
 * this is the backstop, so no caller can store a section the charter builder
 * would later choke on. The parsed value — not the raw input — is what is
 * written.
 *
 * **Always clears `frozen_at`.** A frozen draft is the one the owner reviewed;
 * any edit after that makes the review stale, and the review step must be
 * reached again.
 *
 * `baseCharterVersion` is written on insert only: the version an edit started
 * from does not move because a later section was saved.
 */
export async function saveSection(
  businessId: string,
  section: keyof InterviewAnswers,
  value: unknown,
  options: { baseCharterVersion?: string | null } = {},
): Promise<InterviewDraft> {
  const parsed = InterviewAnswers.shape[section].parse(value);
  const { rows } = await getPool().query<DraftRow>(
    `INSERT INTO charter_interview_drafts (draft_id, business_id, answers, base_charter_version)
     VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb), $5)
     ON CONFLICT (business_id) DO UPDATE
       SET answers = charter_interview_drafts.answers || jsonb_build_object($3::text, $4::jsonb),
           frozen_at = NULL,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [ulid(), businessId, section, JSON.stringify(parsed), options.baseCharterVersion ?? null],
  );
  return only(rows, 'save');
}

/**
 * Replace the whole draft — the edit-mode prefill from an active charter.
 * Validated as a draft, clears `frozen_at`, and (unlike `saveSection`) writes
 * `baseCharterVersion` on update too: a prefill IS a new starting point.
 */
export async function replaceDraft(
  businessId: string,
  answers: InterviewAnswersDraft,
  baseCharterVersion: string | null,
): Promise<InterviewDraft> {
  const parsed = InterviewAnswersDraft.parse(answers);
  const { rows } = await getPool().query<DraftRow>(
    `INSERT INTO charter_interview_drafts (draft_id, business_id, answers, base_charter_version)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (business_id) DO UPDATE
       SET answers = EXCLUDED.answers,
           base_charter_version = EXCLUDED.base_charter_version,
           frozen_at = NULL,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [ulid(), businessId, JSON.stringify(parsed), baseCharterVersion],
  );
  return only(rows, 'replace');
}

/**
 * Freeze the draft for review. Sets `frozen_at` only if it is NULL, so a
 * second freeze (a reload of the review page) keeps the first moment, and
 * returns the effective value. Throws when the business has no draft — there
 * is nothing to review.
 */
export async function freezeDraft(businessId: string, at: Date): Promise<Date> {
  const { rows } = await getPool().query<{ frozen_at: Date }>(
    `UPDATE charter_interview_drafts
        SET frozen_at = coalesce(frozen_at, $2)
      WHERE business_id = $1
      RETURNING frozen_at`,
    [businessId, at],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no interview draft to freeze for business ${businessId}`);
  return row.frozen_at;
}

/** Delete the business's draft, inside the caller's transaction (the sign step). */
export async function deleteDraft(businessId: string, tx: Queryable): Promise<void> {
  await tx.query('DELETE FROM charter_interview_drafts WHERE business_id = $1', [businessId]);
}
