/**
 * A mail that asks a question becomes a reply job and one approval card.
 *
 * **The shape, and why each piece is where it is.**
 *
 *   - The drafter is the only model call, and it runs BEFORE any job exists:
 *     a failed draft leaves nothing behind — no job, no card — and the mail
 *     still shows on the mail screen as a question.
 *   - The job is `unknown_external`, written as a literal in the `createJob`
 *     call. Not a parameter: everything here derives from a stranger's mail.
 *   - The plan is bound BEFORE the card goes up, for the reason `conduct.ts`
 *     gives: in this order a crash leaves an inert `plan`-phase job; in the
 *     other order the owner approves a card into `no_plan_bound`.
 *   - The card is raised directly (`buildFacts` → `assessRisk` →
 *     `enqueueApproval` → `notifyOwner`), the same pattern as
 *     `raiseProposalApproval`. The gate would deny at stage 8 and raise
 *     nothing. When the plan finally runs, the gate still answers, and the
 *     stage-8 exemption for an approved reply (`policy/approved-reply.ts`)
 *     is what lets these exact bytes through — so there is no `RAMP_HONESTY`
 *     sentence here: approving this card does send.
 *   - The recipient is the original `From`, always. A differing `Reply-To`
 *     is shown on the card and never used.
 *
 * **Recording why no card was raised.** A mail without a Message-ID cannot be
 * threaded (`no_message_id`), and a mail whose sender could not be parsed has
 * nobody to answer (`no_sender`). Both are written onto the mail row with
 * `noteMailError`, which leaves `state` alone — the poller settles the row
 * afterwards and `settleMail` COALESCEs `error`, so the reason survives. A
 * failed DRAFT records nothing: it returns `null` and the poller decides.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { MailTriage } from '../domain/mail-triage.js';
import { Plan } from '../domain/plan.js';
import { cancelPendingApproval, enqueueApproval } from '../governance/approvals.js';
import {
  claimFailedReply,
  linkReplyJob,
  noteMailError,
  type StoredMail,
} from '../mail/inbox-store.js';
import {
  composeReplyDetail,
  displayLine,
  mailboxReplyRecipient,
  replySubject,
} from '../mail/reply-card.js';
import { buildFacts } from '../policy/facts.js';
import { assessRisk } from '../policy/risk.js';
import type { Drafter } from '../sdk/mail-drafter.js';
import { createJob, transition, type Job } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { notifyOwner, type NotifyTarget } from './proposal-approval.js';

export { replySubject } from '../mail/reply-card.js';

export interface RaiseMailReplyInput {
  mail: StoredMail;
  triage: MailTriage;
  bundle: PolicyBundle;
  drafter: Drafter;
}

export interface RaiseMailReplyOptions {
  businessId?: string;
  notify?: NotifyTarget;
}

export interface RaisedReply {
  replyJobId: string;
  approvalId: string;
}

/** The mail.send payload a reply job binds — `providerMessageId` is required by the send adapter. */
export type ReplyPayload = {
  to: [string];
  subject: string;
  body: string;
  inReplyTo: string;
  references: string | null;
  threadId: string;
  providerMessageId: string;
};

export async function raiseMailReply(
  input: RaiseMailReplyInput,
  options: RaiseMailReplyOptions = {},
): Promise<RaisedReply | null> {
  const { mail, triage, bundle } = input;
  const businessId = options.businessId ?? config.businessId;

  // Positive checks, before anything costs money. An unparseable sender is
  // '' (Task 3's mapping): no one to answer.
  if (mail.fromAddress.trim() === '') {
    await noteMailError(mail.mailId, 'no_sender', { businessId });
    return null;
  }
  if (mail.internetMessageId === null || mail.internetMessageId.trim() === '') {
    await noteMailError(mail.mailId, 'no_message_id', { businessId });
    return null;
  }
  // A question always carries a gist (`mailTriageProblems`), but this is
  // typed nullable and a drafter without one has nothing to say.
  if (triage.replyGist === null) {
    await noteMailError(mail.mailId, 'no_reply_gist', { businessId });
    return null;
  }

  const draft = await input.drafter({
    bundle,
    summary: triage.summary,
    replyGist: triage.replyGist,
    subject: mail.subject,
  });
  if (draft.status !== 'drafted') return null;

  const payload: ReplyPayload = {
    to: [mail.fromAddress],
    subject: replySubject(mail.subject),
    body: draft.body,
    inReplyTo: mail.internetMessageId,
    references: mail.references,
    threadId: mail.threadId,
    providerMessageId: mail.providerMessageId,
  };

  return raiseReplyCard(
    {
      mailId: mail.mailId,
      originalSubject: mail.subject,
      displayName: mail.fromName,
      replyTo: mail.replyTo,
      payload,
      bundle,
    },
    { businessId, ...(options.notify !== undefined ? { notify: options.notify } : {}) },
  );
}

interface ReplyCardInput {
  mailId: string;
  originalSubject: string;
  displayName: string | null;
  replyTo: string | null;
  /** Bound verbatim as the plan step's input AND the card's proposed input. */
  payload: Record<string, unknown>;
  bundle: PolicyBundle;
  retry?: { mayHaveSent: boolean };
}

/**
 * Open the reply job, bind its one-step plan, raise the card, park the job in
 * `await_approval`, and link the mail to it. Shared by the first card and a
 * re-raise, so the two can never disagree about what a reply job looks like.
 */
async function raiseReplyCard(
  input: ReplyCardInput,
  options: { businessId: string; notify?: NotifyTarget },
): Promise<RaisedReply> {
  const { businessId } = options;
  const recipient = mailboxReplyRecipient(input.payload);
  if (recipient === null) throw new Error('raiseReplyCard: payload is not a mailbox reply');
  const payload = input.payload;
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '';
  const body = typeof payload['body'] === 'string' ? payload['body'] : '';

  const plan = Plan.parse({
    goal: `תשובה לשולח: ${displayLine(input.originalSubject)}`,
    steps: [
      {
        id: 'reply',
        agent: 'comms.email',
        intent: 'reply_to_sender',
        toolName: 'mail.send',
        input: payload,
        expectedActionClass: 'email.reply',
      },
    ],
  });

  const job: Job = await createJob({
    charterVersion: input.bundle.charterVersion,
    // Not a parameter, and not derived from anything a mail says.
    provenance: 'unknown_external',
    businessId,
    title: `תשובה: ${input.originalSubject}`,
  });

  // Hoisted so the catch can withdraw a card that went up before the throw.
  let approvalId: string | null = null;
  try {
    for (const to of ['understand', 'plan'] as const) {
      await transition(job.jobId, {
        to,
        actor: 'orchestrator',
        reason: 'mail reply: drafting a reply to the sender',
        businessId,
      });
    }

    const bound = await bindPlanToJob(job.jobId, plan, { businessId });
    if (bound.status === 'conflict') throw new Error(`mail reply: plan conflict on fresh job ${job.jobId}`);

    const facts = buildFacts('mail.send', payload, {
      // Same reasoning as `raiseProposalApproval`: the chain read mail from
      // outside, so neither exemption a `boss` chain earns applies.
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    if (facts.actionClass !== 'email.reply') {
      // `inReplyTo` is present, so `refineActionClass` must say reply. If it
      // ever does not, a card would ask about a cold email — refuse loudly.
      throw new Error(`mail reply: payload classified as ${String(facts.actionClass)}, not email.reply`);
    }
    const risk = await assessRisk(facts, input.bundle);

    const who = displayLine(input.displayName ?? '') || recipient;
    approvalId = await enqueueApproval(
      {
        jobId: job.jobId,
        facts,
        risk,
        proposedInput: payload,
        summary: `תשובה ל-${who}: ${displayLine(input.originalSubject)}`,
        detail: composeReplyDetail({
          fromAddress: recipient,
          replyTo: input.replyTo,
          subject,
          body,
          ...(input.retry !== undefined ? { retry: input.retry } : {}),
        }),
      },
      { businessId },
    );

    if (options.notify !== undefined) {
      await notifyOwner(approvalId, options.notify, {
        businessId,
        jobId: job.jobId,
        facts,
        charterVersion: input.bundle.charterVersion,
      });
    }

    // `resumeAfterDecision` takes `await_approval` to `execute` on approve
    // and to `closed` on deny — the same parking spot `conduct.ts` uses.
    await transition(job.jobId, {
      to: 'await_approval',
      actor: 'orchestrator',
      reason: `mail reply: ${approvalId}`,
      businessId,
    });

    await linkReplyJob(input.mailId, job.jobId, { businessId });
    return { replyJobId: job.jobId, approvalId };
  } catch (error) {
    // A card already queued would otherwise sit pending on a failed job: the
    // owner could approve it, and nothing would ever run. Withdraw it first.
    if (approvalId !== null) {
      try {
        await cancelPendingApproval(approvalId, { businessId });
      } catch {
        // Best effort; `expireOverdue` retires it on schedule regardless.
      }
    }
    // Every phase a throw can leave the job in has no reader that would move
    // it on; close it rather than leak it. Best effort: the original error is
    // the one worth surfacing.
    try {
      await transition(job.jobId, {
        to: 'failed',
        actor: 'orchestrator',
        reason: `mail reply: ${error instanceof Error ? error.message : String(error)}`,
        businessId,
      });
    } catch {
      // The job may already have moved; nothing more to do here.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Re-asking after an approved send that did not complete (ruling R8)
// ---------------------------------------------------------------------------

/**
 * Failure codes after which the provider may have accepted the mail.
 * `delivery_unknown` is the send adapter's status-0 answer; `adapter_timeout`
 * is the orchestrator's own deadline. Neither carries "nothing was created".
 */
const MAY_HAVE_SENT_CODES: readonly string[] = ['delivery_unknown', 'adapter_timeout'];

interface FailedReplyRow {
  mail_id: string;
  job_id: string;
  original_subject: string;
  from_name: string | null;
  reply_to: string | null;
  proposed_input: unknown;
  edited_input: unknown;
  state: string;
  may_have_sent: boolean;
}

export interface ReraiseResult {
  reraised: number;
  /** Claimed, then raising the fresh card threw. Recorded on the mail as `reraise_failed`. */
  failed: number;
  /** Failed reply jobs whose approved payload no longer reads as a mailbox reply. Left alone. */
  skipped: number;
}

/**
 * Raise a FRESH card for a reply whose approved send did not complete.
 *
 * A consumed approval is never reused (CLAUDE.md: "approval consumed once,
 * failure does not return it"). So a send that failed after the claim — a
 * retryable failure that parked the job in `followup` and was then refused at
 * stage 8 on wake, or a terminal failure — ends the job `failed` with the
 * owner's "yes" spent and nothing sent. This finds those jobs and asks again,
 * on a NEW reply job, with the bytes the owner last approved (the edit, when
 * there was one) and a first line saying so.
 *
 * Found by a positive marker: the mail row's `reply_job_id` names the job, the
 * job is `failed`, an approval on it was consumed, and no step result for it
 * is `completed`. Each failed job is re-raised at most once:
 * `claimFailedReply` takes it off the mail in one conditional UPDATE before
 * anything else happens, and the mail is then linked to the new job.
 *
 * When the earlier failure was `delivery_unknown` or `adapter_timeout`, the
 * mail may already be in the recipient's inbox; the card says so, so the
 * owner checks Sent before approving rather than sending twice.
 */
export async function reraiseAfterFailedSend(
  input: { bundle: PolicyBundle },
  options: RaiseMailReplyOptions = {},
): Promise<ReraiseResult> {
  const businessId = options.businessId ?? config.businessId;
  const { rows } = await getPool().query<FailedReplyRow>(
    `SELECT m.mail_id, j.job_id, m.subject AS original_subject, m.from_name, m.reply_to,
            a.proposed_input, a.edited_input, a.state,
            (EXISTS (
               SELECT 1 FROM job_steps s
                WHERE s.job_id = j.job_id
                  AND split_part(s.reason, ' ', 1) = ANY($2::text[])
             ) OR EXISTS (
               SELECT 1 FROM job_step_results u
                WHERE u.business_id = m.business_id AND u.job_id = j.job_id AND u.status = 'unknown'
             )) AS may_have_sent
       FROM mail_messages m
       JOIN jobs j ON j.business_id = m.business_id AND j.job_id = m.reply_job_id
       JOIN LATERAL (
         SELECT ar.proposed_input, ar.edited_input, ar.state
           FROM approval_requests ar
          WHERE ar.business_id = m.business_id
            AND ar.job_id = j.job_id
            AND ar.consumed_at IS NOT NULL
          ORDER BY ar.consumed_at DESC
          LIMIT 1
       ) a ON true
      WHERE m.business_id = $1
        AND j.phase = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM job_step_results r
           WHERE r.business_id = m.business_id AND r.job_id = j.job_id AND r.status = 'completed'
        )
      ORDER BY m.received_at`,
    [businessId, MAY_HAVE_SENT_CODES],
  );

  const result: ReraiseResult = { reraised: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const approved =
      row.state === 'approved_with_edit' && row.edited_input !== null ? row.edited_input : row.proposed_input;
    if (mailboxReplyRecipient(approved) === null) {
      result.skipped += 1;
      continue;
    }
    if (!(await claimFailedReply(row.mail_id, row.job_id, { businessId }))) continue;

    // Per row: one failure must not stop the rest of the batch. The claim is
    // already spent, so this failed job will not be offered again — the mail
    // says why instead of going quiet.
    try {
      await raiseReplyCard(
        {
          mailId: row.mail_id,
          originalSubject: row.original_subject,
          displayName: row.from_name,
          replyTo: row.reply_to,
          payload: approved as Record<string, unknown>,
          bundle: input.bundle,
          retry: { mayHaveSent: row.may_have_sent },
        },
        { businessId, ...(options.notify !== undefined ? { notify: options.notify } : {}) },
      );
      result.reraised += 1;
    } catch {
      result.failed += 1;
      try {
        await noteMailError(row.mail_id, 'reraise_failed', { businessId });
      } catch {
        // The database is having the same bad moment; the count still says so.
      }
    }
  }
  return result;
}
