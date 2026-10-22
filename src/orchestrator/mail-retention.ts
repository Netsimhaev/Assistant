/**
 * The 365-day mail body retention (spec §5.7).
 *
 * After a year the body text of a mail is emptied: `body_text = NULL`,
 * `body_scrubbed_at` set. Everything else stays — sender, subject, the
 * model's summary, the attachments list (its `documentId`s are what the mail
 * screen downloads by), the invoices and the documents. The raw MIME is never
 * stored in the first place (§5.7), so there is no second copy to clear.
 *
 * **One audit row per pass that scrubbed something, carrying the count and
 * nothing else** (`mail_retention:<n>`) — the same rule an owner-ordered
 * erasure keeps: a row naming what was removed would make the audit log the
 * one place it survives. A pass that scrubbed nothing writes nothing: this
 * runs every scheduler pass, and a row every thirty seconds saying "0" would
 * bury the trail it is meant to be part of.
 *
 * **The scrub and its audit row are one transaction.** `appendAudit` joins
 * the caller's transaction when handed one (its advisory lock is
 * transaction-scoped), so a failed append rolls the scrub back and the next
 * pass tries again — bodies are never emptied without the record saying so.
 * This is the opposite trade from `executeErasure`, which cannot roll its
 * file deletions back; here everything is in the database.
 *
 * `kind: 'erasure'` (the kind whose contract is "counts, never identity"),
 * `actor: 'system'`, `provenance: 'boss'` and `charterVersion: 'n/a'`: a
 * retention pass is a fact about the installation, not about any chain of
 * content, the same reasoning `recordWhatsAppHealthNotifyFailure`
 * (`scheduler.ts`) and `executeErasure` already give for those values.
 */
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';

export const MAIL_BODY_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function scrubOldMailBodies(
  options: { businessId?: string; now?: Date } = {},
): Promise<{ scrubbed: number }> {
  const businessId = options.businessId ?? config.businessId;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - MAIL_BODY_RETENTION_DAYS * DAY_MS);

  const client = await getPool().connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE mail_messages SET body_text = NULL, body_scrubbed_at = $3
        WHERE business_id = $1 AND received_at < $2 AND body_text IS NOT NULL`,
      [businessId, cutoff.toISOString(), now.toISOString()],
    );
    const scrubbed = rowCount ?? 0;
    if (scrubbed > 0) {
      await appendAudit(
        {
          actor: 'system',
          kind: 'erasure',
          charterVersion: 'n/a',
          provenance: 'boss',
          inputHash: canonicalHash({ event: 'mail_retention', scrubbed }),
          reason: `mail_retention:${scrubbed}`,
        },
        { businessId, tx: client },
      );
    }
    await client.query('COMMIT');
    return { scrubbed };
  } catch (error) {
    failed = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the one to surface.
    }
    throw error;
  } finally {
    client.release(failed);
  }
}
