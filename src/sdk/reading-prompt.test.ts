import { describe, expect, it } from 'vitest';
import { INTENT_MEANING, IntentName } from '../domain/reading.js';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from '../charter/compile.js';
import { READING_PROMPT_VERSION, buildReadingSystemPrompt } from './reading-prompt.js';

const bundle = compileCharter(buildCharter());

describe('buildReadingSystemPrompt', () => {
  it('names every intent in the registry', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    for (const name of IntentName.options) {
      expect(prompt, `${name} missing from the prompt`).toContain(name);
    }
  });

  it('carries each intent\'s meaning, not just its identifier', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    for (const meaning of Object.values(INTENT_MEANING)) {
      expect(prompt).toContain(meaning);
    }
  });

  it('opens with the charter the owner signed', () => {
    const prompt = buildReadingSystemPrompt(bundle);
    expect(prompt.startsWith(bundle.promptFragments['know.reader'])).toBe(true);
  });

  it('tells the reader it may not invent an address', () => {
    expect(buildReadingSystemPrompt(bundle)).toContain('unresolved');
  });

  it('is byte-identical across calls, so the cached prefix survives', () => {
    expect(buildReadingSystemPrompt(bundle)).toBe(buildReadingSystemPrompt(bundle));
  });

  it('has a version that is a declared constant, not a hash', () => {
    // A hash would change on a comma and invalidate every stored reading while
    // the question asked stayed identical.
    expect(READING_PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
