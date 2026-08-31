/**
 * Reading and writing `proposals` (spec §10).
 *
 * Unlike `document_readings`, there is no dedupe here — see the migration's
 * own header for the argument. Every call to `saveProposal` stores a new row,
 * because a proposal is a claim about what is worth doing *now*, and the same
 * document legitimately deserves a different proposal next week.
 */

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { Proposal } from '../domain/proposal.js';

export type ProposalStatus = 'proposed' | 'unproposable';

export interface ProposalRecord {
  proposalId: string;
  businessId: string;
  readingId: string;
  status: ProposalStatus;
  reason: string | null;
  content: Proposal | null;
  model: string;
  promptVersion: string;
  decidedAt: string | null;
  decidedNote: string | null;
}

/** What a caller supplies. `businessId` rides on the options, as everywhere else here. */
export interface NewProposal {
  proposalId: string;
  readingId: string;
  status: ProposalStatus;
  reason: string | null;
  content: Proposal | null;
  model: string;
  promptVersion: string;
}

interface ProposalRow {
  proposal_id: string;
  business_id: string;
  reading_id: string;
  status: string;
  reason: string | null;
  content: unknown;
  model: string;
  prompt_version: string;
  decided_at: string | null;
  decided_note: string | null;
}

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    proposalId: row.proposal_id,
    businessId: row.business_id,
    readingId: row.reading_id,
    status: row.status as ProposalStatus,
    reason: row.reason,
    // Stored as validated JSON, read back without re-validation: what went in
    // passed `Proposal.safeParse` at the boundary, and re-parsing here would
    // make every read of the table able to fail for a reason the caller
    // cannot act on.
    content: (row.content ?? null) as Proposal | null,
    model: row.model,
    promptVersion: row.prompt_version,
    decidedAt: row.decided_at,
    decidedNote: row.decided_note,
  };
}

const COLUMNS = `proposal_id, business_id, reading_id, status, reason, content,
                 model, prompt_version, decided_at, decided_note`;

/**
 * Store a proposal.
 *
 * A plain `INSERT ... RETURNING` — there is no conflict clause, because there
 * is no dedupe. The same reading legitimately produces a different proposal
 * next week, after the charter changed, after the ramp rose, or after the
 * owner rejected the first one and asked for another.
 */
export async function saveProposal(
  input: NewProposal,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ProposalRecord> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const { rows } = await db.query<ProposalRow>(
    `INSERT INTO proposals
       (proposal_id, business_id, reading_id, status, reason, content,
        model, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.proposalId,
      businessId,
      input.readingId,
      input.status,
      input.reason,
      input.content === null ? null : JSON.stringify(input.content),
      input.model,
      input.promptVersion,
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`saveProposal: insert of ${input.proposalId} returned no row`);
  }
  return toProposal(row);
}

/** Every proposal ever made for this reading, newest first. */
export async function loadProposalsForReading(
  readingId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ProposalRecord[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM proposals
      WHERE business_id = $1 AND reading_id = $2
      ORDER BY created_at DESC, proposal_id DESC`,
    [options.businessId ?? config.businessId, readingId],
  );
  return rows.map(toProposal);
}
