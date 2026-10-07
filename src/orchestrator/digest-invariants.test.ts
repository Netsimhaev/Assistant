import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The digest contains no model call, and this walks the whole import graph
 * rather than one hop.** Spec §2 decision 2.
 *
 * One-hop checks are not enough here and this repo has the scar to prove it:
 * on the WhatsApp branch the equivalent boundary (`gov.verify` must not reach a
 * module that reads document content) was crossed TWICE through independent
 * helper chains before anyone noticed, and both would have passed a check that
 * only read the file's own import lines.
 *
 * NOTE: the walk is pointed at `digest-render.ts` because `digest-run.ts` does
 * not exist yet — Task 6 creates it. Task 6 must move this entry point to
 * `digest-run.ts` once that file exists.
 */
const ROOT = join(process.cwd(), 'src');

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+'(\.[^']+)\.js'/g)) {
    const rel = match[1];
    if (rel !== undefined) out.push(rel);
  }
  return out;
}

function resolveFrom(file: string, rel: string): string | null {
  const base = join(file, '..', `${rel}.ts`);
  try {
    if (statSync(base).isFile()) return base;
  } catch {
    return null;
  }
  return null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
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

describe('the digest calls no model', () => {
  it('cannot reach a module that talks to a model, at any depth', () => {
    // NOTE: must move to `digest-run.ts` once Task 6 creates it.
    const reached = reachableFrom(join(ROOT, 'orchestrator', 'digest-render.ts'));

    // Every `src/sdk/*` module is a model caller or a step away from one.
    const offenders = [...reached].filter((f) => f.includes(join('src', 'sdk')));
    expect(offenders).toEqual([]);
  });

  /**
   * The walk must be proved to actually walk. Without this, a future edit that
   * breaks `resolveFrom` leaves the test green over a graph of ONE file — green
   * for the wrong reason, which is the failure this project names repeatedly.
   */
  it('really traverses more than the entry file', () => {
    const reached = reachableFrom(join(ROOT, 'orchestrator', 'digest-render.ts'));
    expect(reached.size).toBeGreaterThan(5);
    expect([...reached].some((f) => f.endsWith(join('orchestrator', 'digest-render.ts')))).toBe(true);
  });
});
