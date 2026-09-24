/**
 * The five loop guards and the constraint inheritance, all pure.
 *
 * Pure on purpose: every one of them is a rule that must be provable without
 * a database, and the two that need stored rows (§5.4, §5.5) take the rows as
 * arguments rather than fetching them. `envelope-store.ts` owns the queries.
 */
import { AgentId } from '../domain/audit.js';
import { MAX_HOPS, type ContextRef, type EnvelopeConstraints } from '../domain/envelope.js';
import type { Plan } from '../domain/plan.js';
import { lowestTrust, mostRestrictiveAutonomy } from '../domain/trust.js';
import { canonicalHash } from '../util/canonical.js';

/**
 * Every field of a child's constraints, derived from the parent's and the
 * source's by taking the stricter of the two.
 *
 * **One function is the single source for all five rows.** Five places each
 * tightening one field are five places that drift, and the drift is silent:
 * a field that stopped tightening still returns a value, and the only symptom
 * is a child with more authority than its parent.
 *
 * `charterVersion` is copied from the parent and never negotiated — a child
 * running under a charter the parent never saw is a child whose result the
 * parent cannot explain.
 */
export function tightenConstraints(
  parent: EnvelopeConstraints,
  source: Partial<EnvelopeConstraints>,
): EnvelopeConstraints {
  const provenanceCeiling =
    source.provenanceCeiling === undefined
      ? parent.provenanceCeiling
      : lowestTrust([parent.provenanceCeiling, source.provenanceCeiling]);

  const autonomyCeiling =
    source.autonomyCeiling === undefined
      ? parent.autonomyCeiling
      : mostRestrictiveAutonomy([parent.autonomyCeiling, source.autonomyCeiling]);

  // `null` on either side means "no ceiling of my own" and must not win.
  const money =
    source.moneyCeilingMinor === undefined || source.moneyCeilingMinor === null
      ? parent.moneyCeilingMinor
      : parent.moneyCeilingMinor === null
        ? source.moneyCeilingMinor
        : Math.min(parent.moneyCeilingMinor, source.moneyCeilingMinor);

  const deadlineAt =
    source.deadlineAt === undefined
      ? parent.deadlineAt
      : Date.parse(source.deadlineAt) < Date.parse(parent.deadlineAt)
        ? source.deadlineAt
        : parent.deadlineAt;

  return {
    charterVersion: parent.charterVersion,
    provenanceCeiling,
    autonomyCeiling,
    moneyCeilingMinor: money,
    deadlineAt,
  };
}

export type DelegationDenial =
  | { code: 'hop_limit'; reason: string }
  | { code: 'not_permitted'; reason: string }
  | { code: 'unknown_intent'; reason: string }
  | { code: 'no_new_information'; reason: string }
  | { code: 'oscillation'; reason: string }
  | { code: 'daily_cap'; reason: string };

/**
 * Guard 1. Refuses at the ceiling rather than at the ceiling plus one, so no
 * envelope carrying `hops > MAX_HOPS` is ever constructed.
 */
export function hopGuard(parentHops: number): DelegationDenial | null {
  if (parentHops + 1 > MAX_HOPS) {
    return {
      code: 'hop_limit',
      reason: `שרשרת ההאצלה הגיעה ל-${MAX_HOPS} קפיצות ואינה ממשיכה`,
    };
  }
  return null;
}

/**
 * Guard 4, and the one that actually kills ping-pong. A→B→A continues only
 * when A genuinely has new context.
 *
 * Takes the prior quadruples as an argument rather than querying: the rule is
 * provable without a database, and `envelope-store.ts` owns the query.
 */
export function noNewInformationGuard(
  candidate: { from: string; to: string; intent: string; contextRefsHash: string },
  prior: readonly { from: string; to: string; intent: string; contextRefsHash: string }[],
): DelegationDenial | null {
  const seen = prior.some(
    (p) =>
      p.from === candidate.from &&
      p.to === candidate.to &&
      p.intent === candidate.intent &&
      p.contextRefsHash === candidate.contextRefsHash,
  );
  if (seen) {
    return {
      code: 'no_new_information',
      reason: `${candidate.from} כבר ביקש מ-${candidate.to} בדיוק את זה, על אותו הקשר`,
    };
  }
  return null;
}

/** Guard 5. More than two exchanges between one pair on one intent. */
export const MAX_PAIR_EXCHANGES = 2;

export function oscillationGuard(exchanges: number): DelegationDenial | null {
  if (exchanges >= MAX_PAIR_EXCHANGES) {
    return {
      code: 'oscillation',
      reason:
        `שני הסוכנים החליפו ביניהם ${exchanges} פעמים על אותו נושא. ` +
        `שני סוכנים שחלוקים ביניהם הם סימן שאדם צריך להסתכל, לא שסוכן שלישי יכריע`,
    };
  }
  return null;
}

/** Guard 2's model-cost half. Money is already capped per business by `spend_ledger`. */
export function dailyCapGuard(used: number, cap: number): DelegationDenial | null {
  if (used >= cap) {
    return { code: 'daily_cap', reason: `תקרת ההאצלות היומית (${cap}) נוצלה` };
  }
  return null;
}

/**
 * The hash guard 4 compares.
 *
 * **Sorted before hashing**, the same lesson `planFingerprint` in
 * `erasure-plan.ts` already carries: the arrays behind these pointers come
 * from queries without `ORDER BY`, so hashing the raw order refuses at random
 * — and a control that fires when nothing happened teaches people to click
 * past it.
 */
export function contextRefsHash(refs: readonly ContextRef[]): string {
  const canonical = refs
    .map((ref) => JSON.stringify(ref, Object.keys(ref).sort()))
    .slice()
    .sort();
  return canonicalHash({ refs: canonical });
}

/**
 * Guard 3 of §6.3's first layer: may `from` ask `to` at all.
 *
 * Read from the compiled charter's `collaborationGraph`, which until this work
 * was compiled into the signed bundle and read by nobody.
 */
export function mayDelegate(
  graph: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  if (!Object.hasOwn(graph, from)) return false;
  return (graph[from] ?? []).includes(to);
}

export type DelegationPlanProblem = {
  kind: 'delegation_pair_not_permitted';
  stepId: string;
  from: string;
  to: string;
};

/**
 * Layer one of §6.3: a plan naming a forbidden pair is rejected whole, before
 * any step runs — the rule that already holds for the tool allowlist, and for
 * the same reason: a step that fails alone leaves the steps before it done.
 *
 * Lives here rather than in `planProblems` (`src/domain/plan.ts`), which the
 * spec named: that function is pure over a `Plan` and reaching the compiled
 * bundle from it would import `src/governance/` into `src/domain/`.
 */
export function delegationProblems(
  plan: Plan,
  graph: Readonly<Record<string, readonly string[]>>,
): DelegationPlanProblem[] {
  const problems: DelegationPlanProblem[] = [];
  for (const step of plan.steps) {
    if (step.toolName !== 'agent.request_help') continue;
    const to = Object.hasOwn(step.input, 'to') ? step.input['to'] : undefined;
    if (typeof to !== 'string' || !AgentId.safeParse(to).success || !mayDelegate(graph, step.agent, to)) {
      problems.push({
        kind: 'delegation_pair_not_permitted',
        stepId: step.id,
        from: step.agent,
        to: typeof to === 'string' ? to : '(חסר)',
      });
    }
  }
  return problems;
}
