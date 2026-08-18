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
  // Live browser authority. Classified rather than read-only: a session holds
  // the user's full authority on the site, and the page it reads is written by
  // whoever controls that site (docs/08-risks.md, "the confused deputy").
  'browser.interact',
  'browser.session',
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
  // Optimistic, and correct as a baseline: most clicks navigate. A click that
  // commits money is refined to `purchase.place` before it is ever scored.
  'browser.interact': 'reversible',
  // Handing a live authenticated session to an agent is not undone by closing
  // the tab — whatever it did with that authority is already done.
  'browser.session': 'costly',
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

/**
 * Classes that address a host rather than a person.
 *
 * The `one_unknown` risk escalation ("first contact with a party we cannot
 * resolve") forces the sensitive band and therefore an approval. A browser
 * click also leaves the instance, but it addresses a host, not a person, and
 * scoring it as an unidentified first contact sent every ordinary click to the
 * approval queue.
 *
 * Written as an explicit allowlist of the two classes the exemption is *for*,
 * not as "everything except the classes that address people". The excluding
 * form swept in `crm.write` — an outbound write to a system of record, with an
 * unresolvable counterparty, dropped from `sensitive` to `routine` and stopped
 * requiring a human. Any class added to the enum later must not be able to
 * fall out of the sensitive band by omission.
 */
export const HOST_ADDRESSED_CLASSES: ReadonlySet<ActionClass> = new Set([
  'browser.interact',
  'browser.session',
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
