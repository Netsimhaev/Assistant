import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { resolveSourceDocuments } from './source-resolver.js';

const B = 'test-business';
const OTHER = 'other-business';
let seq = 0;

async function doc(
  name: string,
  options: { business?: string; createdAt?: string; status?: string } = {},
): Promise<string> {
  seq += 1;
  const id = `DOC-${String(seq).padStart(4, '0')}`;
  await testDb().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size,
                            stored_path, status, created_at)
     VALUES ($1, $2, 'manual', $3, 'application/pdf', $4, 10, $5, $6, $7)`,
    [
      id,
      options.business ?? B,
      name,
      String(seq).padStart(64, '0'),
      `${options.business ?? B}/${id}/original.pdf`,
      options.status ?? 'extracted',
      options.createdAt ?? '2026-10-01T10:00:00Z',
    ],
  );
  return id;
}

async function mailWith(
  documentId: string,
  from: { address: string; name?: string },
  docType = 'other',
  business = B,
): Promise<void> {
  seq += 1;
  await testDb().query(
    `INSERT INTO mail_messages (mail_id, business_id, provider_message_id, thread_id, from_address, from_name,
                                subject, received_at, attachments, state)
     VALUES ($1, $2, $3, 't', $4, $5, 's', '2026-10-02T08:00:00Z', $6::jsonb, 'triaged')`,
    [
      `M-${seq}`,
      business,
      `PM-${seq}`,
      from.address,
      from.name ?? null,
      JSON.stringify([{ filename: 'x.pdf', documentId, docType }]),
    ],
  );
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('resolveSourceDocuments', () => {
  it('one match resolves', async () => {
    const id = await doc('מחירון אלפא 2026.pdf');
    await doc('חוזה שכירות.docx');
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['המחירון של אלפא'], []));
    expect(result).toEqual({ resolved: [id], ambiguous: [], missing: [] });
  });

  it('two matches → ambiguous with 2 candidates', async () => {
    const a = await doc('מחירון 2025.pdf', { createdAt: '2026-09-01T10:00:00Z' });
    const b = await doc('מחירון 2026.pdf', { createdAt: '2026-10-01T10:00:00Z' });
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['מחירון'], []));
    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]?.hint).toBe('מחירון');
    expect(result.ambiguous[0]?.candidates.map((c) => c.documentId)).toEqual([b, a]);
    expect(result.ambiguous[0]?.candidates[0]).toMatchObject({ name: 'מחירון 2026.pdf', date: '2026-10-01' });
  });

  it('shows at most three candidates', async () => {
    for (let i = 0; i < 5; i += 1) await doc(`הצעה ${i}.pdf`);
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['הצעה'], []));
    expect(result.ambiguous[0]?.candidates).toHaveLength(3);
  });

  it('none → missing', async () => {
    await doc('חוזה שכירות.docx');
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['מחירון'], []));
    expect(result).toEqual({ resolved: [], ambiguous: [], missing: ['מחירון'] });
  });

  it("another business's document never matches", async () => {
    await doc('מחירון אלפא.pdf', { business: OTHER });
    const other = await doc('מחירון בטא.pdf', { business: OTHER });
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['מחירון'], [other]));
    // The hint finds nothing here, and the explicit id of the other business
    // reads exactly like one that never existed.
    expect(result).toEqual({ resolved: [], ambiguous: [], missing: ['מחירון', other] });
    // Control: the same hint does resolve inside the other business.
    expect((await withBusiness(OTHER, (db) => resolveSourceDocuments(db, ['מחירון'], []))).ambiguous).toHaveLength(1);
  });

  it("matches the mail sender's domain and display name and the attachment type", async () => {
    const id = await doc('scan_0042.pdf');
    await mailWith(id, { address: 'billing@alpha-supply.co.il', name: 'אלפא אספקה' }, 'invoice');
    await doc('scan_0043.pdf');
    expect((await withBusiness(B, (db) => resolveSourceDocuments(db, ['alpha-supply.co.il'], []))).resolved).toEqual([id]);
    expect((await withBusiness(B, (db) => resolveSourceDocuments(db, ['החשבונית מאלפא'], []))).resolved).toEqual([id]);
    const ambiguous = await withBusiness(B, (db) => resolveSourceDocuments(db, ['scan'], []));
    expect(ambiguous.ambiguous[0]?.candidates.find((c) => c.documentId === id)?.sender).toBe('אלפא אספקה');
  });

  it('matches a date', async () => {
    const id = await doc('דוח.pdf', { createdAt: '2026-10-05T09:00:00Z' });
    await doc('דוח.pdf', { createdAt: '2026-10-06T09:00:00Z' });
    expect((await withBusiness(B, (db) => resolveSourceDocuments(db, ['הדוח מ-5/10'], []))).resolved).toEqual([id]);
  });

  it('an explicit id of this business resolves; a rejected document never does', async () => {
    const id = await doc('a.pdf');
    const rejected = await doc('מחירון.pdf', { status: 'rejected' });
    const result = await withBusiness(B, (db) => resolveSourceDocuments(db, ['מחירון'], [id, rejected]));
    expect(result.resolved).toEqual([id]);
    expect(result.missing).toEqual(['מחירון', rejected]);
  });
});
