import { z } from 'zod';

/**
 * The taxonomy every side-effecting action is classified into.
 *
 * This enum is the join key between the charter (which declares ceilings and
 * autonomy per class), the risk engine (which scores per class), the approval
 * broker, and the autonomy ramp. A tool call that maps to no class is read-only
 * and skips the gate entirely.
 *
 * Anything that genuinely matters must map to an ActionClass. A free-text
 * prohibition in `voice.mustNeverSay` is a string match and therefore a weak
 * control — see the charter test in docs/09-roadmap.md.
 */
export const ActionClass = z.enum([
  // Communications
  'email.reply',
  'email.initiate',
  'whatsapp.reply',
  'whatsapp.initiate',
  // Scheduling
  'calendar.create',
  'calendar.move',
  'calendar.cancel',
  // Commercial commitments
  'quote.issue',
  'discount.grant',
  'commitment.make',
  // Money
  'purchase.place',
  'payment.make',
  'refund.issue',
  // Systems of record
  'crm.write',
  'accounting.write',
  // Deliverables
  'doc.deliver',
  'media.publish',
  // High blast radius
  'contract.sign',
  'data.export',
  'memory.write_longterm',
  'charter.amend',
]);
export type ActionClass = z.infer<typeof ActionClass>;

/**
 * How hard an action is to undo. Feeds the risk score directly: an action with
 * no compensation path is `irreversible`, which is what pushes it into the
 * approval band regardless of amount (docs/02-orchestrator.md).
 */
export const Reversibility = z.enum([
  'trivial',
  'reversible',
  'costly',
  'irreversible',
]);
export type Reversibility = z.infer<typeof Reversibility>;

/**
 * Baseline reversibility per class. A concrete action can be scored worse than
 * its baseline (a purchase from a supplier with no cancellation window), never
 * better — the baseline is the optimistic case.
 */
export const BASELINE_REVERSIBILITY: Record<ActionClass, Reversibility> = {
  'email.reply': 'irreversible',
  'email.initiate': 'irreversible',
  'whatsapp.reply': 'irreversible',
  'whatsapp.initiate': 'irreversible',
  'calendar.create': 'reversible',
  'calendar.move': 'reversible',
  'calendar.cancel': 'costly',
  'quote.issue': 'costly',
  'discount.grant': 'costly',
  'commitment.make': 'irreversible',
  'purchase.place': 'costly',
  'payment.make': 'irreversible',
  'refund.issue': 'irreversible',
  'crm.write': 'reversible',
  'accounting.write': 'costly',
  'doc.deliver': 'irreversible',
  'media.publish': 'costly',
  'contract.sign': 'irreversible',
  'data.export': 'irreversible',
  'memory.write_longterm': 'reversible',
  'charter.amend': 'reversible',
};

/**
 * Classes that stay `approve_required` forever, regardless of how good the
 * autonomy-ramp metrics look. Some things you do not automate.
 * (docs/08-risks.md — "irreversibility is never automated")
 */
export const NEVER_FULLY_AUTONOMOUS: ReadonlySet<ActionClass> = new Set([
  'contract.sign',
  'payment.make',
  'refund.issue',
  'data.export',
  'charter.amend',
]);

/** Classes whose payload can carry a monetary amount the ceilings apply to. */
export const MONETARY_CLASSES: ReadonlySet<ActionClass> = new Set([
  'quote.issue',
  'discount.grant',
  'purchase.place',
  'payment.make',
  'refund.issue',
  'accounting.write',
]);
