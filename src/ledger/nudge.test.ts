/**
 * "תוצאה" — a follow-up to a counterparty is drafted, opened as an ordinary
 * `boss` job that passes the UNCHANGED gate, and its outcome is observed.
 *
 * The item is a date-only `money_in` due 2026-11-02 local; a pass at
 * 2026-11-03T10:00Z (12:00 Asia/Jerusalem, outside the fixture's quiet hours)
 * has exactly two slots, `overdue` and `nudge`, both at 08:00 local.
 *
 * Every negative test also proves the code it is about ran: a gate refusal is
 * asserted from its `audit_log` row, a skipped job from the pass's own counts
 * and a control reminder in the same pass.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import { decide } from '../governance/approvals.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { loadJob } from '../orchestrator/jobs.js';
import { loadPlanBody } from '../orchestrator/plan-store.js';
import { resumeAfterDecision } from '../orchestrator/resume.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import { closeVerifiedJobs } from '../orchestrator/verify.js';
import { confirmedCommandCovers } from '../policy/confirmed-command.js';
import { buildFacts } from '../policy/facts.js';
import { runNudgeDrafter, type NudgeDrafter, type NudgeDraftRequest } from '../sdk/nudge-drafter.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { fakeMailboxClient, installMailboxCharter, mailboxRuntime } from '../test/mailbox.js';
import { observeNudges, openNudge } from './nudge.js';
import { runLedgerPass } from './pass.js';
import { LEDGER_DEFAULTS, saveLedgerSettings } from './settings.js';
import { createLedgerItem, listLedgerEvents, loadLedgerItem, moveLedgerStatus, type NewLedgerItem } from './store.js';

const B = 'test-business';
const NOW = new Date('2026-11-03T10:00:00Z');
const NUDGE_SLOT = { slot: 'nudge:2026-11-03T06:00:00.000Z', kind: 'nudge' as const, at: new Date('2026-11-03T06:00:00Z') };
const DRAFT = 'שלום דנה, רציתי להזכיר את חשבונית 123. נשמח לעדכון.';

function base(over: Partial<NewLedgerItem> = {}): NewLedgerItem {
  return {
    family: 'money_in',
    description: 'חשבונית 123 של דנה',
    dueAt: new Date('2026-11-01T22:00:00Z'), // 2026-11-02 local, date-only
    dueIsDateOnly: true,
    importance: 'normal',
    importanceManual: false,
    counterpartyName: 'דנה',
    counterpartyEmail: 'dana@acme.co.il',
    counterpartyEmailVerified: true,
    counterpartyDomain: 'acme.co.il',
    reference: 'INV-123',
    amountMinor: 150000,
    stages: [],
    proposedStages: null,
    originJobId: 'J-origin',
    ...over,
  };
}

function stubDrafter(outcome: Awaited<ReturnType<NudgeDrafter>> = { status: 'drafted', body: DRAFT }) {
  const calls: NudgeDraftRequest[] = [];
  const fn: NudgeDrafter = async (request) => {
    calls.push(request);
    return outcome;
  };
  return { fn, calls };
}

interface Sent {
  subject: string;
  body: string;
}
function recordingAlert(sent: Sent[]) {
  return async (subject: string, body: string) => {
    sent.push({ subject, body });
    return { ok: true };
  };
}

async function actMode(): Promise<void> {
  await withBusiness(B, (db) => saveLedgerSettings(
    db,
    { ...LEDGER_DEFAULTS, modes: { ...LEDGER_DEFAULTS.modes, money_in: 'act' }, meetingLeadMinutesCritical: [1440, 60] },
    { updatedBy: 'owner' },
  ));
}

async function nudgeJobId(itemId: string): Promise<string> {
  const { rows } = await getPool().query<{ nudge_job_id: string | null }>(
    `SELECT nudge_job_id FROM ledger_items WHERE item_id = $1`,
    [itemId],
  );
  const id = rows[0]?.nudge_job_id;
  if (id === null || id === undefined) throw new Error('expected a nudge job');
  return id;
}

async function jobCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE business_id = $1`, [B]);
  return Number(rows[0]?.n ?? 0);
}

async function nudgeReminders(itemId: string): Promise<{ slot: string; body: string; email_state: string | null }[]> {
  const { rows } = await getPool().query<{ slot: string; body: string; email_state: string | null }>(
    `SELECT slot, body, email_state FROM ledger_reminders
      WHERE business_id = $1 AND item_id = $2 AND kind = 'nudge' ORDER BY created_at, reminder_id`,
    [B, itemId],
  );
  return rows;
}

async function auditRows(jobId: string): Promise<{ kind: string; reason: string }[]> {
  const { rows } = await getPool().query<{ kind: string; reason: string }>(
    `SELECT kind, reason FROM audit_log WHERE job_id = $1 ORDER BY seq`,
    [jobId],
  );
  return rows;
}

beforeEach(async () => {
  await resetDatabase();
  await installMailboxCharter(B);
});
afterAll(async () => {
  await closePool();
});

describe('act mode: the nudge goes through the gate', () => {
  it('act mode under ask raises an approval card and sends nothing', async () => {
    await actMode();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const drafter = stubDrafter();

    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: drafter.fn, sendAlert: recordingAlert([]) }));
    expect(result.nudgesOpened).toBe(1);
    expect(result.errored).toEqual([]);
    expect(drafter.calls).toHaveLength(1);
    expect(drafter.calls[0]?.description).toBe('חשבונית 123 של דנה');
    expect(drafter.calls[0]?.nudgeNumber).toBe(1);
    const jobId = await nudgeJobId(item.itemId);
    const job = await withBusiness(B, (db) => loadJob(db, jobId));
    expect(job?.provenance).toBe('boss');
    expect(job?.phase).toBe('execute');
    // The slot is claimed, but its body is not a "draft" signal (F-I3); the draft rides the job's plan.
    expect((await nudgeReminders(item.itemId)).map((r) => r.body)).toEqual(['']);
    expect((await withBusiness(B, (db) => loadPlanBody(db, jobId)))?.plan.steps[0]?.input['body']).toBe(DRAFT);

    const { client, sent, sentNew } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));

    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('await_approval');
    const cards = await getPool().query(`SELECT 1 FROM approval_requests WHERE job_id = $1 AND state = 'pending'`, [jobId]);
    expect(cards.rowCount).toBe(1);
    // The job reached the gate: stage 5 wrote its intent.
    expect((await auditRows(jobId)).some((r) => r.kind === 'intent_to_act')).toBe(true);

    // A card in flight is the owner's: observing changes nothing.
    const observed = await withBusiness(B, (db) => observeNudges(db));
    expect(observed).toMatchObject({ sent: [], fallback: [] });
    expect(await nudgeJobId(item.itemId)).toBe(jobId);
  });

  it('once approved and sent, the outcome is observed as one nudge', async () => {
    await actMode();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const { client, sentNew } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));

    const { rows } = await getPool().query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests WHERE job_id = $1 AND state = 'pending'`,
      [jobId],
    );
    const approvalId = rows[0]?.approval_id;
    if (approvalId === undefined) throw new Error('expected a card');
    const decided = await withBusiness(B, (bdb) => decide(bdb, approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' }));
    await withBusiness(B, (db) => resumeAfterDecision(db, decided, 'p_boss'));
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));
    expect(sentNew).toEqual([{ to: ['dana@acme.co.il'], subject: 'תזכורת לגבי תשלום — INV-123', body: DRAFT }]);
    await withBusiness(B, (db) => closeVerifiedJobs(db));
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('closed');

    const observed = await withBusiness(B, (db) => observeNudges(db));
    expect(observed.sent).toEqual([item.itemId]);
    const after = await withBusiness(B, (db) => loadLedgerItem(db, item.itemId));
    expect(after?.nudgeCount).toBe(1);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.filter((e) => e.kind === 'nudged').map((e) => e.jobId)).toEqual([jobId]);

    // Idempotent: a second observation counts nothing more.
    const again = await withBusiness(B, (db) => observeNudges(db));
    expect(again.sent).toEqual([]);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.nudgeCount).toBe(1);
    const { rows: cleared } = await getPool().query(`SELECT nudge_job_id FROM ledger_items WHERE item_id = $1`, [
      item.itemId,
    ]);
    expect(cleared[0]).toEqual({ nudge_job_id: null });
  });

  it('act mode under off falls back to an owner reminder with the draft', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const { client, sentNew } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));

    expect(sentNew).toHaveLength(0);
    // The gate refused at stage 8 — this is the refusal the fallback reads.
    const denials = (await auditRows(jobId)).filter((r) => r.kind === 'policy_denial');
    expect(denials.some((r) => r.reason.startsWith('draft_only') && r.reason.endsWith('email.initiate'))).toBe(true);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('failed');

    const sent: Sent[] = [];
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: later, drafter: stubDrafter().fn, sendAlert: recordingAlert(sent) }));
    expect(result.nudgeFallbacks).toBe(1);
    expect(result.nudgesOpened).toBe(0);
    const owner = sent.find((s) => s.body.includes('הכנתי טיוטה'));
    expect(owner?.body).toContain(DRAFT);
    expect(owner?.body).toContain('העוזרת לא מורשית לשלוח את זה עדיין');
    expect(owner?.body).toMatch(/מזהה תזכורת: LR-/);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.filter((e) => e.kind === 'nudge_fallback').map((e) => e.jobId)).toEqual([jobId]);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.nudgeCount).toBe(0);
    const fallbackRow = (await nudgeReminders(item.itemId)).find((r) => r.slot === `nudge_fallback:${jobId}`);
    expect(fallbackRow?.email_state).toBe('sent');

    // Idempotent: the fallback is told once.
    const sent2: Sent[] = [];
    const third = await withBusiness(B, (db) => runLedgerPass(db, { now: later, drafter: stubDrafter().fn, sendAlert: recordingAlert(sent2) }));
    expect(third.nudgeFallbacks).toBe(0);
    expect(sent2.filter((s) => s.body.includes('הכנתי טיוטה'))).toHaveLength(0);
  });

  it('a failed draft falls back to the owner and opens no job', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const sent: Sent[] = [];
    const drafter = stubDrafter({ status: 'failed', reason: 'empty draft' });
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: drafter.fn, sendAlert: recordingAlert(sent) }));
    expect(drafter.calls).toHaveLength(1);
    expect(result.nudgeFallbacks).toBe(1);
    expect(await jobCount()).toBe(0);
    expect(sent.some((s) => s.body.includes('הניסוח נכשל'))).toBe(true);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.map((e) => e.kind)).toContain('nudge_fallback');
  });
});

describe('a nudge whose item moved on, or whose opening crashed', () => {
  async function pendingCard(jobId: string): Promise<string> {
    const { rows } = await getPool().query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests WHERE job_id = $1 AND state = 'pending'`,
      [jobId],
    );
    const id = rows[0]?.approval_id;
    if (id === undefined) throw new Error('expected a pending card');
    return id;
  }

  it('F-I1: a pending card is withdrawn and its job closed when the item is closed by evidence', async () => {
    await actMode();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const { client, sentNew } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));
    const approvalId = await pendingCard(jobId);

    // The counterparty paid: the item is closed by evidence while the card waits.
    expect(
      await withBusiness(B, (db) => moveLedgerStatus(
        db,
        item.itemId,
        ['open'],
        'closed_by_evidence',
        { kind: 'closed_by_evidence', by: 'evidence' },
      )),
    ).toBe(true);

    const observed = await withBusiness(B, (db) => observeNudges(db, { now: NOW }));
    expect(observed.sent).toEqual([]);
    expect(observed.fallback).toEqual([]);
    const { rows } = await getPool().query<{ state: string }>(
      `SELECT state FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.state).toBe('cancelled');
    await expect(
      withBusiness(B, (bdb) => decide(bdb, approvalId, 'approved', { by: 'p_boss', channel: 'dashboard' })),
    ).rejects.toThrow();
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('closed');
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.nudgeCount).toBe(0); // never counted
    const { rows: link } = await getPool().query(`SELECT nudge_job_id FROM ledger_items WHERE item_id = $1`, [
      item.itemId,
    ]);
    expect(link[0]).toEqual({ nudge_job_id: null });
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.filter((e) => e.kind === 'updated').map((e) => [e.note, e.jobId])).toEqual([
      ['nudge_cancelled', jobId],
    ]);
    expect(events.some((e) => e.kind === 'nudged')).toBe(false);

    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));
    expect(sentNew).toHaveLength(0);
  });

  it('F-I1: an item still open keeps its card (control)', async () => {
    await actMode();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const { client } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));
    const approvalId = await pendingCard(jobId);
    await withBusiness(B, (db) => observeNudges(db, { now: NOW }));
    const { rows } = await getPool().query<{ state: string }>(
      `SELECT state FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.state).toBe('pending');
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('await_approval');
  });

  it('T10: a linked job stuck in plan over 15 minutes fails and falls back to the owner; a young one is left alone', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    // Simulate the crash between linking and plan→execute.
    await getPool().query(`UPDATE jobs SET phase = 'plan', created_at = $2 WHERE job_id = $1`, [
      jobId,
      new Date(NOW.getTime() - 10 * 60 * 1000),
    ]);
    const young = await withBusiness(B, (db) => observeNudges(db, { now: NOW }));
    expect(young.fallback).toEqual([]);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('plan');

    await getPool().query(`UPDATE jobs SET created_at = $2 WHERE job_id = $1`, [
      jobId,
      new Date(NOW.getTime() - 16 * 60 * 1000),
    ]);
    const observed = await withBusiness(B, (db) => observeNudges(db, { now: NOW }));
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
    expect(observed.fallback.map((f) => f.itemId)).toEqual([item.itemId]);
    expect(observed.fallback[0]?.draft).toBe(DRAFT);
    expect(observed.reminders).toHaveLength(1);
    const { rows: link } = await getPool().query(`SELECT nudge_job_id FROM ledger_items WHERE item_id = $1`, [
      item.itemId,
    ]);
    expect(link[0]).toEqual({ nudge_job_id: null });
  });

  it('M1: an owner-denied card leaves a ledger event naming its job, so erasure reaches the denied job', async () => {
    await actMode();
    await withBusiness(B, (bdb) => setAutonomyMode(bdb, 'ask', 'p_boss'));
    // A name that appears in no nudge-job content (draft, subject, address, title).
    const item = await withBusiness(B, (db) => createLedgerItem(db, base({ counterpartyName: 'רונית לוי' }), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const { client } = fakeMailboxClient();
    await withBusiness(B, (db) => runDueJobs(db, { runtime: mailboxRuntime(client), now: NOW }));
    const decided = await withBusiness(B, async (bdb) => decide(
      bdb,
      await pendingCard(jobId),
      'denied',
      { by: 'p_boss', channel: 'dashboard' }
    ));
    await withBusiness(B, (db) => resumeAfterDecision(db, decided, 'p_boss'));
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('closed');

    await withBusiness(B, (db) => observeNudges(db, { now: NOW }));
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.filter((e) => e.kind === 'updated').map((e) => [e.note, e.jobId])).toEqual([
      ['nudge_denied', jobId],
    ]);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.nudgeCount).toBe(0);

    const plan = await buildErasurePlan({ kind: 'contact', identifier: 'רונית לוי' }, { businessId: B });
    expect(plan.ledgerItemIds).toEqual([item.itemId]);
    expect(plan.jobIds).toContain(jobId);
  });
});

describe('when no nudge job is opened', () => {
  it('remind mode never opens a job', async () => {
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    const drafter = stubDrafter();
    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: drafter.fn, sendAlert: recordingAlert(sent) }));
    expect(await jobCount()).toBe(0);
    expect(drafter.calls).toHaveLength(0);
    expect(result.nudgesOpened).toBe(0);
    // The nudge slot became an ordinary owner reminder.
    expect(sent.some((s) => s.body.includes('הגיע הזמן לחזור לדנה'))).toBe(true);
    expect((await nudgeReminders(item.itemId)).map((r) => r.email_state)).toEqual(['sent']);
  });

  it('unverified address never opens a job', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base({ counterpartyEmailVerified: false }), { by: 'boss' }));
    const drafter = stubDrafter();
    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: drafter.fn, sendAlert: recordingAlert(sent) }));
    expect(await jobCount()).toBe(0);
    expect(drafter.calls).toHaveLength(0);
    expect(result.nudgeFallbacks).toBe(1);
    const owner = sent.find((s) => s.body.includes('הגיע הזמן לחזור לדנה'));
    expect(owner?.body).toContain('אין כתובת מאושרת');
    expect((await nudgeReminders(item.itemId))).toHaveLength(1);
  });

  it('cap moves the item to stuck and tells the owner', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await getPool().query(`UPDATE ledger_items SET nudge_count = 2 WHERE item_id = $1`, [item.itemId]);
    const drafter = stubDrafter();
    const sent: Sent[] = [];
    const result = await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: drafter.fn, sendAlert: recordingAlert(sent) }));
    expect(result.stuck).toBe(1);
    expect(await jobCount()).toBe(0);
    expect(drafter.calls).toHaveLength(0);
    expect((await withBusiness(B, (db) => loadLedgerItem(db, item.itemId)))?.status).toBe('stuck');
    expect(sent.some((s) => s.body.includes('חשבונית 123 של דנה — נדנדתי 2 פעמים ואין תשובה. עובר אליך.'))).toBe(true);
    const events = await withBusiness(B, (db) => listLedgerEvents(db, item.itemId));
    expect(events.map((e) => e.kind)).toContain('stuck');
  });

  it('daily cap leaves the slot unclaimed', async () => {
    await actMode();
    const other = await withBusiness(B, (db) => createLedgerItem(db, base({ description: 'אחר' }), { by: 'boss' }));
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    // One nudge already went out today (10:00 local), on another item.
    await getPool().query(
      `INSERT INTO ledger_events (event_id, business_id, item_id, kind, by_whom, at)
       VALUES ('LE-x', $1, $2, 'nudged', 'system', '2026-11-03T07:00:00Z')`,
      [B, other.itemId],
    );
    const original = config.ledgerNudgesPerDay;
    (config as { ledgerNudgesPerDay: number }).ledgerNudgesPerDay = 1;
    try {
      const active = await withBusiness(B, (bdb) => loadActiveCharter(bdb));
      if (active === null) throw new Error('no charter');
      const drafter = stubDrafter();
      const outcome = await withBusiness(B, (db) => openNudge(db, item, NUDGE_SLOT, { active, drafter: drafter.fn, now: NOW }));
      expect(outcome.outcome).toBe('capped');
      expect(drafter.calls).toHaveLength(0);
      expect(await nudgeReminders(item.itemId)).toEqual([]);
      expect(await jobCount()).toBe(0);

      // A nudge yesterday (local) does not count against today.
      await getPool().query(`UPDATE ledger_events SET at = '2026-11-02T21:59:00Z' WHERE event_id = 'LE-x'`);
      const next = await withBusiness(B, (db) => openNudge(db, item, NUDGE_SLOT, { active, drafter: drafter.fn, now: NOW }));
      expect(next.outcome).toBe('opened');
    } finally {
      (config as { ledgerNudgesPerDay: number }).ledgerNudgesPerDay = original;
    }
  });
});

describe('the nudge job carries no exemption', () => {
  it('nudge job has no boss_instructions row, no standing authorisation, and confirmedCommandCovers is false', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);

    const bi = await getPool().query(`SELECT 1 FROM boss_instructions WHERE job_id = $1`, [jobId]);
    expect(bi.rowCount).toBe(0);
    const auth = await getPool().query(`SELECT 1 FROM job_authorizations WHERE job_id = $1`, [jobId]);
    expect(auth.rowCount).toBe(0);

    const stored = await withBusiness(B, (db) => loadPlanBody(db, jobId));
    const plan = stored?.plan ?? Plan.parse(null);
    const step = plan.steps[0];
    if (step === undefined) throw new Error('no step');
    const active = await withBusiness(B, (bdb) => loadActiveCharter(bdb));
    if (active === null) throw new Error('no charter');
    // Every early-return condition is satisfied (job, step, no approval), so
    // the null comes from the database check — the missing instruction row.
    const facts = buildFacts(step.toolName, step.input, {
      provenance: 'boss',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    const covers = await withBusiness(B, (db) => confirmedCommandCovers(facts, {
      provenance: 'boss',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
      agent: step.agent,
      bundle: active.bundle,
      jobId,
      stepId: step.id,
      db,
    }));
    expect(covers).toBeNull();
  });

  it('nudge payload has no threading fields', async () => {
    await actMode();
    const item = await withBusiness(B, (db) => createLedgerItem(db, base(), { by: 'boss' }));
    await withBusiness(B, (db) => runLedgerPass(db, { now: NOW, drafter: stubDrafter().fn, sendAlert: recordingAlert([]) }));
    const jobId = await nudgeJobId(item.itemId);
    const stored = await withBusiness(B, (db) => loadPlanBody(db, jobId));
    const plan = stored?.plan ?? Plan.parse(null);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step?.agent).toBe('comms.email');
    expect(step?.toolName).toBe('mail.send');
    expect(Object.keys(step?.input ?? {}).sort()).toEqual(['body', 'subject', 'to']);
    expect(step?.input['to']).toBe('dana@acme.co.il');
    const facts = buildFacts('mail.send', step?.input, {
      provenance: 'boss',
      chainDepth: 1,
      counterpartyTags: [],
      provenanceChainDerived: false,
    });
    expect(facts.actionClass).toBe('email.initiate');
  });
});

describe('runNudgeDrafter', () => {
  it('refuses under test', async () => {
    const bundle = (await withBusiness(B, (bdb) => loadActiveCharter(bdb)))?.bundle ?? (buildCharter({}) as never);
    await expect(
      runNudgeDrafter({
        bundle,
        family: 'money_in',
        description: 'x',
        reference: null,
        dueText: null,
        counterpartyName: null,
        nudgeNumber: 1,
      }),
    ).rejects.toThrow(/refusing to run under NODE_ENV=test/);
  });
});
