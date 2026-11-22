import type { PlanStep } from '../domain/plan.js';
import { actionClassLabel } from '../domain/labels.js';
import { ATTACHMENTS_KEY, AttachmentRef, formatAttachmentSize } from '../domain/attachment-ref.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { READ_ONLY_TOOLS, classifyAction, isOutbound, refineActionClass } from '../policy/classify.js';
import { markInvisibleControls, stripBidiControls } from '../util/bidi.js';
import { canonicalJson } from '../util/canonical.js';
import { formatMinor } from '../util/money.js';
import type { ExternalSystem } from '../domain/external-system.js';
import { buildExternalRequestFromPayload } from '../external/request.js';
import { isExternalTool, resolveExternalCall } from '../policy/external-class.js';
import { redactPayload } from '../policy/redact.js';
import { localParts } from '../util/local-time.js';
import { parseIsoInstant } from '../util/send-at.js';

/**
 * The Hebrew confirmation question (boss command, spec §4.1, §4.2, §10.5, §10.6).
 *
 * Pure: no DB. The question shows EVERY field of EVERY side-effecting step in
 * full — there is no truncation anywhere, because a byte the owner approved
 * without seeing is a byte the owner did not approve. The only limit is a
 * refusal: a step too long to show whole is refused, never shortened.
 */

export const MAX_ECHO_CHARS_PER_STEP = 4000;
export const CONFIRM_HINT = 'השיבי "כן" לאישור, או "לא" לביטול.';
export const CHOICE_HINT = 'השיבי במספר או בשם — וזה גם האישור. "לא" לביטול.';
export const REASK_PREFIX = 'ייתכן שזה כבר בוצע — לבצע שוב?';

/** The line a re-ask shows when some steps already completed and will not run again (spec §10.3). */
export function alreadyDoneLine(count: number): string {
  return count === 1
    ? 'כבר בוצע: צעד אחד — הוא לא יבוצע שוב.'
    : `כבר בוצע: ${count} צעדים — הם לא יבוצעו שוב.`;
}

const TOO_LONG = 'הפעולה ארוכה מכדי להציג אותה בשאלה אחת — נסח/י את ההוראה בקצרה יותר.';
const CHOICE_HEADER = 'למי התכוונת?';
const SOURCE_BOSS = '(מהזיכרון — נאמר על ידך)';
const SOURCE_UNVERIFIED = '(מהזיכרון — נלמד ממסמך/מייל — לא אומת)';

/** Known fields, in display order. Everything else follows, sorted. */
const KNOWN_FIELDS: readonly { key: string; name: string }[] = [
  { key: 'to', name: 'אל' },
  { key: 'subject', name: 'נושא' },
  { key: 'body', name: 'תוכן' },
  { key: 'amountMinor', name: 'סכום' },
  { key: 'inReplyTo', name: 'בתשובה ל' },
  // calendar.write (calendar scheduling, Task 10). Values are still shown whole.
  { key: 'operation', name: 'פעולה' },
  { key: 'calendarId', name: 'יומן' },
  { key: 'eventId', name: 'אירוע' },
  { key: 'holdEventId', name: 'שמירת מקום' },
  { key: 'title', name: 'כותרת' },
  { key: 'start', name: 'התחלה' },
  { key: 'end', name: 'סיום' },
  { key: 'location', name: 'מיקום' },
  { key: 'description', name: 'פרטים ללקוח' },
  { key: 'attendees', name: 'משתתפים' },
  // wa.send_message (owner-ordered WhatsApp, task 13): when it will be sent.
  { key: 'sendAt', name: 'בשעה' },
];
/** Multi-line known fields: every continuation line carries the fixed margin. */
const BLOCK_KEYS: ReadonlySet<string> = new Set(['body', 'description']);
const KNOWN_KEYS = new Set(KNOWN_FIELDS.map((f) => f.key));

/** Fixed margin on every continuation line of a multi-line value. */
const CONTINUATION_MARGIN = '    │ ';
/**
 * The one positive set of line breaks: CRLF, CR, LF, VT, FF, FS/GS/RS, NEL,
 * LS and PS. Many renderers treat VT, FF and FS-RS as breaks, so all of them
 * split a body and collapse inline. Every other control is marked, not removed.
 */
const LINE_BREAKS = /\r\n|[\r\n\u000B\u000C\u001C\u001D\u001E\u0085\u2028\u2029]/g;
/** A padding run that could wrap a forged line to the start of a visual line. */
const WHITESPACE_RUN = /\s{2,}/g;

/** Display only (the bytes stay as they are): a whitespace run becomes one space. */
function squeeze(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ');
}

/** One line: every line break becomes a single space. */
function inline(text: string): string {
  return squeeze(text.replace(LINE_BREAKS, ' '));
}

/** A value on one line, invisible controls shown as visible markers. */
function inlineValue(text: string): string {
  return markInvisibleControls(inline(text));
}

/** An option label: bidi controls stripped first, then whatever is left marked. */
function labelText(label: string): string {
  return markInvisibleControls(inline(stripBidiControls(label)));
}

/**
 * A multi-line value (the body). Every line after the first carries the fixed
 * margin, so no line of a value can start at column 0 and pass for a line of
 * the question itself (a forged option, an `אל:` line, a fake hint).
 */
function blockValue(text: string): string {
  return text
    .split(LINE_BREAKS)
    .map((line) => markInvisibleControls(squeeze(line)))
    .join('\n' + CONTINUATION_MARGIN);
}

function structured(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return JSON.stringify(value) ?? String(value);
  }
}

function renderScalar(value: unknown): string {
  if (typeof value === 'string') return inlineValue(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return inlineValue(structured(value));
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((element) => renderScalar(element)).join(', ');
  }
  return renderScalar(value);
}

/**
 * What the WhatsApp echo needs beyond the step itself (task 13): the charter's
 * timezone, so `sendAt` reads as the owner's wall clock, and where the
 * recipient came from — a saved contact or a number typed in the instruction.
 * The caller resolves the source (it holds the contacts and the instruction);
 * this module stays pure.
 */
export interface WhatsAppEchoContext {
  timeZone: string;
  /** The source note for a `wa.send_message` recipient, or null when it has none. */
  recipientNote: (to: string) => string | null;
}

/** `sendAt` in the charter timezone, `DD/MM/YYYY HH:MM`; the raw value when it does not parse. */
function renderSendAt(value: unknown, wa: WhatsAppEchoContext | undefined): string {
  const at = parseIsoInstant(value);
  if (at === null || wa === undefined) return renderValue(value);
  const { date, time } = localParts(at, wa.timeZone);
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y} ${time}`;
}

function renderKnown(key: string, value: unknown, currency: string): string {
  if (key === 'amountMinor' && typeof value === 'number' && Number.isSafeInteger(value)) {
    return formatMinor(value, currency);
  }
  if (BLOCK_KEYS.has(key) && typeof value === 'string') return blockValue(value);
  return renderValue(value);
}

const UNCLASSIFIED_LABEL = 'פעולה ללא סיווג';
const ATTACHMENT_LABEL = 'קובץ מצורף';
const ATTACHMENT_INVALID_LABEL = 'קובץ מצורף (לא תקין)';

/**
 * One line per attached file: `קובץ מצורף: <filename> · <size> · <sha12>` —
 * never the raw ref as a "שדה נוסף" (document production §8.2). The size is
 * the ref's claim, which the resolver checks against the version row and the
 * file before anything is sent. An element that is not a valid ref is shown
 * in full, marked invalid (the send refuses it anyway); nothing is hidden.
 */
function attachmentLines(value: unknown): string[] {
  const elements = Array.isArray(value) ? value : [value];
  return elements.map((element) => {
    const ref = AttachmentRef.safeParse(element);
    if (!ref.success) return `${ATTACHMENT_INVALID_LABEL}: ${renderScalar(element)}`;
    const { filename, sizeBytes, sha256 } = ref.data;
    return `${ATTACHMENT_LABEL}: ${inlineValue(filename)} · ${formatAttachmentSize(sizeBytes)} · ${sha256.slice(0, 12)}`;
  });
}

/** Hidden only when positively known harmless: read-only AND not outbound. */
function isHidden(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName) && !isOutbound(toolName);
}

/**
 * The idempotency key handed to the request builder for the echo's URL line.
 * The key only ever reaches a header, never the URL, and the echo shows no
 * header — so any fixed value builds the exact URL that will be sent.
 */
const ECHO_IDEMPOTENCY_KEY = 'echo';
const UNRESOLVED_EXTERNAL_LABEL = 'פעולה במערכת חיצונית שלא נחתמה';
const UNBUILDABLE_EXTERNAL = 'אי אפשר להציג את הבקשה למערכת החיצונית';
/** The payload keys an `ext.*` echo shows in structured form, once. */
const EXTERNAL_KEYS: ReadonlySet<string> = new Set(['system', 'operation', 'params', 'amountMinor']);

/**
 * Why an `ext.*` step cannot be shown whole, or null when it can (or is not an
 * `ext.*` step). An unresolved operation or a request the builder refuses is
 * never echoed partially: the question is refused instead, quoting the
 * builder's own Hebrew sentence.
 */
export function externalEchoProblem(step: PlanStep, systems: readonly ExternalSystem[]): string | null {
  if (!isExternalTool(step.toolName)) return null;
  const resolved = resolveExternalCall(systems, step.toolName, step.input);
  if (!resolved.ok) return `${UNBUILDABLE_EXTERNAL}: הפעולה אינה פעולה שנחתמה בתקנון.`;
  const built = buildExternalRequestFromPayload(resolved.system, resolved.op, step.input, ECHO_IDEMPOTENCY_KEY);
  return built.ok ? null : `${UNBUILDABLE_EXTERNAL}: ${built.message}`;
}

/** Shown under the URL line: the URL is percent-encoded, the param lines are not. */
export const EXTERNAL_PARAMS_DECODED_NOTE = '(הפרמטרים שלמטה מוצגים כערכים המפוענחים, לפני קידוד הכתובת)';

/** The refusal when an `ext.*` step carries a value the charter redacts (ruling T7-b). */
export const EXTERNAL_REDACTED_HE =
  'בקשה למערכת חיצונית כוללת ערך שהתקנון מסתיר (למשל מספר טלפון או חשבון), ולכן לא תישלח — ערוך את כללי ההסתרה או את הבקשה.';

function canonicalOrNull(value: unknown): string | null {
  try {
    return canonicalJson(value ?? null);
  } catch {
    return null;
  }
}

/**
 * Ruling T7-b, layer (a). `ext.*` are outbound tools, so every `allow` hands
 * the adapter `redactPayload(input, bundle)`: a param value matching a charter
 * redaction pattern would reach the third-party system as the marker in place
 * of the value the owner approved — the owner approves X and Y runs. Such a
 * step is refused instead, with the same redaction function the gate applies.
 * Null when the step is fine (or is not an `ext.*` step). A pattern that does
 * not compile — a bundle that bypassed the charter schema — refuses too.
 */
export function externalRedactionProblem(step: PlanStep, redactPatterns: readonly string[]): string | null {
  if (!isExternalTool(step.toolName)) return null;
  let redacted: unknown;
  try {
    redacted = redactPayload(step.input, { redactPatterns: [...redactPatterns] });
  } catch {
    return EXTERNAL_REDACTED_HE;
  }
  const after = redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : {};
  // `system` and `operation` too: a pattern matching a system or operation
  // name would make the adapter resolve the marker instead of the signed
  // name, and the step would fail only after the owner's "כן".
  for (const key of ['system', 'operation', 'params', 'amountMinor'] as const) {
    const before = canonicalOrNull(step.input[key]);
    const now = canonicalOrNull(after[key]);
    if (before === null || before !== now) return EXTERNAL_REDACTED_HE;
  }
  return null;
}

/**
 * The echo of a resolved `ext.*` step whose request builds: the operation's
 * label, the SIGNED class (never the `TOOL_ACTION_CLASS` placeholder), the
 * tool, the system, the exact method and URL the adapter will send, each param
 * on its own line and the amount. Null when the step does not resolve or its
 * request cannot be built — the caller then falls back to showing every field
 * as it is, and the question refuses it (`externalEchoProblem`).
 */
function externalEcho(step: PlanStep, currency: string, systems: readonly ExternalSystem[]): string | null {
  const resolved = resolveExternalCall(systems, step.toolName, step.input);
  if (!resolved.ok) return null;
  const { system, op } = resolved;
  const built = buildExternalRequestFromPayload(system, op, step.input, ECHO_IDEMPOTENCY_KEY);
  if (!built.ok) return null;

  const lines: string[] = [
    labelText(op.label),
    `סוג פעולה: ${actionClassLabel(resolved.actionClass)}`,
    `כלי: ${inlineValue(step.toolName)}`,
    `מערכת: ${labelText(system.label)} (${inlineValue(system.id)})`,
    `שיטה וכתובת: ${built.method} ${inlineValue(built.url.href)}`,
    EXTERNAL_PARAMS_DECODED_NOTE,
  ];
  const params = step.input['params'];
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    // Declared order; the builder already refused any undeclared key.
    for (const param of op.params) {
      if (!Object.hasOwn(record, param.name)) continue;
      lines.push(`פרמטר ${inlineValue(param.name)}: ${renderValue(record[param.name])}`);
    }
  }
  if (Object.hasOwn(step.input, 'amountMinor')) {
    lines.push(`סכום: ${renderKnown('amountMinor', step.input['amountMinor'], currency)}`);
  }
  const extras = Object.keys(step.input)
    .filter((key) => !EXTERNAL_KEYS.has(key))
    .sort();
  for (const key of extras) {
    lines.push(`שדה נוסף: ${inlineValue(key)} = ${renderValue(step.input[key])}`);
  }
  return lines.join('\n');
}

/**
 * The echo of one step; empty string only for a positively read-only step.
 *
 * `currency` is the active charter's (`bundle.ceilings.currency`), required
 * and with no default: an amount shown in a currency the charter does not
 * keep is an amount the owner did not see. `systems` is the active charter's
 * signed external systems (`bundle.externalSystems`), required for the same
 * reason: an `ext.*` step is labelled by the class the owner signed and shows
 * the exact request the adapter will build — never the placeholder class.
 */
export function renderStepEcho(
  step: PlanStep,
  currency: string,
  systems: readonly ExternalSystem[],
  wa?: WhatsAppEchoContext,
): string {
  if (isHidden(step.toolName)) return '';
  if (isExternalTool(step.toolName)) {
    const echo = externalEcho(step, currency, systems);
    if (echo !== null) return echo;
  }
  const base = classifyAction(step.toolName);
  const label = isExternalTool(step.toolName)
    ? UNRESOLVED_EXTERNAL_LABEL
    : base === null
      ? UNCLASSIFIED_LABEL
      : actionClassLabel(refineActionClass(base, step.input));
  const lines: string[] = [label, `כלי: ${inlineValue(step.toolName)}`];

  const whatsapp = step.toolName === 'wa.send_message';
  for (const { key, name } of KNOWN_FIELDS) {
    if (!Object.hasOwn(step.input, key)) continue;
    const value = step.input[key];
    if (whatsapp && key === 'sendAt') {
      lines.push(`${name}: ${renderSendAt(value, wa)}`);
      continue;
    }
    const note = whatsapp && key === 'to' && typeof value === 'string' ? (wa?.recipientNote(value) ?? null) : null;
    lines.push(`${name}: ${renderKnown(key, value, currency)}${note === null ? '' : ` ${labelText(note)}`}`);
  }
  if (Object.hasOwn(step.input, ATTACHMENTS_KEY)) {
    lines.push(...attachmentLines(step.input[ATTACHMENTS_KEY]));
  }
  const extras = Object.keys(step.input)
    .filter((key) => !KNOWN_KEYS.has(key) && key !== ATTACHMENTS_KEY)
    .sort();
  for (const key of extras) {
    lines.push(`שדה נוסף: ${inlineValue(key)} = ${renderValue(step.input[key])}`);
  }
  return lines.join('\n');
}

function sourceMarker(option: ConfirmationOption): string {
  if (option.contactSource === 'boss') return ` ${SOURCE_BOSS}`;
  if (option.contactSource === 'unverified') return ` ${SOURCE_UNVERIFIED}`;
  return '';
}

/** Echoes of an option's side-effecting steps, or the refusal if one is too long. */
function optionEchoes(
  option: ConfirmationOption,
  currency: string,
  systems: readonly ExternalSystem[],
  redactPatterns: readonly string[],
  wa: WhatsAppEchoContext | undefined,
): string[] | { refused: string } {
  const echoes: string[] = [];
  for (const step of option.plan.steps) {
    const problem = externalEchoProblem(step, systems);
    if (problem !== null) return { refused: problem };
    const redaction = externalRedactionProblem(step, redactPatterns);
    if (redaction !== null) return { refused: redaction };
    const echo = renderStepEcho(step, currency, systems, wa);
    if (echo === '') continue;
    if (echo.length > MAX_ECHO_CHARS_PER_STEP) return { refused: TOO_LONG };
    echoes.push(echo);
  }
  return echoes;
}

export function renderConfirmationQuestion(
  options: ConfirmationOption[],
  opts: {
    /** The active charter's currency (`bundle.ceilings.currency`) — every amount is shown in it. */
    currency: string;
    /** The active charter's signed external systems (`bundle.externalSystems`) — required, never defaulted. */
    systems: readonly ExternalSystem[];
    /** The active charter's redaction patterns (`bundle.redactPatterns`) — required: an `ext.*` value they hide is refused (T7-b). */
    redactPatterns: readonly string[];
    /**
     * The WhatsApp echo context (charter timezone, recipient source). Every
     * production caller passes it; absent, `sendAt` is shown as stored and
     * the recipient without a source note.
     */
    whatsapp?: WhatsAppEchoContext;
    reask?: boolean;
    /** Steps of the original plan that completed and were dropped from this one; shown when > 0. */
    alreadyDone?: number;
    /**
     * Per option (same order), an extra block shown right under the option's
     * label and above its step echoes, or null. Two producers today: what an
     * option's ledger steps will record (`ledgerEchoForSteps` — `renderStepEcho`
     * hides read-only steps, and the ledger tools are read-only, so without
     * this the owner would confirm a mixed plan without seeing what it writes
     * to his ledger, T6), and a meeting plan's summary (`renderMeetingSummary`).
     * An addition, never a replacement: every step echo is still rendered.
     */
    extraEchoes?: readonly (string | null)[];
  },
): { text: string } | { refused: string } {
  const multiple = options.length > 1;
  const rendered: string[] = [];
  for (const [index, option] of options.entries()) {
    const echoes = optionEchoes(option, opts.currency, opts.systems, opts.redactPatterns, opts.whatsapp);
    if (!Array.isArray(echoes)) return echoes;
    const head = `${multiple ? `${index + 1}. ` : ''}${labelText(option.label)}${sourceMarker(option)}`;
    const extra = opts.extraEchoes?.[index] ?? null;
    rendered.push([head, ...(extra === null ? [] : [extra]), ...echoes].join('\n'));
  }

  const parts: string[] = [];
  if (opts.reask === true) parts.push(REASK_PREFIX);
  if (opts.alreadyDone !== undefined && opts.alreadyDone > 0) parts.push(alreadyDoneLine(opts.alreadyDone));
  if (multiple) parts.push(CHOICE_HEADER);
  parts.push(rendered.join('\n\n'));
  parts.push(multiple ? CHOICE_HINT : CONFIRM_HINT);
  return { text: parts.join('\n\n') };
}
