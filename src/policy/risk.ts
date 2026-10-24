import {
  BASELINE_REVERSIBILITY,
  BROWSER_ADDRESSED_CLASSES,
  messagesAPerson,
} from '../domain/action.js';
import { actionClassLabel, trustLevelLabel } from '../domain/labels.js';
import type { ActionFacts, CompiledCeilings, PolicyBundle } from '../domain/policy.js';
import type { RiskAssessment, RiskBand, RiskDimensions } from '../domain/risk.js';
import {
  ANOMALY_Z_THRESHOLD,
  DIMENSION_WEIGHTS,
  ROUTINE_MAX_TOTAL,
  SENSITIVE_MAX_TOTAL,
} from '../domain/risk.js';
import type { TrustLevel } from '../domain/trust.js';
import { extractDomain } from '../util/address.js';
import { formatMinor } from '../util/money.js';

/**
 * Historical baseline for the novelty dimension.
 *
 * Phase 0 ships the interface and a null implementation: with no history there
 * is nothing to be anomalous *against*, so z is 0. The NormsEngine fills this
 * in during Phase 2. Note this makes the system *more* permissive early, which
 * is safe only because the autonomy ramp holds everything at draft_only until
 * agreement is measured — the two mechanisms are load-bearing together.
 */
export interface NormsLookup {
  zScoreFor(facts: ActionFacts): Promise<{ metric: null; z: number; precedentIds: string[] }>;
}

export const NO_HISTORY: NormsLookup = {
  async zScoreFor() {
    return { metric: null, z: 0, precedentIds: [] };
  },
};

const PROVENANCE_SCORE: Record<TrustLevel, number> = {
  boss: 0,
  staff: 15,
  known_counterparty: 35,
  unknown_external: 70,
  open_web: 100,
};

const REVERSIBILITY_SCORE = {
  trivial: 0,
  reversible: 20,
  costly: 60,
  irreversible: 100,
} as const;

const SENSITIVITY_SCORE = {
  public: 0,
  internal: 15,
  customer_pii: 60,
  financial: 70,
  health: 95,
  legal: 85,
  credentials: 100,
} as const;

/**
 * Score an action on seven dimensions. Six are pure code; only novelty consults
 * anything external, and in Phase 0 that is a null implementation.
 *
 * The model is never in this path. `gov.risk` exists to offer a second opinion
 * on top of a score that already exists — it does not produce the score.
 */
export async function assessRisk(
  facts: ActionFacts,
  bundle: PolicyBundle,
  options: { norms?: NormsLookup; charterFit?: RiskDimensions['charterFit'] } = {},
): Promise<RiskAssessment> {
  if (facts.actionClass === null) {
    throw new Error('assessRisk called on a read-only action; the gate should have short-circuited');
  }

  const norms = options.norms ?? NO_HISTORY;
  const ceilings = bundle.ceilings;

  const novelty = await norms.zScoreFor(facts);

  const dimensions: RiskDimensions = {
    money: scoreMoney(facts, ceilings),
    reversibility: {
      class: BASELINE_REVERSIBILITY[facts.actionClass],
      score: REVERSIBILITY_SCORE[BASELINE_REVERSIBILITY[facts.actionClass]],
    },
    externalVisibility: scoreVisibility(facts, bundle.knownCounterparties),
    dataSensitivity: scoreSensitivity(facts),
    novelty: {
      metric: novelty.metric,
      z: novelty.z,
      precedentIds: novelty.precedentIds,
      // A z of 3 is the anomaly threshold, so map it to the top of the scale.
      score: clamp((Math.abs(novelty.z) / ANOMALY_Z_THRESHOLD) * 100),
    },
    provenance: {
      level: facts.provenance,
      chainDepth: facts.chainDepth,
      score: PROVENANCE_SCORE[facts.provenance],
    },
    charterFit: options.charterFit ?? { verdict: 'within', citedRuleIds: [], score: 0 },
  };

  const total = clamp(
    Math.round(
      dimensions.money.score * DIMENSION_WEIGHTS.money +
        dimensions.reversibility.score * DIMENSION_WEIGHTS.reversibility +
        dimensions.externalVisibility.score * DIMENSION_WEIGHTS.externalVisibility +
        dimensions.dataSensitivity.score * DIMENSION_WEIGHTS.dataSensitivity +
        dimensions.novelty.score * DIMENSION_WEIGHTS.novelty +
        dimensions.provenance.score * DIMENSION_WEIGHTS.provenance +
        dimensions.charterFit.score * DIMENSION_WEIGHTS.charterFit,
    ),
  );

  const band = bandFor(total, dimensions, facts);

  return {
    actionId: facts.inputHash.slice(0, 16),
    actionClass: facts.actionClass,
    dimensions,
    total,
    band,
    decidedBy: 'rules',
    explanation: explain(band, total, dimensions, facts, ceilings),
    suggestedApprovers: [],
  };
}

function scoreMoney(
  facts: ActionFacts,
  ceilings: CompiledCeilings,
): RiskDimensions['money'] {
  const pctOfDailyCeiling =
    ceilings.dailyMinor > 0 ? facts.amountMinor / ceilings.dailyMinor : 0;
  return {
    amountMinor: facts.amountMinor,
    pctOfDailyCeiling,
    score: clamp(pctOfDailyCeiling * 100),
  };
}

/**
 * `one_known` means the charter knows this counterparty — not that the payload
 * claimed one. Everything outbound goes through the first-contact escalation
 * except `BROWSER_ADDRESSED_CLASSES`, which is a closed two-element allowlist
 * — `browser.interact` and `browser.session` and nothing else. Stated as those
 * two names rather than as "host-addressed": "host" is the over-broad reading
 * the allowlist exists to block, since a supplier API also terminates on a
 * third party's server and must stay inside the escalation.
 *
 * `buildFacts` falls back to the payload's `entityId` when `counterpartyId` is
 * absent, which is right for resolving a counterparty but wrong as evidence of
 * one: any outbound payload carrying an `entityId` field used to score as a
 * known recipient, dropping 55 to 25 and, through `bandFor`, turning a
 * `sensitive` first contact into a `routine` send. An agent reasoning from
 * injected content could therefore quiet its own risk score by naming an id
 * that exists nowhere. Membership is now checked against the compiled charter,
 * which the model cannot write to.
 */
function scoreVisibility(
  facts: ActionFacts,
  known: PolicyBundle['knownCounterparties'],
): RiskDimensions['externalVisibility'] {
  if (!facts.leavesInstance) return { audience: 'internal', score: 0 };

  // Leaves the instance, but addresses a browser session rather than a person.
  // Scored as external exposure without the first-contact escalation, which is
  // about messaging someone we cannot identify.
  if (facts.actionClass !== null && BROWSER_ADDRESSED_CLASSES.has(facts.actionClass)) {
    return { audience: 'many', score: 30 };
  }

  // Each fact is compared only against the bucket that can legitimately hold
  // it. Against one flat list, `entityId: "vip"` matched a *tag* and bought a
  // resolved-counterparty score the sender had not earned.
  //
  // Every address this action would reach, and whether the charter knows it.
  //
  // Only tokens that actually parse as an address count. `readEmails` reads
  // `to`, `recipient` and `email` and over-approximates on purpose — its own
  // docblock says a false positive there costs nothing, which was true while
  // this check was `some`. Under `every` it stops being true: a display name
  // in `recipient` has no domain, would never resolve, and would drag a
  // perfectly known recipient to `one_unknown`. A string with no domain is
  // also a string the mail adapter will never deliver to, so dropping it here
  // removes no exposure.
  const addressesResolved = [
    ...facts.counterpartyEmails.flatMap((email) => {
      const domain = extractDomain(email);
      if (domain === null) return [];
      // Exact match, deliberately not domainMatches (src/util/address.ts):
      // "known" here LOOSENS the score -- it skips the first-contact
      // escalation -- and a subdomain is not a company boundary a charter
      // entry for the parent vouched for. 'promo.mail.acme.co.il' is not
      // known just because 'acme.co.il' is; anyone can get a subdomain of
      // a domain someone else owns, and a hosting platform's own domain
      // makes that true for every one of its customers at once. See
      // domainMatches's own docblock for why the two consumers of it that
      // *tighten* a restriction are allowed the broader match and this one
      // is not.
      return [known.emailDomains.includes(domain)];
    }),
    ...facts.counterpartyPhones.map((phone) => known.phones.includes(phone)),
  ];

  const identityResolved =
    (facts.counterpartyId !== null && known.entityIds.includes(facts.counterpartyId)) ||
    facts.counterpartyTags.some((tag) => known.tags.includes(tag));

  // The every-address rule applies only where an address is a DESTINATION.
  // `messagesAPerson` (`src/domain/action.ts`) is the existing answer to that
  // question — see its own docblock for why `crm.write`'s email must not
  // count as one.
  const addressedToPerson = messagesAPerson(facts.actionClass);

  // `every`, not `some`, and the distinction is the whole control. This is the
  // one place in the risk engine where a match makes the outcome LESS
  // restrictive, so it has to be satisfied by the worst recipient rather than
  // the best one. Under `some`, a payload naming one address the charter knows
  // carried an arbitrary number of strangers along with it at the known score —
  // "also copy attacker@evil.example on that reply" is a sentence an injected
  // document can write, and the extra recipient is delivered to by
  // `readRecipients` while `isUnvettedFirstContact` never fires for it.
  //
  // Identity evidence -- `counterpartyId`, tags -- resolves ONLY when the
  // action carries no address at all, which is the shape of a record-keeping
  // write like `crm.write`. It may never stand in for an address that failed to
  // resolve: the id is a claim about who this concerns, not about where the
  // message goes, and the two are exactly what an injected payload separates.
  const resolved =
    addressedToPerson && addressesResolved.length > 0
      ? addressesResolved.every((isKnown) => isKnown)
      : identityResolved || addressesResolved.some((isKnown) => isKnown);
  return resolved
    ? { audience: 'one_known', score: 25 }
    : { audience: 'one_unknown', score: 55 };
}

function scoreSensitivity(facts: ActionFacts): RiskDimensions['dataSensitivity'] {
  const worst = facts.dataClasses.reduce(
    (max, cls) => Math.max(max, SENSITIVITY_SCORE[cls]),
    0,
  );
  // Sensitive data that stays inside the instance is far less of a problem than
  // the same data on its way out; only the combination scores high.
  const score = facts.leavesInstance ? worst : Math.round(worst * 0.3);
  return {
    classes: facts.dataClasses,
    leavesInstance: facts.leavesInstance,
    score: clamp(score),
  };
}

/**
 * Origins whose instruction IS the approval, so a first contact from them does
 * not escalate.
 *
 * A positive list, not "anything that is not untrusted": a TrustLevel added to
 * the enum later stays inside the escalation until someone decides otherwise
 * in this file, which is the safe direction to be wrong in.
 *
 * The set alone is not the control. `provenance` is supposed to be the LEAST
 * trusted link in the causal chain, not whoever spoke first — that is what
 * makes the exemption narrow enough to be safe. "Send a quote to
 * dana@newcompany.co.il" carries `boss` and goes. "Read this email and reply
 * to the sender" is supposed to carry the inbound email's level and still
 * escalate: the boss gave a generic instruction and someone else chose the
 * address.
 *
 * Nothing about a `TrustLevel` value proves which of those two it came from.
 * Provenance is stamped once per job today and inherited by every step, so a
 * `boss` on a step whose recipient was chosen by content read three steps
 * earlier is indistinguishable from a `boss` the owner typed — and lifting
 * the escalation for the first case removes the human checkpoint from exactly
 * the prompt-injection path this system exists to stop.
 *
 * So the exemption is gated on `facts.provenanceChainDerived`, an explicit
 * claim by the caller that the value in `provenance` was reduced over THIS
 * action's chain (see that field's docblock in `src/domain/policy.ts` for
 * what a caller must guarantee before setting it). Absent, the escalation
 * runs.
 *
 * `runPlan` (`src/orchestrator/run-plan.ts`) is the one caller that sets it,
 * and only when all three hold for the whole plan being run: the job's
 * stamped provenance is `boss`, no step in that plan reads external content
 * (`ingestsExternalContent`), and the job has never ingested any before now
 * (`job.contentIngested`). Every other caller — `executeStep` invoked on its
 * own, the SDK gate hook — leaves the field unset, so the escalation still
 * runs for them. The safety argument is held by the predicate, not by the
 * absence of a caller — which is exactly why it now has to hold under a real
 * one.
 *
 * **The set is empty as of 10/09, on the owner's instruction, and the whole
 * argument above is now history rather than justification.** `boss` was its
 * only member. What settled it was raising the `email.reply` ramp to
 * `auto_notify`: until then the gate denied on autonomy at stage 8 long
 * before the band was computed, so the exemption had never once decided
 * anything. Made reachable, the first thing it did was let a real message
 * leave for an address nothing in the charter resolved, with no card —
 * measured in `src/orchestrator/ramp-raise.test.ts`, not predicted.
 *
 * The distinction the docblock above draws is real, and the owner's rule
 * draws it in a place this constant cannot reach: a recipient counts as named
 * when the owner **typed it**, and that case is already served by the
 * standing authorisation the instruction door writes, which cancels this same
 * risk-band term in `needsApproval` for exactly the recipients an instruction
 * named. `provenanceChainDerived` can only say the chain came from the owner,
 * never that the owner chose this address — and between those two, only the
 * second is what was ever wanted. So emptying the set costs nothing the owner
 * asked for and closes the case they did not.
 *
 * The mechanism is kept rather than deleted: the predicate below still reads
 * the set and still requires `provenanceChainDerived`, so re-populating it is
 * one line if the friction proves worse than the exposure. Two invariants in
 * `src/policy/positive-controls.test.ts` iterate `TrustLevel.options` and
 * fail — naming the level — the moment anything is put back.
 */
const FIRST_CONTACT_EXEMPT: ReadonlySet<TrustLevel> = new Set<TrustLevel>();

/**
 * Whether this first contact needs a human because nobody trustworthy vouched
 * for the address. Shared by `bandFor` and `explain` so the escalation and its
 * stated reason can never drift apart — a past defect in this plan was exactly
 * two copies of one rule disagreeing.
 *
 * Two conditions, in this order: the origin must be on the positive list AND
 * the caller must have said the origin was computed for this action's own
 * chain. Either one alone lets an inherited trust level speak for a recipient
 * it never saw.
 */
function isUnvettedFirstContact(dimensions: RiskDimensions, facts: ActionFacts): boolean {
  const exempt = facts.provenanceChainDerived && FIRST_CONTACT_EXEMPT.has(facts.provenance);
  return dimensions.externalVisibility.audience === 'one_unknown' && !exempt;
}

/**
 * Band assignment. The total is only one input — several dimensions escalate on
 * their own, because an action can be cheap and average and still be the one
 * you want a human to look at.
 */
function bandFor(
  total: number,
  dimensions: RiskDimensions,
  facts: ActionFacts,
): RiskBand {
  if (dimensions.charterFit.verdict === 'violates') return 'blocked';

  // Untrusted origin plus money is never routine, whatever the total says.
  if (
    facts.amountMinor > 0 &&
    (facts.provenance === 'open_web' || facts.provenance === 'unknown_external')
  ) {
    return 'anomalous';
  }

  if (Math.abs(dimensions.novelty.z) > ANOMALY_Z_THRESHOLD) return 'anomalous';
  if (dimensions.charterFit.verdict === 'ambiguous') return 'anomalous';

  // First contact with a party we cannot resolve is the classic sensitive
  // case — unless the instruction came from the boss, in which case naming
  // the counterparty WAS the approval.
  if (isUnvettedFirstContact(dimensions, facts)) return 'sensitive';

  if (total > SENSITIVE_MAX_TOTAL) return 'anomalous';
  if (total > ROUTINE_MAX_TOTAL) return 'sensitive';

  return 'routine';
}

function explain(
  band: RiskBand,
  total: number,
  dimensions: RiskDimensions,
  facts: ActionFacts,
  ceilings: CompiledCeilings,
): string {
  if (band === 'routine') {
    // A read-only call carries no class; it used to print "null" here.
    const what = facts.actionClass === null ? 'הפעולה' : actionClassLabel(facts.actionClass);
    return `${what} בטווח הרגיל של העסק.`;
  }

  const reasons: string[] = [];
  if (facts.amountMinor > 0) {
    reasons.push(`סכום ${formatMinor(facts.amountMinor, ceilings.currency)}`);
  }
  if (Math.abs(dimensions.novelty.z) > ANOMALY_Z_THRESHOLD) {
    reasons.push(`חריגה מהרגיל (z=${dimensions.novelty.z.toFixed(1)})`);
  }
  if (isUnvettedFirstContact(dimensions, facts)) {
    reasons.push('מגע ראשון עם גורם לא מזוהה');
  }
  if (dimensions.provenance.level === 'unknown_external' || dimensions.provenance.level === 'open_web') {
    reasons.push(`מקור לא אמין (${trustLevelLabel(dimensions.provenance.level)})`);
  }
  if (dimensions.reversibility.class === 'irreversible') {
    reasons.push('פעולה בלתי הפיכה');
  }
  if (dimensions.charterFit.verdict !== 'within') {
    reasons.push(`התאמה לתקנון: ${dimensions.charterFit.verdict}`);
  }

  return reasons.length > 0
    ? `${facts.actionClass}: ${reasons.join(' · ')}.`
    // The composite total, not the money dimension. The old form printed
    // `dimensions.money.score`, so an escalation driven by provenance or
    // reversibility was explained to the boss as "(score 0)" — a number that
    // contradicted the escalation it was meant to justify.
    : `${facts.actionClass} דורש מבט שני (ציון ${total}).`;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

