import type { AgentId } from '../domain/audit.js';
import type { ActionClass } from '../domain/action.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import { mostRestrictiveAutonomy } from '../domain/trust.js';
import { AGENT_ALLOWLISTS, isToolPermitted } from '../charter/capabilities.js';
import { classifyAction, READ_ONLY_TOOLS } from '../policy/classify.js';

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
      const cls = tool.actionClass ?? 'read-only';
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
