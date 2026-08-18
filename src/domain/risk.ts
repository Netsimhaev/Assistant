import { z } from 'zod';
import { ActionClass, Reversibility } from './action.js';
import { DataClass } from './charter.js';
import { TrustLevel } from './trust.js';

/**
 * Which historical distribution an action's novelty was measured against.
 * The NormsEngine keeps rolling distributions per metric; a z-score above 3
 * pushes an action into the `anomalous` band even when every declared rule
 * permits it. The charter says what is *allowed*; the profile says what is
 * *usual* (docs/05-approvals.md).
 */
export const NormMetric = z.enum([
  'order_qty_for_sku',
  'order_value_for_supplier',
  'discount_pct_for_customer',
  'quote_value_for_segment',
  'outbound_volume_per_day',
  'reply_length_for_channel',
  'first_contact_hour',
  'new_counterparty_rate',
]);
export type NormMetric = z.infer<typeof NormMetric>;

export const RiskBand = z.enum(['routine', 'sensitive', 'anomalous', 'blocked']);
export type RiskBand = z.infer<typeof RiskBand>;

const Score = z.number().min(0).max(100);

export const RiskDimensions = z.object({
  money: z.object({
    amountMinor: z.number().int().nonnegative(),
    pctOfDailyCeiling: z.number().min(0),
    score: Score,
  }),
  reversibility: z.object({ class: Reversibility, score: Score }),
  externalVisibility: z.object({
    audience: z.enum(['internal', 'one_known', 'one_unknown', 'many', 'public']),
    score: Score,
  }),
  dataSensitivity: z.object({
    classes: z.array(DataClass),
    leavesInstance: z.boolean(),
    score: Score,
  }),
  novelty: z.object({
    metric: NormMetric.nullable(),
    /** Robust z-score: (value - median) / MAD. Business data is heavy-tailed. */
    z: z.number(),
    precedentIds: z.array(z.string()),
    score: Score,
  }),
  provenance: z.object({
    level: TrustLevel,
    chainDepth: z.number().int().nonnegative(),
    score: Score,
  }),
  charterFit: z.object({
    verdict: z.enum(['within', 'ambiguous', 'violates']),
    citedRuleIds: z.array(z.string()),
    score: Score,
  }),
});
export type RiskDimensions = z.infer<typeof RiskDimensions>;

export const RiskAssessment = z.object({
  actionId: z.string(),
  actionClass: ActionClass,
  dimensions: RiskDimensions,
  /** Weighted total, 0–100. */
  total: Score,
  band: RiskBand,
  /** Six of seven dimensions are pure code; the model is a second opinion only. */
  decidedBy: z.enum(['rules', 'rules+haiku', 'rules+opus']),
  /** One sentence, shown to the boss on the approval card. */
  explanation: z.string(),
  suggestedApprovers: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessment>;

/**
 * Relative weight of each dimension in the total. Money and charter fit carry
 * the most, because they are the two that map most directly to real damage.
 */
export const DIMENSION_WEIGHTS = {
  money: 0.25,
  reversibility: 0.15,
  externalVisibility: 0.1,
  dataSensitivity: 0.1,
  novelty: 0.2,
  provenance: 0.1,
  charterFit: 0.1,
} as const satisfies Record<keyof RiskDimensions, number>;

export const ROUTINE_MAX_TOTAL = 25;
export const SENSITIVE_MAX_TOTAL = 60;
/** Above this z-score an action is anomalous no matter what the rules say. */
export const ANOMALY_Z_THRESHOLD = 3;
