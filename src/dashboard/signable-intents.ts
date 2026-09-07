/**
 * Which proposals may carry a sign button (spec 2026-09-01-signature §7).
 *
 * **Why this exists.** Signing is not a stronger flavour of approving. The
 * form says so in the owner's own language — *"חתימה … קובעת שהמסמך X נתקבל
 * כמחייב"* — and the record it writes is irreversible: `signatures` is unique
 * on `(business_id, document_id)`, a second signature is refused rather than
 * overwriting the first, and migration 020 replaced the row's `ON DELETE
 * CASCADE` with `RESTRICT` precisely so that no retention policy or deletion
 * request can carry away the one row that records a human act. One wrong
 * click is unrecoverable.
 *
 * Before the conductor, no approval card ever resolved to a document, so the
 * form never rendered and the condition was never load-bearing. The conductor
 * made every one of its cards resolve to a document — every conductor card has
 * a proposal with a `job_id` and a reading with a document behind it — which
 * turned a dormant capability live and, on the way, dropped the condition
 * spec §7 states: the button belongs on a card *whose proposal is a decision
 * about the document*. A card proposing to email Dana is not that, and it was
 * getting one.
 *
 * **An allowlist, never "everything except".** This project has written a
 * control as a negation three times and lost something to it three times
 * (`crm.write` demoted, `doc.fetch` widened, whole action classes left dead).
 * A new member of `IntentName` is a name nobody has yet decided about, and the
 * safe reading of "nobody decided" is "no form" — which is what an allowlist
 * gives for free and a denylist gives never.
 *
 * **Why exactly one member, and why each of the other nine is off.** The test
 * is not "does this concern the document" — every intent derived from a
 * reading concerns the document. It is "is the owner's decision here a
 * decision *about the document itself*, such that recording 'I accept this as
 * binding' is a truthful description of what they just clicked".
 *
 * - `file_document` — **on.** Its whole meaning is a disposition of this
 *   document and nothing else ("לתייק במקום שלו, בלי פעולה נוספת"). Accepting
 *   it is accepting the document into the business's record, which is the
 *   thing the signature asserts. No message leaves, no money moves; the
 *   decision and the signature have the same subject.
 * - `pay_or_purchase` — **off.** Tempting, because an invoice accepted as
 *   binding is a real thing an owner does. But approving a payment and
 *   attesting to a document are two irreversible acts, and putting them on one
 *   button is the exact conflation this list exists to undo. If the owner
 *   should do both, they should do both deliberately.
 * - `reply_to_sender`, `contact_counterparty`, `schedule_meeting` — **off.**
 *   The decision is about a message or a meeting going out. The document is
 *   the reason, not the subject.
 * - `record_entity`, `record_preference` — **off.** The decision is about what
 *   to remember from the content. Nothing about it says the document is
 *   accepted as binding.
 * - `flag_for_owner` — **off.** "אדם חייב להסתכל על זה" is an escalation, the
 *   opposite of a settled decision.
 * - `request_clarification` — **off.** The reading itself is incomplete; there
 *   is nothing yet to accept.
 * - `no_action` — **off.** Contradictory on its face, and unreachable anyway:
 *   a proposal with no action raises no approval at all, so no card exists to
 *   put a button on.
 *
 * Widening this list is an owner-facing decision, not a refactor. Anything
 * added here becomes reachable by one click from a card the conductor raised
 * about a document a stranger sent.
 */
import type { IntentName } from '../domain/reading.js';

export const DOCUMENT_DECISION_INTENTS: readonly IntentName[] = ['file_document'];

/**
 * True only for an intent named above.
 *
 * `null` — the proposal carries no action, the stored proposal predates the
 * `intent` field, or the stored value is not a member of the closed enum —
 * is false, deliberately and without a branch of its own: an unreadable
 * answer is never the permissive answer.
 */
export function isDocumentDecisionIntent(intent: IntentName | null): boolean {
  return intent !== null && DOCUMENT_DECISION_INTENTS.includes(intent);
}
