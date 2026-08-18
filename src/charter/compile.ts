import type { ActionClass } from '../domain/action.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { AgentId } from '../domain/audit.js';
import type {
  CompiledCeilings,
  CompiledRule,
  PolicyBundle,
} from '../domain/policy.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { assertExactlyOnePrincipal } from '../domain/charter.js';
import { verifyCharterSignature } from './sign.js';
import { AGENT_ALLOWLISTS, AGENT_DENYLISTS, COLLABORATION_GRAPH } from './capabilities.js';
import { formatMinor } from '../util/money.js';
import { renderPlainLanguage, renderPromptFragments } from './render.js';

/**
 * Compile a signed charter into the artefact the hooks evaluate.
 *
 * This is the step that turns policy from prose the model is asked to obey into
 * data the model cannot influence. Everything downstream of the gate reads the
 * bundle, never the charter document.
 */
export function compileCharter(charter: BusinessCharter): PolicyBundle {
  const signature = verifyCharterSignature(charter);
  if (!signature.valid) {
    throw new Error(`refusing to compile an unverified charter: ${signature.reason}`);
  }
  assertExactlyOnePrincipal(charter.people);

  return {
    charterVersion: charter.charterVersion,
    contentHash: charter.signature.contentHash,
    compiledAt: new Date().toISOString(),

    rules: compileRules(charter),
    ceilings: compileCeilings(charter),
    autonomyBase: charter.autonomy.base,
    provenanceCeiling: charter.autonomy.provenanceCeiling,
    counterpartyAutonomy: compileCounterpartyAutonomy(charter),
    quietHours:
      charter.operations.quietHours === undefined
        ? null
        : { ...charter.operations.quietHours, timezone: charter.identity.timezone },
    redactPatterns: charter.data.redactBeforeSending,
    doNotContact: compileDoNotContact(charter),
    knownCounterparties: bucketMatches(charter.counterparties, () => true),

    allowlists: AGENT_ALLOWLISTS,
    denylists: AGENT_DENYLISTS,
    collaborationGraph: COLLABORATION_GRAPH,

    promptFragments: renderPromptFragments(charter),
    plainLanguage: renderPlainLanguage(charter),
  };
}

/**
 * Sort do-not-contact entries by the key that identifies them.
 *
 * The previous version collapsed all four match keys into one string list and
 * compared it against `facts.counterpartyId` alone. An entry matched by
 * `emailDomain` therefore compiled successfully, appeared in the signed
 * document, and matched nothing — the quietest possible failure for a rule
 * whose entire purpose is to be absolute.
 *
 * A counterparty carrying several match keys contributes to each list: any one
 * of them identifying the other side is enough to stop the message.
 */
function compileDoNotContact(charter: BusinessCharter): PolicyBundle['doNotContact'] {
  return bucketMatches(charter.counterparties, (c) => c.doNotContact);
}

/**
 * Sort counterparty match keys into the bucket each one can actually be
 * compared against.
 *
 * Normalised here to match how `buildFacts` normalises the payload — a domain
 * that differs only in case, or a phone written with dashes, must still match.
 */
function bucketMatches(
  counterparties: BusinessCharter['counterparties'],
  include: (c: BusinessCharter['counterparties'][number]) => boolean,
): PolicyBundle['doNotContact'] {
  const out = {
    entityIds: [] as string[],
    emailDomains: [] as string[],
    phones: [] as string[],
    tags: [] as string[],
  };

  for (const c of counterparties) {
    if (!include(c)) continue;
    if (c.match.entityId !== undefined) out.entityIds.push(c.match.entityId);
    if (c.match.emailDomain !== undefined) {
      out.emailDomains.push(normaliseDomain(c.match.emailDomain));
    }
    if (c.match.phone !== undefined) out.phones.push(c.match.phone.replace(/\D/g, ''));
    if (c.match.tag !== undefined) out.tags.push(c.match.tag);
  }

  return out;
}

export function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

function compileRules(charter: BusinessCharter): CompiledRule[] {
  const rules: CompiledRule[] = [];

  // Hard prohibitions first — these deny before anything else is evaluated and
  // are not overridable, not even by an approval.
  for (const rule of charter.forbidden) {
    rules.push({
      id: `forbidden:${rule.id}`,
      description: rule.description,
      kind: 'forbidden',
      appliesTo: rule.actionClasses,
      whenCounterpartyTag: rule.whenCounterpartyTag ?? null,
    });
  }

  // Per-class money ceilings become named rules so a denial can cite the
  // specific limit that stopped it rather than a generic "over budget".
  for (const [actionClass, ceiling] of Object.entries(
    charter.money.perActionClassCeilingMinor,
  )) {
    if (ceiling === undefined) continue;
    rules.push({
      id: `ceiling:${actionClass}`,
      description:
        `${actionClass} is capped at ${formatMinor(ceiling, charter.money.currency)} per action`,
      kind: 'ceiling',
      appliesTo: [actionClass as ActionClass],
      whenCounterpartyTag: null,
    });
  }

  for (const [actionClass, level] of Object.entries(charter.autonomy.base)) {
    if (level === undefined) continue;
    rules.push({
      id: `autonomy:${actionClass}`,
      description: `${actionClass} baseline autonomy is ${level}`,
      kind: 'autonomy',
      appliesTo: [actionClass as ActionClass],
      whenCounterpartyTag: null,
    });
  }

  return rules;
}

function compileCeilings(charter: BusinessCharter): CompiledCeilings {
  const approvedSupplierCeilingMinor: Record<string, number> = {};
  for (const supplier of charter.money.approvedSuppliers) {
    approvedSupplierCeilingMinor[supplier.entityId] = supplier.autoOrderCeilingMinor;
  }

  return {
    currency: charter.money.currency,
    singleActionMinor: charter.money.singleActionCeilingMinor,
    dailyMinor: charter.money.dailyCeilingMinor,
    monthlyMinor: charter.money.monthlyCeilingMinor,
    perActionClassMinor: charter.money.perActionClassCeilingMinor,
    maxDiscountPercent: charter.money.maxDiscountPercent,
    approvedSupplierCeilingMinor,
  };
}

/**
 * Flatten counterparty rules into a lookup keyed by every match key they carry,
 * so the gate can resolve an override without re-running match logic per call.
 */
function compileCounterpartyAutonomy(
  charter: BusinessCharter,
): PolicyBundle['counterpartyAutonomy'] {
  const out: PolicyBundle['counterpartyAutonomy'] = {
    byEntityId: {},
    byEmailDomain: {},
    byPhone: {},
    byTag: {},
  };

  for (const counterparty of charter.counterparties) {
    const overrides = counterparty.autonomyOverrides;
    if (Object.keys(overrides).length === 0) continue;

    const targets: [Record<string, Partial<Record<ActionClass, AutonomyLevel>>>, string | undefined][] = [
      [out.byEntityId, counterparty.match.entityId],
      [out.byEmailDomain, counterparty.match.emailDomain === undefined
        ? undefined
        : normaliseDomain(counterparty.match.emailDomain)],
      [out.byPhone, counterparty.match.phone?.replace(/\D/g, '')],
      [out.byTag, counterparty.match.tag],
    ];

    for (const [bucket, key] of targets) {
      if (key === undefined || key.length === 0) continue;
      // A later rule matching the same key tightens rather than replaces: two
      // rules that both apply should not let ordering decide the outcome.
      const existing = bucket[key] ?? {};
      for (const [actionClass, level] of Object.entries(overrides)) {
        if (level === undefined) continue;
        const current = existing[actionClass as ActionClass];
        existing[actionClass as ActionClass] =
          current === undefined ? level : moreRestrictive(current, level);
      }
      bucket[key] = existing;
    }
  }

  return out;
}

const AUTONOMY_ORDER: AutonomyLevel[] = [
  'forbidden',
  'draft_only',
  'approve_required',
  'auto_notify',
  'auto',
];

function moreRestrictive(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_ORDER.indexOf(a) <= AUTONOMY_ORDER.indexOf(b) ? a : b;
}


export type { AgentId };
