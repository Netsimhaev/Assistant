import type { AgentId } from '../domain/audit.js';
import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import { mostRestrictiveAutonomy } from '../domain/trust.js';
import { AGENT_ALLOWLISTS, isToolPermitted } from '../charter/capabilities.js';
import { classifyAction, READ_ONLY_TOOLS } from '../policy/classify.js';
import { isExternalTool } from '../policy/external-class.js';
import type { ExternalSystem } from '../domain/external-system.js';
import { actionClassLabel } from '../domain/labels.js';
import { toOneLine } from '../util/bidi.js';

export interface CatalogueTool {
  toolName: string;
  actionClass: ActionClass | null;
  /** What this tool would resolve to for this agent, at this provenance. */
  effectiveAutonomy: AutonomyLevel;
}

export interface CatalogueEntry {
  agent: AgentId;
  tools: CatalogueTool[];
}

/**
 * What each agent can actually do, right now, at this provenance.
 *
 * Handed to the planner so a plan is feasible by construction. The alternative
 * — let the planner guess and have the gate reject step 4 of 6 — wastes a
 * model call and leaves a half-executed job behind.
 *
 * Two things this deliberately does NOT do. It does not widen anything: a tool
 * absent here is absent because the gate would refuse it, and the catalogue is
 * derived from the same tables the gate reads rather than restated. And it
 * does not promise the plan will be permitted — the ceilings, the risk score
 * and the kill switch are all evaluated per call, against the real payload,
 * which the planner does not have yet.
 */
export function capabilityCatalogue(
  bundle: PolicyBundle,
  provenance: TrustLevel,
  options: { rampLevel?: AutonomyLevel } = {},
): CatalogueEntry[] {
  const provenanceCeiling = bundle.provenanceCeiling[provenance];

  return (Object.keys(AGENT_ALLOWLISTS) as AgentId[]).map((agent) => ({
    agent,
    tools: AGENT_ALLOWLISTS[agent]
      .filter((toolName) => isToolPermitted(agent, toolName))
      .map((toolName) => {
        const actionClass = classifyAction(toolName);
        const ceilings: AutonomyLevel[] = [provenanceCeiling];
        if (actionClass !== null) ceilings.push(bundle.autonomyBase[actionClass]);
        if (options.rampLevel !== undefined) ceilings.push(options.rampLevel);

        return {
          toolName,
          actionClass,
          // A read-only tool has no class and no ceiling to combine; the gate
          // short-circuits it, so reporting anything else would be a lie.
          effectiveAutonomy:
            actionClass === null && READ_ONLY_TOOLS.has(toolName)
              ? ('auto' as const)
              : mostRestrictiveAutonomy(ceilings),
        };
      })
      .sort((a, b) => a.toolName.localeCompare(b.toolName)),
  }));
}

/**
 * How a tool with no action class is rendered in the class column.
 *
 * **Never a bare token.** The column beside it holds real `ActionClass`
 * members — `email.reply`, `crm.write` — and the same prompt then asks the
 * model to fill `expectedActionClass`, which is `ActionClass.nullable()`. The
 * earlier label was the literal string `read-only`, which reads as one more
 * member of that column's vocabulary; the model duly copied it, the plan
 * failed `Plan.safeParse`, and the owner was told their instruction could not
 * be understood. This was found by running the instruction door against the
 * real model — no test could have caught it, because every test supplies its
 * own plan.
 *
 * Written as the instruction it actually is, in Hebrew prose carrying the
 * field name and the literal `null`, so it cannot be mistaken for a value:
 * every `ActionClass` member is a bare ASCII dotted token, and nothing that
 * looks like this one is.
 */
export const READ_ONLY_CLASS_LABEL = 'ללא מחלקה (expectedActionClass: null)';

/**
 * How `ext.read` / `ext.call` are rendered in the class column.
 *
 * Their static class in `TOOL_ACTION_CLASS` is a placeholder — for `ext.call`
 * the strictest class there is (`external.delete`) — and the real class of a
 * call is the one the owner signed for the operation it names
 * (`resolveExternalCall`). Showing the placeholder in the column would be L1
 * again: the model copies what the column says, declares `external.delete`
 * for a signed `crm.write`, and `classMismatch` refuses the plan. So, like
 * `READ_ONLY_CLASS_LABEL`, this is Hebrew prose carrying the field name, never
 * a bare dotted token; the signed classes are listed per operation by
 * `renderExternalCatalogue`, in a section of their own — the same way the
 * payload-decided classes (`REFINEMENT_RULES`) get their own section and never
 * the column.
 */
export const EXTERNAL_CLASS_LABEL = 'לפי הפעולה החתומה (expectedActionClass: המחלקה שמופיעה לפעולה ב"פעולות במערכות חיצוניות", או null)';

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The signed external systems as the text a planner reads — one line per
 * operation, with the class the gate will judge it as.
 *
 * Deterministic like `renderCatalogue`: systems sorted by id, operations by
 * name, by code point (not locale), no timestamps. It changes only when the
 * charter changes, which is when the cached prefix is invalidated anyway.
 * Empty when no system is signed, so a business without one keeps exactly the
 * prefix it had. Labels are signed charter text, folded to one line so a label
 * cannot open a line of its own in the prompt.
 */
export function renderExternalCatalogue(systems: readonly ExternalSystem[]): string {
  const lines: string[] = [];
  for (const system of [...systems].sort((a, b) => byCodePoint(a.id, b.id))) {
    lines.push(`## ${system.id} · ${toOneLine(system.label)}`);
    for (const op of [...system.operations].sort((a, b) => byCodePoint(a.name, b.name))) {
      const tool = op.kind === 'read' ? 'ext.read' : 'ext.call';
      const params =
        op.params.length === 0
          ? 'ללא פרמטרים'
          : op.params.map((p) => `${p.name} (${p.required ? 'חובה' : 'רשות'})`).join(', ');
      const parts = [
        op.name,
        toOneLine(op.label),
        op.kind,
        tool,
        `expectedActionClass: ${op.actionClass} (${actionClassLabel(op.actionClass)})`,
        `params: ${params}`,
      ];
      if (op.amount !== null) parts.push('amountMinor: חובה (מספר שלם ביחידות מינור)');
      lines.push(`- ${parts.join(' · ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * The catalogue as the text a planner reads.
 *
 * Deterministic — sorted agents, sorted tools, no timestamps and no ids. The
 * planner's prefix is the most-cached text in the system, and a single varying
 * byte anywhere in it invalidates the whole prefix (docs/08-risks.md, cost
 * controls). Anything per-job belongs after the last cache breakpoint, not
 * here.
 */
export function renderCatalogue(entries: CatalogueEntry[]): string {
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.agent.localeCompare(b.agent))) {
    if (entry.tools.length === 0) continue;
    lines.push(`## ${entry.agent}`);
    for (const tool of entry.tools) {
      const cls = isExternalTool(tool.toolName)
        ? EXTERNAL_CLASS_LABEL
        : (tool.actionClass ?? READ_ONLY_CLASS_LABEL);
      lines.push(`- ${tool.toolName} · ${cls} · ${tool.effectiveAutonomy}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Can this agent hold this tool at all?
 *
 * The check the planner's output is validated against before anything runs. A
 * plan step naming a tool its agent does not own is a plan that fails at that
 * step — better to reject the plan whole than to execute the three steps
 * before it and then stop.
 */
export function planStepIsFeasible(agent: AgentId, toolName: string): boolean {
  return isToolPermitted(agent, toolName);
}
