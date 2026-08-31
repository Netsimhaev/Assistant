/**
 * `proposeForReading` — a reading in, a stored proposal and a plan out
 * (spec §7).
 *
 * The order these steps run in *is* the design, the same way it is in
 * `ingestDocument` and `readDocument`:
 *
 *   loadJob → read its provenance → loadLatestReading (with that provenance)
 *     → no reading? return no_reading → makeProposal → saveProposal (both
 *     outcomes) → proposalToPlan (null when the proposal carries no action)
 *
 * **The `provenance` contract from sub-project ב' comes due here.**
 * `loadLatestReading` requires a `provenance` argument, and `readDocument`'s
 * own docblock records why a mismatched one is a trust raise: a reading made
 * for `unknown_external` material must never be handed back to a caller
 * asking under `boss`. `CLAUDE.md` records the obligation this leaves open —
 * "the first production caller must derive it from the job row instead" —
 * and this is that caller. `input` therefore carries no `provenance` field at
 * all: a caller who could choose it could ask for a boss-level read of a
 * stranger's document, and the cache would honour it precisely. The job row
 * is the only source, loaded fresh here rather than trusted from the caller.
 *
 * **Nothing here throws for a bad model response.** An unproposable answer is
 * stored and returned, exactly as `readDocument` records an unreadable one. A
 * genuine fault — the database unreachable, no such job — still propagates,
 * because that is not a property of the reading.
 *
 * **A reading that does not exist and one that exists but could not be read
 * are the same case here.** Both leave nothing a proposal could be made from,
 * and `ReadingRecord.content` is `null` on both — `unreadable` is not "an
 * empty proposal", it is "no reading to propose from at all".
 */

import { ulid } from 'ulid';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { AutonomyLevel } from '../domain/trust.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { Plan } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';
import { loadLatestReading } from '../documents/reading-store.js';
import {
  makeProposal,
  PROPOSER_MODEL,
  type ProposeOutcome,
  type ProposeRequest,
} from '../sdk/proposer.js';
import { PROPOSAL_PROMPT_VERSION } from '../sdk/proposal-prompt.js';
import { loadJob } from './jobs.js';
import { proposalToPlan } from './proposal-to-plan.js';
import { saveProposal, type ProposalRecord } from './proposal-store.js';

export interface ProposeForReadingInput {
  documentId: string;
  /**
   * The job this proposal belongs to. Required, not optional or nullable: a
   * proposal always follows a reading that was made for a specific job, and
   * this job's own `provenance` column is the only place that reading's trust
   * level is allowed to come from. See this module's header.
   */
  jobId: string;
  bundle: PolicyBundle;
}

export interface ProposeForReadingOptions {
  businessId?: string;
  db?: Queryable;
  /**
   * The one step that costs money, injectable so the composition can be
   * tested without an API key — a stand-in for the one step that costs
   * money, not a mock of the SDK. Every other step in this function runs for
   * real against the real database.
   */
  proposer?: (request: ProposeRequest) => Promise<ProposeOutcome>;
}

export type ProposeResult =
  | { status: 'proposed'; proposal: Proposal; record: ProposalRecord; plan: Plan | null }
  | { status: 'unproposable'; reason: string; record: ProposalRecord }
  | { status: 'no_reading' };

/**
 * The earned autonomy shown to the proposer and used to compute the
 * capability catalogue it reasons over.
 *
 * The ramp mechanics of stage 2 do not exist yet — `RAMP_FLOOR` in
 * `orchestrator/ramp.ts` is `draft_only` for every action class until a
 * person raises it, and no production caller does. `runKnowReader`
 * (`src/sdk/know-reader.ts`) hardcodes the same value for the same reason;
 * see its own comment ("No ramp yet."). There is no `Plan` at this point in
 * the composition to derive a per-class ramp from — that only exists after
 * the proposal already does — so asking `loadRampLevel` anything here would
 * be guessing at a ceiling the charter itself is not yet prepared to grant.
 */
const NO_RAMP_YET: AutonomyLevel = 'draft_only';

export async function proposeForReading(
  input: ProposeForReadingInput,
  options: ProposeForReadingOptions = {},
): Promise<ProposeResult> {
  const businessId = options.businessId ?? config.businessId;
  const proposer = options.proposer ?? makeProposal;

  const job = await loadJob(input.jobId, {
    businessId,
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
  // A job id that does not resolve is not a property of the reading — it is
  // the same class of fault `readDocument` treats as a genuine error rather
  // than a status, per its own header.
  if (job === null) {
    throw new Error(`proposeForReading: no job ${input.jobId} for business ${businessId}`);
  }

  const reading = await loadLatestReading(input.documentId, job.provenance, {
    businessId,
    ...(options.db !== undefined ? { db: options.db } : {}),
  });
  if (reading === null || reading.content === null) {
    return { status: 'no_reading' };
  }

  const outcome = await proposer({
    bundle: input.bundle,
    reading: reading.content,
    provenance: job.provenance,
    rampLevel: NO_RAMP_YET,
  });

  const record = await saveProposal(
    {
      proposalId: `PRP-${ulid()}`,
      readingId: reading.readingId,
      status: outcome.status,
      reason: outcome.status === 'unproposable' ? outcome.reason : null,
      content: outcome.status === 'proposed' ? outcome.proposal : null,
      // The constant the proposer's own `Options` uses, imported rather
      // than repeated — see the comment on `PROPOSER_MODEL` in
      // `src/sdk/proposer.ts` for the incident this guards against.
      model: PROPOSER_MODEL,
      promptVersion: PROPOSAL_PROMPT_VERSION,
    },
    { businessId, ...(options.db !== undefined ? { db: options.db } : {}) },
  );

  if (outcome.status === 'unproposable') {
    return { status: 'unproposable', reason: outcome.reason, record };
  }

  // `proposal.headline` — the owner-facing line, not the action's — is what
  // the plan is *for*. The action's own headline is a separate value, already
  // carried into the step's `intent` by `proposalToPlan` itself.
  const plan = proposalToPlan(outcome.proposal, { goal: outcome.proposal.headline });

  return { status: 'proposed', proposal: outcome.proposal, record, plan };
}
