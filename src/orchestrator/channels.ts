import type { PolicyBundle } from '../domain/policy.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import { addresseeOf } from '../domain/action.js';
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
 * One function, reached by both call sites — plan validation and step
 * execution, in `run-plan.ts`, through the single `targetIdOf` helper there.
 * Two derivations written separately are two derivations that will diverge,
 * and when they do a plan will be approved against one channel and executed
 * against another.
 *
 * The counterparty half must read `counterpartyId` with the same
 * `entityId` fallback `buildFacts` (`src/policy/facts.ts`) uses, or this
 * function and the facts the gate scores diverge on the exact payload shape
 * — `{ entityId }` — that dominates the existing orchestrator and planner
 * fixtures.
 *
 * When a payload carries both a `supplierId` and a `counterpartyId` (a stray
 * field, or one an attacker rode in on), the tie is broken by what the call
 * *is* and never by what the payload contains: letting the payload's own
 * shape settle it would hand a caller-supplied field the power to choose the
 * channel.
 *
 * `prefersSupplier` below names the three ways a call earns supplier
 * precedence. Everything else — every class that addresses a person, and
 * every `internal` class — resolves by counterparty. Both halves of that
 * boundary have been got wrong here already, in opposite directions:
 *
 * - Keying on the literal class `purchase.place` was too narrow.
 *   `browser.click` and `browser.fill` classify as `browser.interact` and
 *   only refine to `purchase.place` once the payload carries
 *   `amountMinor > 0` (`policy/classify.ts`), so an unpriced click on a
 *   supplier's site routed by whatever `counterpartyId` was in the payload.
 * - Widening it to "any class that does not address a person" was too broad
 *   in the mirror image. `crm.write`, `accounting.write`, `data.export`,
 *   `artifact.write`, `memory.write_longterm` and `charter.amend` are
 *   `internal`, and none of them deals with a supplier: they write to the
 *   CRM, the books, the filesystem, long-term memory and the charter, about a
 *   counterparty that the payload names correctly. Handing them supplier
 *   precedence let a stray `supplierId` steer a write to a system of record,
 *   and broke this function's agreement with `facts.counterpartyId`.
 *
 * Written as an allowlist rather than as a negation, because both defects
 * above were negations that swept in a neighbour nobody looked at.
 *
 * The losing side yields `null`; it never falls through to the other field.
 * That cross-fallback made the whole precedence rule optional: a payload did
 * not have to win the argument, it just had to omit the field it would have
 * lost with. `mail.send` carrying only a `supplierId` returned that supplier
 * even though `buildFacts` reports no counterparty at all, and a
 * `browser.interact` carrying only a `counterpartyId` returned that
 * counterparty. Whichever id the payload supplied became the target, which is
 * precisely the caller-chosen routing this function exists to prevent.
 *
 * Returning no target is the safe outcome, not a degraded one: `resolveChannel`
 * then matches the `target: null` catch-all, which is a connection the owner
 * signed, or refuses outright. Either way the channel comes from the registry.
 */
export function deriveTargetId(
  toolName: string,
  input: Record<string, unknown>,
  actionClass: ActionClass | null,
): string | null {
  const supplierId = readString(input, 'supplierId');
  const counterpartyId = readString(input, 'counterpartyId') ?? readString(input, 'entityId');

  return prefersSupplier(toolName, actionClass) ? supplierId : counterpartyId;
}

/**
 * The closed list of calls whose `supplierId` outranks their `counterpartyId`.
 *
 * Three entries, each true for a stated reason:
 *
 * 1. Addressee `browser`. Read from `domain/action.ts`'s `addresseeOf` rather
 *    than restated here. That mapping answers "does this action reach a
 *    human", which is what the risk layer needs; this is a *reader* of that
 *    answer, not a second definition of it. The two browser classes are a
 *    closed allowlist there, and a session on a supplier's site is served by
 *    that supplier's connection.
 * 2. `purchase.place`. `internal` by addressee — the ceilings do not treat a
 *    supplier as a person — and routed by supplier for exactly that reason.
 *    It is the one `internal` class that names a supplier as its target.
 * 3. A `null` class on a `browser.` tool. `browser.navigate` is read-only and
 *    so classifies as nothing at all, yet it is unmistakably a supplier-side
 *    call. Scoped to the tool prefix and not generalised to every `null`
 *    class: "unclassified therefore supplier" is what put the internal
 *    classes on the wrong side, and most unclassified calls are not browsing.
 *
 * The tool name is a parameter rather than an optional one that defaults to
 * "not a browser tool", so a caller that forgets it is a compile error rather
 * than a call that silently routes the other way.
 */
function prefersSupplier(toolName: string, actionClass: ActionClass | null): boolean {
  if (actionClass === null) return toolName.startsWith('browser.');
  if (actionClass === 'purchase.place') return true;
  return addresseeOf(actionClass) === 'browser';
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
