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

/** Who or what an action class reaches, if anything — see `ACTION_ADDRESSEE`. */
export const Addressee = z.enum(['person', 'host', 'internal']);
export type Addressee = z.infer<typeof Addressee>;

/**
 * Who or what each action class reaches.
 *
 * A total `Record` rather than two hand-maintained `Set`s (the
 * `HOST_ADDRESSED_CLASSES` and `COUNTERPARTY_ADDRESSED_CLASSES` this
 * replaces, both still exported below, now derived). Two sets over one enum
 * is exactly the shape that already hurt this codebase once: one of them was
 * originally written as "everything except the classes that address a
 * person", and inverting that by hand to build the other silently swept
 * `crm.write` out of the `one_unknown` escalation — an outbound write to a
 * system of record, with an unresolvable counterparty, dropped from
 * `sensitive` to `routine` and stopped requiring a human. A class missing
 * from a `Record<ActionClass, Addressee>` is a compile error, not a class
 * quietly defaulting to whatever a consumer's `Set.has()` returns for it.
 *
 * - `person`: reaches a human on the other end — a customer, attendee, or
 *   counterparty the action is addressed to.
 * - `host`: reaches a server under someone else's control. Today that is
 *   exactly the two browser classes: the session holds the owner's full
 *   authority on a page an attacker may have written, which is why the
 *   `one_unknown` first-contact escalation exempts them (a click is not a
 *   message to an unidentified person) and why nothing else may join this
 *   bucket by omission.
 * - `internal`: neither — a system the business itself owns (CRM,
 *   accounting, the filesystem, the charter, long-term memory) or a
 *   counterparty addressed as a supplier rather than an individual
 *   (`purchase.place`).
 */
export const ACTION_ADDRESSEE: Record<ActionClass, Addressee> = {
  'email.reply': 'person',
  'email.initiate': 'person',
  'whatsapp.reply': 'person',
  'whatsapp.initiate': 'person',
  'calendar.create': 'person',
  'calendar.move': 'person',
  'calendar.cancel': 'person',
  'quote.issue': 'person',
  'discount.grant': 'person',
  'commitment.make': 'person',
  // A supplier, not an individual — target derivation must order the
  // supplier field first for this class (`orchestrator/channels.ts`).
  'purchase.place': 'internal',
  'payment.make': 'person',
  'refund.issue': 'person',
  'crm.write': 'internal',
  'accounting.write': 'internal',
  'artifact.write': 'internal',
  'doc.deliver': 'person',
  'media.publish': 'internal',
  'browser.interact': 'host',
  'browser.session': 'host',
  'contract.sign': 'person',
  'data.export': 'internal',
  'memory.write_longterm': 'internal',
  'charter.amend': 'internal',
};

function classesAddressed(addressee: Addressee): ReadonlySet<ActionClass> {
  return new Set(
    (Object.entries(ACTION_ADDRESSEE) as [ActionClass, Addressee][])
      .filter(([, a]) => a === addressee)
      .map(([cls]) => cls),
  );
}

/**
 * Classes that address a host rather than a person, derived from
 * `ACTION_ADDRESSEE` so the `one_unknown` risk exemption (`policy/risk.ts`)
 * cannot drift from the total mapping above.
 */
export const HOST_ADDRESSED_CLASSES: ReadonlySet<ActionClass> = classesAddressed('host');

/**
 * Classes that reach a specific person rather than a system or a supplier,
 * derived from `ACTION_ADDRESSEE` so target-derivation ordering
 * (`orchestrator/channels.ts`) cannot drift from the same mapping.
 */
export const COUNTERPARTY_ADDRESSED_CLASSES: ReadonlySet<ActionClass> = classesAddressed('person');

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
