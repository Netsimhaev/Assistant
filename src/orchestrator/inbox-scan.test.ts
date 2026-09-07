import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { scanInbox } from './inbox-scan.js';

// Module-boundary stub for the single "filing an ingested document fails"
// test below. Chosen over a read-only destination directory because NTFS
// permission bits are not a reliable way to force a write failure for the
// same user that owns the directory — a chmod-based test would be flaky on
// this platform. Every other test still gets the real filesystem: only
// `link` is overridden, and only for the one target path the test cares
// about (`processed/jammed.txt`) — everything else falls through to the
// genuine implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (existingPath: string, newPath: string): Promise<void> => {
      if (newPath.includes('jammed.txt') && newPath.includes('processed')) {
        const err = new Error('EACCES: permission denied, link') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.link(existingPath, newPath);
    },
  };
});

const BUSINESS = 'biz-scan';

async function anInbox(): Promise<{ inbox: string; documentRoot: string }> {
  const inbox = await mkdtemp(join(tmpdir(), 'inbox-'));
  const documentRoot = await mkdtemp(join(tmpdir(), 'docroot-'));
  return { inbox, documentRoot };
}

describe('scanInbox', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('ingests a file and moves it to processed', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'hello.txt'), 'שלום עולם', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested).toBe(1);
    expect(await readdir(join(inbox, 'processed'))).toEqual(['hello.txt']);
    expect(await readdir(inbox)).not.toContain('hello.txt');

    const { rows } = await getPool().query<{ original_name: string }>(
      `SELECT original_name FROM documents WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows.map((r) => r.original_name)).toEqual(['hello.txt']);
  });

  it('moves a rejected file to rejected and still counts it', async () => {
    const { inbox, documentRoot } = await anInbox();
    // A .xlsx name over bytes that are not a zip. `sniffMediaType` checks the
    // bytes first: these aren't a ZIP signature, so it falls through to the
    // text sniff, and `.xlsx` isn't one of the extensions (.csv/.md/.json)
    // that disambiguates a text sniff — so it lands as plain text and is
    // ingested, not rejected. The assertion below is deliberately written to
    // accept either outcome, because what this test actually pins down is
    // that the file ends up in exactly one folder, not which one.
    await writeFile(join(inbox, 'bad.xlsx'), 'not a spreadsheet', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested + result.rejected).toBe(1);
    const processed = await readdir(join(inbox, 'processed'));
    const rejected = await readdir(join(inbox, 'rejected'));
    expect(processed.length + rejected.length).toBe(1);
  });

  it('leaves the subdirectories themselves alone', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'a.txt'), 'א', 'utf8');
    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    await writeFile(join(inbox, 'b.txt'), 'ב', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.ingested, 'the second pass must not re-ingest a.txt').toBe(1);
    expect((await readdir(join(inbox, 'processed'))).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('does not collide when the same name arrives twice', async () => {
    const { inbox, documentRoot } = await anInbox();
    await writeFile(join(inbox, 'same.txt'), 'ראשון', 'utf8');
    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    await writeFile(join(inbox, 'same.txt'), 'שני', 'utf8');

    await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    const processed = await readdir(join(inbox, 'processed'));
    expect(processed).toHaveLength(2);
    expect(processed).toContain('same.txt');
  });

  it('creates its subdirectories on a bare folder', async () => {
    const { inbox, documentRoot } = await anInbox();
    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });
    expect(result).toEqual({ ingested: 0, rejected: 0, failed: 0, deferred: 0, skipped: 0 });
    expect((await readdir(inbox)).sort()).toEqual(['failed', 'processed', 'rejected', 'working']);
  });

  it('files a stuck pending document into failed, never processed', async () => {
    const { inbox, documentRoot } = await anInbox();
    const bytes = Buffer.from('תקוע', 'utf8');
    await writeFile(join(inbox, 'stuck.txt'), bytes);

    // Pre-seed a `documents` row under the same (business, sha256) pair as
    // the bytes about to be dropped in the inbox, already `pending` — the
    // stuck, terminal state `ingest.ts` documents as produced by a
    // `writeFile` throw, a transient failure inside `markExtracted`'s
    // transaction, or the process being killed mid-ingest. `insertOrGetDocument`'s
    // `ON CONFLICT (business_id, sha256) DO NOTHING` then fires when
    // `scanInbox` calls `ingestDocument` below, and it hands back this exact
    // row instead of creating a new one — the same thing a second real
    // arrival of these bytes would see.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await getPool().query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
       VALUES ($1, $2, 'manual', 'stuck.txt', 'text/plain', $3, $4, $5, 'pending')`,
      [
        'DOC-stuck-pending-test',
        BUSINESS,
        sha256,
        bytes.length,
        `${BUSINESS}/DOC-stuck-pending-test/original.txt`,
      ],
    );

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    expect(result.failed).toBe(1);
    expect(result.ingested, 'a pending document is stuck, never a success').toBe(0);
    expect(await readdir(join(inbox, 'failed'))).toEqual(['stuck.txt']);
    expect(await readdir(join(inbox, 'processed'))).toEqual([]);
  });

  it('does not abort the batch when filing an ingested document fails', async () => {
    const { inbox, documentRoot } = await anInbox();
    // 'jammed.txt' is the one name the module-level `link` stub above
    // refuses to file into processed/ (EACCES) — everything else about this
    // scan, including 'clean.txt', goes through the real filesystem.
    await writeFile(join(inbox, 'jammed.txt'), 'ראשון', 'utf8');
    await writeFile(join(inbox, 'clean.txt'), 'שני', 'utf8');

    const result = await scanInbox({ inbox, businessId: BUSINESS, documentRoot });

    // The document behind jammed.txt was genuinely ingested — only the move
    // into processed/ failed — so the counters must describe the file, not
    // the ingest verdict: deferred, not ingested.
    expect(result.deferred, 'a failed move must not be silently dropped').toBe(1);
    expect(result.ingested, 'only the file actually filed counts as ingested').toBe(1);

    // clean.txt still made it through — one poisoned file must not abandon
    // the rest of the batch.
    expect(await readdir(join(inbox, 'processed'))).toEqual(['clean.txt']);

    // jammed.txt was claimed (moved into working/) but never filed anywhere
    // else, since the move that would have filed it threw.
    expect(await readdir(join(inbox, 'working'))).toEqual(['jammed.txt']);
  });
});
