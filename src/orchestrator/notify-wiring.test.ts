import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { writeKeyState } from '../governance/master-key.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import { createJob, loadJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Tuesday, 12:00 Asia/Jerusalem — inside business hours and well clear of the
// charter's 20:00–07:00 quiet-hours window. Without a fixed clock the gate
// picks up the real wall-clock time, and quiet hours (checked before the risk
// step that queues an approval) silently swallows this test whenever it runs
// in the evening — exactly the failure this constant exists to avoid. Same
// value `external.test.ts` uses for the same reason.
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail',
  status: 'live',
  endpoint: null,
  credentialRef: 'OFFICE_MAIL',
  lastOkAt: null,
  lastError: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      input: { to: 'dana@example.com', subject: 'אישור', body: 'שלום' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

function recordingNotifier(): { calls: { approvalId: string; link: string }[]; notifier: ApprovalNotifier } {
  const calls: { approvalId: string; link: string }[] = [];
  return {
    calls,
    notifier: {
      channel: 'email',
      async notify(request, link) {
        calls.push({ approvalId: request.approvalId, link });
        return { ok: true };
      },
    },
  };
}

function registry(): AdapterRegistry {
  return new AdapterRegistry([
    createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          return { messageId: 'MSG-1' };
        },
      },
    }),
  ]);
}

/** A job walked from `intake` to `execute`, the way `run-plan` requires. */
async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'notify wiring',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

describe('approval notification wiring', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('notifies the owner when the gate queues an approval', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'approve_required' } }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const { calls, notifier } = recordingNotifier();

    const result = await runPlan({
      job,
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
      now: NOON,
      notify: { notifier, dashboardBaseUrl: 'http://127.0.0.1:8787' },
    });

    expect(result.status).toBe('halted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.link).toContain('http://127.0.0.1:8787');
  });

  it('runs unchanged when no notifier is supplied', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], autonomyBase: { 'email.initiate': 'approve_required' } }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: PLAN,
      registry: registry(),
      bindings: [LIVE],
      credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
      counterpartyTags: [],
      rampLevel: 'approve_required',
      now: NOON,
    });

    expect(result.status).toBe('halted');
  });

  /**
   * The end-to-end point of tasks 1-3: a plan-driven send authenticates with
   * a value that came out of the encrypted store, not out of `process.env`.
   *
   * Deliberately drives `storedCredentials` — the production `CredentialSource`
   * — rather than `envCredentials` above, which exists for tests only
   * (`src/orchestrator/credentials.ts`) and reads a single shared process
   * environment. Nothing in this test ever sets `SMTP_PASS`; `putSecret`
   * writes the only copy of the value, under the ref the binding names, and
   * `runPlan` must resolve that exact row through the real gate, adapter and
   * transport.
   *
   * `email.reply` (not `email.initiate`, as `PLAN` above uses) so the send
   * actually happens instead of queuing an approval — the charter's
   * unmodified base for `email.reply` is `auto_notify` and the boss
   * provenance ceiling is `auto` (see `ramp-raise.test.ts`'s module
   * docblock), and `rampLevel: 'auto_notify'` is passed straight to
   * `runPlan` the same way the two tests above pass `rampLevel` directly,
   * bypassing the DB-backed ramp lookup that is someone else's test's job.
   * `knownCounterpartyEmailDomain` and `inReplyTo` are both required —
   * without the former `scoreVisibility` scores the recipient
   * `one_unknown` and escalates to a card; without the latter
   * `refineActionClass` reports `email.initiate`, which this charter caps at
   * `approve_required` regardless of ramp.
   *
   * The assertion is positive, not a search for absence: it proves the
   * secret WAS on the path (`captured` equals the exact value `putSecret`
   * wrote), not merely that some other value was missing from somewhere —
   * the shape this plan's own security reviews flagged as too easy to write
   * vacuously.
   */
  it('carries a real secret from the store to the transport, for a plan-driven send', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'example.com' }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    // The store is the source: nothing in this test sets SMTP_PASS, and the
    // registry below never touches `envCredentials`.
    const key = randomBytes(32);
    await writeKeyState(key, 'key-1');
    await putSecret(
      { businessId: BUSINESS, ref: 'OFFICE_MAIL', value: 'סוד-מהמאגר', updatedBy: 'test' },
      key,
    );

    const captured: string[] = [];
    const registry = new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        // The real transport (`createSmtpTransport`, task 1) rather than a
        // bare `MailTransport` stub: `captured` records what actually
        // reached nodemailer's own `auth.pass`, one layer further than the
        // adapter boundary.
        transport: createSmtpTransport({
          host: 'smtp.invalid.example',
          port: 587,
          secure: false,
          from: 'assistant@example.com',
          user: 'assistant',
          createTransport: (options) => {
            captured.push(options.auth.pass);
            return { sendMail: async () => ({ messageId: 'MSG-1' }) };
          },
        }),
      }),
    ]);

    const replyPlan: Plan = Plan.parse({
      goal: 'reply to a known customer',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply to the customer',
          toolName: 'mail.send',
          input: {
            to: 'dana@example.com',
            counterpartyId: 'c_812',
            inReplyTo: 'thread-9',
            subject: 'תשובה',
            body: 'גוף',
          },
          expectedActionClass: 'email.reply',
        },
      ],
    });

    const result = await runPlan({
      job,
      bundle,
      plan: replyPlan,
      registry,
      bindings: [LIVE],
      credentials: storedCredentials(key),
      counterpartyTags: [],
      rampLevel: 'auto_notify',
      now: NOON,
    });

    expect(result.status).toBe('done');
    expect(captured).toEqual(['סוד-מהמאגר']);
  });
});
