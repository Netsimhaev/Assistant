import type {
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentId } from '../domain/audit.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import type { Queryable } from '../db/pool.js';
import { evaluateToolCall } from '../policy/engine.js';
import { ingestsExternalContent } from '../policy/classify.js';
import { markContentIngested } from '../orchestrator/jobs.js';
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
  /**
   * The job this call belongs to, or explicitly `null` for a run with no job
   * to remember the read against.
   *
   * Required, not optional: an omitted field used to mean "do not record
   * this read" — indistinguishable from a genuinely job-less run — which is
   * exactly the failure mode `counterpartyTags` and `Job.contentIngested`
   * document above and in `src/orchestrator/jobs.ts`: an optional field that
   * silently disabled a control until a caller happened to notice. `null` is
   * the honest answer for the live script (`run-know-reader.ts`); every
   * other caller states its real job id.
   */
  jobId: string | null;
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
        jobId: binding.jobId,
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

      // `executeStep` (src/orchestrator/execute.ts) is the other place a tool
      // call is allowed to run, and it already marks `content_ingested` before
      // its call goes out. This is not the same call reused: an SDK-driven
      // agent (know.reader chief among them) never passes through
      // `executeStep` at all — the model calls the tool directly and this hook
      // is the only gate it passes. Two writers of a one-way flag sounds like
      // duplication worth unifying, but it is not: there is no single call
      // site both paths funnel through, so "unifying" would mean deleting one
      // of the two places a read can actually happen, and the SDK path is the
      // one Task 6 exists because it was missing.
      //
      // Marked here, not after the SDK executes the tool: a crash between the
      // read landing and the write would leave the read unremembered, which is
      // the one direction that hands out an exemption nobody earned. This is
      // also strictly after the redaction check above and only on the branch
      // that returns `permissionDecision: 'allow'` — a denial here (including
      // `redaction_unrepresentable`) means the tool never runs and must not
      // mark. `translated.internal` is used, never `hook.tool_name`: the
      // ingest table is keyed by internal names, and marking on the raw SDK
      // name would either never match (wrong name) or mark on every call
      // (`ingestsExternalContent` defaults unknown names to `true`).
      if (binding.jobId !== null && ingestsExternalContent(translated.internal)) {
        const matched = await markContentIngested(binding.jobId, {
          ...(binding.businessId !== undefined ? { businessId: binding.businessId } : {}),
          ...(binding.db !== undefined ? { db: binding.db } : {}),
        });
        // `jobId` and `businessId` reach this hook as two independent
        // caller-supplied fields — unlike `executeStep`, nothing here loaded
        // a job row to derive them from. A stale id, a typo, or a jobId that
        // names another business's job all produce a zero-row match, and
        // letting the tool run anyway would mean this read happened with
        // nothing remembering it — the one direction `content_ingested`
        // exists to prevent. So this fails closed, overriding the gate's
        // `allow` from a moment ago, rather than trust a write that did not
        // land.
        if (matched === 0) {
          binding.onDecision?.({
            tool: translated.internal,
            decision: 'deny',
            code: 'content_ingest_unrecorded',
          });
          return denial(
            'content_ingest_unrecorded',
            `לא ניתן לרשום את קליטת התוכן עבור job ${binding.jobId} — הקריאה נחסמה`,
          );
        }
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
