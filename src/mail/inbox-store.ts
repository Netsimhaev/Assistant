/**
 * Inbox store: the mail we read, the poll cursor, and extracted invoices.
 *
 * Dedupe is the unique index on `(business_id, provider_message_id)`:
 * `recordIncoming` inserts with `ON CONFLICT DO NOTHING RETURNING` and reads
 * `null` off the empty result. `claimMail` is a single conditional UPDATE
 * whose row count says whether it won, so two pollers cannot both proceed.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { LIKE_ESCAPE, likeLiteral } from '../util/like.js';
import type { MailCategory, MailProvider } from './mailbox.js';

type Options = { businessId?: string; db?: Queryable };

export type MailState = 'received' | 'claimed' | 'over_cap' | 'triaged' | 'failed';

export interface HeaderFlags {
  listUnsubscribe: boolean;
  autoSubmitted: boolean;
  bulkPrecedence: boolean;
}

export interface MailAttachment {
  attachmentId: string;
  filename: string;
  mediaType: string;
  size: number;
}

export interface IncomingMail {
  providerMessageId: string;
  threadId: string;
  internetMessageId: string | null;
  references: string | null;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  toAddresses: string[];
  subject: string;
  receivedAt: string;
  bodyText: string;
  bodyTruncated: boolean;
  headerFlags: HeaderFlags;
  attachments: MailAttachment[];
}

export interface StoredMail extends IncomingMail {
  mailId: string;
  /** Empty string once the retention window scrubbed the body (column is NULL). */
  bodyText: string;
  state: MailState;
  categories: MailCategory[];
  summary: string | null;
  isPerson: boolean | null;
  jobId: string | null;
  replyJobId: string | null;
  labelsApplied: string[];
  notifiedAt: string | null;
  error: string | null;
  triagedAt: string | null;
  createdAt: string;
}

export type MailRow = StoredMail;

export interface SettlePatch {
  state: 'triaged' | 'failed';
  categories?: MailCategory[];
  summary?: string;
  isPerson?: boolean;
  jobId?: string;
  replyJobId?: string;
  labelsApplied?: string[];
  notifiedAt?: string;
  error?: string;
}

export interface MailSearch {
  text?: string;
  fromIso?: string;
  toIso?: string;
  sender?: string;
  category?: MailCategory;
  limit: number;
}

export interface MailCursor {
  provider: MailProvider;
  cursor: string;
  connectedAt?: string;
  lastPollAt?: string | null;
  lastError?: string | null;
}

export interface NewInvoice {
  mailId: string;
  supplierAddress: string;
  supplierName: string | null;
  invoiceNumber: string | null;
  amountText: string | null;
  documentId: string | null;
  fileName: string | null;
  receivedAt: string;
}

export interface InvoiceFilter {
  supplier?: string;
  invoiceNumber?: string;
  fromIso?: string;
  toIso?: string;
  fileName?: string;
}

export interface InvoiceRow extends NewInvoice {
  invoiceId: string;
  createdAt: string;
}

interface MailDbRow {
  mail_id: string;
  provider_message_id: string;
  thread_id: string;
  internet_message_id: string | null;
  references_header: string | null;
  from_address: string;
  from_name: string | null;
  reply_to: string | null;
  to_addresses: string[];
  subject: string;
  received_at: Date;
  body_text: string | null;
  body_truncated: boolean;
  header_flags: HeaderFlags;
  attachments: MailAttachment[];
  state: string;
  categories: string[];
  summary: string | null;
  is_person: boolean | null;
  job_id: string | null;
  reply_job_id: string | null;
  labels_applied: string[];
  notified_at: Date | null;
  error: string | null;
  triaged_at: Date | null;
  created_at: Date;
}

function toStoredMail(row: MailDbRow): StoredMail {
  return {
    mailId: row.mail_id,
    providerMessageId: row.provider_message_id,
    threadId: row.thread_id,
    internetMessageId: row.internet_message_id,
    references: row.references_header,
    fromAddress: row.from_address,
    fromName: row.from_name,
    replyTo: row.reply_to,
    toAddresses: row.to_addresses,
    subject: row.subject,
    receivedAt: row.received_at.toISOString(),
    bodyText: row.body_text ?? '',
    bodyTruncated: row.body_truncated,
    headerFlags: row.header_flags,
    attachments: row.attachments,
    state: row.state as MailState,
    categories: row.categories as MailCategory[],
    summary: row.summary,
    isPerson: row.is_person,
    jobId: row.job_id,
    replyJobId: row.reply_job_id,
    labelsApplied: row.labels_applied,
    notifiedAt: row.notified_at?.toISOString() ?? null,
    error: row.error,
    triagedAt: row.triaged_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = `mail_id, provider_message_id, thread_id, internet_message_id,
  references_header, from_address, from_name, reply_to, to_addresses, subject,
  received_at, body_text, body_truncated, header_flags, attachments, state,
  categories, summary, is_person, job_id, reply_job_id, labels_applied,
  notified_at, error, triaged_at, created_at`;

function ctx(options: Options): { businessId: string; db: Queryable } {
  return { businessId: options.businessId ?? config.businessId, db: options.db ?? getPool() };
}

/** Returns `null` on a duplicate `(business_id, provider_message_id)`. */
export async function recordIncoming(input: IncomingMail, options: Options = {}): Promise<StoredMail | null> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<MailDbRow>(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, internet_message_id,
        references_header, from_address, from_name, reply_to, to_addresses, subject,
        received_at, body_text, body_truncated, header_flags, attachments, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'received')
     ON CONFLICT (business_id, provider_message_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      `M-${ulid()}`, businessId, input.providerMessageId, input.threadId,
      input.internetMessageId, input.references, input.fromAddress, input.fromName,
      input.replyTo, input.toAddresses, input.subject, input.receivedAt,
      input.bodyText, input.bodyTruncated, JSON.stringify(input.headerFlags),
      JSON.stringify(input.attachments),
    ],
  );
  const row = rows[0];
  return row ? toStoredMail(row) : null;
}

/** Moves `received|over_cap` to `claimed`; the row count says who won. */
export async function claimMail(mailId: string, options: Options = {}): Promise<boolean> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET state = 'claimed'
      WHERE business_id = $1 AND mail_id = $2 AND state IN ('received', 'over_cap')`,
    [businessId, mailId],
  );
  return (res.rowCount ?? 0) === 1;
}

export async function settleMail(mailId: string, patch: SettlePatch, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET
        state = $3,
        categories = COALESCE($4::text[], categories),
        summary = COALESCE($5, summary),
        is_person = COALESCE($6, is_person),
        job_id = COALESCE($7, job_id),
        reply_job_id = COALESCE($8, reply_job_id),
        labels_applied = COALESCE($9::text[], labels_applied),
        notified_at = COALESCE($10::timestamptz, notified_at),
        error = COALESCE($11, error),
        triaged_at = now()
      WHERE business_id = $1 AND mail_id = $2`,
    [
      businessId, mailId, patch.state, patch.categories ?? null, patch.summary ?? null,
      patch.isPerson ?? null, patch.jobId ?? null, patch.replyJobId ?? null,
      patch.labelsApplied ?? null, patch.notifiedAt ?? null, patch.error ?? null,
    ],
  );
  if ((res.rowCount ?? 0) !== 1) throw new Error(`settleMail: no mail row for ${mailId}`);
}

export async function markOverCap(mailId: string, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  await db.query(
    `UPDATE mail_messages SET state = 'over_cap'
      WHERE business_id = $1 AND mail_id = $2 AND state IN ('received', 'over_cap')`,
    [businessId, mailId],
  );
}

/** Rows in `received` or `over_cap`, oldest first. */
export async function mailAwaitingTriage(limit: number, options: Options = {}): Promise<StoredMail[]> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<MailDbRow>(
    `SELECT ${COLUMNS} FROM mail_messages
      WHERE business_id = $1 AND state IN ('received', 'over_cap')
      ORDER BY received_at ASC, mail_id ASC LIMIT $2`,
    [businessId, limit],
  );
  return rows.map(toStoredMail);
}

/** Rows whose `triaged_at` falls in the current day. */
export async function mailReadsToday(options: Options = {}): Promise<number> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM mail_messages
      WHERE business_id = $1 AND triaged_at >= date_trunc('day', now())`,
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

interface CursorRow {
  provider: string;
  cursor: string;
  connected_at: Date;
  last_poll_at: Date | null;
  last_error: string | null;
}

export async function getCursor(options: Options = {}): Promise<MailCursor | null> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<CursorRow>(
    `SELECT provider, cursor, connected_at, last_poll_at, last_error
       FROM mailbox_cursor WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    provider: row.provider as MailProvider,
    cursor: row.cursor,
    connectedAt: row.connected_at.toISOString(),
    lastPollAt: row.last_poll_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

export async function setCursor(c: MailCursor, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  await db.query(
    `INSERT INTO mailbox_cursor (business_id, provider, cursor, last_poll_at, last_error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id) DO UPDATE SET
       provider = EXCLUDED.provider, cursor = EXCLUDED.cursor,
       last_poll_at = EXCLUDED.last_poll_at, last_error = EXCLUDED.last_error`,
    [businessId, c.provider, c.cursor, c.lastPollAt ?? null, c.lastError ?? null],
  );
}

export async function insertInvoice(i: NewInvoice, options: Options = {}): Promise<string> {
  const { businessId, db } = ctx(options);
  const id = `INV-${ulid()}`;
  await db.query(
    `INSERT INTO mail_invoices
       (invoice_id, business_id, mail_id, supplier_address, supplier_name,
        invoice_number, amount_text, document_id, file_name, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, businessId, i.mailId, i.supplierAddress, i.supplierName, i.invoiceNumber,
     i.amountText, i.documentId, i.fileName, i.receivedAt],
  );
  return id;
}

/** Small builder so every filter is a numbered parameter, never interpolated. */
function builder(businessId: string): {
  where: string[];
  params: unknown[];
  add: (sql: (n: number) => string, value: unknown) => void;
} {
  const where: string[] = ['business_id = $1'];
  const params: unknown[] = [businessId];
  return {
    where,
    params,
    add: (sql, value) => {
      params.push(value);
      where.push(sql(params.length));
    },
  };
}

export async function searchMail(q: MailSearch, options: Options = {}): Promise<MailRow[]> {
  const { businessId, db } = ctx(options);
  const b = builder(businessId);
  if (q.text) {
    b.add(
      (n) => `(subject ILIKE $${n} ${LIKE_ESCAPE}
               OR coalesce(body_text, '') ILIKE $${n} ${LIKE_ESCAPE}
               OR coalesce(summary, '') ILIKE $${n} ${LIKE_ESCAPE})`,
      `%${likeLiteral(q.text)}%`,
    );
  }
  if (q.sender) {
    b.add(
      (n) => `(from_address ILIKE $${n} ${LIKE_ESCAPE}
               OR coalesce(from_name, '') ILIKE $${n} ${LIKE_ESCAPE})`,
      `%${likeLiteral(q.sender)}%`,
    );
  }
  if (q.fromIso) b.add((n) => `received_at >= $${n}::timestamptz`, q.fromIso);
  if (q.toIso) b.add((n) => `received_at < $${n}::timestamptz`, q.toIso);
  if (q.category) b.add((n) => `$${n} = ANY(categories)`, q.category);
  b.params.push(q.limit);
  const { rows } = await db.query<MailDbRow>(
    `SELECT ${COLUMNS} FROM mail_messages WHERE ${b.where.join(' AND ')}
      ORDER BY received_at DESC, mail_id DESC LIMIT $${b.params.length}`,
    b.params,
  );
  return rows.map(toStoredMail);
}

interface InvoiceDbRow {
  invoice_id: string;
  mail_id: string;
  supplier_address: string;
  supplier_name: string | null;
  invoice_number: string | null;
  amount_text: string | null;
  document_id: string | null;
  file_name: string | null;
  received_at: Date;
  created_at: Date;
}

function toInvoiceRow(row: InvoiceDbRow): InvoiceRow {
  return {
    invoiceId: row.invoice_id,
    mailId: row.mail_id,
    supplierAddress: row.supplier_address,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    amountText: row.amount_text,
    documentId: row.document_id,
    fileName: row.file_name,
    receivedAt: row.received_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export async function listInvoices(f: InvoiceFilter, options: Options = {}): Promise<InvoiceRow[]> {
  const { businessId, db } = ctx(options);
  const b = builder(businessId);
  if (f.supplier) {
    b.add(
      (n) => `(supplier_address ILIKE $${n} ${LIKE_ESCAPE}
               OR coalesce(supplier_name, '') ILIKE $${n} ${LIKE_ESCAPE})`,
      `%${likeLiteral(f.supplier)}%`,
    );
  }
  if (f.invoiceNumber) {
    b.add((n) => `coalesce(invoice_number, '') ILIKE $${n} ${LIKE_ESCAPE}`, `%${likeLiteral(f.invoiceNumber)}%`);
  }
  if (f.fileName) {
    b.add((n) => `coalesce(file_name, '') ILIKE $${n} ${LIKE_ESCAPE}`, `%${likeLiteral(f.fileName)}%`);
  }
  if (f.fromIso) b.add((n) => `received_at >= $${n}::timestamptz`, f.fromIso);
  if (f.toIso) b.add((n) => `received_at < $${n}::timestamptz`, f.toIso);
  const { rows } = await db.query<InvoiceDbRow>(
    `SELECT invoice_id, mail_id, supplier_address, supplier_name, invoice_number,
            amount_text, document_id, file_name, received_at, created_at
       FROM mail_invoices WHERE ${b.where.join(' AND ')}
      ORDER BY received_at DESC, invoice_id DESC`,
    b.params,
  );
  return rows.map(toInvoiceRow);
}
