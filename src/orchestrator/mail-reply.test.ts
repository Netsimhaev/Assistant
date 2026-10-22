/**
 * The reply job and its approval card, end to end.
 *
 * Every flow here runs under the "freedom level" dial at `off` — the state of
 * every new install — on a job stamped `unknown_external`. Under that setup
 * stage 8 denies `email.reply` as `draft_only` unless the owner approved
 * these exact bytes (`policy/approved-reply.ts`). So the positive e2e proves
 * the approval is what sends, and the negative one proves the gate was
 * actually reached and refused (R2): a `policy_denial` row naming
 * `draft_only` for the job, not merely "nothing was sent", which would hold
 * just as well for a job nothing ever ran.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  DRAFT_BODY as BODY,
  NOON,
  QUESTION_TRIAGE as TRIAGE,
  fakeMailboxClient as fakeClient,
  installMailboxCharter as installFor,
  mailboxRuntime as runtimeWith,
  storedMail as storedFor,
  stubDrafter,
  type SendResult,
} from '../test/mailbox.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { IncomingMail, StoredMail } from '../mail/inbox-store.js';
import { decide, getApproval } from '../governance/approvals.js';
import { claimFailedReply } from '../mail/inbox-store.js';
import { MAY_HAVE_SENT_WARNING, RETRY_PREFIX } from '../mail/reply-card.js';
import type { Drafter } from '../sdk/mail-drafter.js';
import { loadJob, transition } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { raiseMailReply, reraiseAfterFailedSend, replySubject } from './mail-reply.js';
import { resumeAfterDecision } from './resume.js';
import { runDueJobs } from './run-due.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

let activeBundle: PolicyBundle | null = null;

function reraise() {
  if (activeBundle === null) throw new Error('install the charter first');
  return reraiseAfterFailedSend({ bundle: activeBundle }, { businessId: BUSINESS });
}

async function installMailboxCharter(): Promise<PolicyBundle> {
  activeBundle = await installFor(BUSINESS);
  return activeBundle;
}

function storedMail(overrides: Partial<IncomingMail> = {}): Promise<StoredMail> {
  return storedFor(BUSINESS, overrides);
}

async function mailRow(mailId: string): Promise<{ error: string | null; reply_job_id: string | null }> {
  const { rows } = await getPool().query<{ error: string | null; reply_job_id: string | null }>(
    'SELECT error, reply_job_id FROM mail_messages WHERE mail_id = $1',
    [mailId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no mail ${mailId}`);
  return row;
}

async function approvalCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM approval_requests WHERE business_id = $1',
    [BUSINESS],
  );
  return Number(rows[0]?.n ?? 0);
}

async function approve(approvalId: string, editedInput?: unknown): Promise<void> {
  const decided = await decide(
    approvalId,
    'approved',
    {
      by: 'p_boss',
      channel: 'dashboard',
      ...(editedInput !== undefined ? { editedInput } : {}),
    },
    { businessId: BUSINESS },
  );
  await resumeAfterDecision(decided, 'p_boss', { businessId: BUSINESS });
}

describe('replySubject', () => {
  it('prefixes Re: unless already there, any case', () => {
    expect(replySubject('שאלה')).toBe('Re: שאלה');
    expect(replySubject('RE: שאלה')).toBe('RE: שאלה');
    expect(replySubject('re:x')).toBe('re:x');
    expect(replySubject('Fwd: re: x')).toBe('Re: Fwd: re: x');
  });
});

describe('raiseMailReply', () => {
  it('raises a card on a reply job whose plan step carries the exact payload', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const drafter = stubDrafter();

    const raised = await raiseMailReply({ mail, triage: TRIAGE, bundle, drafter }, { businessId: BUSINESS });
    if (raised === null) throw new Error('expected a card');
    expect(drafter.calls).toBe(1);

    const job = await loadJob(raised.replyJobId, { businessId: BUSINESS });
    expect(job?.provenance).toBe('unknown_external');
    expect(job?.title).toBe(`תשובה: ${mail.subject}`);
    expect(job?.phase).toBe('await_approval');

    const stored = await loadPlanBody(raised.replyJobId, { businessId: BUSINESS });
    const step = stored?.plan.steps[0];
    expect(stored?.plan.steps).toHaveLength(1);
    expect(step).toMatchObject({
      id: 'reply',
      agent: 'comms.email',
      intent: 'reply_to_sender',
      toolName: 'mail.send',
      expectedActionClass: 'email.reply',
    });
    const payload = {
      to: ['dana@client.example'],
      subject: 'Re: מתי תגיע ההצעה?',
      body: BODY,
      inReplyTo: '<q-1@client.example>',
      references: '<q-0@client.example>',
      threadId: 'TH-1',
      providerMessageId: 'PM-1',
    };
    expect(step?.input).toEqual(payload);

    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    expect(approval?.jobId).toBe(raised.replyJobId);
    expect(approval?.proposedTool).toBe('mail.send');
    expect(approval?.actionClass).toBe('email.reply');
    expect(approval?.proposedInput).toEqual(payload);
    expect(approval?.summary).toBe('תשובה ל-דנה לוי: מתי תגיע ההצעה?');
    expect(approval?.detail).not.toContain('מוחזקת כרגע במצב טיוטה');

    expect((await mailRow(mail.mailId)).reply_job_id).toBe(raised.replyJobId);
  });

  it('card detail shows the from address and the Reply-To warning when they differ', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ replyTo: 'Collect@Elsewhere.example', fromName: null });

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    expect(approval?.summary).toBe('תשובה ל-dana@client.example: מתי תגיע ההצעה?');
    expect(approval?.detail).toContain('dana@client.example');
    expect(approval?.detail).toContain(BODY);
    expect(approval?.detail).toContain(
      'שים לב: המייל ביקש שהתשובה תישלח ל-Collect@Elsewhere.example. התשובה תישלח ל-dana@client.example.',
    );
    // The Reply-To is shown and never used.
    expect(approval?.proposedInput).toMatchObject({ to: ['dana@client.example'] });
  });

  it('no Reply-To warning when Reply-To equals From in another case', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ replyTo: 'DANA@client.example' });
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    expect(approval?.detail).not.toContain('שים לב');
  });

  it('tells the owner a card is waiting, and a failed send does not undo the card', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const links: string[] = [];
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      {
        businessId: BUSINESS,
        notify: {
          dashboardBaseUrl: 'https://dash.example',
          notifier: {
            channel: 'email',
            async notify(_request, link) {
              links.push(link);
              return { ok: false, error: 'smtp down' };
            },
          },
        },
      },
    );
    if (raised === null) throw new Error('expected a card');
    expect(links).toEqual([`https://dash.example/a/${raised.approvalId}`]);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'incident'`,
      [raised.replyJobId],
    );
    expect(rows.some((r) => r.reason.startsWith(`approval_notify_failed:${raised.approvalId}`))).toBe(true);
  });

  it('mail without Message-ID raises no card', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ internetMessageId: null });
    const drafter = stubDrafter();

    const raised = await raiseMailReply({ mail, triage: TRIAGE, bundle, drafter }, { businessId: BUSINESS });
    expect(raised).toBeNull();
    expect(drafter.calls).toBe(0);
    expect(await approvalCount()).toBe(0);
    expect((await mailRow(mail.mailId)).error).toBe('no_message_id');
  });

  it('mail with an unparseable sender raises no card', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ fromAddress: '' });
    const drafter = stubDrafter();

    const raised = await raiseMailReply({ mail, triage: TRIAGE, bundle, drafter }, { businessId: BUSINESS });
    expect(raised).toBeNull();
    expect(drafter.calls).toBe(0);
    expect(await approvalCount()).toBe(0);
    expect((await mailRow(mail.mailId)).error).toBe('no_sender');
  });

  it('a failure after the card is queued cancels the card and fails the job', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    // A mail id with no row: `linkReplyJob`, the last write, throws.
    await expect(
      raiseMailReply(
        { mail: { ...mail, mailId: 'M-missing' }, triage: TRIAGE, bundle, drafter: stubDrafter() },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(/linkReplyJob/);
    const { rows } = await getPool().query<{ state: string; job_id: string }>(
      'SELECT state, job_id FROM approval_requests WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('cancelled');
    expect((await loadJob(rows[0]?.job_id ?? '', { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('a failed draft raises no card and opens no job', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const drafter: Drafter = async () => ({ status: 'failed', reason: 'empty draft' });

    expect(await raiseMailReply({ mail, triage: TRIAGE, bundle, drafter }, { businessId: BUSINESS })).toBeNull();
    expect(await approvalCount()).toBe(0);
    const { rows } = await getPool().query('SELECT 1 FROM jobs WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});

describe('approve sends, under mode off', () => {
  it('approved card sends the reply to the From address and the job reaches verify', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ replyTo: 'collect@elsewhere.example' });
    const { client, sent } = fakeClient();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    await approve(raised.approvalId);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['dana@client.example']);
    expect(sent[0]?.inReplyTo).toBe('<q-1@client.example>');
    expect(sent[0]?.providerMessageId).toBe('PM-1');
    expect(sent[0]?.body).toBe(BODY);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('same flow without approval sends nothing', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const { client, sent } = fakeClient();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    // R2: reach the gate without a decision — a legal move, the approval
    // stays pending.
    await transition(raised.replyJobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'test: run without a decision',
      businessId: BUSINESS,
    });
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sent).toHaveLength(0);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'policy_denial'`,
      [raised.replyJobId],
    );
    expect(rows.some((r) => r.reason.startsWith('draft_only'))).toBe(true);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('edited approval sends the edited body', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const { client, sent } = fakeClient();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    const edited = { ...(approval?.proposedInput as Record<string, unknown>), body: 'גוף ערוך על ידי הבעלים' };
    await approve(raised.approvalId, edited);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe('גוף ערוך על ידי הבעלים');
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });
});

describe('reraiseAfterFailedSend', () => {
  async function approvedAndRun(results: SendResult[]) {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const { client, sent } = fakeClient(results);
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    await approve(raised.approvalId);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    return { bundle, mail, client, sent, raised };
  }

  async function pendingCards(): Promise<Array<{ approval_id: string; job_id: string; detail: string }>> {
    const { rows } = await getPool().query<{ approval_id: string; job_id: string; detail: string }>(
      `SELECT approval_id, job_id, detail FROM approval_requests
        WHERE business_id = $1 AND state = 'pending' ORDER BY created_at`,
      [BUSINESS],
    );
    return rows;
  }

  it('retryable failure after approval raises a fresh card on a new job, once', async () => {
    const { mail, client, sent, raised } = await approvedAndRun([
      { failure: 'transient', status: 503, message: 'busy' },
    ]);
    expect(sent).toHaveLength(1);
    // Retryable: parked in followup. Waking it reaches the gate with the
    // approval already spent — stage 8 refuses, and the job fails.
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('followup');
    // Not yet failed: nothing to re-raise.
    expect((await reraise()).reraised).toBe(0);

    await transition(raised.replyJobId, {
      to: 'execute', actor: 'orchestrator', reason: 'test: wake', businessId: BUSINESS,
    });
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    expect(sent).toHaveLength(1);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');

    const first = await reraise();
    expect(first.reraised).toBe(1);
    const cards = await pendingCards();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (card === undefined) throw new Error('no card');
    expect(card.job_id).not.toBe(raised.replyJobId);
    expect(card.detail.startsWith(RETRY_PREFIX)).toBe(true);
    expect(card.detail).not.toContain(MAY_HAVE_SENT_WARNING);

    const fresh = await getApproval(card.approval_id, { businessId: BUSINESS });
    const old = await getApproval(raised.approvalId, { businessId: BUSINESS });
    expect(fresh?.proposedInput).toEqual(old?.proposedInput);
    const newJob = await loadJob(card.job_id, { businessId: BUSINESS });
    expect(newJob?.provenance).toBe('unknown_external');
    expect(newJob?.phase).toBe('await_approval');
    expect((await mailRow(mail.mailId)).reply_job_id).toBe(card.job_id);

    // Approving the fresh card sends — the retry is a real second chance.
    await approve(card.approval_id);
    const second = fakeClient();
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(second.client), now: NOON });
    expect(second.sent).toHaveLength(1);
    expect((await loadJob(card.job_id, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('running it twice raises no second card', async () => {
    await approvedAndRun([{ failure: 'rejected', status: 400, message: 'bad request' }]);
    expect((await reraise()).reraised).toBe(1);
    expect((await reraise()).reraised).toBe(0);
    expect(await pendingCards()).toHaveLength(1);
  });

  it('the claim on a failed reply job is won exactly once', async () => {
    const { mail, raised } = await approvedAndRun([{ failure: 'rejected', status: 400, message: 'bad request' }]);
    // Two re-raisers that both listed this row: only the claim's row count
    // separates them (a timing-free stand-in for the race).
    const listed = await getPool().query('SELECT 1 FROM mail_messages WHERE reply_job_id = $1', [raised.replyJobId]);
    expect(listed.rows).toHaveLength(1);
    expect(await claimFailedReply(mail.mailId, raised.replyJobId, { businessId: BUSINESS })).toBe(true);
    expect(await claimFailedReply(mail.mailId, raised.replyJobId, { businessId: BUSINESS })).toBe(false);
  });

  it('delivery_unknown carries the may-have-sent warning', async () => {
    const { raised } = await approvedAndRun([{ failure: 'transient', status: 0, message: 'socket dropped' }]);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');
    expect((await reraise()).reraised).toBe(1);
    const cards = await pendingCards();
    expect(cards[0]?.detail).toContain(`${RETRY_PREFIX}\n${MAY_HAVE_SENT_WARNING}`);
  });

  it('a job the gate refused before any approval was spent is not re-raised', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    await transition(raised.replyJobId, {
      to: 'execute', actor: 'orchestrator', reason: 'test', businessId: BUSINESS,
    });
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(fakeClient().client), now: NOON });
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');
    expect((await reraise()).reraised).toBe(0);
  });

  it('an owner denial closes the job and is not re-raised', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a card');
    const decided = await decide(raised.approvalId, 'denied', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });
    await resumeAfterDecision(decided, 'p_boss', { businessId: BUSINESS });
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('closed');
    expect((await reraise()).reraised).toBe(0);
  });

  it('a failure re-raising one row is recorded on its mail and the batch continues', async () => {
    const bundle = await installMailboxCharter();
    const failed: string[] = [];
    for (const n of [1, 2]) {
      const mail = await storedMail({ providerMessageId: `PM-${n}`, internetMessageId: `<q-${n}@client.example>` });
      const raised = await raiseMailReply(
        { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
        { businessId: BUSINESS },
      );
      if (raised === null) throw new Error('expected a card');
      await approve(raised.approvalId);
      failed.push(mail.mailId);
    }
    await runDueJobs({
      businessId: BUSINESS,
      runtime: runtimeWith(fakeClient([{ failure: 'rejected', status: 400, message: 'bad' }]).client),
      now: NOON,
    });

    // A charter version no row carries: `createJob` fails its foreign key for
    // every row, so both re-raises fail after their claim.
    const broken = { ...bundle, charterVersion: 'no-such-version' };
    const result = await reraiseAfterFailedSend({ bundle: broken }, { businessId: BUSINESS });
    expect(result).toMatchObject({ reraised: 0, failed: 2 });
    for (const mailId of failed) expect((await mailRow(mailId)).error).toBe('reraise_failed');
    expect(await approvalCount()).toBe(2);
  });
});
