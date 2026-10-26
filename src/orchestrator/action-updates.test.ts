/**
 * `dispatchActionUpdates` — one update per autonomous step (owner ruling H3).
 *
 * Steps are written directly into `job_step_results`, the way
 * `autonomous-actions.test.ts`'s `seedCompletedStep` does: what is under test
 * here is what happens to a performed step once it exists, not how the gate
 * got it there.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, getPool } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import { saveActionUpdateSettings } from '../governance/action-update-settings.js';
import type { AutonomousAction } from '../dashboard/autonomous-actions.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import type { BossMessenger } from '../whatsapp/messenger.js';
import { dispatchActionUpdates, renderActionUpdate } from './action-updates.js';
import { createJob } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';

const BUSINESS = 'test-business';
const NOW = new Date();
const HOUR = 60 * 60 * 1000;

function replyPlan(to: string, subject: string): Plan {
  return Plan.parse({
    goal: 'reply to a known customer',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply to the customer',
        toolName: 'mail.send',
        input: { to, inReplyTo: 'thread-9', subject, body: 'גוף ההודעה' },
        expectedActionClass: 'email.reply',
      },
    ],
  });
}

let bundle: PolicyBundle;

async function seedStep(
  options: { to?: string; subject?: string; completedAt?: Date; title?: string } = {},
): Promise<string> {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: options.title ?? 'תשובה ללקוח',
  });
  const binding = await bindPlanToJob(
    job.jobId,
    replyPlan(options.to ?? 'dana@example.com', options.subject ?? 'תשובה'),
    { businessId: BUSINESS },
  );
  if (binding.status !== 'stored') throw new Error(`unexpected plan binding status ${binding.status}`);
  await getPool().query(
    `INSERT INTO job_step_results
       (business_id, job_id, plan_hash, step_id, external_id, status, performed, completed_at)
     VALUES ($1, $2, $3, 's1', 'MSG-1', 'completed', true, $4)`,
    [BUSINESS, job.jobId, binding.planHash, options.completedAt ?? NOW],
  );
  return job.jobId;
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

async function rows(): Promise<
  { job_id: string; email_state: string | null; whatsapp_state: string | null; body: string }[]
> {
  const { rows: found } = await getPool().query<{
    job_id: string;
    email_state: string | null;
    whatsapp_state: string | null;
    body: string;
  }>(
    `SELECT job_id, email_state, whatsapp_state, body FROM action_updates
      WHERE business_id = $1 ORDER BY created_at, update_id`,
    [BUSINESS],
  );
  return found;
}

beforeEach(async () => {
  await resetDatabase();
  bundle = await installCharter(buildCharter({}), { businessId: BUSINESS });
});

afterAll(async () => {
  await closePool();
});

describe('dispatchActionUpdates', () => {
  it('writes one row and sends once; a second pass writes and sends nothing', async () => {
    const jobId = await seedStep();
    const sent: Sent[] = [];

    const first = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(first).toEqual({ written: 1, emailFailed: 0, whatsappFailed: 0, skippedNotConnected: 0 });
    expect(sent).toHaveLength(1);
    // Defaults: email and screen, not WhatsApp.
    expect(await rows()).toEqual([
      expect.objectContaining({ job_id: jobId, email_state: 'sent', whatsapp_state: null }),
    ]);

    const second = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(second.written).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('never batches: ten steps are ten rows and ten sends', async () => {
    for (let i = 0; i < 10; i += 1) await seedStep({ to: `c${i}@example.com` });
    const sent: Sent[] = [];

    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(result.written).toBe(10);
    expect(sent).toHaveLength(10);
    // Each send names exactly one recipient.
    for (const message of sent) {
      expect(message.body.match(/c\d@example\.com/g)).toHaveLength(1);
    }
    expect(new Set(sent.map((m) => m.body)).size).toBe(10);
  });

  it('leaves out a step from a job the owner instructed', async () => {
    const instructed = await seedStep();
    const own = await seedStep();
    await getPool().query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin)
       VALUES ('INS-1', $1, $2, 'תשיבי לדנה', 'typed')`,
      [BUSINESS, instructed],
    );
    const sent: Sent[] = [];

    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(result.written).toBe(1);
    expect(sent).toHaveLength(1);
    expect((await rows()).map((r) => r.job_id)).toEqual([own]);
  });

  it('records skipped_not_connected for a chosen channel with no seam, and NULL for an unchosen one', async () => {
    await seedStep();
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );

    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW });
    expect(result).toEqual({ written: 1, emailFailed: 0, whatsappFailed: 0, skippedNotConnected: 1 });
    expect(await rows()).toEqual([
      expect.objectContaining({ email_state: null, whatsapp_state: 'skipped_not_connected' }),
    ]);
  });

  it('sends through the messenger with the step job id when WhatsApp is chosen', async () => {
    const jobId = await seedStep();
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );
    const messages: { text: string; jobId: string | null }[] = [];
    const messenger: BossMessenger = {
      channel: 'whatsapp',
      async send(input) {
        messages.push(input);
        return { ok: true };
      },
    };

    await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, messenger });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.jobId).toBe(jobId);
    expect(await rows()).toEqual([expect.objectContaining({ whatsapp_state: 'sent' })]);
  });

  it.each([
    ['returns !ok', async () => ({ ok: false, error: 'relay said no' })],
    [
      'throws',
      async (): Promise<{ ok: boolean }> => {
        throw new Error('boom');
      },
    ],
    ['hangs past the deadline', () => new Promise<{ ok: boolean }>(() => {})],
  ])('records email_state failed when sendAlert %s, and does not throw', async (_name, sendAlert) => {
    await seedStep();

    const started = Date.now();
    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ written: 1, emailFailed: 1, whatsappFailed: 0, skippedNotConnected: 0 });
    expect(await rows()).toEqual([expect.objectContaining({ email_state: 'failed' })]);
  });

  it('backfills nothing older than a day', async () => {
    const old = await seedStep({ completedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const recent = await seedStep({ completedAt: new Date(NOW.getTime() - 23 * HOUR) });
    const sent: Sent[] = [];

    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(result.written).toBe(1);
    const jobIds = (await rows()).map((r) => r.job_id);
    expect(jobIds).toEqual([recent]);
    expect(jobIds).not.toContain(old);
  });

  it('stores the body without the link, and sends it with the link', async () => {
    await seedStep();
    const sent: Sent[] = [];

    await dispatchActionUpdates({
      businessId: BUSINESS,
      now: NOW,
      sendAlert: recordingAlert(sent),
      dashboardBaseUrl: 'https://dash.example',
    });
    const [row] = await rows();
    expect(row?.body).not.toContain('https://dash.example');
    expect(sent[0]?.body).toContain('https://dash.example/autonomy/actions');
    expect(sent[0]?.subject).toBe('עדכון: מענה במייל — dana@example.com');
  });
});

describe('dispatchActionUpdates — distinct outbound bytes and a bounded read', () => {
  it('records email skipped_not_connected under default settings when there is no sendAlert', async () => {
    await seedStep();
    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW });
    expect(result).toEqual({ written: 1, emailFailed: 0, whatsappFailed: 0, skippedNotConnected: 1 });
    expect(await rows()).toEqual([
      expect.objectContaining({ email_state: 'skipped_not_connected', whatsapp_state: null }),
    ]);
  });

  /**
   * `sendAlert`'s idempotency key — and so the Message-ID — is a hash of
   * subject + body (`runtime.ts`). Two updates that render identically would
   * share it, and the mail server would drop the second while `sendAlert`
   * still said `ok`. The sent text carries the update id so they cannot.
   */
  it('hands sendAlert distinct bytes for two steps sharing recipient, subject and title', async () => {
    await seedStep();
    await seedStep();
    const sent: Sent[] = [];

    await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.subject).toBe(sent[1]?.subject);
    expect(JSON.stringify(sent[0])).not.toBe(JSON.stringify(sent[1]));
  });

  /** The messenger's key is job id + text + minute: two steps of ONE job must still differ. */
  it('hands the messenger distinct texts for two steps of one job', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'תשובה ללקוח',
    });
    const step = (id: string) => ({
      id,
      agent: 'comms.email',
      intent: 'reply to the customer',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', inReplyTo: 'thread-9', subject: 'תשובה', body: 'גוף' },
      expectedActionClass: 'email.reply',
    });
    const binding = await bindPlanToJob(
      job.jobId,
      Plan.parse({ goal: 'two replies', steps: [step('s1'), step('s2')] }),
      { businessId: BUSINESS },
    );
    if (binding.status !== 'stored') throw new Error(`unexpected plan binding status ${binding.status}`);
    for (const stepId of ['s1', 's2']) {
      await getPool().query(
        `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, status, performed)
         VALUES ($1, $2, $3, $4, 'completed', true)`,
        [BUSINESS, job.jobId, binding.planHash, stepId],
      );
    }
    await saveActionUpdateSettings(
      { toWhatsApp: true, toEmail: false, toScreen: false },
      { businessId: BUSINESS, updatedBy: 'owner' },
    );
    const messages: { text: string; jobId: string | null }[] = [];
    const messenger: BossMessenger = {
      channel: 'whatsapp',
      async send(input) {
        messages.push(input);
        return { ok: true };
      },
    };

    await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, messenger });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.jobId).toBe(messages[1]?.jobId);
    expect(messages[0]?.text).not.toBe(messages[1]?.text);
  });

  it('is not stopped by an unparseable stored plan older than a day', async () => {
    const stale = await seedStep({ completedAt: new Date(NOW.getTime() - 25 * HOUR) });
    await getPool().query(`UPDATE job_plans SET plan = '{"bogus": true}'::jsonb WHERE job_id = $1`, [stale]);
    const fresh = await seedStep();
    const sent: Sent[] = [];

    const result = await dispatchActionUpdates({ businessId: BUSINESS, now: NOW, sendAlert: recordingAlert(sent) });
    expect(result.written).toBe(1);
    expect((await rows()).map((r) => r.job_id)).toEqual([fresh]);
  });
});

describe('renderActionUpdate', () => {
  const action: AutonomousAction = {
    jobId: 'J1',
    stepId: 's1',
    actionClass: 'email.reply',
    toolName: 'mail.send',
    jobTitle: 'משימה\u202e שקרית',
    recipient: 'dana\u202e@example.com',
    subject: 'חשבונית\u2066 מאי\nשורה מזויפת',
    externalId: 'MSG-1',
    completedAt: new Date(),
    fromInstruction: false,
  };

  it('is Hebrew, carries the label not the class id, and strips bidi controls', () => {
    const text = renderActionUpdate(action, 'https://dash.example/autonomy/actions');
    expect(text).toContain('העוזרת ביצעה פעולה בעצמה');
    expect(text).toContain('מענה במייל');
    expect(text).not.toContain('email.reply');
    expect(text).toContain('dana@example.com');
    expect(text).toContain('חשבונית מאי שורה מזויפת');
    expect(text).toContain('משימה שקרית');
    expect(text).not.toMatch(/[\u202e\u2066]/);
    expect(text).toContain('https://dash.example/autonomy/actions');
  });

  it('has no link line when there is no link', () => {
    expect(renderActionUpdate(action, null)).not.toContain('http');
  });
});
