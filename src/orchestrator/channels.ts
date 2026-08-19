import type { PolicyBundle } from '../domain/policy.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';

export type ChannelResolution =
  | { status: 'resolved'; system: string; channel: 'api' | 'browser' }
  | { status: 'no_channel'; reason: string }
  | { status: 'ambiguous'; systems: string[] }
  | { status: 'unavailable'; system: string; reason: string };

/**
 * Which system serves this call, and on which channel.
 *
 * The registry decides, never the model. Choosing between an API and a browser
 * is choosing how much authority to hand out, and the browser session holds
 * the owner's full authority on a site whose content an attacker controls.
 *
 * Matching is written positively: collect every connection that serves the
 * tool, prefer an exact target match over the catch-all, and refuse when two
 * remain. Array order must never break the tie — that looks like a decision
 * and behaves like an accident.
 */
export function resolveChannel(
  bundle: PolicyBundle,
  bindings: readonly ConnectionBinding[],
  toolName: string,
  targetId: string | null,
): ChannelResolution {
  const serving = bundle.connections.filter((c) => c.serves.includes(toolName));
  if (serving.length === 0) {
    return { status: 'no_channel', reason: `no connection serves ${toolName}` };
  }

  const exact = targetId === null ? [] : serving.filter((c) => c.target === targetId);
  const candidates: CharterConnection[] =
    exact.length > 0 ? exact : serving.filter((c) => c.target === null);

  if (candidates.length === 0) {
    return {
      status: 'no_channel',
      reason: `no connection serves ${toolName} for target ${targetId ?? '(none)'}`,
    };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', systems: candidates.map((c) => c.system) };
  }

  const connection = candidates[0]!;
  const binding = bindings.find((b) => b.system === connection.system);
  if (binding === undefined) {
    return { status: 'unavailable', system: connection.system, reason: 'no binding' };
  }
  if (binding.status !== 'live') {
    return { status: 'unavailable', system: connection.system, reason: binding.status };
  }

  return { status: 'resolved', system: connection.system, channel: connection.channel };
}

/**
 * The target a payload is addressed to.
 *
 * One function, imported by both call sites — plan validation and step
 * execution. Two derivations written separately are two derivations that will
 * diverge, and when they do a plan will be approved against one channel and
 * executed against another.
 */
export function deriveTargetId(input: Record<string, unknown>): string | null {
  for (const key of ['supplierId', 'counterpartyId']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
