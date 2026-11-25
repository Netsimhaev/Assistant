/**
 * A failed auto reply is never silent (phase 2, spec §6): the contact asked a
 * question, the assistant meant to answer it without a card, the send failed —
 * and nobody ever saw the draft. This turns such a job into an ordinary card,
 * once, so the owner decides what happens to the contact's question.
 *
 * The mirror of `reraiseLearnedReplies` (mail): the card-less job, `failed`,
 * with no approval and no completed step. A job with an approval is a CARD job
 * and `contact-housekeeping.ts` already owns it (the I2 note).
 *
 * **The conversation swap is the claim.** `raiseContactCard` in `card` mode
 * re-points the conversation with a compare-and-swap on the failed job; the
 * pass that wins it owns the re-raise, and a second pass finds the
 * conversation pointing at the new card and the failed job no longer selected.
 * Claim before send: a crash after the swap loses at most the owner's message
 * (the card is still on the dashboard) and never raises a second card.
 *
 * **An auto job is recognised by its card context (`contact_card_context.auto`),
 * never by a `job_steps` row.** `raiseAuto` takes the conversation over before
 * the job moves `plan -> execute`; a transition that throws after the
 * take-over fails the job without any `execute` row, and a crash there leaves
 * it in `plan`. Both are this module's: a pass first fails auto jobs stuck in
 * `intake`/`understand`/`plan` for more than 15 minutes (the ledger nudge T10
 * sweep), then re-raises every failed one.
 *
 * "ייתכן שההודעה כבר יצאה" when any step row is `unknown` or a failure code is
 * in `MAY_HAVE_SENT_CODES`: a timeout after the send was issued leaves the
 * message possibly delivered, and the owner must check before approving it again.
 */
import type { BusinessDb } from '../db/pool.js';
import type { BossMessenger } from './messenger.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { WhatsAppGateway } from './gateway.js';
import type { NotifyTarget } from '../orchestrator/proposal-approval.js';
import { MAY_HAVE_SENT_CODES } from '../domain/may-have-sent.js';
import { CONTACT_REPLY_EXEMPTION_MARKER } from '../policy/contact-reply.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { PhaseMovedError, transition } from '../orchestrator/jobs.js';
import { toOneLine } from '../util/bidi.js';
import { loadCardContext } from './card-context.js';
import { ContactCardBusyError, presentContactCard, raiseContactCard } from './contact-card.js';
import { loadConversation } from './contact-conversations.js';
import { sendHoldingReply } from './holding-reply.js';
import { loadTopic, setTopicAutoReply } from './contact-topics.js';

export const AUTO_FAILED_REASON = 'התשובה האוטומטית לא יצאה';
export const MAY_HAVE_SENT_NOTE = 'ייתכן שההודעה כבר יצאה — כדאי לבדוק בטלפון לפני שמאשרים';

const TITLE_PREFIX = 'תשובה בוואטסאפ: ';

export interface ReraiseDeps {
  bundle: PolicyBundle;
  /** For the holding reply, which an auto reply never sent; the card path owes it now. */
  gateway: WhatsAppGateway;
  messenger: BossMessenger;
  notify?: NotifyTarget;
  now: Date;
}

export interface ReraiseResult {
  reraised: number;
  skipped: number;
}

interface FailedAutoRow {
  job_id: string;
  conversation_id: string;
  title: string | null;
  may_have_sent: boolean;
}

/** How long an auto job may sit before `execute` before it counts as a crash mid-raise. */
export const AUTO_STALLED_MINUTES = 15;
export const AUTO_STALLED_REASON = 'contact_auto_stalled — the auto job never reached execute';

/**
 * Fails auto jobs left in `intake`/`understand`/`plan` past the window (a
 * crash between the take-over and `plan -> execute`), conditionally: a job
 * that moved meanwhile is skipped.
 */
async function failStalledAutoJobs(db: BusinessDb, now: Date): Promise<void> {
  const { rows } = await db.query<{ job_id: string; phase: 'intake' | 'understand' | 'plan' }>(
    `SELECT j.job_id, j.phase
       FROM jobs j
       JOIN contact_card_context x ON x.business_id = j.business_id AND x.job_id = j.job_id
      WHERE j.business_id = $1
        AND x.auto = true
        AND j.phase IN ('intake', 'understand', 'plan')
        AND j.updated_at < $2::timestamptz - make_interval(mins => $3)`,
    [db.businessId, now, AUTO_STALLED_MINUTES],
  );
  for (const row of rows) {
    try {
      await transition(db, row.job_id, { to: 'failed', actor: 'orchestrator', reason: AUTO_STALLED_REASON, expectFrom: row.phase });
    } catch (error) {
      if (!(error instanceof PhaseMovedError)) throw error;
    }
  }
}

/** Card-less auto jobs that failed, whose conversation still points at them. */
async function failedAutoJobs(db: BusinessDb): Promise<FailedAutoRow[]> {
  const { rows } = await db.query<FailedAutoRow>(
    `SELECT j.job_id, c.conversation_id, j.title,
            (EXISTS (SELECT 1 FROM job_steps f
                      WHERE f.business_id = j.business_id AND f.job_id = j.job_id
                        AND split_part(f.reason, ' ', 1) = ANY($2::text[]))
             OR EXISTS (SELECT 1 FROM job_step_results u
                         WHERE u.business_id = j.business_id AND u.job_id = j.job_id AND u.status = 'unknown')) AS may_have_sent
       FROM contact_conversations c
       JOIN jobs j ON j.business_id = c.business_id AND j.job_id = c.card_job_id
      WHERE c.business_id = $1
        AND c.state = 'carded'
        AND j.phase = 'failed'
        AND EXISTS (SELECT 1 FROM contact_card_context x
                     WHERE x.business_id = j.business_id AND x.job_id = j.job_id AND x.auto = true)
        AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                         WHERE ar.business_id = j.business_id AND ar.job_id = j.job_id)
        AND NOT EXISTS (SELECT 1 FROM job_step_results r
                         WHERE r.business_id = j.business_id AND r.job_id = j.job_id AND r.status = 'completed')
      ORDER BY c.opened_at`,
    [db.businessId, MAY_HAVE_SENT_CODES],
  );
  return rows;
}

/** The label the failed job's title carried; empty when it was only the number. */
function labelFromTitle(title: string | null, contactKey: string): string {
  if (title === null || !title.startsWith(TITLE_PREFIX)) return '';
  const label = title.slice(TITLE_PREFIX.length).trim();
  return label === `+${contactKey}` ? '' : label;
}

export async function reraiseFailedAutoReplies(db: BusinessDb, deps: ReraiseDeps): Promise<ReraiseResult> {
  const result: ReraiseResult = { reraised: 0, skipped: 0 };
  await failStalledAutoJobs(db, deps.now);
  for (const row of await failedAutoJobs(db)) {
    try {
      const stored = await loadPlanBody(db, row.job_id);
      const payload = stored?.plan.steps.find((s) => s.id === 'reply')?.input;
      const conversation = await loadConversation(db, row.conversation_id);
      const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['body'] : undefined;
      if (conversation === null || typeof body !== 'string' || body.trim() === '') {
        result.skipped += 1;
        continue;
      }
      const attach = (payload as Record<string, unknown>)['attachDocumentId'];
      const context = await loadCardContext(db, row.job_id);

      // The swap inside is the claim: only the pass that re-points the
      // conversation from this failed job gets a card.
      let raised: { jobId: string; approvalId: string };
      try {
        raised = await raiseContactCard(
          db,
          {
            conversation,
            draft: { body, attachDocumentId: typeof attach === 'string' && attach !== '' ? attach : null },
            reasonHe: [AUTO_FAILED_REASON, ...(row.may_have_sent ? [MAY_HAVE_SENT_NOTE] : [])].join('; '),
            sourcesHe: context?.sourceNames ?? [],
            bundle: deps.bundle,
            contactLabel: labelFromTitle(row.title, conversation.contactKey),
            mode: 'card',
            ...(context !== null
              ? {
                  context: {
                    kind: context.kind,
                    topicId: context.topicId,
                    summary: context.summary,
                    sourceNames: context.sourceNames,
                    internalDocumentIds: context.internalDocumentIds,
                  },
                }
              : {}),
          },
          deps.notify !== undefined ? { notify: deps.notify } : {},
        );
      } catch (error) {
        if (error instanceof ContactCardBusyError) {
          result.skipped += 1;
          continue;
        }
        throw error;
      }

      // The contact heard nothing so far (an auto reply sends no holding
      // reply); the existing rules (once, fresh, quiet hours, kill switch) apply.
      try {
        await sendHoldingReply(db, { gateway: deps.gateway, bundle: deps.bundle, now: deps.now }, conversation.conversationId);
      } catch (error) {
        console.error('contact auto re-raise: holding reply failed', error instanceof Error ? error.message : error);
      }
      await presentContactCard(db, raised.approvalId, async (text, jobId) => (await deps.messenger.send({ text, jobId })).ok);
      result.reraised += 1;
    } catch (error) {
      result.skipped += 1;
      console.error('contact auto re-raise failed', toOneLine(error instanceof Error ? error.message : String(error)));
    }
  }
  return result;
}

/**
 * "זו הייתה טעות" on an auto reply turns that topic's auto-reply off: the
 * topic is where the assistant earned the trust, so it is where it is taken
 * back. Returns the topic id when it was switched off, `null` when the job was
 * not an auto reply (no intent row ending with the exemption marker), had no
 * topic, or the topic is gone. The marker is read from the audit row the gate
 * itself wrote — never from anything the contact or the form carried.
 */
export async function turnOffTopicOfMarkedAutoReply(
  db: BusinessDb,
  jobId: string,
  by: string,
): Promise<string | null> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND job_id = $2 AND kind = 'intent_to_act'
        AND right(reason, length($3)) = $3`,
    [db.businessId, jobId, CONTACT_REPLY_EXEMPTION_MARKER],
  );
  if (Number(rows[0]?.n ?? '0') === 0) return null;
  const context = await loadCardContext(db, jobId);
  if (context === null || context.topicId === null) return null;
  const topic = await loadTopic(db, context.topicId);
  if (topic === null) return null;
  return (await setTopicAutoReply(db, context.topicId, false, by)) ? context.topicId : null;
}
