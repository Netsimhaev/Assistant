/**
 * Invoices the owner SENT to this contact (the mailbox's Sent folder). A
 * deliberate, read-only exception to "listSince skips SENT": the search is
 * keyed by the sender's own address (`ids.email`) and nothing from message
 * text. Each matching PDF is fetched, ingested like any mail attachment and
 * linked to the contact as `assigned_by = 'sent_mail'`.
 *
 * No mailbox, no email on the contact, a refused address, or any provider
 * failure yields no items — this source never throws into the caller.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusinessDb } from '../../db/pool.js';
import { ingestDocument } from '../../documents/ingest.js';
import { listGrants } from '../../governance/oauth-grants.js';
import { MAILBOX_SYSTEM, type MailProvider } from '../../mail/mailbox.js';
import { clientFor as realClientFor } from '../../mail/providers/client-for.js';
import { isFailure, sentQueryProblem, type MailboxClient } from '../../mail/providers/types.js';
import { loadBindings } from '../../orchestrator/bindings.js';
import type { CredentialSource } from '../../orchestrator/credentials.js';
import { MAILBOX_CREDENTIAL_REF } from '../../orchestrator/mail-poll.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import type { SourceItem, Tier2Source } from './types.js';

const LIMIT = 20;
const SINCE_DAYS = 365;
const MAX_ITEMS = 10;
const MAX_TEXT_CHARS = 2000;
const INVOICE_WORDS = /חשבונית|invoice|קבלה|receipt/i;

export interface SentInvoicesDeps {
  credentials: CredentialSource;
  documentRoot: string;
  clientFor?: (provider: MailProvider) => MailboxClient;
}

function isPdf(mediaType: string, filename: string): boolean {
  const base = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return base === 'application/pdf' || (base === 'application/octet-stream' && filename.toLowerCase().endsWith('.pdf'));
}

function blockTexts(content: unknown): string[] {
  const blocks = (content as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks) {
    const text = (b as { text?: unknown } | null)?.text;
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

async function mailboxAccess(
  db: BusinessDb,
  deps: SentInvoicesDeps,
): Promise<{ client: MailboxClient; token: string } | null> {
  const binding = (await loadBindings(db)).find((b) => b.system === MAILBOX_SYSTEM);
  if (binding === undefined || binding.status !== 'live') return null;
  if (binding.provider !== 'google' && binding.provider !== 'microsoft') return null;
  const ref = binding.credentialRef ?? MAILBOX_CREDENTIAL_REF;
  const grant = (await listGrants(db)).find((g) => g.credentialRef === ref);
  if (grant !== undefined && (grant.revokedAt !== null || grant.needsReauthAt !== null)) return null;
  const handle = await deps.credentials.resolve(ref, db.businessId, db);
  if (handle === null) return null;
  return { client: (deps.clientFor ?? realClientFor)(binding.provider), token: handle.value };
}

export function createSentInvoicesSource(deps: SentInvoicesDeps): Tier2Source {
  return async (db, ids, signal) => {
    const none = { items: [] as SourceItem[], ownershipViolation: false };
    if (ids.email === null) return none;
    const query = { to: ids.email, sinceDays: SINCE_DAYS, limit: LIMIT };
    if (sentQueryProblem(query) !== null) return none;
    try {
      const access = await mailboxAccess(db, deps);
      if (access === null) return none;
      const sent = await access.client.searchSent(access.token, query, signal);
      if (isFailure(sent)) return none;
      const items: SourceItem[] = [];
      for (const mail of sent) {
        for (const att of mail.attachments) {
          if (signal.aborted || items.length >= MAX_ITEMS) return { items, ownershipViolation: false };
          if (!isPdf(att.mediaType, att.filename)) continue;
          if (!INVOICE_WORDS.test(att.filename) && !INVOICE_WORDS.test(mail.subject)) continue;
          const bytes = await access.client.fetchAttachment(access.token, mail.providerMessageId, att.attachmentId, signal);
          if (isFailure(bytes)) continue;
          const dir = await mkdtemp(join(tmpdir(), 'sent-inv-'));
          try {
            const path = join(dir, 'attachment');
            await writeFile(path, bytes);
            const doc = await ingestDocument(
              db,
              { path, source: 'mail', originalName: att.filename },
              { documentRoot: deps.documentRoot },
            );
            await db.query(
              `INSERT INTO contact_documents (business_id, document_id, contact_key, kind, assigned_by)
               VALUES ($1, $2, $3, 'invoice', 'sent_mail') ON CONFLICT DO NOTHING`,
              [db.businessId, doc.documentId, ids.key],
            );
            const { rows } = await db.query<{ content: unknown }>(
              `SELECT content FROM document_artifacts
                WHERE business_id = $1 AND document_id = $2 AND kind = 'text' ORDER BY ordinal`,
              [db.businessId, doc.documentId],
            );
            items.push({
              source: 'sent_invoices',
              label: `חשבונית שנשלחה: ${toOneLine(stripBidiControls(att.filename))} — ${toOneLine(stripBidiControls(mail.subject))}`,
              text: rows.flatMap((r) => blockTexts(r.content)).join('\n').slice(0, MAX_TEXT_CHARS),
              documentId: doc.documentId,
              at: mail.sentAt,
            });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      }
      return { items, ownershipViolation: false };
    } catch {
      return none;
    }
  };
}
