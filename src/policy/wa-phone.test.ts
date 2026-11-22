import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { PolicyBundle } from '../domain/policy.js';
import { resetDatabase } from '../test/db.js';
import { evaluateFor, type TestGateContext } from '../test/gate.js';
import { buildCharter } from '../test/fixtures.js';
import { buildFacts, readPhones } from './facts.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const NUMBER = '+972501234567';

async function install(overrides = {}): Promise<PolicyBundle> {
  return withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter(overrides)));
}

function ctx(bundle: PolicyBundle, agent = 'comms.whatsapp'): TestGateContext {
  return {
    agent,
    bundle,
    provenance: 'boss',
    chainDepth: 0,
    businessId: BUSINESS,
    jobId: 'J-TEST',
    counterpartyTags: [],
    rampLevel: 'auto',
    now: NOON,
  } as TestGateContext;
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('a wa.* tool reads `to` as a phone number', () => {
  it('(a) denies a message to a number the charter marks do-not-contact', async () => {
    const bundle = await install({ doNotContactPhone: NUMBER });
    const decision = await evaluateFor('wa.send_message', { to: NUMBER, body: 'שלום' }, ctx(bundle));
    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe('do_not_contact');
  });

  it('(b) scores a number in counterparties as known, not a first contact', async () => {
    const payload = { to: NUMBER, body: 'שלום' };
    const base = { autonomyBase: { 'whatsapp.initiate': 'auto' as const } };
    const unknown = await evaluateFor('wa.send_message', payload, ctx(await install(base)));
    expect(unknown.outcome).toBe('queue_approval');

    await resetDatabase();
    const known = await evaluateFor(
      'wa.send_message',
      payload,
      ctx(await install({ ...base, knownCounterpartyPhone: NUMBER })),
    );
    expect(known.outcome).toBe('allow');
  });

  it('reads an array of numbers, and ignores an inherited `to`', () => {
    expect(readPhones({ to: ['+972 50-123-4567', '+972521111111'] }, 'wa.send_message')).toEqual(['972501234567', '972521111111']);
    const inherited = Object.create({ to: NUMBER }) as Record<string, unknown>;
    expect(readPhones(inherited, 'wa.send_message')).toEqual([]);
  });
});

describe('`to` is not a phone for any other tool', () => {
  it('(c) a mail.send whose `to` looks like a phone is not read as one', async () => {
    const input = { to: NUMBER, inReplyTo: 'thread-1', body: 'שלום' };
    expect(buildFacts('mail.send', input, { provenance: 'boss', chainDepth: 0, counterpartyTags: [] }).counterpartyPhones).toEqual([]);
    const bundle = await install({ doNotContactPhone: NUMBER });
    const decision = await evaluateFor('mail.send', input, ctx(bundle, 'comms.email'));
    if (decision.outcome === 'deny') expect(decision.code).not.toBe('do_not_contact');
  });
});
