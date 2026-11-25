import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `documents.public_for` decides which documents a stranger-facing auto reply
 * may quote from (phase 2, package 1). Only the owner marks a document public,
 * and only through `src/whatsapp/public-documents.ts` — the dashboard screen
 * calls it. A second writer (a tool handler, the conductor, a mail path) would
 * let something other than the owner's choice widen what goes out alone.
 * Checked by reading the source: the property is about WHO writes the column.
 */
const SRC = join(process.cwd(), 'src');
const WRITER = 'whatsapp/public-documents.ts';

// `UPDATE documents SET public_for`, any `public_for =` assignment in SQL, and
// an INSERT into documents that names the column.
const WRITES = [
  /\bSET\s+public_for\b/i,
  /\bpublic_for\s*=(?!=)/i,
  /INSERT\s+INTO\s+documents\b[^;`]*\bpublic_for\b/i,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

function writesPublicFor(source: string): boolean {
  return WRITES.some((re) => re.test(source));
}

describe('documents.public_for has one writer', () => {
  it('the patterns catch planted writes and spare the read shapes', () => {
    for (const planted of [
      'UPDATE documents SET public_for = $3 WHERE business_id = $1',
      'UPDATE documents\n   SET public_for = NULL',
      "UPDATE documents SET status = 'x', public_for = 'both'",
      'INSERT INTO documents (business_id, document_id, public_for) VALUES ($1, $2, $3)',
    ]) {
      expect(writesPublicFor(planted), planted).toBe(true);
    }
    for (const spared of [
      'SELECT document_id, public_for FROM documents',
      'interface Row { public_for: PublicFor | null }',
      "WHERE public_for IN ($2, 'both')",
    ]) {
      expect(writesPublicFor(spared), spared).toBe(false);
    }
  });

  it('only src/whatsapp/public-documents.ts writes it', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(100); // positive control: the scan found the source tree
    const writers = files
      .filter((f) => writesPublicFor(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split('\\').join('/'));
    expect(writers).toEqual([WRITER]);
  });
});
