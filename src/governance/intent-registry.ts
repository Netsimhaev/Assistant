/**
 * For each RECEIVING agent: which intents it accepts, the zod schema for each
 * payload, and the tool the child's one step will call.
 *
 * One receiver today. `gov.verify` is nobody's delegate in
 * `COLLABORATION_GRAPH`, so it has no entry — an empty entry would advertise a
 * capability that does not exist, which is the dead-rule shape this codebase
 * already pays to avoid.
 *
 * Lookup is `Object.hasOwn`, never `in`: `constructor` and `toString` resolve
 * through the prototype and would read as registered intents.
 *
 * **This file must never import `local-tools.ts`.** `delegate.ts`'s
 * `requestHelp` imports this module to resolve an intent, and `gov.verify`
 * (`src/sdk/gov-verify.ts`) imports `delegate.ts` to delegate at all — its own
 * quarantine forbids transitively reaching `readDocument`, which
 * `local-tools.ts` imports. The completeness check that used to live here
 * (`registryToolsMissingImplementation`, "every registered tool is actually
 * implemented") needed `implementedLocalTools` for exactly that reason and
 * for no other, so it moved to `intent-registry.test.ts`, the only place that
 * ever called it — see `gov-verify.test.ts`'s import-graph invariant, which
 * would catch a reintroduction of this import.
 */
import { z } from 'zod';

/**
 * The cap on `read_for_question`'s `question` field. Named and exported so
 * `gov-verify.ts` — the only caller that ever composes this intent's payload
 * outside this schema itself (once a delegation has already answered, and
 * this schema is not consulted a second time) — derives its own cap from
 * this constant rather than repeating the literal `500`. Two independent
 * literals claiming to be "the same cap" is exactly the drift the house
 * pattern (`sdkToolsFor` deriving from an allowlist, the `OUTBOUND_TOOLS`
 * invariant deriving from `addresseeOf`) exists to prevent.
 */
export const READ_FOR_QUESTION_MAX_CHARS = 500;

export interface IntentSpec {
  payload: z.ZodTypeAny;
  /** A context ref of this kind must be present, or the request is refused. */
  requiresContextRef: 'document' | 'reading' | 'memory' | 'job' | null;
  /** The tool the child job's single step calls. */
  tool: string;
}

export const INTENT_REGISTRY: Record<string, Record<string, IntentSpec>> = {
  'know.reader': {
    /**
     * "Read this and tell me what it asks." The only intent this work needs,
     * and the one that the quarantine boundary forces: `gov.verify` may not
     * open an untrusted document itself.
     */
    read_for_question: {
      payload: z.object({ question: z.string().min(1).max(READ_FOR_QUESTION_MAX_CHARS) }),
      requiresContextRef: 'document',
      // know.reader's allowlist is ['doc.fetch', 'memory.recall'].
      tool: 'doc.fetch',
    },
  },
};

export function resolveIntent(to: string, intent: string): IntentSpec | null {
  if (!Object.hasOwn(INTENT_REGISTRY, to)) return null;
  const forAgent = INTENT_REGISTRY[to]!;
  if (!Object.hasOwn(forAgent, intent)) return null;
  return forAgent[intent]!;
}

/**
 * Every tool named in the registry, for the reachability invariants in
 * `intent-registry.test.ts` — including the completeness check that every
 * registered tool is actually IMPLEMENTED by the local tool executor, not
 * merely known to the policy engine. That check needs `implementedLocalTools`
 * (`orchestrator/local-tools.ts`), which this production module must never
 * import (see this file's own docblock) — so it lives in the test file, the
 * only place that ever called it.
 */
export function registeredTools(): string[] {
  const tools: string[] = [];
  for (const forAgent of Object.values(INTENT_REGISTRY)) {
    for (const spec of Object.values(forAgent)) {
      tools.push(spec.tool);
    }
  }
  return tools;
}
