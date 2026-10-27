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
import { claimFailedReply, linkReplyJob } from '../mail/inbox-store.js';
import type { Proposal } from '../domain/proposal.js';
import { createJob } from './jobs.js';
import { Plan } from '../domain/plan.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { bindPlanToJob } from './plan-store.js';
import { raiseProposalApproval, RAMP_HONESTY } from './proposal-approval.js';
import { proposalToPlan } from './proposal-to-plan.js';
import { EXPIRED_PREFIX, MAY_HAVE_SENT_WARNING, RETRY_PREFIX } from '../mail/reply-card.js';
import type { Drafter } from '../sdk/mail-drafter.js';
import { loadJob, transition } from './jobs.js';
import { loadPlanBody } from './plan-store.js';
import { raiseMailReply, reraiseAfterFailedSend, replySubject } from './mail-reply.js';
import { resumeAfterDecision } from './resume.js';
import { runDueJobs } from './run-due.js';
import { setRampLevel } from './ramp.js';
import { schedulerPass } from './scheduler.js';
import { LEARNED_REPLY_EXEMPTION_MARKER } from '../policy/learned-reply.js';

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

describe('replySubject folds control characters (a subject must never break a header)', () => {
  it('CR, LF, TAB and other C0/C1 controls become single spaces', () => {
    expect(replySubject('שאלה\r\nBcc: v@y.com')).toBe('Re: שאלה Bcc: v@y.com');
    expect(replySubject('a\tb\u0000c\u007fd\u0085e')).toBe('Re: a b c d e');
    expect(replySubject('Re:\nhello')).toBe('Re: hello');
  });

  it('a raised reply proposes a subject with no line break in it', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail({ subject: 'Invoice\r\nBcc: v@y.com' });
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    const subject = (approval?.proposedInput as Record<string, unknown>)['subject'];
    expect(subject).toBe('Re: Invoice Bcc: v@y.com');
  });
});

describe('replySubject', () => {
  it('prefixes Re: unless already there, any case', () => {
    expect(replySubject('שאלה')).toBe('Re: שאלה');
    expect(replySubject('RE: שאלה')).toBe('RE: שאלה');
    expect(replySubject('re:x')).toBe('re:x');
    expect(replySubject('Fwd: re: x')).toBe('Re: Fwd: re: x');
  });
});

describe('raiseMailReply', () => {
  it('strips bidi controls from the drafted body, so the proposal is what the owner reads', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter('שלום‮ דנה⁦, 500‏ ש"ח') },
      { businessId: BUSINESS },
    );
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    expect((approval?.proposedInput as { body: string }).body).toBe('שלום דנה, 500 ש"ח');
    const stored = await loadPlanBody(raised.replyJobId, { businessId: BUSINESS });
    expect((stored?.plan.steps[0]?.input as { body: string }).body).toBe('שלום דנה, 500 ש"ח');
  });

  it('raises a card on a reply job whose plan step carries the exact payload', async () => {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const drafter = stubDrafter();

    const raised = await raiseMailReply({ mail, triage: TRIAGE, bundle, drafter }, { businessId: BUSINESS });
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
    const edited = { ...(approval?.proposedInput as Record<string, unknown>), body: 'גוף ערוך על ידי הבעלים' };
    await approve(raised.approvalId, edited);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe('גוף ערוך על ידי הבעלים');
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });
});

describe('the stage-8 exemption is a mailbox-reply-job exemption (R20)', () => {
  /**
   * A conductor card for a threaded `mail.send`: the conductor binds the plan,
   * raises the card through `raiseProposalApproval` (which carries
   * RAMP_HONESTY — "approving does not execute"), and parks the job. The
   * payload is a complete mailbox reply, so the send adapter WOULD send it if
   * the gate let it through — the only thing that can stop it is the gate.
   */
  async function conductorCardApproved(options: { linkToMail: boolean }) {
    const bundle = await installMailboxCharter();
    const mail = await storedMail();
    const payload = {
      to: ['dana@client.example'],
      subject: 'Re: מתי תגיע ההצעה?',
      body: 'שלום דנה, מצורפת ההצעה.',
      inReplyTo: '<q-1@client.example>',
      references: '<q-0@client.example>',
      threadId: 'TH-1',
      providerMessageId: 'PM-1',
    };
    const proposal = {
      headline: 'קראתי את המסמך',
      stance: 'act',
      reasons: [{ text: 'נשאלה שאלה', findingLabel: 'שאלה', sourceRef: { ordinal: 0, locator: null } }],
      action: {
        headline: 'אשיב לדנה',
        purpose: 'לענות על השאלה',
        agent: 'comms.email',
        intent: 'reply_to_sender',
        toolName: 'mail.send',
        expectedActionClass: 'email.reply',
        input: payload,
      },
      clarifyingQuestion: null,
    } as unknown as Proposal;
    const job = await createJob({
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
      provenance: 'unknown_external',
    });
    for (const to of ['understand', 'plan'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    }
    const plan = proposalToPlan(proposal, { goal: 'test' });
    if (plan === null) throw new Error('no plan');
    await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: job.jobId, proposal, bundle },
      { businessId: BUSINESS },
    );
    if (approvalId === null) throw new Error('expected a conductor card');
    const card = await getApproval(approvalId, { businessId: BUSINESS });
    expect(card?.detail).toContain(RAMP_HONESTY);
    await transition(job.jobId, {
      to: 'await_approval', actor: 'orchestrator', reason: 'test', businessId: BUSINESS,
    });
    if (options.linkToMail) await linkReplyJob(mail.mailId, job.jobId, { businessId: BUSINESS });

    await approve(approvalId);
    const { client, sent } = fakeClient();
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    const { rows } = await getPool().query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM approval_requests WHERE approval_id = $1',
      [approvalId],
    );
    return { jobId: job.jobId, sent, consumed: rows[0]?.consumed_at ?? null };
  }

  it('an approved conductor card for a threaded mail.send sends nothing under mode off', async () => {
    const { jobId, sent, consumed } = await conductorCardApproved({ linkToMail: false });

    expect(sent).toHaveLength(0);
    expect(consumed).toBeNull();
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'policy_denial'`,
      [jobId],
    );
    expect(rows.some((r) => r.reason.startsWith('draft_only'))).toBe(true);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('control: the same approved payload on a mailbox reply job sends', async () => {
    const { jobId, sent, consumed } = await conductorCardApproved({ linkToMail: true });

    expect(sent).toHaveLength(1);
    expect(consumed).not.toBeNull();
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });
});

describe('a new message goes out through the mailbox too, under the gate (R21)', () => {
  /**
   * The instruction door's shape: a `boss` job whose one step is a
   * `mail.send` with no threading field — `email.initiate` at the gate. After
   * the mailbox amendment the mailbox adapter is the only one serving
   * `mail.send`, so before R21 this failed `not_a_reply` even when approved.
   */
  async function newMailJob(): Promise<string> {
    const bundle = await installMailboxCharter();
    const job = await createJob({
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
    });
    for (const to of ['understand', 'plan'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    }
    await bindPlanToJob(
      job.jobId,
      Plan.parse({
        goal: 'write to Avi',
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'send the offer',
            toolName: 'mail.send',
            input: { to: 'avi@partner.example', subject: 'הצעת מחיר', body: 'מצורפת ההצעה' },
            expectedActionClass: 'email.initiate',
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    await transition(job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    return job.jobId;
  }

  it('asks first, and once approved sends a new message (not a reply) from the mailbox', async () => {
    const jobId = await newMailJob();
    await setAutonomyMode('ask', 'p_boss', { businessId: BUSINESS });
    const { client, sent, sentNew } = fakeClient();

    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    // email.initiate is approve_required in the charter: a card, nothing sent.
    expect(sentNew).toHaveLength(0);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
    const { rows } = await getPool().query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests WHERE job_id = $1 AND state = 'pending'`,
      [jobId],
    );
    const approvalId = rows[0]?.approval_id;
    if (approvalId === undefined) throw new Error('expected a card');

    await approve(approvalId);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    expect(sent).toHaveLength(0);
    expect(sentNew).toEqual([{ to: ['avi@partner.example'], subject: 'הצעת מחיר', body: 'מצורפת ההצעה' }]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('under mode off a new message is still refused at stage 8 — no exemption reaches it', async () => {
    const jobId = await newMailJob();
    const { client, sentNew } = fakeClient();

    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sentNew).toHaveLength(0);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'policy_denial'`,
      [jobId],
    );
    expect(rows.some((r) => r.reason.startsWith('draft_only') && r.reason.endsWith('email.initiate'))).toBe(true);
  });
});

describe('an instruction-door reply goes out threaded through the mailbox', () => {
  /**
   * The planner writes a reply as `mail.send` with `inReplyTo` only — it
   * never knows the provider's thread or message id. Before the adapter
   * resolved them from the stored mail, this failed `not_a_reply` even once
   * the owner approved it.
   */
  async function instructedReplyJob(inReplyTo: string): Promise<string> {
    const bundle = await installMailboxCharter();
    const job = await createJob({ businessId: BUSINESS, charterVersion: bundle.charterVersion, provenance: 'boss' });
    for (const to of ['understand', 'plan'] as const) {
      await transition(job.jobId, { to, actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    }
    await bindPlanToJob(
      job.jobId,
      Plan.parse({
        goal: 'answer Dana',
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'reply to Dana',
            toolName: 'mail.send',
            input: { to: 'dana@client.example', subject: 'Re: מתי תגיע ההצעה?', body: 'מחר.', inReplyTo },
            expectedActionClass: 'email.reply',
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    await transition(job.jobId, { to: 'execute', actor: 'orchestrator', reason: 'test', businessId: BUSINESS });
    return job.jobId;
  }

  async function pendingCardFor(jobId: string): Promise<string> {
    const { rows } = await getPool().query<{ approval_id: string }>(
      `SELECT approval_id FROM approval_requests WHERE job_id = $1 AND state = 'pending'`,
      [jobId],
    );
    const id = rows[0]?.approval_id;
    if (id === undefined) throw new Error('expected a card');
    return id;
  }

  it('asks first, and once approved sends a reply on the stored thread', async () => {
    await storedMail();
    const jobId = await instructedReplyJob('<q-1@client.example>');
    await setAutonomyMode('ask', 'p_boss', { businessId: BUSINESS });
    const { client, sent, sentNew } = fakeClient();

    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    // The gate ran: under `ask` the reply is approve_required, so a card.
    expect(sent).toHaveLength(0);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');

    await approve(await pendingCardFor(jobId));
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sentNew).toHaveLength(0);
    expect(sent).toEqual([
      {
        to: ['dana@client.example'],
        subject: 'Re: מתי תגיע ההצעה?',
        body: 'מחר.',
        inReplyTo: '<q-1@client.example>',
        references: '<q-0@client.example>',
        threadId: 'TH-1',
        providerMessageId: 'PM-1',
      },
    ]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  it('an approved reply to a mail the business never received fails reply_target_unknown, sending nothing', async () => {
    await storedMail();
    const jobId = await instructedReplyJob('<never-received@client.example>');
    await setAutonomyMode('ask', 'p_boss', { businessId: BUSINESS });
    const { client, sent, sentNew } = fakeClient();

    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    await approve(await pendingCardFor(jobId));
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });

    expect(sent).toHaveLength(0);
    expect(sentNew).toHaveLength(0);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM job_steps WHERE job_id = $1 AND to_phase = 'failed'`,
      [jobId],
    );
    expect(rows.some((r) => r.reason.startsWith('reply_target_unknown'))).toBe(true);
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    await approve(raised.approvalId);
    await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    return { bundle, mail, client, sent, raised: { replyJobId: raised.replyJobId, approvalId: raised.approvalId } };
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
    expect(first.approvalIds).toEqual([card.approval_id]);
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    const decided = await decide(raised.approvalId, 'denied', { by: 'p_boss', channel: 'dashboard' },
      { businessId: BUSINESS });
    await resumeAfterDecision(decided, 'p_boss', { businessId: BUSINESS });
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('closed');
    expect((await reraise()).reraised).toBe(0);
  });

  describe('an approved reply whose approval expired before it could be sent', () => {
    // 19:30 UTC is 22:30 in Asia/Jerusalem — inside the fixture's quiet hours.
    const NIGHT = new Date('2026-10-21T19:30:00.000Z');

    /** Approve at night: the gate defers on quiet hours, the approval unspent. */
    async function approvedThenDeferred() {
      const bundle = await installMailboxCharter();
      const mail = await storedMail();
      const { client, sent } = fakeClient();
      const raised = await raiseMailReply(
        { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
        { businessId: BUSINESS },
      );
      if (raised === null || raised.approvalId === null) throw new Error('expected a card');
      await approve(raised.approvalId);
      await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NIGHT });
      expect(sent).toHaveLength(0);
      expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('followup');
      return { mail, client, sent, raised: { replyJobId: raised.replyJobId, approvalId: raised.approvalId } };
    }

    async function expire(approvalId: string): Promise<void> {
      await getPool().query(
        `UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE approval_id = $1`,
        [approvalId],
      );
    }

    async function wakeAndRun(jobId: string, client: Parameters<typeof runtimeWith>[0]): Promise<void> {
      await transition(jobId, { to: 'execute', actor: 'orchestrator', reason: 'test: wake', businessId: BUSINESS });
      await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON });
    }

    it('is re-asked once, saying the approval expired, and approving the fresh card sends', async () => {
      const { mail, client, sent, raised } = await approvedThenDeferred();
      await expire(raised.approvalId);
      await wakeAndRun(raised.replyJobId, client);
      // Without the approval the woken step dies at stage 8 — the "yes" lost.
      expect(sent).toHaveLength(0);
      expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');

      const first = await reraise();
      expect(first.reraised).toBe(1);
      const cards = await pendingCards();
      expect(cards).toHaveLength(1);
      const card = cards[0];
      if (card === undefined) throw new Error('no card');
      expect(card.detail.startsWith(EXPIRED_PREFIX)).toBe(true);
      expect(card.detail).not.toContain(RETRY_PREFIX);
      expect(card.detail).not.toContain(MAY_HAVE_SENT_WARNING);
      expect((await mailRow(mail.mailId)).reply_job_id).toBe(card.job_id);
      const fresh = await getApproval(card.approval_id, { businessId: BUSINESS });
      const old = await getApproval(raised.approvalId, { businessId: BUSINESS });
      expect(fresh?.proposedInput).toEqual(old?.proposedInput);

      expect((await reraise()).reraised).toBe(0);

      await approve(card.approval_id);
      const second = fakeClient();
      await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(second.client), now: NOON });
      expect(second.sent).toHaveLength(1);
    });

    it('the re-asked card carries the edit the owner approved, not the original draft', async () => {
      const bundle = await installMailboxCharter();
      const mail = await storedMail();
      const { client } = fakeClient();
      const raised = await raiseMailReply(
        { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
        { businessId: BUSINESS },
      );
      if (raised === null || raised.approvalId === null) throw new Error('expected a card');
      const approval = await getApproval(raised.approvalId, { businessId: BUSINESS });
      const edited = { ...(approval?.proposedInput as Record<string, unknown>), body: 'גוף ערוך' };
      await approve(raised.approvalId, edited);
      await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(client), now: NIGHT });
      await expire(raised.approvalId);
      await wakeAndRun(raised.replyJobId, client);

      expect((await reraise()).reraised).toBe(1);
      const card = (await pendingCards())[0];
      if (card === undefined) throw new Error('no card');
      const fresh = await getApproval(card.approval_id, { businessId: BUSINESS });
      expect((fresh?.proposedInput as Record<string, unknown>)['body']).toBe('גוף ערוך');
    });

    it('an approval that expired only AFTER the job had already failed is not re-raised', async () => {
      // The job failed for its own reason while the approval was still live;
      // that "yes" was not lost to expiry, so nothing is re-asked.
      const { client, raised } = await approvedThenDeferred();
      await transition(raised.replyJobId, {
        to: 'failed', actor: 'orchestrator', reason: 'test: failed for another reason', businessId: BUSINESS,
      });
      await getPool().query(
        `UPDATE job_steps SET at = now() - interval '2 hours' WHERE job_id = $1 AND to_phase = 'failed'`,
        [raised.replyJobId],
      );
      await expire(raised.approvalId);
      void client;

      expect((await reraise()).reraised).toBe(0);
      expect(await pendingCards()).toHaveLength(0);
    });

    it('an owner-denied card is never re-raised, even past its expiry', async () => {
      const bundle = await installMailboxCharter();
      const mail = await storedMail();
      const raised = await raiseMailReply(
        { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
        { businessId: BUSINESS },
      );
      if (raised === null || raised.approvalId === null) throw new Error('expected a card');
      const decided = await decide(raised.approvalId, 'denied', { by: 'p_boss', channel: 'dashboard' },
        { businessId: BUSINESS });
      await resumeAfterDecision(decided, 'p_boss', { businessId: BUSINESS });
      await expire(raised.approvalId);
      // Even forced onto the failed path, a denial is not an approval to re-ask.
      // Phase AND a failed step after the expiry: every other condition of
      // the expired branch holds, so only the approval's state refuses it.
      await getPool().query(`UPDATE jobs SET phase = 'failed' WHERE job_id = $1`, [raised.replyJobId]);
      await getPool().query(
        `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, reason)
         VALUES ($1, 'closed', 'failed', 'test', 'test: forced')`,
        [raised.replyJobId],
      );

      expect((await reraise()).reraised).toBe(0);
    });

    it('a deferred reply that is then sent is never re-raised', async () => {
      const { client, sent, raised } = await approvedThenDeferred();
      await wakeAndRun(raised.replyJobId, client);
      expect(sent).toHaveLength(1);
      await expire(raised.approvalId);
      expect((await reraise()).reraised).toBe(0);
    });
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
      if (raised === null || raised.approvalId === null) throw new Error('expected a card');
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

describe('a reply the assistant has LEARNED goes without a card (owner ruling H10)', () => {
  async function learned(options: { knownDomain?: string } = {}): Promise<PolicyBundle> {
    activeBundle = await installFor(
      BUSINESS,
      'google',
      options.knownDomain !== undefined ? { knownCounterpartyEmailDomain: options.knownDomain } : {},
    );
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner', { businessId: BUSINESS });
    return activeBundle;
  }

  async function actionUpdateCount(): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM action_updates WHERE business_id = $1',
      [BUSINESS],
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('a known sender: no card, the job goes to execute, and one scheduler pass sends and updates', async () => {
    const bundle = await learned({ knownDomain: 'client.example' });
    const mail = await storedMail();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a reply job');
    expect(raised.approvalId).toBeNull();
    expect(await approvalCount()).toBe(0);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('execute');
    expect((await mailRow(mail.mailId)).reply_job_id).toBe(raised.replyJobId);

    const { client, sent } = fakeClient();
    await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith(client), now: NOON, inbox: null });

    expect(sent).toHaveLength(1);
    expect(await approvalCount()).toBe(0);
    expect(await actionUpdateCount()).toBe(1);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'intent_to_act'`,
      [raised.replyJobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason.endsWith(` ${LEARNED_REPLY_EXEMPTION_MARKER}`)).toBe(true);
  });

  it('a sender the charter does not know still gets a card, as today', async () => {
    const bundle = await learned();
    const mail = await storedMail();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a reply job');
    expect(raised.approvalId).not.toBeNull();
    expect(await approvalCount()).toBe(1);
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });

  it('a known sender under learn, but a class NOT yet promoted, still gets a card', async () => {
    activeBundle = await installFor(BUSINESS, 'google', { knownCounterpartyEmailDomain: 'client.example' });
    await setAutonomyMode('learn', 'owner', { businessId: BUSINESS });
    const mail = await storedMail();

    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle: activeBundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null) throw new Error('expected a reply job');
    expect(raised.approvalId).not.toBeNull();
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });

  it('a re-raise always gets a card, even once the class is learned', async () => {
    // Raised and approved under `off`; the approved send fails terminally.
    const bundle = await installFor(BUSINESS, 'google', { knownCounterpartyEmailDomain: 'client.example' });
    activeBundle = bundle;
    const mail = await storedMail();
    const raised = await raiseMailReply(
      { mail, triage: TRIAGE, bundle, drafter: stubDrafter() },
      { businessId: BUSINESS },
    );
    if (raised === null || raised.approvalId === null) throw new Error('expected a card');
    await approve(raised.approvalId);
    await runDueJobs({
      businessId: BUSINESS,
      runtime: runtimeWith(fakeClient([{ failure: 'rejected', status: 400, message: 'bad' }]).client),
      now: NOON,
    });
    expect((await loadJob(raised.replyJobId, { businessId: BUSINESS }))?.phase).toBe('failed');

    // Now the class is learned, and the sender is known — every other
    // condition for a card-less send holds.
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner', { businessId: BUSINESS });

    const result = await reraise();
    expect(result.reraised).toBe(1);
    expect(result.approvalIds).toHaveLength(1);
    const fresh = (await mailRow(mail.mailId)).reply_job_id;
    if (fresh === null) throw new Error('mail not relinked');
    expect((await loadJob(fresh, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });
});
