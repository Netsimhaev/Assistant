import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { assessRisk } from '../policy/risk.js';
import { canonicalHash } from '../util/canonical.js';
import { ActionClass } from '../domain/action.js';
import type { ActionFacts, PolicyBundle } from '../domain/policy.js';
import { decide, enqueueApproval } from '../governance/approvals.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import type { Agreement } from '../governance/agreement.js';
import { setRampLevel } from '../orchestrator/ramp.js';
import {
  classStatus,
  learningSnapshot,
  orderCards,
  overallScore,
  renderLearning,
  type ClassCard,
  type LearningSnapshot,
  type StatusInputs,
} from './learning-view.js';

const BUSINESS = 'test-business';

const agreement = (right: number, counted: number, topWrongReason: Agreement['topWrongReason'] = null): Agreement => ({
  right,
  counted,
  topWrongReason,
});

const card = (actionClass: ActionClass, a: Agreement, status: ClassCard['status']): ClassCard => ({
  actionClass,
  agreement: a,
  status,
  since: null,
});

const inputs = (overrides: Partial<StatusInputs> = {}): StatusInputs => ({
  actionClass: 'email.reply',
  charterBase: 'auto_notify',
  clampedRamp: 'approve_required',
  demotions: 0,
  agreement: agreement(0, 0),
  mode: 'learn',
  ...overrides,
});

describe('classStatus — first match wins', () => {
  it('a never-fully-autonomous class is always_approval, whatever the charter says', () => {
    expect(classStatus(inputs({ actionClass: 'payment.make', charterBase: 'auto', clampedRamp: 'auto' }))).toBe(
      'always_approval',
    );
  });

  it('a charter base of approve_required, draft_only or forbidden requires approval', () => {
    for (const charterBase of ['approve_required', 'draft_only', 'forbidden'] as const) {
      expect(classStatus(inputs({ charterBase, clampedRamp: 'auto_notify' }))).toBe('charter_requires_approval');
    }
  });

  it('acting_alone is read from the clamped ramp level', () => {
    expect(classStatus(inputs({ clampedRamp: 'auto_notify' }))).toBe('acting_alone');
    expect(classStatus(inputs({ clampedRamp: 'auto' }))).toBe('acting_alone');
    expect(classStatus(inputs({ clampedRamp: 'approve_required' }))).toBe('shadow');
  });

  it('stops after two demotions, not after one', () => {
    expect(classStatus(inputs({ demotions: 2 }))).toBe('stopped_after_demotions');
    expect(classStatus(inputs({ demotions: 1 }))).toBe('shadow');
  });

  it('a learned class under a dial other than learn is ready but waiting', () => {
    const learned = agreement(5, 5);
    expect(classStatus(inputs({ agreement: learned, mode: 'ask' }))).toBe('ready_but_dial_not_learn');
    expect(classStatus(inputs({ agreement: learned, mode: 'off' }))).toBe('ready_but_dial_not_learn');
    expect(classStatus(inputs({ agreement: learned, mode: 'learn' }))).toBe('shadow');
    expect(classStatus(inputs({ agreement: agreement(4, 5), mode: 'ask' }))).toBe('shadow');
  });
});

describe('overallScore', () => {
  it('sums only eligible classes — the two "never" states are left out', () => {
    const cards = [
      card('email.reply', agreement(8, 10), 'shadow'),
      card('calendar.create', agreement(1, 2), 'acting_alone'),
      card('payment.make', agreement(0, 50), 'always_approval'),
      card('email.initiate', agreement(0, 50), 'charter_requires_approval'),
    ];
    expect(overallScore(cards)).toEqual({ right: 9, counted: 12 });
  });

  it('is null when nothing eligible was counted, even when an ineligible class was', () => {
    expect(overallScore([card('payment.make', agreement(3, 3), 'always_approval')])).toBeNull();
    expect(overallScore([])).toBeNull();
  });
});

describe('orderCards', () => {
  it('orders eligible cards by counted, descending, with the ineligible ones last', () => {
    const ordered = orderCards([
      card('payment.make', agreement(0, 99), 'always_approval'),
      card('email.reply', agreement(1, 3), 'shadow'),
      card('crm.write', agreement(5, 9), 'shadow'),
      card('email.initiate', agreement(0, 0), 'charter_requires_approval'),
    ]);
    expect(ordered.map((c) => c.actionClass)).toEqual(['crm.write', 'email.reply', 'payment.make', 'email.initiate']);
  });
});

function snapshot(cards: ClassCard[]): LearningSnapshot {
  return { overall: overallScore(cards), cards: orderCards(cards), timeZone: 'Asia/Jerusalem' };
}

describe('renderLearning', () => {
  it('says there is not enough data when nothing was counted — never 0%', () => {
    const html = renderLearning(snapshot([card('email.reply', agreement(0, 0), 'shadow')]));
    expect(html).toContain('עוד אין מספיק נתונים');
    // `width:0%` is the empty bar's style, not a score.
    expect(html).not.toMatch(/(^|[^:\d])0%/);
  });

  it('shows the weighted score and the count it rests on', () => {
    const html = renderLearning(snapshot([card('email.reply', agreement(9, 12), 'shadow')]));
    expect(html).toContain('75%');
    expect(html).toContain('מבוסס על 12 הכרעות ב-14 הימים האחרונים');
  });

  it('below five verdicts it is early to tell, with no percentage', () => {
    const html = renderLearning(snapshot([card('email.reply', agreement(4, 4), 'shadow')]));
    expect(html).toContain('עוד מוקדם לדעת (4 מתוך 5)');
    // The overall score still shows (100%); the card must not repeat it.
    expect(html.match(/100%/g)?.length).toBe(1);
  });

  it('from five verdicts the card shows its own percentage', () => {
    const html = renderLearning(snapshot([card('email.reply', agreement(4, 5), 'shadow')]));
    expect(html).not.toContain('עוד מוקדם לדעת');
    expect(html).toContain('80% · 5 הכרעות');
  });

  it('names the most common reason in Hebrew', () => {
    const html = renderLearning(snapshot([card('email.reply', agreement(3, 6, 'date'), 'shadow')]));
    expect(html).toContain('תאריך או שעה');
  });

  it('names each status in Hebrew', () => {
    const html = renderLearning(
      snapshot([
        card('email.reply', agreement(5, 5), 'ready_but_dial_not_learn'),
        card('crm.write', agreement(1, 5), 'stopped_after_demotions'),
        card('calendar.create', agreement(0, 0), 'acting_alone'),
        card('payment.make', agreement(0, 0), 'always_approval'),
        card('email.initiate', agreement(0, 0), 'charter_requires_approval'),
      ]),
    );
    expect(html).toContain('מוכנה, אבל רמת החופש לא על &#39;לומדת&#39;');
    expect(html).toContain('נעצרה אחרי שתי טעויות — מחכה להחלטתך');
    expect(html).toContain('עובדת לבד');
    expect(html).toContain('תמיד באישורך');
    expect(html).toContain('התקנון שלך מחייב אישור');
  });

  it('never shows a raw action-class id — every card is named through labels.ts', () => {
    const html = renderLearning(
      snapshot(ActionClass.options.map((c) => card(c, agreement(3, 6, 'recipient'), 'shadow'))),
    );
    for (const id of ActionClass.options) expect(html).not.toContain(id);
    expect(html).toContain('מענה במייל');
  });
});

// --- Through the database: the same reads the promotion pass makes. --------

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

/** One approved mailbox-reply card — evidence `agreementFor` counts as "right". */
async function approvedReplyCard(): Promise<void> {
  sequence += 1;
  const jobId = `J-${sequence}`;
  await getPool().query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
        received_at, body_text, state, reply_job_id)
     VALUES ($1, $2, $3, $4, 'dana@example.com', 's', now(), 'b', 'triaged', $5)`,
    [`M-${sequence}`, BUSINESS, `pm-${sequence}`, `th-${sequence}`, jobId],
  );
  const input = { to: ['dana@example.com'], subject: 'Re: s', body: 'תודה רבה על הפנייה שלך', ref: sequence };
  const facts = factsFor(input);
  const approvalId = await enqueueApproval(
    { facts, risk: await assessRisk(facts, bundle), proposedInput: input, summary: 'שליחת מייל', jobId },
    { businessId: BUSINESS },
  );
  await decide(approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }, { businessId: BUSINESS });
}

async function autonomyEvent(direction: 'promote' | 'demote', at: Date): Promise<void> {
  await getPool().query(
    `INSERT INTO autonomy_events (event_id, business_id, action_class, direction, from_level, to_level, reason, at)
     VALUES ($1, $2, 'email.reply', $3, 'approve_required', 'auto_notify', 'test', $4)`,
    [`AE-${ulid()}`, BUSINESS, direction, at.toISOString()],
  );
}

async function replyCard(): Promise<ClassCard> {
  const s = await learningSnapshot({ businessId: BUSINESS });
  const found = s.cards.find((c) => c.actionClass === 'email.reply');
  if (found === undefined) throw new Error('no email.reply card');
  return found;
}

describe('learningSnapshot', () => {
  beforeEach(async () => {
    await resetDatabase();
    sequence = 0;
    bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
  });
  afterAll(async () => {
    await closePool();
  });

  it('has a card for every action class', async () => {
    const s = await learningSnapshot({ businessId: BUSINESS });
    expect(s.cards.map((c) => c.actionClass).sort()).toEqual([...ActionClass.options].sort());
    expect(s.overall).toBeNull();
  });

  it('a class promoted in its ramp row but clamped by dial off is not acting alone', async () => {
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    await setAutonomyMode('off', 'owner', { businessId: BUSINESS });
    expect((await replyCard()).status).toBe('shadow');

    await setAutonomyMode('learn', 'owner', { businessId: BUSINESS });
    const promotedAt = new Date(Date.now() - 3_600_000);
    await autonomyEvent('promote', promotedAt);
    const acting = await replyCard();
    expect(acting.status).toBe('acting_alone');
    expect(acting.since?.toISOString()).toBe(promotedAt.toISOString());
  });

  it('a class learned under ask is ready but waiting for the dial', async () => {
    for (let i = 0; i < 5; i += 1) await approvedReplyCard();
    await setAutonomyMode('ask', 'owner', { businessId: BUSINESS });
    const ready = await replyCard();
    expect(ready.agreement).toEqual({ right: 5, counted: 5, topWrongReason: null });
    expect(ready.status).toBe('ready_but_dial_not_learn');

    const s = await learningSnapshot({ businessId: BUSINESS });
    expect(s.overall).toEqual({ right: 5, counted: 5 });
  });

  it('measures from the last move, as the promotion pass does', async () => {
    for (let i = 0; i < 5; i += 1) await approvedReplyCard();
    await autonomyEvent('demote', new Date(Date.now() + 60_000));
    expect((await replyCard()).agreement.counted).toBe(0);
  });

  it('stops after two demotions', async () => {
    await autonomyEvent('demote', new Date(Date.now() - 7_200_000));
    expect((await replyCard()).status).toBe('shadow');
    await autonomyEvent('demote', new Date(Date.now() - 3_600_000));
    expect((await replyCard()).status).toBe('stopped_after_demotions');
  });

  it('a class the charter holds at approve_required is left out of the overall score', async () => {
    await resetDatabase();
    bundle = await installCharter(buildCharter({ autonomyBase: { 'email.reply': 'approve_required' } }), {
      businessId: BUSINESS,
    });
    for (let i = 0; i < 5; i += 1) await approvedReplyCard();
    const s = await learningSnapshot({ businessId: BUSINESS });
    expect(s.cards.find((c) => c.actionClass === 'email.reply')?.status).toBe('charter_requires_approval');
    expect(s.overall).toBeNull();
    // Ineligible cards sort last.
    expect(s.cards.at(-1)?.status === 'always_approval' || s.cards.at(-1)?.status === 'charter_requires_approval').toBe(
      true,
    );
  });

  it('throws without an installed charter, rather than claiming what one says', async () => {
    await resetDatabase();
    await expect(learningSnapshot({ businessId: BUSINESS })).rejects.toThrow(/no active charter/);
  });
});
