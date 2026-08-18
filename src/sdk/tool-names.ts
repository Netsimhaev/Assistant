import type { AgentId } from '../domain/audit.js';
import { AGENT_ALLOWLISTS } from '../charter/capabilities.js';

/**
 * Translate the Agent SDK's tool names into the names the policy layer knows.
 *
 * These are two different vocabularies and neither can be changed to match the
 * other: the SDK ships `Read`, `Bash`, `WebFetch`; the charter, the allowlists
 * and the audit log all speak `doc.fetch`, `code_execution`, `memory.recall`.
 *
 * The translation is the security boundary, not a convenience. The SDK offers
 * tools the policy layer has never heard of — `Bash` above all — and the gate
 * cannot deny what it cannot name. So the rule is inverted from the usual: a
 * tool absent from this map is **denied**, and adding one here is a deliberate
 * act that also requires adding it to `classify.ts` and to an allowlist.
 */
const SDK_TO_INTERNAL: Record<string, string> = {
  Read: 'doc.fetch',
  Glob: 'doc.fetch',
  Grep: 'doc.fetch',
  WebFetch: 'doc.fetch',
  Write: 'file.write',
  Edit: 'file.write',
};

/**
 * Prefix for tools this system exposes to the SDK over MCP.
 *
 * An MCP tool arrives as `mcp__<server>__<tool>`; ours carry their internal
 * name in the last segment, so they need no table entry.
 */
const MCP_PREFIX = 'mcp__assistant__';

export interface TranslatedTool {
  /** The name the gate will evaluate. */
  internal: string;
  /** How we arrived at it, for the audit reason. */
  via: 'builtin' | 'mcp';
}

/**
 * Returns null for a tool with no internal name — which the caller must treat
 * as a denial, never as "no policy applies".
 */
export function translateToolName(sdkToolName: string): TranslatedTool | null {
  if (sdkToolName.startsWith(MCP_PREFIX)) {
    const internal = sdkToolName.slice(MCP_PREFIX.length);
    return internal.length > 0 ? { internal, via: 'mcp' } : null;
  }
  const internal = SDK_TO_INTERNAL[sdkToolName];
  return internal === undefined ? null : { internal, via: 'builtin' };
}

/**
 * The SDK-side tool list for an agent, derived from its charter allowlist.
 *
 * Derived rather than written by hand, so the two can never drift: an agent
 * that loses `doc.fetch` in the charter loses `Read` in the SDK in the same
 * change. `Bash` appears in no allowlist, so it is never produced here.
 */
export function sdkToolsFor(agent: AgentId): string[] {
  const permitted = new Set(AGENT_ALLOWLISTS[agent]);
  const tools = Object.entries(SDK_TO_INTERNAL)
    .filter(([, internal]) => permitted.has(internal))
    .map(([sdkName]) => sdkName);
  return [...new Set(tools)].sort();
}
