/**
 * The owner's signature on a document (spec §5).
 *
 * Beside `approvals.ts`, `consume.ts` and `killswitch.ts`, not under
 * `documents/`: signing is a governance act — a person accepting a document
 * as binding — not document processing. `signed_by` is a dashboard username,
 * never an agent id and never `'system'`; nothing in this module supplies
 * that value, the caller does.
 */

import { DatabaseError } from 'pg';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';

/** Postgres' unique/primary-key-violation error code (see `src/cli/create-owner.ts`). */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === UNIQUE_VIOLATION;
}

export interface SignatureRecord {
  signatureId: string;
  businessId: string;
  documentId: string;
  signedSha256: string;
  approvalId: string;
  signedBy: string;
}

/** What a caller supplies to `recordSignature`. */
export interface NewSignature {
  signatureId: string;
  documentId: string;
  signedSha256: string;
  approvalId: string;
  signedBy: string;
}

interface SignatureRow {
  signature_id: string;
  business_id: string;
  document_id: string;
  signed_sha256: string;
  approval_id: string;
  signed_by: string;
}

function toSignature(row: SignatureRow): SignatureRecord {
  return {
    signatureId: row.signature_id,
    businessId: row.business_id,
    documentId: row.document_id,
    signedSha256: row.signed_sha256,
    approvalId: row.approval_id,
    signedBy: row.signed_by,
  };
}

const COLUMNS = `signature_id, business_id, document_id, signed_sha256, approval_id, signed_by`;

/**
 * Thrown when a document already carries a signature.
 *
 * One signature per document, enforced by `signatures_one_per_document_idx`
 * (migration 019). A second signature is not an update — the row would either
 * silently overwrite who accepted the document and when, or (with no update
 * path at all) simply fail as an opaque `23505`. Catching the unique
 * violation and naming it means the refusal reads as "a document is signed
 * once" rather than a raw Postgres code nobody who never opened the
 * migration would recognise.
 */
export class DocumentAlreadySignedError extends Error {
  constructor(documentId: string) {
    super(
      `recordSignature: document ${documentId} already carries a signature; a second signature would silently overwrite who accepted it and when`,
    );
    this.name = 'DocumentAlreadySignedError';
  }
}

/** Store the owner's signature on a document. One per document; a second throws `DocumentAlreadySignedError`. */
export async function recordSignature(
  input: NewSignature,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<SignatureRecord> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  try {
    const { rows } = await db.query<SignatureRow>(
      `INSERT INTO signatures (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        input.signatureId,
        businessId,
        input.documentId,
        input.signedSha256,
        input.approvalId,
        input.signedBy,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      // INSERT ... RETURNING with no ON CONFLICT clause either returns
      // exactly one row or throws; a missing row here is the table
      // disagreeing with itself, not a document property.
      throw new Error(
        `recordSignature: insert for ${input.documentId} returned no row`,
      );
    }
    return toSignature(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DocumentAlreadySignedError(input.documentId);
    }
    throw err;
  }
}

/** The signature on a document, if any. */
export async function loadSignature(
  documentId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<SignatureRecord | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<SignatureRow>(
    `SELECT ${COLUMNS} FROM signatures WHERE business_id = $1 AND document_id = $2`,
    [options.businessId ?? config.businessId, documentId],
  );
  const row = rows[0];
  return row === undefined ? null : toSignature(row);
}
