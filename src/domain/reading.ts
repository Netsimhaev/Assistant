import { z } from 'zod';
import { SafeLookupKey } from './charter.js';

/**
 * What a reader may conclude follows from something it read.
 *
 * An intent names an **outcome**, never a tool. `reply_to_sender`, not
 * `mail.send`. A reader that names tools is a reader choosing authority, and
 * `know.reader` is the quarantine agent — zero classified tools, input hostile
 * by construction. Mapping an intent onto steps is the planner's work; it sees
 * the capability catalogue and the charter, and the reader sees a document.
 *
 * The registry is small on purpose. Every name added here widens what a
 * document is able to ask for, and a vocabulary that grows for convenience is
 * a vocabulary that has stopped being closed.
 */
export const IntentName = z.enum([
  'reply_to_sender',
  'contact_counterparty',
  'schedule_meeting',
  'file_document',
  'record_entity',
  'record_preference',
  'pay_or_purchase',
  'flag_for_owner',
  'request_clarification',
  'no_action',
]);
export type IntentName = z.infer<typeof IntentName>;

/**
 * What each intent means, in the language the owner reads.
 *
 * Kept beside the enum and locked to it by a test: an intent added to the enum
 * without an explanation fails the build rather than reaching a prompt as a
 * bare identifier the model has to guess at.
 */
export const INTENT_MEANING: Record<IntentName, string> = {
  reply_to_sender: 'להשיב למי ששלח את זה',
  contact_counterparty: 'לפנות לגורם שנקוב בתוכן',
  schedule_meeting: 'לקבוע מועד',
  file_document: 'לתייק במקום שלו, בלי פעולה נוספת',
  record_entity: 'ישות חדשה הופיעה וכדאי לרשום אותה',
  record_preference: 'נאמרה כאן העדפה שכדאי לזכור',
  pay_or_purchase: 'כסף צריך לזוז',
  flag_for_owner: 'אדם חייב להסתכל על זה',
  request_clarification: 'הקריאה עצמה חסרה — צריך להשלים מידע',
  no_action: 'נקרא, ולא נדרש דבר',
};

/**
 * Where in the document a claim came from.
 *
 * `ordinal` addresses one of the document's own artefacts and is checked
 * against the artefacts that were actually rendered into the brief — see
 * `readingProblems`. A claim attributed to a part that does not exist is not a
 * report about the document.
 */
export const SourceRef = z.object({
  ordinal: z.number().int().nonnegative(),
  /** Where inside it, in the reader's words: "שורה 14", "סעיף 3". Advisory. */
  locator: z.string().nullable().default(null),
});
export type SourceRef = z.infer<typeof SourceRef>;

/**
 * One data point the reader drew out of the document.
 *
 * `value` is a string, deliberately, even when it reads as money or a date.
 * A typed `amountMinor` here would be a number a model invented that looks
 * exactly like a number the system measured — and no module under
 * `src/policy/` may read a finding at all. `reading-invariants.test.ts`
 * enforces that; this comment records why.
 */
export const Finding = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  sourceRef: SourceRef,
});
export type Finding = z.infer<typeof Finding>;

/**
 * Who an intent concerns.
 *
 * The three branches are the whole design: a counterparty already known to the
 * business, the job's own sender (resolved by the orchestrator from the job
 * record, never from the content), or an unresolved description. There is no
 * branch that carries an address, so a document can say that someone should be
 * contacted and can never say where the message goes.
 */
export const EntityRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entityId: SafeLookupKey.min(1) }),
  z.object({ kind: z.literal('sender') }),
  z.object({ kind: z.literal('unresolved'), describedAs: z.string().min(1) }),
]);
export type EntityRef = z.infer<typeof EntityRef>;

export const Intent = z.object({
  intent: IntentName,
  subject: EntityRef,
  sourceRef: SourceRef,
  note: z.string().default(''),
});
export type Intent = z.infer<typeof Intent>;

/**
 * The only shape a reading may take.
 *
 * `intents` is `.min(1)` and the registry carries `no_action`: an empty array
 * and "I read it and nothing follows" are different claims, and this codebase
 * separates them everywhere else — a missing `job_step_results` row is not
 * "nothing happened", an unreadable amount is not zero.
 */
export const Reading = z.object({
  summary: z.string().min(1),
  findings: z.array(Finding).default([]),
  intents: z.array(Intent).min(1),
  /** What the reader could not determine. An empty list is a claim, not an absence. */
  unreadable: z.array(z.string()).default([]),
});
export type Reading = z.infer<typeof Reading>;
