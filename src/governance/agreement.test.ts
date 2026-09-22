import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { decide, enqueueApproval } from './approvals.js';
import { approvalStreak, STREAK_REQUIRED } from './agreement.js';

import type { PolicyBundle, ActionFacts } from '../domain/policy.js';

const BUSINESS = 'test-business';

let bundle: PolicyBundle;
/** Bumped on every seeded row so each gets a distinct, strictly-increasing `decided_at`. */
let sequence = 0;

/**
 * Real `ActionFacts`, never `as never` — see `consume.test.ts`, which this
 * shape is copied from. `actionClass` is fixed to 'email.reply' because that
 * is the class every test in this file measures.
 */
function factsFor(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.reply',
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    inputHash: canonicalHash(input),
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: ['dana@example.com'],
    counterpartyPhones: [],
    counterpartyTags: [],
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
  };
}

/** Seed one decided card. `edited` produces `approved_with_edit`. */
async function card(
  outcome: 'approved' | 'denied',
  opts: { edited?: boolean } = {},
): Promise<void> {
  sequence += 1;
  const input = { to: 'dana@example.com', body: `card-${sequence}` };
  const facts = factsFor(input);
  const risk = await assessRisk(facts, bundle);
  const approvalId = await enqueueApproval(
    { facts, risk, proposedInput: input, summary: 'שליחת מייל' },
    { businessId: BUSINESS },
  );

  const editedInput = opts.edited ? { ...input, body: 'נוסח מחדש' } : undefined;
  await decide(
    approvalId,
    outcome,
    {
      by: 'p_boss',
      channel: 'dashboard',
      ...(editedInput !== undefined ? { editedInput } : {}),
    },
    { businessId: BUSINESS },
  );

  // `decide` stamps `decided_at` with SQL now(). Two cards seeded back to
  // back in the same test can land on the same tick if now()'s resolution is
  // coarser than the gap between calls, which would make the streak's
  // `ORDER BY decided_at DESC` ambiguous and the test flaky. Overwriting it
  // with a value that strictly increases with `sequence` removes the race.
  await getPool().query(
    `UPDATE approval_requests SET decided_at = $1 WHERE approval_id = $2`,
    [new Date(Date.now() + sequence * 1_000).toISOString(), approvalId],
  );
}

describe('the agreement streak', () => {
  beforeEach(async () => {
    await resetDatabase();
    sequence = 0;
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  });
  afterAll(async () => {
    await closePool();
  });

  it('is zero with no history at all', async () => {
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(0);
  });

  it('counts consecutive clean approvals, newest first', async () => {
    for (let i = 0; i < 3; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(3);
  });

  /**
   * Spec §4.2 — the decision the whole measurement turns on. An edit means
   * the owner had to work, which is the time this project exists to save.
   */
  it('treats an approval the owner edited as a break, not a win', async () => {
    await card('approved', { edited: true });
    for (let i = 0; i < 4; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(4);
  });

  it('breaks on a denial', async () => {
    await card('denied');
    for (let i = 0; i < 2; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(2);
  });

  /**
   * Spec §4.3 — an expired card says nobody answered. That is not the
   * assistant being right and not her being wrong, so it must neither count
   * nor break. Seeded by writing the state directly, because expiry is the
   * scheduler's job (`expireOverdue`), not something `decide` produces.
   */
  it('ignores an expired card entirely — it neither counts nor breaks', async () => {
    for (let i = 0; i < 2; i += 1) await card('approved');

    sequence += 1;
    const input = { to: 'dana@example.com', body: `expired-${sequence}` };
    const facts = factsFor(input);
    const risk = await assessRisk(facts, bundle);
    await getPool().query(
      `INSERT INTO approval_requests (
         approval_id, business_id, action_class, summary, detail, risk,
         proposed_tool, proposed_input, input_hash, expires_at, state, decided_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '1 hour', 'expired', $10)`,
      [
        `AP-expired-${sequence}`,
        BUSINESS,
        facts.actionClass,
        'שליחת מייל',
        'שליחת מייל',
        JSON.stringify(risk),
        facts.toolName,
        JSON.stringify(input),
        facts.inputHash,
        // Between the decided_at of the two cards seeded before it and the
        // two seeded after — a real expiry sitting mid-history, not at an edge
        // where its exclusion would be indistinguishable from never existing.
        new Date(Date.now() + sequence * 1_000).toISOString(),
      ],
    );

    for (let i = 0; i < 2; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(4);
  });

  it('never reports more than the required streak', async () => {
    for (let i = 0; i < STREAK_REQUIRED + 5; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(STREAK_REQUIRED);
  });

  it('counts each action class on its own', async () => {
    for (let i = 0; i < 3; i += 1) await card('approved');
    expect(await approvalStreak('calendar.create', { businessId: BUSINESS })).toBe(0);
  });
});
