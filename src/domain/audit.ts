import { z } from 'zod';
import { ActionClass } from './action.js';
import { RiskAssessment } from './risk.js';
import { TrustLevel } from './trust.js';

export const AgentId = z.enum([
  'intake.triage',
  'comms.email',
  'comms.whatsapp',
  'sched.meetings',
  'know.reader',
  'know.memory',
  'know.digest',
  'ops.tasks',
  'ops.web',
  'ops.systems',
  'prod.docs',
  'prod.media',
  'gov.charter',
  'gov.risk',
  'gov.verify',
]);
export type AgentId = z.infer<typeof AgentId>;

export const Actor = z.union([
  AgentId,
  z.literal('orchestrator'),
  z.literal('human'),
  z.literal('system'),
]);
export type Actor = z.infer<typeof Actor>;

export const AuditKind = z.enum([
  /** Written BEFORE the call, so a crash mid-action is visible. */
  'intent_to_act',
  'tool_call',
  'tool_result',
  'decision',
  'approval',
  /**
   * The owner signed a document. Distinct from `approval` on purpose: someone
   * reading the trail must be able to tell "the owner permitted an action"
   * from "the owner accepted a document as binding".
   */
  'signature',
  'policy_denial',
  'phase_change',
  'memory_write',
  'incident',
  'charter_change',
  'kill_switch',
  'connection_binding',
  /**
   * The owner erased something. Carries counts and never what was erased —
   * a row naming the contact would make the audit log the one place the name
   * survives, which is exactly what the command asked to prevent (spec §5.3).
   */
  'erasure',
  /**
   * The assistant decided on her own what a finished job was worth
   * remembering. Carries counts only — how many candidates came back, how
   * many were written, how many were refused — never the subject or the
   * claim. This row is also what the daily cap counts, because it is the
   * only record that a billed call happened at all, including a call that
   * produced nothing.
   */
  'curation',
  /**
   * The owner moved the dial, or the measurement moved a class up or down.
   * Carries the class, both levels and the reason — never a recipient and
   * never message content: an autonomy change is a fact about the system's
   * own permissions, not about whoever the action was aimed at.
   */
  'autonomy_change',
  /**
   * The platform operator put, removed, or tested a secret through
   * `secret.ts` — the only door a credential ever enters or leaves through,
   * since the customer never touches it directly. Carries the business, the
   * ref and the operator — and never the value: this design concentrates
   * every customer's secrets in one operator's hands, and the only honest
   * counterweight is that each use of that power leaves a record nobody can
   * edit (`audit_log` is append-only at the database level, not by
   * convention).
   */
  'credential_change',
  /**
   * One agent asked another for help. Carries the pair, the intent, the hop
   * count and the envelope id — never the payload and never what the context
   * refs point at. A delegation is a fact about the system's own plumbing, and
   * a row naming the subject would make the audit log the one place that
   * subject survives.
   */
  'delegation',
]);
export type AuditKind = z.infer<typeof AuditKind>;

export const EvidenceRef = z.object({
  kind: z.enum(['artifact', 'doc', 'screenshot', 'message', 'episode']),
  uri: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  mime: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * One link in the append-only, hash-chained audit trail. Serves as both the
 * episodic memory (L2) and the compliance record.
 *
 * Properties that matter (docs/05-approvals.md):
 *   - intent is recorded *before* the call, so a crash mid-action is visible
 *   - the hash chain makes tampering detectable
 *   - every entry names the charter version, so "what were the rules when this
 *     happened?" is answerable
 */
export const AuditEntry = z.object({
  seq: z.bigint(),
  at: z.string().datetime(),
  jobId: z.string().nullable(),
  envelopeId: z.string().nullable(),
  actor: Actor,
  /** Set when a human decided; names the person the action was taken for. */
  onBehalfOf: z.string().nullable(),
  kind: AuditKind,
  actionClass: ActionClass.nullable(),
  charterVersion: z.string(),
  provenance: TrustLevel,
  risk: RiskAssessment.nullable(),
  inputHash: z.string(),
  outputHash: z.string().nullable(),
  artifacts: z.array(EvidenceRef),
  costMinor: z.number().int().nonnegative().nullable(),
  tokens: z
    .object({
      in: z.number().int().nonnegative(),
      out: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Free-form reason, always human-readable — this is what the dashboard shows. */
  reason: z.string(),
  prevHash: z.string(),
  /** sha256(prevHash || canonicalJson(entry without hash)) */
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** What a caller supplies; seq/prevHash/hash are assigned by the log itself. */
export const AuditEntryInput = AuditEntry.omit({
  seq: true,
  at: true,
  prevHash: true,
  hash: true,
}).partial({
  jobId: true,
  envelopeId: true,
  onBehalfOf: true,
  actionClass: true,
  risk: true,
  outputHash: true,
  artifacts: true,
  costMinor: true,
  tokens: true,
});
export type AuditEntryInput = z.infer<typeof AuditEntryInput>;

/** The chain's anchor. Genesis has no predecessor. */
export const GENESIS_HASH = '0'.repeat(64);
