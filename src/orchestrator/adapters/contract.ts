import { expect } from 'vitest';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

/**
 * Tools known, by name, to commit nothing when executed for real.
 *
 * Written as a positive membership list rather than as "not classified as a
 * committing action" (`classifyAction(toolName) === null`), because that
 * negative reads as safe for two things it is not: an unrecognised or
 * typo'd tool name, and the side-effecting members `READ_ONLY_TOOLS` itself
 * knowingly holds — `media.generate_image` and `media.generate_video`
 * generate content and cost money, and are read-only only in the sense that
 * the policy gate does not need to sit in front of them, not in the sense
 * that running them for real is free of consequence. `classifyAction` was
 * tried here once already; it let `media.generate_video` stand as a sample
 * and pass. The fix has to name the safe tools, not describe the unsafe ones
 * by absence — the same shape of mistake this project's `positive-controls`
 * tests exist to catch in the policy layer itself, made here for the same
 * reason: every prior version of "everything not X" swept in a neighbour
 * nobody looked at.
 *
 * Extend this list — never `classifyAction` — when a future adapter's
 * contract test needs a different safe sample tool.
 *
 * Exported so `adapters.test.ts` can hold it against `classify.ts`: the names
 * here are hand-written, and nothing in the type system stops a tool from
 * being reclassified as committing while its name stays on this list. That
 * invariant test is what ties the two files together.
 */
export const NON_COMMITTING_SAMPLE_TOOLS: ReadonlySet<string> = new Set([
  'browser.navigate',
  'browser.snapshot',
  'browser.screenshot',
]);

export interface AssertAdapterContractOptions {
  /**
   * Skip the "sample is not a committing action" check.
   *
   * Set this only when `adapter` is a test double, never against a real
   * driver: the suite executes `sample` for real, and an adapter whose every
   * tool commits something (the mail adapter, for one) can only supply a
   * sample that clears the check by pointing `execute` at a double instead
   * of the live implementation for this one call.
   */
  allowCommittingSample?: boolean;
}

/**
 * The suite every adapter must pass.
 *
 * One suite rather than per-adapter tests, so a new adapter inherits the
 * properties that matter instead of inventing its own idea of them.
 *
 * `sample` is executed for real — that is the point, since a mocked call
 * would prove nothing about the adapter under test — and also the hazard:
 * once a real driver backs an adapter, running this suite against a
 * committing sample call (an order, a payment, a send, a paid generation)
 * performs that commitment for real, on every `npm test`. The default
 * behaviour makes the safe path the only path: `sample.toolName` must be a
 * named member of `NON_COMMITTING_SAMPLE_TOOLS`, or the assertion itself
 * fails before `execute` ever runs. Pass `{ allowCommittingSample: true }`
 * to skip that check, and only together with an `adapter` that is a test
 * double for the call this suite makes.
 */
export async function assertAdapterContract(
  adapter: ExternalAdapter,
  sample: AdapterCall,
  options: AssertAdapterContractOptions = {},
): Promise<void> {
  expect(adapter.system.length, 'system must be named').toBeGreaterThan(0);
  expect(adapter.serves.length, 'an adapter that serves nothing is unreachable')
    .toBeGreaterThan(0);

  if (options.allowCommittingSample !== true) {
    expect(
      NON_COMMITTING_SAMPLE_TOOLS.has(sample.toolName),
      `sample.toolName "${sample.toolName}" is not on the list of tools known to commit ` +
        'nothing, and this suite executes it for real. Use a tool from ' +
        'NON_COMMITTING_SAMPLE_TOOLS, or pass { allowCommittingSample: true } with `adapter` ' +
        'set to a test double for this call.',
    ).toBe(true);
  }

  // Never throws, sync or async: an exception escaping an adapter skips the
  // outcome record. `adapter.execute(sample)` itself can throw before ever
  // returning a promise if `execute` is not declared `async`, so the call is
  // inside the `try` rather than only `.catch()`-ed afterwards.
  let result: AdapterResult;
  try {
    result = await adapter.execute(sample);
  } catch (error) {
    throw new Error(`${adapter.system} threw instead of returning a result: ${String(error)}`);
  }

  if (result.ok) {
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('externalId');
  } else {
    expect(typeof result.retryable, 'retryable must be stated').toBe('boolean');
    expect(result.code.length, 'a failure must carry a code').toBeGreaterThan(0);
  }
}
