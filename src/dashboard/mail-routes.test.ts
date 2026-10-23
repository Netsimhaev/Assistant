/**
 * Mail screens: the searchable list, the invoices-by-supplier screen, one
 * mail, and the business-scoped document download. Real HTTP server and
 * Postgres, same harness as `mail-reply-route.test.ts`.
 */
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { annotateAttachment, insertInvoice, linkAttachmentDocument, markOverCap, noteMailError, setCursor, settleMail } from '../mail/inbox-store.js';
import { resetDatabase } from '../test/db.js';
import { storedMail } from '../test/mailbox.js';
import { ingestDocument } from '../documents/ingest.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';
import { DOCUMENT_LIMIT } from './mail-handlers.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
const USERNAME = 'owner';
const PASSWORD = 'correct horse battery staple';

let server: Server | null = null;
let root: string;

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), 'mail-routes-'));
  await createOwner({ username: USERNAME, password: PASSWORD, businessId: BUSINESS });
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

async function start(): Promise<string> {
  server = createServer({ businessId: BUSINESS, port: 0, documentRoot: root });
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    redirect: 'manual',
  });
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!pair) throw new Error('no session cookie');
  return pair;
}

async function get(baseUrl: string, cookie: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function addDocument(
  businessId: string,
  id: string,
  over: { status?: string; name?: string; media?: string; path?: string } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, 'mail', $3, $4, $5, 5, $6, $7)`,
    [
      id,
      businessId,
      over.name ?? 'חשבונית.pdf',
      over.media ?? 'application/pdf',
      id.padEnd(64, '0'),
      over.path ?? `${businessId}/${id}/original.pdf`,
      over.status ?? 'stored',
    ],
  );
}

describe('GET /mail', () => {
  it('requires a session', async () => {
    const baseUrl = await start();
    const res = await fetch(`${baseUrl}/mail`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('?q=משלוח returns the matching row with <mark> and escapes a <script> in the body', async () => {
    await storedMail(BUSINESS, {
      providerMessageId: 'PM-A',
      subject: 'עדכון',
      bodyText: 'המשלוח יצא <script>alert(1)</script> היום',
    });
    await storedMail(BUSINESS, { providerMessageId: 'PM-B', subject: 'נושא אחר', bodyText: 'שום דבר' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/mail?q=${encodeURIComponent('משלוח')}`)).text();
    expect(html).toContain('<mark>משלוח</mark>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('עדכון');
    expect(html).not.toContain('נושא אחר');
  });

  it('does not mark inside an escaped entity', async () => {
    await storedMail(BUSINESS, { providerMessageId: 'PM-E', bodyText: 'a < b & c amp' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/mail?q=${encodeURIComponent('amp')}`)).text();
    expect(html).toContain('&amp;');
    expect(html).not.toContain('&<mark>');
    expect(html).toContain('<mark>amp</mark>');
  });

  it('shows the over-cap banner on the row', async () => {
    const mail = await storedMail(BUSINESS, { providerMessageId: 'PM-C' });
    await markOverCap(mail.mailId, { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('לא נקרא — התקרה היומית נגמרה');
  });

  it('says no mailbox is connected when there is no grant', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('תיבת מייל לא מחוברת');
  });

  it('shows the reconnect-gap banner and Hebrew notes for error codes', async () => {
    const mail = await storedMail(BUSINESS, { providerMessageId: 'PM-G' });
    await settleMail(mail.mailId, { state: 'triaged', categories: ['other'] }, { businessId: BUSINESS });
    await noteMailError(mail.mailId, 'notify_failed', { businessId: BUSINESS });
    await setCursor({ provider: 'google', cursor: 'c', lastError: null }, { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('לא הצלחנו להתריע');
    expect(html).not.toContain('notify_failed');
  });

  it('escapes a hostile sender name and strips bidi controls', async () => {
    await storedMail(BUSINESS, { providerMessageId: 'PM-H', fromName: '<img src=x>\u202Eevil' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('&lt;img src=x&gt;evil');
    expect(html).not.toContain('\u202E');
  });

  it('filters by category and by sender', async () => {
    const a = await storedMail(BUSINESS, { providerMessageId: 'PM-1', subject: 'חשבונית מאי', fromAddress: 'a@x.example' });
    await settleMail(a.mailId, { state: 'triaged', categories: ['invoice'] }, { businessId: BUSINESS });
    await storedMail(BUSINESS, { providerMessageId: 'PM-2', subject: 'הצעת מחיר', fromAddress: 'b@y.example' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const byCat = await (await get(baseUrl, cookie, '/mail?category=invoice')).text();
    expect(byCat).toContain('חשבונית מאי');
    expect(byCat).not.toContain('הצעת מחיר');
    const bySender = await (await get(baseUrl, cookie, '/mail?sender=b@y')).text();
    expect(bySender).toContain('הצעת מחיר');
    expect(bySender).not.toContain('חשבונית מאי');
  });
});

describe('GET /mail/invoices', () => {
  async function seed(): Promise<void> {
    const m1 = await storedMail(BUSINESS, { providerMessageId: 'I-1' });
    const m2 = await storedMail(BUSINESS, { providerMessageId: 'I-2' });
    const m3 = await storedMail(BUSINESS, { providerMessageId: 'I-3' });
    await addDocument(BUSINESS, 'doc1');
    await insertInvoice(
      { mailId: m1.mailId, supplierAddress: 'acc@sup1.example', supplierName: 'ספק ראשון', invoiceNumber: 'INV-100',
        amountText: '1,200 ש"ח', documentId: 'doc1', fileName: 'a.pdf', receivedAt: '2026-10-01T10:00:00.000Z' },
      { businessId: BUSINESS },
    );
    await insertInvoice(
      { mailId: m2.mailId, supplierAddress: 'acc@sup1.example', supplierName: 'ספק ראשון', invoiceNumber: 'INV-200',
        amountText: null, documentId: null, fileName: null, receivedAt: '2026-10-05T10:00:00.000Z' },
      { businessId: BUSINESS },
    );
    await insertInvoice(
      { mailId: m3.mailId, supplierAddress: 'x@sup2.example', supplierName: 'ספק שני', invoiceNumber: 'ZZ-1',
        amountText: '50', documentId: null, fileName: null, receivedAt: '2026-10-03T10:00:00.000Z' },
      { businessId: BUSINESS },
    );
  }

  it('groups by supplier, newest first, marks unverified, links original mail and download', async () => {
    await seed();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail/invoices')).text();
    expect(html).toContain('ספק ראשון');
    expect(html).toContain('ספק שני');
    expect(html.indexOf('INV-200')).toBeLessThan(html.indexOf('INV-100'));
    expect(html).toContain('לא מאומת');
    expect(html).toContain('href="/documents/doc1/file"');
    expect(html).toMatch(/href="\/mail\/[^"]+"/);
  });

  it('filters by number and groups by supplier', async () => {
    await seed();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail/invoices?number=INV-1')).text();
    expect(html).toContain('INV-100');
    expect(html).not.toContain('INV-200');
    expect(html).not.toContain('ZZ-1');
    expect(html).not.toContain('ספק שני');
  });
});

describe('GET /mail/:mailId', () => {
  it('renders an HTML body as text', async () => {
    const mail = await storedMail(BUSINESS, {
      providerMessageId: 'M-1',
      bodyText: '<b onclick=x>שלום</b><script>1</script>',
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, `/mail/${mail.mailId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<pre>&lt;b onclick=x&gt;שלום&lt;/b&gt;&lt;script&gt;1&lt;/script&gt;</pre>');
    expect(html).not.toContain('<script>');
  });

  it('404s on an unknown mail and on another business mail', async () => {
    const other = await storedMail(OTHER, { providerMessageId: 'M-O' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await get(baseUrl, cookie, `/mail/${other.mailId}`)).status).toBe(404);
    expect((await get(baseUrl, cookie, '/mail/nope')).status).toBe(404);
  });
});

describe('GET /documents/:id/file', () => {
  async function writeFor(businessId: string, id: string): Promise<void> {
    await mkdir(join(root, businessId, id), { recursive: true });
    await writeFile(join(root, businessId, id, 'original.pdf'), 'PDF-1');
  }

  it('serves a stored document as an attachment with safe headers', async () => {
    await addDocument(BUSINESS, 'docA', { name: 'חשבונית\u202E.pdf' });
    await writeFor(BUSINESS, 'docA');
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const res = await get(baseUrl, cookie, '/documents/docA/file');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PDF-1');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toContain('%E2%80%AE');
  });

  it('is business-scoped: another business document gives 404', async () => {
    await addDocument(OTHER, 'docO');
    await writeFor(OTHER, 'docO');
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await get(baseUrl, cookie, '/documents/docO/file')).status).toBe(404);
  });

  it('refuses rejected documents and paths that escape the root', async () => {
    await addDocument(BUSINESS, 'docR', { status: 'rejected' });
    await writeFor(BUSINESS, 'docR');
    await addDocument(BUSINESS, 'docX', { path: '../../outside.pdf' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await get(baseUrl, cookie, '/documents/docR/file')).status).toBe(404);
    expect((await get(baseUrl, cookie, '/documents/docX/file')).status).toBe(404);
  });

  it('requires a session', async () => {
    const baseUrl = await start();
    const res = await fetch(`${baseUrl}/documents/x/file`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});

describe('fix round 1', () => {
  const pdf = (id: string, name: string) => ({ attachmentId: id, filename: name, mediaType: 'application/pdf', size: 5 });

  async function writeFor(businessId: string, id: string): Promise<void> {
    await mkdir(join(root, businessId, id), { recursive: true });
    await writeFile(join(root, businessId, id, 'original.pdf'), 'PDF-1');
  }

  it('links an attachment document, business-scoped, leaving the others untouched', async () => {
    const mail = await storedMail(BUSINESS, { providerMessageId: 'L-1', attachments: [pdf('a1', 'one.pdf'), pdf('a2', 'two.pdf')] });
    const other = await storedMail(OTHER, { providerMessageId: 'L-2', attachments: [pdf('a1', 'one.pdf')] });
    await linkAttachmentDocument(mail.mailId, 'a2', 'docZ', { businessId: OTHER });
    await linkAttachmentDocument(mail.mailId, 'a2', 'docZ', { businessId: BUSINESS });
    const { rows } = await getPool().query('SELECT mail_id, attachments FROM mail_messages');
    const byId = new Map(rows.map((r) => [r.mail_id, r.attachments]));
    expect(byId.get(mail.mailId)).toEqual([pdf('a1', 'one.pdf'), { ...pdf('a2', 'two.pdf'), documentId: 'docZ' }]);
    expect(byId.get(other.mailId)).toEqual([pdf('a1', 'one.pdf')]);
  });

  it('a document-category mail with PDFs shows working downloads for every linked attachment', async () => {
    const m = await storedMail(BUSINESS, { providerMessageId: 'D-1', attachments: [pdf('a1', 'offer.pdf'), pdf('a2', 'terms.pdf')] });
    await settleMail(m.mailId, { state: 'triaged', categories: ['document'] }, { businessId: BUSINESS });
    await addDocument(BUSINESS, 'docP1');
    await addDocument(BUSINESS, 'docP2');
    await writeFor(BUSINESS, 'docP1');
    await linkAttachmentDocument(m.mailId, 'a1', 'docP1', { businessId: BUSINESS });
    await linkAttachmentDocument(m.mailId, 'a2', 'docP2', { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const detail = await (await get(baseUrl, cookie, `/mail/${m.mailId}`)).text();
    expect(detail).toContain('href="/documents/docP1/file"');
    expect(detail).toContain('href="/documents/docP2/file"');
    const list = await (await get(baseUrl, cookie, '/mail')).text();
    expect(list).toContain('href="/documents/docP1/file"');
    expect(list).toContain('href="/documents/docP2/file"');
    expect(list).toContain('📎');
    expect((await get(baseUrl, cookie, '/documents/docP1/file')).status).toBe(200);
  });

  it('a mailed PDF that cannot be decoded is still downloadable from the mail (ruling P7)', async () => {
    const m = await storedMail(BUSINESS, { providerMessageId: 'D-U', attachments: [pdf('a1', 'broken.pdf')] });
    const src = join(root, 'incoming-broken');
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n')]);
    await writeFile(src, bytes);
    const doc = await ingestDocument({ path: src, source: 'mail', originalName: 'broken.pdf' }, { businessId: BUSINESS, documentRoot: root });
    expect(doc.status).toBe('stored');
    expect(doc.reason).toMatch(/^הפענוח נכשל: /);
    await linkAttachmentDocument(m.mailId, 'a1', doc.documentId, { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const detail = await (await get(baseUrl, cookie, `/mail/${m.mailId}`)).text();
    expect(detail).toContain(`href="/documents/${doc.documentId}/file"`);
    // The owner is told it was not read, and why — next to the attachment.
    const item = detail.slice(detail.indexOf('broken.pdf'));
    expect(item.slice(0, item.indexOf('</li>'))).toContain(`לא ניתן לפענח: ${doc.reason?.slice(0, 20)}`);
    const file = await get(baseUrl, cookie, `/documents/${doc.documentId}/file`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('does not offer a download for a linked document that was rejected', async () => {
    const m = await storedMail(BUSINESS, { providerMessageId: 'D-2', attachments: [pdf('a1', 'bad.pdf')] });
    await addDocument(BUSINESS, 'docBad', { status: 'rejected' });
    await linkAttachmentDocument(m.mailId, 'a1', 'docBad', { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const detail = await (await get(baseUrl, cookie, `/mail/${m.mailId}`)).text();
    expect(detail).not.toContain('/documents/docBad/file');
    expect(detail).toContain('bad.pdf');
  });

  async function auditGap(daysAgo: number): Promise<void> {
    await appendAudit(
      {
        jobId: null, actor: 'orchestrator', kind: 'incident', reason: 'mail_cursor_gap', inputHash: 'a'.repeat(64),
        provenance: 'unknown_external', charterVersion: 'v1', envelopeId: null, onBehalfOf: null, actionClass: null,
        risk: null, outputHash: null, artifacts: [], costMinor: null, tokens: null,
      },
      { businessId: BUSINESS },
    );
    if (daysAgo > 0) {
      const db = getPool();
      await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      await db.query("UPDATE audit_log SET at = now() - ($1 || ' days')::interval WHERE reason = 'mail_cursor_gap'", [String(daysAgo)]);
      await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    }
  }

  it('shows the gap banner from the durable audit row even after the cursor error was cleared', async () => {
    await setCursor({ provider: 'google', cursor: 'c', lastError: null }, { businessId: BUSINESS });
    await auditGap(0);
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('חלק מהמיילים שהגיעו בזמן שהתיבה הייתה מנותקת לא נקראו (בתאריך ');
  });

  it('does not show the gap banner for a gap older than 7 days', async () => {
    await auditGap(8);
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).not.toContain('חלק מהמיילים שהגיעו');
  });

  it('shows a generic banner for other cursor errors', async () => {
    await setCursor({ provider: 'google', cursor: 'c', lastError: 'list_transient' }, { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('יש תקלה בקריאת התיבה — הפרטים במסך החיבור');
    expect(html).not.toContain('list_transient');
  });

  it('strips bidi controls from invoice number and amount, snippet and body', async () => {
    const m = await storedMail(BUSINESS, { providerMessageId: 'B-1', bodyText: 'abc\u202Edef משלוח⁧ x' });
    await insertInvoice(
      { mailId: m.mailId, supplierAddress: 's@x.example', supplierName: null, invoiceNumber: 'N\u202E1',
        amountText: '9\u202E00', documentId: null, fileName: null, receivedAt: '2026-10-01T10:00:00.000Z' },
      { businessId: BUSINESS },
    );
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const inv = await (await get(baseUrl, cookie, '/mail/invoices')).text();
    expect(inv).not.toContain('\u202E');
    expect(inv).toContain('N1');
    const list = await (await get(baseUrl, cookie, `/mail?q=${encodeURIComponent('def\u202E')}`)).text();
    expect(list).not.toContain('\u202E');
    expect(list).not.toContain('⁧');
    expect(list).toContain('<mark>def</mark>');
    const detail = await (await get(baseUrl, cookie, `/mail/${m.mailId}`)).text();
    expect(detail).not.toContain('\u202E');
    expect(detail).not.toContain('⁧');
  });

  it('collapses whitespace in the query before marking', async () => {
    await storedMail(BUSINESS, { providerMessageId: 'W-1', bodyText: 'the big red box' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/mail?q=${encodeURIComponent('red   box')}`)).text();
    expect(html).toContain('<mark>red box</mark>');
  });

  it('answers 404 for a malformed percent escape in a path', async () => {
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect((await get(baseUrl, cookie, '/mail/%E0%A4%A')).status).toBe(404);
    expect((await get(baseUrl, cookie, '/documents/%E0%A4%A/file')).status).toBe(404);
  });
});

describe('PDF summaries and the documents screen', () => {
  const att = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    attachmentId: id, filename: name, mediaType: 'application/pdf', size: 5, ...extra,
  });

  /** `recordIncoming` keeps only the provider fields, so the reader's fields are written the way the poll writes them. */
  async function mailWith(businessId: string, over: Parameters<typeof storedMail>[1]): ReturnType<typeof storedMail> {
    const given = (over?.attachments ?? []) as unknown as Record<string, unknown>[];
    const m = await storedMail(businessId, {
      ...over,
      attachments: given.map(({ docType: _d, summary: _s, scanned: _c, documentId: _i, ...base }) => base) as never,
    });
    for (const a of given) {
      const id = a['attachmentId'] as string;
      await annotateAttachment(
        m.mailId, id,
        {
          ...(a['docType'] !== undefined ? { docType: a['docType'] as never } : {}),
          ...(a['summary'] !== undefined ? { summary: a['summary'] as string } : {}),
          ...(a['scanned'] !== undefined ? { scanned: a['scanned'] as boolean } : {}),
        },
        { businessId },
      );
      if (a['documentId'] !== undefined) await linkAttachmentDocument(m.mailId, id, a['documentId'] as string, { businessId });
    }
    return m;
  }

  it('mail detail shows summary, type and scanned state', async () => {
    const m = await mailWith(BUSINESS, {
      providerMessageId: 'PD-1',
      attachments: [
        att('a1', 'offer.pdf', { docType: 'quote', summary: 'הצעה <b>לשיפוץ</b> בסך 12,000' }),
        att('a2', 'scan.pdf', { docType: 'other', scanned: true }),
      ],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/mail/${m.mailId}`)).text();
    expect(html).toContain('הצעת מחיר');
    expect(html).toContain('הצעה &lt;b&gt;לשיפוץ&lt;/b&gt; בסך 12,000');
    expect(html).not.toContain('<b>לשיפוץ</b>');
    expect(html).toContain('קובץ סרוק — לא נקרא');
  });

  async function seedDocs(): Promise<{ a: string }> {
    const a = await mailWith(BUSINESS, {
      providerMessageId: 'DOC-A', fromAddress: 'dana@client.example', fromName: 'דנה',
      attachments: [
        att('a1', 'inv.pdf', { docType: 'invoice', summary: 'חשבונית מס 77', documentId: 'docQ1' }),
        att('a2', 'contract.pdf', { docType: 'contract', summary: 'חוזה שכירות' }),
      ],
    });
    await mailWith(OTHER, {
      providerMessageId: 'DOC-B', fromAddress: 'x@other.example',
      attachments: [att('b1', 'secret.pdf', { docType: 'invoice', summary: 'סוד של עסק אחר' })],
    });
    await addDocument(BUSINESS, 'docQ1');
    return { a: a.mailId };
  }

  it('/mail/documents filters by type and is business-scoped', async () => {
    const { a } = await seedDocs();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const all = await (await get(baseUrl, cookie, '/mail/documents')).text();
    expect(all).toContain('חשבונית מס 77');
    expect(all).toContain('חוזה שכירות');
    expect(all).not.toContain('סוד של עסק אחר');
    expect(all).toContain('href="/documents/docQ1/file"');
    expect(all).toContain(`href="/mail/${a}"`);
    const only = await (await get(baseUrl, cookie, '/mail/documents?type=contract')).text();
    expect(only).toContain('חוזה שכירות');
    expect(only).not.toContain('חשבונית מס 77');
    const bySender = await (await get(baseUrl, cookie, '/mail/documents?sender=nobody')).text();
    expect(bySender).not.toContain('חוזה שכירות');
    const byDate = await (await get(baseUrl, cookie, '/mail/documents?from=2999-01-01')).text();
    expect(byDate).not.toContain('חוזה שכירות');
  });

  it('an unknown type parameter does not filter and is not echoed raw', async () => {
    await seedDocs();
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, `/mail/documents?type=${encodeURIComponent('<script>x</script>')}`)).text();
    expect(html).toContain('חוזה שכירות');
    expect(html).toContain('חשבונית מס 77');
    expect(html).not.toContain('<script>x</script>');
  });

  it('requires a session', async () => {
    const baseUrl = await start();
    expect((await fetch(`${baseUrl}/mail/documents`, { redirect: 'manual' })).status).toBe(302);
  });

  it('a document id of another business never yields a download link', async () => {
    // A mail of this business whose attachment names a document that exists
    // only in the other business: the id is there, the link must not be.
    await addDocument(OTHER, 'docForeign');
    await mailWith(BUSINESS, {
      providerMessageId: 'XB-1',
      attachments: [att('a1', 'foreign.pdf', { docType: 'invoice', summary: 'מצביע לעסק אחר', documentId: 'docForeign' })],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail/documents')).text();
    expect(html).toContain('מצביע לעסק אחר');
    expect(html).not.toContain('/documents/docForeign/file');
    expect(html).toContain('אין קובץ');
    expect((await get(baseUrl, cookie, '/documents/docForeign/file')).status).toBe(404);
  });

  it('the sender filter matches by name and address, and a % is a literal', async () => {
    await mailWith(BUSINESS, {
      providerMessageId: 'SF-1', fromAddress: 'dana@client.example', fromName: 'דנה',
      attachments: [att('a1', 'd.pdf', { docType: 'quote', summary: 'מסמך של דנה' })],
    });
    await mailWith(BUSINESS, {
      providerMessageId: 'SF-2', fromAddress: 'promo@shop.example', fromName: '100% שירות',
      attachments: [att('a1', 'p.pdf', { docType: 'other', summary: 'מסמך של מאה אחוז' })],
    });
    // Would match '100%' if the % were a wildcard.
    await mailWith(BUSINESS, {
      providerMessageId: 'SF-3', fromAddress: 'x@decoy.example', fromName: '100 שקל',
      attachments: [att('a1', 'x.pdf', { docType: 'other', summary: 'מסמך פיתיון' })],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const byName = await (await get(baseUrl, cookie, `/mail/documents?sender=${encodeURIComponent('דנה')}`)).text();
    expect(byName).toContain('מסמך של דנה');
    expect(byName).not.toContain('מסמך של מאה אחוז');
    const byAddress = await (await get(baseUrl, cookie, '/mail/documents?sender=client.example')).text();
    expect(byAddress).toContain('מסמך של דנה');
    expect(byAddress).not.toContain('מסמך פיתיון');
    const literal = await (await get(baseUrl, cookie, `/mail/documents?sender=${encodeURIComponent('100%')}`)).text();
    expect(literal).toContain('מסמך של מאה אחוז');
    expect(literal).not.toContain('מסמך פיתיון');
    expect(literal).not.toContain('מסמך של דנה');
  });

  it('strips direction controls from the file name on the documents screen', async () => {
    await mailWith(BUSINESS, {
      providerMessageId: 'FN-1',
      attachments: [att('a1', 'invoice\u202Efdp.exe', { docType: 'invoice', summary: 'שם קובץ הפוך' })],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail/documents')).text();
    expect(html).toContain('invoicefdp.exe');
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });

  it('says when the list was cut at the limit, and only then', async () => {
    const m = await mailWith(BUSINESS, {
      providerMessageId: 'LIM-1',
      attachments: [att('a0', 'one.pdf', { docType: 'other', summary: 'יחיד' })],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    expect(await (await get(baseUrl, cookie, '/mail/documents')).text()).not.toContain('האחרונים');
    // More attachments than the screen shows: written straight to the JSON,
    // because the stored-mail path keeps ten.
    const many = Array.from({ length: DOCUMENT_LIMIT + 1 }, (_, i) => att(`l${i}`, `f${i}.pdf`, { docType: 'other' }));
    await getPool().query(`UPDATE mail_messages SET attachments = $2::jsonb WHERE mail_id = $1`, [m.mailId, JSON.stringify(many)]);
    const html = await (await get(baseUrl, cookie, '/mail/documents')).text();
    expect(html).toContain(`מוצגים ${DOCUMENT_LIMIT} האחרונים`);
    expect(html.match(/<tr>/g)?.length).toBe(DOCUMENT_LIMIT + 1); // header row + the limit
  });

  it('summary with U+202E is stripped on every surface', async () => {
    const m = await mailWith(BUSINESS, {
      providerMessageId: 'BD-1',
      attachments: [att('a1', 'x.pdf', { docType: 'report', summary: 'דוח\u202E חצי\u2066 שנתי' })],
    });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    for (const path of [`/mail/${m.mailId}`, '/mail/documents']) {
      const html = await (await get(baseUrl, cookie, path)).text();
      expect(html).toContain('דוח חצי שנתי');
      expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    }
  });
});
