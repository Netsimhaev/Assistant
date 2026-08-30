import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_ALLOWLISTS } from '../charter/capabilities.js';
import { classifiedToolNames } from '../policy/classify.js';
import { INTENT_MEANING, IntentName } from '../domain/reading.js';

const POLICY_DIR = fileURLToPath(new URL('../policy/', import.meta.url));

function policySources(): string[] {
  return readdirSync(POLICY_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(POLICY_DIR, name));
}

/**
 * These are structural invariants, not behaviour tests — the same genre as
 * capabilities.test.ts. Each one blocks a way for the tables that describe
 * the reading domain to fall out of sync with the policy layer and leave a
 * silent hole.
 */
describe('a reading is never a fact the gate reads', () => {
  it('finds policy sources to check, so an empty sweep cannot pass silently', () => {
    expect(policySources().length).toBeGreaterThan(3);
  });

  it('has no module under src/policy/ importing the reading domain', () => {
    const offenders = policySources().filter((path) =>
      /from\s+['"].*domain\/reading\.js['"]/.test(readFileSync(path, 'utf8')),
    );
    // A model-read amount reaching readAmountMinor would let a document set
    // its own ceiling. Findings are advisory and stay out of the gate.
    expect(offenders).toEqual([]);
  });

  it('has no module under src/policy/ naming Finding or IntentName at all', () => {
    const offenders = policySources().filter((path) =>
      /\b(Finding|IntentName)\b/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the reader stays in quarantine', () => {
  it('gives know.reader no classified tool', () => {
    const classified = new Set(classifiedToolNames());
    const tools = AGENT_ALLOWLISTS['know.reader'] ?? [];
    const sideEffecting = tools.filter((tool) => classified.has(tool));
    expect(sideEffecting).toEqual([]);
  });

  it('adds no tool to know.reader for the reading work', () => {
    // Structured output is validated on our side precisely so no new tool has
    // to exist. If this list grows, the quarantine argument has been dropped.
    expect([...(AGENT_ALLOWLISTS['know.reader'] ?? [])].sort()).toEqual(
      ['doc.fetch', 'memory.recall'].sort(),
    );
  });
});

describe('the intent registry', () => {
  it('names no tool', () => {
    // An intent names an outcome. A dot in the name is the shape of a tool id
    // (`mail.send`, `crm.write`) and the surest sign the rule slipped.
    for (const name of IntentName.options) {
      expect(name, `${name} looks like a tool id`).not.toContain('.');
    }
  });

  it('explains every intent it declares', () => {
    expect(Object.keys(INTENT_MEANING).sort()).toEqual([...IntentName.options].sort());
  });
});
