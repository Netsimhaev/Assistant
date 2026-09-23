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
 */
import { z } from 'zod';
import { implementedLocalTools } from '../orchestrator/local-tools.js';

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
      payload: z.object({ question: z.string().min(1).max(500) }),
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

/** Every tool named in the registry, for the reachability invariants below. */
export function registeredTools(): string[] {
  const tools: string[] = [];
  for (const forAgent of Object.values(INTENT_REGISTRY)) {
    for (const spec of Object.values(forAgent)) {
      tools.push(spec.tool);
    }
  }
  return tools;
}

/**
 * Every registered intent must name a tool that is not merely known to the
 * policy engine (classified or explicitly read-only — `isKnownTool`, checked
 * directly in `intent-registry.test.ts`) but actually IMPLEMENTED by the local
 * tool executor.
 *
 * A registry entry that names a known-but-unimplemented tool is a capability
 * that completes with `{ performed: false, reason: 'not_implemented' }` the
 * moment the ramp allows the child's one step to run — a delegation that runs
 * end to end and teaches the parent nothing. That is the hollow-mechanism
 * failure this whole sub-project was chosen to close, so it is checked here as
 * a structural fact about the registry, not left to be discovered the next
 * time someone actually delegates.
 *
 * Scoped to local, unimplemented tools only: a registry entry naming a tool
 * that reaches an adapter (none do today) would not appear here as a defect,
 * because `implementedLocalTools` only speaks for the local executor.
 */
export function registryToolsMissingImplementation(): string[] {
  const implemented = new Set(implementedLocalTools());
  return registeredTools().filter((tool) => !implemented.has(tool));
}
