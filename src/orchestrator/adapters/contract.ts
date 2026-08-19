import { expect } from 'vitest';
import type { AdapterCall, ExternalAdapter } from './types.js';

/**
 * The suite every adapter must pass.
 *
 * One suite rather than per-adapter tests, so a new adapter inherits the
 * properties that matter instead of inventing its own idea of them.
 */
export async function assertAdapterContract(
  adapter: ExternalAdapter,
  sample: AdapterCall,
): Promise<void> {
  expect(adapter.system.length, 'system must be named').toBeGreaterThan(0);
  expect(adapter.serves.length, 'an adapter that serves nothing is unreachable')
    .toBeGreaterThan(0);

  // Never throws: an exception escaping an adapter skips the outcome record.
  const result = await adapter.execute(sample).catch((error: unknown) => {
    throw new Error(
      `${adapter.system} threw instead of returning a result: ${String(error)}`,
    );
  });

  if (result.ok) {
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('externalId');
  } else {
    expect(typeof result.retryable, 'retryable must be stated').toBe('boolean');
    expect(result.code.length, 'a failure must carry a code').toBeGreaterThan(0);
  }
}
