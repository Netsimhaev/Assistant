import { describe, expect, it } from 'vitest';
import { curateWithModel } from './curator.js';

describe('the curator call', () => {
  /**
   * The suite runs with NODE_ENV=test and this machine carries a real
   * ANTHROPIC_API_KEY. A test that reached the real call would bill the owner
   * and would do it silently; two review rounds already caught exactly that on
   * the planner. The refusal is mechanical so it does not depend on every
   * future test remembering to inject a fake.
   */
  it('refuses to run under NODE_ENV=test', async () => {
    await expect(
      curateWithModel({ text: 'x', touched: { recipients: [], entityIds: [] } }),
    ).rejects.toThrow(/NODE_ENV=test/);
  });
});
