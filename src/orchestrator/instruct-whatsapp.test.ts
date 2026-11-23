/**
 * The instruction door and an owner-ordered WhatsApp (task 13, H2 + H15).
 *
 * Real Postgres; the planner is an injected stub that returns a fixed plan,
 * so what is tested is `planAndCheck` and the confirmation echo — never a
 * model.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { buildCharter } from '../test/fixtures.js';
import { resetDatabase, testDb } from '../test/db.js';
import { addManagedContact } from '../business/settings-contacts.js';
import { PersonEntry } from '../business/setup-package.js';
import { writeMemory } from '../memory/store.js';
import { Plan } from '../domain/plan.js';
import type { PlanOutcome } from '../sdk/planner.js';
import { localParts } from '../util/local-time.js';
import { createJob } from './jobs.js';
import { runInstruction } from './instruct.js';
import { WA_RECIPIENT_REFUSAL } from './whatsapp-recipient.js';
import { WA_ATTACHMENT_WITHOUT_CONVERSATION_HE } from '../domain/wa-attachment.js';

const BUSINESS = 'test-business';
const TZ = 'Asia/Jerusalem';
const DANA = '+972541234567';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'wa-charter' })));
});
afterAll(async () => {
  await closePool();
});

function waPlan(input: Record<string, unknown>, expectedActionClass: 'whatsapp.initiate' | 'whatsapp.reply' = 'whatsapp.initiate'): Plan {
  return Plan.parse({
    goal: 'הודעת וואטסאפ',
    steps: [{
      id: 's1',
      agent: 'comms.whatsapp',
      intent: 'send',
      toolName: 'wa.send_message',
      input,
      expectedActionClass,
    }],
  });
}

function plannerReturning(plan: Plan): () => Promise<PlanOutcome> {
  return async () => ({ status: 'planned', plan }) as PlanOutcome;
}

async function instruct(
  text: string,
  plan: Plan,
  textOrigin: 'typed' | 'transcribed' = 'typed',
) {
  return withBusiness(BUSINESS, (db) => runInstruction(db, { text }, {
    textOrigin,
    channel: 'dashboard',
    planner: plannerReturning(plan),
  }));
}

async function saveContact(name: string, phone: string): Promise<void> {
  await withBusiness(BUSINESS, (db) => addManagedContact(db, PersonEntry.parse({ name, role: 'לקוחה', phone, kind: 'client' })));
}

describe('who an owner-ordered WhatsApp may go to', () => {
  it('typed number accepted', async () => {
    const outcome = await instruct(`תשלחי בוואטסאפ ל-${DANA} שהמסמך מוכן`, waPlan({ to: DANA, body: 'המסמך מוכן' }));
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') return;
    expect(outcome.question).toContain(`אל: ${DANA} (הוקלד בהוראה)`);
  });

  it('recipient learned from a document is refused at plan time', async () => {
    // A contact the assistant learned from a document — in memory, but not
    // one the owner saved, and not typed in this instruction.
    const charterVersion = 'wa-charter';
    const job = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion, provenance: 'unknown_external' }));
    await withBusiness(BUSINESS, (db) => writeMemory(db, {
      jobId: job.jobId,
      kind: 'entity',
      subjectKey: DANA,
      body: { name: 'דנה כהן', phone: DANA },
      sourceRef: 'document:DOC-1',
    }));

    const outcome = await instruct('תשלחי לדנה כהן בוואטסאפ שהמסמך מוכן', waPlan({ to: DANA, body: 'המסמך מוכן' }));
    expect(outcome).toEqual({ status: 'refused', reason: WA_RECIPIENT_REFUSAL });
  });

  it('a voice instruction does not count as typing the number', async () => {
    const outcome = await instruct(
      `תשלחי בוואטסאפ ל-${DANA} שהמסמך מוכן`,
      waPlan({ to: DANA, body: 'המסמך מוכן' }),
      'transcribed',
    );
    expect(outcome).toEqual({ status: 'refused', reason: WA_RECIPIENT_REFUSAL });
  });

  it('a saved contact counts from a voice instruction too, and is named in the echo', async () => {
    await saveContact('דנה כהן', DANA);
    const outcome = await instruct('תשלחי לדנה בוואטסאפ שהמסמך מוכן', waPlan({ to: DANA, body: 'המסמך מוכן' }), 'transcribed');
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') return;
    expect(outcome.question).toContain(`אל: ${DANA} (איש קשר ששמרת: דנה כהן)`);
  });

  it('a number sharing only the last nine digits is refused (exact key, never last-nine)', async () => {
    await saveContact('דנה כהן', DANA);
    const lookalike = '+44541234567';
    const outcome = await instruct(`תשלחי בוואטסאפ ל-${DANA}`, waPlan({ to: lookalike, body: 'שלום' }));
    expect(outcome).toEqual({ status: 'refused', reason: WA_RECIPIENT_REFUSAL });
  });

  it('a national-form number is refused even when typed', async () => {
    const outcome = await instruct('תשלחי בוואטסאפ ל-0541234567', waPlan({ to: '0541234567', body: 'שלום' }));
    expect(outcome).toEqual({ status: 'refused', reason: WA_RECIPIENT_REFUSAL });
  });

  it('a typed WhatsApp recipient becomes a standing grant (readPhones sees `to` for wa.*)', async () => {
    const outcome = await instruct(`תשלחי בוואטסאפ ל-${DANA} שהמסמך מוכן`, waPlan({ to: DANA, body: 'המסמך מוכן' }));
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') return;
    const { rows } = await testDb().query<{ recipients: string[] }>(
      'SELECT recipients FROM job_authorizations WHERE job_id = $1',
      [outcome.jobId],
    );
    // The digits-only form is what the gate's `readPhones(input, 'wa.*')`
    // yields for `to`; `readEmails` alone only ever contributes the raw
    // `+…` string.
    expect(rows.flatMap((r) => r.recipients)).toContain('972541234567');
  });
});

describe('an owner-ordered WhatsApp never attaches a stored file (I1)', () => {
  it('refuses attachDocumentId without a conversationId, before any question; the same plan without it is offered', async () => {
    const text = `תשלחי בוואטסאפ ל-${DANA} את הקובץ`;
    const refused = await instruct(text, waPlan({ to: DANA, body: 'מצורף', attachDocumentId: 'DOC-STRANGER' }));
    expect(refused).toEqual({ status: 'refused', reason: WA_ATTACHMENT_WITHOUT_CONVERSATION_HE });
    const { rows } = await testDb().query('SELECT 1 FROM instruction_confirmations');
    expect(rows).toHaveLength(0);
    // Positive control: identical recipient and body, no file — asked.
    const offered = await instruct(text, waPlan({ to: DANA, body: 'מצורף' }));
    expect(offered.status).toBe('needs_confirmation');
  });

  it('refuses attachDocumentId even with a real-looking conversationId — an owner order is never a card', async () => {
    const text = `תשלחי בוואטסאפ ל-${DANA} את הקובץ`;
    const refused = await instruct(
      text,
      waPlan({ to: DANA, body: 'מצורף', conversationId: 'CONV-REAL', attachDocumentId: 'DOC-STRANGER' }, 'whatsapp.reply'),
    );
    expect(refused).toEqual({ status: 'refused', reason: WA_ATTACHMENT_WITHOUT_CONVERSATION_HE });
    const { rows } = await testDb().query('SELECT 1 FROM instruction_confirmations');
    expect(rows).toHaveLength(0);
  });
});

describe('when an owner-ordered WhatsApp is sent', () => {
  it('sendAt 31 days ahead refused', async () => {
    const sendAt = new Date(Date.now() + 31 * DAY).toISOString();
    const outcome = await instruct(`תזכירי ל-${DANA} בוואטסאפ`, waPlan({ to: DANA, body: 'תזכורת', sendAt }));
    expect(outcome).toEqual({ status: 'refused', reason: 'אפשר לתזמן הודעת וואטסאפ עד 30 יום קדימה.' });
  });

  it('a sendAt in the past is refused', async () => {
    const sendAt = new Date(Date.now() - 60 * 1000).toISOString();
    const outcome = await instruct(`תזכירי ל-${DANA} בוואטסאפ`, waPlan({ to: DANA, body: 'תזכורת', sendAt }));
    expect(outcome).toEqual({ status: 'refused', reason: 'מועד השליחה בוואטסאפ כבר עבר.' });
  });

  it('a sendAt that is not an ISO instant with an offset is refused', async () => {
    for (const sendAt of ['מחר ב-9', '2030-01-01T09:00:00', '2030-02-30T09:00:00Z']) {
      const outcome = await instruct(`תזכירי ל-${DANA} בוואטסאפ`, waPlan({ to: DANA, body: 'תזכורת', sendAt }));
      expect(outcome).toEqual({ status: 'refused', reason: 'מועד השליחה בוואטסאפ אינו תקין.' });
    }
  });

  it('sendAt is shown as בשעה in the charter timezone', async () => {
    const at = new Date(Date.now() + 2 * DAY);
    at.setUTCSeconds(0, 0);
    const outcome = await instruct(`תזכירי ל-${DANA} בוואטסאפ`, waPlan({ to: DANA, body: 'תזכורת', sendAt: at.toISOString() }));
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') return;
    const { date, time } = localParts(at, TZ);
    const [y, m, d] = date.split('-');
    expect(outcome.question).toContain(`בשעה: ${d}/${m}/${y} ${time}`);
  });

  it('a sendAt on any other tool is refused', async () => {
    const mail = Plan.parse({
      goal: 'מייל',
      steps: [{
        id: 's1', agent: 'comms.email', intent: 'send', toolName: 'mail.send',
        input: { to: 'dana@example.com', subject: 's', body: 'b', sendAt: new Date(Date.now() + DAY).toISOString() },
        expectedActionClass: 'email.initiate',
      }],
    });
    const outcome = await instruct('תשלחי מייל ל-dana@example.com מחר', mail);
    expect(outcome).toEqual({ status: 'refused', reason: 'מועד שליחה אפשר לקבוע רק להודעת וואטסאפ.' });
  });
});

describe('a planted "saved contact" (security fix 1)', () => {
  it('a document-born write carrying sourceRef settings_people does not make the number sendable', async () => {
    const job = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: 'wa-charter', provenance: 'unknown_external' }));
    await withBusiness(BUSINESS, (db) => writeMemory(db, {
      jobId: job.jobId,
      kind: 'entity',
      subjectKey: DANA,
      body: { name: 'דנה', role: 'לקוחה', phone: DANA },
      sourceRef: 'settings_people',
    }));
    const outcome = await instruct('תשלחי לדנה בוואטסאפ שהמסמך מוכן', waPlan({ to: DANA, body: 'המסמך מוכן' }));
    expect(outcome).toEqual({ status: 'refused', reason: WA_RECIPIENT_REFUSAL });
  });
});
