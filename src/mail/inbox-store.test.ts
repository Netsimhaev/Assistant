import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  claimMail, getCursor, insertInvoice, listInvoices, mailReadsToday, recordIncoming, searchMail,
  setCursor, settleMail, staleClaimsToReceived, type IncomingMail,
} from './inbox-store.js';

const BUSINESS = 'test-business';
const opts = { businessId: BUSINESS };

function mail(over: Partial<IncomingMail> = {}): IncomingMail {
  return {
    providerMessageId: 'p1', threadId: 't1', internetMessageId: '<a@x>', references: null,
    fromAddress: 'sup@example.com', fromName: 'Sup', replyTo: null, toAddresses: ['me@biz.co.il'],
    subject: 'hello', receivedAt: '2026-10-10T10:00:00.000Z', bodyText: 'body', bodyTruncated: false,
    headerFlags: { listUnsubscribe: false, autoSubmitted: false, bulkPrecedence: false },
    attachments: [], ...over,
  };
}

describe('inbox store', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  it('setCursor records connectedAt when given, and a reconnect moves it', async () => {
    await setCursor({ provider: 'google', cursor: 'h1', connectedAt: '2026-10-01T00:00:00.000Z' }, opts);
    expect((await getCursor(opts))?.connectedAt).toBe('2026-10-01T00:00:00.000Z');
    await setCursor({ provider: 'microsoft', cursor: 'd1', connectedAt: '2026-10-21T08:00:00.000Z' }, opts);
    const c = await getCursor(opts);
    expect(c?.provider).toBe('microsoft');
    expect(c?.cursor).toBe('d1');
    expect(c?.connectedAt).toBe('2026-10-21T08:00:00.000Z');
  });

  it('setCursor without connectedAt keeps the connection time of an existing cursor', async () => {
    await setCursor({ provider: 'google', cursor: 'h1', connectedAt: '2026-10-01T00:00:00.000Z' }, opts);
    await setCursor({ provider: 'google', cursor: 'h2', lastPollAt: '2026-10-02T00:00:00.000Z' }, opts);
    const c = await getCursor(opts);
    expect(c?.cursor).toBe('h2');
    expect(c?.connectedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(c?.lastPollAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('recordIncoming returns null for a second insert of the same provider id', async () => {
    expect(await recordIncoming(mail(), opts)).not.toBeNull();
    expect(await recordIncoming(mail(), opts)).toBeNull();
  });

  it('claimMail claims once', async () => {
    const m = await recordIncoming(mail(), opts);
    expect(await claimMail(m!.mailId, opts)).toBe(true);
    expect(await claimMail(m!.mailId, opts)).toBe(false);
  });

  it('searchMail finds a body substring within a date window and not outside it', async () => {
    await recordIncoming(mail({ bodyText: 'the quarterly report is attached' }), opts);
    const base = { text: 'quarterly', limit: 10 };
    expect(await searchMail({ ...base, fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-31T00:00:00Z' }, opts)).toHaveLength(1);
    expect(await searchMail({ ...base, fromIso: '2026-11-01T00:00:00Z' }, opts)).toHaveLength(0);
  });

  it('searchMail treats % and _ in the query literally', async () => {
    await recordIncoming(mail({ providerMessageId: 'a', bodyText: '50%_off' }), opts);
    await recordIncoming(mail({ providerMessageId: 'b', bodyText: '50 off' }), opts);
    const rows = await searchMail({ text: '50%_off', limit: 10 }, opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerMessageId).toBe('a');
  });

  it('insertInvoice writes one row per (mail, document) and refuses a second', async () => {
    const m = (await recordIncoming(mail(), opts))!;
    const inv = {
      mailId: m.mailId, supplierAddress: 'a@acme.com', supplierName: null, invoiceNumber: '1', amountText: null,
      documentId: 'DOC-1', fileName: 'a.pdf', receivedAt: '2026-10-05T00:00:00Z',
    };
    expect(await insertInvoice(inv, opts)).not.toBeNull();
    expect(await insertInvoice({ ...inv, invoiceNumber: '2' }, opts)).toBeNull();
    // Rows with no document are not bound by it.
    expect(await insertInvoice({ ...inv, documentId: null }, opts)).not.toBeNull();
    expect(await insertInvoice({ ...inv, documentId: null }, opts)).not.toBeNull();
    const { rows } = await getPool().query('SELECT invoice_number FROM mail_invoices WHERE business_id = $1 AND document_id = $2', [BUSINESS, 'DOC-1']);
    expect(rows).toEqual([{ invoice_number: '1' }]);
  });

  it('listInvoices filters by supplier, number and date range', async () => {
    const m = (await recordIncoming(mail(), opts))!;
    const inv = { mailId: m.mailId, supplierName: null, amountText: null, documentId: null, fileName: null };
    await insertInvoice({ ...inv, supplierAddress: 'a@acme.com', invoiceNumber: 'INV-100', receivedAt: '2026-10-05T00:00:00Z' }, opts);
    await insertInvoice({ ...inv, supplierAddress: 'b@other.com', invoiceNumber: 'INV-200', receivedAt: '2026-09-05T00:00:00Z' }, opts);
    expect(await listInvoices({ supplier: 'acme' }, opts)).toHaveLength(1);
    expect(await listInvoices({ invoiceNumber: '200' }, opts)).toHaveLength(1);
    expect(await listInvoices({ fromIso: '2026-10-01T00:00:00Z', toIso: '2026-11-01T00:00:00Z' }, opts)).toHaveLength(1);
    expect(await listInvoices({}, opts)).toHaveLength(2);
  });

  it('mailReadsToday counts only rows triaged today', async () => {
    const a = (await recordIncoming(mail({ providerMessageId: 'a' }), opts))!;
    const b = (await recordIncoming(mail({ providerMessageId: 'b' }), opts))!;
    await recordIncoming(mail({ providerMessageId: 'c' }), opts);
    await settleMail(a.mailId, { state: 'triaged' }, opts);
    await settleMail(b.mailId, { state: 'triaged' }, opts);
    await getPool().query(`UPDATE mail_messages SET triaged_at = now() - interval '2 days' WHERE mail_id = $1`, [b.mailId]);
    expect(await mailReadsToday(opts)).toBe(1);
  });
  it('recordIncoming strips NUL from every text field, so a hostile mail cannot stall the poll', async () => {
    const stored = await recordIncoming(
      mail({
        subject: 'a\u0000b',
        bodyText: 'x\u0000y',
        fromName: 'N\u0000m',
        toAddresses: ['me\u0000@biz.co.il'],
        attachments: [{ attachmentId: 'A\u0000', filename: 'f\u0000.pdf', mediaType: 'application/pdf', size: 1 }],
      }),
      opts,
    );
    expect(stored?.subject).toBe('ab');
    expect(stored?.bodyText).toBe('xy');
    expect(stored?.fromName).toBe('Nm');
    expect(stored?.toAddresses).toEqual(['me@biz.co.il']);
    expect(stored?.attachments[0]?.filename).toBe('f.pdf');
  });

  it('claimMail stamps claimed_at, and staleClaimsToReceived returns only old claims', async () => {
    const a = await recordIncoming(mail({ providerMessageId: 'old' }), opts);
    const b = await recordIncoming(mail({ providerMessageId: 'fresh' }), opts);
    if (a === null || b === null) throw new Error('setup');
    expect(await claimMail(a.mailId, opts)).toBe(true);
    expect(await claimMail(b.mailId, opts)).toBe(true);
    const { rows } = await getPool().query<{ claimed_at: Date | null }>(
      'SELECT claimed_at FROM mail_messages WHERE mail_id = $1', [b.mailId],
    );
    expect(rows[0]?.claimed_at).not.toBeNull();
    await getPool().query("UPDATE mail_messages SET claimed_at = now() - interval '31 minutes' WHERE mail_id = $1", [a.mailId]);

    expect(await staleClaimsToReceived(30, opts)).toBe(1);
    const { rows: states } = await getPool().query<{ provider_message_id: string; state: string }>(
      'SELECT provider_message_id, state FROM mail_messages ORDER BY provider_message_id',
    );
    expect(states).toEqual([
      { provider_message_id: 'fresh', state: 'claimed' },
      { provider_message_id: 'old', state: 'received' },
    ]);
  });
});
