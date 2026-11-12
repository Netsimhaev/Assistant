/**
 * `runLedgerPass` — claim each due reminder slot once, then tell the owner by
 * email (one per reminder), WhatsApp (one numbered batch per pass) and screen.
 *
 * Every pass gets an explicit `now`, so the due slot is deterministic: a
 * date-only `money_in` item due on 2026-11-03 has exactly one slot, `due` at
 * 08:00 Asia/Jerusalem (06:00Z), and a pass at 10:00Z is inside its window.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { LedgerItem } from '../domain/ledger.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { LEDGER_DEFAULTS, loadLedgerSettings, saveLedgerSettings, type LedgerSettings } from './settings.js';
import { dueSlots } from './schedule.js';
import { runLedgerPass, sendLedgerBatch } from './pass.js';
import { createLedgerItem, listLedgerEvents, moveLedgerStatus, type NewLedgerItem } from './store.js';
import { LEDGER_BATCH_FOOTER } from './render.js';

const B = 'test-business';
const NOW = new Date('2026-11-03T10:00:00Z');
const TZ = 'Asia/Jerusalem';

function base(over: Partial<NewLedgerItem> = {}): NewLedgerItem {
  return {
    family: 'money_in',
    description: 'חשבונית 123 של דנה',
    dueAt: new Date('2026-11-02T22:00:00Z'), // 2026-11-03 local, date-only
    dueIsDateOnly: true,
    importance: 'normal',
    importanceManual: false,
    counterpartyName: 'דנה',
    counterpartyEmail: 'dana@acme.co.il',
    counterpartyEmailVerified: true,
    counterpartyDomain: 'acme.co.il',
    reference: null,
    amountMinor: 150000,
    stages: [],
    proposedStages: null,
    originJobId: 'J-1',
    ...over,
  };
}

interface Sent {
  subject: string;
  body: string;
}

function recordingAlert(sent: Sent[], ok = true) {
  return async (subject: string, body: string) => {
    sent.push({ subject, body });
    return ok ? { ok: true } : { ok: false, error: 'smtp down' };
  };
}

function recordingMessenger(texts: string[], ok = true): BossMessenger {
  return {
    channel: 'whatsapp',
    async send(input) {
      texts.push(input.text);
      return ok ? { ok: true } : { ok: false, error: 'bridge down' };
    },
  };
}

async function setSettings(over: Partial<LedgerSettings>): Promise<void> {
  await withBusiness(B, (db) => saveLedgerSettings(
    db,
    { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes }, meetingLeadMinutesCritical: [1440, 60], ...over },
    { updatedBy: 'owner' },
  ));
}

interface ReminderRow {
  reminder_id: string;
  item_id: string;
  kind: string;
  body: string;
  email_state: string | null;
  whatsapp_state: string | null;
  seen_at: Date | null;
}

async function reminders(): Promise<ReminderRow[]> {
  const { rows } = await testDb().query<ReminderRow>(
    `SELECT reminder_id, item_id, kind, body, email_state, whatsapp_state, seen_at
       FROM ledger_reminders WHERE business_id = $1 ORDER BY created_at, reminder_id`,
    [B],
  );
  return rows;
}

async function batches(): Promise<{ batch_id: string; items: string[]; sent_at: Date | null }[]> {
  const { rows } = await testDb().query<{ batch_id: string; items: string[]; sent_at: Date | null }>(
    `SELECT batch_id, items, sent_at FROM ledger_whatsapp_batches WHERE business_id = $1 ORDER BY created_at`,
    [B],
  );
  return rows;
}

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(B, (bdb) => installCharter(bdb, buildCharter({})));
});
afterAll(async () => {
  await closePool();
});

describe('runLedgerPass', () => {
  it('sends one reminder per due slot and records the states', async () => {
    const a = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const b = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'חשבונית 456' }), { by: 'boss' }));
    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));

    expect(result.reminded).toBe(2);
    expect(result.errored).toEqual([]);
    expect(sent).toHaveLength(2);
    const rows = await reminders();
    expect(rows.map((r) => r.item_id).sort()).toEqual([a.itemId, b.itemId].sort());
    for (const r of rows) {
      expect(r.kind).toBe('due');
      expect(r.email_state).toBe('sent');
      // WhatsApp not chosen by default: NULL, not "skipped".
      expect(r.whatsapp_state).toBeNull();
      // Screen: unseen until /ledger is opened.
      expect(r.seen_at).toBeNull();
      expect(r.body).toContain('תזכורת:');
    }
    const events = await withBusiness(B, (db) => listLedgerEvents(db, a.itemId));
    expect(events.map((e) => e.kind)).toEqual(['created', 'reminded']);
  });

  it('a second pass sends nothing', async () => {
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const sent: Sent[] = [];
    const first = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
    expect(first.reminded).toBe(1);
    const second = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
    expect(second.reminded).toBe(0);
    // The slot was found and lost to the earlier claim — it ran, it did not send.
    expect(second.skipped).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await reminders()).toHaveLength(1);
  });

  it('two concurrent passes send once', async () => {
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const sent: Sent[] = [];
    const [r1, r2] = await Promise.all([
      withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) })),
      withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) })),
    ]);
    expect(sent).toHaveLength(1);
    expect(r1.reminded + r2.reminded).toBe(1);
    expect(r1.skipped + r2.skipped).toBe(1);
    expect(await reminders()).toHaveLength(1);
  });

  it('WhatsApp batches all reminders into one numbered message and stamps sent_at only on ok', async () => {
    await setSettings({ toWhatsApp: true, toEmail: false });
    const a = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'ראשונה' }), { by: 'boss' }));
    const b = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'שנייה' }), { by: 'boss' }));
    const texts: string[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, messenger: recordingMessenger(texts) }));

    expect(result.reminded).toBe(2);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('1. ');
    expect(text).toContain('2. ');
    expect(text.trimEnd().endsWith(LEDGER_BATCH_FOOTER)).toBe(true);
    const rows = await reminders();
    for (const r of rows) {
      expect(r.whatsapp_state).toBe('sent');
      expect(r.email_state).toBeNull();
      expect(text).toContain(`מזהה תזכורת: ${r.reminder_id}`);
    }
    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0]?.sent_at).not.toBeNull();
    // Numbering follows the stored order: items[n-1] is entry n.
    expect(bs[0]?.items).toHaveLength(2);
    expect(new Set(bs[0]?.items)).toEqual(new Set([a.itemId, b.itemId]));
    const firstItem = bs[0]?.items[0] === a.itemId ? 'ראשונה' : 'שנייה';
    expect(text.split('\n').find((l) => l.startsWith('1. '))).toContain(firstItem);
  });

  it('failed WhatsApp send leaves sent_at NULL', async () => {
    await setSettings({ toWhatsApp: true, toEmail: false });
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const texts: string[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, messenger: recordingMessenger(texts, false) }));
    // The send was attempted.
    expect(texts).toHaveLength(1);
    expect(result.whatsappFailed).toBe(1);
    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0]?.sent_at).toBeNull();
    expect((await reminders())[0]?.whatsapp_state).toBe('failed');
  });

  it('a hanging WhatsApp send is failed by the deadline', async () => {
    await setSettings({ toWhatsApp: true, toEmail: false });
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const messenger: BossMessenger = { channel: 'whatsapp', send: () => new Promise(() => {}) };
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, messenger, timeoutMs: 50 }));
    expect(result.whatsappFailed).toBe(1);
    expect((await batches())[0]?.sent_at).toBeNull();
  });

  it('a chosen channel with no seam is skipped_not_connected', async () => {
    await setSettings({ toWhatsApp: true, toEmail: true });
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW }));
    expect(result.reminded).toBe(1);
    expect(result.skippedNotConnected).toBe(2);
    const row = (await reminders())[0];
    expect(row?.email_state).toBe('skipped_not_connected');
    expect(row?.whatsapp_state).toBe('skipped_not_connected');
    // No batch row: nothing was sent, so nothing is answerable.
    expect(await batches()).toHaveLength(0);
  });

  it('critical reminder is marked', async () => {
    await withBusiness(B, (db) => createLedgerItem(db, base({ importance: 'critical' }), { by: 'boss' }));
    const sent: Sent[] = [];
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
    const due = sent.find((s) => s.body.includes('תזכורת:'));
    expect(due).toBeDefined();
    expect(due?.subject.startsWith('⚠️ ')).toBe(true);
    expect(due?.body.startsWith('⚠️ קריטי — ')).toBe(true);
  });

  it('the sent text carries the reminder id', async () => {
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const sent: Sent[] = [];
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent), dashboardBaseUrl: 'https://x.test/' }));
    const id = (await reminders())[0]?.reminder_id ?? 'missing';
    expect(sent[0]?.body).toContain(`מזהה תזכורת: ${id}`);
    expect(sent[0]?.body).toContain('https://x.test/ledger');
    // The stored body carries neither the link nor the id.
    expect((await reminders())[0]?.body).not.toContain('https://');
  });

  it('nothing is sent for a cancelled item', async () => {
    const cancelled = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'מבוטלת' }), { by: 'boss' }));
    await withBusiness(B, (db) => moveLedgerStatus(db, cancelled.itemId, ['open'], 'cancelled', { kind: 'cancelled', by: 'boss' }));
    const control = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'פתוחה' }), { by: 'boss' }));

    // The same item, were it open, would have a due slot in this pass.
    const settings = await withBusiness(B, (db) => loadLedgerSettings(db));
    const asOpen: LedgerItem = { ...cancelled, status: 'open' };
    expect(
      dueSlots(asOpen, settings, { now: NOW, timeZone: TZ, workweek: ['sun', 'mon', 'tue', 'wed', 'thu'], holidays: [], lastNudgeAt: null })
        .length,
    ).toBeGreaterThan(0);

    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
    // The pass ran: the open control item was reminded.
    expect(result.reminded).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('פתוחה');
    const rows = await reminders();
    expect(rows.map((r) => r.item_id)).toEqual([control.itemId]);
  });

  it('a remind-mode awaiting_reply item is nudged again after nudgeAfterBusinessDays, not once ever', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ family: 'awaiting_reply', description: 'תשובה מרונית', counterpartyName: 'רונית', dueAt: null, amountMinor: null }),
      { by: 'boss' },
    ));
    // Created Sunday 2026-11-01 10:00 local. Sun–Thu week, 3 business days → Wed 11-04 08:00 local.
    await testDb().query(`UPDATE ledger_items SET created_at = $2 WHERE item_id = $1`, [
      item.itemId,
      new Date('2026-11-01T08:00:00Z'),
    ]);
    const sent: Sent[] = [];
    const alert = recordingAlert(sent);

    const first = await withBusiness(B, (db) => runLedgerPass(db, { now: new Date('2026-11-04T07:00:00Z'), sendAlert: alert }));
    expect(first.reminded).toBe(1);
    expect(sent[0]?.body).toContain('הגיע הזמן לחזור לרונית');

    // Next business day is NOT a new nudge: the cadence is counted from the last one.
    const between = await withBusiness(B, (db) => runLedgerPass(db, { now: new Date('2026-11-08T07:00:00Z'), sendAlert: alert }));
    expect(between.reminded).toBe(0);

    // Thu 11-05, Sun 11-08, Mon 11-09 → Mon 08:00 local.
    const second = await withBusiness(B, (db) => runLedgerPass(db, { now: new Date('2026-11-09T07:00:00Z'), sendAlert: alert }));
    expect(second.reminded).toBe(1);
    expect(sent).toHaveLength(2);
    const rows = await reminders();
    expect(rows.map((r) => r.kind)).toEqual(['nudge', 'nudge']);
  });

  it('an act-mode nudge slot is left unclaimed for the nudge stage', async () => {
    await setSettings({ modes: { ...LEDGER_DEFAULTS.modes, awaiting_reply: 'act' } });
    const actItem = await withBusiness(B, (db) => createLedgerItem(
      db,
      base({ family: 'awaiting_reply', description: 'act', dueAt: null, amountMinor: null }),
      { by: 'boss' },
    ));
    await testDb().query(`UPDATE ledger_items SET created_at = $2 WHERE item_id = $1`, [
      actItem.itemId,
      new Date('2026-11-01T08:00:00Z'),
    ]);
    // A control in the same pass proves the pass ran.
    const control = await withBusiness(B, (db) => createLedgerItem(db, base({ dueAt: new Date('2026-11-03T22:00:00Z') }), {
      by: 'boss',
    }));
    const now = new Date('2026-11-04T07:00:00Z');
    const settings = await withBusiness(B, (db) => loadLedgerSettings(db));
    const slots = dueSlots({ ...actItem, createdAt: new Date('2026-11-01T08:00:00Z') }, settings, {
      now,
      timeZone: TZ,
      workweek: ['sun', 'mon', 'tue', 'wed', 'thu'],
      holidays: [],
      lastNudgeAt: null,
    });
    expect(slots.map((s) => s.kind)).toEqual(['nudge']);

    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now, sendAlert: recordingAlert(sent) }));
    expect(result.reminded).toBe(1);
    expect((await reminders()).map((r) => r.item_id)).toEqual([control.itemId]);
  });

  it('a pass with no active charter returns the empty result', async () => {
    await testDb().query(`DELETE FROM charter_active WHERE business_id = $1`, [B]);
    await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
    expect(result.reminded).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('an item whose claim fails is reported in errored and the next item is still reminded', async () => {
    const bad = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'רעה' }), { by: 'boss' }));
    const good = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'טובה' }), { by: 'boss' }));
    // A real DB failure on one item's claim, nothing stubbed in the pass.
    await testDb().query(`
      CREATE OR REPLACE FUNCTION test_ledger_reminder_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.item_id = '${bad.itemId}' THEN RAISE EXCEPTION 'boom for test'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_ledger_reminder_boom BEFORE INSERT ON ledger_reminders
        FOR EACH ROW EXECUTE FUNCTION test_ledger_reminder_boom();`);
    try {
      const sent: Sent[] = [];
      const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: recordingAlert(sent) }));
      expect(result.errored).toEqual([{ itemId: bad.itemId, error: expect.stringContaining('boom for test') }]);
      expect(result.reminded).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toContain('טובה');
      expect((await reminders()).map((r) => r.item_id)).toEqual([good.itemId]);
      // The failed claim rolled back with its event.
      expect((await withBusiness(B, (db) => listLedgerEvents(db, bad.itemId))).map((e) => e.kind)).toEqual(['created']);
    } finally {
      await testDb().query(`DROP TRIGGER IF EXISTS test_ledger_reminder_boom ON ledger_reminders;
        DROP FUNCTION IF EXISTS test_ledger_reminder_boom();`);
    }
  });

  it('a throwing email send is a failed channel, not a failed item', async () => {
    const bad = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'רעה' }), { by: 'boss' }));
    await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'טובה' }), { by: 'boss' }));
    const sent: Sent[] = [];
    const alert = async (subject: string, body: string) => {
      if (body.includes('רעה')) throw new Error('boom');
      return recordingAlert(sent)(subject, body);
    };
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, sendAlert: alert }));
    // A throwing send is a failed channel, not a failed item.
    expect(result.reminded).toBe(2);
    expect(result.emailFailed).toBe(1);
    expect(sent).toHaveLength(1);
    expect((await reminders()).find((r) => r.item_id === bad.itemId)?.email_state).toBe('failed');
  });
});

describe('sendLedgerBatch', () => {
  it('returns empty and writes nothing for no entries', async () => {
    const texts: string[] = [];
    const r = await withBusiness(B, (db) => sendLedgerBatch(db, [], { messenger: recordingMessenger(texts) }));
    expect(r).toEqual({ state: 'empty', batchId: null });
    expect(texts).toHaveLength(0);
    expect(await batches()).toHaveLength(0);
  });

  it('numbers entries 1-based in insertion order', async () => {
    const a = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const texts: string[] = [];
    const r = await withBusiness(B, (db) => sendLedgerBatch(
      db,
      [
        { itemId: a.itemId, text: 'אחת' },
        { itemId: 'LI-x', text: 'שתיים' },
      ],
      { messenger: recordingMessenger(texts) },
    ));
    expect(r.state).toBe('sent');
    expect(texts[0]).toContain('1. אחת');
    expect(texts[0]).toContain('2. שתיים');
    const bs = await batches();
    expect(bs[0]?.batch_id).toBe(r.batchId);
    expect(bs[0]?.items).toEqual([a.itemId, 'LI-x']);
  });
});
