/**
 * `schedulerPass` ledger wiring — evidence closes before reminders, the two
 * ledger stages are isolated from the rest of the pass, and both report
 * `null` (did not run) when no charter is active.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { envCredentials } from '../orchestrator/credentials.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { schedulerPass } from '../orchestrator/scheduler.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { LEDGER_DEFAULTS, saveLedgerSettings } from './settings.js';
import { createLedgerItem, type NewLedgerItem } from './store.js';

const B = 'test-business';
// A Wednesday, 09:00 local: well inside the nudge window of an item created 2026-11-01.
const NOW = new Date('2026-11-04T07:00:00Z');

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

function emptyRuntime(emails: { subject: string; body: string }[] = []): Runtime {
  return {
    registry: new AdapterRegistry([]),
    credentials: envCredentials({}, 'LEDGER_TEST_'),
    warnings: [],
    notify: {
      sendAlert: async (subject: string, body: string) => {
        emails.push({ subject, body });
        return { ok: true };
      },
      dashboardBaseUrl: 'http://localhost:3000',
    },
  } as unknown as Runtime;
}

async function backdate(itemId: string): Promise<void> {
  await getPool().query(`UPDATE ledger_items SET created_at = $2, evidence_after = $2 WHERE item_id = $1`, [
    itemId,
    new Date('2026-11-01T08:00:00Z'),
  ]);
}

async function setModes(awaitingReply: 'remind' | 'act'): Promise<void> {
  await saveLedgerSettings(
    {
      ...LEDGER_DEFAULTS,
      modes: { ...LEDGER_DEFAULTS.modes, awaiting_reply: awaitingReply },
      meetingLeadMinutesCritical: [1440, 60],
    },
    { businessId: B, updatedBy: 'owner' },
  );
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('schedulerPass ledger stages', () => {
  it('one pass closes by evidence before it reminds', async () => {
    await installCharter(buildCharter({}), { businessId: B });
    await setModes('remind');
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    await backdate(item.itemId);
    // The counterparty's reply, newer than the item's evidence_after.
    await getPool().query(
      `INSERT INTO mail_messages (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
                                  received_at, body_text, created_at)
       VALUES ('M-1', $1, 'P-1', 'T', 'dana@acme.co.il', 'מענה', $2, NULL, $2)`,
      [B, new Date('2026-11-02T09:00:00Z')],
    );
    const emails: { subject: string; body: string }[] = [];
    const pass = await schedulerPass({
      businessId: B,
      runtime: emptyRuntime(emails),
      now: NOW,
      inbox: null,
    });

    expect(pass.ledgerEvidenceError).toBeNull();
    expect(pass.ledgerError).toBeNull();
    expect(pass.ledgerEvidence?.closed).toEqual([{ itemId: item.itemId, mailId: 'M-1' }]);
    // The stage after it RAN (an empty result is not null) and found nothing to remind about.
    expect(pass.ledger).not.toBeNull();
    expect(pass.ledger?.reminded).toBe(0);
    const { rows } = await getPool().query<{ slot: string; kind: string }>(
      `SELECT slot, kind FROM ledger_reminders WHERE business_id = $1`,
      [B],
    );
    expect(rows.map((r) => r.slot)).toEqual(['evidence:M-1']);
    expect(rows.some((r) => r.kind === 'nudge' || r.kind === 'due')).toBe(false);
  });

  it('one pass with an evidence closure and a due reminder sends ONE WhatsApp batch, the notice first', async () => {
    await installCharter(buildCharter({}), { businessId: B });
    await saveLedgerSettings(
      { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes }, meetingLeadMinutesCritical: [1440, 60], toWhatsApp: true },
      { businessId: B, updatedBy: 'owner' },
    );
    const closing = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    await backdate(closing.itemId);
    await getPool().query(
      `INSERT INTO mail_messages (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
                                  received_at, body_text, created_at)
       VALUES ('M-1', $1, 'P-1', 'T', 'dana@acme.co.il', 'מענה', $2, NULL, $2)`,
      [B, new Date('2026-11-02T09:00:00Z')],
    );
    // A money_in item due today: its `due` slot (09:00 local) is due at NOW.
    const due = await createLedgerItem(
      base({
        family: 'money_in',
        description: 'חשבונית 9 של יוסי',
        counterpartyEmail: null,
        counterpartyEmailVerified: false,
        dueAt: new Date('2026-11-04T07:00:00Z'),
        dueIsDateOnly: true,
      }),
      { businessId: B, by: 'boss' },
    );
    const gateway = createFakeGateway();
    const runtime = { ...emptyRuntime(), whatsapp: { gateway } } as unknown as Runtime;
    const pass = await schedulerPass({ businessId: B, runtime, now: NOW, inbox: null });

    expect(pass.ledgerEvidence?.closed.map((c) => c.itemId)).toEqual([closing.itemId]);
    expect(pass.ledger?.reminded).toBe(1);
    const batches = await getPool().query<{ items: string[]; sent_at: Date | null }>(
      `SELECT items, sent_at FROM ledger_whatsapp_batches WHERE business_id = $1`,
      [B],
    );
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]?.items).toEqual([closing.itemId, due.itemId]);
    expect(batches.rows[0]?.sent_at).not.toBeNull();
    const ledgerTexts = gateway.sent.filter((m) => m.body.startsWith('תזכורות מהפנקס:'));
    expect(ledgerTexts).toHaveLength(1);
    const text = ledgerTexts[0]?.body ?? '';
    expect(text).toContain("1. סגרתי 'תשובה מדנה על ההצעה'");
    expect(text).toContain("השיבי '1 פתחי'");
    expect(text).toContain('2. תזכורת: חשבונית 9 של יוסי');
    const states = await getPool().query<{ kind: string; whatsapp_state: string | null }>(
      `SELECT kind, whatsapp_state FROM ledger_reminders WHERE business_id = $1 ORDER BY kind`,
      [B],
    );
    expect(states.rows).toEqual([
      { kind: 'due', whatsapp_state: 'sent' },
      { kind: 'evidence', whatsapp_state: 'sent' },
    ]);
  });

  it('a throwing nudge drafter is contained and does not stop the rest of the pass', async () => {
    await installCharter(buildCharter({}), { businessId: B });
    await setModes('act');
    const item = await createLedgerItem(base(), { businessId: B, by: 'boss' });
    await backdate(item.itemId);
    const pass = await schedulerPass({
      businessId: B,
      runtime: emptyRuntime(),
      now: NOW,
      inbox: null,
      ledgerDrafter: async () => {
        throw new Error('drafter exploded');
      },
    });

    expect(pass.ledger).not.toBeNull();
    // The throwing drafter was reached and contained inside the stage: the
    // nudge fell back to the owner (draft_failed) instead of escaping.
    expect(pass.ledger?.nudgeFallbacks).toBe(1);
    expect(pass.ledger?.nudgesOpened).toBe(0);
    expect(pass.ledgerError).toBeNull();
    // Later stages still ran.
    expect(pass.actionUpdates).not.toBeNull();
    expect(pass.actionUpdatesError).toBeNull();
    expect(pass.verified).toBeDefined();
  });

  it('is null when no charter is active', async () => {
    const pass = await schedulerPass({
      businessId: B,
      runtime: emptyRuntime(),
      now: NOW,
      inbox: null,
    });
    expect(pass.ledgerEvidence).toBeNull();
    expect(pass.ledger).toBeNull();
    expect(pass.ledgerEvidenceError).toBeNull();
    expect(pass.ledgerError).toBeNull();
    // The rest of the pass ran.
    expect(pass.actionUpdates).not.toBeNull();
  });

  it('a real fault in both ledger stages is contained and the later stages still run', async () => {
    await installCharter(buildCharter({}), { businessId: B });
    await setModes('remind');
    const pool = getPool();
    await pool.query('ALTER TABLE ledger_items RENAME TO ledger_items_x');
    try {
      const pass = await schedulerPass({ businessId: B, runtime: emptyRuntime(), now: NOW, inbox: null });
      expect(typeof pass.ledgerEvidenceError).toBe('string');
      expect(pass.ledgerEvidenceError?.length).toBeGreaterThan(0);
      expect(typeof pass.ledgerError).toBe('string');
      expect(pass.ledgerError?.length).toBeGreaterThan(0);
      expect(pass.ledgerEvidence).toBeNull();
      expect(pass.ledger).toBeNull();
      expect(pass.actionUpdates).not.toBeNull();
      expect(pass.actionUpdatesError).toBeNull();
      expect(pass.verified).toBeDefined();
    } finally {
      await pool.query('ALTER TABLE ledger_items_x RENAME TO ledger_items');
    }
  });
});
