/**
 * The contact flow through the WhatsApp door: a contact's or an unknown
 * number's message gets the holding reply and ONE card to the owner; a
 * colleague's is recorded only. Every model and source is an injected stub.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { PolicyBundle } from '../domain/policy.js';
import { trip } from '../governance/killswitch.js';
import { decide } from '../governance/approvals.js';
import { addColleague } from '../business/colleagues.js';
import { addManagedContact } from '../business/settings-contacts.js';
import { PersonEntry } from '../business/setup-package.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { runWhatsAppDoor } from '../orchestrator/whatsapp-door.js';
import type { ContactDraftRequest, ContactDrafter, ContactDraftOutcome } from '../sdk/contact-drafter.js';
import type { ContactResearcher, ResearchOutcome } from '../sdk/contact-researcher.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import type { NormalizedInboundMessage } from './gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';
import { HOLDING_REPLY_TEXT } from './holding-reply.js';
import type { SourceItem, Tier2Source } from './sources/types.js';
import {
  CONTACT_DRAFT_REASON,
  REASON_ATTACHMENT_DROPPED,
  REASON_CAPPED,
  REASON_DRAFT_FAILED,
  REASON_OWNERSHIP,
  REASON_RESEARCH_FAILED,
  REASON_SOURCE_FAILED,
  REASON_SOURCES_STOPPED,
  type ContactFlowDeps,
} from './contact-flow.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';
const CONTACT = '+972501110001';
const UNKNOWN = '+972549999999';
const COLLEAGUE = '+972501110003';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

interface World {
  charter: BusinessCharter;
  bundle: PolicyBundle;
  gateway: FakeGateway;
  messenger: BossMessenger;
  drafts: ContactDraftRequest[];
  researched: number;
  sourceCalls: number;
}

async function world(): Promise<World> {
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter()));
  const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
  if (active === null) throw new Error('no charter');
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL.slice(1), businessId: BUSINESS });
  // Quiet hours off, so the holding reply's timing does not depend on when the suite runs.
  return {
    charter: active.charter,
    bundle: { ...active.bundle, quietHours: null },
    gateway,
    messenger,
    drafts: [],
    researched: 0,
    sourceCalls: 0,
  };
}

async function addContact(): Promise<void> {
  await withBusiness(BUSINESS, (db) =>
    addManagedContact(db, PersonEntry.parse({ name: 'דנה לוי', role: 'לקוחה', phone: CONTACT, kind: 'client' })),
  );
}

function deps(w: World, overrides: Partial<ContactFlowDeps> & {
  draft?: (req: ContactDraftRequest) => Promise<ContactDraftOutcome>;
  research?: () => Promise<ResearchOutcome>;
  items?: SourceItem[];
} = {}): ContactFlowDeps {
  const drafter: ContactDrafter = async (req) => {
    w.drafts.push(req);
    return overrides.draft !== undefined
      ? overrides.draft(req)
      : { status: 'drafted', body: 'שלום דנה, בודקת ומחזירה תשובה.', usedTier3: false, attachDocumentId: null };
  };
  const researcher: ContactResearcher = async () => {
    w.researched += 1;
    return overrides.research !== undefined ? overrides.research() : { status: 'none' };
  };
  const source: Tier2Source = async () => {
    w.sourceCalls += 1;
    return { items: overrides.items ?? [], ownershipViolation: false };
  };
  const { draft: _d, research: _r, items: _i, ...rest } = overrides;
  return {
    gateway: w.gateway,
    messenger: w.messenger,
    bundle: w.bundle,
    charter: w.charter,
    businessName: 'נגריית הדקל',
    researcher,
    drafter,
    // Phase 2: an unclassified answer keeps every phase-1 path (no topic, no auto).
    classifier: async () => ({ status: 'failed', reason: 'stub' }),
    sources: [source],
    calendarSource: async () => ({ items: [], ownershipViolation: false }),
    now: () => new Date(),
    ...rest,
  };
}

let n = 0;
function msg(sender: string, body: string, offsetMs = 0): NormalizedInboundMessage {
  n += 1;
  return {
    providerMessageId: `wamid.flow-${n}`,
    senderNumber: sender,
    body,
    mediaKind: null,
    providerTimestamp: new Date(Date.now() + offsetMs).toISOString(),
  };
}

function door(w: World, flow: ContactFlowDeps | undefined, messages: NormalizedInboundMessage[]) {
  for (const m of messages) w.gateway.enqueue(m);
  return withBusiness(BUSINESS, (db) =>
    runWhatsAppDoor(db, {
      gateway: w.gateway,
      messenger: w.messenger,
      charter: w.charter,
      ...(flow !== undefined ? { contactFlow: flow } : {}),
    }),
  );
}

const sentTo = (w: World, number: string) => w.gateway.sent.filter((s) => s.contactId === number.slice(1));

async function approvals() {
  const { rows } = await testDb().query<{ approval_id: string; job_id: string; state: string; detail: string; proposed_input: Record<string, unknown> }>(
    `SELECT approval_id, job_id, state, detail, proposed_input FROM approval_requests WHERE business_id = $1 ORDER BY created_at`,
    [BUSINESS],
  );
  return rows;
}

async function inbound() {
  const { rows } = await testDb().query<{ sender_kind: string; state: string; job_id: string | null }>(
    `SELECT sender_kind, state, job_id FROM whatsapp_messages WHERE business_id = $1 AND direction = 'inbound' ORDER BY provider_timestamp`,
    [BUSINESS],
  );
  return rows;
}

async function conversations() {
  const { rows } = await testDb().query<{ conversation_id: string; card_job_id: string | null; state: string }>(
    `SELECT conversation_id, card_job_id, state FROM contact_conversations WHERE business_id = $1`,
    [BUSINESS],
  );
  return rows;
}

describe('the contact flow through the door', () => {
  it('five messages in a burst: one conversation, one holding reply, one live card', async () => {
    const w = await world();
    await addContact();
    const texts = ['שלום', 'רציתי לשאול', 'על החשבונית', 'מאוקטובר', 'תודה'];
    const result = await door(w, deps(w), texts.map((t, i) => msg(CONTACT, t, i)));

    expect(result.contactHandled).toBe(5);
    expect(await conversations()).toHaveLength(1);
    const toContact = sentTo(w, CONTACT);
    expect(toContact).toHaveLength(1);
    expect(toContact[0]?.body).toBe(HOLDING_REPLY_TEXT('העסק'));
    const live = (await approvals()).filter((a) => a.state === 'pending');
    expect(live).toHaveLength(1);
    expect(await approvals()).toHaveLength(1);
    // One draft, over all five messages.
    expect(w.drafts).toHaveLength(1);
    const asked = w.drafts[0]!.conversation.filter((m) => m.direction === 'inbound').map((m) => m.body);
    for (const t of texts) expect(asked).toContain(t);
    // Every message settled with the card's job, and labelled a contact.
    const rows = await inbound();
    expect(rows.every((r) => r.sender_kind === 'contact' && r.state === 'handled' && r.job_id === live[0]!.job_id)).toBe(true);
    // The card was presented to the owner.
    expect(sentTo(w, PRINCIPAL).some((s) => s.body.includes('לאשר: "שלח"'))).toBe(true);
  });

  it('unknown number: holding + card, no tier-2 source and no researcher called', async () => {
    const w = await world();
    const result = await door(w, deps(w), [msg(UNKNOWN, 'מה המחיר?')]);
    expect(result.contactHandled).toBe(1);
    expect(sentTo(w, UNKNOWN)).toHaveLength(1);
    expect(w.sourceCalls).toBe(0);
    expect(w.researched).toBe(0);
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]!.tier2).toEqual([]);
    expect(w.drafts[0]!.contactKind).toBe('unknown');
    expect((await approvals()).filter((a) => a.state === 'pending')).toHaveLength(1);
    expect((await inbound())[0]?.sender_kind).toBe('unknown');
  });

  it('a contact: its tier-2 sources and the researcher are consulted', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'יש לך את החשבונית?')]);
    expect(w.sourceCalls).toBe(1);
    expect(w.researched).toBe(1);
  });

  it('colleague: recorded only, no holding, no card', async () => {
    const w = await world();
    await withBusiness(BUSINESS, (db) => addColleague(db, { name: 'יוסי', role: 'מנהל עבודה', phone: COLLEAGUE }));
    const result = await door(w, deps(w), [msg(COLLEAGUE, 'סיימתי באתר')]);
    expect(result.recordedOnly).toBe(1);
    expect(result.contactHandled).toBe(0);
    expect(w.gateway.sent).toEqual([]);
    expect(w.drafts).toHaveLength(0);
    expect(await approvals()).toHaveLength(0);
    expect(await conversations()).toHaveLength(0);
    expect((await inbound())[0]).toMatchObject({ sender_kind: 'colleague', state: 'handled' });
  });

  it('over the per-contact cap: card without model calls', async () => {
    const w = await world();
    await addContact();
    await withBusiness(BUSINESS, (db) =>
      appendAudit(db, {
        actor: 'comms.whatsapp',
        kind: 'tool_call',
        charterVersion: w.bundle.charterVersion,
        provenance: 'unknown_external',
        inputHash: canonicalHash({ key: CONTACT.slice(1) }),
        reason: `${CONTACT_DRAFT_REASON}:30`,
      }),
    );
    const result = await door(w, deps(w), [msg(CONTACT, 'עוד שאלה')]);
    expect(result.contactCapped).toBe(1);
    expect(w.drafts).toHaveLength(0);
    expect(w.researched).toBe(0);
    expect(w.sourceCalls).toBe(0);
    const [card] = await approvals();
    expect(card?.detail).toContain(REASON_CAPPED);
    expect(card?.proposed_input['body']).toBe('');
  });

  it('over the business cap: card without model calls', async () => {
    const w = await world();
    await testDb().query(
      `INSERT INTO business_runtime_settings (business_id, contact_wa_reads_per_day) VALUES ($1, 1)`,
      [BUSINESS],
    );
    await withBusiness(BUSINESS, (db) =>
      appendAudit(db, {
        actor: 'comms.whatsapp',
        kind: 'tool_call',
        charterVersion: w.bundle.charterVersion,
        provenance: 'unknown_external',
        inputHash: canonicalHash({ key: '972540000000' }),
        reason: `${CONTACT_DRAFT_REASON}:1`,
      }),
    );
    const result = await door(w, deps(w), [msg(UNKNOWN, 'שלום')]);
    expect(result.contactCapped).toBe(1);
    expect(w.drafts).toHaveLength(0);
    expect((await approvals())[0]?.detail).toContain(REASON_CAPPED);
  });

  it('writes one counts-only contact_draft audit row per model run', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'א', 0), msg(CONTACT, 'ב', 1)]);
    const { rows } = await testDb().query<{ reason: string; input_hash: string }>(
      `SELECT reason, input_hash FROM audit_log WHERE business_id = $1 AND reason LIKE 'contact_draft:%'`,
      [BUSINESS],
    );
    expect(rows).toEqual([{ reason: 'contact_draft:2', input_hash: canonicalHash({ key: CONTACT.slice(1) }) }]);
  });

  it('a tripped kill switch skips the tier-2 sources; the card says so', async () => {
    const w = await world();
    await addContact();
    await withBusiness(BUSINESS, (db) => trip(db, 'operations', 'test', 'stop'));
    await door(w, deps(w), [msg(CONTACT, 'יש לך את החשבונית?')]);
    expect(w.sourceCalls).toBe(0);
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(REASON_SOURCES_STOPPED);
  });

  it('a source that returns someone else\'s data: card with the reason, no draft', async () => {
    const w = await world();
    await addContact();
    const violating: Tier2Source = async () => ({ items: [], ownershipViolation: true });
    await door(w, deps(w, { sources: [violating] }), [msg(CONTACT, 'החשבונית שלי?')]);
    expect(w.drafts).toHaveLength(0);
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(REASON_OWNERSHIP);
  });

  it('a source past its deadline, a failed researcher and a failed drafter still raise a card with the reasons', async () => {
    const w = await world();
    await addContact();
    // Answers only well after its deadline. It must settle eventually: it now
    // holds a pooled connection of its own until it does (fix round 1).
    const hanging: Tier2Source = (_db, _ids, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => setTimeout(() => resolve({ items: [], ownershipViolation: false }), 100));
      });
    await door(
      w,
      deps(w, {
        sources: [hanging],
        tier2TimeoutMs: 30,
        research: async () => ({ status: 'failed', reason: 'boom' }),
        draft: async () => ({ status: 'failed', reason: 'boom' }),
      }),
      [msg(CONTACT, 'שאלה')],
    );
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(REASON_SOURCE_FAILED);
    expect(card?.detail).toContain(REASON_RESEARCH_FAILED);
    expect(card?.detail).toContain(REASON_DRAFT_FAILED);
  });

  it('a drafter that throws or hangs still raises a card', async () => {
    const w = await world();
    const flow = deps(w, { draftTimeoutMs: 30, draft: () => new Promise(() => undefined) });
    await door(w, flow, [msg(UNKNOWN, 'שאלה')]);
    expect((await approvals())[0]?.detail).toContain(REASON_DRAFT_FAILED);
  });

  it('an attachment the drafter names that tier-2 did not return is dropped with a reason (R11c)', async () => {
    const w = await world();
    await addContact();
    await insertDocument('DOC-0000000000STRANGER');
    await door(
      w,
      deps(w, {
        draft: async () => ({ status: 'drafted', body: 'מצרפת', usedTier3: false, attachDocumentId: 'DOC-0000000000STRANGER' }),
      }),
      [msg(CONTACT, 'תשלחי את החשבונית')],
    );
    const [card] = await approvals();
    expect(card?.proposed_input['attachDocumentId']).toBeUndefined();
    expect(card?.detail).toContain(REASON_ATTACHMENT_DROPPED);
  });

  it('an attachment tier-2 returned in this run is kept (R11c)', async () => {
    const w = await world();
    await addContact();
    await insertDocument('DOC-0000000000OWNINVOICE');
    const item: SourceItem = { source: 'uploaded_invoices', label: 'חשבונית 12', text: 'סכום 100', documentId: 'DOC-0000000000OWNINVOICE', at: null };
    await door(
      w,
      deps(w, {
        items: [item],
        draft: async () => ({ status: 'drafted', body: 'מצרפת', usedTier3: false, attachDocumentId: 'DOC-0000000000OWNINVOICE' }),
      }),
      [msg(CONTACT, 'תשלחי את החשבונית')],
    );
    const [card] = await approvals();
    expect(card?.proposed_input['attachDocumentId']).toBe('DOC-0000000000OWNINVOICE');
    expect(card?.detail).not.toContain(REASON_ATTACHMENT_DROPPED);
    expect(card?.detail).toContain('חשבונית 12');
  });

  it('a new message while the card is approved but unsent: stays on the conversation, one owner note, no re-draft (R11a)', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'שאלה ראשונה')]);
    const [first] = await approvals();
    await withBusiness(BUSINESS, (db) => decide(db, first!.approval_id, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    const ownerBefore = sentTo(w, PRINCIPAL).length;

    const result = await door(w, deps(w), [msg(CONTACT, 'ועוד ‮משהו', 5_000)]);

    expect(result.contactHandled).toBe(1);
    expect(w.drafts).toHaveLength(1); // only the first message's draft
    expect(await approvals()).toHaveLength(1);
    const note = sentTo(w, PRINCIPAL).slice(ownerBefore);
    expect(note).toHaveLength(1);
    expect(note[0]?.body).toContain('דנה לוי');
    expect(note[0]?.body).toContain('ועוד משהו');
    expect(note[0]?.body).not.toContain('‮');
    const rows = await inbound();
    expect(rows[1]).toMatchObject({ state: 'handled', job_id: first!.job_id });
    const [conv] = await conversations();
    expect(conv?.card_job_id).toBe(first!.job_id);
  });

  it('without the flow wired, a stranger is recorded only, labelled unknown (R11d)', async () => {
    const w = await world();
    const result = await door(w, undefined, [msg(UNKNOWN, 'שלום')]);
    expect(result.recordedOnly).toBe(1);
    expect(w.gateway.sent).toEqual([]);
    expect((await inbound())[0]?.sender_kind).toBe('unknown');
  });

  it('the owner\'s "שלח" through the door decides the presented contact card', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'שאלה')]);
    const [card] = await approvals();
    const result = await door(w, deps(w), [msg(PRINCIPAL, 'שלח', 3_000)]);
    expect(result.contactCardReplies).toBe(1);
    expect((await approvals())[0]?.state).toBe('approved');
    expect(card?.state).toBe('pending');
  });

  it('the owner\'s "שלח" with a contact card and another open thing is refused', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'שאלה')]);
    // A second contact card open at the same time: "שלח" cannot say which.
    await door(w, deps(w), [msg(UNKNOWN, 'שאלה אחרת', 1_000)]);
    const result = await door(w, deps(w), [msg(PRINCIPAL, 'שלח', 3_000)]);
    expect(result.contactCardReplies).toBe(0);
    expect(result.refused).toBe(1);
    expect((await approvals()).every((a) => a.state === 'pending')).toBe(true);
  });
});

async function insertDocument(id: string): Promise<void> {
  await testDb().query(
    `INSERT INTO documents (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, 'manual', 'invoice.pdf', 'application/pdf', $3, 10, $4, 'extracted')`,
    [id, BUSINESS, 'c'.repeat(64), `${BUSINESS}/${id}/original.pdf`],
  );
}

describe('fix round 1', () => {
  it('a source that ignores its signal and writes after its deadline runs on its own connection and cannot touch the card', async () => {
    const w = await world();
    await addContact();
    let doorPid = -1;
    let sourcePid = -2;
    let lateWrite: () => void = () => undefined;
    const lateDone = new Promise<void>((resolve) => {
      lateWrite = resolve;
    });
    const late: Tier2Source = async (own) => {
      const { rows } = await own.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      sourcePid = rows[0]!.pid;
      await new Promise((r) => setTimeout(r, 150));
      // Long past the 20 ms deadline, ignoring the aborted signal.
      await own.query(
        `INSERT INTO whatsapp_messages (id, business_id, direction, body, provider_timestamp, state)
         VALUES ('WA-LATE', $1, 'outbound', 'late', now(), 'handled')`,
        [own.businessId],
      );
      lateWrite();
      return { items: [], ownershipViolation: false };
    };
    w.gateway.enqueue(msg(CONTACT, 'שאלה'));
    const result = await withBusiness(BUSINESS, async (db) => {
      const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      doorPid = rows[0]!.pid;
      return runWhatsAppDoor(db, {
        gateway: w.gateway,
        messenger: w.messenger,
        charter: w.charter,
        contactFlow: deps(w, { sources: [late], tier2TimeoutMs: 20 }),
      });
    });
    expect(sourcePid).not.toBe(doorPid);
    expect(result.contactHandled).toBe(1);
    expect(result.contactFailed).toBe(0);
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(REASON_SOURCE_FAILED);
    const [conv] = await conversations();
    expect(conv).toMatchObject({ state: 'carded', card_job_id: card!.job_id });

    await lateDone;
    // The late row committed on its own connection, apart from the card.
    const { rows } = await testDb().query(`SELECT 1 FROM whatsapp_messages WHERE id = 'WA-LATE'`);
    expect(rows).toHaveLength(1);
    expect((await approvals())[0]?.state).toBe('pending');
  });

  it('the researcher gets a connection of its own', async () => {
    const w = await world();
    await addContact();
    let doorPid = -1;
    let researchPid = -2;
    w.gateway.enqueue(msg(CONTACT, 'שאלה'));
    await withBusiness(BUSINESS, async (db) => {
      doorPid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      return runWhatsAppDoor(db, {
        gateway: w.gateway,
        messenger: w.messenger,
        charter: w.charter,
        contactFlow: {
          ...deps(w),
          researcher: async (req) => {
            researchPid = (await req.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            return { status: 'none' };
          },
        },
      });
    });
    expect(researchPid).not.toBe(doorPid);
  });

  it('the drafter receives a signal that aborts at its deadline', async () => {
    const w = await world();
    let seen: AbortSignal | undefined;
    const flow = deps(w, {
      draftTimeoutMs: 20,
      draft: (req) => {
        seen = req.signal;
        return new Promise(() => undefined);
      },
    });
    await door(w, flow, [msg(UNKNOWN, 'שאלה')]);
    expect(seen?.aborted).toBe(true);
    expect((await approvals())[0]?.detail).toContain(REASON_DRAFT_FAILED);
  });

  it('busy: a throwing owner note does not mark the messages failed', async () => {
    const w = await world();
    await addContact();
    await door(w, deps(w), [msg(CONTACT, 'ראשונה')]);
    const [first] = await approvals();
    await withBusiness(BUSINESS, (db) => decide(db, first!.approval_id, 'approved', { by: 'whatsapp:test', channel: 'whatsapp' }));
    const throwing: BossMessenger = {
      ...w.messenger,
      send: async () => {
        throw new Error('note failed');
      },
    };
    const result = await door(w, deps(w, { messenger: throwing }), [msg(CONTACT, 'שנייה', 5_000)]);
    expect(result.contactHandled).toBe(1);
    expect(result.contactFailed).toBe(0);
    expect((await inbound())[1]).toMatchObject({ state: 'handled', job_id: first!.job_id });
  });

  it('a sender lookup that fails still records the message, recorded only — never handed to the flow', async () => {
    const w = await world();
    w.gateway.enqueue(msg(UNKNOWN, 'שלום'));
    const result = await withBusiness(BUSINESS, (db) => {
      const flaky = Object.create(db) as typeof db;
      flaky.query = ((sql: string, params?: unknown[]) => {
        if (/FROM business_colleagues/.test(sql)) throw new Error('db blip');
        return db.query(sql, params as never);
      }) as typeof db.query;
      return runWhatsAppDoor(flaky, { gateway: w.gateway, messenger: w.messenger, charter: w.charter, contactFlow: deps(w) });
    });
    expect(result.recordedOnly).toBe(1);
    expect(result.contactHandled).toBe(0);
    expect(w.gateway.sent).toEqual([]);
    expect(await inbound()).toEqual([{ sender_kind: 'unknown', state: 'handled', job_id: null }]);
  });

  it('a failed sender lookup does not stop the owner: his message is still an instruction path', async () => {
    const w = await world();
    w.gateway.enqueue(msg(PRINCIPAL, 'שלום'));
    await withBusiness(BUSINESS, (db) => {
      const flaky = Object.create(db) as typeof db;
      flaky.query = ((sql: string, params?: unknown[]) => {
        if (/FROM business_colleagues/.test(sql)) throw new Error('db blip');
        return db.query(sql, params as never);
      }) as typeof db.query;
      return runWhatsAppDoor(flaky, { gateway: w.gateway, messenger: w.messenger, charter: w.charter });
    });
    expect((await inbound())[0]?.sender_kind).toBe('principal');
  });
});
