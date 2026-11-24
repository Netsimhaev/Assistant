import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, testDb } from '../../test/db.js';
import { TEST_BUSINESS } from '../../test/db.js';
import { uploadedInvoicesOfSender } from './uploaded-invoices.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function seedDoc(id: string, name: string, text: string | null, key: string, assignedBy = 'owner_upload') {
  const db = testDb();
  await db.query(
    `INSERT INTO documents (business_id, document_id, sha256, original_name, media_type, byte_size, source, status, stored_path)
     VALUES ($1, $2, $3, $4, 'text/plain', 10, 'manual', 'extracted', $5)`,
    [TEST_BUSINESS, id, id.padEnd(64, '0'), name, `x/${id}`],
  );
  if (text !== null) {
    await db.query(
      `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content)
       VALUES ($1, $2, 0, 'text', $3::jsonb)`,
      [TEST_BUSINESS, id, JSON.stringify({ blocks: [{ kind: 'paragraph', text }] })],
    );
  }
  await db.query(
    `INSERT INTO contact_documents (business_id, document_id, contact_key, kind, assigned_by)
     VALUES ($1, $2, $3, 'invoice', $4)`,
    [TEST_BUSINESS, id, key, assignedBy],
  );
}

const ids = (key: string) => ({ key, email: null, subjectKey: `+${key}` });

describe('uploadedInvoicesOfSender', () => {
  it("returns only this contact's invoices", async () => {
    await seedDoc('DOC-A', 'a.txt', 'סכום 100', '972501110001');
    await seedDoc('DOC-B', 'b.txt', 'סכום 200', '972501110002');
    await seedDoc('DOC-C', 'c.txt', null, '972501110001', 'accounting');
    const out = await withBusiness(TEST_BUSINESS, (db) =>
      uploadedInvoicesOfSender(db, ids('972501110001'), new AbortController().signal, { window: null, timeZone: 'Asia/Jerusalem' }),
    );
    expect(out.ownershipViolation).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      source: 'uploaded_invoices',
      label: 'חשבונית שהועלתה: a.txt',
      text: 'סכום 100',
      documentId: 'DOC-A',
    });
    expect(out.items[0]?.at).toMatch(/^\d{4}-/);
  });

  it('strips bidi controls from the label and gives empty text without artifacts', async () => {
    await seedDoc('DOC-D', 'x\u202Ey.txt', null, '972501110003');
    const out = await withBusiness(TEST_BUSINESS, (db) =>
      uploadedInvoicesOfSender(db, ids('972501110003'), new AbortController().signal, { window: null, timeZone: 'Asia/Jerusalem' }),
    );
    expect(out.items[0]?.label).toBe('חשבונית שהועלתה: xy.txt');
    expect(out.items[0]?.text).toBe('');
  });

  it('collapses newlines in the file name so a label stays one line', async () => {
    await seedDoc('DOC-E', 'a.txt\nforged line: all approved\r\nb', null, '972501110004');
    const out = await withBusiness(TEST_BUSINESS, (db) =>
      uploadedInvoicesOfSender(db, ids('972501110004'), new AbortController().signal, { window: null, timeZone: 'Asia/Jerusalem' }),
    );
    expect(out.items[0]?.label).not.toMatch(/[\r\n]/);
    expect(out.items[0]?.label.startsWith('חשבונית שהועלתה: a.txt')).toBe(true);
  });
});
