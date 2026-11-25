/**
 * The contact card: a reply drafted to a client or supplier on the business's
 * WhatsApp number, raised to the owner as an approval card, presented on his
 * WhatsApp and answered there ("שלח" / "נוסח: …").
 *
 * Mirrors the mailbox reply card (`orchestrator/mail-reply.ts` raise,
 * `orchestrator/whatsapp-mail-card.ts` present/open/answer) — every condition
 * positive, typed text only, one open thing in total or nothing is decided.
 *
 * **The conversation stays `carded` from `setCard` until the send completes.**
 * `approvedReplyCovers` exempts a `whatsapp.reply` only while the payload's
 * `conversationId` names a conversation whose `card_job_id` is this job and
 * whose state is `carded`. Nothing here moves a carded conversation to another
 * state: a replacement body re-stages an edit on the SAME job (a fresh
 * approval, same `card_job_id`), and a new draft raises a new card on a new
 * job whose `setCard` is the only thing that changes `card_job_id`.
 *
 * **The attachment is shown by what it is, never only by id** (ruling R10a):
 * its stored original name (bidi stripped, one line), its source and its
 * received date, loaded business-scoped; a file that came in from outside is
 * flagged. A document that cannot be loaded refuses the card — nothing is
 * raised for an attachment nobody can identify.
 */
import { transaction, type BusinessDb } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import { Plan } from '../domain/plan.js';
import {
  ApprovalNotDecidableError,
  cancelPendingApproval,
  decide,
  enqueueApproval,
  getApproval,
  stagePendingEdit,
  type ApprovalRequest,
} from '../governance/approvals.js';
import { isClosureCommand } from '../governance/closure-command.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import { PhaseMovedError, createJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { notifyOwner, type NotifyTarget } from '../orchestrator/proposal-approval.js';
import { resumeAfterDecision } from '../orchestrator/resume.js';
import { SEVERAL_OPEN_REFUSAL } from '../orchestrator/whatsapp-document-card.js';
import {
  DECIDED_RESUME_FAILED,
  EMPTY_REPLACEMENT,
  REPLACEMENT_LEAD,
  isApproveWord,
  replacementBody,
} from '../orchestrator/whatsapp-mail-card.js';
import { buildFacts } from '../policy/facts.js';
import { assessRisk } from '../policy/risk.js';
import { capFor, loadRuntimeSettings } from '../tenancy/runtime-settings.js';
import { stripBidiControls, toOneLine } from '../util/bidi.js';
import type { NormalizedInboundMessage } from './gateway.js';
import { canonicalHash } from '../util/canonical.js';
import { writeClearance } from './auto-clearance.js';
import { saveCardContext, type CardContext } from './card-context.js';
import type { BossMessenger } from './messenger.js';
import { claimMessage, settleMessage } from './store.js';
import { contactReplyEditAllowed } from './contact-reply-edit.js';
import {
  conversationByCardJob,
  loadConversation,
  recentMessages,
  setCard,
  type ContactConversation,
  type ContactKind,
} from './contact-conversations.js';

export const CONTACT_CARD_INSTRUCTION = 'לאשר: "שלח". לתקן: "נוסח: <הטקסט>".';
export const CONTACT_CARD_TTL_MINUTES = 4320;
export const CONTACT_CARD_EDIT_REFUSAL = 'בכרטיס הזה אפשר לשנות רק את נוסח ההודעה.';
export const CONTACT_CARD_GONE = 'הטיוטה הזו כבר הוכרעה או שפג תוקפה — לא שיניתי דבר.';
export const EXTERNAL_FILE_WARNING = '⚠️ הקובץ התקבל מגורם חיצוני';
export const REPLACED_JOB_REASON = 'replaced by newer draft';
/** "שלח" on a card raised without a draft (cap, failure): there is nothing to send yet. */
export const CONTACT_CARD_NO_DRAFT = 'בכרטיס הזה אין עדיין טיוטה לשליחה — כתבי "נוסח: <הטקסט>".';
/** `job_steps.reason` of an auto job's `plan -> execute`: no approval was raised. */
export const CONTACT_AUTO_REASON = 'contact reply: auto, no card';
/** Shown in place of the proposed reply when the card carries no draft. */
export const CONTACT_CARD_NO_DRAFT_SHOWN = '(לא נוסחה הצעה)';

const KIND_HE: Record<ContactKind, string> = { client: 'לקוח', supplier: 'ספק', unknown: 'לא מוכר' };
const SOURCE_HE: Record<string, string> = {
  manual: 'העלאה ידנית',
  instruction: 'צורף על ידך להוראה',
  mail: 'מייל נכנס',
  api: 'ממשק',
};
/** Sources the owner put in himself; any other source is a stranger's file. */
const OWN_SOURCES: ReadonlySet<string> = new Set(['manual', 'instruction']);
const ASKED_MAX_CHARS = 300;

// --- The attachment, by what it is -------------------------------------------

export interface AttachmentInfo {
  name: string;
  source: string;
  receivedAt: Date;
}

/** Business-scoped; `null` when the document is missing or not a readable one. */
export async function loadAttachmentInfo(db: BusinessDb, documentId: string): Promise<AttachmentInfo | null> {
  const { rows } = await db.query<{ original_name: string; source: string; created_at: Date }>(
    `SELECT original_name, source, created_at FROM documents
      WHERE business_id = $1 AND document_id = $2 AND status IN ('extracted', 'stored')`,
    [db.businessId, documentId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { name: toOneLine(row.original_name), source: row.source, receivedAt: row.created_at };
}

export function attachmentLines(info: AttachmentInfo): string[] {
  const received = Number.isNaN(info.receivedAt.getTime()) ? '' : info.receivedAt.toISOString().slice(0, 10);
  const lines = [
    `קובץ מצורף: ${info.name === '' ? '(ללא שם)' : info.name} — מקור: ${SOURCE_HE[info.source] ?? toOneLine(info.source)}${received === '' ? '' : `, התקבל ${received}`}`,
  ];
  if (!OWN_SOURCES.has(info.source)) lines.push(EXTERNAL_FILE_WARNING);
  return lines;
}

// --- Raising ------------------------------------------------------------------

export interface RaiseContactCardInput {
  conversation: ContactConversation;
  draft: { body: string; attachDocumentId: string | null };
  reasonHe: string;
  sourcesHe: string[];
  bundle: PolicyBundle;
  contactLabel: string;
  /**
   * `card` (default): an approval card, as phase 1. `auto`: the caller (the
   * contact flow) ran the six exit checks on THIS draft and they passed - no
   * approval, a clearance for the exact bound bytes, straight to `execute`.
   * The gate (`contactReplyCovers`) re-checks everything at send time.
   */
  mode?: 'card' | 'auto';
  /** What the classifier and the sources said; `auto` is derived from `mode`. Default: unclassified. */
  context?: Omit<CardContext, 'jobId' | 'auto'>;
}

const EMPTY_CONTEXT: Omit<CardContext, 'jobId' | 'auto'> = {
  kind: 'unclassified',
  topicId: null,
  summary: '',
  sourceNames: [],
  internalDocumentIds: [],
};

/** The reply payload a card job binds — `wa.send_message`'s input, verbatim. */
function buildPayload(input: RaiseContactCardInput): Record<string, unknown> {
  return {
    to: `+${input.conversation.contactKey}`,
    body: stripBidiControls(input.draft.body),
    conversationId: input.conversation.conversationId,
    ...(input.draft.attachDocumentId !== null ? { attachDocumentId: input.draft.attachDocumentId } : {}),
  };
}

async function lastInboundText(db: BusinessDb, key: string): Promise<string> {
  const messages = await recentMessages(db, key, 10);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.direction === 'inbound') return toOneLine(m.body).slice(0, ASKED_MAX_CHARS);
  }
  return '';
}

/**
 * Thrown when a new draft cannot replace the conversation's current card
 * because that card's send is already decided or under way (an unspent
 * approved approval, or a job past `await_approval`). Re-pointing
 * `card_job_id` then would make `approvedReplyCovers` refuse the approved send,
 * and cancelling would destroy it. Nothing is created or changed; the caller
 * may retry once the send completes.
 */
export class ContactCardBusyError extends Error {
  constructor(conversationId: string) {
    super(`contact card: conversation ${conversationId} has a card that is approved or being sent`);
    this.name = 'ContactCardBusyError';
  }
}

interface PreviousCard {
  jobId: string;
  /** The pending approval to cancel when the new card takes over, or null (job already failed/closed). */
  pendingApprovalId: string | null;
}

/**
 * Read-only: what the conversation's current card is, and whether it may be
 * replaced. Throws `ContactCardBusyError` when it may not.
 */
async function inspectPreviousCard(db: BusinessDb, conversationId: string): Promise<PreviousCard | null> {
  const conv = await loadConversation(db, conversationId);
  if (conv === null || conv.cardJobId === null) return null;
  const { rows: jobs } = await db.query<{ phase: string }>(
    'SELECT phase FROM jobs WHERE business_id = $1 AND job_id = $2',
    [db.businessId, conv.cardJobId],
  );
  const phase = jobs[0]?.phase;
  if (phase === undefined || phase === 'failed' || phase === 'closed') return { jobId: conv.cardJobId, pendingApprovalId: null };
  if (phase !== 'await_approval') throw new ContactCardBusyError(conversationId);
  const { rows } = await db.query<{ approval_id: string; state: string; consumed_at: Date | null; expires_at: Date }>(
    `SELECT approval_id, state, consumed_at, expires_at FROM approval_requests
      WHERE business_id = $1 AND job_id = $2 AND proposed_tool = 'wa.send_message'`,
    [db.businessId, conv.cardJobId],
  );
  let pending: string | null = null;
  for (const r of rows) {
    if ((r.state === 'approved' || r.state === 'approved_with_edit') && r.consumed_at === null && r.expires_at.getTime() > Date.now()) {
      throw new ContactCardBusyError(conversationId);
    }
    if (r.state === 'pending') pending = r.approval_id;
  }
  return { jobId: conv.cardJobId, pendingApprovalId: pending };
}

/**
 * Read-only: whether a new card for this conversation would be refused right
 * now (`ContactCardBusyError`) — the previous card is approved but unsent, or
 * its job is past `await_approval`. The door asks BEFORE spending model calls
 * on a draft nobody could raise (ruling R11a); `raiseContactCard` still
 * decides for itself, since the answer can change between the two.
 */
export async function cardTakeoverBlocked(db: BusinessDb, conversationId: string): Promise<boolean> {
  try {
    await inspectPreviousCard(db, conversationId);
    return false;
  } catch (error) {
    if (error instanceof ContactCardBusyError) return true;
    throw error;
  }
}

/**
 * One transaction: cancel the old pending card and re-point the conversation
 * together, or neither. A lost race (the old card was decided since the
 * inspection) or a closed conversation rolls back.
 */
async function takeOverConversation(
  db: BusinessDb,
  conversationId: string,
  jobId: string,
  previous: PreviousCard | null,
): Promise<void> {
  await transaction(db, async (tx) => {
    if (previous !== null && previous.pendingApprovalId !== null) {
      if (!(await cancelPendingApproval(tx, previous.pendingApprovalId))) {
        throw new ContactCardBusyError(conversationId);
      }
    }
    // Compare-and-swap on the card pointer this raise inspected (R11b): a
    // concurrent raise that re-pointed the conversation since then wins,
    // and this one withdraws its own card (the caller's catch) - no live
    // approval is left that no conversation points at.
    if (!(await setCard(tx, conversationId, jobId, null, previous?.jobId ?? null))) {
      const current = await loadConversation(tx, conversationId);
      if (current !== null && (current.state === 'open' || current.state === 'carded')) {
        throw new ContactCardBusyError(conversationId);
      }
      throw new Error('contact card: the conversation is no longer open');
    }
  });
}

async function failReplaced(db: BusinessDb, previous: PreviousCard | null): Promise<void> {
  if (previous === null || previous.pendingApprovalId === null) return;
  try {
    await transition(db, previous.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: REPLACED_JOB_REASON,
      expectFrom: 'await_approval',
    });
  } catch (error) {
    // Already moved on; the old approval is cancelled either way.
    if (!(error instanceof PhaseMovedError)) throw error;
  }
}

/**
 * The auto half: the conversation is taken over (it is `carded` on this job,
 * which `contactReplyCovers` requires), the clearance is written for the
 * EXACT input of the bound step - the bytes `executeStep` will hash, under
 * the step id that will run - and the job moves `plan -> execute`. No
 * approval, no owner notice, no holding reply. The clearance comes BEFORE
 * the take-over: a clearance on a job no conversation points at is inert (the
 * gate requires the conversation `carded` on that job), while anything that
 * throws after the take-over leaves the job failed with the conversation on
 * it — which `contact-auto-reraise.ts` re-raises by its card context, and
 * fails first if a crash left it in `plan`.
 */
async function raiseAuto(db: BusinessDb, a: {
  conversation: ContactConversation;
  jobId: string;
  plan: Plan;
  previous: PreviousCard | null;
  topicId: string;
}): Promise<void> {
  const step = a.plan.steps[0];
  if (step === undefined) throw new Error('contact card: auto plan has no step');
  // The clearance is for a reply and nothing else: the bound bytes must read
  // as `whatsapp.reply` (a real conversationId) before anything is cleared.
  const facts = buildFacts(step.toolName, step.input, {
    provenance: 'unknown_external',
    chainDepth: 1,
    counterpartyTags: [],
    provenanceChainDerived: false,
  });
  if (facts.actionClass !== 'whatsapp.reply') {
    throw new Error(`contact card: auto payload classified as ${String(facts.actionClass)}, not whatsapp.reply`);
  }
  await writeClearance(db, {
    jobId: a.jobId,
    stepId: step.id,
    inputHash: canonicalHash(step.input),
    conversationId: a.conversation.conversationId,
    topicId: a.topicId,
  });
  await takeOverConversation(db, a.conversation.conversationId, a.jobId, a.previous);
  await transition(db, a.jobId, { to: 'execute', actor: 'orchestrator', reason: CONTACT_AUTO_REASON, expectFrom: 'plan' });
  await failReplaced(db, a.previous);
}

export async function raiseContactCard(
  db: BusinessDb,
  input: RaiseContactCardInput & { mode?: 'card' },
  options?: { notify?: NotifyTarget },
): Promise<{ jobId: string; approvalId: string }>;
export async function raiseContactCard(
  db: BusinessDb,
  input: RaiseContactCardInput & { mode: 'auto' },
  options?: { notify?: NotifyTarget },
): Promise<{ jobId: string; approvalId: null }>;
export async function raiseContactCard(
  db: BusinessDb,
  input: RaiseContactCardInput,
  options?: { notify?: NotifyTarget },
): Promise<{ jobId: string; approvalId: string | null }>;
export async function raiseContactCard(
  db: BusinessDb,
  input: RaiseContactCardInput,
  options: { notify?: NotifyTarget } = {},
): Promise<{ jobId: string; approvalId: string | null }> {
  const { conversation, bundle } = input;
  const mode = input.mode ?? 'card';
  const context = input.context ?? EMPTY_CONTEXT;
  const payload = buildPayload(input);
  const body = payload['body'] as string;
  // An auto reply is cleared for one topic and carries a body; anything else
  // is refused before anything is created.
  const autoTopicId = context.topicId;
  if (mode === 'auto' && (autoTopicId === null || body.trim() === '')) {
    throw new Error('contact card: an auto reply needs a topic and a body');
  }

  // Before anything is created: an attachment nobody can identify refuses the card.
  let attachment: AttachmentInfo | null = null;
  if (input.draft.attachDocumentId !== null) {
    attachment = await loadAttachmentInfo(db, input.draft.attachDocumentId);
    if (attachment === null) throw new Error('contact card: the attached document cannot be loaded');
  }

  const label = toOneLine(input.contactLabel);
  const number = `+${conversation.contactKey}`;
  const asked = await lastInboundText(db, conversation.contactKey);
  const found = input.sourcesHe.map(toOneLine).filter((s) => s !== '');
  const header = [
    `מי: ${label === '' ? number : `${label} (${number})`} — ${KIND_HE[conversation.contactKind]}`,
    `מה ביקש: ${asked === '' ? '(לא נמצאה הודעה)' : asked}`,
    `מה נמצא: ${found.length > 0 ? found.join('; ') : 'לא נמצא מידע רלוונטי'}`,
    `למה לא אוטומטי: ${toOneLine(input.reasonHe)}`,
    ...(attachment !== null ? attachmentLines(attachment) : []),
  ];

  // Refuses (typed error, nothing created) when the current card is approved
  // or being sent; the old card is withdrawn only once the new one is ready.
  const previous = await inspectPreviousCard(db, conversation.conversationId);

  const plan = Plan.parse({
    goal: `תשובה ל-${label === '' ? number : label} בוואטסאפ`,
    steps: [
      {
        id: 'reply',
        agent: 'comms.whatsapp',
        intent: 'reply_to_sender',
        toolName: 'wa.send_message',
        input: payload,
        expectedActionClass: 'whatsapp.reply',
      },
    ],
  });
  const job = await createJob(db, {
    charterVersion: bundle.charterVersion,
    // Not a parameter: everything here derives from a contact's message.
    provenance: 'unknown_external',
    title: `תשובה בוואטסאפ: ${label === '' ? number : label}`,
  });

  let approvalId: string | null = null;
  try {
    for (const to of ['understand', 'plan'] as const) {
      await transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'contact card: drafting a reply' });
    }
    const bound = await bindPlanToJob(db, job.jobId, plan);
    if (bound.status === 'conflict') throw new Error(`contact card: plan conflict on fresh job ${job.jobId}`);
    await saveCardContext(db, { ...context, jobId: job.jobId, auto: mode === 'auto' });
    if (mode === 'auto' && autoTopicId !== null) {
      await raiseAuto(db, { conversation, jobId: job.jobId, plan, previous, topicId: autoTopicId });
      return { jobId: job.jobId, approvalId: null };
    }

    const facts = buildFacts('wa.send_message', payload, {
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    if (facts.actionClass !== 'whatsapp.reply') {
      throw new Error(`contact card: payload classified as ${String(facts.actionClass)}, not whatsapp.reply`);
    }
    const risk = await assessRisk(facts, bundle);
    approvalId = await enqueueApproval(db, {
      jobId: job.jobId,
      facts,
      risk,
      proposedInput: payload,
      summary: `תשובה ל-${label === '' ? number : label} בוואטסאפ`,
      detail: `${header.join('\n')}\n\n${body}`,
      ttlMinutes: CONTACT_CARD_TTL_MINUTES,
    });
    if (options.notify !== undefined) {
      await notifyOwner(db, approvalId, options.notify, {
        jobId: job.jobId,
        facts,
        charterVersion: bundle.charterVersion,
      });
    }
    await transition(db, job.jobId, {
      to: 'await_approval',
      actor: 'orchestrator',
      reason: `contact card: ${approvalId}`,
    });
    await takeOverConversation(db, conversation.conversationId, job.jobId, previous);
    await failReplaced(db, previous);
    return { jobId: job.jobId, approvalId };
  } catch (error) {
    if (approvalId !== null) {
      try {
        await cancelPendingApproval(db, approvalId);
      } catch {
        // Best effort; `expireOverdue` retires it on schedule regardless.
      }
    }
    try {
      await transition(db, job.jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: `contact card: ${error instanceof Error ? error.message : String(error)}`,
      });
    } catch {
      // The job may already have moved; the original error is the one to surface.
    }
    throw error;
  }
}

// --- Presenting ---------------------------------------------------------------

function splitDetail(detail: string): { header: string; body: string } {
  const at = detail.indexOf('\n\n');
  return at === -1 ? { header: detail, body: '' } : { header: detail.slice(0, at), body: detail.slice(at + 2) };
}

function bodyOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const b = (payload as Record<string, unknown>)['body'];
  return typeof b === 'string' ? b : '';
}

/**
 * Send the card to the owner. `send` returns whether the WhatsApp send
 * succeeded; `card_presented_at` is recorded only after it did. Returns `false`
 * when nothing was sent or the send failed. The outbound row the messenger
 * writes (linked to the card job, ending with `CONTACT_CARD_INSTRUCTION`) IS
 * the presentation `openContactCards` looks for.
 */
export async function presentContactCard(
  db: BusinessDb,
  approvalId: string,
  send: (text: string, jobId: string | null) => Promise<boolean>,
  options: { lead?: string } = {},
): Promise<boolean> {
  const approval = await getApproval(db, approvalId);
  if (approval === null || approval.jobId === null || approval.state !== 'pending') return false;
  if (approval.proposedTool !== 'wa.send_message') return false;
  const conversation = await conversationByCardJob(db, approval.jobId);
  if (conversation === null) return false;

  const { header } = splitDetail(approval.detail);
  const reply = bodyOf(approval.editedInput ?? approval.proposedInput);
  const shown = reply.trim() === '' ? CONTACT_CARD_NO_DRAFT_SHOWN : reply;
  const card = `${header}\n\nהתשובה המוצעת:\n${shown}\n\n${CONTACT_CARD_INSTRUCTION}`;
  const ok = await send(options.lead !== undefined ? `${options.lead}\n\n${card}` : card, approval.jobId);
  if (!ok) return false;
  // Same job on both sides: only the presentation time changes, and only while
  // this card is still the conversation's.
  return setCard(db, conversation.conversationId, approval.jobId, new Date(), approval.jobId);
}

// --- What is open -------------------------------------------------------------

export interface OpenContactCard {
  approval: ApprovalRequest;
  presentedAt: Date;
}

interface OpenRow {
  approval_id: string;
  presented_at: Date;
  later_texts: string[];
}

/**
 * The contact cards open on WhatsApp for a message sent at `inboundAt`: the
 * approval is pending, unexpired, unspent and for `wa.send_message`; its job
 * is parked in `await_approval` and is the `card_job_id` of a `carded`
 * conversation; this code presented it (an outbound row for the job ending
 * with `CONTACT_CARD_INSTRUCTION`, at or after the card was raised); the
 * presentation is inside the window and strictly before the message; and no
 * later owner message was a closure word. Read-only.
 */
export async function openContactCards(db: BusinessDb, input: {
  excludeMessageId: string;
  inboundAt: string;
  now?: number;
  windowMinutes?: number;
}): Promise<OpenContactCard[]> {
  const windowMinutes = input.windowMinutes ?? capFor(await loadRuntimeSettings(db), 'whatsappQuestionWindowMinutes');
  if (windowMinutes <= 0) return [];
  const nowMs = input.now ?? Date.now();
  const inboundMs = Date.parse(input.inboundAt);
  if (Number.isNaN(inboundMs)) return [];

  const { rows } = await db.query<OpenRow>(
    `SELECT a.approval_id, p.presented_at,
            ARRAY(
              SELECT coalesce(w.transcript, w.body, '')
                FROM whatsapp_messages w
               WHERE w.business_id = a.business_id
                 AND w.direction = 'inbound'
                 AND w.sender_kind = 'principal'
                 AND w.created_at > p.presented_at
                 AND w.id <> $3
            ) AS later_texts
       FROM approval_requests a
       JOIN jobs j
         ON j.business_id = a.business_id AND j.job_id = a.job_id AND j.phase = 'await_approval'
       JOIN contact_conversations c
         ON c.business_id = a.business_id AND c.card_job_id = a.job_id AND c.state = 'carded'
       JOIN LATERAL (
         SELECT w.created_at AS presented_at
           FROM whatsapp_messages w
          WHERE w.business_id = a.business_id
            AND w.direction = 'outbound'
            AND w.job_id = a.job_id
            AND w.state = 'handled'
            AND w.created_at >= a.created_at
            AND right(w.body, char_length($2)) = $2
          ORDER BY w.created_at DESC
          LIMIT 1
       ) p ON true
      WHERE a.business_id = $1
        AND a.state = 'pending'
        AND a.expires_at > now()
        AND a.consumed_at IS NULL
        AND a.proposed_tool = 'wa.send_message'
      ORDER BY p.presented_at`,
    [db.businessId, CONTACT_CARD_INSTRUCTION, input.excludeMessageId],
  );

  const open: OpenContactCard[] = [];
  for (const row of rows) {
    const presentedMs = row.presented_at.getTime();
    if (Number.isNaN(presentedMs) || nowMs - presentedMs > windowMinutes * 60_000) continue;
    if (!(inboundMs > presentedMs)) continue;
    if (row.later_texts.some((text) => isClosureCommand(text))) continue;
    const approval = await getApproval(db, row.approval_id);
    if (approval === null) continue;
    open.push({ approval, presentedAt: row.presented_at });
  }
  return open;
}

// --- Reading the owner's message ----------------------------------------------

export type ContactCardOutcome = 'decided' | 'replaced' | 'refused' | 'passthrough' | 'skipped';

/** Whether a typed message is one of the two contact-card actions. */
export function isContactCardAction(text: string): boolean {
  return isApproveWord(text) || replacementBody(text) !== null;
}

function recipientOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const to = (payload as Record<string, unknown>)['to'];
  return typeof to === 'string' ? stripBidiControls(to).trim() : '';
}

/**
 * The owner's TYPED message while at least one contact card is open.
 * `othersOpen` is how many OTHER things are open on WhatsApp for the same
 * message (`openOnWhatsApp`, contact card excluded): with any, "שלח" cannot
 * say which, and nothing is decided.
 */
export async function handleContactCardMessage(db: BusinessDb, input: {
  msg: NormalizedInboundMessage;
  storedId: string;
  cards: readonly OpenContactCard[];
  messenger: BossMessenger;
  othersOpen: number;
}): Promise<ContactCardOutcome> {
  const { msg, storedId, cards, messenger } = input;
  if (msg.mediaKind !== null || msg.body === null) return 'passthrough';
  const text = msg.body;
  if (!isContactCardAction(text) || cards.length === 0) return 'passthrough';

  const claimed = await claimMessage(db, storedId);
  if (!claimed) return 'skipped';

  const refuse = async (reply: string): Promise<'refused'> => {
    await messenger.send({ text: reply, jobId: null });
    await settleMessage(db, storedId, 'failed', {});
    return 'refused';
  };

  const only = cards.length === 1 && input.othersOpen === 0 ? cards[0] : undefined;
  const by = `whatsapp:${authorityNumberKey(msg.senderNumber) ?? msg.senderNumber}`;

  if (isApproveWord(text)) {
    if (only === undefined) return refuse(SEVERAL_OPEN_REFUSAL);
    return approveCard(db, only.approval, { by, storedId, messenger, refuse });
  }

  const newBody = replacementBody(text) ?? '';
  if (newBody === '') return refuse(EMPTY_REPLACEMENT);
  if (only === undefined) return refuse(SEVERAL_OPEN_REFUSAL);
  return replaceBody(db, only.approval, newBody, { by, storedId, messenger, refuse });
}

interface StepContext {
  by: string;
  storedId: string;
  messenger: BossMessenger;
  refuse: (text: string) => Promise<'refused'>;
}

async function approveCard(db: BusinessDb, card: ApprovalRequest, ctx: StepContext): Promise<ContactCardOutcome> {
  const staged = card.editedInput ?? undefined;
  if (staged !== undefined && !contactReplyEditAllowed(card.proposedInput, staged)) {
    return ctx.refuse(CONTACT_CARD_EDIT_REFUSAL);
  }
  // A card raised without a draft carries an empty body: approving it would
  // only fail at the send. The owner writes the reply with "נוסח:".
  if (bodyOf(staged ?? card.proposedInput).trim() === '') return ctx.refuse(CONTACT_CARD_NO_DRAFT);
  let decided: ApprovalRequest;
  try {
    decided = await decide(db, card.approvalId, 'approved', {
      by: ctx.by,
      channel: 'whatsapp',
      ...(staged !== undefined ? { editedInput: staged } : {}),
    });
  } catch (error) {
    if (error instanceof ApprovalNotDecidableError) return ctx.refuse(CONTACT_CARD_GONE);
    throw error;
  }
  let resumed = true;
  try {
    await resumeAfterDecision(db, decided, ctx.by);
  } catch {
    resumed = false;
  }
  await ctx.messenger.send({
    text: resumed ? `אישרתי. התשובה יוצאת ל-${recipientOf(card.proposedInput)}.` : DECIDED_RESUME_FAILED,
    jobId: null,
  });
  await settleMessage(db, ctx.storedId, 'handled', card.jobId !== null ? { jobId: card.jobId } : {});
  return 'decided';
}

/**
 * The owner's text as the new body: cancel the open card and raise a fresh
 * pending one on the SAME job with the edit staged — the proposal stays the
 * original bytes (it is what the bound plan step carries, so the approval is
 * found by it), and `contactReplyEditAllowed` says only `body` differs.
 * The conversation is not touched: it stays `carded` on this job.
 */
async function replaceBody(
  db: BusinessDb,
  card: ApprovalRequest,
  newBody: string,
  ctx: StepContext,
): Promise<ContactCardOutcome> {
  if (card.jobId === null) return ctx.refuse(CONTACT_CARD_GONE);
  const jobId = card.jobId;
  const proposed = card.proposedInput as Record<string, unknown>;
  const edited: Record<string, unknown> = { ...proposed, body: stripBidiControls(newBody) };
  if (!contactReplyEditAllowed(proposed, edited)) return ctx.refuse(CONTACT_CARD_EDIT_REFUSAL);

  const freshId = await transaction(db, async (tx) => {
    if (!(await cancelPendingApproval(tx, card.approvalId))) return null;
    const facts = buildFacts('wa.send_message', proposed, {
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    if (facts.actionClass !== 'whatsapp.reply' || facts.inputHash !== card.inputHash) {
      throw new Error(`contact card: proposal of ${card.approvalId} no longer reads as the bound reply`);
    }
    const { header } = splitDetail(card.detail);
    const id = await enqueueApproval(tx, {
      jobId,
      facts,
      risk: card.risk,
      proposedInput: proposed,
      summary: card.summary,
      detail: `${header}\n\n${edited['body'] as string}`,
      ttlMinutes: CONTACT_CARD_TTL_MINUTES,
    });
    if (!(await stagePendingEdit(tx, id, edited))) {
      throw new Error(`contact card: could not stage the edit on ${id}`);
    }
    return id;
  });
  if (freshId === null) return ctx.refuse(CONTACT_CARD_GONE);

  await presentContactCard(
    db,
    freshId,
    async (cardText, cardJobId) => (await ctx.messenger.send({ text: cardText, jobId: cardJobId })).ok,
    { lead: REPLACEMENT_LEAD },
  );
  await settleMessage(db, ctx.storedId, 'handled', { jobId });
  return 'replaced';
}
