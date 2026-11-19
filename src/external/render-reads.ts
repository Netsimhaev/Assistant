/**
 * What an external read returned, rendered for the owner (WhatsApp report and
 * dashboard). Pure and deterministic: no model, no I/O.
 *
 * Every value and label is treated as a stranger's bytes even though it was
 * cleaned at store time (`toOneLine`): cleaned again here, defence in depth.
 * A value that is not a string (a malformed stored row) is stringified, never
 * thrown on. System and operation labels come from the owner-signed charter;
 * a system or operation no longer signed falls back to its own id, cleaned.
 *
 * Bounded twice, and never silently: a line cap and a character budget, each
 * cutting at whole lines and ending with a line that says how many FIELD
 * lines were left out. If not even one field fits the budget, the block is
 * the fixed "full result is on the dashboard" line.
 */
import type { ExternalSystem } from '../domain/external-system.js';
import { toOneLine } from '../util/bidi.js';
import type { ExternalReadRecord } from './store.js';

/** Total lines in the rendered block, the final cut line included. */
export const MAX_READ_LINES = 40;

/** The final line when field lines were left out. */
export function cutLine(omittedFields: number): string {
  return `… ועוד ${omittedFields} שורות שלא הוצגו`;
}

/** Sent when no field line fits the character budget. */
export const READS_ON_DASHBOARD_LINE = 'התוצאה המלאה מופיעה בדשבורד.';

type ReadForRender = Pick<ExternalReadRecord, 'systemId' | 'operation' | 'fields'>;

export interface RenderReadsOptions {
  /** Line cap including the cut line. Default `MAX_READ_LINES`. */
  maxLines?: number;
  /** Character budget for the whole block. Default unbounded. */
  maxChars?: number;
}

function text(value: unknown): string {
  if (typeof value === 'string') return toOneLine(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return toOneLine(JSON.stringify(value) ?? '');
    } catch {
      return '';
    }
  }
  return toOneLine(String(value));
}

/** The header line of one read: `מ<system> — <operation>:`. */
export function readHeader(read: ReadForRender, systems: readonly ExternalSystem[]): string {
  const system = systems.find((s) => s.id === read.systemId);
  const operation = system?.operations.find((o) => o.name === read.operation);
  return `מ${text(system?.label ?? read.systemId)} — ${text(operation?.label ?? read.operation)}:`;
}

interface Entry {
  line: string;
  field: boolean;
}

/**
 * `headers`, when given, replaces each read's header line (the dashboard adds
 * when it was read and whether its job finished); same length as `reads`.
 */
export function renderReadsForOwner(
  reads: readonly ReadForRender[],
  systems: readonly ExternalSystem[],
  options: RenderReadsOptions & { headers?: readonly string[] } = {},
): string {
  if (reads.length === 0) return '';
  const maxLines = options.maxLines ?? MAX_READ_LINES;
  const entries: Entry[] = [];
  reads.forEach((read, index) => {
    if (entries.length > 0) entries.push({ line: '', field: false });
    entries.push({ line: options.headers?.[index] ?? readHeader(read, systems), field: false });
    const fields = Array.isArray(read.fields) ? read.fields : [];
    for (const field of fields) {
      entries.push({ line: `${text(field?.label)}: ${text(field?.value)}`, field: true });
    }
  });
  const fieldTotal = entries.filter((e) => e.field).length;
  const joined = entries.map((e) => e.line).join('\n');
  if (entries.length <= maxLines && (options.maxChars === undefined || joined.length <= options.maxChars)) {
    return joined;
  }

  // Cut mode: leave room for the cut line, sized for the worst-case count.
  const reserve = cutLine(fieldTotal).length + 1;
  const lineBudget = maxLines - 1;
  const charBudget = (options.maxChars ?? Infinity) - reserve;
  const kept: Entry[] = [];
  let chars = 0;
  for (const entry of entries) {
    const cost = entry.line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length + 1 > lineBudget || chars + cost > charBudget) break;
    kept.push(entry);
    chars += cost;
  }
  // A trailing header or blank separator without its fields says nothing.
  while (kept.length > 0 && !kept[kept.length - 1]!.field) kept.pop();
  const shown = kept.filter((e) => e.field).length;
  if (shown === 0) return READS_ON_DASHBOARD_LINE;
  return [...kept.map((e) => e.line), cutLine(fieldTotal - shown)].join('\n');
}
