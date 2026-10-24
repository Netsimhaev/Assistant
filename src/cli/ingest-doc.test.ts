import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { runIngestCli } from './ingest-doc.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../documents/fixtures/${name}`, import.meta.url));

const BUSINESS = 'test-business';

let ROOT: string;

beforeEach(async () => {
  await resetDatabase();
  ROOT = await mkdtemp(join(tmpdir(), 'ingest-cli-'));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  // The first test below deliberately omits `documentRoot`, to prove the
  // CLI falls back to the real configured DOCUMENT_ROOT the way a person
  // running it by hand would get — so it is the one thing in this suite
  // that lands outside ROOT's per-test tmpdir and needs its own cleanup.
  // DOCUMENT_ROOT is gitignored (`/documents/`), so this only tidies the
  // working tree, not anything tracked.
  await rm(join(config.documentRoot, BUSINESS), { recursive: true, force: true });
  await closePool();
});

describe('runIngestCli', () => {
  it('prints the document id and its status', async () => {
    const lines: string[] = [];
    await runIngestCli([fixture('tiny.xlsx')], { log: (l) => lines.push(l), businessId: BUSINESS });
    expect(lines.join('\n')).toMatch(/DOC-[0-9A-Z]+/);
    expect(lines.join('\n')).toContain('extracted');
  });

  it('exits with a message when the file does not exist', async () => {
    const lines: string[] = [];
    await expect(
      runIngestCli(['/no/such/file'], { log: (l) => lines.push(l) }),
    ).rejects.toThrow();
  });

  it('gives a Hebrew reason for a missing file rather than the raw ENOENT text', async () => {
    await expect(runIngestCli(['/no/such/file'], { log: () => {} })).rejects.toThrow(
      /הקובץ לא נמצא/,
    );
  });

  it('gives a Hebrew reason when the path is a directory, not a file', async () => {
    await expect(
      runIngestCli([ROOT], { log: () => {}, businessId: BUSINESS, documentRoot: ROOT }),
    ).rejects.toThrow(/אינו קובץ/);
  });

  it('rejects an unsupported --source value with a Hebrew message, not a stack trace', async () => {
    await expect(
      runIngestCli([fixture('tiny.xlsx'), '--source', 'carrier-pigeon'], {
        log: () => {},
        businessId: BUSINESS,
        documentRoot: ROOT,
      }),
    ).rejects.toThrow(/--source/);
  });

  it('requires a path argument', async () => {
    await expect(
      runIngestCli([], { log: () => {}, businessId: BUSINESS, documentRoot: ROOT }),
    ).rejects.toThrow(/שימוש/);
  });

  it('prints the media type and one line per artefact, including the outline', async () => {
    const lines: string[] = [];
    await runIngestCli([fixture('tiny.xlsx')], {
      log: (l) => lines.push(l),
      businessId: BUSINESS,
      documentRoot: ROOT,
    });
    const out = lines.join('\n');
    expect(out).toContain('סוג מדיה:');
    expect(out).toContain('רכיב: outline');
  });

  it('accepts --source and ingests under it', async () => {
    const lines: string[] = [];
    await runIngestCli([fixture('tiny.docx'), '--source', 'mail'], {
      log: (l) => lines.push(l),
      businessId: BUSINESS,
      documentRoot: ROOT,
    });
    const out = lines.join('\n');
    expect(out).toContain('extracted');
    // Asserting only 'extracted' would still pass if --source were parsed
    // and silently discarded (ingestDocument defaults to 'manual') — this
    // is the assertion that actually proves the flag reached the pipeline.
    expect(out).toContain('מקור: mail');
  });

  it('prints the Hebrew rejection reason for an unsupported type instead of throwing', async () => {
    const lines: string[] = [];
    await runIngestCli([fixture('mystery.bin')], {
      log: (l) => lines.push(l),
      businessId: BUSINESS,
      documentRoot: ROOT,
    });
    const out = lines.join('\n');
    expect(out).toContain('rejected');
    expect(out).toContain('סיבת הדחייה:');
    expect(out).toContain('סוג');
  });

  it('prints why an undecodable PDF was stored without being read', async () => {
    const path = join(ROOT, 'broken.pdf');
    await writeFile(
      path,
      Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n')]),
    );
    const lines: string[] = [];
    await runIngestCli([path], { log: (l) => lines.push(l), businessId: BUSINESS, documentRoot: ROOT });
    const out = lines.join('\n');
    expect(out).toContain('סטטוס: stored');
    expect(out).toMatch(/לא נקרא: הפענוח נכשל: /);
  });
});
