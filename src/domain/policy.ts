import { z } from 'zod';
import { ActionClass } from './action.js';
import { AutonomyLevel, TrustLevel } from './trust.js';
import { AgentId } from './audit.js';
import { DataClass } from './charter.js';

/**
 * The canonical fact object a tool call is reduced to before any policy runs.
 *
 * Building facts first is what makes the gate deterministic: every predicate
 * reads the same normalised shape, so a rule can never accidentally depend on
 * the raw tool payload's structure.
 */
export const ActionFacts = z.object({
  toolName: z.string(),
  actionClass: ActionClass.nullable(),
  /** Money at stake, in minor units. Zero for non-monetary actions. */
  amountMinor: z.number().int().nonnegative(),
  /**
   * Did the payload actually carry a readable amount?
   *
   * Distinct from `amountMinor === 0`, which is also what an absent, misnamed
   * or nested amount produces. Without the distinction a purchase whose amount
   * arrived as `total` rather than `amountMinor` skipped every ceiling and
   * scored zero on the money dimension.
   */
  amountDeclared: z.boolean(),
  /** Resolved entity id of the other side, when there is one. */
  counterpartyId: z.string().nullable(),
  /**
   * Every address the payload would reach, normalised.
   *
   * A list, not one value. Reading only the first recipient meant a payload
   * with `to: ["ok@x.com", "blocked@y.com"]` — or a comma-joined string — had
   * its do-not-contact check run against one address and skipped for the rest,
   * and an array `to` produced no address at all.
   */
  counterpartyEmails: z.array(z.string()),
  counterpartyPhones: z.array(z.string()),
  /** Tags carried by the counterparty, used by narrowed forbidden rules. */
  counterpartyTags: z.array(z.string()),
  /** Trust of the least-trusted link in this job's causal chain. */
  provenance: TrustLevel,
  chainDepth: z.number().int().nonnegative(),
  dataClasses: z.array(DataClass),
  /** True when the payload would leave the instance (an outbound send). */
  leavesInstance: z.boolean(),
  /** Supplier id for purchase actions, matched against approvedSuppliers. */
  supplierId: z.string().nullable(),
  /** Discount percentage for discount.grant, else 0. */
  discountPercent: z.number().min(0).max(100),
  /** sha256 of the canonical tool input — the TOCTOU binding for approvals. */
  inputHash: z.string(),
});
export type ActionFacts = z.infer<typeof ActionFacts>;

/**
 * A compiled charter rule. The model never sees these — it sees the prose in
 * `promptFragments`. The hook evaluates these. When the two disagree, this wins.
 */
export const CompiledRule = z.object({
  id: z.string(),
  /** Human-readable, surfaced in the denial reason and the audit entry. */
  description: z.string(),
  kind: z.enum(['forbidden', 'ceiling', 'autonomy']),
  appliesTo: z.array(ActionClass),
  /** Optional narrowing by counterparty tag. */
  whenCounterpartyTag: z.string().nullable(),
});
export type CompiledRule = z.infer<typeof CompiledRule>;

export const CompiledCeilings = z.object({
  currency: z.string(),
  singleActionMinor: z.number().int().nonnegative(),
  dailyMinor: z.number().int().nonnegative(),
  monthlyMinor: z.number().int().nonnegative(),
  perActionClassMinor: z.partialRecord(ActionClass, z.number().int().nonnegative()),
  maxDiscountPercent: z.number().min(0).max(100),
  /** entityId -> auto-order ceiling. Absent means "not an approved supplier". */
  approvedSupplierCeilingMinor: z.record(z.string(), z.number().int().nonnegative()),
});
export type CompiledCeilings = z.infer<typeof CompiledCeilings>;

/**
 * The artefact the charter compiles into on signature. Split deliberately:
 *
 *   (a) `rules` / `ceilings` / `allowlists` — data the hook evaluates. The model
 *       cannot influence these.
 *   (b) `promptFragments` — prose injected into agent prompts. Behavioural
 *       guidance the model reasons with, and could in principle be talked out of.
 *   (c) `plainLanguage` — what the owner actually signed.
 *
 * That asymmetry is the whole safety story: every consequential decision is
 * checked twice, and the check the model cannot touch is the one that decides.
 */
export const PolicyBundle = z.object({
  charterVersion: z.string(),
  contentHash: z.string(),
  compiledAt: z.string().datetime(),

  rules: z.array(CompiledRule),
  ceilings: CompiledCeilings,
  /** Baseline autonomy per action class. */
  autonomyBase: z.record(ActionClass, AutonomyLevel),
  /** Hard cap by the provenance of the causal chain. */
  provenanceCeiling: z.record(TrustLevel, AutonomyLevel),
  /**
   * Per-counterparty autonomy overrides, split by the key that identifies them.
   *
   * Flattening these into one map keyed by any match string meant only the
   * `entityId` entries were ever looked up: the gate compares against
   * `facts.counterpartyId`, so an override written against an email domain,
   * a phone or a tag compiled, appeared in the signed charter, and could never
   * be found. Since an override can only tighten, a lost one is silently
   * *more* permissive. Same defect the do-not-contact list already had.
   */
  counterpartyAutonomy: z.object({
    byEntityId: z.record(z.string(), z.partialRecord(ActionClass, AutonomyLevel)),
    byEmailDomain: z.record(z.string(), z.partialRecord(ActionClass, AutonomyLevel)),
    byPhone: z.record(z.string(), z.partialRecord(ActionClass, AutonomyLevel)),
    byTag: z.record(z.string(), z.partialRecord(ActionClass, AutonomyLevel)),
  }),
  /**
   * Structured rather than a flat string list.
   *
   * The flat list was compared only against `facts.counterpartyId`, so a
   * counterparty matched by `emailDomain`, `phone` or `tag` compiled into an
   * entry that could never equal anything — the owner marked a domain
   * do-not-contact and the gate silently kept mailing it. Each key is now
   * matched against the fact that can actually carry it.
   */
  doNotContact: z.object({
    entityIds: z.array(z.string()),
    emailDomains: z.array(z.string()),
    phones: z.array(z.string()),
    tags: z.array(z.string()),
  }),

  /**
   * Hours during which nothing may be sent, in the business's own timezone.
   *
   * The owner signs a sentence promising this. Until the gate read it, the
   * sentence was the only place it existed.
   */
  quietHours: z
    .object({ from: z.string(), to: z.string(), timezone: z.string() })
    .nullable(),

  /**
   * Patterns stripped from a payload before it leaves the instance.
   *
   * Compiled from `charter.data.redactBeforeSending`, which had no caller: the
   * gate returned the raw input as `redactedInput`, so the field named a
   * protection that was never applied.
   */
  redactPatterns: z.array(z.string()),

  /**
   * Every counterparty the charter names, by whichever key identifies it.
   *
   * The risk layer treats an outbound message to a resolvable counterparty as
   * lower-risk than a first contact. That check has to consult the charter: if
   * it trusts the payload's own claim to name a counterparty, an agent working
   * from injected content can quiet its own risk score by inventing one.
   *
   * Split by key for the same reason as `doNotContact`. Flattened, the id the
   * payload supplies was compared against a list that also held tags and
   * domains — so `entityId: "vip"` matched a *tag* and bought the sender a
   * resolved-counterparty score it had not earned.
   */
  knownCounterparties: z.object({
    entityIds: z.array(z.string()),
    emailDomains: z.array(z.string()),
    phones: z.array(z.string()),
    tags: z.array(z.string()),
  }),

  allowlists: z.record(AgentId, z.array(z.string())),
  denylists: z.record(AgentId, z.array(z.string())),
  collaborationGraph: z.record(AgentId, z.array(AgentId)),

  promptFragments: z.record(AgentId, z.string()),
  plainLanguage: z.string(),
});
export type PolicyBundle = z.infer<typeof PolicyBundle>;

// ---------------------------------------------------------------------------
// The decision the gate returns.

export const PolicyDecision = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('allow'),
    /** Effective autonomy that permitted this, for the audit entry. */
    effectiveAutonomy: AutonomyLevel,
    /** Input after redaction; may differ from what the agent proposed. */
    redactedInput: z.unknown(),
  }),
  z.object({
    outcome: z.literal('deny'),
    /** Stable machine code, e.g. `forbidden:no_contract_signing`. */
    code: z.string(),
    /** One sentence for a human. */
    reason: z.string(),
  }),
  z.object({
    outcome: z.literal('queue_approval'),
    approvalId: z.string(),
    /** Always `queued_for_approval:<id>` — the run ends here, job goes dormant. */
    code: z.string(),
    reason: z.string(),
  }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const DENY_CODES = {
  killSwitch: 'kill_switch_active',
  stalePolicy: 'stale_policy',
  forbidden: 'forbidden',
  autonomyForbidden: 'autonomy_forbidden',
  draftOnly: 'draft_only:persist_as_draft',
  budgetExceeded: 'budget_exceeded',
  riskBlocked: 'risk_blocked',
  doNotContact: 'do_not_contact',
  quietHours: 'quiet_hours',
  amountUnreadable: 'amount_unreadable',
  recipientUnreadable: 'recipient_unreadable',
  notAllowlisted: 'tool_not_allowlisted',
} as const;
