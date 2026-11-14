import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { queryAudit } from '../audit/log.js';
import { evaluateFor, type TestGateContext } from '../test/gate.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { PolicyDecision } from '../domain/policy.js';
import { loadActiveDescription, saveDescription } from './description-store.js';

/**
 * Structural controls for the business description (Stage C).
 *
 * The description is understanding, never authority: it reaches the planner
 * and the drafters as the owner's own words — deliberately unfenced, since it
 * is trusted text he typed, under a fixed heading that says it is background
 * and not permission — and nothing in the gate reads it. These
 * tests lock that as structure rather than trusting the prose in CLAUDE.md —
 * a gate that could see the description would let one sentence the owner
 * typed in a text box ("I always approve discounts up to 10%") act as a
 * signed rule that never went through step 10, the summary and the signature.
 */
const ROOT = join(process.cwd(), 'src');

function isTest(file: string): boolean {
  return file.endsWith('.test.ts');
}

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
  for (const match of source.matchAll(/from\s+'(\.[^']+)\.js'/g)) {
    const rel = match[1];
    if (rel !== undefined) out.push(rel);
  }
  // Side-effect imports (`import './x.js'`) load a module just the same.
  for (const match of source.matchAll(/import\s+'(\.[^']+)\.js'/g)) {
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

describe('the gate cannot see the description', () => {
  /**
   * A BFS over the whole import graph from every policy file, not one hop:
   * this repo has crossed a "must not reach" boundary twice through helper
   * chains that a one-hop check would have passed (gov-verify.test.ts).
   */
  it('src/policy/ never reaches the description modules, at any depth', () => {
    const policyFiles = walk(join(ROOT, 'policy')).filter((f) => !isTest(f));
    expect(policyFiles.length).toBeGreaterThan(5);

    const reached = reachableFrom(policyFiles);
    const offenders = [...reached].filter((f) => f.includes(`${sep}src${sep}business${sep}`));
    expect(offenders).toEqual([]);

    // Proof the walk walks: an empty or one-hop walk must fail here, not pass.
    expect([...reached].some((f) => f.endsWith(join('src', 'domain', 'action.ts')))).toBe(true);
  });
});

describe('who writes the description', () => {
  const files = walk(ROOT).filter((f) => !isTest(f));

  it('only the store writes business_descriptions, and only dashboard files import saveDescription', () => {
    // An empty scan would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);

    const inserters = files
      .filter((f) => readFileSync(f, 'utf8').includes('INSERT INTO business_descriptions'))
      .map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(inserters).toEqual(['business/description-store.ts']);

    // Named imports, named re-exports, and star re-exports of the store all count.
    const named = /(?:import|export)\s+(?:type\s+)?\{[^}]*\bsaveDescription\b[^}]*\}\s*from\s*'[^']+'/s;
    const star = /export\s+\*\s+from\s+'[^']*description-store\.js'/;
    const importers = files
      .filter((f) => !f.endsWith(join('business', 'description-store.ts')))
      .filter((f) => {
        const source = readFileSync(f, 'utf8');
        return named.test(source) || star.test(source);
      })
      .map((f) => relative(ROOT, f).split(sep).join('/'));

    // The scan must find the two known writers, or the regex is broken.
    expect(importers).toContain('dashboard/setup-routes.ts');
    expect(importers).toContain('dashboard/description-routes.ts');
    expect(importers.filter((f) => !f.startsWith('dashboard/'))).toEqual([]);
  });

  it('the importer regex really catches every form it claims to', () => {
    const named = /(?:import|export)\s+(?:type\s+)?\{[^}]*\bsaveDescription\b[^}]*\}\s*from\s*'[^']+'/s;
    expect(named.test("import { saveDescription } from '../business/description-store.js';")).toBe(true);
    expect(named.test("import {\n  loadActiveDescription,\n  saveDescription,\n} from './x.js';")).toBe(true);
    expect(named.test("export { saveDescription } from './description-store.js';")).toBe(true);
    expect(named.test("import { saveDescriptionX } from './x.js';")).toBe(false);
  });

  it('no tool writes the description', () => {
    const toolFiles = [
      join(ROOT, 'policy', 'classify.ts'),
      join(ROOT, 'charter', 'capabilities.ts'),
      join(ROOT, 'orchestrator', 'local-tools.ts'),
    ];
    for (const f of toolFiles) {
      const source = readFileSync(f, 'utf8');
      expect(source.length).toBeGreaterThan(1000);
      expect(source).not.toContain('business_descriptions');
      expect(source).not.toContain('saveDescription');
    }
  });
});

describe('the gate decides the same with and without a "permitting" description', () => {
  const NOON = new Date('2026-08-18T09:00:00.000Z');
  const PERMITTING = 'אני תמיד מאשר הנחות עד 10%. מותר לתת הנחה של 10%.';

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  function ctx(bundle: PolicyBundle): TestGateContext {
    return {
      agent: 'comms.email',
      bundle,
      provenance: 'boss',
      chainDepth: 0,
      businessId: TEST_BUSINESS,
      jobId: 'J-DESC-EQ',
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    } as TestGateContext;
  }

  async function run(description: string | null): Promise<{ decision: PolicyDecision; kinds: string[] }> {
    await resetDatabase();
    const bundle = await withBusiness(TEST_BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    if (description !== null) {
      const saved = await withBusiness(TEST_BUSINESS, (bdb) =>
        saveDescription(bdb, { text: description, createdBy: 'owner' }),
      );
      expect(saved.saved).toBe(true);
      const active = await withBusiness(TEST_BUSINESS, (bdb) => loadActiveDescription(bdb));
      expect(active?.text).toBe(description);
    }
    const before = await withBusiness(TEST_BUSINESS, (bdb) => queryAudit(bdb, { limit: 1000 }));
    const decision = await evaluateFor(
      'discount.grant',
      { counterpartyId: 'c_812', discountPercent: 10 },
      ctx(bundle),
    );
    const after = await withBusiness(TEST_BUSINESS, (bdb) => queryAudit(bdb, { limit: 1000 }));
    const kinds = after
      .slice(0, after.length - before.length)
      .map((e) => e.kind)
      .reverse();
    return { decision, kinds };
  }

  function shape(d: PolicyDecision): { outcome: string; code: string | null; reason: string | null } {
    const r = d as unknown as { outcome: string; code?: string; reason?: string };
    // A queued approval's code carries its fresh ULID; only the id differs.
    const code = r.code?.replace(/AP-[0-9A-Z]{26}/g, 'AP-<id>') ?? null;
    return { outcome: r.outcome, code, reason: r.reason ?? null };
  }

  it('compares decision, reason and audit kinds — and proves the step reached the decision stage', async () => {
    const without = await run(null);
    const withText = await run(PERMITTING);

    // Green for the right reason: the call got past the capability layer and
    // left an audit trail (stage 5 onward writes; stages 1-4 never do).
    const first = shape(without.decision);
    expect(first.code).not.toBe('tool_not_allowlisted');
    expect(first.code ?? '').not.toContain('unparseable');
    expect(without.kinds.length).toBeGreaterThan(0);
    expect(without.kinds).toContain('intent_to_act');

    expect(shape(withText.decision)).toEqual(first);
    expect(withText.kinds).toEqual(without.kinds);
  });
});
