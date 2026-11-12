/**
 * Spec §5.7 — the cross-business operations are declared, by name, and run on
 * the platform pool (`src/db/platform-pool.ts`, the BYPASSRLS login). That
 * pool is a connection past the row-level wall, so who may hold one is pinned
 * here: `src/tenancy/` (where the named operations live), `src/cli/` (the
 * operator's tools, key rotation among them), `src/db/` itself, and the
 * scheduler's entry point, which lists the active businesses. Anything else
 * that needs a cross-business answer asks `src/tenancy/platform.ts` for it.
 *
 * A recursive scan of `src/` (tests and `src/test/` excluded) — the same shape
 * as the erasure and `withNoBusiness` import invariants, never a hand-written
 * list of folders to look in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function allowed(rel: string): boolean {
  return (
    rel.startsWith('tenancy/') ||
    rel.startsWith('cli/') ||
    rel.startsWith('db/') ||
    rel === 'orchestrator/run-scheduler.ts'
  );
}

/** An import (static, `import type`, re-export or dynamic) whose specifier ends in `platform-pool.js`. */
const IMPORTS_IT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"][^'"]*platform-pool\.js['"]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === join(SRC, 'test')) continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('platform pool import invariant (spec §5.7)', () => {
  it('the pattern catches the import shapes it must', () => {
    expect(IMPORTS_IT.test(`import { withPlatform } from '../db/platform-pool.js';`)).toBe(true);
    expect(IMPORTS_IT.test(`import {\n  closePlatformPool,\n} from '../db/platform-pool.js';`)).toBe(true);
    expect(IMPORTS_IT.test(`const m = await import('../db/platform-pool.js');`)).toBe(true);
    expect(IMPORTS_IT.test(`export { withPlatform } from './platform-pool.js';`)).toBe(true);
    // A comment that names the file is not an import.
    expect(IMPORTS_IT.test(' * (`src/db/platform-pool.ts`). Required outside tests')).toBe(false);
    expect(IMPORTS_IT.test(`import { withBusiness } from '../db/pool.js';`)).toBe(false);
  });

  it('only tenancy, the CLIs, db and the scheduler entry point import it', () => {
    const files = sourceFiles(SRC);
    // An empty scan that passes is not a control.
    expect(files.length).toBeGreaterThan(300);
    const importers = files
      .filter((file) => IMPORTS_IT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !allowed(file))).toEqual([]);
  });
});
