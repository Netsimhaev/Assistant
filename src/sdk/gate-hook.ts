import type {
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import type { Queryable } from '../db/pool.js';
import { evaluateToolCall } from '../policy/engine.js';
import { isPathWithin, readPathArgument, translateToolName } from './tool-names.js';

export interface GateHookBinding {
  agent: AgentId;
  bundle: PolicyBundle;
  /** Lowest trust in this job's causal chain, stamped by the caller. */
  provenance: TrustLevel;
  chainDepth?: number;
  /**
   * Tags of the resolved counterparty. Required so a caller with no resolver
   * has to write `[]` deliberately — every tag-narrowed charter rule and the
   * whole doNotContact-by-tag bucket read this, and while it was optional it
   * was permanently empty and they were all dead.
   */
  counterpartyTags: string[];
  /**
   * Earned autonomy for this action class, from the ramp.
   *
   * Required, and there is no ramp yet, so callers pass `draft_only`. The risk
   * engine's null NormsLookup is documented as safe *because* the ramp holds
   * everything at draft_only — the two are load-bearing together, and leaving
   * this optional meant only one of the pair was actually present.
   */
  rampLevel: AutonomyLevel;
  businessId?: string;
  jobId?: string | null;
  envelopeId?: string | null;
  autonomyCeiling?: AutonomyLevel;
  db?: Queryable;
  /**
   * Called for every decision, allow or deny.
   *
   * The SDK gives a denial back to the model as text and nothing else, so
   * without this the caller cannot tell "the reader found nothing" apart from
   * "the gate stopped it four times". The audit log has the truth, but a
   * caller should not have to query Postgres to learn what happened in its own
   * run.
   */
  onDecision?: (event: { tool: string; decision: 'allow' | 'deny'; code: string }) => void;
  /**
   * Root a filesystem read may not escape.
   *
   * Required, because `doc.fetch` is read-only and therefore short-circuits the
   * gate at step 4 without risk scoring, without an audit row, and without the
   * outbound controls. This check is the only thing between an agent reading
   * an attacker's document and that document telling it to read `.env`.
   */
  documentRoot: string;
  /** Injectable clock, for the quiet-hours step. Real time when omitted. */
  now?: Date;
}

/**
 * The wire between the Agent SDK and the policy gate.
 *
 * This is the piece that was missing: `evaluateToolCall` had no caller outside
 * the test suite, so every property the gate enforces was, in production terms,
 * theoretical. A `PreToolUse` hook is the right seam because the SDK runs it
 * *before* the tool executes and honours a `deny` — which is the same shape the
 * architecture already assumed (docs/04-charter.md).
 *
 * Three decisions map onto two SDK outcomes:
 *
 *   allow          → permissionDecision 'allow'
 *   deny           → 'deny', with the gate's code and reason
 *   queue_approval → 'deny' as well, and deliberately so. The run ends and the
 *                    job goes dormant; holding the tool call open while a human
 *                    takes six hours to answer is exactly what the approval
 *                    broker exists to avoid (docs/00-overview.md, #4). The
 *                    approval id travels in the reason so the orchestrator can
 *                    resume from it.
 */
export function createGateHook(binding: GateHookBinding) {
  return async function gateHook(input: unknown): Promise<HookJSONOutput> {
    try {
      return await decide(input, binding);
    } catch (error) {
      // `readAmountMinor` throws on a decimal amount, and any database error in
      // gate steps 1-2 throws too. What the SDK does with a hook that rejects is
      // unspecified, and "unspecified" on the permission path is not a risk
      // worth taking: fail closed and say so.
      return denial(
        'gate_error',
        error instanceof Error ? error.message : 'שגיאה לא צפויה בשער',
      );
    }
  };
}

async function decide(
  input: unknown,
  binding: GateHookBinding,
): Promise<HookJSONOutput> {
  {
    const hook = input as PreToolUseHookInput;

    const translated = translateToolName(hook.tool_name);
    if (translated === null) {
      // The SDK offers tools the policy layer has never heard of. Denying the
      // unknown is the only safe default here: an unmapped name would reach
      // the gate as an unclassified tool and, worse, would be indistinguishable
      // from a read-only one.
      binding.onDecision?.({
        tool: hook.tool_name,
        decision: 'deny',
        code: 'sdk_tool_unmapped',
      });
      return denial(
        'sdk_tool_unmapped',
        `הכלי "${hook.tool_name}" אינו ממופה למרשם הכלים של המערכת`,
      );
    }

    if (translated.pathScoped) {
      const path = readPathArgument(hook.tool_input);
      if (path === null || !isPathWithin(path, binding.documentRoot)) {
        binding.onDecision?.({
          tool: translated.internal,
          decision: 'deny',
          code: 'path_outside_document_root',
        });
        return denial(
          'path_outside_document_root',
          `קריאה מחוץ לתיקיית המסמכים המורשית: ${path ?? '(ללא נתיב)'}`,
        );
      }
    }

    const decision = await evaluateToolCall(
      translated.internal,
      hook.tool_input,
      {
        agent: binding.agent,
        bundle: binding.bundle,
        provenance: binding.provenance,
        chainDepth: binding.chainDepth ?? 0,
        counterpartyTags: binding.counterpartyTags,
        rampLevel: binding.rampLevel,
        ...(binding.now !== undefined ? { now: binding.now } : {}),
        ...(binding.businessId !== undefined ? { businessId: binding.businessId } : {}),
        ...(binding.jobId !== undefined ? { jobId: binding.jobId } : {}),
        ...(binding.envelopeId !== undefined ? { envelopeId: binding.envelopeId } : {}),
        ...(binding.autonomyCeiling !== undefined
          ? { autonomyCeiling: binding.autonomyCeiling }
          : {}),
        ...(binding.db !== undefined ? { db: binding.db } : {}),
      },
    );

    if (decision.outcome === 'allow') {
      binding.onDecision?.({ tool: translated.internal, decision: 'allow', code: 'allow' });
      // `updatedInput` is how the redaction actually reaches the wire. Without
      // it the gate computed a redacted payload and the SDK went on to execute
      // the original — the charter's redactBeforeSending promise silently did
      // not hold on the only execution path that exists.
      const redacted = decision.redactedInput;
      const wasObject = typeof hook.tool_input === 'object' && hook.tool_input !== null;
      const isObject = typeof redacted === 'object' && redacted !== null;
      if (wasObject && !isObject) {
        // Fail closed: an allow we cannot express with the redacted payload
        // would send the unredacted one.
        return denial(
          'redaction_unrepresentable',
          'הקלט המצונזר אינו אובייקט ולכן לא ניתן להעביר אותו ל-SDK',
        );
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `policy:${binding.agent}:${translated.internal}`,
          ...(isObject ? { updatedInput: redacted as Record<string, unknown> } : {}),
        },
      };
    }

    binding.onDecision?.({
      tool: translated.internal,
      decision: 'deny',
      code: decision.code,
    });
    return denial(decision.code, decision.reason);
  }
}

function denial(code: string, reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // The code goes in the reason because that is the only field the SDK
      // carries back to the model and into the transcript. It must stay
      // machine-parseable: the orchestrator reads `queued_for_approval:<id>`
      // out of it to know which approval to resume from.
      permissionDecisionReason: `${code} — ${reason}`,
    },
  };
}
