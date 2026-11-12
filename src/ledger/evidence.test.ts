/**
 * `closeLedgerByEvidence` — a mail from the counterparty closes the item and
 * the owner is always told who the sender was.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { closeLedgerByEvidence } from './evidence.js';
import { renderEvidenceNotice } from './render.js';
import { LEDGER_DEFAULTS, saveLedgerSettings } from './settings.js';
import { createLedgerItem, listLedgerEvents, listLedgerItems, moveLedgerStatus, type NewLedgerItem } from './store.js';

const B = 'test-business';
let seq = 0;

function base(over: Partial<NewLedgerItem> = {}): NewLedgerItem {
  return {
    family: 'awaiting_reply',
    description: 'תשובה מדנה על ההצעה',
    dueAt: null,
    dueIsDateOnly: false,
    importance: 'normal',
    importanceManual: false,
    counterpartyName: 'דנה',
    counterpartyEmail: 'dana@acme.co.il',
    counterpartyEmailVerified: true,
    counterpartyDomain: null,
    reference: null,
    amountMinor: null,
    stages: [],
    proposedStages: null,
    originJobId: 'J-1',
    ...over,
  };
}

async function statusOf(itemId: string): Promise<string | undefined> {
  const all = await withBusiness(B, (db) => listLedgerItems(db));
  return all.find((i) => i.itemId === itemId)?.status;
}

async function addMail(o: {
  from: string;
  subject?: string;
  body?: string | null;
  createdAt: Date;
  businessId?: string;
}): Promise<string> {
  seq += 1;
  const id = `M-${seq}`;
  await testDb().query(
    `INSERT INTO mail_messages (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
                                received_at, body_text, created_at)
     VALUES ($1, $2, $3, 'T', $4, $5, $6, $7, $6)`,
    [id, o.businessId ?? B, `P-${seq}`, o.from, o.subject ?? 'מענה', o.createdAt, o.body ?? null],
  );
  return id;
}

async function setEvidenceAfter(itemId: string, at: Date): Promise<void> {
  await testDb().query(`UPDATE ledger_items SET evidence_after = $2 WHERE item_id = $1`, [itemId, at]);
}

const T0 = new Date('2026-11-01T08:00:00Z');
const T1 = new Date('2026-11-01T09:00:00Z');
const T2 = new Date('2026-11-01T10:00:00Z');

function recorders() {
  const emails: { subject: string; body: string }[] = [];
  const texts: string[] = [];
  const messenger: BossMessenger = {
    channel: 'whatsapp',
    async send(input) {
      texts.push(input.text);
      return { ok: true };
    },
  };
  const sendAlert = async (subject: string, body: string) => {
    emails.push({ subject, body });
    return { ok: true };
  };
  return { emails, texts, messenger, sendAlert };
}

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(B, (db) => saveLedgerSettings(
    db,
    { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes }, meetingLeadMinutesCritical: [1440, 60], toWhatsApp: true },
    { updatedBy: 'owner' },
  ));
});
afterAll(async () => {
  await closePool();
});

describe('closeLedgerByEvidence', () => {
  it('closes an awaiting_reply item on a mail from the counterparty', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    const mailId = await addMail({ from: 'Dana@Acme.co.il', createdAt: T1 });
    const r = recorders();
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db, { sendAlert: r.sendAlert, messenger: r.messenger }));
    expect(res.closed).toEqual([{ itemId: item.itemId, mailId }]);
    expect(await statusOf(item.itemId)).toBe('closed_by_evidence');
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.at(-1)).toMatchObject({ kind: 'closed_by_evidence', mailId, byWhom: 'evidence' });
    // Email goes now; WhatsApp is NOT sent here (I5): the notice is handed to
    // the ledger pass, which puts it first in the pass's single batch.
    const { rows } = await testDb().query(`SELECT slot, email_state, whatsapp_state FROM ledger_reminders`);
    expect(rows).toEqual([{ slot: `evidence:${mailId}`, email_state: 'sent', whatsapp_state: null }]);
    expect(r.texts).toHaveLength(0);
    const batch = await testDb().query(`SELECT 1 FROM ledger_whatsapp_batches`);
    expect(batch.rowCount).toBe(0);
    expect(res.notices).toHaveLength(1);
    expect(res.notices[0]).toMatchObject({ itemId: item.itemId, from: 'Dana@Acme.co.il' });
    expect(res.notices[0]?.reminderId).toMatch(/^LR-/);
  });

  it('returns no WhatsApp notice when WhatsApp is not chosen', async () => {
    await withBusiness(B, (db) => saveLedgerSettings(
      db,
      { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes }, meetingLeadMinutesCritical: [1440, 60], toWhatsApp: false },
      { updatedBy: 'owner' },
    ));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toHaveLength(1); // it ran and closed
    expect(res.notices).toEqual([]);
  });

  it('does not close on a mail older than evidence_after', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T2);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1 });
    await addMail({ from: 'dana@acme.co.il', createdAt: T2 }); // strictly after: equal does not count
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([]);
    expect(res.considered).toBe(1); // the item was examined
    expect(await statusOf(item.itemId)).toBe('open');
  });

  it('money_in without reference never closes', async () => {
    const noRef = await withBusiness(B, (db) => createLedgerItem(db, base({ family: 'money_in', reference: null }), { by: 'owner' }));
    const withRef = await withBusiness(B, (db) => createLedgerItem(db, base({ family: 'money_in', reference: 'INV-77' }), { by: 'owner' }));
    await setEvidenceAfter(noRef.itemId, T0);
    await setEvidenceAfter(withRef.itemId, T0);
    const mailId = await addMail({ from: 'dana@acme.co.il', subject: 'לגבי INV-77', createdAt: T1 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([{ itemId: withRef.itemId, mailId }]);
    expect(res.considered).toBe(2); // the no-reference item was examined and refused on its own rule
    expect(await statusOf(noRef.itemId)).toBe('open');
  });

  it('money_in closes only when the reference appears', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base({ family: 'money_in', reference: 'INV-77' }), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', subject: 'שלום', body: 'INV-78 שולם', createdAt: T1 });
    const miss = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(miss.closed).toEqual([]);
    expect(miss.considered).toBe(1);
    const hit = await addMail({ from: 'dana@acme.co.il', subject: 'x', body: 'שולם inv-77 היום', createdAt: T2 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([{ itemId: item.itemId, mailId: hit }]);
  });

  it('an unverified address is not evidence; the same address verified is', async () => {
    const unverified = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ counterpartyEmail: 'dana@acme.co.il', counterpartyEmailVerified: false, counterpartyDomain: null }),
      { by: 'owner' },
    ));
    await setEvidenceAfter(unverified.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.considered).toBe(1); // examined, and refused on the unverified address
    expect(res.closed).toEqual([]);
    expect(await statusOf(unverified.itemId)).toBe('open');

    await testDb().query(`UPDATE ledger_items SET counterparty_email_verified = true WHERE item_id = $1`, [
      unverified.itemId,
    ]);
    const again = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(again.closed.map((c) => c.itemId)).toEqual([unverified.itemId]);
  });

  it('an unverified address falls back to the vouched domain', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ counterpartyEmail: 'dana@evil.example', counterpartyEmailVerified: false, counterpartyDomain: 'acme.co.il' }),
      { by: 'owner' },
    ));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@evil.example', createdAt: T1 });
    const mailId = await addMail({ from: 'bob@acme.co.il', createdAt: T2 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([{ itemId: item.itemId, mailId }]);
  });

  it('domain match accepts a subdomain', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ counterpartyEmail: null, counterpartyEmailVerified: false, counterpartyDomain: 'acme.co.il' }),
      { by: 'owner' },
    ));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'x@evilacme.co.il', createdAt: T1 }); // lookalike, not a subdomain
    const mailId = await addMail({ from: 'bob@mail.acme.co.il', createdAt: T2 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([{ itemId: item.itemId, mailId }]);
  });

  it('the notice names the sender', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'תשובה מדנה' }), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', subject: 'שורה 1\nשורה 2', createdAt: T1 });
    const r = recorders();
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db, { sendAlert: r.sendAlert, messenger: r.messenger }));
    const expectedEmail =
      "סגרתי 'תשובה מדנה' — הגיע מייל מ-dana@acme.co.il: שורה 1 שורה 2. אם זה לא נכון, אפשר לפתוח מחדש בדשבורד.";
    const expectedWa =
      "סגרתי 'תשובה מדנה' — הגיע מייל מ-dana@acme.co.il: שורה 1 שורה 2. אם זה לא נכון, השיבי '3 פתחי'.";
    expect(r.emails).toHaveLength(1);
    expect(r.emails[0]?.body).toContain(expectedEmail);
    const notice = res.notices[0];
    if (notice === undefined) throw new Error('expected a notice');
    // The number is the notice's real position in the batch it lands in.
    expect(renderEvidenceNotice(notice, 'whatsapp', 3)).toBe(expectedWa);
    const { rows } = await testDb().query(`SELECT body FROM ledger_reminders`);
    expect(rows[0].body).toContain('dana@acme.co.il');
  });

  it('reopen then rerun does not close again on the same mail', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: new Date(Date.now() - 60_000) });
    const first = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(first.closed).toHaveLength(1);
    expect(
      await withBusiness(B, (db) => moveLedgerStatus(
        db,
        item.itemId,
        ['closed_by_evidence'],
        'open',
        { kind: 'reopened', by: 'owner' },
      )),
    ).toBe(true);
    const second = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(second.closed).toEqual([]);
    expect(second.skipped).toBe(0); // rejected by evidence_after, not by the claim fallback
    expect(second.considered).toBe(1); // the item was examined and the old mail rejected
    expect(await statusOf(item.itemId)).toBe('open');
    const { rows } = await testDb().query(`SELECT count(*)::int AS n FROM ledger_reminders`);
    expect(rows[0].n).toBe(1);
  });

  it('an item with neither email nor domain is never closed but is considered', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ counterpartyEmail: null, counterpartyEmailVerified: false, counterpartyDomain: null }),
      { by: 'owner' },
    ));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1 });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.considered).toBe(1);
    expect(res.closed).toEqual([]);
    expect(await statusOf(item.itemId)).toBe('open');
  });

  it("another business's mail never matches", async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1, businessId: 'other-business' });
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db));
    expect(res.closed).toEqual([]);
    expect(res.considered).toBe(1);
    expect(await statusOf(item.itemId)).toBe('open');
  });

  it('a lost race sends nothing and counts skipped', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'owner' }));
    await setEvidenceAfter(item.itemId, T0);
    await addMail({ from: 'dana@acme.co.il', createdAt: T1 });
    const r = recorders();
    let calls = 0;
    const res = await withBusiness(B, (db) => closeLedgerByEvidence(db, {
      sendAlert: r.sendAlert,
      messenger: r.messenger,
      beforeMove: async () => {
        calls += 1;
        await withBusiness(B, (db) => moveLedgerStatus(db, item.itemId, ['open'], 'done', { kind: 'done', by: 'owner' }));
      },
    }));
    expect(calls).toBe(1);
    expect(res.closed).toEqual([]);
    expect(res.skipped).toBe(1);
    expect(r.emails).toHaveLength(0);
    expect(r.texts).toHaveLength(0);
    const { rows } = await testDb().query(`SELECT count(*)::int AS n FROM ledger_reminders`);
    expect(rows[0].n).toBe(0);
  });
});
