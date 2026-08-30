import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { guardZipArchive, ingestDocument } from './ingest.js';
import { loadArtifacts } from './store.js';
import type { OutlineContent } from './types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const stubChild = (name: string) =>
  fileURLToPath(new URL(`./fixtures/stub-children/${name}`, import.meta.url));

const BUSINESS = 'test-business';

let ROOT: string;
let OPTS: { businessId: string; documentRoot: string };

beforeEach(async () => {
  await resetDatabase();
  ROOT = await mkdtemp(join(tmpdir(), 'ingest-root-'));
  OPTS = { businessId: BUSINESS, documentRoot: ROOT };
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await closePool();
});

describe('ingestDocument', () => {
  it('stores, extracts and records in one pass', async () => {
    const doc = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS);
    expect(doc.status).toBe('extracted');
    const artifacts = await loadArtifacts(doc.documentId, OPTS);
    expect(artifacts.some((a) => a.kind === 'outline')).toBe(true);
    // The outline is real, not a placeholder — spot-check it read a real
    // sheet name out of the fixture used by outline.test.ts/xlsx.test.ts.
    const outline = artifacts.find((a) => a.kind === 'outline');
    const content = outline?.content as OutlineContent;
    expect(content.parts.map((p) => p.name)).toContain('מחירים');
  });

  it('rejects an unsupported type and keeps the file anyway', async () => {
    const doc = await ingestDocument({ path: fixture('mystery.bin'), source: 'manual' }, OPTS);
    expect(doc.status).toBe('rejected');
    expect(doc.reason).toContain('סוג');
    expect(existsSync(join(ROOT, doc.storedPath))).toBe(true);
  });

  it('never lets the original name become a path', async () => {
    const doc = await ingestDocument(
      { path: fixture('tiny.xlsx'), source: 'manual', originalName: '../../escape.xlsx' },
      OPTS,
    );
    expect(doc.storedPath).not.toContain('..');
    expect(doc.originalName).toBe('../../escape.xlsx');
    // Actually landed under the document root, not escaped from it.
    expect(existsSync(join(ROOT, doc.storedPath))).toBe(true);
  });

  it('returns the same document for the same bytes, without a second file', async () => {
    const first = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS);
    const second = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'mail' }, OPTS);
    expect(second.documentId).toBe(first.documentId);
    // The first call's source wins — the second call did not overwrite it.
    expect(second.source).toBe('manual');

    const businessDir = join(ROOT, BUSINESS);
    const documentDirs = await readdir(businessDir);
    expect(documentDirs).toHaveLength(1);
  });

  it('resolves two concurrent ingests of identical bytes to one document, one file', async () => {
    // Decision 3 of the task brief: the two-statement findBySha-then-insert
    // form is a real race where both callers read nothing and both insert.
    // Firing both ingests at once, unawaited, is what actually exercises
    // insertOrGetDocument's single atomic INSERT ... ON CONFLICT rather than
    // merely trusting its docblock.
    const [first, second] = await Promise.all([
      ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS),
      ingestDocument({ path: fixture('tiny.xlsx'), source: 'api' }, OPTS),
    ]);
    expect(second.documentId).toBe(first.documentId);

    const businessDir = join(ROOT, BUSINESS);
    const documentDirs = await readdir(businessDir);
    expect(documentDirs).toHaveLength(1);
  });

  it('rejects a document whose extension lies about a non-ZIP file, using the sniffed type', async () => {
    // small.txt is plain text wearing no zip signature; naming it .xlsx must
    // not fool the pipeline into treating it as a spreadsheet — sniffMediaType
    // (media-type.test.ts) already proves the byte-level rule; this proves
    // ingestDocument actually honours it end to end rather than trusting the
    // caller-supplied name anywhere in its own logic.
    const doc = await ingestDocument(
      { path: fixture('small.txt'), source: 'manual', originalName: 'prices.xlsx' },
      OPTS,
    );
    // A non-zip file named .xlsx sniffs as plain text, which IS supported
    // (passthrough) — so it must extract successfully as text, not be
    // rejected, and its stored extension must reflect the real type.
    expect(doc.status).toBe('extracted');
    expect(doc.storedPath.endsWith('.txt')).toBe(true);
  });

  it('rejects a hostile archive before any child process runs, and keeps the file', async () => {
    // bomb.xlsx (archive-guard.test.ts): a genuine ZIP with one entry that
    // inflates past the 200MB ceiling. basename(path) is 'bomb.xlsx', which
    // sniffMediaType recognises as an xlsx container.
    const doc = await ingestDocument({ path: fixture('bomb.xlsx'), source: 'manual' }, OPTS);
    expect(doc.status).toBe('rejected');
    expect(doc.reason).toMatch(/מתנפח|בייטים/);
    expect(existsSync(join(ROOT, doc.storedPath))).toBe(true);
    const artifacts = await loadArtifacts(doc.documentId, OPTS);
    expect(artifacts).toHaveLength(0);
  });

  it('rejects a file over the 25MB size cap without ever writing it to disk', async () => {
    const bigDir = await mkdtemp(join(tmpdir(), 'ingest-src-'));
    const bigPath = join(bigDir, 'big.txt');
    try {
      await writeFile(bigPath, Buffer.alloc(25 * 1024 * 1024 + 1, 0x61));
      const doc = await ingestDocument({ path: bigPath, source: 'manual' }, OPTS);
      expect(doc.status).toBe('rejected');
      expect(doc.reason).toContain('תקרת הגודל');
      // The whole point of checking the cap before the write: an oversized
      // file must never reach disk, not merely never reach the extractor.
      // Checking only "runExtractor never ran" (the previous version of
      // this test) would still pass if the bytes had been written first —
      // this is the assertion the Task 10 review's Critical finding said
      // was missing.
      expect(existsSync(join(ROOT, doc.storedPath))).toBe(false);
      // Nothing under the document's own directory either — mkdir itself
      // must not have run, not just writeFile.
      expect(existsSync(join(ROOT, BUSINESS, doc.documentId))).toBe(false);
    } finally {
      await rm(bigDir, { recursive: true, force: true });
    }
  });

  it('records a killed, wedged child as rejected (extractor_timeout)', async () => {
    const doc = await ingestDocument(
      { path: fixture('small.txt'), source: 'manual' },
      { ...OPTS, runExtractorOptions: { timeoutMs: 200, childPath: stubChild('hang.ts') } },
    );
    expect(doc.status).toBe('rejected');
    expect(doc.reason?.length).toBeGreaterThan(0);
  }, 10_000);

  it('records a child that floods stdout as rejected (extractor_output_too_large)', async () => {
    const doc = await ingestDocument(
      { path: fixture('huge.txt'), source: 'manual' },
      { ...OPTS, runExtractorOptions: { maxOutputBytes: 1024 } },
    );
    expect(doc.status).toBe('rejected');
    expect(doc.reason?.length).toBeGreaterThan(0);
  });

  it('records a genuine engine-level crash as rejected (extractor_crashed)', async () => {
    const doc = await ingestDocument(
      { path: fixture('small.txt'), source: 'manual' },
      {
        ...OPTS,
        runExtractorOptions: { memoryMb: 32, childPath: stubChild('oom.ts'), timeoutMs: 15_000 },
      },
    );
    expect(doc.status).toBe('rejected');
    expect(doc.reason).toContain('קרס');
  }, 20_000);

  it('records a controlled child failure as rejected (extractor_failed)', async () => {
    const doc = await ingestDocument(
      { path: fixture('small.txt'), source: 'manual' },
      { ...OPTS, runExtractorOptions: { childPath: stubChild('fail.ts') } },
    );
    expect(doc.status).toBe('rejected');
    expect(doc.reason).toContain('נכשל');
  });

  it('extracts a real docx end to end', async () => {
    const doc = await ingestDocument({ path: fixture('tiny.docx'), source: 'manual' }, OPTS);
    expect(doc.status).toBe('extracted');
    const artifacts = await loadArtifacts(doc.documentId, OPTS);
    expect(artifacts.some((a) => a.kind === 'text')).toBe(true);
    expect(artifacts.some((a) => a.kind === 'outline')).toBe(true);
  });

  it('extracts a real csv end to end', async () => {
    const doc = await ingestDocument({ path: fixture('semicolons.csv'), source: 'manual' }, OPTS);
    expect(doc.status).toBe('extracted');
    const artifacts = await loadArtifacts(doc.documentId, OPTS);
    expect(artifacts.some((a) => a.kind === 'table')).toBe(true);
  });

  it('propagates a genuine fault (bad path) rather than recording a rejection', async () => {
    await expect(
      ingestDocument({ path: join(ROOT, 'no-such-file'), source: 'manual' }, OPTS),
    ).rejects.toThrow();
  });
});

describe('guardZipArchive', () => {
  it('turns a vanished/unreadable file into a Hebrew rejection reason rather than an uncaught rejection', async () => {
    const verdict = await guardZipArchive(join(ROOT, 'does', 'not', 'exist.xlsx'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('passes through a clean archive', async () => {
    const doc = await ingestDocument({ path: fixture('tiny.xlsx'), source: 'manual' }, OPTS);
    const verdict = await guardZipArchive(join(ROOT, doc.storedPath));
    expect(verdict.ok).toBe(true);
  });
});
