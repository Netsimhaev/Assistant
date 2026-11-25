import type { ActionFacts } from '../domain/policy.js';
import type { GateContext } from './engine.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import { WHATSAPP_CONTACTS_SYSTEM } from '../charter/amend-whatsapp-contacts.js';
import { listManagedContacts } from '../memory/managed-contacts.js';
import { loadClearance } from '../whatsapp/auto-clearance.js';
import { loadTopic, topicApplies } from '../whatsapp/contact-topics.js';
import { loadContactWaSettings } from '../whatsapp/sources/invoice-settings.js';

/**
 * Whether the call in front of stage 8 is an AUTO reply to a managed WhatsApp
 * contact that the six exit checks cleared for these exact bytes (WhatsApp
 * contacts phase 2, spec §7). When it holds, stage 8 drops the ramp and the
 * provenance ceiling — the same two `approvedReplyCovers` drops — and risk
 * scoring treats that one contact's number as known.
 *
 * Why it exists: a contact-card job is `unknown_external`, whose signed
 * ceiling is `draft_only`, and under the dial's default `off` the ramp is
 * `draft_only` too. A reply the owner allowed the assistant to send alone, on
 * a topic he approved, would otherwise die at stage 8 every time.
 *
 * Built in the pattern of `approvedReplyCovers`/`learnedReplyCovers`. Every
 * condition is positive and each one is required; a value that cannot be
 * read is never the permissive one:
 *
 *   1. `ctx.approval` is ABSENT (an approved card is `approvedReplyCovers`'s
 *      case), and `ctx.jobId` and `ctx.stepId` are strings. `stepId` is set
 *      by `executeStep` and nowhere else — the SDK hook does not set it — so
 *      an agent running straight through the SDK is never covered.
 *   2. The refined class is exactly `whatsapp.reply` (`whatsapp.initiate`, a
 *      message with no real `conversationId`, never) and no amount is declared.
 *   3. The payload's OWN `conversationId` is a non-empty string, its OWN `to`
 *      is a string that `authorityNumberKey` parses (international form only,
 *      one number — a comma-joined list does not parse), and every phone the
 *      facts read from the payload is that same number: a second phone key
 *      would be a second recipient the clearance never named.
 *   4. A `contact_conversations` row IN THIS BUSINESS has this job as its
 *      current card job, is the conversation the payload names, is still
 *      `carded`, and its stored number is `to`.
 *   5. A clearance row exists for this job and step, its `input_hash` equals
 *      `facts.inputHash` — the hash of the bytes about to run, so an edited
 *      or re-planned payload is not covered — and it names this conversation.
 *   6. The job has NO `job_step_results` row with status `unknown`: a send
 *      that timed out may already be with the contact, and no approval stands
 *      between a re-run and a second message (the `learnedReplyCovers` lesson).
 *   7. The charter switch: the active charter declares the `whatsapp-contacts`
 *      connection AND its signed base for `whatsapp.reply` is `auto_notify` or
 *      `auto`. Lowering the base in a re-signed charter turns this off.
 *   8. The settings switch: the owner's auto-reply toggle is on.
 *   9. Send-time re-check, because quiet hours can park a cleared job for a
 *      night: the clearance's topic still exists, is not retired, still has
 *      auto-reply on and still applies to the conversation's contact kind; the
 *      managed contact on `'+' + to` still exists (owner-written, `boss`), is
 *      not also a colleague, and its kind equals the conversation's kind.
 *
 * It is a read and only a read. There is no claim to lose between it and the
 * allow (no approval is spent), so the stage-10 lost-claim recompute does not
 * apply; repeat sends are stopped by condition 6 and by the conversation
 * leaving `carded` once the send completes.
 *
 * What it does not bypass: the kill switch (1), a readable current charter
 * (2), the tool allowlist (3), `forbidden` (5), do-not-contact (6) and quiet
 * hours (7) all run before stage 8. Inside stage 8 the signed base for the
 * class, every counterparty override and an envelope's ceiling still apply;
 * budget (9) and the risk band (10) still run after it.
 */
/** Appended to the `intent_to_act` audit reason when the exemption carried the call. */
export const CONTACT_REPLY_EXEMPTION_MARKER = 'contact_reply_exemption';

export type ContactReplyCoverage = { covered: false } | { covered: true; knownPhone: string };

const NOT_COVERED: ContactReplyCoverage = { covered: false };

function ownString(input: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(input, key)) return null;
  const v = input[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export async function contactReplyCovers(
  facts: ActionFacts,
  toolInput: Record<string, unknown>,
  ctx: GateContext,
): Promise<ContactReplyCoverage> {
  // 1.
  if (ctx.approval !== undefined) return NOT_COVERED;
  if (typeof ctx.jobId !== 'string' || ctx.jobId === '') return NOT_COVERED;
  if (typeof ctx.stepId !== 'string' || ctx.stepId === '') return NOT_COVERED;
  // 2.
  if (facts.actionClass !== 'whatsapp.reply') return NOT_COVERED;
  if (facts.amountDeclared !== false) return NOT_COVERED;
  // 3.
  const conversationId = ownString(toolInput, 'conversationId');
  if (conversationId === null) return NOT_COVERED;
  const to = ownString(toolInput, 'to');
  if (to === null) return NOT_COVERED;
  const toKey = authorityNumberKey(to);
  if (toKey === null) return NOT_COVERED;
  if (facts.counterpartyPhones.length === 0 || !facts.counterpartyPhones.every((p) => p === toKey)) {
    return NOT_COVERED;
  }
  // 7. (charter only — no I/O, so checked before the reads)
  if (!ctx.bundle.connections.some((c) => c.system === WHATSAPP_CONTACTS_SYSTEM)) return NOT_COVERED;
  const base = ctx.bundle.autonomyBase['whatsapp.reply'];
  if (base !== 'auto_notify' && base !== 'auto') return NOT_COVERED;

  const db = ctx.db;
  const businessId = db.businessId;
  const jobId = ctx.jobId;

  // 4. and 6.
  const { rows } = await db.query<{ contact_kind: string }>(
    `SELECT c.contact_kind
       FROM contact_conversations c
      WHERE c.business_id = $1
        AND c.card_job_id = $2
        AND c.conversation_id = $3
        AND c.state = 'carded'
        AND c.contact_key = $4
        AND NOT EXISTS (
          SELECT 1 FROM job_step_results r
           WHERE r.business_id = $1 AND r.job_id = $2 AND r.status = 'unknown'
        )`,
    [businessId, jobId, conversationId, toKey],
  );
  const conversation = rows[0];
  if (conversation === undefined) return NOT_COVERED;
  const kind = conversation.contact_kind;
  if (kind !== 'client' && kind !== 'supplier') return NOT_COVERED;

  // 5.
  const clearance = await loadClearance(db, jobId, ctx.stepId);
  if (clearance === null) return NOT_COVERED;
  if (clearance.inputHash !== facts.inputHash) return NOT_COVERED;
  if (clearance.conversationId !== conversationId) return NOT_COVERED;

  // 8.
  const settings = await loadContactWaSettings(db);
  if (settings.autoReplyEnabled !== true) return NOT_COVERED;

  // 9. The topic, as it is NOW.
  const topic = await loadTopic(db, clearance.topicId);
  if (topic === null || topic.retiredAt !== null || topic.autoReply !== true) return NOT_COVERED;
  if (!topicApplies(topic, kind)) return NOT_COVERED;

  // 9. The contact, as it is NOW: owner-managed, same kind, not a colleague.
  const contacts = await listManagedContacts(db);
  const contact = contacts.find((c) => c.subjectKey === `+${toKey}`);
  if (contact === undefined || contact.kind !== kind) return NOT_COVERED;
  const colleagues = await db.query<{ phone: string }>(
    `SELECT phone FROM business_colleagues WHERE business_id = $1`,
    [businessId],
  );
  // Colleagues are recorded and never answered: a number that is also a
  // colleague's is not a contact for this purpose.
  const colleagueKeys = colleagues.rows.map((r) => authorityNumberKey(r.phone));
  if (colleagueKeys.some((k) => k === toKey)) return NOT_COVERED;

  return { covered: true, knownPhone: toKey };
}
