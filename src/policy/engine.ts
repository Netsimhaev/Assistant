import { config } from '../config.js';
import { domainMatches, extractDomain } from '../util/address.js';
import { AMOUNT_REQUIRED_CLASSES, NEVER_FULLY_AUTONOMOUS } from '../domain/action.js';
import { coveredByAuthorization, loadAuthorization } from '../governance/authorization.js';
// `AgentId` is both a value (the zod enum, used below for `.safeParse`) and a
// type (`GateContext.agent`'s type) exported from the same declaration in
// `domain/audit.ts`. A single non-type-only import brings in both bindings —
// unlike the type-only import this replaces, which erased the value and left
// `AgentId.safeParse` uncallable under `verbatimModuleSyntax`.
import { AgentId } from '../domain/audit.js';
import type { ActionFacts, PolicyBundle, PolicyDecision } from '../domain/policy.js';
import { DENY_CODES } from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import type { RiskAssessment } from '../domain/risk.js';
import { mostRestrictiveAutonomy } from '../domain/trust.js';
import { appendAudit } from '../audit/log.js';
import { isToolPermitted } from '../charter/capabilities.js';
import { activeCharterVersion } from '../charter/store.js';
import { enqueueApproval, getApproval } from '../governance/approvals.js';
import { consumeApproval } from '../governance/consume.js';
import { checkKillSwitch } from '../governance/killswitch.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { getPool, type Queryable } from '../db/pool.js';
import { checkBudget } from './budget.js';
import { buildFacts, type FactsContext } from './facts.js';
import { isOutbound, isKnownTool } from './classify.js';
import { assessRisk, type NormsLookup } from './risk.js';
import { inQuietHours, redactPayload } from './redact.js';
import { mayDelegate } from '../governance/delegation.js';
import { APPROVED_REPLY_EXEMPTION_MARKER, approvedReplyCovers } from './approved-reply.js';
import { LEARNED_REPLY_EXEMPTION_MARKER, learnedReplyCovers } from './learned-reply.js';

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
  /** Injectable clock. The quiet-hours check is the only time-dependent step. */
  now?: Date;
  /**
   * An approval a human already granted for this step, and the step spending
   * it. One field, both required: the gate has no step of its own, and a
   * consumption recorded against no step defeats the audit trail the column
   * exists for. Supplying one without the other is not expressible.
   *
   * Supplied by the executor when it resumes a job that was parked on an
   * approval. Without it the gate recomputes `needsApproval` and queues a
   * second request, and the step never runs however many times it is approved.
   */
  approval?: { approvalId: string; stepId: string };
  /**
   * Whether to consult a standing authorisation for this job at all.
   *
   * Deliberately a boolean, not the row itself. `ctx.approval` proves
   * permission by re-proving an id against `approval_requests` inside a
   * guarded `UPDATE` — no caller can hand the gate a fabricated approval.
   * The first round of this feature took a whole `StandingAuthorization`
   * object by value instead, and review found the asymmetry: the
   * `jobId`/`businessId` equality check inside `coveredByAuthorization` was
   * comparing two fields the very same caller supplied, so forgery was only
   * documented against, not structurally impossible — a real risk once a
   * model-produced proposal is what shapes `GateContext`.
   *
   * The gate now loads the row itself with `loadAuthorization(ctx.jobId, {
   * businessId, db })` — the same `businessId` and `db` every other step in
   * this call already trusts — so a caller can only ask "does one apply",
   * never assert what it says. When it covers the call, `needsApproval` is
   * satisfied by it instead of by a fresh question (spec §6). It cannot
   * reach `NEVER_FULLY_AUTONOMOUS` or the charter's own `approve_required`
   * ceiling, and `coveredByAuthorization` refuses anything carrying money.
   */
  useStandingAuthorization?: boolean;
  /**
   * What the proposal said, in the owner's language.
   *
   * Fills the approval card's title and description, which today carry the
   * risk engine's own prose. The risk explanation is not replaced — it stays
   * in the card's risk row. A person needs both what is proposed and why the
   * system is uneasy; they are two facts, not one.
   */
  proposalText?: { headline: string; detail: string };
  /**
   * How to tell the owner a request is waiting, and where they can act on it.
   *
   * Absent by default — that is the state the system is in today, and
   * `enqueueApproval` already queues correctly without it. This gate is a
   * pure-ish policy function with no notion of email or a deployment's
   * externally-reachable address; both come from whichever caller actually
   * has them (an SMTP transport and the dashboard's origin are deployment
   * concerns, not policy ones), so they arrive here instead of every caller
   * being made to know how to send mail.
   */
  notify?: { notifier: ApprovalNotifier; dashboardBaseUrl: string };
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
 *   7. quiet hours      — outbound only; the action is early, not questionable
 *   8. autonomy         — the combined ceiling from five independent sources
 *   9. budget           — money ceilings, denied rather than escalated
 *  10. risk             — score, then band, then allow or queue for approval
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

  // Still stage 3, and deliberately here rather than in a stage of its own:
  // "whom may you ask" is a permission question, and this is the one place
  // that answers permission questions. The gate already reads payloads for
  // exactly this — stage 6 reads the recipient list to answer "whom may you
  // write to". Same question, different addressee space.
  //
  // `collaborationGraph` was compiled into the signed bundle from the first
  // migration and read by nobody until this line, which made the rule that
  // `ops.web` delegates to nobody signed and unenforced.
  //
  // This is still before stage 5, so a refusal here writes no audit row (see
  // the module docblock: "Intent is written to the audit log *before* the
  // call is permitted" — stage 5 onward). A refused delegation therefore
  // leaves no trace in the audit chain; the caller's own failure handling
  // (the `PolicyDecision` returned here) is the only record of it. Do not
  // move this check later to buy a row — its position, right after the
  // allowlist check and before any state is touched, is correct.
  if (toolName === 'agent.request_help') {
    const to = isRecord(toolInput) && Object.hasOwn(toolInput, 'to') ? toolInput['to'] : undefined;
    if (typeof to !== 'string' || !AgentId.safeParse(to).success) {
      return deny(
        DENY_CODES.delegationNotPermitted,
        'בקשת עזרה בלי נמען קריא — סוכן יעד שלא נפתר אינו נמען מותר',
      );
    }
    if (!mayDelegate(ctx.bundle.collaborationGraph, ctx.agent, to)) {
      return deny(
        DENY_CODES.delegationNotPermitted,
        `${ctx.agent} אינו רשאי לבקש עזרה מ-${to}`,
      );
    }
  }

  // 4. Read-only short-circuit --------------------------------------------
  const facts = buildFacts(toolName, toolInput, ctx);
  if (facts.actionClass === null) {
    // Three tools are in READ_ONLY_TOOLS *and* OUTBOUND_TOOLS —
    // `browser.navigate`, `media.generate_image`, `media.generate_video`. They
    // carry no action class, so the class-based steps below cannot judge them,
    // but they do leave the instance: skipping quiet hours and redaction for
    // them made a URL an unredacted egress channel.
    if (!outbound) {
      return { outcome: 'allow', effectiveAutonomy: 'auto', redactedInput: toolInput };
    }
    const window = ctx.bundle.quietHours;
    if (window !== null && inQuietHours(window, ctx.now ?? new Date())) {
      return deny(
        DENY_CODES.quietHours,
        `שעות שקט ${window.from}–${window.to} — הפעולה תתבצע אחרי ${window.to}`,
      );
    }
    return {
      outcome: 'allow',
      effectiveAutonomy: 'auto',
      redactedInput: redactPayload(toolInput, ctx.bundle),
    };
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

  // 7. Quiet hours ---------------------------------------------------------
  // Only outbound actions. Reading, drafting and writing to our own systems at
  // 03:00 is fine; it is the message arriving on someone's phone that the owner
  // promised would not happen.
  const quiet = ctx.bundle.quietHours;
  if (outbound && quiet !== null && inQuietHours(quiet, ctx.now ?? new Date())) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${DENY_CODES.quietHours}: ${quiet.from}-${quiet.to} ${quiet.timezone}`,
    });
    // A denial and not a queued approval: the action is not questionable, it is
    // merely early. The orchestrator reschedules it past the window rather than
    // asking anyone to approve it (docs/02-orchestrator.md, followup phase).
    return deny(
      DENY_CODES.quietHours,
      `שעות שקט ${quiet.from}–${quiet.to} — ההודעה תישלח אחרי ${quiet.to}`,
    );
  }

  // 8. Autonomy ------------------------------------------------------------
  // A reply the owner already approved, byte for byte, on this job and tool,
  // is judged without the ramp and provenance ceilings — and only those two.
  // See `approvedReplyCovers` for the conditions and for what it does not
  // bypass. `facts.inputHash` is the same hash stage 10 hands
  // `consumeApproval`, so the exemption and the claim agree on the bytes.
  const approvedReply = await approvedReplyCovers(facts, facts.toolName, facts.inputHash, ctx);
  // A reply to an incoming mail the assistant has LEARNED to send (owner
  // ruling H10): judged without the provenance ceiling — and only that one;
  // the ramp stays, and is `auto_notify` whenever this holds. See
  // `learnedReplyCovers`. Never alongside `approvedReply`: that one requires
  // `ctx.approval`, this one requires its absence, and the `!` says so here.
  const learnedReply =
    !approvedReply && (await learnedReplyCovers(facts, isRecord(toolInput) ? toolInput : {}, ctx));
  let effective = effectiveAutonomy(facts, ctx, {
    skipRampAndProvenance: approvedReply,
    skipProvenanceOnly: learnedReply,
  });

  const stage8Denial = await autonomyDenial(effective, facts, ctx, currentVersion, businessId);
  if (stage8Denial !== null) return stage8Denial;

  // 9. Budget --------------------------------------------------------------
  // An amount we could not read is not an amount of zero. Without this, a
  // purchase whose total arrived as `total` or `order.amountMinor` skipped
  // every ceiling and scored zero on the money dimension.
  if (AMOUNT_REQUIRED_CLASSES.has(facts.actionClass) && !facts.amountDeclared) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${DENY_CODES.amountUnreadable}: ${facts.actionClass}`,
    });
    return deny(
      DENY_CODES.amountUnreadable,
      `${facts.actionClass} חייב לשאת amountMinor — בלעדיו אי אפשר לאכוף תקרה`,
    );
  }

  const budget = await checkBudget(facts, ctx.bundle.ceilings, { businessId, db });
  if (!budget.permitted) {
    await recordIntent(facts, ctx, currentVersion, businessId, {
      kind: 'policy_denial',
      reason: `${budget.code} — ${budget.reason}`,
    });
    return deny(budget.code, budget.reason);
  }

  // 10. Risk ----------------------------------------------------------------
  const risk = await assessRisk(facts, ctx.bundle, ctx.norms ? { norms: ctx.norms } : {});

  // Intent to act is recorded here, before any decision to permit — so an
  // action that crashes between this point and execution leaves a trace.
  // A send the learned-reply exemption carried has no `approval_consumed`
  // row to mark, so the fixed token rides on the intent row instead — a
  // reader can find every reply that went out on what she learned alone.
  const intent = await recordIntent(facts, ctx, currentVersion, businessId, {
    kind: 'intent_to_act',
    reason: risk.explanation + (learnedReply ? ` ${LEARNED_REPLY_EXEMPTION_MARKER}` : ''),
    risk,
  });

  if (risk.band === 'blocked') {
    return deny(`${DENY_CODES.riskBlocked}:${risk.actionId}`, risk.explanation);
  }

  // Computed once and shared by both `allow` returns below (spending an
  // approval, and the normal unattended path). The two must return the same
  // payload for the same call — a spent approval that redacted a payload the
  // human approved unredacted would run a *different* action than the one
  // shown to them, and a normal allow that skipped redaction on an outbound
  // call would leak. One expression is what keeps those two returns from
  // drifting the way `approvalId`'s redaction and the plain allow's already
  // had.
  const permittedInput = outbound ? redactPayload(toolInput, ctx.bundle) : toolInput;

  // An approval a person already granted is spent here, before the gate asks
  // for another one. Placed after the `blocked` check on purpose: an approval
  // is permission to do something questionable, never permission to do
  // something the charter forbids outright.
  if (ctx.approval !== undefined) {
    const spent = await consumeApproval({
      approvalId: ctx.approval.approvalId,
      // An approval always belongs to a job. A context carrying an approval
      // id and no job id cannot match any row, so it falls through and queues
      // a fresh request — which is the safe direction for a malformed call.
      jobId: ctx.jobId ?? '',
      stepId: ctx.approval.stepId,
      // The tool the gate is judging, not one the caller named separately:
      // an approval is permission for a specific action, and the tool is
      // half of what makes it specific.
      toolName: facts.toolName,
      liveInputHash: facts.inputHash,
      businessId,
      ...(ctx.db ? { db: ctx.db } : {}),
    });

    if (spent.ok) {
      await appendAudit(
        {
          actor: ctx.agent,
          kind: 'approval',
          jobId: ctx.jobId ?? null,
          envelopeId: ctx.envelopeId ?? null,
          actionClass: facts.actionClass,
          charterVersion: currentVersion,
          provenance: facts.provenance,
          inputHash: facts.inputHash,
          risk,
          // The exemption is otherwise invisible in the trail: the row would
          // read exactly like an approval spent on a ceiling that let it
          // through anyway. A fixed token, so a reader can find every send
          // that ran on the owner's "yes" alone.
          reason:
            `approval_consumed:${ctx.approval.approvalId} (intent seq ${intent.seq})` +
            (approvedReply ? ` ${APPROVED_REPLY_EXEMPTION_MARKER}` : ''),
        },
        { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
      );

      return {
        outcome: 'allow',
        effectiveAutonomy: effective,
        redactedInput: permittedInput,
      };
    }
    // Every failure code falls through to the normal path, which queues a
    // fresh request. That is the correct answer to all of them: the human
    // approved something, and it was not this.
    //
    // Except that the normal path must not run on a ceiling the exemption
    // relaxed. `approvedReplyCovers` is a read; between it and the claim
    // above another runner can spend the same approval. Carrying on with the
    // relaxed `effective` would then let a routine-band reply through
    // UNATTENDED — a second send of an approval that was used once. So the
    // stage-8 verdict is recomputed with every ceiling, exactly as if the
    // exemption had never applied.
    if (approvedReply) {
      effective = effectiveAutonomy(facts, ctx);
      const lostClaim = await autonomyDenial(effective, facts, ctx, currentVersion, businessId);
      if (lostClaim !== null) return lostClaim;
    }
  }

  // An instruction the owner already gave for this job, if it covers this
  // call. Loaded here, by id, rather than trusted from `ctx` — see
  // `useStandingAuthorization`'s docblock for why a whole row handed over by
  // value was the finding. Sourced from the executing job's own id and the
  // gate's resolved business — never from `toolInput`, which the payload's
  // author could shape. Without an executing job there is nothing for the
  // authorisation to belong to, so it cannot apply
  // (`coveredByAuthorization` itself checks `jobId`/`businessId` again, as a
  // second line of defence against a mismatch this loader cannot produce but
  // a future caller of `coveredByAuthorization` elsewhere might).
  const standingAuth =
    ctx.useStandingAuthorization === true && ctx.jobId != null
      ? await loadAuthorization(ctx.jobId, { businessId, db })
      : null;

  const standing =
    ctx.jobId != null &&
    coveredByAuthorization(standingAuth, {
      jobId: ctx.jobId,
      businessId,
      actionClass: facts.actionClass,
      input: isRecord(toolInput) ? toolInput : {},
      amountDeclared: facts.amountDeclared,
      amountMinor: facts.amountMinor,
    });

  const needsApproval =
    // Absolute, and standing authorisation cannot reach it. A class that is
    // never fully autonomous is never fully autonomous.
    NEVER_FULLY_AUTONOMOUS.has(facts.actionClass) ||
    // The charter ceiling the owner signed, and any hard cap an envelope
    // carried, stand outside `standing`'s reach too — controller ruling
    // (fix round 1, F1). An instruction is momentary; a signed ceiling is a
    // durable, deliberate statement, and every prior relaxation in this
    // codebase — the first-contact exemption chief among them — stops short
    // of it. Standing authorisation removes only the risk-band escalation
    // below, exactly the scope that exemption has.
    effective === 'approve_required' ||
    (!standing && risk.band !== 'routine');

  if (needsApproval) {
    const approvalId = await enqueueApproval(
      {
        jobId: ctx.jobId ?? null,
        envelopeId: ctx.envelopeId ?? null,
        facts,
        risk,
        proposedInput: toolInput,
        summary: proposalHeadline(ctx.proposalText) ?? risk.explanation,
        detail: proposalDetail(ctx.proposalText) ?? defaultApprovalDetail(facts, risk),
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

    if (ctx.notify) {
      const { notifier, dashboardBaseUrl } = ctx.notify;
      const approvalLink = (id: string): string => `${dashboardBaseUrl}/a/${id}`;
      // Delivery failing is not the request failing. The row exists, the screen
      // shows it, and the scheduler will expire it on schedule either way. An
      // approval that vanished because an SMTP server was down would be far worse
      // than one nobody was emailed about.
      try {
        const request = await getApproval(approvalId, { businessId, db });
        if (request === null) {
          throw new Error('approval vanished immediately after being queued');
        }
        const delivered = await notifier.notify(request, approvalLink(approvalId));
        if (!delivered.ok) throw new Error(delivered.error ?? 'notify returned not-ok');
      } catch (error) {
        await appendAudit(
          {
            actor: 'system',
            kind: 'incident',
            jobId: ctx.jobId ?? null,
            actionClass: facts.actionClass,
            charterVersion: currentVersion,
            provenance: facts.provenance,
            inputHash: facts.inputHash,
            reason:
              `approval_notify_failed:${approvalId} via ${notifier.channel} — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          },
          { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
        );
      }
    }

    return {
      outcome: 'queue_approval',
      approvalId,
      code: `queued_for_approval:${approvalId}`,
      reason: risk.explanation,
    };
  }

  // The standing authorisation was consulted and covered this call — the
  // approval path leaves `approval_consumed:<id>` for the same reason.
  // Without this row a `sensitive`-band send that ran unattended is
  // indistinguishable in the trail from a routine one that never needed
  // asking; reconstructing why something was permitted is the one thing the
  // trail exists for.
  //
  // Deliberately not narrowed to `risk.band !== 'routine'`, which is the only
  // case where the authorisation is what *changed* the outcome. The row is
  // written whenever it applied, and says only that — "covered", not "and
  // therefore permitted". A row that appears only when it was decisive would
  // make its absence ambiguous between "no authorisation" and "one that did
  // not need to matter", and the trail is read to reconstruct what the gate
  // consulted, not only what tipped it.
  if (standing) {
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
        reason: `standing_authorization:${ctx.jobId} (intent seq ${intent.seq})`,
      },
      { businessId, ...(ctx.db ? { tx: ctx.db } : {}) },
    );
  }

  return {
    outcome: 'allow',
    effectiveAutonomy: effective,
    // Redaction happens here and not in the agent, because the agent is the
    // component we are least able to trust to have done it. Shared with the
    // approval-consumption return above via `permittedInput` — see its
    // comment for why that sharing is the point.
    redactedInput: permittedInput,
  };
}

/**
 * Match a do-not-contact entry against every key that can identify the other
 * side, and return the one that matched so the denial can name it.
 *
 * Four keys, checked independently: an entry is a block if *any* of them
 * matches. The email match is on the domain, which is the point of the key —
 * "never contact anyone at this company" is a sentence an owner writes, and
 * it means the whole company, not one hostname: `extractDomain` and
 * `domainMatches` (`src/util/address.ts`) normalise the address's domain and
 * match it against the charter entry or any subdomain of it, so
 * `dana@mail.rival.co.il` is blocked by a `rival.co.il` entry exactly as
 * `dana@rival.co.il` is.
 */
function matchDoNotContact(
  facts: ActionFacts,
  list: PolicyBundle['doNotContact'],
): string | null {
  if (facts.counterpartyId !== null && list.entityIds.includes(facts.counterpartyId)) {
    return facts.counterpartyId;
  }
  for (const email of facts.counterpartyEmails) {
    const domain = extractDomain(email);
    if (domain !== null && list.emailDomains.some((blocked) => domainMatches(domain, blocked))) {
      return domain;
    }
  }
  const phone = facts.counterpartyPhones.find((p) => list.phones.includes(p));
  if (phone !== undefined) return phone;
  const tag = facts.counterpartyTags.find((t) => list.tags.includes(t));
  return tag ?? null;
}

/**
 * Stage 8's two refusals, shared by the stage itself and by the lost-claim
 * fallback in stage 10, so the two can never word or audit them differently.
 * Returns `null` when the level permits the action to continue.
 */
async function autonomyDenial(
  effective: AutonomyLevel,
  facts: ActionFacts,
  ctx: GateContext,
  currentVersion: string,
  businessId: string,
): Promise<PolicyDecision | null> {
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

  return null;
}

/**
 * Combine every ceiling that applies. Five independent sources, all able to
 * tighten and none able to loosen — that is what makes them ceilings.
 *
 * `skipRampAndProvenance` drops exactly two of the five, and is set only by
 * stage 8 when `approvedReplyCovers` holds: an owner who approved these exact
 * bytes has answered, for this one call, the question both of those ceilings
 * exist to ask ("has a person looked at what an untrusted chain wants to
 * send?"). The other three are not that question and stay: the signed
 * charter's base for the class, every counterparty override, and an
 * envelope's hard cap. Named as the two it omits, never as "everything except"
 * — a control written as a negation is how this file has lost ceilings before.
 *
 * `skipProvenanceOnly` drops exactly ONE of the five — the provenance
 * ceiling — and is set only by stage 8 when `learnedReplyCovers` holds. The
 * ramp is NOT dropped: it is the very ceiling that says the class was
 * learned (`auto_notify` under `learn`), and the moment a demotion or the
 * dial lowers it, the learned reply stops on it.
 */
function effectiveAutonomy(
  facts: ActionFacts,
  ctx: GateContext,
  options: { skipRampAndProvenance?: boolean; skipProvenanceOnly?: boolean } = {},
): AutonomyLevel {
  const actionClass = facts.actionClass;
  if (actionClass === null) return 'auto';
  const skip = options.skipRampAndProvenance === true;
  const skipProvenance = skip || options.skipProvenanceOnly === true;

  const ceilings: AutonomyLevel[] = [ctx.bundle.autonomyBase[actionClass]];
  if (!skipProvenance) ceilings.push(ctx.bundle.provenanceCeiling[facts.provenance]);

  // Every key that identifies the other side, each against its own bucket.
  // Keyed by entityId alone, an override written against a domain, a phone or
  // a tag was compiled and never found — and since an override can only
  // tighten, losing one is silently more permissive.
  const overrides = ctx.bundle.counterpartyAutonomy;
  const candidates: (AutonomyLevel | undefined)[] = [
    facts.counterpartyId === null
      ? undefined
      : overrides.byEntityId[facts.counterpartyId]?.[actionClass],
    // A direct property lookup (`byEmailDomain[domain]`) only ever matched
    // the exact domain an owner wrote, so an override tightening every
    // `rival.co.il` counterparty silently missed `mail.rival.co.il`. Every
    // registered pattern the domain matches or is a subdomain of applies —
    // never just the first one found — because this only ever tightens the
    // ceiling, and dropping a stricter override that also matched would be
    // the same silent-loosening bug this whole function exists to avoid.
    ...facts.counterpartyEmails.flatMap((email) => {
      const domain = extractDomain(email);
      if (domain === null) return [];
      return Object.keys(overrides.byEmailDomain)
        .filter((pattern) => domainMatches(domain, pattern))
        .map((pattern) => overrides.byEmailDomain[pattern]?.[actionClass]);
    }),
    ...facts.counterpartyPhones.map((p) => overrides.byPhone[p]?.[actionClass]),
    ...facts.counterpartyTags.map((tag) => overrides.byTag[tag]?.[actionClass]),
  ];
  for (const override of candidates) {
    if (override !== undefined) ceilings.push(override);
  }
  if (!skip && ctx.rampLevel !== undefined) ceilings.push(ctx.rampLevel);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `summary`/`detail` are `TEXT NOT NULL` with no bound in `approval_requests`,
// and this text is model-generated. The dashboard already size-limits
// owner-supplied text (`MAX_BODY_BYTES`, `src/dashboard/server.ts`); text
// arriving from the other direction deserves the same discipline.
const MAX_PROPOSAL_HEADLINE_LENGTH = 200;
const MAX_PROPOSAL_DETAIL_LENGTH = 2000;

/**
 * A caller-supplied proposal field counts as present only when it is a
 * non-empty string after trimming — the `refineActionClass` rule (CLAUDE.md):
 * a field that merely "normalises to something" is not the same as one that
 * was actually written. `??` alone let `{ headline: '', detail: '' }` through
 * and rendered an approval card with a blank title (fix round 1, F4).
 */
function proposalHeadline(proposalText: GateContext['proposalText']): string | undefined {
  const headline = proposalText?.headline;
  if (headline === undefined || headline.trim().length === 0) return undefined;
  return headline.slice(0, MAX_PROPOSAL_HEADLINE_LENGTH);
}

function proposalDetail(proposalText: GateContext['proposalText']): string | undefined {
  const detail = proposalText?.detail;
  if (detail === undefined || detail.trim().length === 0) return undefined;
  return detail.slice(0, MAX_PROPOSAL_DETAIL_LENGTH);
}

function defaultApprovalDetail(facts: ActionFacts, risk: RiskAssessment): string {
  return `${facts.toolName} · ${facts.actionClass} · רצועה ${risk.band}`;
}
