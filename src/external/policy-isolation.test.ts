import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural controls for Stage D's inbound half (Task 12).
 *
 * 1. Nothing an external system says reaches a decision: no module under
 *    `src/policy/` reaches any module under `src/external/`, at any depth —
 *    the same rule `findings` and the business description already carry.
 *    A BFS over the import graph, not one hop: this repo has crossed a "must
 *    not reach" boundary twice through helper chains a one-hop check passed.
 * 2. The paths that read from outside on their own — the webhook, the scan,
 *    the learning loop — never bind a plan, so no `ext.*` step can come of
 *    anything a stranger wrote.
 */
const ROOT = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+'(\.[^']+)\.js'/g)) if (match[1] !== undefined) out.push(match[1]);
  for (const match of source.matchAll(/import\s+'(\.[^']+)\.js'/g)) if (match[1] !== undefined) out.push(match[1]);
  // Dynamic imports load a module just the same.
  for (const match of source.matchAll(/import\(\s*'(\.[^']+)\.js'\s*\)/g)) if (match[1] !== undefined) out.push(match[1]);
  return out;
}

function resolveFrom(file: string, rel: string): string | null {
  const base = join(file, '..', `${rel}.ts`);
  try {
    return statSync(base).isFile() ? base : null;
  } catch {
    return null;
  }
}

function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const rel of importsOf(current)) {
      const resolved = resolveFrom(current, rel);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe('external data never reaches a policy decision', () => {
  it('src/policy/ never reaches src/external/, at any depth', () => {
    const policyFiles = walk(join(ROOT, 'policy')).filter((f) => !f.endsWith('.test.ts'));
    expect(policyFiles.length).toBeGreaterThan(5);

    const reached = reachableFrom(policyFiles);
    const offenders = [...reached].filter((f) => f.includes(`${sep}src${sep}external${sep}`));
    expect(offenders).toEqual([]);

    // Proof the walk walks: an empty or one-hop walk must fail here, not pass.
    expect([...reached].some((f) => f.endsWith(join('src', 'domain', 'action.ts')))).toBe(true);
  });

  it('the walk would catch a policy file that did reach src/external/', () => {
    // The same walk from a file known to import src/external/ must find it.
    const adapter = join(ROOT, 'orchestrator', 'adapters', 'external.ts');
    const reached = reachableFrom([adapter]);
    expect([...reached].some((f) => f.includes(`${sep}src${sep}external${sep}`))).toBe(true);
  });
});

describe('inbound external paths never plan', () => {
  it('the webhook, the scan and the learning loop bind no plan and name no ext.* step', () => {
    for (const name of ['webhook.ts', 'scan.ts', 'learn.ts']) {
      const source = readFileSync(join(ROOT, 'external', name), 'utf8');
      expect(source, name).not.toMatch(/bindPlanToJob|plan-store\.js|runPlan/);
      expect(source, name).not.toMatch(/['"`]ext\.(call|read)['"`]/);
    }
  });
});
