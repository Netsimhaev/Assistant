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
  /** Set once the attachment was ingested as a document (`linkAttachmentDocument`). */
  documentId?: string;
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

/**
 * Postgres refuses U+0000 in `text` and in `jsonb`, so one hostile mail with a
 * NUL in its subject, body or attachment name used to make `recordIncoming`
 * throw on every pass — and the cursor never advanced past it. Stripped here,
 * in the one function both providers record through.
 */
function noNul(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}

function sanitize(input: IncomingMail): IncomingMail {
  const opt = (v: string | null): string | null => (v === null ? null : noNul(v));
  return {
    providerMessageId: noNul(input.providerMessageId),
    threadId: noNul(input.threadId),
    internetMessageId: opt(input.internetMessageId),
    references: opt(input.references),
    fromAddress: noNul(input.fromAddress),
    fromName: opt(input.fromName),
    replyTo: opt(input.replyTo),
    toAddresses: input.toAddresses.map(noNul),
    subject: noNul(input.subject),
    receivedAt: noNul(input.receivedAt),
    bodyText: noNul(input.bodyText),
    bodyTruncated: input.bodyTruncated,
    headerFlags: input.headerFlags,
    attachments: input.attachments.map((a) => ({
      attachmentId: noNul(a.attachmentId),
      filename: noNul(a.filename),
      mediaType: noNul(a.mediaType),
      size: a.size,
    })),
  };
}

/** Returns `null` on a duplicate `(business_id, provider_message_id)`. */
export async function recordIncoming(raw: IncomingMail, options: Options = {}): Promise<StoredMail | null> {
  const { businessId, db } = ctx(options);
  const input = sanitize(raw);
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

/**
 * The mail whose triage job is this one, or `null`. The curation brief reads
 * the sender from here: the stored header, never anything a model said.
 */
export async function mailForJob(jobId: string, options: Options = {}): Promise<StoredMail | null> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<MailDbRow>(
    `SELECT ${COLUMNS} FROM mail_messages WHERE business_id = $1 AND job_id = $2 LIMIT 1`,
    [businessId, jobId],
  );
  const row = rows[0];
  return row ? toStoredMail(row) : null;
}

/** Moves `received|over_cap` to `claimed`; the row count says who won. */
export async function claimMail(mailId: string, options: Options = {}): Promise<boolean> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET state = 'claimed', claimed_at = now()
      WHERE business_id = $1 AND mail_id = $2 AND state IN ('received', 'over_cap')`,
    [businessId, mailId],
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * Return claims older than `minutes` to `received`, so a poller that crashed
 * after `claimMail` does not leave the mail stuck forever (nothing re-reads
 * `claimed`). A NULL `claimed_at` (a row claimed before migration 044) counts
 * as stale. The orphaned triage job is the re-handler's to close — it knows
 * the mail's `job_id`. Returns how many rows moved.
 */
export async function staleClaimsToReceived(minutes: number, options: Options = {}): Promise<number> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET state = 'received', claimed_at = NULL
      WHERE business_id = $1 AND state = 'claimed'
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $2))`,
    [businessId, minutes],
  );
  return res.rowCount ?? 0;
}

export const UNRECORDABLE_SUBJECT = '(לא ניתן לשמור את המייל)';

/**
 * A placeholder for a message that failed to record on several passes in a
 * row: no content at all, state `failed`, error `unrecordable`. It exists so
 * the cursor can move past the message (the dedupe then absorbs it on every
 * later listing) and so the mail screen shows that something arrived and was
 * not kept. `ON CONFLICT DO NOTHING`: a real row, if one ever got written,
 * wins.
 */
export async function recordUnrecordable(providerMessageId: string, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  await db.query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
        received_at, body_text, state, error)
     VALUES ($1, $2, $3, '', '', $4, now(), NULL, 'failed', 'unrecordable')
     ON CONFLICT (business_id, provider_message_id) DO NOTHING`,
    [`M-${ulid()}`, businessId, noNul(providerMessageId), UNRECORDABLE_SUBJECT],
  );
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

/**
 * Record why a mail got no reply card, without touching `state`.
 *
 * Separate from `settleMail` on purpose: the reply path (`mail-reply.ts`)
 * runs inside the poller's handling of one mail, before the poller settles
 * it, and must not decide that mail's state. `settleMail` COALESCEs `error`,
 * so a later settle without an error keeps this one.
 */
export async function noteMailError(mailId: string, error: string, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    'UPDATE mail_messages SET error = $3 WHERE business_id = $1 AND mail_id = $2',
    [businessId, mailId, error],
  );
  if ((res.rowCount ?? 0) !== 1) throw new Error(`noteMailError: no mail row for ${mailId}`);
}

/**
 * Point a mail at its reply job — the positive marker `reraiseAfterFailedSend`
 * finds reply jobs by. Written by the reply path itself, so the marker does not
 * depend on the poller settling the row.
 */
export async function linkReplyJob(mailId: string, replyJobId: string, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    'UPDATE mail_messages SET reply_job_id = $3 WHERE business_id = $1 AND mail_id = $2',
    [businessId, mailId, replyJobId],
  );
  if ((res.rowCount ?? 0) !== 1) throw new Error(`linkReplyJob: no mail row for ${mailId}`);
}

/**
 * Whether a job is a mailbox reply job — the positive marker the dashboard
 * keys the reply card's layout and edit rule on. Only the reply path writes
 * `reply_job_id`, so a card built from some other payload that merely LOOKS
 * like a reply never gets the reply layout.
 */
export async function isMailReplyJob(jobId: string, options: Options = {}): Promise<boolean> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query(
    'SELECT 1 FROM mail_messages WHERE business_id = $1 AND reply_job_id = $2 LIMIT 1',
    [businessId, jobId],
  );
  return rows.length > 0;
}

/**
 * Take a failed reply job off its mail, so it is re-raised at most once.
 *
 * A single conditional UPDATE: the row count says whether this caller won.
 * Two concurrent re-raisers cannot both proceed, and a crash after the claim
 * leaves the mail unlinked — the failed job is never offered again, which is
 * the safe direction (no second card, so no second send), never a duplicate.
 */
export async function claimFailedReply(
  mailId: string,
  failedJobId: string,
  options: Options = {},
): Promise<boolean> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET reply_job_id = NULL
      WHERE business_id = $1 AND mail_id = $2 AND reply_job_id = $3`,
    [businessId, mailId, failedJobId],
  );
  return (res.rowCount ?? 0) === 1;
}

/**
 * Record a side effect the poller just performed — a label added in the
 * mailbox, a WhatsApp notice sent — the moment it happens, without touching
 * `state`.
 *
 * Settling writes the same columns, but only at the end of a mail's handling.
 * A crash between the label (or the notice) and the settle would otherwise
 * leave the row `claimed` with nothing saying the effect already happened,
 * and the next handling would label or notify a second time (spec §5.4: "a
 * re-poll after a crash does not read, label or notify twice").
 */
export async function recordMailProgress(
  mailId: string,
  progress: { labelsApplied?: string[]; notifiedAt?: string; jobId?: string },
  options: Options = {},
): Promise<void> {
  const { businessId, db } = ctx(options);
  const res = await db.query(
    `UPDATE mail_messages SET
        labels_applied = COALESCE($3::text[], labels_applied),
        notified_at = COALESCE($4::timestamptz, notified_at),
        job_id = COALESCE($5, job_id)
      WHERE business_id = $1 AND mail_id = $2`,
    [businessId, mailId, progress.labelsApplied ?? null, progress.notifiedAt ?? null, progress.jobId ?? null],
  );
  if ((res.rowCount ?? 0) !== 1) throw new Error(`recordMailProgress: no mail row for ${mailId}`);
}

/** Whether an invoice row already exists for this mail — a re-handled mail must not add a second. */
export async function hasInvoiceForMail(mailId: string, options: Options = {}): Promise<boolean> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query(
    'SELECT 1 FROM mail_invoices WHERE business_id = $1 AND mail_id = $2 LIMIT 1',
    [businessId, mailId],
  );
  return rows.length > 0;
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

/**
 * Whole-row write of the cursor. `connectedAt` is written when given (the
 * connect ceremony passes it, so a reconnect — possibly to another provider —
 * moves it) and otherwise left as it was (`now()` on a first insert). The
 * poll fields are replaced as given, `null` when omitted: a caller advancing
 * the cursor states its own poll outcome.
 */
export async function setCursor(c: MailCursor, options: Options = {}): Promise<void> {
  const { businessId, db } = ctx(options);
  await db.query(
    `INSERT INTO mailbox_cursor (business_id, provider, cursor, connected_at, last_poll_at, last_error)
     VALUES ($1, $2, $3, COALESCE($6::timestamptz, now()), $4, $5)
     ON CONFLICT (business_id) DO UPDATE SET
       provider = EXCLUDED.provider, cursor = EXCLUDED.cursor,
       connected_at = COALESCE($6::timestamptz, mailbox_cursor.connected_at),
       last_poll_at = EXCLUDED.last_poll_at, last_error = EXCLUDED.last_error`,
    [businessId, c.provider, c.cursor, c.lastPollAt ?? null, c.lastError ?? null, c.connectedAt ?? null],
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

/**
 * Record, inside the mail's own `attachments` JSON, which document an
 * attachment became. No new table: the mail row already owns its attachment
 * list. Business-scoped; ids are NUL-stripped like everything else that is
 * written from provider text. Other elements are left exactly as they were.
 */
export async function linkAttachmentDocument(
  mailId: string,
  attachmentId: string,
  documentId: string,
  options: Options = {},
): Promise<void> {
  const { businessId, db } = ctx(options);
  await db.query(
    `UPDATE mail_messages
        SET attachments = (
          SELECT coalesce(jsonb_agg(
                   CASE WHEN e->>'attachmentId' = $3
                        THEN e || jsonb_build_object('documentId', $4::text)
                        ELSE e END
                   ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(attachments) WITH ORDINALITY AS t(e, ord))
      WHERE business_id = $1 AND mail_id = $2`,
    [businessId, mailId, noNul(attachmentId), noNul(documentId)],
  );
}

/** One mail by id, scoped to its business. `null` when this business does not own it. */
export async function getMail(mailId: string, options: Options = {}): Promise<StoredMail | null> {
  const { businessId, db } = ctx(options);
  const { rows } = await db.query<MailDbRow>(
    `SELECT ${COLUMNS} FROM mail_messages WHERE business_id = $1 AND mail_id = $2`,
    [businessId, mailId],
  );
  const row = rows[0];
  return row === undefined ? null : toStoredMail(row);
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
