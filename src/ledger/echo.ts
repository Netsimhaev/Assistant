/**
 * The ledger echo of a plan, with the descriptions of the items its
 * `ledger.update` steps name (spec F-I4c) read from the store. One function
 * for every place the owner reads it: the planned outcome, the boss-command
 * confirmation question (T6) and its re-ask.
 */
import type { BusinessDb } from '../db/pool.js';
import type { PlanStep } from '../domain/plan.js';
import { renderLedgerEcho, type LedgerEchoOptions } from './render.js';
import { loadLedgerItem } from './store.js';

export async function ledgerEchoForSteps(
  db: BusinessDb,
  steps: readonly PlanStep[],
  o: Omit<LedgerEchoOptions, 'itemDescriptions'>,
): Promise<string | null> {
  const itemDescriptions = new Map<string, string>();
  for (const step of steps) {
    if (step.toolName !== 'ledger.update') continue;
    const itemId = step.input['itemId'];
    if (typeof itemId !== 'string' || itemId === '' || itemDescriptions.has(itemId)) continue;
    const item = await loadLedgerItem(db, itemId);
    if (item !== null) itemDescriptions.set(itemId, item.description);
  }
  return renderLedgerEcho(steps, {
    timeZone: o.timeZone,
    currency: o.currency,
    instructionText: o.instructionText,
    textOrigin: o.textOrigin,
    knownCounterparties: o.knownCounterparties,
    itemDescriptions,
  });
}
