/**
 * Signing and deciding as one act (spec §5, final-fix F1).
 *
 * The dashboard's sign button is three writes: the signature row, its audit
 * entry, and the approval decision the signature rides on. Run as three
 * commits they can come apart, and the way they come apart is not symmetric.
 * A signature that commits and is then followed by a failing `decide` — a
 * second tab denied the approval, `expireOverdue` swept it, or the TTL simply
 * elapsed while the file was being re-read and hashed — leaves a permanent
 * row asserting that this owner accepted this document *through this
 * approval*, over an approval that was denied or expired. Worse, the row is
 * permanent in the strong sense: `signatures_one_per_document_idx` allows one
 * per document, so the document can never be signed again.
 *
 * The route's own guard (`server.ts`) reads `state` and `expires_at` before
 * any of this and refuses early. It narrows the window; it cannot close it,
 * because a document join, a file read and a SHA-256 sit between that read
 * and `decide`'s `WHERE ... state = 'pending' AND expires_at > now()`.
 *
 * So all three run on one connection inside one transaction. `decide` is
 * LAST on purpose: it is the statement that can still refuse on a predicate
 * nobody upstream can hold still, and putting it last means the failure it
 * raises rolls back a signature and an audit entry that were written moments
 * earlier in the same transaction — which is precisely the interleaving F1
 * describes, and precisely what `sign-decision.test.ts` drives.
 */

import { withTransaction } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import type { AuditEntryInput } from '../domain/audit.js';
import { decide, type ApprovalRequest, type Decision } from './approvals.js';
import { recordSignature, type NewSignature } from './signatures.js';

export interface SignAndDecideInput {
  approvalId: string;
  decision: Decision;
  signature: NewSignature;
  audit: AuditEntryInput;
}

/**
 * Record the signature, its audit entry and the approval decision, or none of
 * them.
 *
 * Throws whatever its parts throw — `DocumentAlreadySignedError` from
 * `recordSignature`, and `decide`'s "already decided"/"expired"/"decided
 * concurrently" errors — with nothing committed in any of those cases. The
 * caller renders the refusal; it never has to undo a partial write, because
 * there is no partial write to undo.
 *
 * The job-phase transition that follows an approval is deliberately NOT in
 * here. `transition` opens its own transaction and takes `FOR UPDATE` on the
 * job row; pulling it inside would either need a second connection (defeating
 * the point) or a rewrite of a function five other callers depend on. It runs
 * after this commits, exactly as `applyDecision` runs it after `decide` — and
 * a crash between the two leaves "decided and signed but the job did not
 * move", which **nothing repairs on its own**. `expireApprovals` sweeps only
 * `pending` rows, `wakeDueJobs` needs a `wake_at`, and `runDueJobs` selects
 * `phase = 'execute'` — none of them loads a job parked in `await_approval`
 * behind a decided approval. The owner cannot retry it either: the document
 * holds its one permitted signature and the approval is no longer `pending`,
 * so both guards refuse. It needs manual repair. The window is older than
 * this function — `applyDecision` has always had it, and `resume.ts` says why
 * it stays open — but a comment claiming a recovery path that does not exist
 * is the same defect this module was written to remove.
 */
export async function decideAndSign(
  input: SignAndDecideInput,
  options: { businessId?: string } = {},
): Promise<ApprovalRequest> {
  const businessId = options.businessId;
  const scope = businessId !== undefined ? { businessId } : {};

  return withTransaction(async (tx) => {
    await recordSignature(input.signature, { ...scope, db: tx });
    await appendAudit(input.audit, { ...scope, tx });
    return decide(input.approvalId, 'approved', input.decision, { ...scope, db: tx });
  });
}
