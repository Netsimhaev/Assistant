/**
 * Handlers for the mail screens and the document download. The renderers are
 * in `mail-views.ts`; this file reads.
 *
 * Every read here is scoped to `businessId`. The document download is the one
 * route that touches the filesystem: the path comes from `documents.stored_path`
 * (built from system-generated ids at ingest), is resolved against the
 * document root, and is refused unless its REAL path (symlinks followed) is
 * still inside the real root.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { loadDocument } from '../documents/store.js';
import { AttachmentDocType } from '../domain/mail-triage.js';
import { LIKE_ESCAPE, likeLiteral } from '../util/like.js';
import { getCursor, getMail, listInvoices, searchMail } from '../mail/inbox-store.js';
import type { MailCategory } from '../mail/mailbox.js';
import { stripBidiControls } from '../util/bidi.js';
import { mailboxBannerStatus } from './mailbox-connect.js';
import {
  groupInvoices,
  renderInvoices,
  renderMailDocuments,
  type DocumentFilters,
  type DocumentRow,
  renderMailDetail,
  renderMailList,
  type InvoiceFilters,
  type MailFilters,
} from './mail-views.js';

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;
const MAIL_LIMIT = 100;
const CATEGORIES: readonly string[] = ['invoice', 'question', 'document', 'other'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('לא נמצא');
}

/** The charter's own zone; `UTC` only when no readable charter exists (a stated stand-in, not a silent default). */
async function charterTimeZone(businessId: string): Promise<string> {
  try {
    const active = await loadActiveCharter(businessId);
    return active?.charter.identity.timezone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - instant;
}

/** Midnight at the start of `day` (`YYYY-MM-DD`) in `timeZone`, as an ISO instant; `null` for anything that is not a date. */
export function dayStartIso(day: string, timeZone: string): string | null {
  if (!DAY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  if (Number.isNaN(naive) || new Date(naive).getUTCDate() !== d) return null;
  let guess = naive - offsetMs(naive, timeZone);
  guess = naive - offsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

/** The instant after the whole of `day`: start of the next calendar day. */
function dayEndIso(day: string, timeZone: string): string | null {
  if (!DAY.test(day)) return null;
  const next = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return null;
  next.setUTCDate(next.getUTCDate() + 1);
  return dayStartIso(next.toISOString().slice(0, 10), timeZone);
}

function param(url: URL, name: string): string {
  return stripBidiControls(url.searchParams.get(name) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const CURSOR_PROBLEM = /^(cursor_expired_unrecovered|list_|credential_error)/;
const GAP_WINDOW_DAYS = 7;

/**
 * When the poll last recorded a reconnect gap (mail that arrived while the
 * mailbox was disconnected and was never read), within the last week. Read
 * from the durable audit row, not from `mailbox_cursor.last_error`, which the
 * next clean pass overwrites.
 */
async function recentGapAt(businessId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ at: Date | null }>(
    `SELECT max(at) AS at FROM audit_log
      WHERE business_id = $1 AND reason = 'mail_cursor_gap' AND at > now() - ($2 || ' days')::interval`,
    [businessId, String(GAP_WINDOW_DAYS)],
  );
  return rows[0]?.at?.toISOString() ?? null;
}

/** The subset of `ids` that belong to this business and are in a status that may be served. */
async function downloadableDocuments(businessId: string, ids: readonly (string | undefined)[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== undefined))];
  if (wanted.length === 0) return new Set();
  const { rows } = await getPool().query<{ document_id: string }>(
    `SELECT document_id FROM documents
      WHERE business_id = $1 AND document_id = ANY($2::text[]) AND status IN ('extracted', 'stored')`,
    [businessId, wanted],
  );
  return new Set(rows.map((r) => r.document_id));
}

export async function handleMailList(res: ServerResponse, businessId: string, url: URL, csrf: string): Promise<void> {
  const filters: MailFilters = {
    q: param(url, 'q'),
    from: param(url, 'from'),
    to: param(url, 'to'),
    sender: param(url, 'sender'),
    category: param(url, 'category'),
  };
  const timeZone = await charterTimeZone(businessId);
  const fromIso = dayStartIso(filters.from, timeZone);
  const toIso = dayEndIso(filters.to, timeZone);
  const rows = await searchMail(
    {
      ...(filters.q !== '' ? { text: filters.q } : {}),
      ...(filters.sender !== '' ? { sender: filters.sender } : {}),
      ...(fromIso !== null ? { fromIso } : {}),
      ...(toIso !== null ? { toIso } : {}),
      ...(CATEGORIES.includes(filters.category) ? { category: filters.category as MailCategory } : {}),
      limit: MAIL_LIMIT,
    },
    { businessId },
  );
  const [mailboxStatus, cursor, gapAt, downloadable] = await Promise.all([
    mailboxBannerStatus(businessId),
    getCursor({ businessId }),
    recentGapAt(businessId),
    downloadableDocuments(businessId, rows.flatMap((m) => m.attachments.map((a) => a.documentId))),
  ]);
  html(
    res,
    200,
    renderMailList({
      rows,
      filters,
      mailboxStatus,
      gapAt,
      cursorProblem: CURSOR_PROBLEM.test(cursor?.lastError ?? ''),
      downloadable,
      timeZone,
      csrf,
    }),
  );
}

export async function handleInvoices(res: ServerResponse, businessId: string, url: URL, csrf: string): Promise<void> {
  const filters: InvoiceFilters = {
    supplier: param(url, 'supplier'),
    number: param(url, 'number'),
    from: param(url, 'from'),
    to: param(url, 'to'),
    file: param(url, 'file'),
  };
  const timeZone = await charterTimeZone(businessId);
  const fromIso = dayStartIso(filters.from, timeZone);
  const toIso = dayEndIso(filters.to, timeZone);
  const rows = await listInvoices(
    {
      ...(filters.supplier !== '' ? { supplier: filters.supplier } : {}),
      ...(filters.number !== '' ? { invoiceNumber: filters.number } : {}),
      ...(filters.file !== '' ? { fileName: filters.file } : {}),
      ...(fromIso !== null ? { fromIso } : {}),
      ...(toIso !== null ? { toIso } : {}),
    },
    { businessId },
  );
  html(res, 200, renderInvoices({ groups: groupInvoices(rows), filters, timeZone, csrf }));
}

const DOCUMENT_LIMIT = 200;

/** Every attachment of every mail of this business, newest mail first, filtered as the owner asked. */
export async function handleMailDocuments(res: ServerResponse, businessId: string, url: URL): Promise<void> {
  const requestedType = param(url, 'type');
  // A closed set: anything else means "no filter" and is never echoed back.
  const type = AttachmentDocType.safeParse(requestedType).success ? requestedType : '';
  const filters: DocumentFilters = { type, sender: param(url, 'sender'), from: param(url, 'from'), to: param(url, 'to') };
  const timeZone = await charterTimeZone(businessId);
  const fromIso = dayStartIso(filters.from, timeZone);
  const toIso = dayEndIso(filters.to, timeZone);
  const where = ['m.business_id = $1'];
  const params: unknown[] = [businessId];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    where.push(sql(params.length));
  };
  if (type !== '') add((n) => `a.elem ->> 'docType' = $${n}`, type);
  if (filters.sender !== '') {
    add(
      (n) => `(m.from_address ILIKE $${n} ${LIKE_ESCAPE} OR coalesce(m.from_name, '') ILIKE $${n} ${LIKE_ESCAPE})`,
      `%${likeLiteral(filters.sender)}%`,
    );
  }
  if (fromIso !== null) add((n) => `m.received_at >= $${n}::timestamptz`, fromIso);
  if (toIso !== null) add((n) => `m.received_at < $${n}::timestamptz`, toIso);
  params.push(DOCUMENT_LIMIT);
  const { rows } = await getPool().query<{
    mail_id: string;
    received_at: Date;
    from_name: string | null;
    from_address: string;
    filename: string | null;
    doc_type: string | null;
    summary: string | null;
    scanned: boolean | null;
    document_id: string | null;
  }>(
    `SELECT m.mail_id, m.received_at, m.from_name, m.from_address,
            a.elem ->> 'filename' AS filename, a.elem ->> 'docType' AS doc_type,
            a.elem ->> 'summary' AS summary, (a.elem ->> 'scanned')::boolean AS scanned,
            a.elem ->> 'documentId' AS document_id
       FROM mail_messages m
      CROSS JOIN LATERAL jsonb_array_elements(m.attachments) AS a(elem)
      WHERE ${where.join(' AND ')}
      ORDER BY m.received_at DESC, m.mail_id DESC LIMIT $${params.length}`,
    params,
  );
  const docs: DocumentRow[] = rows.map((r) => ({
    mailId: r.mail_id,
    receivedAt: r.received_at.toISOString(),
    fromName: r.from_name,
    fromAddress: r.from_address,
    filename: r.filename ?? '',
    docType: r.doc_type,
    summary: r.summary,
    scanned: r.scanned === true,
    documentId: r.document_id,
  }));
  const downloadable = await downloadableDocuments(businessId, docs.map((d) => d.documentId ?? undefined));
  html(res, 200, renderMailDocuments({ rows: docs, filters, downloadable, timeZone }));
}

export async function handleMailDetail(res: ServerResponse, businessId: string, mailId: string): Promise<void> {
  const mail = await getMail(mailId, { businessId });
  if (mail === null) return notFound(res);
  const timeZone = await charterTimeZone(businessId);
  const db = getPool();
  let cardApprovalId: string | null = null;
  if (mail.replyJobId !== null) {
    const { rows } = await db.query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests
        WHERE business_id = $1 AND job_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [businessId, mail.replyJobId],
    );
    cardApprovalId = rows[0]?.approval_id ?? null;
  }
  const { rows: docRows } = await db.query<{ document_id: string; file_name: string | null }>(
    `SELECT i.document_id, i.file_name
       FROM mail_invoices i
       JOIN documents d ON d.document_id = i.document_id AND d.business_id = i.business_id
      WHERE i.business_id = $1 AND i.mail_id = $2 AND i.document_id IS NOT NULL
        AND d.status IN ('extracted', 'stored')`,
    [businessId, mail.mailId],
  );
  html(
    res,
    200,
    renderMailDetail({
      mail,
      timeZone,
      cardApprovalId,
      documents: docRows.map((r) => ({ documentId: r.document_id, fileName: r.file_name })),
      downloadable: await downloadableDocuments(businessId, mail.attachments.map((a) => a.documentId)),
    }),
  );
}

/** RFC 5987 `ext-value` encoding: `encodeURIComponent` plus the characters it leaves that attr-char forbids. */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const SAFE_MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;

export async function handleDocumentFile(
  res: ServerResponse,
  businessId: string,
  documentId: string,
  documentRoot: string | undefined,
): Promise<void> {
  const doc = await loadDocument(documentId, { businessId });
  if (doc === null || (doc.status !== 'extracted' && doc.status !== 'stored')) return notFound(res);

  const root = resolve(documentRoot ?? config.documentRoot);
  const candidate = resolve(root, doc.storedPath);
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch {
    return notFound(res);
  }
  const rel = relative(realRoot, realFile);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return notFound(res);
  let size: number;
  try {
    const info = await stat(realFile);
    if (!info.isFile()) return notFound(res);
    size = info.size;
  } catch {
    return notFound(res);
  }

  const name = stripBidiControls(doc.originalName).replace(/[\u0000-\u001f\u007f]/g, '') || 'document';
  const contentType = SAFE_MEDIA_TYPE.test(doc.mediaType) ? doc.mediaType : 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${rfc5987(name)}`,
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS,
  });
  const stream = createReadStream(realFile);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
