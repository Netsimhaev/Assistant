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
import { insertInvoice, markOverCap, noteMailError, setCursor, settleMail } from '../mail/inbox-store.js';
import { resetDatabase } from '../test/db.js';
import { storedMail } from '../test/mailbox.js';
import { createOwner } from './auth.js';
import { createServer } from './server.js';

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
    await setCursor({ provider: 'google', cursor: 'c', lastError: 'cursor_expired_gap' }, { businessId: BUSINESS });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('חלק מהמיילים שהגיעו בזמן שהתיבה הייתה מנותקת לא נקראו');
    expect(html).toContain('לא הצלחנו להתריע');
    expect(html).not.toContain('notify_failed');
  });

  it('escapes a hostile sender name and strips bidi controls', async () => {
    await storedMail(BUSINESS, { providerMessageId: 'PM-H', fromName: '<img src=x>‮evil' });
    const baseUrl = await start();
    const cookie = await login(baseUrl);
    const html = await (await get(baseUrl, cookie, '/mail')).text();
    expect(html).toContain('&lt;img src=x&gt;evil');
    expect(html).not.toContain('‮');
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
    await addDocument(BUSINESS, 'docA', { name: 'חשבונית‮.pdf' });
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
