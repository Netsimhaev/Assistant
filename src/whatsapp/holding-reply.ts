/**
 * The holding reply: "I received your message, checking and will update."
 *
 * THE ONE DOCUMENTED GATE BYPASS of the contact-WhatsApp feature. It goes
 * straight to the gateway, not through `evaluateToolCall`, because a contact's
 * first message is `unknown_external` and the gate would refuse every outbound
 * action there. What stands in for the gate, all positive checks:
 *   - the text is a constant (`HOLDING_REPLY_TEXT`) — the sending function has
 *     no text parameter, so nothing a contact wrote can reach the wire;
 *   - the recipient is the conversation's own `contact_key`, read from the row;
 *   - once per conversation, at most 3 per number per business day, only when
 *     the contact wrote within the last 60 minutes;
 *   - never inside quiet hours (deferred to their end) and stopped by the
 *     `outbound` kill switch;
 *   - an audit row that carries a hash and a constant reason, never the number.
 */
import type { BusinessDb } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import { appendAudit } from '../audit/log.js';
import { checkKillSwitch } from '../governance/killswitch.js';
import { inQuietHours } from '../policy/redact.js';
import { canonicalHash } from '../util/canonical.js';
import { localParts, localToInstant, nextQuietEnd } from '../util/local-time.js';
import { deferHolding, loadConversation, markHoldingSent } from './contact-conversations.js';
import type { WhatsAppGateway } from './gateway.js';
import { recordOutbound } from './store.js';

export const HOLDING_REPLY_REASON = 'contact_holding_reply';
export const HOLDING_MAX_PER_DAY = 3;
export const HOLDING_FRESHNESS_MS = 60 * 60 * 1000;

export const HOLDING_REPLY_TEXT = (businessName: string): string =>
  `שלום, כאן העוזרת הדיגיטלית של ${businessName}. קיבלתי את הודעתך — בודקת ומעדכנת בהקדם.`;

export interface HoldingDeps {
  gateway: WhatsAppGateway;
  bundle: PolicyBundle;
  businessName: string;
  now: Date;
}

export type HoldingOutcome = 'sent' | 'deferred' | 'already' | 'stale' | 'capped' | 'halted' | 'failed';

async function holdingsToday(db: BusinessDb, key: string, bundle: PolicyBundle, now: Date): Promise<number> {
  // The business day, in the charter's timezone (UTC when no quiet window names one).
  const tz = bundle.quietHours?.timezone ?? 'UTC';
  const dayStart = localToInstant(localParts(now, tz).date, '00:00', tz);
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log
      WHERE business_id = $1 AND kind = 'tool_call' AND reason = $2 AND input_hash = $3 AND at >= $4`,
    [db.businessId, HOLDING_REPLY_REASON, canonicalHash({ key }), dayStart],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function sendHoldingReply(
  db: BusinessDb,
  deps: HoldingDeps,
  conversationId: string,
): Promise<HoldingOutcome> {
  const { gateway, bundle, businessName, now } = deps;
  const conv = await loadConversation(db, conversationId);
  if (conv === null) return 'stale';
  if (conv.holdingSentAt !== null) return 'already';

  const kill = await checkKillSwitch(db, 'comms.whatsapp', true);
  if (kill.blocked) return 'halted';

  // A deferred reply (holding_due_at set) is still wanted while the question is open;
  // a first attempt must be fresh.
  if (conv.holdingDueAt !== null) {
    if (conv.state !== 'open' && conv.state !== 'carded') return 'stale';
  } else if (now.getTime() - conv.lastInboundAt.getTime() > HOLDING_FRESHNESS_MS) return 'stale';
  if ((await holdingsToday(db, conv.contactKey, bundle, now)) >= HOLDING_MAX_PER_DAY) return 'capped';

  if (inQuietHours(bundle.quietHours, now)) {
    await deferHolding(db, conversationId, nextQuietEnd(bundle, now));
    return 'deferred';
  }

  let state: string;
  try {
    const result = await gateway.sendMessage({
      contactId: conv.contactKey,
      body: HOLDING_REPLY_TEXT(businessName),
      idempotencyKey: `holding:${conversationId}`,
    });
    state = result.state;
  } catch {
    return 'failed';
  }
  if (state === 'rejected') return 'failed';

  await markHoldingSent(db, conversationId, now);
  await recordOutbound(db, { body: HOLDING_REPLY_TEXT(businessName), jobId: null, recipientNumber: conv.contactKey });
  await appendAudit(db, {
    actor: 'agent' as never,
    kind: 'tool_call',
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    inputHash: canonicalHash({ key: conv.contactKey }),
    reason: HOLDING_REPLY_REASON,
  });
  return 'sent';
}

/** Scheduler entry: every conversation whose deferred reply is now due and unsent. */
export async function sendDueHoldingReplies(
  db: BusinessDb,
  deps: HoldingDeps,
): Promise<{ sent: number; failed: number }> {
  const { rows } = await db.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM contact_conversations
      WHERE business_id = $1 AND holding_due_at <= $2 AND holding_sent_at IS NULL
        AND state IN ('open', 'carded')
      ORDER BY holding_due_at`,
    [db.businessId, deps.now],
  );
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const outcome = await sendHoldingReply(db, deps, r.conversation_id);
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
  }
  return { sent, failed };
}
