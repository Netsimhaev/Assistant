/**
 * Phase 2, package 1 — the contact flow classifies, routes the sources by
 * topic and, only when every condition and the six exit checks hold, raises
 * the card job in `auto` mode: a clearance for the exact bound bytes, no
 * approval, straight to `execute`, no holding reply. Every other case is the
 * phase-1 card path, now carrying the classification and the exit reason.
 *
 * Models and sources are injected stubs; the database, the charter and the
 * door are real.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { WHATSAPP_CONTACTS_SYSTEM } from '../charter/amend-whatsapp-contacts.js';
import { trip } from '../governance/killswitch.js';
import { addManagedContact } from '../business/settings-contacts.js';
import { PersonEntry } from '../business/setup-package.js';
import { canonicalHash } from '../util/canonical.js';
import { runWhatsAppDoor } from '../orchestrator/whatsapp-door.js';
import type { ClassifierRequest, ContactClassifier } from '../sdk/contact-classifier.js';
import type { ContactDraftRequest, ContactDrafter, ContactDraftOutcome } from '../sdk/contact-drafter.js';
import type { ContactResearcher, ResearchOutcome } from '../sdk/contact-researcher.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';
import type { NormalizedInboundMessage } from './gateway.js';
import { createBossMessenger, type BossMessenger } from './messenger.js';
import { createTopic } from './contact-topics.js';
import { saveAutoReplyEnabled } from './sources/invoice-settings.js';
import { loadCardContext } from './card-context.js';
import { loadClearance } from './auto-clearance.js';
import { EXIT_REASONS } from './exit-checks.js';
import { namedSource, type SourceItem, type Tier2Source } from './sources/types.js';
import { CONTACT_AUTO_REASON } from './contact-card.js';
import type { ContactFlowDeps } from './contact-flow.js';
import type { BusinessCharter } from '../domain/charter.js';
import type { PolicyBundle } from '../domain/policy.js';

const BUSINESS = 'test-business';
const PRINCIPAL = '+972500000000';
const CONTACT = '+972501110001';
const UNKNOWN = '+972549999999';

const WA_CONNECTION = {
  system: WHATSAPP_CONTACTS_SYSTEM,
  label: 'וואטסאפ ללקוחות ולספקים',
  channel: 'api' as const,
  serves: ['wa.send_message'],
  target: null,
  subprocessor: null,
};

const LEDGER_ITEM: SourceItem = {
  source: 'ledger_of_sender',
  label: 'פנקס',
  text: 'חשבונית 4412 נשלחה ב-12/11',
  documentId: null,
  at: null,
};
const GROUNDED = 'שלום דנה, חשבונית 4412 נשלחה ב-12/11.';

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
  topicId: string;
  drafts: ContactDraftRequest[];
  classified: ClassifierRequest[];
  researched: number;
  sourceCalls: string[];
}

async function world(o: { charter?: CharterOverrides; settingsOn?: boolean } = {}): Promise<World> {
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ connections: [WA_CONNECTION], ...o.charter })));
  const active = await withBusiness(BUSINESS, (db) => loadActiveCharter(db));
  if (active === null) throw new Error('no charter');
  await withBusiness(BUSINESS, (db) =>
    addManagedContact(db, PersonEntry.parse({ name: 'דנה לוי', role: 'לקוחה', phone: CONTACT, kind: 'client' })),
  );
  const topic = await withBusiness(BUSINESS, (db) => createTopic(db, {
    name: 'חשבוניות',
    description: 'מתי נשלחה חשבונית',
    appliesTo: 'client',
    sources: ['ledger_of_sender'],
    autoReply: true,
    by: 'owner',
  }));
  if (o.settingsOn !== false) await withBusiness(BUSINESS, (db) => saveAutoReplyEnabled(db, true, 'owner'));
  const gateway = createFakeGateway();
  const messenger = createBossMessenger({ gateway, contactId: PRINCIPAL.slice(1), businessId: BUSINESS });
  return {
    charter: active.charter,
    bundle: { ...active.bundle, quietHours: null },
    gateway,
    messenger,
    topicId: topic.topicId,
    drafts: [],
    classified: [],
    researched: 0,
    sourceCalls: [],
  };
}

interface Overrides {
  kind?: 'question' | 'request' | 'commitment' | 'courtesy';
  topic?: 'same' | null;
  draft?: (req: ContactDraftRequest) => ContactDraftOutcome;
  research?: () => ResearchOutcome;
  extra?: Partial<ContactFlowDeps>;
}

function deps(w: World, o: Overrides = {}): ContactFlowDeps {
  const classifier: ContactClassifier = async (req) => {
    w.classified.push(req);
    return {
      status: 'classified',
      raw: {
        kind: o.kind ?? 'question',
        topicId: o.topic === null ? null : w.topicId,
        summary: 'מתי נשלחה החשבונית',
        window: null,
      },
    };
  };
  const drafter: ContactDrafter = async (req) => {
    w.drafts.push(req);
    return o.draft !== undefined ? o.draft(req) : { status: 'drafted', body: GROUNDED, usedTier3: false, attachDocumentId: null };
  };
  const researcher: ContactResearcher = async () => {
    w.researched += 1;
    return o.research !== undefined ? o.research() : { status: 'none' };
  };
  const stub = (name: string, items: SourceItem[]): Tier2Source => async () => {
    w.sourceCalls.push(name);
    return { items, ownershipViolation: false };
  };
  return {
    gateway: w.gateway,
    messenger: w.messenger,
    bundle: w.bundle,
    charter: w.charter,
    businessName: 'נגריית הדקל',
    researcher,
    drafter,
    classifier,
    sources: [
      namedSource('uploaded_invoices', stub('uploaded_invoices', [])),
      namedSource('ledger_of_sender', stub('ledger_of_sender', [LEDGER_ITEM])),
      namedSource('meetings_of_sender', stub('meetings_of_sender', [])),
    ],
    calendarSource: stub('calendar_busy', []),
    now: () => new Date(),
    ...o.extra,
  };
}

let n = 0;
function msg(sender: string, body: string, offsetMs = 0): NormalizedInboundMessage {
  n += 1;
  return {
    providerMessageId: `wamid.auto-${n}`,
    senderNumber: sender,
    body,
    mediaKind: null,
    providerTimestamp: new Date(Date.now() + offsetMs).toISOString(),
  };
}

function door(w: World, flow: ContactFlowDeps, messages: NormalizedInboundMessage[]) {
  for (const m of messages) w.gateway.enqueue(m);
  return withBusiness(BUSINESS, (db) =>
    runWhatsAppDoor(db, { gateway: w.gateway, messenger: w.messenger, charter: w.charter, contactFlow: flow }),
  );
}

const sentTo = (w: World, number: string) => w.gateway.sent.filter((s) => s.contactId === number.slice(1));

async function approvals() {
  const { rows } = await testDb().query<{ approval_id: string; job_id: string; state: string; detail: string }>(
    `SELECT approval_id, job_id, state, detail FROM approval_requests WHERE business_id = $1 ORDER BY created_at`,
    [BUSINESS],
  );
  return rows;
}

async function jobs() {
  const { rows } = await testDb().query<{ job_id: string; phase: string }>(
    `SELECT job_id, phase FROM jobs WHERE business_id = $1 AND provenance = 'unknown_external' ORDER BY created_at`,
    [BUSINESS],
  );
  return rows;
}

async function lastReason(jobId: string): Promise<string | undefined> {
  const { rows } = await testDb().query<{ reason: string }>(
    `SELECT reason FROM job_steps WHERE business_id = $1 AND job_id = $2 ORDER BY id DESC LIMIT 1`,
    [BUSINESS, jobId],
  );
  return rows[0]?.reason;
}

async function boundStepInput(jobId: string): Promise<{ id: string; input: Record<string, unknown> }> {
  const { rows } = await testDb().query<{ plan: { steps: { id: string; input: Record<string, unknown> }[] } }>(
    `SELECT plan FROM job_plans WHERE business_id = $1 AND job_id = $2`,
    [BUSINESS, jobId],
  );
  const step = rows[0]?.plan.steps[0];
  if (step === undefined) throw new Error('no bound plan');
  return step;
}

describe('the auto path', () => {
  it('a question with a grounded draft goes straight to execute: clearance, no approval, no holding, no researcher', async () => {
    const w = await world();
    const result = await door(w, deps(w), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);

    expect(result.contactHandled).toBe(1);
    expect(await approvals()).toHaveLength(0);
    const [job] = await jobs();
    expect(job?.phase).toBe('execute');
    expect(await lastReason(job!.job_id)).toBe(CONTACT_AUTO_REASON);

    const step = await boundStepInput(job!.job_id);
    const clearance = await withBusiness(BUSINESS, (db) => loadClearance(db, job!.job_id, step.id));
    expect(clearance?.inputHash).toBe(canonicalHash(step.input));
    expect(clearance?.topicId).toBe(w.topicId);
    expect(step.input['body']).toBe(GROUNDED);

    expect(sentTo(w, CONTACT)).toHaveLength(0); // no holding reply on the auto path
    expect(w.researched).toBe(0);
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]?.tier3).toEqual([]);
    expect(w.drafts[0]?.instruction).toBe('report_state');
    // Topic routing: invoices always, plus the topic's own source; never the others.
    expect(w.sourceCalls.sort()).toEqual(['ledger_of_sender', 'uploaded_invoices']);

    const ctx = await withBusiness(BUSINESS, (db) => loadCardContext(db, job!.job_id));
    expect(ctx).toMatchObject({ auto: true, kind: 'question', topicId: w.topicId, sourceNames: ['ledger_of_sender'] });
    const [conv] = (await testDb().query<{ card_job_id: string; state: string }>(
      `SELECT card_job_id, state FROM contact_conversations WHERE business_id = $1`, [BUSINESS])).rows;
    expect(conv).toMatchObject({ card_job_id: job!.job_id, state: 'carded' });
  });

  it('the same message classified as a request: card, holding reply, researcher, and the not-a-question reason (P3)', async () => {
    const w = await world();
    await door(w, deps(w, { kind: 'request' }), [msg(CONTACT, 'אפשר לשלוח שוב את החשבונית?')]);
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(EXIT_REASONS.notQuestion);
    expect(sentTo(w, CONTACT)).toHaveLength(1);
    expect(w.researched).toBe(1);
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]?.instruction).toBeUndefined();
    const ctx = await withBusiness(BUSINESS, (db) => loadCardContext(db, card!.job_id));
    expect(ctx).toMatchObject({ auto: false, kind: 'request' });
  });

  it('an ungrounded number fails the exit check: card, and a second draft with tier 3', async () => {
    const w = await world();
    const flow = deps(w, {
      draft: () => ({ status: 'drafted', body: 'החשבונית נשלחה ב-12/11 על סך 9,999 ש"ח', usedTier3: false, attachDocumentId: null }),
      research: () => ({ status: 'found', findings: [{ text: 'מסמך פנימי', documentId: null }] }),
    });
    await door(w, flow, [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    const [card] = await approvals();
    expect(card?.detail).toContain(EXIT_REASONS.ungrounded);
    expect(w.drafts).toHaveLength(2);
    expect(w.drafts[0]?.tier3).toEqual([]);
    expect(w.drafts[1]?.tier3).toEqual([{ text: 'מסמך פנימי' }]);
    expect(w.drafts[1]?.instruction).toBeUndefined();
    expect(w.researched).toBe(1);
    expect(sentTo(w, CONTACT)).toHaveLength(1);
  });

  it('an attachment that is not a tier-1/2 document fails the exit check: card', async () => {
    const w = await world();
    const flow = deps(w, {
      draft: () => ({ status: 'drafted', body: GROUNDED, usedTier3: false, attachDocumentId: 'DOC-NOTINSOURCES0001' }),
    });
    await door(w, flow, [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    const [card] = await approvals();
    expect(card?.state).toBe('pending');
    expect(card?.detail).toContain(EXIT_REASONS.attachment);
    expect(w.drafts).toHaveLength(2);
  });

  it('the settings switch off: card, no auto attempt', async () => {
    const w = await world({ settingsOn: false });
    await door(w, deps(w), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    expect((await approvals())[0]?.state).toBe('pending');
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]?.instruction).toBeUndefined();
    expect(w.researched).toBe(1);
  });

  it('the charter base at approve_required: card, no auto attempt', async () => {
    const w = await world({ charter: { autonomyBase: { 'whatsapp.reply': 'approve_required' } } });
    await door(w, deps(w), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    expect((await approvals())[0]?.state).toBe('pending');
    expect(w.drafts[0]?.instruction).toBeUndefined();
    expect(w.researched).toBe(1);
  });

  it('no topic: every source runs and nothing goes out alone', async () => {
    const w = await world();
    await door(w, deps(w, { topic: null }), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    expect((await approvals())[0]?.detail).toContain(EXIT_REASONS.topic);
    expect(w.sourceCalls.sort()).toEqual(['calendar_busy', 'ledger_of_sender', 'meetings_of_sender', 'uploaded_invoices']);
  });

  it('a tripped kill switch: no source runs (new ones included), and nothing goes out alone', async () => {
    const w = await world();
    await withBusiness(BUSINESS, (db) => trip(db, 'operations', 'test', 'stop'));
    await door(w, deps(w, { topic: null }), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    expect(w.sourceCalls).toEqual([]);
    expect((await approvals())[0]?.state).toBe('pending');
  });
});

describe('courtesy', () => {
  it('"תודה" with no live card: no card, no holding reply, no draft', async () => {
    const w = await world();
    const result = await door(w, deps(w, { kind: 'courtesy' }), [msg(CONTACT, 'תודה')]);
    expect(result.recordedOnly).toBe(1);
    expect(await approvals()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect(sentTo(w, CONTACT)).toHaveLength(0);
    expect(w.drafts).toHaveLength(0);
    expect(w.classified).toHaveLength(1);
    const { rows } = await testDb().query<{ state: string }>(
      `SELECT state FROM whatsapp_messages WHERE business_id = $1 AND direction = 'inbound'`, [BUSINESS]);
    expect(rows).toEqual([{ state: 'handled' }]);
  });

  it('"תודה" on a conversation with a live card goes the card path', async () => {
    const w = await world();
    await door(w, deps(w, { kind: 'request' }), [msg(CONTACT, 'אפשר לשלוח שוב?')]);
    expect(await approvals()).toHaveLength(1);
    await door(w, deps(w, { kind: 'courtesy' }), [msg(CONTACT, 'תודה', 2_000)]);
    expect(w.drafts).toHaveLength(2);
    const live = (await approvals()).filter((a) => a.state === 'pending');
    expect(live).toHaveLength(1);
    expect(await approvals()).toHaveLength(2);
  });
});

describe('busy and context', () => {
  it('an auto job waiting in followup is not replaced: busy note, no second job, no holding reply', async () => {
    const w = await world();
    await door(w, deps(w), [msg(CONTACT, 'נשלחה כבר החשבונית?')]);
    const [job] = await jobs();
    expect(job?.phase).toBe('execute');
    await testDb().query(`UPDATE jobs SET phase = 'followup' WHERE business_id = $1 AND job_id = $2`, [BUSINESS, job!.job_id]);
    const ownerBefore = sentTo(w, PRINCIPAL).length;

    const result = await door(w, deps(w), [msg(CONTACT, 'ועוד שאלה', 5_000)]);

    expect(result.contactHandled).toBe(1);
    expect(await jobs()).toHaveLength(1);
    expect(w.drafts).toHaveLength(1);
    expect(w.classified).toHaveLength(1);
    const notes = sentTo(w, PRINCIPAL).slice(ownerBefore);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain('ועוד שאלה');
    expect(sentTo(w, CONTACT)).toHaveLength(0);
  });

  it('a card job records the researcher findings\' document ids', async () => {
    const w = await world();
    const flow = deps(w, {
      kind: 'request',
      research: () => ({ status: 'found', findings: [
        { text: 'מסמך א', documentId: 'DOC-INTERNAL00000001' },
        { text: 'מסמך ב', documentId: null },
      ] }),
    });
    await door(w, flow, [msg(CONTACT, 'אפשר לשלוח שוב?')]);
    const [card] = await approvals();
    const ctx = await withBusiness(BUSINESS, (db) => loadCardContext(db, card!.job_id));
    expect(ctx?.internalDocumentIds).toEqual(['DOC-INTERNAL00000001']);
    expect(ctx?.auto).toBe(false);
  });

  it('an unknown sender with a matching topic: card, no source called', async () => {
    const w = await world();
    await door(w, deps(w), [msg(UNKNOWN, 'נשלחה כבר החשבונית?')]);
    expect((await approvals())[0]?.state).toBe('pending');
    expect(w.sourceCalls).toEqual([]);
    expect(w.researched).toBe(0);
    expect(w.classified).toHaveLength(1);
    expect(w.drafts).toHaveLength(1);
    expect(w.drafts[0]?.instruction).toBeUndefined();
  });
});
