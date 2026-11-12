/**
 * `withNoBusiness` (pool.ts) hands out an app-pool connection with NO business
 * context. It exists for one thing: the server-wide unknown-login throttle,
 * reached by the dashboard's login route before any business is known. Any
 * other caller is a connection outside the wall that ordinary code should
 * never be holding, so the importers are pinned by name — a recursive scan of
 * `src/`, not a hand-written list of folders.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** The only modules allowed to import `withNoBusiness`. */
const ALLOWED = new Set(['dashboard/server.ts']);

/** An import statement (possibly multi-line) that names `withNoBusiness`. */
const IMPORTS_IT = /import\s*(?:type\s*)?\{[^}]*\bwithNoBusiness\b[^}]*\}\s*from\s*['"][^'"]+['"]/;

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

describe('withNoBusiness import invariant', () => {
  it('the pattern catches the import shapes it must', () => {
    expect(IMPORTS_IT.test(`import { withNoBusiness } from '../db/pool.js';`)).toBe(true);
    expect(IMPORTS_IT.test(`import {\n  withBusiness,\n  withNoBusiness,\n  type BusinessDb,\n} from '../db/pool.js';`)).toBe(true);
    expect(IMPORTS_IT.test(`import { withBusiness } from '../db/pool.js';`)).toBe(false);
  });

  it('only the dashboard server imports it', () => {
    const files = sourceFiles(SRC);
    // An empty scan that passes is not a control.
    expect(files.length).toBeGreaterThan(300);
    const importers = files
      .filter((file) => IMPORTS_IT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
