/**
 * The WhatsApp half of a document card: its word lists stay disjoint from
 * every other reader's, and the time gate is re-checked inside the approval
 * itself — not only before the message was claimed.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { CLOSURE_VERB_WORDS } from '../governance/closure-command.js';
import { DOCUMENT_SETTINGS_DEFAULTS, saveDocumentSettings } from '../governance/document-settings.js';
import { FORGET_VERBS } from '../governance/forget-command.js';
import { LEDGER_COMMAND_WORDS } from '../ledger/whatsapp-command.js';
import { addTypedRecipient, approveDocumentCard, createDocumentCard, loadDocumentCard } from '../production/card.js';
import { advanceStage, createProduction, saveVersion, type ProductionDestination } from '../production/store.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { CANCEL_WORDS, CONFIRM_WORDS, REPLY_STOPLIST } from './command-confirm.js';
import {
  DOCUMENT_CARD_SAVE_WORDS,
  DOCUMENT_CARD_SEND_WORDS,
  fixRequestText,
  isDocumentCardAction,
} from './whatsapp-document-card.js';
import { MAIL_CARD_APPROVE_WORDS, replacementBody } from './whatsapp-mail-card.js';

const B = 'test-business';
const DIR = `produced/__wdc-${process.pid}`;

describe('word lists', () => {
  it('"שלחי"/"שלח" are the mail card\'s own approve words — the shared word is why C9 counts both kinds together', () => {
    expect([...DOCUMENT_CARD_SEND_WORDS]).toEqual([...MAIL_CARD_APPROVE_WORDS]);
  });

  it('the save words are disjoint from every other reader\'s words', () => {
    const others: Array<[string, readonly string[]]> = [
      ['CONFIRM_WORDS', CONFIRM_WORDS],
      ['CANCEL_WORDS', CANCEL_WORDS],
      ['CLOSURE_VERB_WORDS', CLOSURE_VERB_WORDS],
      ['FORGET_VERBS', FORGET_VERBS],
      ['MAIL_CARD_APPROVE_WORDS', MAIL_CARD_APPROVE_WORDS],
      ['LEDGER_COMMAND_WORDS', LEDGER_COMMAND_WORDS],
      ['REPLY_STOPLIST', REPLY_STOPLIST],
    ];
    expect(DOCUMENT_CARD_SAVE_WORDS).toEqual(['שמרי', 'שמור']);
    for (const [name, list] of others) {
      expect(DOCUMENT_CARD_SAVE_WORDS.filter((w) => list.includes(w)), name).toEqual([]);
    }
    // The send words are only the mail card's: no other reader takes them.
    for (const [name, list] of others.filter(([n]) => n !== 'MAIL_CARD_APPROVE_WORDS')) {
      expect(DOCUMENT_CARD_SEND_WORDS.filter((w) => list.includes(w)), name).toEqual([]);
    }
  });

  it('a save word is a whole message: the ledger phrase "שמרי שלבים" is not a card action', () => {
    expect(isDocumentCardAction('שמרי')).toBe(true);
    expect(isDocumentCardAction(' שמור ')).toBe(true);
    expect(isDocumentCardAction('שמרי שלבים')).toBe(false);
  });

  it('"תיקון:" and "נוסח:" are disjoint prefixes', () => {
    expect(fixRequestText('תיקון: להוסיף מע"מ')).toBe('להוסיף מע"מ');
    expect(fixRequestText('נוסח: שלום')).toBe(null);
    expect(replacementBody('תיקון: להוסיף')).toBe(null);
    expect(replacementBody('נוסח: שלום')).toBe('שלום');
    for (const word of [...CONFIRM_WORDS, ...CANCEL_WORDS, ...FORGET_VERBS, ...LEDGER_COMMAND_WORDS, ...MAIL_CARD_APPROVE_WORDS]) {
      expect(fixRequestText(word)).toBe(null);
      expect(word.startsWith('תיקון')).toBe(false);
      expect(word.startsWith('נוסח')).toBe(false);
    }
  });
});

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'הצעה',
  filename: 'הצעה',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

let seq = 0;
async function card(destination: ProductionDestination, deliveredAgoMs: number | null): Promise<string> {
  seq += 1;
  const productionId = await withBusiness(B, (db) => createProduction(db, {
    originJobId: 'J-o',
    instructionText: 'תכיני הצעה',
    textOrigin: 'typed',
    format: 'docx',
    language: 'he',
    kind: 'letter',
    destination,
    sourceDocumentIds: [],
  }));
  const bytes = Buffer.from(`docx ${productionId}`);
  const storedPath = `${DIR}/${productionId}.docx`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  const versionId = await withBusiness(TEST_BUSINESS, (db) => saveVersion(db, {
    productionId,
    versionNo: 1,
    spec,
    storedPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  }));
  expect(await withBusiness(TEST_BUSINESS, (db) => advanceStage(db, productionId, 'queued', 'ready', {}))).toBe(true);
  const created = await withBusiness(B, (db) => createDocumentCard(db, versionId));
  if (deliveredAgoMs !== null) {
    await testDb().query(
      `UPDATE document_cards SET whatsapp_delivered_at = now() - make_interval(secs => $2::double precision / 1000)
        WHERE card_id = $1`,
      [created.cardId, deliveredAgoMs],
    );
  }
  return created.cardId;
}

describe('the WhatsApp time gate inside approveDocumentCard', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withBusiness(B, (bdb) => installCharter(bdb, buildCharter({ version: 'v-gate' })));
    // A save option needs somewhere to save to (M4); the gate under test is time.
    await saveDocumentSettings({ ...DOCUMENT_SETTINGS_DEFAULTS, baseFolder: tmpdir() }, { businessId: B });
  });
  afterAll(async () => {
    await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
    await closePool();
  });

  const save = async (cardId: string): Promise<string> =>
    (await withBusiness(B, (db) => loadDocumentCard(db, cardId)))!.deliveryPlans.find((o) => o.option === 'save')!.planHash;

  it('approves a whatsapp answer sent after delivery and inside the window', async () => {
    const cardId = await card({ mode: 'save', folder: null }, 60_000);
    const outcome = await withBusiness(B, async (db) => approveDocumentCard(db, cardId, await save(cardId), 'whatsapp', {
      whatsappInboundAt: new Date(),
    }));
    expect(outcome.status).toBe('approved');
  });

  it('refuses a whatsapp answer sent before the card was delivered', async () => {
    const cardId = await card({ mode: 'save', folder: null }, 60_000);
    const outcome = await withBusiness(B, async (db) => approveDocumentCard(db, cardId, await save(cardId), 'whatsapp', {
      whatsappInboundAt: new Date(Date.now() - 120_000),
    }));
    expect(outcome.status).toBe('not_answerable');
    expect((await withBusiness(B, (db) => loadDocumentCard(db, cardId)))?.state).toBe('open');
  });

  it('refuses a whatsapp answer to a card no longer delivered (withdrawn) or past the window, or with no timestamp', async () => {
    const never = await card({ mode: 'save', folder: null }, null);
    expect(
      (await withBusiness(B, async (db) => approveDocumentCard(db, never, await save(never), 'whatsapp', { whatsappInboundAt: new Date() }))).status,
    ).toBe('not_answerable');
    const old = await card({ mode: 'save', folder: null }, (config.whatsappQuestionWindowMinutes + 5) * 60_000);
    expect(
      (await withBusiness(B, async (db) => approveDocumentCard(db, old, await save(old), 'whatsapp', { whatsappInboundAt: new Date() }))).status,
    ).toBe('not_answerable');
    const fresh = await card({ mode: 'save', folder: null }, 60_000);
    expect((await withBusiness(B, async (db) => approveDocumentCard(db, fresh, await save(fresh), 'whatsapp'))).status).toBe('not_answerable');
  });

  it('the dashboard is not time-gated', async () => {
    const cardId = await card({ mode: 'save', folder: null }, null);
    expect((await withBusiness(B, async (db) => approveDocumentCard(db, cardId, await save(cardId), 'dashboard'))).status).toBe('approved');
  });

  it('a typed address clears the WhatsApp delivery and re-sends the card, showing the address', async () => {
    const cardId = await card({ mode: 'send', to: [] }, 60_000);
    const files: string[] = [];
    const messenger = {
      send: async () => ({ ok: true }),
      sendFile: async (input: { caption: string }) => {
        files.push(input.caption);
        return { ok: true };
      },
    } as unknown as BossMessenger;
    await testDb().query(
      `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen) VALUES ($1, true, false, true)
        ON CONFLICT (business_id) DO UPDATE SET to_whatsapp = true, to_email = false, to_screen = true`,
      [B],
    );
    const before = (await withBusiness(B, (db) => loadDocumentCard(db, cardId)))!.whatsappDeliveredAt!;
    const outcome = await withBusiness(B, (db) => addTypedRecipient(db, cardId, 'yossi@client.example', { messenger }));
    expect(outcome).toMatchObject({ status: 'added', resend: 'sent' });
    // The card as it now stands — with the typed address in its echo — was
    // sent again, and only that new delivery is answerable.
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('yossi@client.example');
    const after = (await withBusiness(B, (db) => loadDocumentCard(db, cardId)))!;
    expect(after.whatsappState).toBe('sent');
    expect(after.whatsappDeliveredAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it('a typed address with no notification seams leaves the card withdrawn and its channel states untouched', async () => {
    const cardId = await card({ mode: 'send', to: [] }, 60_000);
    await testDb().query(`UPDATE document_cards SET email_state = 'sent', whatsapp_state = 'sent' WHERE card_id = $1`, [cardId]);
    const outcome = await withBusiness(B, (db) => addTypedRecipient(db, cardId, 'yossi@client.example'));
    expect(outcome).toMatchObject({ status: 'added', resend: 'skipped_no_seams' });
    const after = (await withBusiness(B, (db) => loadDocumentCard(db, cardId)))!;
    expect(after.whatsappDeliveredAt).toBe(null);
    expect(after.emailState).toBe('sent');
    expect(after.whatsappState).toBe('sent');
  });

  it('a typed address is saved even when the charter cannot be read — the re-send is skipped, not guessed', async () => {
    const cardId = await card({ mode: 'send', to: [] }, 60_000);
    await testDb().query(`UPDATE document_cards SET whatsapp_state = 'sent' WHERE card_id = $1`, [cardId]);
    await testDb().query(
      `UPDATE charter_versions SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1`,
      [B],
    );
    const sent: string[] = [];
    const messenger = {
      send: async () => ({ ok: true }),
      sendFile: async (input: { caption: string }) => {
        sent.push(input.caption);
        return { ok: true };
      },
    } as unknown as BossMessenger;
    const outcome = await withBusiness(B, (db) => addTypedRecipient(db, cardId, 'yossi@client.example', { messenger }));
    expect(outcome).toMatchObject({ status: 'added', resend: 'skipped_charter_unreadable' });
    expect(sent).toEqual([]);
    const after = (await withBusiness(B, (db) => loadDocumentCard(db, cardId)))!;
    expect(after.deliveryPlans.some((o) => o.option === 'send')).toBe(true);
    expect(after.whatsappDeliveredAt).toBe(null);
    expect(after.whatsappState).toBe('sent');
  });
});
