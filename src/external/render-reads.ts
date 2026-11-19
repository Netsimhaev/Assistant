/**
 * What an external read returned, rendered for the owner (WhatsApp report and
 * dashboard). Pure and deterministic: no model, no I/O.
 *
 * Every value and label is treated as a stranger's bytes even though it was
 * cleaned at store time (`toOneLine`): cleaned again here, defence in depth.
 * System and operation labels come from the owner-signed charter; a system or
 * operation no longer signed falls back to its own id, cleaned.
 */
import type { ExternalSystem } from '../domain/external-system.js';
import { toOneLine } from '../util/bidi.js';
import type { ExternalReadRecord } from './store.js';

/** Total lines in the rendered block, the final cut line included. */
export const MAX_READ_LINES = 40;

/** The final line when fields were left out. */
export function cutLine(omitted: number): string {
  return `… ועוד ${omitted} שורות שלא הוצגו`;
}

type ReadForRender = Pick<ExternalReadRecord, 'systemId' | 'operation' | 'fields'>;

export function renderReadsForOwner(
  reads: readonly ReadForRender[],
  systems: readonly ExternalSystem[],
): string {
  if (reads.length === 0) return '';
  const lines: string[] = [];
  for (const read of reads) {
    const system = systems.find((s) => s.id === read.systemId);
    const operation = system?.operations.find((o) => o.name === read.operation);
    const systemLabel = toOneLine(system?.label ?? read.systemId);
    const operationLabel = toOneLine(operation?.label ?? read.operation);
    if (lines.length > 0) lines.push('');
    lines.push(`מ${systemLabel} — ${operationLabel}:`);
    for (const field of read.fields) {
      lines.push(`${toOneLine(field.label)}: ${toOneLine(field.value)}`);
    }
  }
  if (lines.length <= MAX_READ_LINES) return lines.join('\n');
  // Keep room for the cut line, whose count is what was actually dropped.
  const kept = lines.slice(0, MAX_READ_LINES - 1);
  const omitted = lines.length - kept.length;
  return [...kept, cutLine(omitted)].join('\n');
}
