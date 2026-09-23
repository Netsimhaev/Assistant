import { describe, expect, it } from 'vitest';
import { isKnownTool } from '../policy/classify.js';
import { isToolPermitted } from '../charter/capabilities.js';
import { AgentId } from '../domain/audit.js';
import {
  INTENT_REGISTRY,
  registeredTools,
  registryToolsMissingImplementation,
  resolveIntent,
} from './intent-registry.js';

describe('resolveIntent', () => {
  it('resolves a registered intent and refuses an unregistered one', () => {
    const spec = resolveIntent('know.reader', 'read_for_question');
    expect(spec).not.toBeNull();
    expect(spec?.tool).toBe('doc.fetch');
    expect(spec?.requiresContextRef).toBe('document');

    expect(resolveIntent('know.reader', 'no_such_intent')).toBeNull();
    expect(resolveIntent('comms.email', 'read_for_question')).toBeNull();
  });

  it('refuses a prototype key as an agent name and as an intent name', () => {
    expect(resolveIntent('constructor', 'x')).toBeNull();
    expect(resolveIntent('toString', 'x')).toBeNull();
    expect(resolveIntent('__proto__', 'x')).toBeNull();
    expect(resolveIntent('know.reader', 'toString')).toBeNull();
    expect(resolveIntent('know.reader', 'constructor')).toBeNull();
    expect(resolveIntent('know.reader', '__proto__')).toBeNull();
  });

  /**
   * Every registered intent names a tool the policy engine knows AND that the
   * receiving agent actually holds. A value that fails either half would only
   * fail at runtime, the moment the ramp let a delegated step run.
   */
  it('every registered intent names a tool the policy engine knows and the receiver may hold', () => {
    let checked = 0;
    for (const [to, intents] of Object.entries(INTENT_REGISTRY)) {
      const agent = AgentId.parse(to);
      for (const spec of Object.values(intents)) {
        checked += 1;
        expect(isKnownTool(spec.tool), `${spec.tool} is not a tool the policy knows`).toBe(true);
        expect(
          isToolPermitted(agent, spec.tool),
          `${to} does not hold ${spec.tool}`,
        ).toBe(true);
      }
    }
    // A registry that happened to be empty would pass every assertion above
    // for having checked nothing.
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * The addition this task carries beyond the brief: a tool that is merely
   * *known* to the policy engine but not *implemented* by the local tool
   * executor is a delegation that runs end to end and completes with
   * `{ performed: false, reason: 'not_implemented' }` — teaching the parent
   * nothing. `doc.fetch` was exactly this case until this task implemented it.
   */
  it('every registered tool has a local implementation', () => {
    expect(registeredTools().length).toBeGreaterThan(0);
    expect(registryToolsMissingImplementation()).toEqual([]);
  });
});
