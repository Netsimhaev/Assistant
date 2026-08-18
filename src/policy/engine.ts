import { config } from '../config.js';
import { NEVER_FULLY_AUTONOMOUS } from '../domain/action.js';
import type { AgentId } from '../domain/audit.js';
import type { ActionFacts, PolicyBundle, PolicyDecision } from '../domain/policy.js';
import { DENY_CODES } from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import type { RiskAssessment } from '../domain/risk.js';
import { mostRestrictiveAutonomy } from '../domain/trust.js';
import { appendAudit } from '../audit/log.js';
import { isToolPermitted } from '../charter/capabilities.js';
import { activeCharterVersion } from '../charter/store.js';
import { enqueueApproval } from '../governance/approvals.js';
import { checkKillSwitch } from '../governance/killswitch.js';
import { getPool, type Queryable } from '../db/pool.js';
import { checkBudget } from './budget.js';
import { buildFacts, type FactsContext } from './facts.js';
import { isOutbound, isKnownTool } from './classify.js';
import { assessRisk, type NormsLookup } from './risk.js';

export interface GateContext extends FactsContext {
  agent: AgentId;
  bundle: PolicyBundle;
  jobId?: string | null;
  envelopeId?: string | null;
  /** Hard cap carried by the envelope; can only tighten the result. */
  autonomyCeiling?: AutonomyLevel;
  /** Earned autonomy for this action class, from the ramp. */
  rampLevel?: AutonomyLevel;
  businessId?: string;
  db?: Queryable;
  norms?: NormsLookup;
}

/**
 * The authoritative gate. Every tool call, without exception, passes through
 * this function before it executes.
 *
 * Order matters and is not arbitrary — each step is cheaper and more absolute
 * than the next, so the most categorical denials happen before any work:
 *
 *   1. kill switch      — a stop must stop everything, immediately
 *   2. stale policy     — never act on rules that are no longer current
 *   3. capability       — the tool isn't in this agent's allowlist at all
 *   4. read-only        — nothing side-effecting, short-circuit to allow
 *   5. hard prohibition — charter `forbidden`, not overridable by anyone
 *   6. do-not-contact   — an absolute per-counterparty block
 *   7. autonomy         — the combined ceiling from five independent sources
 *   8. budget           — money ceilings, denied rather than escalated
 *   9. risk             — score, then band, then allow or queue for approval
 *
 * Intent is written to the audit log *before* the call is permitted, so a crash
 * between decision and execution is visible rather than silent.
 */
export async function evaluateToolCall(
  toolName: string,
  toolInput: unknown,
  ctx: GateContext,
): Promise<PolicyDecision> {
  const businessId = ctx.businessId ?? config.businessId;
  const db = ctx.db ?? getPool();
  const outbound = isOutbound(toolName);

  // 1. Kill switch ---------------------------------------------------------
  const kill = await checkKillSwitch(ctx.agent, outbound, { businessId, db });
  if (kill.blocked) {
    return deny(
      DENY_CODES.killSwitch,
      `עצירת חירום פעילה בהיקף "${kill.scope}": ${kill.reason}`,
    );
  }

  // 2. Stale policy --------------------------------------------------------
  const currentVersion = await activeCharterVersion(businessId, db);
  if (currentVersion === null) {
    return deny(
      DENY_CODES.stalePolicy,
      'אין תקנון פעיל — סוכן לא רשאי לפעול בלי מדיניות',
    );
  }
  if (currentVersion !== ctx.bundle.charterVersion) {
    return deny(
      DENY_CODES.stalePolicy,
      `הריצה מחזיקה תקנון ${ctx.bundle.charterVersion} אך הפעיל הוא ${currentVersion}`,
    );
  }

  // 3. Capability ----------------------------------------------------------
  if (!isKnownTool(toolName)) {
    return deny(
      DENY_CODES.notAllowlisted,
      `הכלי "${toolName}" אינו מוכר למנוע המדיניות; כלי לא מסווג אינו מבוצע`,
    );
  }
  if (!isToolPermitted(ctx.agent, toolName)) {
    return deny(
      DENY_CODES.notAllowlisted,
      `הכלי "${toolName}" אינו ברשימת ההרשאות של ${ctx.agent}`,
    );
  }

  // 4. Read-only short-circuit --------------------------------------------
  const facts = buildFacts(toolName, toolInput, ctx);
  if (facts.actionClass === null) {
    return { outcome: 'allow', effectiveAutonomy: 'auto', redactedInput: toolInput };
  }

  // 5. Hard prohibitions ---------------------------------------------------
  const forbidden = ctx.bundle.rules.find(
    (rule) =>
      rule.kind === 'forbidden' &&
      rule.appliesTo.includes(facts.actionClass!) &&
      (rule.whenCounterpartyTag === null ||
        facts.counterpartyTags.includes(rule.whenCounterpartyTag)),
  );
  if (forbidden) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${forbidden.id} — ${forbidden.description}`,
    });
    // `forbidden.id` already carries its namespace: the compiler prefixes every
    // rule id with its kind (`forbidden:`, `ceiling:`, `autonomy:`) so a ceiling
    // and an autonomy rule for the same action class stay distinct. Prefixing
    // again here produced `forbidden:forbidden:<id>`.
    return deny(forbidden.id, forbidden.description);
  }

  // 6. Do-not-contact ------------------------------------------------------
  const blocked = matchDoNotContact(facts, ctx.bundle.doNotContact);
  if (blocked !== null) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${DENY_CODES.doNotContact}: ${blocked}`,
    });
    return deny(DENY_CODES.doNotContact, `${blocked} מסומן כ-doNotContact`);
  }

  // 7. Autonomy ------------------------------------------------------------
  const effective = effectiveAutonomy(facts, ctx);

  if (effective === 'forbidden') {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${DENY_CODES.autonomyForbidden}: ${facts.actionClass}`,
    });
    return deny(
      DENY_CODES.autonomyForbidden,
      `${facts.actionClass} אסור לחלוטין בהגדרות הנוכחיות`,
    );
  }

  if (effective === 'draft_only') {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${DENY_CODES.draftOnly}: ${facts.actionClass}`,
    });
    return deny(
      DENY_CODES.draftOnly,
      `${facts.actionClass} במצב טיוטה בלבד — נשמר לאישור ידני`,
    );
  }

  // 8. Budget --------------------------------------------------------------
  const budget = await checkBudget(facts, ctx.bundle.ceilings, { businessId, db });
  if (!budget.permitted) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${budget.code} — ${budget.reason}`,
    });
    return deny(budget.code, budget.reason);
  }

  // 9. Risk ----------------------------------------------------------------
  const risk = await assessRisk(facts, ctx.bundle, ctx.norms ? { norms: ctx.norms } : {});

  // Intent to act is recorded here, before any decision to permit — so an
  // action that crashes between this point and execution leaves a trace.
  const intent = await recordIntent(facts, ctx, currentVersion, businessId, {
    kind: 'intent_to_act',
    reason: risk.explanation,
    risk,
  });

  if (risk.band === 'blocked') {
    return deny(`${DENY_CODES.riskBlocked}:${risk.actionId}`, risk.explanation);
  }

  const needsApproval =
    effective === 'approve_required' ||
    risk.band !== 'routine' ||
    NEVER_FULLY_AUTONOMOUS.has(facts.actionClass);

  if (needsApproval) {
    const approvalId = await enqueueApproval(
      {
        jobId: ctx.jobId ?? null,
        envelopeId: ctx.envelopeId ?? null,
        facts,
        risk,
        proposedInput: toolInput,
        summary: risk.explanation,
        detail: `${facts.toolName} · ${facts.actionClass} · רצועה ${risk.band}`,
      },
      { businessId, db },
    );

    await appendAudit(
      {
        actor: ctx.agent,
        kind: 'decision',
        jobId: ctx.jobId ?? null,
        envelopeId: ctx.envelopeId ?? null,
        actionClass: facts.actionClass,
        charterVersion: currentVersion,
        provenance: facts.provenance,
        inputHash: facts.inputHash,
        risk,
        reason: `queued_for_approval:${approvalId} (intent seq ${intent.seq})`,
      },
      { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
    );

    return {
      outcome: 'queue_approval',
      approvalId,
      code: `queued_for_approval:${approvalId}`,
      reason: risk.explanation,
    };
  }

  return {
    outcome: 'allow',
    effectiveAutonomy: effective,
    redactedInput: toolInput,
  };
}

/**
 * Match a do-not-contact entry against every key that can identify the other
 * side, and return the one that matched so the denial can name it.
 *
 * Four keys, checked independently: an entry is a block if *any* of them
 * matches. The email match is on the domain, which is the point of the key —
 * "never contact anyone at this company" is a sentence an owner writes.
 */
function matchDoNotContact(
  facts: ActionFacts,
  list: PolicyBundle['doNotContact'],
): string | null {
  if (facts.counterpartyId !== null && list.entityIds.includes(facts.counterpartyId)) {
    return facts.counterpartyId;
  }
  if (facts.counterpartyEmail !== null) {
    const domain = facts.counterpartyEmail.split('@')[1];
    if (domain !== undefined && list.emailDomains.includes(domain)) return domain;
  }
  if (facts.counterpartyPhone !== null && list.phones.includes(facts.counterpartyPhone)) {
    return facts.counterpartyPhone;
  }
  const tag = facts.counterpartyTags.find((t) => list.tags.includes(t));
  return tag ?? null;
}

/**
 * Combine every ceiling that applies. Five independent sources, all able to
 * tighten and none able to loosen — that is what makes them ceilings.
 */
function effectiveAutonomy(facts: ActionFacts, ctx: GateContext): AutonomyLevel {
  const actionClass = facts.actionClass;
  if (actionClass === null) return 'auto';

  const ceilings: AutonomyLevel[] = [
    ctx.bundle.autonomyBase[actionClass],
    ctx.bundle.provenanceCeiling[facts.provenance],
  ];

  if (facts.counterpartyId !== null) {
    const override = ctx.bundle.counterpartyAutonomy[facts.counterpartyId]?.[actionClass];
    if (override !== undefined) ceilings.push(override);
  }
  if (ctx.rampLevel !== undefined) ceilings.push(ctx.rampLevel);
  if (ctx.autonomyCeiling !== undefined) ceilings.push(ctx.autonomyCeiling);

  return mostRestrictiveAutonomy(ceilings);
}

async function recordIntent(
  facts: ActionFacts,
  ctx: GateContext,
  charterVersion: string,
  businessId: string,
  entry: {
    kind: 'intent_to_act' | 'policy_denial';
    reason: string;
    risk?: RiskAssessment;
  },
) {
  // Join the caller's transaction when there is one. `checkBudget` and
  // `enqueueApproval` already used `ctx.db`; the audit writes did not, so a
  // caller-supplied transaction produced an approval row and an audit entry
  // citing it on two different connections — the approval could commit while
  // its own justification rolled back.
  //
  // Passed only when the caller actually supplied a handle. The audit chain
  // serialises on `pg_advisory_xact_lock`, which is transaction-scoped: handing
  // it the bare pool would take and drop the lock inside one statement and
  // silently remove the serialisation that keeps the chain from forking.
  return appendAudit(
    {
      actor: ctx.agent,
      kind: entry.kind,
      jobId: ctx.jobId ?? null,
      envelopeId: ctx.envelopeId ?? null,
      actionClass: facts.actionClass,
      charterVersion,
      provenance: facts.provenance,
      inputHash: facts.inputHash,
      risk: entry.risk ?? null,
      reason: entry.reason,
    },
    { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
  );
}

function deny(code: string, reason: string): PolicyDecision {
  return { outcome: 'deny', code, reason };
}
