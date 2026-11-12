/**
 * Owner commands on ledger items: the pure reader, the one applier the
 * WhatsApp door and the dashboard share, and the WhatsApp resolution against
 * the numbered batch the owner actually received.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, type BusinessDb, type Queryable, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { recordInbound } from '../whatsapp/store.js';
import { CANCEL_WORDS, CONFIRM_WORDS, REPLY_STOPLIST } from '../orchestrator/command-confirm.js';
import { CLOSURE_VERB_WORDS } from '../governance/closure-command.js';
import { FORGET_VERBS } from '../governance/forget-command.js';
import { MAIL_CARD_APPROVE_WORDS } from '../orchestrator/whatsapp-mail-card.js';
import { localParts } from '../util/local-time.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import { executeErasure } from '../governance/erasure.js';
import { LEDGER_DEFAULTS, saveLedgerSettings } from './settings.js';
import {
  createLedgerItem,
  listLedgerEvents,
  loadLedgerItem,
  moveLedgerStatus,
  type NewLedgerItem,
} from './store.js';
import {
  LEDGER_BARE_WORDS,
  LEDGER_COMMAND_WORDS,
  LEDGER_NUMBER_REQUIRED_WORDS,
  applyLedgerCommand,
  handleLedgerWhatsApp,
  readLedgerCommand,
  type LedgerCommand,
} from './whatsapp-command.js';

const B = 'test-business';
const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-03T08:00:00Z');
const R = { now: NOW, timeZone: TZ };

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
    counterpartyEmailVerified: false,
    counterpartyDomain: null,
    reference: null,
    amountMinor: null,
    stages: [],
    proposedStages: null,
    originJobId: 'J-1',
    ...over,
  };
}

async function item(over: Partial<NewLedgerItem> = {}): Promise<string> {
  return (await withBusiness(B, (db) => createLedgerItem(db, base(over), { by: 'test' }))).itemId;
}

async function load(itemId: string) {
  const it = await withBusiness(B, (db) => loadLedgerItem(db, itemId));
  if (it === null) throw new Error('missing item');
  return it;
}

async function kinds(itemId: string): Promise<string[]> {
  return (await withBusiness(B, (db) => listLedgerEvents(db, itemId))).map((e) => e.kind);
}

const APPLY = { businessId: B, by: 'owner', now: NOW, timeZone: TZ };

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(B, (db) => saveLedgerSettings(db, { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes } }, { updatedBy: 'owner' }));
});

afterAll(async () => {
  await closePool();
});

describe('readLedgerCommand', () => {
  const cases: Array<[string, LedgerCommand | null]> = [
    ['2 בוצע', { kind: 'done', n: 2 }],
    ['בוצע', { kind: 'done', n: null }],
    ['2 בוצע!', { kind: 'done', n: 2 }],
    ['  2   בוצע.  ', { kind: 'done', n: 2 }],
    ['‫2 בוצע‬', { kind: 'done', n: 2 }],
    ['3 דחי ל-05/11', { kind: 'snooze', n: 3, to: { date: '2026-11-05' } }],
    ['3 דחי ל05/11', { kind: 'snooze', n: 3, to: { date: '2026-11-05' } }],
    ['דחי ל-5/11', { kind: 'snooze', n: null, to: { date: '2026-11-05' } }],
    ['דחי מחר', { kind: 'snooze', n: null, to: 'tomorrow' }],
    ['1 דחי מחר', { kind: 'snooze', n: 1, to: 'tomorrow' }],
    ['1 פתחי', { kind: 'reopen', n: 1 }],
    ['פתחי', { kind: 'reopen', n: null }],
    ['התקיימה', { kind: 'held', n: null }],
    ['2 התקיימה', { kind: 'held', n: 2 }],
    ['2 לא התקיימה', { kind: 'not_held', n: 2 }],
    ['2 בטלי', { kind: 'cancel', n: 2 }],
    ['1 שמרי שלבים', { kind: 'save_stages', n: 1 }],
    ['שמרי שלבים', { kind: 'save_stages', n: null }],
    ['4 אשרי כתובת', { kind: 'confirm_address', n: 4 }],
    // A word that also answers a confirmation / cancel needs its number.
    ['בטלי', null],
    ['לא התקיימה', null],
    ['אשרי כתובת', null],
    ['כן', null],
    ['לא', null],
    ['שלח', null],
    ['0 בוצע', null],
    ['02 בוצע', null],
    ['2 בוצע את זה', null],
    ['בוצע 2', null],
    ['דחי', null],
    ['דחי ל-31/02', null],
    ['דחי ל-01/13', null],
    ['דחי ל-5', null],
    ['2', null],
    ['', null],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(readLedgerCommand(text, R)).toEqual(expected);
    });
  }

  it('a date already past this year is next year; today is today — in the charter zone', () => {
    expect(readLedgerCommand('דחי ל-01/11', R)).toEqual({ kind: 'snooze', n: null, to: { date: '2027-11-01' } });
    expect(readLedgerCommand('דחי ל-03/11', R)).toEqual({ kind: 'snooze', n: null, to: { date: '2026-11-03' } });
    // 23:30 UTC on 03/11 is already 04/11 in Jerusalem.
    const late = { now: new Date('2026-11-03T23:30:00Z'), timeZone: TZ };
    expect(readLedgerCommand('דחי ל-03/11', late)).toEqual({ kind: 'snooze', n: null, to: { date: '2027-11-03' } });
    expect(readLedgerCommand('דחי ל-03/11', { ...late, timeZone: 'UTC' })).toEqual({
      kind: 'snooze',
      n: null,
      to: { date: '2026-11-03' },
    });
  });

  it('29/02 resolves to the next year that has it', () => {
    expect(readLedgerCommand('דחי ל-29/02', R)).toEqual({ kind: 'snooze', n: null, to: { date: '2028-02-29' } });
  });
});

describe('the ledger words are disjoint from every other WhatsApp answer', () => {
  const foreign = [
    ...CONFIRM_WORDS,
    ...CANCEL_WORDS,
    ...CLOSURE_VERB_WORDS,
    ...FORGET_VERBS,
    ...MAIL_CARD_APPROVE_WORDS,
  ];

  it('a word usable without a number is none of theirs, not even as its first token', () => {
    expect(LEDGER_BARE_WORDS.length).toBeGreaterThan(0);
    for (const word of LEDGER_BARE_WORDS) {
      expect(foreign).not.toContain(word);
      expect(foreign).not.toContain(word.split(' ')[0]);
    }
  });

  it('every ledger phrase whose first token is one of theirs requires a number, and reads null without it', () => {
    const colliding = LEDGER_COMMAND_WORDS.filter((w) => foreign.includes(w.split(' ')[0] ?? ''));
    // The test is not vacuous: בטלי, לא התקיימה and אשרי כתובת collide today.
    expect(colliding.length).toBeGreaterThanOrEqual(3);
    expect([...colliding].sort()).toEqual([...LEDGER_NUMBER_REQUIRED_WORDS].sort());
    for (const word of colliding) {
      expect(readLedgerCommand(word, R)).toBeNull();
      expect(readLedgerCommand(`1 ${word}`, R)).not.toBeNull();
    }
  });

  it('none of their words, nor the reply stoplist, reads as a ledger command', () => {
    for (const word of [...foreign, ...REPLY_STOPLIST]) {
      expect(readLedgerCommand(word, R), word).toBeNull();
    }
    // The reader does read something: a ledger word is non-null.
    expect(readLedgerCommand('בוצע', R)).not.toBeNull();
  });
});

describe('applyLedgerCommand', () => {
  it('done moves an open item to done with a done event by the actor', async () => {
    const id = await item();
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'done', n: null }, APPLY))).toBe('applied');
    expect((await load(id)).status).toBe('done');
    const events = await withBusiness(B, (db) => listLedgerEvents(db, id));
    expect(events.at(-1)).toMatchObject({ kind: 'done', byWhom: 'owner' });
  });

  it('done on an already-done item is not applicable and writes nothing', async () => {
    const id = await item();
    await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'done', n: null }, APPLY));
    const before = await kinds(id);
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'done', n: null }, APPLY))).toBe('not_applicable');
    expect(await kinds(id)).toEqual(before);
  });

  it('an item of another business is not applicable', async () => {
    const id = await item();
    expect(await withBusiness('other', (db) => applyLedgerCommand(db, id, { kind: 'done', n: null }, { ...APPLY }))).toBe(
      'not_applicable',
    );
    expect((await load(id)).status).toBe('open');
  });

  it('a status moved between the read and the conditional update is a lost race', async () => {
    const id = await item();
    let raced = false;
    // `inTransaction: true`: the store joins instead of issuing BEGIN on a
    // pool, the way the old `atomically` used a caller's client as is.
    const db: BusinessDb = {
      businessId: B,
      inTransaction: true,
      query: (async (text: string, params?: unknown[]) => {
        if (!raced && typeof text === 'string' && text.trimStart().startsWith('UPDATE ledger_items')) {
          raced = true;
          await testDb().query(`UPDATE ledger_items SET status = 'cancelled' WHERE item_id = $1`, [id]);
        }
        return testDb().query(text, params);
      }) as Queryable['query'],
    };
    expect(await applyLedgerCommand(db, id, { kind: 'done', n: null }, { ...APPLY })).toBe('lost_race');
    expect(raced).toBe(true);
    expect((await load(id)).status).toBe('cancelled');
  });

  it('cancel moves to cancelled', async () => {
    const id = await item();
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'cancel', n: null }, APPLY))).toBe('applied');
    expect((await load(id)).status).toBe('cancelled');
    expect(await kinds(id)).toContain('cancelled');
  });

  it('reopen moves an evidence-closed item to open and evidence_after forward', async () => {
    const id = await item();
    const past = new Date('2026-01-01T00:00:00Z');
    await testDb().query(`UPDATE ledger_items SET evidence_after = $2 WHERE item_id = $1`, [id, past]);
    await withBusiness(B, (db) => moveLedgerStatus(db, id, ['open'], 'closed_by_evidence', { kind: 'closed_by_evidence', by: 'system' }));
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'reopen', n: null }, APPLY))).toBe('applied');
    const after = await load(id);
    expect(after.status).toBe('open');
    expect(after.closedAt).toBeNull();
    expect(after.evidenceAfter.getTime()).toBeGreaterThan(past.getTime());
    expect(await kinds(id)).toContain('reopened');
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'reopen', n: null }, APPLY))).toBe('not_applicable');
  });

  it('held closes a meeting as done with a held event; not on another family', async () => {
    const meeting = await item({ family: 'meetings' });
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, meeting, { kind: 'held', n: null }, APPLY))).toBe('applied');
    expect((await load(meeting)).status).toBe('done');
    expect(await kinds(meeting)).toContain('held');

    const other = await item();
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, other, { kind: 'held', n: null }, APPLY))).toBe('not_applicable');
    expect((await load(other)).status).toBe('open');
  });

  it('not_held writes an event and the meeting stays open', async () => {
    const meeting = await item({ family: 'meetings' });
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, meeting, { kind: 'not_held', n: null }, APPLY))).toBe('applied');
    expect((await load(meeting)).status).toBe('open');
    expect(await kinds(meeting)).toContain('not_held');
  });

  it('snooze resets nudge_count and reopens a stuck item', async () => {
    const id = await item({ dueAt: new Date('2026-11-01T06:00:00Z'), dueIsDateOnly: true });
    await testDb().query(`UPDATE ledger_items SET nudge_count = 3 WHERE item_id = $1`, [id]);
    await withBusiness(B, (db) => moveLedgerStatus(db, id, ['open'], 'stuck', { kind: 'stuck', by: 'system' }));

    expect(
      await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'snooze', n: null, to: { date: '2026-11-10' } }, APPLY)),
    ).toBe('applied');
    const after = await load(id);
    expect(after.status).toBe('open');
    expect(after.nudgeCount).toBe(0);
    expect(after.dueIsDateOnly).toBe(true);
    // Date-only: the daily hour (default 8) on the new date, in the charter zone.
    expect(localParts(after.dueAt ?? new Date(0), TZ)).toMatchObject({ date: '2026-11-10', time: '08:00' });
    expect(await kinds(id)).toEqual(expect.arrayContaining(['snoozed', 'reopened']));
  });

  it('snooze revives an evidence-closed item but not a done or cancelled one', async () => {
    const closed = await item();
    await withBusiness(B, (db) => moveLedgerStatus(db, closed, ['open'], 'closed_by_evidence', { kind: 'closed_by_evidence', by: 'system' }));
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, closed, { kind: 'snooze', n: null, to: 'tomorrow' }, APPLY))).toBe('applied');
    expect((await load(closed)).status).toBe('open');

    for (const status of ['done', 'cancelled'] as const) {
      const id = await item();
      await withBusiness(B, (db) => moveLedgerStatus(db, id, ['open'], status, { kind: status, by: 'system' }));
      const before = await load(id);
      expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'snooze', n: null, to: 'tomorrow' }, APPLY))).toBe('not_applicable');
      const after = await load(id);
      expect(after.status).toBe(status);
      expect(after.dueAt).toEqual(before.dueAt);
      expect(await kinds(id)).not.toContain('snoozed');
    }
  });

  it('snooze to tomorrow keeps a timed item’s hour', async () => {
    const id = await item({ dueAt: new Date('2026-11-03T12:30:00Z'), dueIsDateOnly: false }); // 14:30 local
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'snooze', n: null, to: 'tomorrow' }, APPLY))).toBe('applied');
    const after = await load(id);
    expect(localParts(after.dueAt ?? new Date(0), TZ)).toMatchObject({ date: '2026-11-04', time: '14:30' });
    expect(after.dueIsDateOnly).toBe(false);
  });

  it('save_stages promotes the proposed stages, and only when there are some', async () => {
    const proposed = [{ title: 'שרטוט', done: false }];
    const id = await item({ family: 'projects', proposedStages: proposed });
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'save_stages', n: null }, APPLY))).toBe('applied');
    const after = await load(id);
    expect(after.stages).toEqual(proposed);
    expect(after.proposedStages).toBeNull();
    expect(await kinds(id)).toContain('stages_saved');
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'save_stages', n: null }, APPLY))).toBe('not_applicable');
  });

  it('confirm_address verifies a present email; with no email it is not applicable', async () => {
    const id = await item();
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, id, { kind: 'confirm_address', n: null }, APPLY))).toBe('applied');
    expect((await load(id)).counterpartyEmailVerified).toBe(true);
    expect(await kinds(id)).toContain('address_confirmed');

    const none = await item({ counterpartyEmail: null });
    expect(await withBusiness(B, (db) => applyLedgerCommand(db, none, { kind: 'confirm_address', n: null }, APPLY))).toBe('not_applicable');
    expect((await load(none)).counterpartyEmailVerified).toBe(false);
  });
});

describe('handleLedgerWhatsApp', () => {
  let seq = 0;
  let texts: string[];
  let messenger: BossMessenger;

  beforeEach(() => {
    texts = [];
    messenger = {
      channel: 'whatsapp',
      async send(input) {
        texts.push(input.text);
        return { ok: true };
      },
    };
  });

  async function batch(items: string[], sentAt: Date | null): Promise<void> {
    seq += 1;
    await testDb().query(
      `INSERT INTO ledger_whatsapp_batches (batch_id, business_id, items, sent_at) VALUES ($1, $2, $3, $4)`,
      [`LB-T${seq}`, B, items, sentAt],
    );
  }

  async function inbound(text: string, at: Date): Promise<string> {
    seq += 1;
    const stored = await withBusiness(B, (db) => recordInbound(
      db,
      {
        providerMessageId: `wamid.ledger-${seq}`,
        senderNumber: '+972500000000',
        senderKind: 'principal',
        body: text,
        mediaKind: null,
        providerTimestamp: at.toISOString(),
      },
    ));
    if (stored === null) throw new Error('not stored');
    return stored.id;
  }

  async function handle(text: string, inboundAt: Date) {
    const messageId = await inbound(text, inboundAt);
    const outcome = await withBusiness(B, (db) => handleLedgerWhatsApp(db, {
      text,
      messageId,
      inboundAt,
      by: 'whatsapp:+972500000000',
      now: NOW,
      timeZone: TZ,
      messenger,
    }));
    return { outcome, messageId };
  }

  async function messageState(id: string): Promise<string | undefined> {
    const { rows } = await testDb().query<{ state: string }>(`SELECT state FROM whatsapp_messages WHERE id = $1`, [id]);
    return rows[0]?.state;
  }

  const T1 = new Date('2026-11-03T06:00:00Z');
  const T2 = new Date('2026-11-03T07:00:00Z');
  const T3 = new Date('2026-11-03T07:30:00Z');

  it('a non-command passes through, claiming nothing', async () => {
    const { outcome, messageId } = await handle('תשלחי לדנה', T3);
    expect(outcome).toBe('passthrough');
    expect(await messageState(messageId)).toBe('received');
    expect(texts).toEqual([]);
  });

  it('applies "2 בוצע" to the second item and says so in Hebrew', async () => {
    const a = await item({ description: 'ראשון' });
    const b = await item({ description: 'שני\nעם שבירה' });
    await batch([a, b], T1);
    const { outcome, messageId } = await handle('2 בוצע', T3);
    expect(outcome).toBe('applied');
    expect((await load(b)).status).toBe('done');
    expect((await load(a)).status).toBe('open');
    expect(texts).toEqual(['עודכן: שני עם שבירה — בוצע']);
    expect(await messageState(messageId)).toBe('handled');
    const events = await withBusiness(B, (db) => listLedgerEvents(db, b));
    expect(events.at(-1)).toMatchObject({ kind: 'done', byWhom: 'whatsapp:+972500000000' });
  });

  it('M2: a reply send that throws still settles the claimed message', async () => {
    const a = await item({ description: 'ראשון' });
    await batch([a], T1);
    const messageId = await inbound('1 בוצע', T3);
    let calls = 0;
    const outcome = await withBusiness(B, (db) => handleLedgerWhatsApp(db, {
      text: '1 בוצע',
      messageId,
      inboundAt: T3,
      by: 'whatsapp:+972500000000',
      now: NOW,
      timeZone: TZ,
      messenger: {
        channel: 'whatsapp',
        async send() {
          calls += 1;
          throw new Error('gateway down');
        },
      },
    }));
    expect(calls).toBe(1); // the reply was attempted
    expect(outcome).toBe('applied');
    expect((await load(a)).status).toBe('done');
    expect(await messageState(messageId)).toBe('handled');
  });

  it('resolves n against the batch delivered before the message, not a newer one', async () => {
    const old1 = await item({ description: 'ישן 1' });
    const old2 = await item({ description: 'ישן 2' });
    const new1 = await item({ description: 'חדש 1' });
    const new2 = await item({ description: 'חדש 2' });
    await batch([old1, old2], T1);
    // Sent after the owner typed — he never saw it when he answered.
    await batch([new1, new2], new Date(T3.getTime() + 60_000));
    expect((await handle('2 בוצע', T3)).outcome).toBe('applied');
    expect((await load(old2)).status).toBe('done');
    expect((await load(new2)).status).toBe('open');
  });

  it('the latest of several delivered batches is the one addressed', async () => {
    const old1 = await item({ description: 'ישן' });
    const new1 = await item({ description: 'חדש' });
    await batch([old1], T1);
    await batch([new1], T2);
    expect((await handle('1 בוצע', T3)).outcome).toBe('applied');
    expect((await load(new1)).status).toBe('done');
    expect((await load(old1)).status).toBe('open');
  });

  it('an unsent batch (sent_at NULL) cannot be addressed', async () => {
    const a = await item();
    await batch([a], null);
    const { outcome, messageId } = await handle('1 בוצע', T3);
    expect(outcome).toBe('refused');
    expect((await load(a)).status).toBe('open');
    expect(texts).toEqual(['לא מצאתי את מספר 1 בהודעה האחרונה של הפנקס']);
    expect(await messageState(messageId)).toBe('failed');
  });

  /**
   * Erasure keeps positions (`LEDGER_WHATSAPP_BATCHES_SCRUB_SET`): an erased
   * id becomes '' in place, so "3" still means the third line the owner saw,
   * and "2" — the erased one — answers not-found and touches nothing.
   */
  it('after an erasure, the erased position answers not-found and the next keeps its number', async () => {
    const a = await item({ description: 'ראשון' });
    const x = await item({ description: 'נמחק', counterpartyEmail: 'gone@erased.example', originJobId: 'J-erased' });
    const b = await item({ description: 'שלישי' });
    await batch([a, x, b], T1);
    const plan = await withBusiness(B, (bdb) => buildErasurePlan(bdb, { kind: 'contact', identifier: 'gone@erased.example' }));
    expect(plan.ledgerItemIds).toEqual([x]);
    await withBusiness(B, (bdb) => executeErasure(bdb, plan));

    expect((await handle('3 בוצע', T3)).outcome).toBe('applied');
    expect((await load(b)).status).toBe('done');

    texts = [];
    const second = await handle('2 בוצע', T3);
    expect(second.outcome).toBe('refused');
    expect(texts).toEqual(['לא מצאתי את מספר 2 בהודעה האחרונה של הפנקס']);
    expect(await messageState(second.messageId)).toBe('failed');
    expect((await load(a)).status).toBe('open');
  });

  it('a number out of range is refused and nothing changes', async () => {
    const a = await item();
    await batch([a], T1);
    expect((await handle('2 בוצע', T3)).outcome).toBe('refused');
    expect(texts).toEqual(['לא מצאתי את מספר 2 בהודעה האחרונה של הפנקס']);
    expect((await load(a)).status).toBe('open');
  });

  it('a bare word acts on a one-item batch', async () => {
    const a = await item();
    await batch([a], T1);
    expect((await handle('בוצע', T3)).outcome).toBe('applied');
    expect((await load(a)).status).toBe('done');
  });

  it('a bare word on a batch of several asks for the number and changes nothing', async () => {
    const a = await item();
    const b = await item();
    await batch([a, b], T1);
    expect((await handle('בוצע', T3)).outcome).toBe('refused');
    expect(texts[0]).toContain('מספר');
    expect((await load(a)).status).toBe('open');
    expect((await load(b)).status).toBe('open');
  });

  it('a not-applicable command is refused with the item’s current status', async () => {
    const a = await item({ description: 'משהו' });
    await batch([a], T1);
    await withBusiness(B, (db) => applyLedgerCommand(db, a, { kind: 'done', n: null }, APPLY));
    expect((await handle('1 בוצע', T3)).outcome).toBe('refused');
    expect(texts[0]).toContain('משהו');
    expect(texts[0]).toContain('בוצע');
  });

  it('not_held asks for a new date with the same number', async () => {
    const m = await item({ family: 'meetings', description: 'פגישה עם דנה' });
    const x = await item();
    await batch([x, m], T1);
    expect((await handle('2 לא התקיימה', T3)).outcome).toBe('applied');
    expect((await load(m)).status).toBe('open');
    expect(texts[0]).toContain("לקבוע מועד חדש? השיבי '2 דחי ל-DD/MM'");
  });

  it('a bare word passes through, unclaimed, when no ledger batch was ever delivered', async () => {
    const a = await item();
    await batch([a], null); // written but never delivered
    const { outcome, messageId } = await handle('בוצע', T3);
    expect(outcome).toBe('passthrough');
    expect(await messageState(messageId)).toBe('received');
    expect(texts).toEqual([]);
    expect((await load(a)).status).toBe('open');
    // The reader did read it: the numbered form is refused in the same state.
    expect((await handle('1 בוצע', T3)).outcome).toBe('refused');
  });

  it('a bare word is refused when a batch was delivered but none before the message', async () => {
    const a = await item();
    await batch([a], new Date(T3.getTime() + 60_000));
    const { outcome, messageId } = await handle('בוצע', T3);
    expect(outcome).toBe('refused');
    expect(await messageState(messageId)).toBe('failed');
    expect((await load(a)).status).toBe('open');
  });

  it('accept splits numbered from bare commands', async () => {
    const a = await item();
    await batch([a], T1);
    const call = async (text: string, accept: 'numbered' | 'bare') =>
      withBusiness(B, async (db) => handleLedgerWhatsApp(db, {
        text,
        messageId: await inbound(text, T3),
        inboundAt: T3,
        by: 'owner',
        now: NOW,
        timeZone: TZ,
        messenger,
        accept,
      }));
    expect(await call('בוצע', 'numbered')).toBe('passthrough');
    expect(await call('1 בוצע', 'bare')).toBe('passthrough');
    expect((await load(a)).status).toBe('open');
    expect(await call('1 בוצע', 'numbered')).toBe('applied');
    expect((await load(a)).status).toBe('done');
  });

  it('a redelivered copy of the same message applies once', async () => {
    const a = await item();
    await batch([a], T1);
    const { messageId } = await handle('1 בוצע', T3);
    const again = await withBusiness(B, (db) => handleLedgerWhatsApp(db, {
      text: '1 בוצע',
      messageId,
      inboundAt: T3,
      by: 'owner',
      now: NOW,
      timeZone: TZ,
      messenger,
    }));
    expect(again).toBe('skipped');
    expect((await kinds(a)).filter((k) => k === 'done')).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });
});
