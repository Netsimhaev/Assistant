import { expect } from 'vitest';
import { classifyAction } from '../../policy/classify.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export interface AssertAdapterContractOptions {
  /**
   * Skip the "sample is not a committing action" check.
   *
   * Set this only when `adapter` is a test double, never against a real
   * driver: the suite executes `sample` for real, and an adapter whose every
   * tool is classified (the mail adapter, for one) can only supply a sample
   * that clears `classifyAction` by pointing `execute` at a double instead of
   * the live implementation for this one call.
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
 * committing sample call (an order, a payment, a send) performs that
 * commitment for real, on every `npm test`. The default behaviour makes the
 * safe path the only path: `sample.toolName` must classify as `null`
 * (`classifyAction`, `src/policy/classify.ts` — read-only or unclassified),
 * or the assertion itself fails before `execute` ever runs. Pass
 * `{ allowCommittingSample: true }` to skip that check, and only together
 * with an `adapter` that is a test double for the call this suite makes.
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
      classifyAction(sample.toolName),
      `sample.toolName "${sample.toolName}" is a committing action and this suite executes it ` +
        'for real. Use a non-committing sample tool, or pass { allowCommittingSample: true } ' +
        'with `adapter` set to a test double for this call.',
    ).toBeNull();
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
