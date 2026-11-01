/**
 * What the setup interview decides for the owner without asking (spec §7).
 *
 * Every value here is copied from `buildCharter()` in `src/test/fixtures.ts`
 * — the charter the whole suite, and every gate invariant, is written
 * against — except where the spec says otherwise (`subprocessorsAllowed`
 * starts at `anthropic` only; the meeting defaults are the schema's own).
 * Copied, not imported: production code does not depend on a test fixture,
 * and a fixture edit must not silently change what a real owner signs.
 *
 * Each default has a Hebrew line in `DEFAULTS_CHOSEN_HE`, shown on the
 * summary page under "what I decided for you without asking".
 */
import type { ActionClass } from '../../domain/action.js';
import { CharterOperations, type CharterData, type ForbiddenRule } from '../../domain/charter.js';
import type { AutonomyLevel, TrustLevel } from '../../domain/trust.js';
import type { z } from 'zod';
import type { InterviewRow } from './rows.js';

/**
 * The base autonomy of every class the interview table does not show. The
 * key type is exhaustive over `ActionClass` minus the rows, so a new class
 * is a compile error here until someone decides its value.
 *
 * Why each value (spec §7, last bullet):
 * - `payment.make` `approve_required`, and also forbidden by
 *   `no_payments_to_new_payees` below; no agent owns `payment.charge`, so the
 *   capability layer refuses it first anyway.
 * - `artifact.write` `auto`: producing a file is internal work; the control
 *   is the path scope and the audit row. Its only tools (`file.write`,
 *   `code_execution`) are owned by no agent or are local.
 * - `browser.interact` `auto`: the gating comes from the provenance ceiling
 *   above it — a chain that read an untrusted page is `open_web`, so
 *   `draft_only`. A click carrying an amount refines to `purchase.place`.
 * - `browser.session` `approve_required`: handing over a live session is not
 *   ordinary work.
 * - `contract.sign` `forbidden`, plus `no_contract_signing`: no agent owns
 *   the tool; signing is an outcome of the owner's approval, never a tool.
 * - `data.export` `approve_required`, plus `no_customer_data_export`, which
 *   is genuinely enforced (`ops.systems` owns the tool).
 * - `memory.write_longterm` `auto`: internal; the provenance ceiling still
 *   holds an `unknown_external` chain at `draft_only`.
 * - `charter.amend` `draft_only`: the assistant may propose, only the owner
 *   signs.
 * - `agent.delegate` `auto`: carries no outbound authority of its own; the
 *   child job faces its own ceiling (`CEILING_EXEMPT_TOOLS`).
 */
export const FIXED_BASE: Record<Exclude<ActionClass, InterviewRow>, AutonomyLevel> = {
  'payment.make': 'approve_required',
  'artifact.write': 'auto',
  'browser.interact': 'auto',
  'browser.session': 'approve_required',
  'contract.sign': 'forbidden',
  'data.export': 'approve_required',
  'memory.write_longterm': 'auto',
  'charter.amend': 'draft_only',
  'agent.delegate': 'auto',
};

/**
 * Content from anyone but the owner or staff never acts without approval:
 * `known_counterparty` asks, `unknown_external` and `open_web` only draft.
 */
export const INTERVIEW_PROVENANCE_CEILING: Record<TrustLevel, AutonomyLevel> = {
  boss: 'auto',
  staff: 'auto_notify',
  known_counterparty: 'approve_required',
  unknown_external: 'draft_only',
  open_web: 'draft_only',
};

/** The three standing prohibitions every charter carries; ids as in the fixture. */
export const FIXED_FORBIDDEN: readonly ForbiddenRule[] = [
  {
    id: 'no_customer_data_export',
    description: 'לעולם לא לייצא נתוני לקוחות אל מחוץ למערכת.',
    actionClasses: ['data.export'],
  },
  {
    id: 'no_contract_signing',
    description: 'לעולם לא לחתום על חוזה או מסמך מחייב.',
    actionClasses: ['contract.sign'],
  },
  {
    id: 'no_payments_to_new_payees',
    description: 'לא לבצע תשלום לנמען שאינו ספק מאושר.',
    actionClasses: ['payment.make'],
  },
];

/**
 * Retention, redaction and external sharing as in the fixture, checked to be
 * the strict reading: customer PII kept two years and financial records seven
 * (the Israeli bookkeeping period), nine-digit runs (an ID number) redacted
 * before anything leaves, and health, legal and credentials never shared.
 * `anthropic` is always a subprocessor because the model runs there; a
 * mailbox provider is added only when the owner chooses one.
 */
export const DATA_DEFAULTS: z.infer<typeof CharterData> = {
  retentionDays: { customer_pii: 730, financial: 2555 },
  redactBeforeSending: ['\\b\\d{9}\\b'],
  mayShareExternally: { health: 'never', legal: 'never', credentials: 'never' },
  subprocessorsAllowed: ['anthropic'],
};

/** The schema's own defaults, read from the schema rather than restated. */
export const MEETING_DEFAULTS = CharterOperations.shape.meetingDefaults.parse({});

export const DEFAULT_CURRENCY = 'ILS';
export const DEFAULT_LANGUAGES: readonly string[] = ['he'];

/** One plain-Hebrew line per default above, for the summary page. */
export const DEFAULTS_CHOSEN_HE: readonly string[] = [
  'תוכן שמגיע ממייל או ממסמך של מישהו אחר לעולם לא יגרום לי לפעול בלי אישורך.',
  'אני מדברת עברית, בתשובות באורך רגיל, והסכומים בשקלים.',
  'המידע שאני קוראת עובר דרך Anthropic (ודרך Google או Microsoft אם חיברת תיבת מייל).',
  'לעולם לא אייצא נתוני לקוחות, לא אחתום על חוזה, ולא אשלם לנמען שאינו ספק מאושר.',
  'פרטים אישיים של לקוחות נשמרים עד שנתיים ורישומים כספיים עד שבע שנים.',
  'מספר בן תשע ספרות (כמו תעודת זהות) מושחר לפני שמשהו יוצא החוצה, ומידע רפואי, משפטי או סיסמאות לעולם לא נמסר.',
  'פגישה נקבעת כברירת מחדל לחצי שעה, עד שמונה פגישות ביום.',
  'יצירת קבצים, רישום בזיכרון ובקשת עזרה מסוכן אחר הם עבודה פנימית שאני עושה בלי לשאול. שינוי הכללים — רק כהצעה שאתה חותם עליה.',
];
