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
  'policy_denial',
  'phase_change',
  'memory_write',
  'incident',
  'charter_change',
  'kill_switch',
  'connection_binding',
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
