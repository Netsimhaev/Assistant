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

  // The sibling tests above each assert one outcome. This one asserts the
  // property that spans them: the union really does have five members, every
  // one of them is reachable, and NONE of them arrives as a thrown error —
  // the whole reason `verify.ts` returns a discriminated union instead of
  // throwing is that the route has to render a different Hebrew refusal for
  // each. Its predecessor set up one document, deleted it, and asserted the
  // promise resolved: it drove one outcome, and a `verifyDocumentUnchanged`
  // that returned a constant kept it green.
  it('resolves to each of the five outcomes in turn, and throws for none of them', async () => {
    // Distinct bytes per case, and each row's hash is its own: intake
    // deduplicates on `(business_id, sha256)`, so five documents sharing one
    // hash would be one row wearing five ids.
    const stored = async (label: string): Promise<string> => {
      const bytes = Buffer.from(`הסכם שיווק — ${label}`, 'utf8');
      return aStoredDocument(bytes, createHash('sha256').update(bytes).digest('hex'));
    };

    const unchanged = await stored('ללא שינוי');

    // The row keeps a hash of something else; the bytes on disk are these.
    const changedBytes = Buffer.from('הסכם שיווק — נוסח שנערך', 'utf8');
    const changed = await aStoredDocument(
      changedBytes,
      createHash('sha256').update(Buffer.from('הנוסח שנקלט', 'utf8')).digest('hex'),
    );

    const missing = await stored('נמחק');
    await rm(join(root, BUSINESS, missing), { recursive: true, force: true });

    const unreadable = await stored('לא קריא');
    const unreadablePath = join(root, BUSINESS, unreadable, 'original.txt');
    await rm(unreadablePath, { force: true });
    await mkdir(unreadablePath);

    // Asked for under another business, so `loadDocument` finds nothing.
    const unknown = await stored('של עסק אחר');

    const cases: [string, Promise<{ status: string }>][] = [
      ['unchanged', verifyDocumentUnchanged(unchanged, { businessId: BUSINESS, documentRoot: root })],
      ['changed', verifyDocumentUnchanged(changed, { businessId: BUSINESS, documentRoot: root })],
      ['missing', verifyDocumentUnchanged(missing, { businessId: BUSINESS, documentRoot: root })],
      ['unreadable', verifyDocumentUnchanged(unreadable, { businessId: BUSINESS, documentRoot: root })],
      ['unknown_document', verifyDocumentUnchanged(unknown, { businessId: 'other', documentRoot: root })],
    ];

    const seen: string[] = [];
    for (const [expected, pending] of cases) {
      const outcome = await pending;
      expect(outcome.status).toBe(expected);
      seen.push(outcome.status);
    }
    expect(new Set(seen).size).toBe(5);
  });
});
