/**
 * Test-only: run the gate for a named business without each test opening its
 * own `withBusiness`. A context may still carry its own `db` (a test that
 * drives a racing connection), in which case that one is used as is.
 */
import { withBusiness, type BusinessDb } from '../db/pool.js';
import type { PolicyDecision } from '../domain/policy.js';
import { evaluateToolCall, type GateContext } from '../policy/engine.js';

export type TestGateContext = Omit<GateContext, 'db'> & { businessId: string; db?: BusinessDb };

export async function evaluateFor(
  toolName: string,
  toolInput: unknown,
  ctx: TestGateContext,
): Promise<PolicyDecision> {
  const { businessId, db, ...rest } = ctx;
  if (db !== undefined) return evaluateToolCall(toolName, toolInput, { ...rest, db });
  return withBusiness(businessId, (own) => evaluateToolCall(toolName, toolInput, { ...rest, db: own }));
}
