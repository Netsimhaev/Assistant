/**
 * Colleagues never give instructions (admin-panel spec, "Roles"). The same
 * message, from the principal's number and from a colleague's, is handled
 * differently — and so is a number that is only in the technician's setup
 * package, before any charter names it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import type { Plan } from '../domain/plan.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import { addColleague } from '../business/colleagues.js';
import { saveSetupPackage } from '../business/setup-package.js';
import { runWhatsAppDoor } from './whatsapp-door.js';

const BUSINESS = 'colleague-business';
/** `buildCharter`'s default principal number. */
const PRINCIPAL_NUMBER = '+972500000000';
const COLLEAGUE_NUMBER = '+972501110003';
const PACKAGE_BOSS = '+972541234567';
const TEXT = 'תשלחי לדנה את ההצעה';

let n = 0;
function textMsg(senderNumber: string): NormalizedInboundMessage {
  n += 1;
  return {
    providerMessageId: `wamid.colleague-${n}`,
    senderNumber,
    body: TEXT,
    mediaKind: null,
    providerTimestamp: new Date().toISOString(),
  };
}

const recallPlan: Plan = {
  goal: 'להיזכר',
  assumptions: [],
  clarifyingQuestion: null,
  estimatedCostMinor: 0,
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'להיזכר',
      toolName: 'memory.recall',
      input: { subjectKey: 'dana@example.com' },
      dependsOn: [],
      expectedActionClass: null,
    },
  ],
};
const planned = async (): Promise<PlanOutcome> => ({ status: 'planned', plan: recallPlan });
const neverCalled = async (_r: PlanRequest): Promise<PlanOutcome> => {
  throw new Error('planner must not be called');
};

async function instructionRows(): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM boss_instructions WHERE business_id = $1',
    [BUSINESS],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('a colleague\'s WhatsApp message', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('from the principal: an instruction', async () => {
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter()));
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg(PRINCIPAL_NUMBER));
    const result = await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, planner: planned }));
    expect(result.instructed).toBe(1);
    expect(await instructionRows()).toBe(1);
    expect(messenger.sentTexts.length).toBeGreaterThan(0);
  });

  it('from a colleague: recorded only, no instruction, no reply', async () => {
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter()));
    await withBusiness(BUSINESS, (db) => addColleague(db, { name: 'יוסי', role: 'מנהל עבודה', phone: COLLEAGUE_NUMBER }));
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg(COLLEAGUE_NUMBER));
    const result = await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, planner: neverCalled }));
    expect(result.recordedOnly).toBe(1);
    expect(result.instructed).toBe(0);
    expect(await instructionRows()).toBe(0);
    expect(messenger.sentTexts).toEqual([]);
  });

  /**
   * Before any charter the door does not run at all: it refuses before it
   * touches the queue (the invariant `whatsapp-door.test.ts` locks, and the
   * scheduler skips both loops). So a number that is only in the setup
   * package is never even read — stricter than `recordedOnly`, and no
   * instruction, no reply.
   */
  it('from a number only in the setup package, before any charter: the door refuses, nothing is acted on', async () => {
    await withBusiness(BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: PACKAGE_BOSS, contacts: [], colleagues: [] }, 'tech'),
    );
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg(PACKAGE_BOSS));
    await expect(
      withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, planner: neverCalled })),
    ).rejects.toThrow(/no active charter/);
    expect(await instructionRows()).toBe(0);
    expect(messenger.sentTexts).toEqual([]);
  });

  /** And a charter whose principal is someone else never consults the package's number. */
  it('from the package boss number while the charter names another principal: recorded only', async () => {
    await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter()));
    await testDb().query(
      `INSERT INTO setup_packages (business_id, boss_whatsapp, updated_by) VALUES ($1, $2, 'tech')`,
      [BUSINESS, PACKAGE_BOSS],
    );
    const gateway = createFakeGateway();
    const messenger = createFakeMessenger();
    gateway.enqueue(textMsg(PACKAGE_BOSS));
    const result = await withBusiness(BUSINESS, (db) => runWhatsAppDoor(db, { gateway, messenger, planner: neverCalled }));
    expect(result.recordedOnly).toBe(1);
    expect(result.instructed).toBe(0);
    expect(await instructionRows()).toBe(0);
    expect(messenger.sentTexts).toEqual([]);
  });
});
