/**
 * The auto-reply exemption for a WhatsApp contact (phase 2 package 1, spec §7).
 *
 * Every test runs the real `evaluateToolCall` against `buildCharter()` (its
 * `whatsapp.reply` base is `auto_notify`) on a card job whose provenance is
 * `unknown_external`, with the dial at `off` — so the ramp is `draft_only`
 * and the provenance ceiling is `draft_only` too. Those two are the ONLY
 * things that would refuse the call, so each negative test proves its
 * refusal came from stage 8: the deny code is `draft_only` AND no
 * `intent_to_act` row was written. A negative test that saw only "deny"
 * would hold with its condition deleted, for the boring reason that
 * something later refused instead.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { buildCharter, type CharterOverrides } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import { DENY_CODES } from '../domain/policy.js';
import { evaluateFor, type TestGateContext } from '../test/gate.js';
import { canonicalHash } from '../util/canonical.js';
import { addManagedContact, removeManagedContact, updateManagedContact } from '../business/settings-contacts.js';
import { addColleague } from '../business/colleagues.js';
import { PersonEntry } from '../business/setup-package.js';
import { createTopic, retireTopic, setTopicAutoReply, updateTopic } from '../whatsapp/contact-topics.js';
import { saveAutoReplyEnabled } from '../whatsapp/sources/invoice-settings.js';
import { writeClearance } from '../whatsapp/auto-clearance.js';
import { WHATSAPP_CONTACTS_SYSTEM } from '../charter/amend-whatsapp-contacts.js';
import { buildFacts } from './facts.js';
import { assessRisk } from './risk.js';
import { CONTACT_REPLY_EXEMPTION_MARKER, contactReplyCovers } from './contact-reply.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const STEP_ID = 'reply';
const PHONE = '+972501234567';
const KEY = '972501234567';
const OTHER_PHONE = '+972509999999';

const WA = { to: PHONE, body: 'החשבונית האחרונה נשלחה ב-12/11.', conversationId: 'conv-1' };

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await closePool(); });

interface Setup {
  jobId: string;
  topicId: string;
  ctx: TestGateContext;
}

const WA_CONNECTION = {
  system: WHATSAPP_CONTACTS_SYSTEM,
  label: 'וואטסאפ ללקוחות ולספקים',
  channel: 'api' as const,
  serves: ['wa.send_message'],
  target: null,
  subprocessor: null,
};

interface SetupOptions {
  connection?: boolean;
  settingsOn?: boolean;
  conversationState?: 'carded' | 'answered';
  conversationKind?: 'client' | 'supplier';
  contactKey?: string;
  clearanceInput?: Record<string, unknown> | null;
  topicAppliesTo?: 'client' | 'supplier' | 'both';
}

async function setup(overrides: CharterOverrides = {}, o: SetupOptions = {}): Promise<Setup> {
  const bundle = await withBusiness(BUSINESS, (db) => installCharter(
    db,
    buildCharter({ connections: o.connection === false ? [] : [WA_CONNECTION], ...overrides }),
  ));
  const rampLevel = await withBusiness(BUSINESS, (db) => loadRampLevel(db, 'whatsapp.reply'));
  // The dial is at its default `off`: the ramp is clamped to draft_only, so
  // without the exemption stage 8 refuses.
  expect(rampLevel).toBe('draft_only');

  await withBusiness(BUSINESS, (db) =>
    addManagedContact(db, PersonEntry.parse({ name: 'דנה כהן', role: 'לקוחה', phone: PHONE, kind: 'client' })),
  );
  const topic = await withBusiness(BUSINESS, (db) => createTopic(db, {
    name: 'חשבוניות',
    description: 'מתי נשלחה חשבונית',
    appliesTo: o.topicAppliesTo ?? 'client',
    sources: ['uploaded_invoices'],
    autoReply: true,
    by: 'owner',
  }));
  if (o.settingsOn !== false) await withBusiness(BUSINESS, (db) => saveAutoReplyEnabled(db, true, 'owner'));

  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
  }));
  await testDb().query(
    `INSERT INTO contact_conversations
       (business_id, conversation_id, contact_key, contact_kind, state, last_inbound_at, card_job_id)
     VALUES ($1, 'conv-1', $2, $3, $4, now(), $5)`,
    [BUSINESS, o.contactKey ?? KEY, o.conversationKind ?? 'client', o.conversationState ?? 'carded', job.jobId],
  );
  const clearanceInput = o.clearanceInput === undefined ? WA : o.clearanceInput;
  if (clearanceInput !== null) {
    await withBusiness(BUSINESS, (db) => writeClearance(db, {
      jobId: job.jobId,
      stepId: STEP_ID,
      inputHash: canonicalHash(clearanceInput),
      conversationId: 'conv-1',
      topicId: topic.topicId,
    }));
  }
  return {
    jobId: job.jobId,
    topicId: topic.topicId,
    ctx: {
      agent: 'comms.whatsapp',
      bundle,
      jobId: job.jobId,
      stepId: STEP_ID,
      provenance: 'unknown_external',
      chainDepth: 1,
      counterpartyTags: [],
      rampLevel,
      businessId: BUSINESS,
      now: NOON,
    },
  };
}

async function intentRows(): Promise<{ reason: string; risk: { band?: string } | null }[]> {
  const { rows } = await testDb().query<{ reason: string; risk: { band?: string } | null }>(
    `SELECT reason, risk FROM audit_log WHERE business_id = $1 AND kind = 'intent_to_act' ORDER BY seq`,
    [BUSINESS],
  );
  return rows;
}

type Decision = Awaited<ReturnType<typeof evaluateFor>>;

async function expectDeniedAtStage8(decision: Decision): Promise<void> {
  expect(decision.outcome).toBe('deny');
  if (decision.outcome !== 'deny') throw new Error('unreachable');
  expect(decision.code.startsWith(DENY_CODES.draftOnly)).toBe(true);
  expect(await intentRows()).toHaveLength(0);
}

describe('an auto reply to a managed contact on a cleared payload', () => {
  it('is allowed with no card, and the intent row ends with the marker', async () => {
    const s = await setup();
    const decision = await evaluateFor('wa.send_message', WA, s.ctx);

    expect(decision.outcome).toBe('allow');
    const rows = await intentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason.endsWith(` ${CONTACT_REPLY_EXEMPTION_MARKER}`)).toBe(true);
    const { rows: approvals } = await testDb().query('SELECT 1 FROM approval_requests WHERE business_id = $1', [BUSINESS]);
    expect(approvals).toHaveLength(0);
  });

  it('a call the exemption did not carry has no marker on its intent row', async () => {
    // The provenance ceiling and the ramp already allow it, and no clearance
    // exists: stage 8 passes without the exemption and the row must not claim it.
    const s = await setup({ provenanceCeiling: { unknown_external: 'auto_notify' } }, { clearanceInput: null });
    const decision = await evaluateFor('wa.send_message', WA, { ...s.ctx, rampLevel: 'auto_notify' });
    expect(await intentRows()).toHaveLength(1);
    expect((await intentRows())[0]?.reason).not.toContain(CONTACT_REPLY_EXEMPTION_MARKER);
    expect(decision.outcome).not.toBe('deny');
  });
});

describe('each condition, flipped alone, is refused at stage 8', () => {
  it('1a. an approval on the context turns it off', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, {
      ...s.ctx, approval: { approvalId: 'no-such-approval', stepId: STEP_ID },
    }));
  });

  it('1b. no job id is refused', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, { ...s.ctx, jobId: null }));
  });

  it('1c. no step id is refused', async () => {
    const s = await setup();
    const { stepId: _step, ...noStep } = s.ctx;
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, noStep));
  });

  it('1d. a step id the clearance was not written for is refused', async () => {
    const s = await setup();
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, { ...s.ctx, stepId: 'other-step' }));
  });

  it('2a. whatsapp.initiate (no conversationId) is refused', async () => {
    const { conversationId: _c, ...initiate } = WA;
    const s = await setup({}, { clearanceInput: initiate });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', initiate, s.ctx));
  });

  it('2b. a declared amount is refused', async () => {
    const withAmount = { ...WA, amountMinor: 0 };
    const s = await setup({}, { clearanceInput: withAmount });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', withAmount, s.ctx));
  });

  it('3a. a `to` that is not an international number is refused', async () => {
    const local = { ...WA, to: '0501234567' };
    const s = await setup({}, { clearanceInput: local });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', local, s.ctx));
  });

  it('3b. a second phone key on the payload is refused', async () => {
    const extra = { ...WA, phone: OTHER_PHONE };
    const s = await setup({}, { clearanceInput: extra });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', extra, s.ctx));
  });

  it('4a. a conversation no longer carded is refused', async () => {
    const s = await setup({}, { conversationState: 'answered' });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('4b. a `to` other than the conversation number is refused', async () => {
    const other = { ...WA, to: OTHER_PHONE };
    const s = await setup({}, { clearanceInput: other });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', other, s.ctx));
  });

  it('4d. `to` another managed contact of the same kind, not the conversation number, is refused', async () => {
    // Only the conversation-number condition can refuse this one: the other
    // number IS a managed client, so the contact re-check would pass.
    const other = { ...WA, to: OTHER_PHONE };
    const s = await setup({}, { clearanceInput: other });
    await withBusiness(BUSINESS, (db) =>
      addManagedContact(db, PersonEntry.parse({ name: 'רון לוי', role: 'לקוח', phone: OTHER_PHONE, kind: 'client' })),
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', other, s.ctx));
  });

  it('4c. a conversation of another business naming this job does not count', async () => {
    const s = await setup();
    await testDb().query(
      `UPDATE contact_conversations SET business_id = 'other-business' WHERE business_id = $1`,
      [BUSINESS],
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('5a. a clearance for a different body is refused', async () => {
    const s = await setup({}, { clearanceInput: { ...WA, body: 'טקסט אחר' } });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('5b. no clearance at all is refused', async () => {
    const s = await setup({}, { clearanceInput: null });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('5c. a clearance for another conversation is refused', async () => {
    const s = await setup();
    await testDb().query(
      `UPDATE contact_auto_clearances SET conversation_id = 'conv-2' WHERE business_id = $1`,
      [BUSINESS],
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('6. a job with an unknown step result is refused', async () => {
    const s = await setup();
    await testDb().query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status)
       VALUES ($1, $2, 'h-earlier', 'reply', 'unknown')`,
      [BUSINESS, s.jobId],
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('7a. a charter without the whatsapp-contacts connection is refused', async () => {
    const s = await setup({}, { connection: false });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('7b. a charter base of approve_required for whatsapp.reply is refused', async () => {
    // With the exemption applied the effective level would be approve_required,
    // which passes stage 8 and queues at stage 10 (writing an intent row) —
    // so the stage-8 refusal proves the base condition itself refused.
    const s = await setup({ autonomyBase: { 'whatsapp.reply': 'approve_required' } });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('8. the settings switch off is refused', async () => {
    const s = await setup({}, { settingsOn: false });
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9a. a topic retired after the clearance is refused', async () => {
    const s = await setup();
    await withBusiness(BUSINESS, (db) => retireTopic(db, s.topicId, 'owner'));
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9a2. a retired topic is refused even if its auto-reply flag stayed on', async () => {
    // `retireTopic` also clears `auto_reply`; a row retired by any other path
    // must still refuse on `retired_at` alone.
    const s = await setup();
    await testDb().query(
      `UPDATE contact_topics SET retired_at = now() WHERE business_id = $1 AND topic_id = $2`,
      [BUSINESS, s.topicId],
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9b. a topic whose auto-reply was turned off after the clearance is refused', async () => {
    const s = await setup();
    await withBusiness(BUSINESS, (db) => setTopicAutoReply(db, s.topicId, false, 'owner'));
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9c. a topic that no longer applies to clients is refused', async () => {
    const s = await setup();
    await withBusiness(BUSINESS, (db) => updateTopic(db, s.topicId, { appliesTo: 'supplier' }, 'owner'));
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9d. a contact whose kind changed to supplier is refused', async () => {
    // The topic applies to both, so only the contact/conversation kind mismatch refuses.
    const s = await setup({}, { topicAppliesTo: 'both' });
    await withBusiness(BUSINESS, (db) => updateManagedContact(
      db, `+${KEY}`, PersonEntry.parse({ name: 'דנה כהן', role: 'ספקית', phone: PHONE, kind: 'supplier' }),
    ));
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9e. a contact that was removed is refused', async () => {
    const s = await setup();
    expect(await withBusiness(BUSINESS, (db) => removeManagedContact(db, `+${KEY}`))).toBe(true);
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9f. a number that is also a colleague is refused', async () => {
    const s = await setup();
    await withBusiness(BUSINESS, (db) =>
      addColleague(db, PersonEntry.parse({ name: 'דנה כהן', role: 'עובדת', phone: PHONE })),
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });

  it('9g. a learned (not owner-managed) entity on the number does not count', async () => {
    const s = await setup();
    await testDb().query(
      `UPDATE memories SET source_ref = 'mail:x' WHERE business_id = $1 AND kind = 'entity'`,
      [BUSINESS],
    );
    await expectDeniedAtStage8(await evaluateFor('wa.send_message', WA, s.ctx));
  });
});

describe('risk and what the exemption does not bypass', () => {
  it('a covered send to a number the charter does not know is routine', async () => {
    const s = await setup();
    const decision = await evaluateFor('wa.send_message', WA, s.ctx);
    expect(decision.outcome).toBe('allow');
    expect((await intentRows())[0]?.risk?.band).toBe('routine');
  });

  it('the same number without the extra known phone is one_unknown', async () => {
    const s = await setup();
    const facts = buildFacts('wa.send_message', WA, {
      provenance: 'unknown_external', chainDepth: 1, counterpartyTags: [],
    });
    const without = await assessRisk(facts, s.ctx.bundle);
    expect(without.dimensions.externalVisibility.audience).toBe('one_unknown');
    const withKnown = await assessRisk(facts, s.ctx.bundle, { extraKnownPhones: [KEY] });
    expect(withKnown.dimensions.externalVisibility.audience).toBe('one_known');
    const otherKnown = await assessRisk(facts, s.ctx.bundle, { extraKnownPhones: ['972509999999'] });
    expect(otherKnown.dimensions.externalVisibility.audience).toBe('one_unknown');
  });

  it('a forbidden rule on whatsapp.reply still denies when covered', async () => {
    const s = await setup({
      forbidden: [{ id: 'no_wa_replies', description: 'אין מענה בוואטסאפ', actionClasses: ['whatsapp.reply'] }],
    });
    const decision = await evaluateFor('wa.send_message', WA, s.ctx);
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code.startsWith('forbidden:')).toBe(true);
  });
});

describe('the class condition, called directly', () => {
  // Through the gate, `wa.send_message` is `whatsapp.reply` exactly when it
  // carries a `conversationId`, so condition 2's class check cannot be isolated
  // there; it is proven here on facts whose class alone differs.
  it('covers the cleared facts, and nothing with another class', async () => {
    const s = await setup();
    const facts = buildFacts('wa.send_message', WA, {
      provenance: 'unknown_external', chainDepth: 1, counterpartyTags: [],
    });
    const { businessId: _b, ...ctx } = s.ctx;
    await withBusiness(BUSINESS, async (db) => {
      expect(await contactReplyCovers(facts, WA, { ...ctx, db })).toEqual({ covered: true, knownPhone: KEY });
      for (const actionClass of ['whatsapp.initiate', 'email.reply'] as const) {
        expect(await contactReplyCovers({ ...facts, actionClass }, WA, { ...ctx, db })).toEqual({ covered: false });
      }
      expect(await contactReplyCovers(facts, WA, { ...ctx, db, jobId: '' })).toEqual({ covered: false });
      expect(await contactReplyCovers(facts, WA, { ...ctx, db, stepId: '' })).toEqual({ covered: false });
    });
  });
});
