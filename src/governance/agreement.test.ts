import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { composeReplyDetail } from '../mail/reply-card.js';
import { decide, enqueueApproval } from './approvals.js';
import { AGREEMENT_WINDOW_DAYS, agreementFor, isLearned, type Agreement } from './agreement.js';

import type { PolicyBundle, ActionFacts } from '../domain/policy.js';

const BUSINESS = 'test-business';
const DAY_MS = 86_400_000;

let bundle: PolicyBundle;
let sequence = 0;

function factsFor(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.reply',
    provenance: 'unknown_external',
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

interface CardOptions {
  /** Job the card is raised on. Default: a fresh job, linked to a stored mail. */
  jobId?: string;
  /** Whether a `mail_messages` row names the job as its reply job. */
  linked?: boolean;
  /** `expired` / `cancelled` are written directly, as the scheduler does. */
  outcome?: 'approved' | 'denied' | 'approved_with_edit' | 'expired' | 'cancelled';
  editedBody?: string;
  detail?: string;
  decidedDaysAgo?: number;
  /** Seconds after the epoch of this file's run; orders `created_at`. */
  createdOffsetSeconds?: number;
}

async function card(opts: CardOptions = {}): Promise<string> {
  sequence += 1;
  const jobId = opts.jobId ?? `J-${sequence}`;
  const db = getPool();

  if (opts.linked !== false) {
    await db.query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
          received_at, body_text, state, reply_job_id)
       VALUES ($1, $2, $3, $4, 'dana@example.com', 's', now(), 'b', 'triaged', $5)
       ON CONFLICT DO NOTHING`,
      [`M-${sequence}`, BUSINESS, `pm-${sequence}`, `th-${sequence}`, jobId],
    );
  }

  const input = { to: ['dana@example.com'], subject: 'Re: s', body: 'תודה רבה על הפנייה שלך', ref: sequence };
  const facts = factsFor(input);
  const risk = await assessRisk(facts, bundle);
  const approvalId = await enqueueApproval(
    {
      facts,
      risk,
      proposedInput: input,
      summary: 'שליחת מייל',
      jobId,
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    },
    { businessId: BUSINESS },
  );

  const outcome = opts.outcome ?? 'approved';
  const decidedAt = new Date(Date.now() - (opts.decidedDaysAgo ?? 0) * DAY_MS - 1_000);
  if (outcome === 'expired' || outcome === 'cancelled') {
    await db.query(`UPDATE approval_requests SET state = $2, decided_at = $3 WHERE approval_id = $1`, [
      approvalId,
      outcome,
      decidedAt.toISOString(),
    ]);
  } else {
    await decide(
      approvalId,
      outcome === 'denied' ? 'denied' : 'approved',
      {
        by: 'p_boss',
        channel: 'dashboard',
        ...(outcome === 'approved_with_edit'
          ? { editedInput: { ...input, body: opts.editedBody ?? 'נוסח אחר לגמרי של התשובה הזו' } }
          : {}),
      },
      { businessId: BUSINESS },
    );
    await db.query(`UPDATE approval_requests SET decided_at = $2 WHERE approval_id = $1`, [
      approvalId,
      decidedAt.toISOString(),
    ]);
  }
  if (opts.createdOffsetSeconds !== undefined) {
    await db.query(`UPDATE approval_requests SET created_at = $2 WHERE approval_id = $1`, [
      approvalId,
      new Date(Date.UTC(2026, 0, 1) + opts.createdOffsetSeconds * 1_000).toISOString(),
    ]);
  }
  return approvalId;
}

const agreement = (since: Date | null = null): Promise<Agreement> =>
  agreementFor('email.reply', { businessId: BUSINESS, since });

describe('the windowed agreement rate', () => {
  beforeEach(async () => {
    await resetDatabase();
    sequence = 0;
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  });
  afterAll(async () => {
    await closePool();
  });

  it('is empty with no history at all', async () => {
    expect(await agreement()).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });

  it('five approvals are learned; four approvals and a denial are not', async () => {
    for (let i = 0; i < 5; i += 1) await card();
    const five = await agreement();
    expect(five).toEqual({ right: 5, counted: 5, topWrongReason: null });
    expect(isLearned(five)).toBe(true);

    await resetDatabase();
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    for (let i = 0; i < 4; i += 1) await card();
    await card({ outcome: 'denied' });
    const mixed = await agreement();
    expect(mixed).toEqual({ right: 4, counted: 5, topWrongReason: 'denied' });
    expect(isLearned(mixed)).toBe(false);
  });

  it('isLearned needs the minimum sample and is strict about the threshold', () => {
    expect(isLearned({ right: 4, counted: 4, topWrongReason: null })).toBe(false);
    expect(isLearned({ right: 8, counted: 10, topWrongReason: null })).toBe(false); // exactly 0.8
    expect(isLearned({ right: 9, counted: 10, topWrongReason: null })).toBe(true);
  });

  it('counts a light edit as right and a heavy one as wrong', async () => {
    await card({ outcome: 'approved_with_edit', editedBody: 'תודה רבה על הפנייה שלך בכיף' });
    await card({ outcome: 'approved_with_edit' });
    const a = await agreement();
    expect(a.counted).toBe(2);
    expect(a.right).toBe(1);
    expect(a.topWrongReason).toBe('too_many_words');
  });

  it('does not count a card on a job no mailbox message links to', async () => {
    await card({ linked: false });
    expect(await agreement()).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });

  it('does not count a linked job of another business', async () => {
    await card();
    expect(
      await agreementFor('email.reply', { businessId: 'other-business', since: null }),
    ).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });

  it('does not count a job whose only mail link belongs to another business', async () => {
    await card({ jobId: 'J-shared', linked: false });
    await getPool().query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
          received_at, body_text, state, reply_job_id)
       VALUES ('M-other', 'other-business', 'pm-other', 'th-other', 'x@example.com', 's',
               now(), 'b', 'triaged', 'J-shared')`,
    );
    expect(await agreement()).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });

  it('counts only the earliest decided card of a job', async () => {
    await card({ jobId: 'J-dup', outcome: 'denied', createdOffsetSeconds: 10 });
    await card({ jobId: 'J-dup', outcome: 'approved', createdOffsetSeconds: 20, linked: false });
    // The earlier card (the denial) is the one that counts, not the later approval.
    expect(await agreement()).toEqual({ right: 0, counted: 1, topWrongReason: 'denied' });

    await resetDatabase();
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    await card({ jobId: 'J-dup', outcome: 'approved', createdOffsetSeconds: 10 });
    await card({ jobId: 'J-dup', outcome: 'denied', createdOffsetSeconds: 20, linked: false });
    expect(await agreement()).toEqual({ right: 1, counted: 1, topWrongReason: null });
  });

  it('skips re-asked cards by their retry or expired header', async () => {
    await card({
      detail: composeReplyDetail({
        fromAddress: 'dana@example.com',
        replyTo: null,
        subject: 'Re: s',
        body: 'x',
        retry: { mayHaveSent: false },
      }),
    });
    await card({
      detail: composeReplyDetail({
        fromAddress: 'dana@example.com',
        replyTo: null,
        subject: 'Re: s',
        body: 'x',
        retry: { mayHaveSent: false, expired: true },
      }),
    });
    expect(await agreement()).toEqual({ right: 0, counted: 0, topWrongReason: null });

    // The same header text in the BODY is not a re-ask.
    await card({
      detail: composeReplyDetail({
        fromAddress: 'dana@example.com',
        replyTo: null,
        subject: 'Re: s',
        body: 'השליחה הקודמת לא הושלמה — לאשר שוב?',
      }),
    });
    expect((await agreement()).counted).toBe(1);
  });

  it('ignores expired and cancelled cards', async () => {
    await card({ outcome: 'expired' });
    await card({ outcome: 'cancelled' });
    await card();
    expect(await agreement()).toEqual({ right: 1, counted: 1, topWrongReason: null });
  });

  it('ignores cards decided outside the window', async () => {
    await card({ decidedDaysAgo: AGREEMENT_WINDOW_DAYS + 1 });
    await card({ decidedDaysAgo: AGREEMENT_WINDOW_DAYS - 1 });
    expect(await agreement()).toEqual({ right: 1, counted: 1, topWrongReason: null });
  });

  it('ignores cards decided before `since`', async () => {
    await card({ decidedDaysAgo: 5 });
    await card({ decidedDaysAgo: 1 });
    const since = new Date(Date.now() - 3 * DAY_MS);
    expect(await agreement(since)).toEqual({ right: 1, counted: 1, topWrongReason: null });
  });

  it('judges the window by the first card, not by a later one inside it', async () => {
    await card({ jobId: 'J-old', decidedDaysAgo: AGREEMENT_WINDOW_DAYS + 2, createdOffsetSeconds: 10 });
    await card({ jobId: 'J-old', decidedDaysAgo: 1, createdOffsetSeconds: 20, linked: false });
    expect(await agreement()).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });

  it('names the most frequent wrong reason; a tie goes to the earlier one in order', async () => {
    await card({ outcome: 'denied' });
    await card({ outcome: 'denied' });
    await card({ outcome: 'approved_with_edit' }); // too_many_words
    expect((await agreement()).topWrongReason).toBe('denied');

    await resetDatabase();
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    await card({ outcome: 'denied' });
    await card({ outcome: 'approved_with_edit' });
    expect((await agreement()).topWrongReason).toBe('too_many_words');
  });

  it('counts each action class on its own', async () => {
    await card();
    expect(
      await agreementFor('calendar.create', { businessId: BUSINESS, since: null }),
    ).toEqual({ right: 0, counted: 0, topWrongReason: null });
  });
});
