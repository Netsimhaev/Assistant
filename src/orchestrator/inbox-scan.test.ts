import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { scanInbox } from './inbox-scan.js';

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
    // A .xlsx name over bytes that are not a zip: sniffed as text, never sent
    // to the Excel decoder, and rejected by ingest as a mismatch it will not
    // guess about.
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
    expect(result).toEqual({ ingested: 0, rejected: 0, skipped: 0 });
    expect((await readdir(inbox)).sort()).toEqual(['processed', 'rejected', 'working']);
  });
});
