import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { isValidBusinessId, RESERVED_BUSINESS_IDS } from '../db/pool.js';
import { businessDocumentRoot, businessFolderUnder, businessSaveRoot, isFolderOfBusiness } from './paths.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

async function productionSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionSources(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Literal first segments placed directly under one of the three server roots:
 * `join(<root>, '<literal>', …)`, and a stored path that begins with one —
 * `join('<literal>', …)`, which is a path relative to `DOCUMENT_ROOT` (the
 * shape `production/loop.ts` stores `produced/<businessId>/…` in).
 */
const ROOT_JOIN =
  /join\(\s*(?:config\.)?(?:documentRoot|documentInboxRoot|documentSaveRoot|inboxRoot|saveRoot)\s*,\s*['"`]([^'"`$/\\]+)['"`/]/g;
const RELATIVE_JOIN = /join\(\s*['"`]([^'"`$/\\]+)['"`]\s*,/g;

describe('business folders on the server (spec §5.8)', () => {
  it("isValidBusinessId('produced') is false — it is the parent of every business's produced files", () => {
    expect(RESERVED_BUSINESS_IDS.has('produced')).toBe(true);
    expect(isValidBusinessId('produced')).toBe(false);
    // Control: the same shape, not reserved, is valid.
    expect(isValidBusinessId('producer')).toBe(true);
    expect(() => businessDocumentRoot('produced')).toThrow(/invalid business id/);
  });

  it('every literal first segment under a server root is a reserved business id', async () => {
    const found = new Map<string, string>();
    for (const file of await productionSources(SRC)) {
      const text = await readFile(file, 'utf8');
      for (const pattern of [ROOT_JOIN, RELATIVE_JOIN]) {
        for (const match of text.matchAll(pattern)) {
          const literal = match[1];
          if (literal !== undefined) found.set(literal, relative(SRC, file).split(sep).join('/'));
        }
      }
    }
    // Not vacuous: the scan must see the one we know about.
    expect(found.get('produced')).toBeDefined();
    const unreserved = [...found].filter(([literal]) => !RESERVED_BUSINESS_IDS.has(literal));
    // A new literal top-level folder under a root has to be reserved, or a
    // business named after it owns the folder of every other business.
    expect(unreserved).toEqual([]);
  });

  it('builds each business folder under its root, and checks the last segment', () => {
    expect(businessDocumentRoot('alpha-shop')).toBe(join(config.documentRoot, 'alpha-shop'));
    expect(businessFolderUnder('/srv/inbox', 'alpha-shop')).toBe(join('/srv/inbox', 'alpha-shop'));
    expect(businessSaveRoot('alpha-shop')).toBe(join(config.documentSaveRoot ?? 'unset', 'alpha-shop'));
    expect(() => businessFolderUnder('/srv/inbox', '../escape')).toThrow(/invalid business id/);
    expect(isFolderOfBusiness(join('/srv/inbox', 'alpha-shop'), 'alpha-shop')).toBe(true);
    expect(isFolderOfBusiness('/srv/inbox', 'alpha-shop')).toBe(false);
    expect(isFolderOfBusiness(join('/srv/inbox', 'beta-shop'), 'alpha-shop')).toBe(false);
  });
});
