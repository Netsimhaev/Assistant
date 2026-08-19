import type { PolicyBundle } from '../domain/policy.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { ActionClass } from '../domain/action.js';

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
 *
 * The counterparty half must read `counterpartyId` with the same
 * `entityId` fallback `buildFacts` (`src/policy/facts.ts`) uses, or this
 * function and the facts the gate scores diverge on the exact payload shape
 * — `{ entityId }` — that dominates the existing orchestrator and planner
 * fixtures.
 *
 * When a payload carries both a `supplierId` and a `counterpartyId` (a stray
 * field, or one an attacker rode in on), which one is authoritative is a
 * routing question, not the "does this reach a human" question
 * `domain/action.ts`'s `addresseeOf` answers — a purchase is read by a
 * person too, but it is still routed by supplier. `purchase.place` is the
 * one class whose entire purpose is dealing with a supplier, so it is the
 * one class where `supplierId` wins; every other class resolves by
 * `counterpartyId` regardless of what else the payload carries. Letting the
 * payload's own shape settle the tie would hand a caller-supplied field the
 * power to choose the channel.
 */
export function deriveTargetId(
  input: Record<string, unknown>,
  actionClass: ActionClass | null,
): string | null {
  const supplierId = readString(input, 'supplierId');
  const counterpartyId = readString(input, 'counterpartyId') ?? readString(input, 'entityId');

  return actionClass === 'purchase.place'
    ? (supplierId ?? counterpartyId)
    : (counterpartyId ?? supplierId);
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
