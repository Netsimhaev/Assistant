/**
 * Evidence closure: an open ledger item is closed when a mail arrives that
 * is evidence the thing happened, and the owner is ALWAYS told who sent it.
 *
 * **Matching is deterministic SQL + JS, no model.** Only `status = 'open'`
 * items of the families `money_in`, `warm_leads`, `awaiting_reply` are
 * examined. A candidate mail is in the same business and strictly newer than
 * the item's `evidence_after` (which a reopen moves forward, so a reopened
 * item cannot be closed again by the very mail the owner just overruled).
 * The sender must be the counterparty: an exact (case-insensitive) address
 * when the item has a VERIFIED one, otherwise a domain/subdomain match when it
 * has a (vouched) domain; an unverified address is never evidence, and an
 * item with neither is never matched. A `reference`, when the
 * item has one, must appear (case-insensitive `position`, never `LIKE`) in
 * `subject || ' ' || coalesce(body_text, '')`. `money_in` REQUIRES a
 * reference: an address alone says someone wrote, not that they paid. The
 * earliest matching mail wins.
 *
 * **Claim, then move, in one transaction; send afterwards.** The
 * `evidence:<mailId>` reminder row is claimed (`ON CONFLICT DO NOTHING
 * RETURNING`) and the status moved in the same transaction; if the move loses
 * a race the claim is deleted again and the item counts as `skipped`. Only
 * after commit is anything sent, so a lost race never sends. Channel states
 * follow 040/047 exactly as in `pass.ts`.
 *
 * **Email is sent here; WhatsApp is not (spec I5).** A notice of its own
 * would be a second numbered batch in the same pass, re-pointing the numbers
 * the owner is about to answer. The WhatsApp notices are RETURNED
 * (`notices`) and `schedulerPass` hands them to `runLedgerPass`, which puts
 * them first in the pass's single batch and stamps their `whatsapp_state`.
 * No ledger pass that pass (no charter) → they are not sent on WhatsApp and
 * their state stays NULL; the email already went.
 *
 * **The sender and subject are attacker-controlled.** Both go through
 * `toOneLine` before they reach any text; the address is shown, never hidden.
 *
 * `considered` counts the open eligible items examined (including those
 * refused by their own rules, e.g. `money_in` without a reference), so a
 * negative test can prove the code ran.
 */
import { monotonicFactory } from 'ulid';
import { getPool, type Queryable } from '../db/pool.js';
import type { LedgerFamily, LedgerItem } from '../domain/ledger.js';
import { NOTIFY_TIMEOUT_MS } from '../governance/notify.js';
import { domainMatches, extractDomain } from '../util/address.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { deliver, type LedgerChannelState } from './pass.js';
import { renderEvidenceNotice, type EvidenceNoticeFacts } from './render.js';
import { loadLedgerSettings } from './settings.js';
import { atomically, listLedgerItems, moveLedgerStatus } from './store.js';

const ulid = monotonicFactory();

const EVIDENCE_FAMILIES: readonly LedgerFamily[] = ['money_in', 'warm_leads', 'awaiting_reply'];

/** A closure's WhatsApp notice, for the ledger pass to number and send. */
export interface EvidenceNotice extends EvidenceNoticeFacts {
  itemId: string;
  reminderId: string;
}

export interface EvidenceResult {
  closed: { itemId: string; mailId: string }[];
  /** Matches whose claim or status move lost a race. */
  skipped: number;
  /** Open eligible items examined this run. */
  considered: number;
  errored: { itemId: string; error: string }[];
  /** WhatsApp notices of this run's closures (empty unless WhatsApp is chosen). */
  notices: EvidenceNotice[];
}

export interface EvidenceOptions {
  businessId: string;
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  /** Accepted for symmetry with the pass; never used — WhatsApp goes through the pass's batch. */
  messenger?: BossMessenger;
  dashboardBaseUrl?: string;
  db?: Queryable;
  timeoutMs?: number;
  /** @internal Test seam: runs between finding the match and the claim+move. */
  beforeMove?: (itemId: string) => Promise<void>;
}

interface MailRow {
  mail_id: string;
  from_address: string;
  subject: string;
}

/** The earliest mail that is evidence for `item`, or null. */
async function findEvidence(db: Queryable, item: LedgerItem): Promise<MailRow | null> {
  // Only a VERIFIED address is evidence (security review S1): an unverified
  // one may have come from a memory a stranger's document wrote, and a mail
  // from it would close the owner's item. Unverified → the vouched domain,
  // when one is stored; otherwise no match.
  const email = item.counterpartyEmailVerified ? item.counterpartyEmail : null;
  if (email === null && item.counterpartyDomain === null) return null;
  if (item.family === 'money_in' && item.reference === null) return null;
  const params: unknown[] = [item.businessId, item.evidenceAfter];
  let where = 'business_id = $1 AND created_at > $2';
  if (email !== null) {
    params.push(email);
    where += ` AND lower(from_address) = lower($${params.length})`;
  }
  if (item.reference !== null) {
    params.push(item.reference);
    where += ` AND position(lower($${params.length}) in lower(subject || ' ' || coalesce(body_text, ''))) > 0`;
  }
  const { rows } = await db.query<MailRow>(
    `SELECT mail_id, from_address, subject FROM mail_messages
      WHERE ${where} ORDER BY created_at ASC, mail_id ASC`,
    params,
  );
  if (email !== null) return rows[0] ?? null;
  const pattern = item.counterpartyDomain;
  if (pattern === null) return null;
  for (const row of rows) {
    const domain = extractDomain(row.from_address);
    if (domain !== null && domainMatches(domain, pattern)) return row;
  }
  return null;
}

export async function closeLedgerByEvidence(o: EvidenceOptions): Promise<EvidenceResult> {
  const { businessId } = o;
  const db = o.db ?? getPool();
  const timeoutMs = o.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const result: EvidenceResult = { closed: [], skipped: 0, considered: 0, errored: [], notices: [] };
  const settings = await loadLedgerSettings({ businessId, db });
  const link =
    o.dashboardBaseUrl !== undefined && o.dashboardBaseUrl.length > 0
      ? `${o.dashboardBaseUrl.replace(/\/+$/, '')}/ledger`
      : null;

  const items = (await listLedgerItems({ businessId, db, statuses: ['open'] })).filter((i) =>
    EVIDENCE_FAMILIES.includes(i.family),
  );

  for (const item of items) {
    result.considered += 1;
    try {
      const mail = await findEvidence(db, item);
      if (mail === null) continue;
      if (o.beforeMove !== undefined) await o.beforeMove(item.itemId);

      const facts: EvidenceNoticeFacts = { description: item.description, from: mail.from_address, subject: mail.subject };
      const text = renderEvidenceNotice(facts, 'email');
      const slot = `evidence:${mail.mail_id}`;
      const reminderId = await atomically(o.db, async (tx) => {
        const inserted = await tx.query<{ reminder_id: string }>(
          `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body)
           VALUES ($1, $2, $3, $4, 'evidence', $5)
           ON CONFLICT (business_id, item_id, slot) DO NOTHING
           RETURNING reminder_id`,
          [`LR-${ulid()}`, businessId, item.itemId, slot, text],
        );
        const id = inserted.rows[0]?.reminder_id;
        if (id === undefined) return null;
        const moved = await moveLedgerStatus(
          item.itemId,
          ['open'],
          'closed_by_evidence',
          { kind: 'closed_by_evidence', by: 'evidence', mailId: mail.mail_id },
          { businessId, db: tx },
        );
        if (!moved) {
          await tx.query(`DELETE FROM ledger_reminders WHERE reminder_id = $1 AND business_id = $2`, [id, businessId]);
          return null;
        }
        return id;
      });
      if (reminderId === null) {
        result.skipped += 1;
        continue;
      }
      result.closed.push({ itemId: item.itemId, mailId: mail.mail_id });

      let emailState: LedgerChannelState | null = null;
      if (settings.toEmail) {
        const sendAlert = o.sendAlert;
        if (sendAlert === undefined) {
          emailState = 'skipped_not_connected';
        } else {
          const body = [text, '', ...(link === null ? [] : [`לפנקס: ${link}`]), `מזהה תזכורת: ${reminderId}`].join('\n');
          emailState = await deliver(() => sendAlert('סגרתי פריט בפנקס לפי מייל', body), timeoutMs);
        }
      }
      await db.query(`UPDATE ledger_reminders SET email_state = $3 WHERE reminder_id = $1 AND business_id = $2`, [
        reminderId,
        businessId,
        emailState,
      ]);
      if (settings.toWhatsApp) result.notices.push({ itemId: item.itemId, reminderId, ...facts });
    } catch (err) {
      result.errored.push({ itemId: item.itemId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
