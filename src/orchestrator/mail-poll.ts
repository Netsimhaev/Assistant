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
 * **Non-fatal steps.** A label the provider refused, an attachment that
 * could not be fetched or ingested (or was too large), a WhatsApp notice that
 * did not go out, a reply card that threw, and a triage job that would not
 * close after the mail settled are noted on the mail (`noteMailError`) and
 * the mail still settles `triaged` with its categories: the owner can see it
 * on the mail screen, which a `failed` row would hide. The triage call itself
 * is the per-mail failure the poison-pill rule speaks about.
 *
 * **Crash recovery.** A row a crashed poller left `claimed` goes back to
 * `received` after 30 minutes (`staleClaimsToReceived`), and the triage job
 * that handling opened is failed before a new one opens. A message that will
 * not record at all becomes a content-free placeholder on its third failing
 * pass, so the cursor can move (`recordBatch`).
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
  recordUnrecordable,
  recordMailProgress,
  setCursor,
  staleClaimsToReceived,
  settleMail,
  type IncomingMail,
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
import { createJob, loadJob, transition, type Job } from './jobs.js';
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
  /** Most mails triaged in one pass (default 20): a pass is bounded in time as well as in money. */
  limit?: number;
}

const MAILBOX_CREDENTIAL_REF = 'OAUTH_MAILBOX';
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_TRIAGE_LIMIT = 20;
/** A claim older than this is a crashed poller's, not a slow one's: a pass triages at most 20 mails. */
const STALE_CLAIM_MINUTES = 30;
/** The document pipeline's own ceiling (`ingest.ts`). Checked on the declared size, before downloading. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MAIL = 10;

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

  // A poller that crashed after `claimMail` left its rows `claimed`, which
  // nothing re-reads. Returned to `received` here, at the top of every pass
  // of a connected mailbox; the orphaned triage job is failed when the mail
  // is handled again (`handleMail`).
  await staleClaimsToReceived(STALE_CLAIM_MINUTES, { businessId });

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
      // `last_error` is overwritten by the next clean pass; the audit row is
      // the durable record that mail between the two cursors was never read.
      // Codes only — no cursor value, no address.
      await appendAudit(
        {
          jobId: null,
          actor: 'orchestrator',
          kind: 'incident',
          reason: 'mail_cursor_gap',
          inputHash: canonicalHash({ event: 'mail_cursor_gap', provider, status: listed.status }),
          provenance: 'unknown_external',
          charterVersion: active.charter.charterVersion,
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
    } else {
      // transient or rejected: the cursor stays where it was.
      await writeCursor({ lastError: `list_${listed.failure}` });
      return { ...result, status: 'error', error: listed.message };
    }
  } else {
    const failure = await recordBatch(listed.messages, cursor, result, businessId);
    if (failure === null) {
      await writeCursor({ cursor: listed.nextCursor });
    } else {
      // The cursor stays; what WAS stored is still triaged below, and the
      // re-raise still runs. Only the advance waits for the whole batch.
      await writeCursor({ lastError: failure.lastError });
      result.status = 'error';
      result.error = failure.error;
    }
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
  const waiting = await mailAwaitingTriage(options.limit ?? DEFAULT_TRIAGE_LIMIT, { businessId });
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

/** How many consecutive passes one message may fail to record before it becomes a placeholder. */
export const UNRECORDABLE_AFTER_PASSES = 3;

/**
 * Record every listed message; return `null` when all of them are stored (or
 * already were), else what to write on the cursor row.
 *
 * Each message is recorded on its own, so one that throws does not stop the
 * rest of the batch from being stored. The cursor still waits for ALL of
 * them: advancing past a message we failed to store would lose it for good.
 *
 * **The per-message skip.** A message that fails on every pass would hold
 * the cursor still forever. The count of consecutive failures lives on the
 * cursor row's own `last_error` (`record_failed:<id hash>:<n>`), durable
 * across restarts and needing no new column. On the `UNRECORDABLE_AFTER_PASSES`
 * pass a content-free placeholder row is written instead (state `failed`,
 * error `unrecordable`) and the batch counts as recorded. Only the first
 * failing message in a batch is tracked; a second one starts its count once
 * the first is past. A message whose provider id itself cannot be read has
 * nothing to key on and is never skipped — the cursor stays, loudly.
 */
async function recordBatch(
  messages: readonly IncomingMail[],
  cursor: MailCursor,
  result: MailPollResult,
  businessId: string,
): Promise<{ lastError: string; error: string } | null> {
  let failure: { lastError: string; error: string } | null = null;
  for (const incoming of messages) {
    try {
      const stored = await recordIncoming(incoming, { businessId });
      if (stored !== null) result.recorded += 1;
      continue;
    } catch (error) {
      if (failure !== null) continue;
      let key: string;
      try {
        key = canonicalHash({ providerMessageId: incoming.providerMessageId }).slice(0, 12);
      } catch {
        failure = { lastError: 'record_failed', error: message(error) };
        continue;
      }
      const previous = /^record_failed:([0-9a-f]{12}):(\d+)$/.exec(cursor.lastError ?? '');
      const count = previous !== null && previous[1] === key ? Number(previous[2]) + 1 : 1;
      if (count >= UNRECORDABLE_AFTER_PASSES) {
        await recordUnrecordable(incoming.providerMessageId, { businessId });
        continue;
      }
      failure = { lastError: `record_failed:${key}:${count}`, error: message(error) };
    }
  }
  return failure;
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
  let settled = false;
  try {
    // A mail handled again after a crash (stale claim, or a reset) may still
    // name the triage job the crashed handling opened. Left alone, that job
    // sits in `intake`/`understand`/`plan` forever — phases nothing reads.
    if (mail.jobId !== null) await failOrphanedJob(mail.jobId, businessId);

    job = await createJob({
      charterVersion: pass.charterVersion,
      // Not a parameter, and not derived from anything a mail says.
      provenance: 'unknown_external',
      businessId,
      title: `מייל: ${mail.subject}`,
    });
    // Written at once, so a crash from here on leaves the job findable.
    await recordMailProgress(mail.mailId, { jobId: job.jobId }, { businessId });
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
    settled = true;

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
    if (settled) {
      // The mail's own work is done and recorded; only closing its triage
      // job failed. Re-settling as `failed` would hide a classified mail
      // from the owner over bookkeeping. Noted, and the job is left to
      // `failOrphanedJob` should the mail ever be handled again.
      try {
        await noteMailError(mail.mailId, 'job_close_failed', { businessId });
      } catch {
        // Best effort.
      }
      return;
    }
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

/** Terminal phases: a job there needs nothing more from us. */
const TERMINAL_PHASES: readonly string[] = ['closed', 'failed', 'halted'];

/**
 * Move a crashed handling's triage job to `failed` — legal from every phase
 * this module leaves a triage job in (`intake`, `understand`, `plan`).
 * Best effort: a job that moved on its own is not this mail's problem.
 */
async function failOrphanedJob(jobId: string, businessId: string): Promise<void> {
  try {
    const orphan = await loadJob(jobId, { businessId });
    if (orphan === null || TERMINAL_PHASES.includes(orphan.phase)) return;
    await transition(jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: 'mail poll: handling was interrupted; the mail is being handled again',
      businessId,
    });
  } catch {
    // Nothing more to do here.
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
 * Fetch and ingest the attachments the document pipeline accepts — a
 * declared ingestible type, or `application/octet-stream` named `.pdf`
 * (providers often label a PDF that way; the sniff in `ingestDocument`
 * decides what it really is, never the name).
 *
 * The temp file is named by us, never by the sender: the filename travels
 * only as `originalName`, which `ingestDocument` stores verbatim and never
 * treats as a path (§5.5).
 *
 * **Never fatal to the mail.** An attachment over 25 MB (declared size) is
 * skipped before it is downloaded (`attachment_too_large`); at most 10 are
 * taken per mail; a fetch the provider refused or an ingest that threw is
 * noted (`attachment_failed`) and the rest continue. Losing one PDF must not
 * also lose the owner's notice, the invoice row and the reply card. The
 * attachment stays in the mailbox either way.
 */
async function ingestAttachments(mail: StoredMail, pass: PassContext): Promise<IngestedAttachment[]> {
  const { businessId } = pass;
  const out: IngestedAttachment[] = [];
  let taken = 0;
  for (const attachment of mail.attachments) {
    const mediaType = baseMediaType(attachment.mediaType);
    const pdfByName = mediaType === 'application/octet-stream' && attachment.filename.toLowerCase().endsWith('.pdf');
    if (!INGESTIBLE_TYPES.has(mediaType) && !pdfByName) continue;
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      await noteMailError(mail.mailId, 'attachment_too_large', { businessId });
      continue;
    }
    if (taken >= MAX_ATTACHMENTS_PER_MAIL) break;
    taken += 1;
    try {
      const bytes = await pass.client.fetchAttachment(
        pass.token,
        mail.providerMessageId,
        attachment.attachmentId,
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      if (isFailure(bytes)) throw new Error(bytes.message);
      const dir = await mkdtemp(join(tmpdir(), 'mail-att-'));
      try {
        const path = join(dir, 'attachment');
        await writeFile(path, bytes);
        const document = await ingestDocument(
          { path, source: 'mail', originalName: attachment.filename },
          { businessId, documentRoot: pass.documentRoot },
        );
        out.push({ documentId: document.documentId, fileName: attachment.filename, mediaType: document.mediaType });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      await noteMailError(mail.mailId, 'attachment_failed', { businessId });
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
