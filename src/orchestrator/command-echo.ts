import type { PlanStep } from '../domain/plan.js';
import { actionClassLabel } from '../domain/labels.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { READ_ONLY_TOOLS, classifyAction, isOutbound, refineActionClass } from '../policy/classify.js';
import { markInvisibleControls, stripBidiControls } from '../util/bidi.js';
import { canonicalJson } from '../util/canonical.js';
import { formatMinor } from '../util/money.js';

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
];
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

function renderKnown(key: string, value: unknown, currency: string): string {
  if (key === 'amountMinor' && typeof value === 'number' && Number.isSafeInteger(value)) {
    return formatMinor(value, currency);
  }
  if (key === 'body' && typeof value === 'string') return blockValue(value);
  return renderValue(value);
}

const UNCLASSIFIED_LABEL = 'פעולה ללא סיווג';

/** Hidden only when positively known harmless: read-only AND not outbound. */
function isHidden(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName) && !isOutbound(toolName);
}

/**
 * The echo of one step; empty string only for a positively read-only step.
 *
 * `currency` is the active charter's (`bundle.ceilings.currency`), required
 * and with no default: an amount shown in a currency the charter does not
 * keep is an amount the owner did not see.
 */
export function renderStepEcho(step: PlanStep, currency: string): string {
  if (isHidden(step.toolName)) return '';
  const base = classifyAction(step.toolName);
  const label = base === null ? UNCLASSIFIED_LABEL : actionClassLabel(refineActionClass(base, step.input));
  const lines: string[] = [label, `כלי: ${inlineValue(step.toolName)}`];

  for (const { key, name } of KNOWN_FIELDS) {
    if (!Object.hasOwn(step.input, key)) continue;
    lines.push(`${name}: ${renderKnown(key, step.input[key], currency)}`);
  }
  const extras = Object.keys(step.input)
    .filter((key) => !KNOWN_KEYS.has(key))
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
function optionEchoes(option: ConfirmationOption, currency: string): string[] | { refused: string } {
  const echoes: string[] = [];
  for (const step of option.plan.steps) {
    const echo = renderStepEcho(step, currency);
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
    reask?: boolean;
    /** Steps of the original plan that completed and were dropped from this one; shown when > 0. */
    alreadyDone?: number;
  },
): { text: string } | { refused: string } {
  const multiple = options.length > 1;
  const rendered: string[] = [];
  for (const [index, option] of options.entries()) {
    const echoes = optionEchoes(option, opts.currency);
    if (!Array.isArray(echoes)) return echoes;
    const head = `${multiple ? `${index + 1}. ` : ''}${labelText(option.label)}${sourceMarker(option)}`;
    rendered.push([head, ...echoes].join('\n'));
  }

  const parts: string[] = [];
  if (opts.reask === true) parts.push(REASK_PREFIX);
  if (opts.alreadyDone !== undefined && opts.alreadyDone > 0) parts.push(alreadyDoneLine(opts.alreadyDone));
  if (multiple) parts.push(CHOICE_HEADER);
  parts.push(rendered.join('\n\n'));
  parts.push(multiple ? CHOICE_HINT : CONFIRM_HINT);
  return { text: parts.join('\n\n') };
}
