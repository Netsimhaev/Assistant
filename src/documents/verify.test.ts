import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { insertOrGetDocument } from './store.js';
import { verifyDocumentUnchanged } from './verify.js';

const BUSINESS = 'test-business';
const BYTES = Buffer.from('הסכם שיווק — גרסה ראשונה', 'utf8');
const HASH = createHash('sha256').update(BYTES).digest('hex');

let root: string;

/** A document row plus its file on disk, exactly as ingestDocument leaves them. */
async function aStoredDocument(bytes: Buffer, sha256: string): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  const rel = `${BUSINESS}/${documentId}/original.txt`;
  await mkdir(join(root, BUSINESS, documentId), { recursive: true });
  await writeFile(join(root, rel), bytes);
  await insertOrGetDocument({
    documentId, source: 'manual', originalName: 'הסכם.docx', mediaType: 'text/plain',
    sha256, byteSize: bytes.length, storedPath: rel,
  }, { businessId: BUSINESS });
  return documentId;
}

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), 'verify-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closePool();
});

describe('verifyDocumentUnchanged', () => {
  it('reports unchanged when the file still hashes to what intake recorded', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    const outcome = await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root });
    expect(outcome.status).toBe('unchanged');
    if (outcome.status !== 'unchanged') throw new Error('expected unchanged');
    expect(outcome.sha256).toBe(HASH);
  });

  it('reports changed when the file on disk was edited after intake', async () => {
    // The row keeps intake's hash; the bytes are someone else's.
    const documentId = await aStoredDocument(Buffer.from('הסכם שיווק — נוסח אחר', 'utf8'), HASH);
    const outcome = await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root });
    expect(outcome.status).toBe('changed');
    if (outcome.status !== 'changed') throw new Error('expected changed');
    expect(outcome.expected).toBe(HASH);
    expect(outcome.actual).not.toBe(HASH);
  });

  it('reports missing when the file is gone', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    await rm(join(root, BUSINESS, documentId), { recursive: true, force: true });
    expect((await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root })).status)
      .toBe('missing');
  });

  it('reports unknown_document for an id this business does not own', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    expect((await verifyDocumentUnchanged(documentId, { businessId: 'other', documentRoot: root })).status)
      .toBe('unknown_document');
  });

  it('reports unreadable, not missing, when a directory sits where the file should be', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    const filePath = join(root, BUSINESS, documentId, 'original.txt');
    // Replace the file itself with a directory of the same name — a real
    // filesystem error distinct from ENOENT (EISDIR here), not a stubbed
    // throw. This is what a misconfigured deploy or a botched restore looks
    // like: the row exists, something is at the path, it just isn't a file.
    await rm(filePath, { force: true });
    await mkdir(filePath);
    const outcome = await verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root });
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.cause.length).toBeGreaterThan(0);
  });

  it('never throws for any of the five outcomes', async () => {
    const documentId = await aStoredDocument(BYTES, HASH);
    await rm(join(root, BUSINESS, documentId), { recursive: true, force: true });
    await expect(
      verifyDocumentUnchanged(documentId, { businessId: BUSINESS, documentRoot: root }),
    ).resolves.toBeDefined();
  });
});
