/**
 * Task 10 — the scheduler actually running the WhatsApp loops.
 *
 * Tasks 2-8 built the door, the report, the messenger and the gateway, and
 * none of them had a production caller. This file is the wiring: `runtime.
 * whatsapp` turns both loops on, the door runs before `runDueJobs` and the
 * report runs after `closeVerifiedJobs` — in that order, and the order is
 * what makes "instructed this pass" mean "ran this pass" and "ran this pass"
 * mean "reported this pass" rather than each waiting a full scheduler
 * interval for no reason.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import type { Plan } from '../domain/plan.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { NormalizedInboundMessage } from '../whatsapp/gateway.js';
import { createFakeGateway } from '../whatsapp/fake-gateway.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { loadJob } from './jobs.js';
import { setRampLevel } from './ramp.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const HEALTH_BUSINESS = 'test-business-health';
const STALE_CHARTER_BUSINESS = 'test-business-no-charter';
const PREFIX = 'TEST_CRED_';
// Fixed clock, matching run-due.test.ts / scheduler-runs-plans.test.ts: an
// evening wall-clock run of this suite would otherwise fall inside quiet
// hours and change what the test is actually asserting.
const NOON = new Date('2026-08-18T09:00:00.000Z');
// `buildCharter`'s default principal (`src/test/fixtures.ts`) carries this
// number on the `whatsapp` channel.
const PRINCIPAL_NUMBER = '+972500000000';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

let nextId = 0;
function nextProviderMessageId(): string {
  nextId += 1;
  return `wamid.wiring-test-${nextId}`;
}

function principalMessage(body: string): NormalizedInboundMessage {
  return {
    providerMessageId: nextProviderMessageId(),
    senderNumber: PRINCIPAL_NUMBER,
    body,
    mediaKind: null,
    providerTimestamp: new Date().toISOString(),
  };
}

/** A minimal, feasible plan — the same shape `whatsapp-door.test.ts`'s own `mailPlan` uses. */
function mailPlan(): Plan {
  return {
    goal: 'לשלוח הודעה',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח הודעה',
        toolName: 'mail.send',
        // `counterpartyId: 'c_812'` matches the known counterparty
        // `buildCharter` always includes — see scheduler-runs-plans.test.ts.
        input: { to: 'dana@example.com', counterpartyId: 'c_812', subject: 'נושא', body: 'גוף ההודעה' },
        dependsOn: [],
        expectedActionClass: 'email.initiate',
      },
    ],
  };
}

const plannedWithMailPlan = async (_request: PlanRequest): Promise<PlanOutcome> => ({
  status: 'planned',
  plan: mailPlan(),
});

function runtimeWith(
  sent: MailMessage[],
  gateway: ReturnType<typeof createFakeGateway>,
): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: 'MSG-1' };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
    whatsapp: { gateway },
  };
}

function recordingNotifier(): {
  calls: { subject: string; body: string }[];
  notify: Runtime['notify'];
} {
  const calls: { subject: string; body: string }[] = [];
  const notifier: ApprovalNotifier = {
    channel: 'email',
    async notify() {
      return { ok: true };
    },
  };
  return {
    calls,
    notify: {
      notifier,
      dashboardBaseUrl: 'http://127.0.0.1:8787',
      async sendAlert(subject, body) {
        calls.push({ subject, body });
        return { ok: true };
      },
    },
  };
}

describe('schedulerPass — WhatsApp wiring', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('runs neither loop and returns nulls when WhatsApp is not configured', async () => {
    await installCharter(buildCharter(), { businessId: BUSINESS });
    const pass = await schedulerPass({
      businessId: BUSINESS,
      now: NOON,
      inbox: null,
      runtime: {
        registry: new AdapterRegistry([]),
        credentials: envCredentials({}, PREFIX),
        warnings: [],
        // No `whatsapp` field at all.
      },
    });
    expect(pass.whatsappDoor).toBeNull();
    expect(pass.whatsappReport).toBeNull();
    expect(pass.whatsappError).toBeNull();
  });

  /**
   * Order is not arbitrary, and the reasoning already sits in `scheduler.ts`
   * for `resumeDelegatedJobs`: an instruction received in this pass must also
   * RUN in this pass (the door before `runDueJobs`), and a job that CLOSED in
   * this pass must also be REPORTED in it (the report after
   * `closeVerifiedJobs`). The plan here is deliberately `autonomyBase:
   * { 'email.initiate': 'auto' }` + a ramp set to `auto`, not
   * `approve_required` — the job must actually reach `closed` within this one
   * pass, not merely `await_approval`, or the report-after-close ordering
   * below is never actually exercised (an `await_approval` report does not
   * depend on `closeVerifiedJobs` having run at all). See the mutation
   * verification in the task report for both orderings pinned this way.
   */
  it('instructs, executes, closes and reports — all in one pass', async () => {
    await installCharter(
      buildCharter({
        connections: [MAIL_CONNECTION],
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_MAIL',
        provider: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS, by: 'test' },
    );
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    const gateway = createFakeGateway();
    gateway.enqueue(principalMessage('תשלחי לדנה'));
    const sent: MailMessage[] = [];

    const pass = await schedulerPass({
      businessId: BUSINESS,
      now: NOON,
      inbox: null,
      runtime: runtimeWith(sent, gateway),
      whatsappPlanner: plannedWithMailPlan,
    });

    expect(pass.whatsappError).toBeNull();
    expect(pass.whatsappDoor?.instructed).toBe(1);
    expect(pass.due.ran).toHaveLength(1); // ran in the SAME pass
    expect(sent).toHaveLength(1); // the mail really went out
    const jobId = pass.due.ran[0]?.jobId;
    expect(jobId).toBeDefined();
    if (jobId !== undefined) {
      expect(pass.verified.closed).toContain(jobId); // closed in the SAME pass
      expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
    }
    expect(pass.whatsappReport?.reported).toBe(1); // reported in the SAME pass
    expect(pass.whatsappReport?.deferred).toBe(0);
    expect(pass.whatsappReport?.errored).toEqual([]);
    // The owner heard the acknowledgement AND the final report — never the
    // acknowledgement alone, which would mean the report never ran.
    expect(gateway.sent.length).toBeGreaterThanOrEqual(2);
  });

  /** A charter this process cannot read must skip BOTH loops, not the pass. */
  it('skips both loops and reports why when there is no active charter', async () => {
    const gateway = createFakeGateway();
    const pass = await schedulerPass({
      businessId: STALE_CHARTER_BUSINESS,
      now: NOON,
      inbox: null,
      runtime: {
        registry: new AdapterRegistry([]),
        credentials: envCredentials({}, PREFIX),
        warnings: [],
        whatsapp: { gateway },
      },
    });
    expect(pass.whatsappDoor).toBeNull();
    expect(pass.whatsappReport).toBeNull();
    expect(pass.whatsappError).not.toBeNull();
    // The rest of the pass still ran — a stale/missing charter for the
    // WhatsApp loops must not suppress the tick or the other loops.
    expect(pass.tick.skipped).toBe(false);
  });

  /**
   * §7.4 — a bridge that WAS connected and is not must reach the owner by
   * EMAIL, never by WhatsApp (WhatsApp is the thing that is down), and
   * exactly ONCE per transition.
   */
  it('emails the owner once when a previously connected gateway is no longer connected', async () => {
    await installCharter(buildCharter(), { businessId: HEALTH_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify } = recordingNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — the gateway starts out connected (the fake's own default).
    // This is the FIRST observation this process ever makes, never itself a
    // transition, so nothing is sent yet.
    await schedulerPass({ businessId: HEALTH_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(0);
    expect(gateway.sent).toHaveLength(0);

    // Pass 2 — the bridge drops.
    gateway.setHealth({ state: 'reconnecting', since: NOON.toISOString() });
    await schedulerPass({ businessId: HEALTH_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toContain('וואטסאפ');
    expect(calls[0]?.body).toContain('התנתק');
    // Never through WhatsApp — WhatsApp is the thing that is down.
    expect(gateway.sent).toHaveLength(0);

    // Pass 3 — still disconnected. No second email for the same outage.
    await schedulerPass({ businessId: HEALTH_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);
  });
});
