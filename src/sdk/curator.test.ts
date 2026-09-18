import { describe, expect, it } from 'vitest';
import { curateWithModel, SYSTEM_PROMPT } from './curator.js';

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

describe('the system prompt', () => {
  /**
   * Defect 1 from the first live run: the prompt named "a list of facts" and
   * never stated `CurationResult`'s actual shape, so the model invented one
   * (a bare array with fields it made up) and `CurationResult.safeParse`
   * refused it. This asserts on the contract's distinctive parts rather than
   * the whole string, so ordinary rewording of the surrounding prose does not
   * break the test — only losing the shape itself should.
   */
  it('states the envelope: a single object with a candidates array', () => {
    expect(SYSTEM_PROMPT).toContain('candidates');
    expect(SYSTEM_PROMPT).toContain('אובייקט');
  });

  it('states the three closed kind values', () => {
    expect(SYSTEM_PROMPT).toContain('entity');
    expect(SYSTEM_PROMPT).toContain('preference');
    expect(SYSTEM_PROMPT).toContain('chunk');
  });

  it('states that attribute is required for preference and forbidden otherwise', () => {
    expect(SYSTEM_PROMPT).toContain('attribute');
    expect(SYSTEM_PROMPT).toContain('חובה');
  });

  it('shows a literal example that itself parses as valid JSON with the right keys', () => {
    const match = SYSTEM_PROMPT.match(/\{"candidates":\[.*?\]\}/);
    expect(match).not.toBeNull();
    const parsed: unknown = JSON.parse(match![0]);
    expect(parsed).toHaveProperty('candidates');
  });
});
