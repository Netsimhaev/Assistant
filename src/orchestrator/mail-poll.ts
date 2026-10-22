/**
 * The mailbox poll pass: read what arrived since the cursor, triage each mail
 * in quarantine, label it, ingest its attachments, record invoices, tell the
 * owner about mail from real people, and raise a reply card for questions.
 *
 * **A switch, not a fault.** No active `mailbox` connection in the signed
 * charter, no live binding, or no cursor → `null`, never `{ recorded: 0 }`.
 * "The loop did not run" and "it ran and found nothing" are different facts
 * about an installation (the same line `DOCUMENT_INBOX` draws).
 *
 * **Order within one pass, and why.**
 *
 *   1. The credential. A revoked grant, one marked `needs_reauth`, or a
 *      refresh the provider rejected is `{ status: 'needs_reauth' }` with the
 *      reason on the cursor row — never a throw. `markNeedsReauth` is written
 *      by `oauthCredentials` itself on the rejected-refresh branch; this
 *      module only READS the grant store (`listGrants`), because the write
 *      surface belongs to `oauth-token.ts` and `oauth-routes.ts` alone
 *      (`connector-invariants.test.ts`).
 *   2. `listSince`, then `recordIncoming` for every message, and only then
 *      the new cursor. A failure while recording leaves the cursor where it
 *      was: the next pass lists the same messages again and the
 *      `(business_id, provider_message_id)` dedupe absorbs the ones already
 *      stored. Advancing first would lose the rest of the batch for good.
 *      An expired cursor is re-taken with `initialCursor` and reported as a
 *      `gap` — no backfill (spec §2.2).
 *   3. Triage, oldest first, while the daily ceiling allows. Over the
 *      ceiling a mail is marked `over_cap` and the model is never called.
 *   4. Per mail: label → attachments → invoice → owner notice → reply card →
 *      settle → close the triage job. A failure inside one mail settles THAT
 *      mail as `failed` and the pass moves on.
 *   5. `reraiseAfterFailedSend`, once, after the triage loop: it is
 *      independent of this batch, and running it last means a pass whose
 *      triage budget is spent still re-asks about an approved send that did
 *      not complete.
 *
 * **Labelling bypasses the gate, deliberately** (spec §5.2). It joins the
 * short list of documented bypasses (`conduct.ts`, the curator, erasure):
 * every mail job is `unknown_external`, whose ceiling is `draft_only`, so a
 * classified tool would label nothing. The bypass is safe because the only
 * write is ADD-a-label, the label name comes from the closed set in code
 * (`MAIL_LABELS`, and the provider clients refuse anything else), it stays
 * inside the business's own mailbox and reaches no person, and nothing in its
 * input is a field a mail can steer. Every label is audited — the message id
 * and the label, hashed; never the subject, never an address.
 *
 * **Side effects are recorded as they happen** (`recordMailProgress`), not
 * only at settle: a crash between a label and the settle must not lead the
 * next handling to label or notify a second time. A mail that already names a
 * reply job is not drafted again, and a mail that already has an invoice row
 * gets no second one.
 *
 * **Non-fatal steps.** A label the provider refused, a WhatsApp notice that
 * did not go out, and a reply card that threw are noted on the mail
 * (`noteMailError`) and the mail still settles `triaged` with its categories:
 * the owner can see it on the mail screen, which a `failed` row would hide.
 * The triage call itself, and fetching or ingesting an attachment, are the
 * per-mail failures the poison-pill rule speaks about.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit } from '../audit/log.js';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { ingestDocument } from '../documents/ingest.js';
import { CSV, DOCX, JSON as JSON_TYPE, MARKDOWN, TEXT, XLSX } from '../documents/media-type.js';
import type { PolicyBundle } from '../domain/policy.js';
import { finalCategories, type MailTriage } from '../domain/mail-triage.js';
import { listGrants } from '../governance/oauth-grants.js';
import { isAutomatedSender } from '../mail/automated.js';
import {
  claimMail,
  getCursor,
  hasInvoiceForMail,
  insertInvoice,
  mailAwaitingTriage,
  mailReadsToday,
  markOverCap,
  noteMailError,
  recordIncoming,
  recordMailProgress,
  setCursor,
  settleMail,
  type MailCursor,
  type StoredMail,
} from '../mail/inbox-store.js';
import { MAIL_LABELS, MAILBOX_SYSTEM, type MailCategory, type MailProvider } from '../mail/mailbox.js';
import { createGmailClient } from '../mail/providers/gmail.js';
import { createGraphClient } from '../mail/providers/graph.js';
import { MailboxCursorError, isFailure, type MailboxClient } from '../mail/providers/types.js';
import { renderMailNotice } from '../mail/whatsapp-notice.js';
import { runMailDrafter, type Drafter } from '../sdk/mail-drafter.js';
import { runMailTriage, type Triage } from '../sdk/mail-triage.js';
import { canonicalHash } from '../util/canonical.js';
import { loadBindings } from './bindings.js';
import { createJob, transition, type Job } from './jobs.js';
import { raiseMailReply, reraiseAfterFailedSend } from './mail-reply.js';
import { OAuthGrantRevokedError, OAuthRefreshRejectedError } from './oauth-token.js';
import type { NotifyTarget } from './proposal-approval.js';
import type { Runtime } from './runtime.js';

export interface MailPollResult {
  status: 'ok' | 'needs_reauth' | 'error';
  /** New messages stored this pass (duplicates not counted). */
  recorded: number;
  /** Triage model calls made this pass. */
  triaged: number;
  /** Mails left unread because the daily ceiling was reached. */
  overCap: number;
  labelled: number;
  /** WhatsApp notices that went out. */
  notified: number;
  /**
   * Mails that warranted a WhatsApp notice when no WhatsApp channel exists.
   * Reported, not silent (spec §2.6): "no notices" must not look the same as
   * "nothing to notify about".
   */
  unnotified: number;
  /** Reply cards raised. */
  drafts: number;
  /** Fresh cards raised for an approved send that did not complete. */
  reraised: number;
  failed: number;
  /** The cursor had expired and was re-taken; mail in between is not read (no backfill). */
  gap?: true;
  error?: string;
}

export interface PollMailboxOptions {
  businessId?: string;
  runtime: Runtime;
  /** Test seam; defaults to the real client for the binding's provider. */
  client?: MailboxClient;
  triage?: Triage;
  drafter?: Drafter;
  readsPerDay?: number;
  documentRoot?: string;
  /** The WhatsApp line to the owner. Absent when no WhatsApp gateway is configured. */
  notifyBoss?: (text: string, jobId: string | null) => Promise<void>;
  /** Approval-card email target — the same one the conductor gets. */
  notify?: NotifyTarget;
  now?: Date;
  /** Most mails considered in one pass. */
  limit?: number;
}

const MAILBOX_CREDENTIAL_REF = 'OAUTH_MAILBOX';
const CALL_TIMEOUT_MS = 30_000;

/** Attachment types the document pipeline accepts. PDF is stored and kept downloadable. */
const INGESTIBLE_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  XLSX,
  DOCX,
  CSV,
  TEXT,
  MARKDOWN,
  JSON_TYPE,
]);

function baseMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(status: MailPollResult['status']): MailPollResult {
  return {
    status,
    recorded: 0,
    triaged: 0,
    overCap: 0,
    labelled: 0,
    notified: 0,
    unnotified: 0,
    drafts: 0,
    reraised: 0,
    failed: 0,
  };
}

function clientFor(provider: MailProvider): MailboxClient {
  return provider === 'google' ? createGmailClient() : createGraphClient();
}

export async function pollMailbox(options: PollMailboxOptions): Promise<MailPollResult | null> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();

  // --- The switch -----------------------------------------------------------
  const active = await loadActiveCharter(businessId);
  if (active === null) return null;
  if (!active.bundle.connections.some((c) => c.system === MAILBOX_SYSTEM)) return null;
  const binding = (await loadBindings({ businessId })).find((b) => b.system === MAILBOX_SYSTEM);
  if (binding === undefined || binding.status !== 'live') return null;
  if (binding.provider !== 'google' && binding.provider !== 'microsoft') return null;
  const cursor = await getCursor({ businessId });
  if (cursor === null) return null;

  const provider: MailProvider = binding.provider;
  const ref = binding.credentialRef ?? MAILBOX_CREDENTIAL_REF;

  const writeCursor = (patch: Partial<MailCursor>): Promise<void> =>
    setCursor(
      { provider: cursor.provider, cursor: cursor.cursor, lastPollAt: now.toISOString(), lastError: null, ...patch },
      { businessId },
    );

  if (cursor.provider !== provider) {
    // A reconnect moves the cursor along with the binding; a mismatch means
    // the two were written apart, and listing one provider's cursor against
    // the other would read nothing sensible.
    await writeCursor({ lastError: 'cursor_provider_mismatch' });
    return { ...emptyResult('error'), error: 'cursor_provider_mismatch' };
  }

  // --- 1. The credential ----------------------------------------------------
  const needsReauth = async (): Promise<MailPollResult> => {
    await writeCursor({ lastError: 'needs_reauth' });
    return emptyResult('needs_reauth');
  };
  const grant = (await listGrants(businessId)).find((g) => g.credentialRef === ref);
  if (grant !== undefined && (grant.revokedAt !== null || grant.needsReauthAt !== null)) {
    return needsReauth();
  }
  let token: string;
  try {
    const handle = await options.runtime.credentials.resolve(ref, businessId);
    if (handle === null) return needsReauth();
    token = handle.value;
  } catch (error) {
    if (error instanceof OAuthGrantRevokedError || error instanceof OAuthRefreshRejectedError) {
      return needsReauth();
    }
    await writeCursor({ lastError: 'credential_error' });
    return { ...emptyResult('error'), error: message(error) };
  }

  const client = options.client ?? clientFor(provider);
  const result = emptyResult('ok');

  // --- 2. List, record, then advance --------------------------------------
  let listed: Awaited<ReturnType<MailboxClient['listSince']>>;
  try {
    listed = await client.listSince(token, cursor.cursor, AbortSignal.timeout(CALL_TIMEOUT_MS));
  } catch (error) {
    await writeCursor({ lastError: 'list_failed' });
    return { ...result, status: 'error', error: message(error) };
  }

  if (isFailure(listed)) {
    if (listed.failure === 'auth') {
      // The cached access token is the likeliest thing wrong; the next pass
      // mints a fresh one, and a refresh the provider rejects marks the grant.
      options.runtime.credentials.invalidate?.(ref, businessId);
      return needsReauth();
    }
    if (listed.failure === 'cursor_expired') {
      let fresh: string;
      try {
        fresh = await client.initialCursor(token, AbortSignal.timeout(CALL_TIMEOUT_MS));
      } catch (error) {
        const detail = error instanceof MailboxCursorError ? error.failure.message : message(error);
        await writeCursor({ lastError: 'cursor_expired_unrecovered' });
        return { ...result, status: 'error', error: detail };
      }
      await writeCursor({ cursor: fresh, lastError: 'cursor_expired_gap' });
      result.gap = true;
    } else {
      // transient or rejected: the cursor stays where it was.
      await writeCursor({ lastError: `list_${listed.failure}` });
      return { ...result, status: 'error', error: listed.message };
    }
  } else {
    try {
      for (const incoming of listed.messages) {
        const stored = await recordIncoming(incoming, { businessId });
        if (stored !== null) result.recorded += 1;
      }
    } catch (error) {
      await writeCursor({ lastError: 'record_failed' });
      return { ...result, status: 'error', error: message(error) };
    }
    await writeCursor({ cursor: listed.nextCursor });
  }

  // --- 3–4. Triage ----------------------------------------------------------
  const pass: PassContext = {
    businessId,
    bundle: active.bundle,
    charterVersion: active.charter.charterVersion,
    client,
    token,
    triage: options.triage ?? runMailTriage,
    drafter: options.drafter ?? runMailDrafter,
    documentRoot: options.documentRoot ?? config.documentRoot,
    notifyBoss: options.notifyBoss,
    notify: options.notify,
    labelIds: null,
    result,
  };

  const readsPerDay = options.readsPerDay ?? config.mailReadsPerDay;
  let remaining = readsPerDay - (await mailReadsToday({ businessId }));
  const waiting = await mailAwaitingTriage(options.limit ?? 100, { businessId });
  for (const mail of waiting) {
    if (remaining <= 0) {
      await markOverCap(mail.mailId, { businessId });
      result.overCap += 1;
      continue;
    }
    if (!(await claimMail(mail.mailId, { businessId }))) continue;
    remaining -= 1;
    await handleMail(mail, pass);
  }

  // --- 5. Re-ask about approved sends that did not complete ---------------
  try {
    const reraised = await reraiseAfterFailedSend(
      { bundle: active.bundle },
      { businessId, ...(options.notify !== undefined ? { notify: options.notify } : {}) },
    );
    result.reraised = reraised.reraised;
  } catch (error) {
    result.error = `reraise: ${message(error)}`;
  }

  return result;
}

interface PassContext {
  businessId: string;
  bundle: PolicyBundle;
  charterVersion: string;
  client: MailboxClient;
  token: string;
  triage: Triage;
  drafter: Drafter;
  documentRoot: string;
  notifyBoss: PollMailboxOptions['notifyBoss'];
  notify: NotifyTarget | undefined;
  /** Resolved lazily, once per pass; `'failed'` when the provider refused. */
  labelIds: Record<string, string> | 'failed' | null;
  result: MailPollResult;
}

async function handleMail(mail: StoredMail, pass: PassContext): Promise<void> {
  const { businessId, result } = pass;
  let job: Job | null = null;
  try {
    job = await createJob({
      charterVersion: pass.charterVersion,
      // Not a parameter, and not derived from anything a mail says.
      provenance: 'unknown_external',
      businessId,
      title: `מייל: ${mail.subject}`,
    });
    await transition(job.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: 'mail poll: triaging an incoming mail',
      businessId,
    });

    // Counted before the call: a call that throws was still made and billed.
    result.triaged += 1;
    const outcome = await pass.triage({ bundle: pass.bundle, mail });
    if (outcome.status !== 'read') throw new Error(`triage_unreadable: ${outcome.reason}`);
    const triage: MailTriage = outcome.triage;

    const { categories, isPerson } = finalCategories(
      triage,
      isAutomatedSender(mail.headerFlags, mail.fromAddress),
    );

    const labelsApplied = await applyLabels(mail, categories, job.jobId, pass);
    const documents = await ingestAttachments(mail, pass);

    if (categories.includes('invoice') && !(await hasInvoiceForMail(mail.mailId, { businessId }))) {
      const linked = documents.find((d) => d.mediaType === 'application/pdf') ?? documents[0] ?? null;
      await insertInvoice(
        {
          mailId: mail.mailId,
          supplierAddress: mail.fromAddress,
          supplierName: mail.fromName,
          invoiceNumber: triage.invoice?.number ?? null,
          amountText: triage.invoice?.amountText ?? null,
          documentId: linked?.documentId ?? null,
          fileName: linked?.fileName ?? null,
          receivedAt: mail.receivedAt,
        },
        { businessId },
      );
    }

    const notifiedAt = await notifyOwner(mail, triage, categories, isPerson, job.jobId, pass);

    let replyJobId: string | undefined;
    if (categories.includes('question') && mail.replyJobId === null) {
      try {
        const raised = await raiseMailReply(
          { mail, triage, bundle: pass.bundle, drafter: pass.drafter },
          { businessId, ...(pass.notify !== undefined ? { notify: pass.notify } : {}) },
        );
        if (raised !== null) {
          // Only a job raised in THIS handling: `settleMail` COALESCEs, and a
          // stale id would re-link a failed job and reopen it for re-raise.
          replyJobId = raised.replyJobId;
          result.drafts += 1;
        }
      } catch {
        await noteMailError(mail.mailId, 'reply_failed', { businessId });
      }
    }

    await settleMail(
      mail.mailId,
      {
        state: 'triaged',
        categories,
        summary: triage.summary,
        isPerson,
        jobId: job.jobId,
        labelsApplied,
        ...(notifiedAt !== null ? { notifiedAt } : {}),
        ...(replyJobId !== undefined ? { replyJobId } : {}),
      },
      { businessId },
    );

    // The same path `conduct.ts` takes for a job that raises no card: the
    // triage job's work is done here; a reply, if any, lives on its own job.
    for (const to of ['plan', 'closed'] as const) {
      await transition(job.jobId, {
        to,
        actor: 'orchestrator',
        reason: 'mail poll: triaged',
        businessId,
      });
    }
  } catch (error) {
    result.failed += 1;
    const reason = message(error).slice(0, 500);
    try {
      await settleMail(
        mail.mailId,
        { state: 'failed', error: reason, ...(job !== null ? { jobId: job.jobId } : {}) },
        { businessId },
      );
    } catch {
      // Best effort: the database is having the same bad moment. The row
      // stays `claimed`, which nothing re-reads — a known gap, not a loop.
    }
    if (job !== null) {
      try {
        await transition(job.jobId, {
          to: 'failed',
          actor: 'orchestrator',
          reason: `mail poll: ${reason}`,
          businessId,
        });
      } catch {
        // The job may already have moved; nothing more to do here.
      }
    }
  }
}

/** Add the closed-set labels this mail earns, skipping any already applied. Returns the full applied list. */
async function applyLabels(
  mail: StoredMail,
  categories: readonly MailCategory[],
  jobId: string,
  pass: PassContext,
): Promise<string[]> {
  const { businessId } = pass;
  const applied = [...mail.labelsApplied];
  const wanted = (['invoice', 'question'] as const)
    .filter((c) => categories.includes(c))
    .map((c) => MAIL_LABELS[c])
    .filter((label) => !applied.includes(label));
  if (wanted.length === 0) return applied;

  if (pass.labelIds === null) {
    const ensured = await pass.client.ensureLabels(
      pass.token,
      Object.values(MAIL_LABELS),
      AbortSignal.timeout(CALL_TIMEOUT_MS),
    );
    pass.labelIds = isFailure(ensured) ? 'failed' : ensured;
  }
  const ids = pass.labelIds;
  if (ids === 'failed') {
    await noteMailError(mail.mailId, 'label_failed', { businessId });
    return applied;
  }

  for (const label of wanted) {
    const labelId = ids[label];
    const added =
      labelId === undefined
        ? null
        : await pass.client.addLabel(pass.token, mail.providerMessageId, label, labelId, AbortSignal.timeout(CALL_TIMEOUT_MS));
    if (added !== true) {
      await noteMailError(mail.mailId, 'label_failed', { businessId });
      continue;
    }
    applied.push(label);
    await recordMailProgress(mail.mailId, { labelsApplied: applied }, { businessId });
    pass.result.labelled += 1;
    // Numbers and hashes only: never the subject, never an address.
    await appendAudit(
      {
        jobId,
        actor: 'intake.triage',
        kind: 'tool_call',
        reason: `mail_label:${label}`,
        inputHash: canonicalHash({ providerMessageId: mail.providerMessageId, label }),
        provenance: 'unknown_external',
        charterVersion: pass.charterVersion,
        envelopeId: null,
        onBehalfOf: null,
        actionClass: null,
        risk: null,
        outputHash: null,
        artifacts: [],
        costMinor: null,
        tokens: null,
      },
      { businessId },
    );
  }
  return applied;
}

interface IngestedAttachment {
  documentId: string;
  fileName: string;
  mediaType: string;
}

/**
 * Fetch and ingest every attachment of a type the document pipeline accepts.
 *
 * The temp file is named by us, never by the sender: the filename travels
 * only as `originalName`, which `ingestDocument` stores verbatim and never
 * treats as a path (§5.5). A fetch the provider refused is a failure of this
 * mail. Types the pipeline does not take are left in the mailbox, unfetched.
 */
async function ingestAttachments(mail: StoredMail, pass: PassContext): Promise<IngestedAttachment[]> {
  const out: IngestedAttachment[] = [];
  for (const attachment of mail.attachments) {
    const mediaType = baseMediaType(attachment.mediaType);
    if (!INGESTIBLE_TYPES.has(mediaType)) continue;
    const bytes = await pass.client.fetchAttachment(
      pass.token,
      mail.providerMessageId,
      attachment.attachmentId,
      AbortSignal.timeout(CALL_TIMEOUT_MS),
    );
    if (isFailure(bytes)) throw new Error(`attachment_fetch_failed: ${bytes.message}`);
    const dir = await mkdtemp(join(tmpdir(), 'mail-att-'));
    try {
      const path = join(dir, 'attachment');
      await writeFile(path, bytes);
      const document = await ingestDocument(
        { path, source: 'mail', originalName: attachment.filename },
        { businessId: pass.businessId, documentRoot: pass.documentRoot },
      );
      out.push({ documentId: document.documentId, fileName: attachment.filename, mediaType });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * Tell the owner on WhatsApp about mail from a real person that is an invoice
 * or a question — and nothing else (spec §2.6). Returns the ISO time it went
 * out, or `null`. Never load-bearing: a failed send is noted on the mail.
 */
async function notifyOwner(
  mail: StoredMail,
  triage: MailTriage,
  categories: readonly MailCategory[],
  isPerson: boolean,
  jobId: string,
  pass: PassContext,
): Promise<string | null> {
  const { businessId } = pass;
  if (!isPerson) return null;
  if (!categories.includes('invoice') && !categories.includes('question')) return null;
  // No sender to name — and `raiseMailReply` refuses the card for the same reason.
  if (mail.fromAddress.trim() === '') return null;
  if (mail.notifiedAt !== null) return null;
  if (pass.notifyBoss === undefined) {
    pass.result.unnotified += 1;
    return null;
  }
  try {
    await pass.notifyBoss(
      renderMailNotice({ fromName: mail.fromName, fromAddress: mail.fromAddress, summary: triage.summary }, categories),
      jobId,
    );
  } catch {
    await noteMailError(mail.mailId, 'notify_failed', { businessId });
    return null;
  }
  const at = new Date().toISOString();
  await recordMailProgress(mail.mailId, { notifiedAt: at }, { businessId });
  pass.result.notified += 1;
  return at;
}
