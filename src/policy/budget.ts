import { config } from '../config.js';
import type { ActionFacts, CompiledCeilings } from '../domain/policy.js';
import { getPool, type Queryable } from '../db/pool.js';
import { formatMinor } from '../util/money.js';

export type BudgetVerdict =
  | { permitted: true }
  | { permitted: false; code: string; reason: string };

interface SpendWindow {
  daily: number;
  monthly: number;
}

/**
 * Sum committed spend over the rolling windows.
 *
 * Summing the ledger rather than keeping a running counter is deliberate: a
 * counter that a crash leaves stale is a ceiling that silently stops holding.
 * The ledger is the source of truth and the sum is always recomputable.
 */
async function spentInWindows(
  businessId: string,
  db: Queryable,
): Promise<SpendWindow> {
  const { rows } = await db.query<{ daily: string | null; monthly: string | null }>(
    `SELECT
       COALESCE(SUM(amount_minor) FILTER (WHERE at >= now() - interval '1 day'), 0)   AS daily,
       COALESCE(SUM(amount_minor) FILTER (WHERE at >= now() - interval '30 days'), 0) AS monthly
     FROM spend_ledger
     WHERE business_id = $1`,
    [businessId],
  );

  const row = rows[0];
  return {
    daily: Number(row?.daily ?? 0),
    monthly: Number(row?.monthly ?? 0),
  };
}

/**
 * The money gate.
 *
 * Checked in ascending order of scope so the denial names the tightest limit
 * that actually stopped the action — "over the per-action cap for quote.issue"
 * is actionable, "over budget" is not.
 *
 * A denial here is terminal for the step: unlike a risk-band escalation it does
 * not become an approval, because a ceiling the owner signed is not something
 * an in-the-moment approval should quietly raise.
 */
export async function checkBudget(
  facts: ActionFacts,
  ceilings: CompiledCeilings,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<BudgetVerdict> {
  if (facts.actionClass === null) {
    return { permitted: true };
  }

  // The discount ceiling is checked before the zero-amount short-circuit and
  // not after it. A discount is a percentage, and the tool call that grants one
  // carries no `amountMinor` at all — so an early return on `amountMinor === 0`
  // skipped this check entirely and let a 90% discount through a 10% cap.
  if (
    facts.actionClass === 'discount.grant' &&
    facts.discountPercent > ceilings.maxDiscountPercent
  ) {
    return {
      permitted: false,
      code: 'budget_exceeded:discount',
      reason:
        `discounts are capped at ${ceilings.maxDiscountPercent}%; this one is ${facts.discountPercent}%`,
    };
  }

  if (facts.amountMinor === 0) {
    return { permitted: true };
  }

  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const perClass = ceilings.perActionClassMinor[facts.actionClass];
  if (perClass !== undefined && facts.amountMinor > perClass) {
    return {
      permitted: false,
      code: `budget_exceeded:per_action_class:${facts.actionClass}`,
      reason:
        `${facts.actionClass} is capped at ${formatMinor(perClass, ceilings.currency)} per action; ` +
        `this one is ${formatMinor(facts.amountMinor, ceilings.currency)}`,
    };
  }

  if (facts.amountMinor > ceilings.singleActionMinor) {
    return {
      permitted: false,
      code: 'budget_exceeded:single_action',
      reason:
        `a single action is capped at ${formatMinor(ceilings.singleActionMinor, ceilings.currency)}; ` +
        `this one is ${formatMinor(facts.amountMinor, ceilings.currency)}`,
    };
  }

  // Per-supplier auto-order ceiling. The charter compiles one of these for every
  // approved supplier, and until now nothing compared it to anything: the owner
  // could sign "auto-order up to ₪500 from this supplier" and the number was
  // never read.
  //
  // Only *approved* suppliers are capped here. A supplier absent from the list
  // is not denied at this step — that is not a budget question, and the risk
  // layer already treats an unrecognised counterparty as sensitive. Denying
  // here would be terminal and would silently forbid every first-time purchase.
  if (facts.supplierId !== null) {
    const supplierCeiling = ceilings.approvedSupplierCeilingMinor[facts.supplierId];
    if (supplierCeiling !== undefined && facts.amountMinor > supplierCeiling) {
      return {
        permitted: false,
        code: `budget_exceeded:supplier:${facts.supplierId}`,
        reason:
          `auto-ordering from ${facts.supplierId} is capped at ` +
          `${formatMinor(supplierCeiling, ceilings.currency)}; ` +
          `this one is ${formatMinor(facts.amountMinor, ceilings.currency)}`,
      };
    }
  }

  const spent = await spentInWindows(businessId, db);

  if (spent.daily + facts.amountMinor > ceilings.dailyMinor) {
    return {
      permitted: false,
      code: 'budget_exceeded:daily',
      reason:
        `the daily ceiling is ${formatMinor(ceilings.dailyMinor, ceilings.currency)}; ` +
        `${formatMinor(spent.daily, ceilings.currency)} already committed today and this adds ` +
        `${formatMinor(facts.amountMinor, ceilings.currency)}`,
    };
  }

  if (spent.monthly + facts.amountMinor > ceilings.monthlyMinor) {
    return {
      permitted: false,
      code: 'budget_exceeded:monthly',
      reason:
        `the monthly ceiling is ${formatMinor(ceilings.monthlyMinor, ceilings.currency)}; ` +
        `${formatMinor(spent.monthly, ceilings.currency)} already committed and this adds ` +
        `${formatMinor(facts.amountMinor, ceilings.currency)}`,
    };
  }

  return { permitted: true };
}

/**
 * Record committed spend.
 *
 * The idempotency key is derived from (jobId, stepId, canonicalInputHash), so a
 * retry after an uncertain timeout cannot double-count. The unique constraint
 * does the enforcing; this returns false when the row already existed.
 */
export async function recordSpend(
  entry: {
    jobId: string | null;
    actionClass: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    auditSeq?: bigint;
  },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<boolean> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rowCount } = await db.query(
    `INSERT INTO spend_ledger
       (business_id, job_id, action_class, amount_minor, currency, idempotency_key, audit_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING`,
    [
      businessId,
      entry.jobId,
      entry.actionClass,
      entry.amountMinor,
      entry.currency,
      entry.idempotencyKey,
      entry.auditSeq ?? null,
    ],
  );
  return (rowCount ?? 0) > 0;
}

