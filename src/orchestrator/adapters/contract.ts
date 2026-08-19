import { expect } from 'vitest';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

/**
 * The suite every adapter must pass.
 *
 * One suite rather than per-adapter tests, so a new adapter inherits the
 * properties that matter instead of inventing its own idea of them.
 *
 * `sample` is executed for real — that is the point, since a mocked call
 * would prove nothing about the adapter under test — and also the hazard:
 * `sample` must never be a committing action (an order, a payment, a send).
 * Once a real driver backs an adapter, `npm test` running this suite against
 * a committing sample call would perform that commitment for real, every
 * test run.
 */
export async function assertAdapterContract(
  adapter: ExternalAdapter,
  sample: AdapterCall,
): Promise<void> {
  expect(adapter.system.length, 'system must be named').toBeGreaterThan(0);
  expect(adapter.serves.length, 'an adapter that serves nothing is unreachable')
    .toBeGreaterThan(0);

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
