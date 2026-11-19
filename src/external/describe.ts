/**
 * A definition in plain Hebrew: one line per operation, then one for the
 * webhook and one for the scan. Two audiences, one helper:
 *
 * - the technician's preview in the panel (Task 9) — `describeForTechnician`;
 * - the owner's sign page (Task 10) — `describeExternalSystem`, which speaks to
 *   the owner ("העוזרת תוכל: …", "רק אחרי "כן" שלך") and states the scan in
 *   words. That scan sentence is what authorises the scan (plan ruling 9): the
 *   owner signs that it reads automatically at the signed interval, without
 *   asking each time.
 *
 * Everything it prints comes from the definition the technician typed —
 * labels, event labels, hours — never from anything a system returned. The
 * strings are plain text; the page escapes them (`escLabel`).
 */
import type { ExternalSystem } from '../domain/external-system.js';
import { externalOperationKindLabel } from '../domain/labels.js';

type Operation = ExternalSystem['operations'][number];
type Audience = 'technician' | 'owner';

function operationLine(op: Operation, audience: Audience, currency: string | null): string {
  const base = `${op.label} (${externalOperationKindLabel[op.kind]})`;
  if (audience === 'technician') return op.kind === 'money' ? `${base} — רק אחרי "כן" של בעל העסק` : base;
  let line = `העוזרת תוכל: ${base}`;
  if (op.kind === 'money') {
    line += ' — רק אחרי "כן" שלך';
    if (op.amount !== null && currency !== null && op.amount.currency !== currency) {
      line += ` (במטבע ${op.amount.currency}, שאינו מטבע העסק ${currency})`;
    }
  }
  return line;
}

/** Shown when some event declares no id field: deliveries are deduplicated on the declared fields. */
export const WEBHOOK_DEDUP_HINT = 'אם אין לאירוע שדה מזהה, שתי התראות זהות יישמרו כאחת';

/** A field path whose last segment is `id` or ends in `_id` — positive and simple. */
function isIdPath(path: string): boolean {
  const last = path.split('.').at(-1) ?? '';
  return last === 'id' || last.endsWith('_id');
}

function describe(def: ExternalSystem, audience: Audience, currency: string | null): string[] {
  const lines = def.operations.map((op) => operationLine(op, audience, currency));
  if (def.webhook !== null) {
    const events = def.webhook.events.map((e) => e.label);
    if (audience === 'technician') {
      lines.push(
        events.length === 0
          ? 'התראות נכנסות (webhook): בלי אירועים מוגדרים'
          : `התראות נכנסות (webhook): ${events.join(', ')}`,
      );
    } else {
      lines.push(
        events.length === 0
          ? 'התראות נכנסות (webhook): המערכת תוכל לשלוח לעוזרת התראות, בלי אירועים מוגדרים'
          : `התראות נכנסות (webhook): המערכת תוכל לשלוח לעוזרת התראות על: ${events.join(', ')}`,
      );
    }
    if (def.webhook.events.some((e) => !e.fields.some((f) => isIdPath(f.path)))) lines.push(WEBHOOK_DEDUP_HINT);
  }
  if (def.scan !== null) {
    const op = def.operations.find((o) => o.name === def.scan?.operation);
    const label = op?.label ?? def.scan.operation;
    lines.push(
      audience === 'technician'
        ? `סריקה כל ${def.scan.everyHours} שעות: ${label}`
        : `סריקה: העוזרת תקרא אוטומטית את „${label}” כל ${def.scan.everyHours} שעות, בלי לשאול אותך בכל פעם.`,
    );
  }
  return lines;
}

/** The technician's preview: `<label> (<kind label>)`, money operations marked as always asking. */
export function describeForTechnician(def: ExternalSystem): string[] {
  return describe(def, 'technician', null);
}

/**
 * The owner's sentences: `העוזרת תוכל: <label> (<kind label>)` per operation,
 * money operations adding `— רק אחרי "כן" שלך` (and a warning when their
 * currency is not the business's `currency`), then the webhook and scan lines.
 */
export function describeExternalSystem(def: ExternalSystem, currency: string): string[] {
  return describe(def, 'owner', currency);
}
