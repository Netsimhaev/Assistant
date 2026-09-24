/**
 * The typed object that travels between agents (docs/03-protocol.md §1).
 *
 * **`contextRefs` carries pointers and never text, and that is the control —
 * not an efficiency choice.** If one agent could plant raw text from a hostile
 * document into the payload that reaches another, delegation itself would
 * become the injection path: the text arrives inside an agent the system
 * trusts, stripped of the provenance label that travels with it everywhere
 * else. With pointers, the receiver resolves for itself, and everything it
 * pulls arrives with its own trust level attached — the same rule the planner
 * already follows ("never the raw message") and the memory already follows
 * (provenance on every row).
 */
import { z } from 'zod';
import { AgentId } from './audit.js';
import { SafeLookupKey } from './charter.js';
import { AutonomyLevel, TrustLevel } from './trust.js';

/**
 * Hard ceiling on delegation depth. One exported constant, read by both the
 * schema below and the guard in `governance/delegation.ts` — two places each
 * naming 6 are two places that drift.
 */
export const MAX_HOPS = 6;

/**
 * Only the two kinds this work actually produces.
 *
 * `assign`, `verify_request`, `verdict` and `escalate` appear in
 * docs/03-protocol.md and are deliberately absent until something emits them.
 * A member with no producer is the dead-branch defect this codebase has
 * already paid for with dead action classes.
 */
export const EnvelopeKind = z.enum(['help_request', 'result']);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

/**
 * How a delegation ended, as `resumeDelegatedJobs`
 * (`orchestrator/resume-delegated.ts`) decides it — the child reached
 * `closed` (`succeeded`), reached `failed` or `halted` (`failed`), or never
 * reached a terminal phase before the envelope's own deadline ran out
 * (`timeout`).
 */
export const DelegationOutcome = z.enum(['succeeded', 'failed', 'timeout']);
export type DelegationOutcome = z.infer<typeof DelegationOutcome>;

/**
 * The payload of a `kind: 'result'` envelope — the ONE shape
 * `resumeDelegatedJobs` ever writes and `agent.request_help`'s handler
 * (`orchestrator/local-tools.ts`) ever reads back.
 *
 * Shared rather than restated at each end on purpose: `AgentEnvelope.payload`
 * is `z.unknown()` by design (an envelope's payload shape is the receiving
 * intent's business, per `intent-registry.ts`), so nothing enforces this
 * shape for a `result` envelope except both ends agreeing on it — and a
 * schema defined once and imported twice is the only way "agreeing" means
 * anything. A hand-rolled narrowing at the read site (a `typeof` check with
 * an `'unknown'` fallback) let a `result` payload that failed to parse — a
 * missing, non-string, or out-of-enum `outcome` — complete the step as
 * `done` anyway, which is exactly the "value we could not read treated as a
 * permitting one" shape this project refuses everywhere else
 * (`amount_unreadable`, an unknown data class scored most severe, an unknown
 * calendar action becoming `calendar.cancel`). The reader now parses this
 * schema and treats a failure to parse as a corrupted state, not a
 * completion.
 */
export const ResultEnvelopePayload = z.object({
  outcome: DelegationOutcome,
  note: z.string(),
});
export type ResultEnvelopePayload = z.infer<typeof ResultEnvelopePayload>;

/**
 * A pointer the receiver resolves itself. **No branch carries free text** —
 * an invariant test asserts that, because the next person to add a branch
 * will reach for a convenient `content: string`.
 */
export const ContextRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: SafeLookupKey }),
  z.object({ kind: z.literal('reading'), readingId: SafeLookupKey }),
  z.object({ kind: z.literal('memory'), memoryId: SafeLookupKey }),
  z.object({ kind: z.literal('job'), jobId: SafeLookupKey }),
]);
export type ContextRef = z.infer<typeof ContextRef>;

export const EnvelopeConstraints = z.object({
  charterVersion: z.string().min(1),
  provenanceCeiling: TrustLevel,
  autonomyCeiling: AutonomyLevel,
  /** `null` means "no ceiling of my own", never "no ceiling applies". */
  moneyCeilingMinor: z.number().int().nonnegative().nullable(),
  deadlineAt: z.string().datetime(),
});
export type EnvelopeConstraints = z.infer<typeof EnvelopeConstraints>;

export const AgentEnvelope = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  /**
   * The root job of the whole tree. For a job with no parent this is the job's
   * own id — without that rule the first envelope in a tree would have nothing
   * to write here, and the no-new-information guard would compare against an
   * empty field.
   */
  correlationId: z.string().min(1),
  /** Envelope ids, root first. */
  causalChain: z.array(z.string().min(1)),
  from: z.union([AgentId, z.literal('orchestrator')]),
  to: AgentId,
  kind: EnvelopeKind,
  intent: z.string().min(1),
  payload: z.unknown(),
  contextRefs: z.array(ContextRef),
  constraints: EnvelopeConstraints,
  /**
   * The guard refuses before a seventh envelope is built, so this `max` should
   * never fire. It is here as a second layer, exactly as an approval's expiry
   * is checked both in the lookup and again in the claim's `WHERE`.
   */
  hops: z.number().int().min(0).max(MAX_HOPS),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;
