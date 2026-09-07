/**
 * Loop B — understanding. This is the half that costs money.
 *
 * One job per document, walked through the phases for real
 * (`intake → understand → plan → await_approval`) so the audit trail describes
 * a history that happened. A job left in `intake` with a reading and a proposal
 * hanging off it would describe one that did not.
 *
 * Failure is per document, never per batch: one document that cannot be read
 * must not stop the ones behind it, which is the rule `ingestDocument` already
 * keeps for a hostile file.
 */
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { readDocument, type ReadDocumentOptions } from '../documents/read.js';
import {
  documentsAwaitingRead,
  readingsToday,
  recordReadFailure,
} from '../documents/store.js';
import { createJob, transition } from './jobs.js';
import { proposeForReading, type ProposeForReadingOptions } from './propose.js';
import { raiseProposalApproval } from './proposal-approval.js';

export interface ConductOptions {
  businessId?: string;
  /** Defaults to `config.documentReadsPerDay`. */
  readsPerDay?: number;
  /** Most documents to consider in one pass, regardless of the daily ceiling. */
  limit?: number;
  reader?: ReadDocumentOptions['reader'];
  proposer?: ProposeForReadingOptions['proposer'];
}

export interface ConductResult {
  considered: number;
  /** Proposals that carried an action and produced a pending card. */
  carded: number;
  /** Proposals with no action — stored, and visible only on the readings screen. */
  readOnly: number;
  failed: number;
  ceilingReached: boolean;
}

export async function conductPendingDocuments(
  options: ConductOptions = {},
): Promise<ConductResult> {
  const businessId = options.businessId ?? config.businessId;
  const readsPerDay = options.readsPerDay ?? config.documentReadsPerDay;
  const limit = options.limit ?? 10;

  const result: ConductResult = {
    considered: 0,
    carded: 0,
    readOnly: 0,
    failed: 0,
    ceilingReached: false,
  };

  // No charter, no reasoning: the bundle is what the proposer's catalogue and
  // the risk engine's ceilings are both derived from. `evaluateToolCall`
  // treats an absent charter as fatal for the same reason.
  const active = await loadActiveCharter(businessId);
  if (active === null) return result;

  const alreadyToday = await readingsToday({ businessId });
  let remaining = readsPerDay - alreadyToday;
  if (remaining <= 0) {
    result.ceilingReached = true;
    return result;
  }

  const waiting = await documentsAwaitingRead(limit, { businessId });

  for (const document of waiting) {
    if (remaining <= 0) {
      result.ceilingReached = true;
      break;
    }
    result.considered += 1;
    remaining -= 1;

    try {
      const job = await createJob({
        charterVersion: active.charter.charterVersion,
        // Not a parameter, and not derived from anything a document says.
        provenance: 'unknown_external',
        businessId,
        title: `מסמך: ${document.originalName}`,
      });

      await transition(job.jobId, {
        to: 'understand',
        actor: 'orchestrator',
        reason: 'conductor: reading an ingested document',
        businessId,
      });

      const read = await readDocument(
        {
          documentId: document.documentId,
          jobId: job.jobId,
          provenance: 'unknown_external',
          bundle: active.bundle,
        },
        {
          businessId,
          ...(options.reader !== undefined ? { reader: options.reader } : {}),
        },
      );

      if (read.status !== 'read') {
        await recordReadFailure(document.documentId, `read: ${read.status}`, { businessId });
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `conductor: ${read.status}`,
          businessId,
        });
        result.failed += 1;
        continue;
      }

      await transition(job.jobId, {
        to: 'plan',
        actor: 'orchestrator',
        reason: 'conductor: proposing from the reading',
        businessId,
      });

      const proposed = await proposeForReading(
        { documentId: document.documentId, jobId: job.jobId, bundle: active.bundle },
        {
          businessId,
          ...(options.proposer !== undefined ? { proposer: options.proposer } : {}),
        },
      );

      if (proposed.status !== 'proposed') {
        await recordReadFailure(document.documentId, `propose: ${proposed.status}`, {
          businessId,
        });
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `conductor: ${proposed.status}`,
          businessId,
        });
        result.failed += 1;
        continue;
      }

      const approvalId = await raiseProposalApproval(
        { jobId: job.jobId, proposal: proposed.proposal, bundle: active.bundle },
        { businessId },
      );

      if (approvalId === null) {
        // A stance with nothing to approve. The proposal is stored and the
        // owner sees it on the readings screen; the job has nowhere further
        // to go, so it closes rather than sitting in `plan` forever.
        await transition(job.jobId, {
          to: 'closed',
          actor: 'orchestrator',
          reason: 'conductor: proposal carries no action',
          businessId,
        });
        result.readOnly += 1;
        continue;
      }

      await transition(job.jobId, {
        to: 'await_approval',
        actor: 'orchestrator',
        reason: `conductor: ${approvalId}`,
        businessId,
      });
      result.carded += 1;
    } catch (err) {
      // Per document, never per batch.
      const message = err instanceof Error ? err.message : String(err);
      await recordReadFailure(document.documentId, message, { businessId });
      result.failed += 1;
    }
  }

  return result;
}
