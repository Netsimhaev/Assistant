import type {
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import type { Queryable } from '../db/pool.js';
import { evaluateToolCall } from '../policy/engine.js';
import { translateToolName } from './tool-names.js';

export interface GateHookBinding {
  agent: AgentId;
  bundle: PolicyBundle;
  /** Lowest trust in this job's causal chain, stamped by the caller. */
  provenance: TrustLevel;
  chainDepth?: number;
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

    const decision = await evaluateToolCall(
      translated.internal,
      hook.tool_input,
      {
        agent: binding.agent,
        bundle: binding.bundle,
        provenance: binding.provenance,
        chainDepth: binding.chainDepth ?? 0,
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
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `policy:${binding.agent}:${translated.internal}`,
        },
      };
    }

    binding.onDecision?.({
      tool: translated.internal,
      decision: 'deny',
      code: decision.code,
    });
    return denial(decision.code, decision.reason);
  };
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
