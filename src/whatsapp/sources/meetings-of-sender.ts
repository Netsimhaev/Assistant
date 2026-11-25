/**
 * The sender's own meetings (the assistant's `meetings` rows), matched by the
 * sender's phone digits or email - never by anything the message says.
 * The table has no location column, so none is shown.
 */
import { localParts } from '../../util/local-time.js';
import type { SourceItem, Tier2Source } from './types.js';

const MAX_ITEMS = 10;
const RESPONSE_HE: Readonly<Record<string, string>> = Object.freeze({
  accepted: 'אישר',
  declined: 'דחה',
  tentative: 'ממתין לתשובה',
  needs_action: 'ממתין לתשובה',
  not_updated: 'לא עודכן',
});

interface Row {
  meeting_id: string;
  start_at: Date;
  response: string;
}

export const meetingsOfSender: Tier2Source = async (db, ids, _signal, ctx) => {
  const { rows } = await db.query<Row>(
    `SELECT meeting_id, start_at, response FROM meetings
      WHERE business_id = $1 AND state IN ('proposed','active')
        AND start_at IS NOT NULL AND start_at >= now() - interval '1 day'
        AND ( (client_phone IS NOT NULL AND regexp_replace(client_phone, '\\D', '', 'g') = $2)
           OR ($3::text IS NOT NULL AND client_email IS NOT NULL AND lower(client_email) = lower($3)) )
      ORDER BY start_at ASC, meeting_id ASC
      LIMIT $4`,
    [db.businessId, ids.key, ids.email, MAX_ITEMS],
  );
  const items: SourceItem[] = rows.map((r) => {
    const p = localParts(r.start_at, ctx.timeZone);
    return {
      source: 'meetings_of_sender',
      label: 'פגישות',
      text: `${p.date} ${p.time} · ${RESPONSE_HE[r.response] ?? 'ממתין לתשובה'}`,
      documentId: null,
      at: r.start_at.toISOString(),
    };
  });
  return { items, ownershipViolation: false };
};
