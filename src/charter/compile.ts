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
    doNotContact: charter.counterparties
      .filter((c) => c.doNotContact)
      .map((c) => c.match.entityId ?? c.match.emailDomain ?? c.match.phone ?? c.match.tag)
      .filter((key): key is string => key !== undefined),

    allowlists: AGENT_ALLOWLISTS,
    denylists: AGENT_DENYLISTS,
    collaborationGraph: COLLABORATION_GRAPH,

    promptFragments: renderPromptFragments(charter),
    plainLanguage: renderPlainLanguage(charter),
  };
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
): Record<string, Partial<Record<ActionClass, AutonomyLevel>>> {
  const out: Record<string, Partial<Record<ActionClass, AutonomyLevel>>> = {};

  for (const counterparty of charter.counterparties) {
    const overrides = counterparty.autonomyOverrides;
    if (Object.keys(overrides).length === 0) continue;

    for (const key of [
      counterparty.match.entityId,
      counterparty.match.emailDomain,
      counterparty.match.phone,
      counterparty.match.tag,
    ]) {
      if (key === undefined) continue;
      // A later rule matching the same key tightens rather than replaces: two
      // rules that both apply should not let ordering decide the outcome.
      const existing = out[key] ?? {};
      for (const [actionClass, level] of Object.entries(overrides)) {
        if (level === undefined) continue;
        const current = existing[actionClass as ActionClass];
        existing[actionClass as ActionClass] =
          current === undefined ? level : moreRestrictive(current, level);
      }
      out[key] = existing;
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
