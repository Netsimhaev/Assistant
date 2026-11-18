import type { ActionClass } from '../domain/action.js';
import {
  CHANGE_CLASSES,
  MONEY_CLASSES,
  type ExternalOperation,
  type ExternalSystem,
} from '../domain/external-system.js';
import { toOneLine } from '../util/bidi.js';
import { classifyAction, refineActionClass } from './classify.js';

/**
 * The class an `ext.read` / `ext.call` is judged as — the one the owner signed.
 *
 * `TOOL_ACTION_CLASS` (`classify.ts`) gives the two tools a static class, and
 * for `ext.call` that class is a placeholder: the strictest one there is
 * (`external.delete`). The real class of a call is the `actionClass` of the
 * operation it names in the signed charter, and this module is the ONE place
 * that reads it. The gate (stage 3 of `evaluateToolCall`), the plan runner's
 * classification (`actionClassOf`, `classMismatch`, `targetIdOf` in
 * `run-plan.ts`) and the plan ramp (`rampLevelForPlan`) all call
 * `resolveExternalCall` or `classifyCall` below; two derivations written
 * separately would be two derivations that disagree, and the plan would then
 * be approved as one class and executed as another.
 *
 * Every rule here is positive. A call resolves only when:
 *  - the payload carries an OWN string `system` that equals, exactly, the id
 *    of a signed system;
 *  - the payload carries an OWN string `operation` that equals, exactly, the
 *    name of one of that system's signed operations;
 *  - the operation's kind is one the tool may perform: `ext.read` performs
 *    `read` only, `ext.call` performs `change`, `delete` or `money` only;
 *  - the operation's signed class fits its kind (checked again here, though
 *    the schema already checked it at signing, because a bundle reaching the
 *    gate is not necessarily one that went through that schema).
 * Anything else is unresolved, and an unresolved call is refused — never
 * judged under some milder default.
 *
 * Systems and operations are ARRAYS and are searched by equality, never by
 * using the payload's string as an object key: `constructor`, `toString` and
 * `__proto__` can only ever resolve to an operation the owner actually signed
 * under that name, never to something on `Object.prototype`.
 */

/** The two tools whose class comes from the signed charter. Closed. */
export const EXTERNAL_TOOLS: ReadonlySet<string> = new Set(['ext.read', 'ext.call']);

export function isExternalTool(toolName: string): boolean {
  return EXTERNAL_TOOLS.has(toolName);
}

export type ExternalResolution =
  | { ok: true; system: ExternalSystem; op: ExternalOperation; actionClass: ActionClass }
  | { ok: false; reason: string };

/** An own-property string, or `null`. Inherited values never count. */
function ownString(input: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(input, key)) return null;
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Longest slice of a payload string a refusal reason may quote. */
export const QUOTED_PAYLOAD_MAX_CHARS = 80;

/**
 * A payload string as a refusal reason may quote it: one line, no bidi
 * controls (`toOneLine` strips them), at most 80 characters. The `system`
 * and `operation` values are written by whoever shaped the payload, and the
 * reason travels to the caller, the job record and the owner's screen.
 */
function quoted(value: string): string {
  return toOneLine(value).slice(0, QUOTED_PAYLOAD_MAX_CHARS);
}

/** May this tool perform an operation of this kind? Positive, per tool. */
function toolPerformsKind(toolName: string, kind: ExternalOperation['kind']): boolean {
  if (toolName === 'ext.read') return kind === 'read';
  if (toolName === 'ext.call') return kind === 'change' || kind === 'delete' || kind === 'money';
  return false;
}

/** Does the signed class fit the operation's kind? The schema's rule, restated positively. */
function classFitsKind(op: ExternalOperation): boolean {
  switch (op.kind) {
    case 'read':
      return op.actionClass === 'external.read';
    case 'delete':
      return op.actionClass === 'external.delete';
    case 'change':
      return (CHANGE_CLASSES as readonly string[]).includes(op.actionClass);
    case 'money':
      return (MONEY_CLASSES as readonly string[]).includes(op.actionClass);
  }
}

export function resolveExternalCall(
  systems: readonly ExternalSystem[],
  toolName: string,
  input: Record<string, unknown>,
): ExternalResolution {
  if (!isExternalTool(toolName)) {
    return { ok: false, reason: `"${quoted(toolName)}" is not an external-system tool` };
  }
  const systemId = ownString(input, 'system');
  if (systemId === null) return { ok: false, reason: 'no readable "system" in the call' };
  const operationName = ownString(input, 'operation');
  if (operationName === null) return { ok: false, reason: 'no readable "operation" in the call' };

  const system = systems.find((s) => s.id === systemId);
  if (system === undefined) return { ok: false, reason: `no signed system "${quoted(systemId)}"` };

  const op = system.operations.find((o) => o.name === operationName);
  if (op === undefined) {
    return { ok: false, reason: `system "${quoted(systemId)}" has no signed operation "${quoted(operationName)}"` };
  }
  if (!toolPerformsKind(toolName, op.kind)) {
    return { ok: false, reason: `${toolName} may not perform the "${op.kind}" operation "${operationName}"` };
  }
  if (!classFitsKind(op)) {
    return { ok: false, reason: `operation "${operationName}" carries class ${op.actionClass}, which does not fit its kind` };
  }
  return { ok: true, system, op, actionClass: op.actionClass };
}

/**
 * The action class the gate settles on for a call — for every tool.
 *
 * For an external tool, the signed class when the call resolves. When it does
 * not, the static placeholder (`classifyAction`), which is the strictest class
 * for `ext.call` — but no caller should ever act on that: the gate refuses an
 * unresolved call at stage 3 and `runPlan` rejects the plan before any step
 * runs. Returned rather than thrown so a display path never crashes on a
 * malformed step; it is never the permissive answer.
 *
 * For every other tool, exactly what `buildFacts` computes: the base class,
 * refined by the payload.
 */
export function classifyCall(
  systems: readonly ExternalSystem[],
  toolName: string,
  input: Record<string, unknown>,
): ActionClass | null {
  if (isExternalTool(toolName)) {
    const resolved = resolveExternalCall(systems, toolName, input);
    if (resolved.ok) return resolved.actionClass;
  }
  const base = classifyAction(toolName);
  return base === null ? null : refineActionClass(base, input);
}
