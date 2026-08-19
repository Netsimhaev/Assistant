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
  'artifact.write',
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
  // Writing a file is undone by writing it again — unless it lands somewhere
  // that executes it, which is what the path scoping is for.
  'artifact.write': 'reversible',
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
const NEVER_FULLY_AUTONOMOUS_TABLE: Record<ActionClass, boolean> = {
  'email.reply': false,
  'email.initiate': false,
  'whatsapp.reply': false,
  'whatsapp.initiate': false,
  'calendar.create': false,
  'calendar.move': false,
  'calendar.cancel': false,
  'quote.issue': false,
  'discount.grant': false,
  'commitment.make': false,
  'purchase.place': false,
  'payment.make': true,
  'refund.issue': true,
  'browser.interact': false,
  'browser.session': false,
  'contract.sign': true,
  'data.export': true,
  'crm.write': false,
  'accounting.write': false,
  'artifact.write': false,
  'doc.deliver': false,
  'media.publish': false,
  'memory.write_longterm': false,
  'charter.amend': true,
};

/**
 * A total record rather than a `Set`.
 *
 * A `Set` is maintained by hand and says nothing when the enum grows: a newly
 * added irreversible class would land silently *outside* the "always needs a
 * human" check. A `Record<ActionClass, boolean>` makes that a compile error.
 */
export const NEVER_FULLY_AUTONOMOUS: ReadonlySet<ActionClass> = new Set(
  (Object.entries(NEVER_FULLY_AUTONOMOUS_TABLE) as [ActionClass, boolean][])
    .filter(([, never]) => never)
    .map(([cls]) => cls),
);

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

/**
 * Classes that reach a specific person rather than a system or a supplier.
 *
 * Used to order target derivation: when a payload carries both a
 * `counterpartyId` and a `supplierId` (a stray field, or one an attacker
 * injected), which one is authoritative must be a property of the action
 * class, not of which field happens to be present. Written as an explicit
 * allowlist for the same reason as `HOST_ADDRESSED_CLASSES` above — the
 * excluding form ("everything that isn't clearly a supplier action") would
 * silently pull in a class added later and let its payload decide the
 * channel, which is the authority this list exists to keep out of the
 * payload's hands.
 */
export const COUNTERPARTY_ADDRESSED_CLASSES: ReadonlySet<ActionClass> = new Set([
  'email.reply',
  'email.initiate',
  'whatsapp.reply',
  'whatsapp.initiate',
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

/**
 * Does this action commit money that the ceilings must account for?
 *
 * One predicate for both sides of the accounting. They used to disagree:
 * `checkBudget` charged *any* action carrying `amountMinor` against the daily
 * ceiling, while the ledger only recorded the six classes in
 * `MONETARY_CLASSES`. A class outside that set could therefore be charged
 * against a ceiling and never added to it — so repeated `commitment.make`
 * calls each passed the per-action cap and the daily total stayed at zero.
 */
/**
 * Monetary classes whose payload must carry a readable amount.
 *
 * Listed by name rather than derived as "MONETARY_CLASSES minus the odd one",
 * because the odd one is load-bearing: a discount is a percentage and its tool
 * call carries no amount at all. Requiring one there would deny every discount
 * and quietly undo the fix that made the discount ceiling reachable.
 */
export const AMOUNT_REQUIRED_CLASSES: ReadonlySet<ActionClass> = new Set([
  'quote.issue',
  'purchase.place',
  'payment.make',
  'refund.issue',
  'accounting.write',
]);

export function isMoneyBearing(
  actionClass: ActionClass | null,
  amountMinor: number,
): boolean {
  if (actionClass === null) return false;
  return amountMinor > 0 || MONETARY_CLASSES.has(actionClass);
}
