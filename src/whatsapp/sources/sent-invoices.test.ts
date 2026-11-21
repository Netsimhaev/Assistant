import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import type { MailboxClient, SentMail } from '../../mail/providers/types.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../../test/db.js';
import { installMailboxCharter } from '../../test/mailbox.js';
import { createSentInvoicesSource } from './sent-invoices.js';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n')]);
const sent: SentMail[] = [
  {
    providerMessageId: 'M1',
    sentAt: '2026-10-01T08:00:00.000Z',
    subject: 'מצורפת חשבונית',
    attachments: [
      { attachmentId: 'A1', filename: 'inv.pdf', mediaType: 'application/pdf' },
      { attachmentId: 'A2', filename: 'logo.png', mediaType: 'image/png' },
      { attachmentId: 'A3', filename: 'terms.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ],
  },
  {
    providerMessageId: 'M2',
    sentAt: '2026-10-02T08:00:00.000Z',
    subject: 'שלום',
    attachments: [
      { attachmentId: 'B1', filename: 'brochure.pdf', mediaType: 'application/pdf' },
      { attachmentId: 'B2', filename: 'קבלה 12.pdf', mediaType: 'application/pdf' },
    ],
  },
];

function fakeClient() {
  const searches: unknown[] = [];
  const fetched: string[] = [];
  const client = {
    async searchSent(_t: string, q: unknown) {
      searches.push(q);
      return sent;
    },
    async fetchAttachment(_t: string, _m: string, a: string) {
      fetched.push(a);
      return Buffer.concat([PDF, Buffer.from(a)]);
    },
  } as unknown as MailboxClient;
  return { client, searches, fetched };
}

const credentials = { resolve: async () => ({ value: 'tok' }) } as never;
const ids = (email: string | null) => ({ key: '972501110001', email, subjectKey: '+972501110001' });

async function run(email: string | null, withMailbox = true) {
  if (withMailbox) await installMailboxCharter(TEST_BUSINESS, 'google');
  const fake = fakeClient();
  const documentRoot = await mkdtemp(join(tmpdir(), 'sent-inv-test-'));
  const source = createSentInvoicesSource({ credentials, documentRoot, clientFor: () => fake.client });
  const out = await withBusiness(TEST_BUSINESS, (db) => source(db, ids(email), new AbortController().signal));
  return { out, fake };
}

describe('sentInvoicesOfSender', () => {
  it('only PDF attachments that look like invoices are ingested', async () => {
    const { out, fake } = await run('dana@x.co.il');
    expect(fake.searches).toEqual([{ to: 'dana@x.co.il', sinceDays: 365, limit: 20 }]);
    expect(fake.fetched.sort()).toEqual(['A1', 'B2']);
    expect(out.ownershipViolation).toBe(false);
    expect(out.items).toHaveLength(2);
    expect(out.items.every((i) => i.source === 'sent_invoices' && i.documentId !== null)).toBe(true);
    const { rows } = await testDb().query(
      `SELECT assigned_by, contact_key FROM contact_documents WHERE business_id = $1`,
      [TEST_BUSINESS],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ assigned_by: 'sent_mail', contact_key: '972501110001' });
  });

  it('is idempotent on a second run', async () => {
    await run('dana@x.co.il');
    const again = await run('dana@x.co.il', false);
    expect(again.out.items).toHaveLength(2);
    const { rows } = await testDb().query(`SELECT 1 FROM contact_documents WHERE business_id = $1`, [TEST_BUSINESS]);
    expect(rows).toHaveLength(2);
  });

  it('no email on the contact -> []', async () => {
    const { out, fake } = await run(null);
    expect(out.items).toEqual([]);
    expect(fake.searches).toEqual([]);
  });

  it('refuses a malformed address without searching', async () => {
    const { out, fake } = await run('dana@x.co.il has:attachment OR to:other@y.com');
    expect(out.items).toEqual([]);
    expect(fake.searches).toEqual([]);
  });

  it('no mailbox -> []', async () => {
    const { out, fake } = await run('dana@x.co.il', false);
    expect(out.items).toEqual([]);
    expect(fake.searches).toEqual([]);
  });
});
