/**
 * The sender's own open ledger rows. A row belongs to the sender only when it
 * carries a VERIFIED email equal to the sender's email: a domain match or an
 * unverified address (which may come from memory a stranger wrote) is not
 * ownership. No domain and no phone is ever a filter or shown.
 */
import { ledgerStatusLabel } from '../../domain/labels.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { localParts } from '../../util/local-time.js';
import { formatMinor } from '../../util/money.js';
import type { SourceItem, Tier2Source } from './types.js';

const MAX_ITEMS = 10;

interface Row {
  item_id: string;
  description: string;
  status: 'open' | 'stuck';
  due_at: Date | null;
  amount_minor: string | null;
  created_at: Date;
}

export const ledgerOfSender: Tier2Source = async (db, ids, _signal, ctx) => {
  if (ids.email === null) return { items: [], ownershipViolation: false };
  const { rows } = await db.query<Row>(
    `SELECT item_id, description, status, due_at, amount_minor, created_at
       FROM ledger_items
      WHERE business_id = $1 AND counterparty_email_verified = true
        AND lower(counterparty_email) = lower($2)
        AND status IN ('open','stuck')
      ORDER BY created_at DESC, item_id DESC
      LIMIT $3`,
    [db.businessId, ids.email, MAX_ITEMS],
  );
  const items: SourceItem[] = rows.map((r) => {
    const parts = [toOneLine(stripBidiControls(r.description)), ledgerStatusLabel[r.status]];
    if (r.due_at !== null) parts.push(`מועד: ${localParts(r.due_at, ctx.timeZone).date}`);
    if (r.amount_minor !== null && ctx.currency !== undefined) parts.push(formatMinor(Number(r.amount_minor), ctx.currency));
    return { source: 'ledger_of_sender', label: 'פנקס', text: parts.join(' · '), documentId: null, at: r.created_at.toISOString() };
  });
  return { items, ownershipViolation: false };
};
