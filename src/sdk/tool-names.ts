import { resolve, sep } from 'node:path';
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
 *
 * The map is deliberately tiny. An earlier version mapped `Glob`, `Grep` and
 * `WebFetch` onto `doc.fetch` as well, which widened one internal name from
 * "fetch a business document" into "read any path and fetch any URL" — and
 * `doc.fetch` is read-only, so all of it short-circuited the gate at step 4 and
 * left no audit row. That handed the quarantine reader an arbitrary-read plus
 * arbitrary-egress pair, which is exactly the capability it exists not to have.
 */
const SDK_TO_INTERNAL: Record<string, string> = {
  Read: 'doc.fetch',
};

/**
 * SDK tools that must never be offered, whatever an allowlist derives.
 *
 * Belt and braces over the deny-by-default map: `WebFetch` is the one that
 * matters, because egress from an agent reading untrusted content is the
 * exfiltration half of a prompt-injection attack.
 */
export const ALWAYS_DISALLOWED_SDK_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
];

/** Filesystem-reading SDK tools, whose path argument must be scoped. */
const PATH_SCOPED_SDK_TOOLS: ReadonlySet<string> = new Set(['Read']);

/**
 * Prefix for tools this system exposes to the SDK over MCP.
 *
 * An MCP tool arrives as `mcp__<server>__<tool>`; ours carry their internal
 * name in the last segment, so they need no table entry. The name still has to
 * survive `isKnownTool` and the agent's allowlist inside the gate, so an
 * invented segment is denied there rather than here.
 */
const MCP_PREFIX = 'mcp__assistant__';

export interface TranslatedTool {
  /** The name the gate will evaluate. */
  internal: string;
  /** How we arrived at it, for the audit reason. */
  via: 'builtin' | 'mcp';
  /** True when the payload carries a filesystem path that must be scoped. */
  pathScoped: boolean;
}

/**
 * Returns null for a tool with no internal name — which the caller must treat
 * as a denial, never as "no policy applies".
 */
export function translateToolName(sdkToolName: string): TranslatedTool | null {
  if (ALWAYS_DISALLOWED_SDK_TOOLS.includes(sdkToolName)) return null;

  if (sdkToolName.startsWith(MCP_PREFIX)) {
    const internal = sdkToolName.slice(MCP_PREFIX.length);
    return internal.length > 0
      ? { internal, via: 'mcp', pathScoped: false }
      : null;
  }
  const internal = SDK_TO_INTERNAL[sdkToolName];
  return internal === undefined
    ? null
    : { internal, via: 'builtin', pathScoped: PATH_SCOPED_SDK_TOOLS.has(sdkToolName) };
}

/**
 * Is `candidate` inside `root`?
 *
 * `doc.fetch` is read-only and skips the gate, so the only thing standing
 * between a reader and `.env` is this check. Compared after `resolve`, so
 * `../../../.env` is normalised before the prefix test rather than after.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, candidate);
  return (
    resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep)
  );
}

/** The path argument an SDK read tool carries, if any. */
export function readPathArgument(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const value = (toolInput as Record<string, unknown>)['file_path'];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
    .filter(([sdkName, internal]) => {
      return permitted.has(internal) && !ALWAYS_DISALLOWED_SDK_TOOLS.includes(sdkName);
    })
    .map(([sdkName]) => sdkName);
  return [...new Set(tools)].sort();
}
