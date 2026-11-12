/**
 * Spec §5.2 — there is no default business anywhere in production code.
 *
 * Deleting `config.businessId` was the control: the compiler found every place
 * that read it. This scan is what keeps it deleted — a recursive text scan of
 * `src/` (tests and `src/test/` excluded) that fails on the shapes a default
 * business comes back in: the config field, the env var, the unscoped pool
 * and its transaction helper, the migration marker, and a `businessId`
 * parameter that is optional or defaulted.
 *
 * Exemptions are by name, in `ALLOWED` below, never by folder — and there are
 * none today. A file that needs one must be named here with its reason.
 *
 * Comments are scanned too, on purpose: a docblock that still says
 * "defaults to `config.businessId`" describes a fallback that no longer
 * exists, and a reader who believes it writes the fallback back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

interface Pattern {
  name: string;
  regex: RegExp;
  /** A string the regex must match — proof the scan can see this shape at all. */
  sample: string;
  /** A string the regex must NOT match — proof it is not so broad it flags everything. */
  near: string;
}

const PATTERNS: readonly Pattern[] = [
  { name: 'config.businessId', regex: /\bconfig\.businessId\b/, sample: 'const b = config.businessId;', near: 'const b = db.businessId;' },
  { name: 'BUSINESS_ID', regex: /\bBUSINESS_ID\b/, sample: "required('BUSINESS_ID')", near: 'const BUSINESS_ID_SHAPE = /x/;' },
  { name: 'getPool(', regex: /\bgetPool\(/, sample: 'await getPool().query(sql);', near: 'getMigratorPool()' },
  { name: 'withTransaction(', regex: /\bwithTransaction\(/, sample: 'await withTransaction(async (tx) => {});', near: 'await withBusinessTransaction(id, fn);' },
  // Spelled in two halves, so this file is not itself the one marker left in `src/`.
  { name: 'TENANCY' + '-TODO', regex: new RegExp('TENANCY' + '-TODO'), sample: 'x(); // TENANCY' + '-TODO(task 12)', near: 'x(); // TODO' },
  { name: 'businessId?:', regex: /\bbusinessId\s*\?\s*:/, sample: 'options: { businessId?: string }', near: 'options: { businessId: string }' },
  { name: 'businessId: string =', regex: /\bbusinessId\s*:\s*string\s*=(?![=>])/, sample: "function f(businessId: string = 'dev') {}", near: 'function f(businessId: string) {}' },
  {
    name: 'businessId = (parameter default)',
    // After `(`, `,` or `{` (a parameter list or a destructuring pattern), so
    // `const businessId = db.businessId;` — a binding, not a default — passes,
    // and so does `, businessId=${id}` inside a message template.
    regex: /[(,{]\s*businessId\s*=(?![=>])(?!\$\{)/,
    sample: 'function f(a: number,\n  businessId = config.x) {}',
    near: 'throw new Error(`no row for id=${id}, businessId=${businessId}`);',
  },
];

/**
 * Files exempt from a named pattern, with the reason. Empty: nothing in
 * production code needs a default business. Add an entry only with a reason a
 * reviewer can disagree with.
 */
const ALLOWED: ReadonlyMap<string, readonly string[]> = new Map();

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

describe('no default business (spec §5.2)', () => {
  it('every pattern catches the shape it names, and only that', () => {
    for (const pattern of PATTERNS) {
      expect(pattern.regex.test(pattern.sample), pattern.name).toBe(true);
      expect(pattern.regex.test(pattern.near), `${pattern.name} (near miss)`).toBe(false);
    }
  });

  it('no production file carries a default business', () => {
    const files = sourceFiles(SRC);
    // An empty scan that passes is not a control.
    expect(files.length).toBeGreaterThan(300);
    const found: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      for (const pattern of PATTERNS) {
        if (ALLOWED.get(rel)?.includes(pattern.name) === true) continue;
        if (pattern.regex.test(text)) found.push(`${rel}: ${pattern.name}`);
      }
    }
    expect(found).toEqual([]);
  });
});
