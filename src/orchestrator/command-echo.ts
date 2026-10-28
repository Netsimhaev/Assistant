import type { PlanStep } from '../domain/plan.js';
import { actionClassLabel } from '../domain/labels.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { classifyAction, refineActionClass } from '../policy/classify.js';
import { stripBidiControls } from '../util/bidi.js';
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

function renderScalar(value: unknown): string {
  if (typeof value === 'string') return stripBidiControls(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return stripBidiControls(JSON.stringify(value) ?? String(value));
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((element) => renderScalar(element)).join(', ');
  }
  return renderScalar(value);
}

function renderKnown(key: string, value: unknown): string {
  if (key === 'amountMinor' && typeof value === 'number' && Number.isSafeInteger(value)) {
    return formatMinor(value, 'ILS');
  }
  return renderValue(value);
}

/** The echo of one side-effecting step; empty string for a read-only step. */
export function renderStepEcho(step: PlanStep): string {
  const base = classifyAction(step.toolName);
  if (base === null) return '';
  const refined = refineActionClass(base, step.input);
  const lines: string[] = [actionClassLabel(refined)];

  for (const { key, name } of KNOWN_FIELDS) {
    if (!Object.hasOwn(step.input, key)) continue;
    lines.push(`${name}: ${renderKnown(key, step.input[key])}`);
  }
  const extras = Object.keys(step.input)
    .filter((key) => !KNOWN_KEYS.has(key))
    .sort();
  for (const key of extras) {
    lines.push(`שדה נוסף: ${stripBidiControls(key)} = ${renderValue(step.input[key])}`);
  }
  return lines.join('\n');
}

function sourceMarker(option: ConfirmationOption): string {
  if (option.contactSource === 'boss') return ` ${SOURCE_BOSS}`;
  if (option.contactSource === 'unverified') return ` ${SOURCE_UNVERIFIED}`;
  return '';
}

/** Echoes of an option's side-effecting steps, or the refusal if one is too long. */
function optionEchoes(option: ConfirmationOption): string[] | { refused: string } {
  const echoes: string[] = [];
  for (const step of option.plan.steps) {
    const echo = renderStepEcho(step);
    if (echo === '') continue;
    if (echo.length > MAX_ECHO_CHARS_PER_STEP) return { refused: TOO_LONG };
    echoes.push(echo);
  }
  return echoes;
}

export function renderConfirmationQuestion(
  options: ConfirmationOption[],
  opts?: { reask?: boolean },
): { text: string } | { refused: string } {
  const multiple = options.length > 1;
  const rendered: string[] = [];
  for (const [index, option] of options.entries()) {
    const echoes = optionEchoes(option);
    if (!Array.isArray(echoes)) return echoes;
    const head = `${multiple ? `${index + 1}. ` : ''}${stripBidiControls(option.label)}${sourceMarker(option)}`;
    rendered.push([head, ...echoes].join('\n'));
  }

  const parts: string[] = [];
  if (opts?.reask === true) parts.push(REASK_PREFIX);
  if (multiple) parts.push(CHOICE_HEADER);
  parts.push(rendered.join('\n\n'));
  parts.push(multiple ? CHOICE_HINT : CONFIRM_HINT);
  return { text: parts.join('\n\n') };
}
