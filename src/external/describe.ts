/**
 * A definition in plain Hebrew: one line per operation, then one for the
 * webhook and one for the scan. The technician's preview in the panel uses it
 * (Task 9); the owner's sign page builds on it (Task 10).
 *
 * Everything it prints comes from the definition the technician typed —
 * labels, event labels, hours — never from anything a system returned.
 */
import type { ExternalSystem } from '../domain/external-system.js';
import { externalOperationKindLabel } from '../domain/labels.js';

/** `<label> (<kind label>)`, with money operations marked as always asking. */
export function describeOperation(op: ExternalSystem['operations'][number]): string {
  const base = `${op.label} (${externalOperationKindLabel[op.kind]})`;
  return op.kind === 'money' ? `${base} — רק אחרי "כן" של בעל העסק` : base;
}

export function describeExternalSystem(def: ExternalSystem): string[] {
  const lines = def.operations.map(describeOperation);
  if (def.webhook !== null) {
    const events = def.webhook.events.map((e) => e.label);
    lines.push(
      events.length === 0
        ? 'התראות נכנסות (webhook): בלי אירועים מוגדרים'
        : `התראות נכנסות (webhook): ${events.join(', ')}`,
    );
  }
  if (def.scan !== null) {
    const op = def.operations.find((o) => o.name === def.scan?.operation);
    lines.push(`סריקה כל ${def.scan.everyHours} שעות: ${op?.label ?? def.scan.operation}`);
  }
  return lines;
}
